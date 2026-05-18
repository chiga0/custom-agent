import { ChildHandle, type ChildHandleOptions, type JsonRpcMessage } from "./child";
import { DEFAULT_RING_SIZE, SessionCursor, type CursorEvent } from "./cursor";

// SessionManager: per-daemon registry mapping ACP `sessionId` to the
// owning ChildHandle and its event cursor.
//
// Lifecycle per session (see SPEC.md §6, §10 and [[adr-0004]] §5):
//
//   createSession(initParams, newSessionParams) ──► spawn child
//                                                ──► initialize child
//                                                ──► forward session/new
//                                                ──► record { child, cursor }
//
//   prompt / cancel ──► route by sessionId to that child's stdio
//
//   child exit      ──► mark terminated, emit final cursor event,
//                       leave the ring buffer in place so an SSE replay
//                       can finish; further requests return 410 Gone.
//
//   terminate       ──► kill child, close cursor, drop the entry.

export type SessionState = {
  readonly sessionId: string;
  readonly child: ChildHandle;
  readonly cursor: SessionCursor;
  status: "alive" | "terminated";
  /** Why the session ended (only set when status === 'terminated'). */
  terminationReason?: string;
};

export type CreateSessionInput = {
  /** Daemon's own initialize params; passed through to the child. */
  initializeParams: { protocolVersion: number; [key: string]: unknown };
  /** session/new params from the client. */
  newSessionParams: unknown;
};

export type CreateSessionResult = {
  /** session id as returned by the child. */
  sessionId: string;
  /** Original JSON-RPC result for session/new (for proxying back). */
  newSessionResult: unknown;
};

export type SessionManagerOptions = {
  /** Override for tests — produce a ChildHandle without spawning. */
  spawnChild?: (opts: ChildHandleOptions) => ChildHandle;
  /** Ring buffer capacity per session (SPEC.md §8). Default 256. */
  ringSize?: number;
  /** Environment for spawned children. */
  childEnv?: NodeJS.ProcessEnv;
};

export class SessionManager {
  private readonly sessions = new Map<string, SessionState>();
  private readonly spawnChild: (opts: ChildHandleOptions) => ChildHandle;
  private readonly ringSize: number;
  private readonly childEnv: NodeJS.ProcessEnv | undefined;

  constructor(opts: SessionManagerOptions = {}) {
    this.spawnChild = opts.spawnChild ?? ((o) => new ChildHandle(o));
    this.ringSize = opts.ringSize ?? DEFAULT_RING_SIZE;
    this.childEnv = opts.childEnv;
  }

  /** Snapshot of currently-tracked sessions. */
  list(): SessionState[] {
    return Array.from(this.sessions.values());
  }

  /** Get state by id, or undefined if never created. */
  get(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Spawn a fresh child, perform `initialize` + `session/new`, and
   * register the session. Errors during any step cause the child to be
   * cleaned up and the error propagated.
   */
  async createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
    const child = this.spawnChild({ env: this.childEnv });
    let initResp: JsonRpcMessage;
    try {
      initResp = await child.request("initialize", input.initializeParams);
    } catch (err) {
      await child.terminate();
      throw err;
    }
    if (initResp.error) {
      await child.terminate();
      throw new Error(`child initialize failed: ${initResp.error.message}`);
    }

    let newResp: JsonRpcMessage;
    try {
      newResp = await child.request("session/new", input.newSessionParams);
    } catch (err) {
      await child.terminate();
      throw err;
    }
    if (newResp.error) {
      await child.terminate();
      throw new Error(`child session/new failed: ${newResp.error.message}`);
    }

    const sessionId = extractSessionId(newResp.result);
    if (!sessionId) {
      await child.terminate();
      throw new Error("child session/new returned no sessionId");
    }

    const cursor = new SessionCursor(this.ringSize);
    const state: SessionState = { sessionId, child, cursor, status: "alive" };
    this.sessions.set(sessionId, state);

    // Wire child notifications → cursor. Only session/update notifications
    // are persisted to the SSE stream; the daemon does not invent its own
    // notification methods so any other method passed through is a
    // forward-compatibility courtesy.
    child.on("notification", (msg) => {
      if (state.status !== "alive") return;
      try {
        cursor.push(JSON.stringify(msg));
      } catch {
        // Cursor closed concurrently with a notification; harmless.
      }
    });

    child.on("exit", (info) => {
      state.status = "terminated";
      state.terminationReason = `child_exited(code=${info.code}, signal=${info.signal})`;
      // Push a final synthetic event so any subscribed SSE stream sees
      // the termination and the response handler in server.ts can emit
      // `event: terminated`. We tag it with a method the daemon owns to
      // avoid colliding with ACP-defined methods.
      try {
        cursor.push(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "_daemon/terminated",
            params: { sessionId, reason: state.terminationReason },
          }),
        );
      } catch {
        // ignore
      }
      // Keep the cursor open so a slow SSE consumer can still read the
      // last events; we close it on terminate() / cleanup.
    });

    return { sessionId, newSessionResult: newResp.result };
  }

  /** Forward a request frame to the child. Returns the child's response. */
  async forwardRequest(
    sessionId: string,
    method: string,
    params: unknown,
  ): Promise<JsonRpcMessage> {
    const state = this.requireAlive(sessionId);
    return state.child.request(method, params);
  }

  /** Forward a notification frame to the child. Fire-and-forget. */
  forwardNotification(sessionId: string, method: string, params: unknown): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.status !== "alive") return;
    state.child.notify(method, params);
  }

  /**
   * Subscribe to SSE-style events for `sessionId`. Yields buffered events
   * with id > fromCursor first, then live events. Stops when the cursor
   * closes (terminate) or `signal` aborts.
   */
  async *subscribe(
    sessionId: string,
    fromCursor: number,
    signal: AbortSignal,
  ): AsyncIterable<CursorEvent> {
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw new SessionNotFoundError(sessionId);
    }
    const { cursor } = state;
    if (!cursor.canResumeFrom(fromCursor)) {
      throw new CursorLostError(fromCursor, cursor.oldest);
    }
    // Replay buffered events first.
    for (const event of cursor.replay(fromCursor)) {
      if (signal.aborted) return;
      yield event;
    }
    if (cursor.isClosed) return;

    // Then attach to live stream.
    const queue: CursorEvent[] = [];
    let resolveWait: (() => void) | null = null;
    const wake = (): void => {
      if (resolveWait) {
        resolveWait();
        resolveWait = null;
      }
    };
    const onEvent = (e: CursorEvent): void => {
      queue.push(e);
      wake();
    };
    const onClose = (): void => {
      wake();
    };
    const onAbort = (): void => {
      wake();
    };
    cursor.on("event", onEvent);
    cursor.on("close", onClose);
    signal.addEventListener("abort", onAbort);

    try {
      while (true) {
        while (queue.length > 0) {
          const next = queue.shift();
          if (next) yield next;
        }
        if (signal.aborted) return;
        if (cursor.isClosed) return;
        await new Promise<void>((resolveP) => {
          resolveWait = resolveP;
        });
      }
    } finally {
      cursor.off("event", onEvent);
      cursor.off("close", onClose);
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** Tear down one session and remove it from the registry. */
  async terminate(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    this.sessions.delete(sessionId);
    state.status = "terminated";
    state.cursor.close();
    await state.child.terminate();
  }

  /** Tear down every session (daemon shutdown). */
  async terminateAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    await Promise.all(ids.map((id) => this.terminate(id)));
  }

  private requireAlive(sessionId: string): SessionState {
    const state = this.sessions.get(sessionId);
    if (!state) throw new SessionNotFoundError(sessionId);
    if (state.status !== "alive") {
      throw new SessionTerminatedError(sessionId, state.terminationReason ?? "unknown");
    }
    return state;
  }
}

export class SessionNotFoundError extends Error {
  readonly status = 410;
  constructor(public readonly sessionId: string) {
    super(`session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}

export class SessionTerminatedError extends Error {
  readonly status = 410;
  constructor(
    public readonly sessionId: string,
    public readonly reason: string,
  ) {
    super(`session terminated: ${sessionId} (${reason})`);
    this.name = "SessionTerminatedError";
  }
}

export class CursorLostError extends Error {
  readonly status = 410;
  constructor(
    public readonly requested: number,
    public readonly oldestAvailable: number,
  ) {
    super(`cursor lost: requested=${requested}, oldestAvailable=${oldestAvailable}`);
    this.name = "CursorLostError";
  }
}

function extractSessionId(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const sid = (result as { sessionId?: unknown }).sessionId;
  return typeof sid === "string" ? sid : undefined;
}
