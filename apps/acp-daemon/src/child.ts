import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ChildHandle wraps one `apps/acp-server` subprocess.
//
// Per [[adr-0004]] §5 each ACP session owns exactly one acp-server child
// process so crashes are isolated and stdio framing stays simple (no
// multiplexing). This handle:
//
// 1. Spawns the binary at `apps/acp-server/bin/acp-server.mjs` via
//    `process.execPath` (so we use the same Node runtime as the daemon,
//    not whatever happens to be on PATH).
// 2. Parses ndjson on stdout: each JSON-RPC frame is one line.
// 3. Routes responses (`id` matches a pending request) to the awaiting
//    promise, and notifications (no `id`) to a listener.
// 4. Surfaces exit / error so the SessionManager can mark the session
//    terminated and isolate other sessions.

const HERE = dirname(fileURLToPath(import.meta.url));

/** Path to the acp-server binary. Resolved once at module load. */
export const ACP_SERVER_BIN = resolve(HERE, "..", "..", "acp-server", "bin", "acp-server.mjs");

export type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

/** Pending request awaiting a response from the child. */
type Pending = {
  resolve: (msg: JsonRpcMessage) => void;
  reject: (err: Error) => void;
};

export type ChildExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

export type ChildHandleOptions = {
  /** Override binary path. Used in tests. */
  binPath?: string;
  /** Override spawn function. Used to inject a fake child for unit tests. */
  spawnFn?: typeof spawn;
  /** Environment to pass to the child. Defaults to the daemon's env. */
  env?: NodeJS.ProcessEnv;
};

/**
 * Strongly-typed event emitter so consumers see what the handle emits.
 *
 *  - `notification`: a JSON-RPC notification frame from the child (no id).
 *  - `exit`: the child exited; subsequent calls fail.
 *  - `stderr`: a chunk of stderr text, useful for diagnostics.
 */
export type ChildHandleEvents = {
  notification: (msg: JsonRpcMessage) => void;
  exit: (info: ChildExit) => void;
  stderr: (chunk: string) => void;
};

type ChildHandleEventName = keyof ChildHandleEvents;

export class ChildHandle extends EventEmitter {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = "";
  private stderrBuffer = "";
  private exited = false;
  private exitInfo: ChildExit | null = null;

  constructor(opts: ChildHandleOptions = {}) {
    super();
    const bin = opts.binPath ?? ACP_SERVER_BIN;
    const spawnImpl = opts.spawnFn ?? spawn;
    this.child = spawnImpl(process.execPath, [bin], {
      stdio: ["pipe", "pipe", "pipe"],
      env: opts.env ?? process.env,
    }) as ChildProcessWithoutNullStreams;

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onStdout(chunk));

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer += chunk;
      this.emit("stderr", chunk);
    });

    this.child.on("exit", (code, signal) => {
      this.exited = true;
      this.exitInfo = { code, signal };
      const err = new Error(
        `acp-server child exited (code=${code}, signal=${signal}); stderr=${this.stderrBuffer.slice(0, 500)}`,
      );
      for (const [, pending] of this.pending) pending.reject(err);
      this.pending.clear();
      this.emit("exit", this.exitInfo);
    });

    // 'error' on spawn (e.g. ENOENT for bin path). Treat same as exit.
    this.child.on("error", (err) => {
      if (!this.exited) {
        this.exited = true;
        this.exitInfo = { code: null, signal: null };
        for (const [, pending] of this.pending) pending.reject(err);
        this.pending.clear();
        this.emit("exit", this.exitInfo);
      }
    });
  }

  /** Process id of the underlying child (for `process.kill` in tests). */
  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Whether the child has exited. Once true the handle is unusable. */
  get isExited(): boolean {
    return this.exited;
  }

  /** Exit info, populated only after `exit` event fires. */
  get exit(): ChildExit | null {
    return this.exitInfo;
  }

  /**
   * Send a JSON-RPC request and wait for the matching response.
   * Allocates an id automatically; the supplied `id` field is ignored.
   */
  request(method: string, params: unknown): Promise<JsonRpcMessage> {
    if (this.exited) {
      return Promise.reject(new Error(`child exited; cannot send ${method}`));
    }
    const id = this.nextId++;
    const frame: JsonRpcMessage = { jsonrpc: "2.0", id, method, params };
    return new Promise<JsonRpcMessage>((resolveP, rejectP) => {
      this.pending.set(id, { resolve: resolveP, reject: rejectP });
      try {
        this.child.stdin.write(JSON.stringify(frame) + "\n");
      } catch (err) {
        this.pending.delete(id);
        rejectP(err as Error);
      }
    });
  }

  /** Send a JSON-RPC notification (no id). Fire-and-forget. */
  notify(method: string, params: unknown): void {
    if (this.exited) return;
    const frame: JsonRpcMessage = { jsonrpc: "2.0", method, params };
    try {
      this.child.stdin.write(JSON.stringify(frame) + "\n");
    } catch {
      // The child already crashed or stdin is closed. The 'exit' handler
      // will fire and reject pending requests. Swallow here so callers
      // of notify() don't see a misleading error.
    }
  }

  /** Best-effort graceful shutdown. Force-kills after 2 s. */
  async terminate(): Promise<void> {
    if (this.exited) return;
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }
    await new Promise<void>((resolveP) => {
      const t = setTimeout(() => {
        try {
          this.child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 2000);
      t.unref();
      this.child.once("exit", () => {
        clearTimeout(t);
        resolveP();
      });
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        // Framing corruption: surface as stderr and kill the child so
        // we don't keep desynchronized state. The SessionManager will
        // mark the session terminated via the 'exit' event.
        this.stderrBuffer += `\n[daemon] unparseable stdout line: ${line.slice(0, 200)}`;
        try {
          this.child.kill("SIGKILL");
        } catch {
          // ignore
        }
        return;
      }
      this.routeMessage(msg);
    }
  }

  private routeMessage(msg: JsonRpcMessage): void {
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        pending.resolve(msg);
      }
      return;
    }
    if (msg.method) {
      this.emit("notification", msg);
      return;
    }
    // Response without a matching id, or notification without a method.
    // Ignore — surfacing as stderr is too noisy for normal operation.
  }
}

// Re-declared method overloads on the class would require declaration
// merging (an ESLint blocking rule). Consumers cast via the helper
// below when they need the typed-listener overloads.
export type TypedChildHandle = ChildHandle & {
  on<K extends ChildHandleEventName>(event: K, listener: ChildHandleEvents[K]): TypedChildHandle;
  once<K extends ChildHandleEventName>(event: K, listener: ChildHandleEvents[K]): TypedChildHandle;
  off<K extends ChildHandleEventName>(event: K, listener: ChildHandleEvents[K]): TypedChildHandle;
};
