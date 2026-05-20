import type {
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SessionUpdate,
} from "@custom-agent/schema/acp";
import { SseFrameParser } from "./sse";

// daemon-client.ts
//
// Thin ACP Streamable HTTP client for the web shell. Matches the wire
// spec at apps/acp-daemon/SPEC.md:
//
//   - POST /rpc           — JSON-RPC over HTTP (bearer auth)
//   - GET  /events        — SSE stream of session/update notifications
//                            (bearer auth via fetch + ReadableStream,
//                             not native EventSource — see sse.ts)
//
// The client is intentionally framework-agnostic: it returns plain
// Promises + async iterators and never touches the DOM. main.ts wires
// it to the UI.

export type DaemonConfig = {
  readonly baseUrl: string;
  readonly authToken: string;
};

export type JsonRpcRequest = {
  readonly jsonrpc: "2.0";
  readonly id?: number;
  readonly method: string;
  readonly params?: unknown;
};

export type JsonRpcResponse<T = unknown> = {
  readonly jsonrpc: "2.0";
  readonly id: number | null;
  readonly result?: T;
  readonly error?: { code: number; message: string; data?: unknown };
};

export class DaemonError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly rpcError?: { code: number; message: string },
  ) {
    super(message);
    this.name = "DaemonError";
  }
}

/** Internal: minimal seq for JSON-RPC request id. */
let nextRpcId = 1;

async function postRpc<T>(
  config: DaemonConfig,
  method: string,
  params: unknown,
  sessionIdHeader?: string,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.authToken}`,
    "Content-Type": "application/json",
  };
  if (sessionIdHeader) headers["X-ACP-Session-Id"] = sessionIdHeader;

  const body: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: nextRpcId++,
    method,
    params,
  };

  const res = await fetch(`${stripTrailingSlash(config.baseUrl)}/rpc`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // 401 / 410 / 400 carry a JSON error body (`{ error: "..." }`); the
    // 200 JSON-RPC error path is handled below.
    const text = await res.text();
    throw new DaemonError(res.status, `daemon HTTP ${res.status}: ${text}`);
  }
  const json = (await res.json()) as JsonRpcResponse<T>;
  if (json.error) {
    throw new DaemonError(res.status, json.error.message, json.error);
  }
  if (json.result === undefined) {
    throw new DaemonError(res.status, "daemon JSON-RPC response missing result");
  }
  return json.result;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** ACP session/new. */
export async function newSession(
  config: DaemonConfig,
  params: NewSessionRequest,
): Promise<NewSessionResponse> {
  return postRpc<NewSessionResponse>(config, "session/new", params);
}

/** ACP session/load (M1-04). */
export async function loadSession(
  config: DaemonConfig,
  params: LoadSessionRequest,
): Promise<LoadSessionResponse> {
  return postRpc<LoadSessionResponse>(config, "session/load", params);
}

/** ACP session/prompt — sessionId is supplied on both header and params per SPEC.md §5. */
export async function prompt(config: DaemonConfig, params: PromptRequest): Promise<PromptResponse> {
  return postRpc<PromptResponse>(config, "session/prompt", params, params.sessionId);
}

/**
 * Subscribe to the daemon's SSE stream for `sessionId`. Returns an
 * AsyncIterable of decoded JSON-RPC `session/update` payloads. The
 * iterable ends when the daemon emits a `terminated` event, the
 * AbortSignal aborts, or the stream closes.
 *
 * Anything outside the `session/update` shape (cursor_lost, unknown
 * methods) is surfaced as a `StreamControlEvent` so the caller can
 * react (e.g. restart from session/load on cursor_lost).
 */
export type StreamControlEvent =
  | { kind: "cursor_lost"; oldestAvailable?: number; requested?: number }
  | { kind: "terminated"; reason?: string };

export type StreamEvent =
  | { kind: "update"; id: number; update: SessionUpdate; sessionId: string }
  | { kind: "control"; control: StreamControlEvent };

export async function* subscribe(
  config: DaemonConfig,
  sessionId: string,
  options: { lastEventId?: number; signal?: AbortSignal } = {},
): AsyncGenerator<StreamEvent, void, void> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.authToken}`,
    "X-ACP-Session-Id": sessionId,
  };
  if (options.lastEventId !== undefined) {
    headers["Last-Event-ID"] = String(options.lastEventId);
  }

  const res = await fetch(`${stripTrailingSlash(config.baseUrl)}/events`, {
    method: "GET",
    headers,
    signal: options.signal,
  });
  if (!res.ok) {
    throw new DaemonError(res.status, `daemon SSE HTTP ${res.status}: ${await res.text()}`);
  }
  if (!res.body) {
    throw new DaemonError(res.status, "daemon SSE response has no body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseFrameParser();
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        return; // aborted
      }
      if (chunk.done) return;
      parser.push(decoder.decode(chunk.value, { stream: true }));
      for (const frame of parser.take()) {
        if (frame.event === "terminated") {
          yield {
            kind: "control",
            control: { kind: "terminated", reason: parseReason(frame.data) },
          };
          return;
        }
        if (frame.event === "cursor_lost") {
          const parsed = safeParseJson(frame.data) as
            | { requested?: number; oldestAvailable?: number }
            | undefined;
          yield {
            kind: "control",
            control: {
              kind: "cursor_lost",
              requested: parsed?.requested,
              oldestAvailable: parsed?.oldestAvailable,
            },
          };
          return;
        }
        if (frame.id === undefined) continue;
        const parsed = safeParseJson(frame.data);
        if (!isSessionUpdateNotification(parsed)) continue;
        yield {
          kind: "update",
          id: frame.id,
          update: parsed.params.update,
          sessionId: parsed.params.sessionId,
        };
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseReason(data: string): string | undefined {
  const parsed = safeParseJson(data) as { reason?: unknown } | undefined;
  return typeof parsed?.reason === "string" ? parsed.reason : undefined;
}

type SessionUpdateNotification = {
  method: "session/update";
  params: { sessionId: string; update: SessionUpdate };
};

function isSessionUpdateNotification(value: unknown): value is SessionUpdateNotification {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { method?: unknown; params?: unknown };
  if (candidate.method !== "session/update") return false;
  if (!candidate.params || typeof candidate.params !== "object") return false;
  const p = candidate.params as { sessionId?: unknown; update?: unknown };
  if (typeof p.sessionId !== "string") return false;
  if (!p.update || typeof p.update !== "object") return false;
  return true;
}
