import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { AuthFailed, createAuthenticator, type Authenticator } from "./auth";
import type { SessionManager } from "./session-manager";
import { CursorLostError, SessionNotFoundError, SessionTerminatedError } from "./session-manager";
import type { JsonRpcMessage } from "./child";

// HTTP+SSE gateway for ACP. Two routes (SPEC.md §2):
//
//   POST /rpc     — JSON-RPC request/notification → response/202
//   GET  /events  — SSE stream of session/update notifications
//   GET  /healthz — liveness (unauthenticated)
//
// We deliberately use node:http rather than Hono / Express. The surface
// is tiny, and adding a framework here would drag its peer deps into a
// boundary-sensitive package. SSE is hand-rolled because every framework
// I've used produces subtly non-compliant framing.

const SESSION_HEADER = "x-acp-session-id";
const LAST_EVENT_HEADER = "last-event-id";
const SSE_KEEPALIVE_MS = 15_000;

// Session ids are used as filesystem path components (the writer's
// JSONL is at `${ACP_EVENT_LOG_ROOT}/${sessionId}.jsonl`) AND as HTTP
// header values AND as log line tokens. Pin a conservative shape so a
// hostile / buggy client cannot inject path traversal, header
// continuation, or noisy log lines. SPEC.md §5 documents this rule.
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
function isValidSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

export type ServerOptions = {
  /** Listening port. 0 = ephemeral, useful for tests. */
  port?: number;
  /** Listening host. Defaults to 127.0.0.1 (localhost only). */
  host?: string;
  /** Bearer token, must be non-empty. */
  authToken: string;
  manager: SessionManager;
};

export type DaemonServer = {
  /** Address the daemon is listening on. */
  readonly address: AddressInfo;
  /** Stop accepting connections and tear down active sessions. */
  close(): Promise<void>;
  /** Underlying server (rarely needed; useful in tests). */
  readonly raw: Server;
};

/** Start the daemon HTTP server. */
export async function startServer(opts: ServerOptions): Promise<DaemonServer> {
  const authenticator = createAuthenticator(opts.authToken);
  const server = createServer((req, res) => {
    handleRequest(req, res, opts.manager, authenticator).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      // Last-resort error path: handler should already have responded.
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: `daemon internal error: ${message}` }));
      } else {
        try {
          res.end();
        } catch {
          // ignore
        }
      }
    });
  });

  await new Promise<void>((resolveP, rejectP) => {
    const onError = (err: Error): void => {
      server.off("listening", onListening);
      rejectP(err);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolveP();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1");
  });

  const address = server.address() as AddressInfo;

  return {
    address,
    raw: server,
    async close(): Promise<void> {
      await opts.manager.terminateAll();
      await new Promise<void>((resolveP) => {
        server.close(() => resolveP());
        // Force-close keep-alive connections that the SSE stream
        // intentionally keeps open.
        server.closeAllConnections?.();
      });
    },
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  manager: SessionManager,
  auth: Authenticator,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/healthz" && req.method === "GET") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain");
    res.end("ok");
    return;
  }

  // Every other path requires auth.
  try {
    auth.check(req.headers.authorization);
  } catch (err) {
    if (err instanceof AuthFailed) {
      respondJson(res, 401, { error: err.message });
      return;
    }
    throw err;
  }

  if (url.pathname === "/rpc" && req.method === "POST") {
    await handleRpc(req, res, manager);
    return;
  }
  if (url.pathname === "/events" && req.method === "GET") {
    await handleEvents(req, res, manager);
    return;
  }
  // Path exists, wrong verb?
  if (url.pathname === "/rpc" || url.pathname === "/events" || url.pathname === "/healthz") {
    respondJson(res, 405, { error: "method not allowed" });
    return;
  }
  respondJson(res, 404, { error: "not found" });
}

async function handleRpc(
  req: IncomingMessage,
  res: ServerResponse,
  manager: SessionManager,
): Promise<void> {
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    respondJson(res, 415, { error: "Content-Type must be application/json" });
    return;
  }

  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    respondJson(res, 400, {
      error: `failed to read request body: ${err instanceof Error ? err.message : err}`,
    });
    return;
  }

  let msg: JsonRpcMessage;
  try {
    msg = JSON.parse(body) as JsonRpcMessage;
  } catch {
    respondJson(res, 400, { error: "request body is not valid JSON" });
    return;
  }
  if (typeof msg.method !== "string") {
    respondJson(res, 400, { error: "JSON-RPC method is required" });
    return;
  }

  const sessionHeader = req.headers[SESSION_HEADER];
  const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
  const isNotification = msg.id === undefined || msg.id === null;

  try {
    if (msg.method === "initialize") {
      // Daemon-level initialize (SPEC.md §6): purely informational in M1.
      // We echo the client's protocolVersion back so capability negotiation
      // mirrors what the child later advertises, but the child itself is
      // always spawned with protocolVersion: 1 in M1. Real per-session
      // version threading is an M2 concern.
      //
      // The advertised agentCapabilities MUST match what `apps/acp-server`
      // returns from its own initialize (see apps/acp-server/src/agent.ts
      // initialize()), otherwise clients that trust the daemon's response
      // will skip methods the child actually supports — notably session/load
      // (M1-04).
      respondJsonRpc(res, msg.id ?? null, {
        protocolVersion:
          (msg.params as { protocolVersion?: number } | undefined)?.protocolVersion ?? 1,
        agentInfo: { name: "Custom Agent (daemon)", version: "0.1.0" },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          mcpCapabilities: { http: false, sse: false },
        },
        authMethods: [],
      });
      return;
    }

    if (msg.method === "authenticate") {
      // Daemon advertises no auth methods (transport-level bearer token
      // is its own thing). Respond with an empty result to match acp-server.
      respondJsonRpc(res, msg.id ?? null, {});
      return;
    }

    if (msg.method === "session/new") {
      // Reject if a session header is present — session/new must NOT be
      // pinned to an existing session.
      if (sessionId) {
        respondJsonRpc(res, msg.id ?? null, null, {
          code: -32602,
          message: "session/new must not carry X-ACP-Session-Id",
        });
        return;
      }
      const result = await manager.createSession({
        initializeParams: { protocolVersion: 1 },
        newSessionParams: msg.params ?? {},
      });
      respondJsonRpc(res, msg.id ?? null, result.newSessionResult);
      return;
    }

    if (msg.method === "session/load") {
      // session/load mirrors session/new: it CREATES the daemon-side
      // entry; the client supplies the sessionId in params. Header MUST
      // NOT be present — the body field is the only identity source for
      // a freshly loaded session. (SPEC.md §5/§6.)
      if (sessionId) {
        respondJsonRpc(res, msg.id ?? null, null, {
          code: -32602,
          message: "session/load must not carry X-ACP-Session-Id",
        });
        return;
      }
      const params = (msg.params ?? {}) as { sessionId?: unknown };
      if (!isValidSessionId(params.sessionId)) {
        respondJsonRpc(res, msg.id ?? null, null, {
          code: -32602,
          message:
            "session/load params.sessionId is required and must match [A-Za-z0-9][A-Za-z0-9_-]{0,127}",
        });
        return;
      }
      const result = await manager.loadSession({
        initializeParams: { protocolVersion: 1 },
        loadSessionParams: msg.params as { sessionId: string; [key: string]: unknown },
      });
      respondJsonRpc(res, msg.id ?? null, result.loadSessionResult);
      return;
    }

    // All other methods are session-scoped.
    if (!sessionId) {
      respondJson(res, 400, { error: `missing ${SESSION_HEADER} header for ${msg.method}` });
      return;
    }
    if (!isValidSessionId(sessionId)) {
      // Reject malformed header values BEFORE they reach the registry
      // lookup or any log line — defense-in-depth against header
      // injection / path traversal even though the value normally
      // round-trips from a daemon-issued response.
      respondJson(res, 400, {
        error: `${SESSION_HEADER} must match [A-Za-z0-9][A-Za-z0-9_-]{0,127}`,
      });
      return;
    }

    // SPEC.md §5: when the body carries `params.sessionId`, it must
    // match the routing header. Mismatch is almost always a client bug
    // (wrong header or stale prompt body); rejecting with 400 avoids
    // logs where the routing target and the body identity disagree.
    const bodySessionId = extractParamsSessionId(msg.params);
    if (bodySessionId !== undefined && bodySessionId !== sessionId) {
      respondJson(res, 400, {
        error: `params.sessionId (${bodySessionId}) does not match ${SESSION_HEADER} (${sessionId})`,
      });
      return;
    }

    if (msg.method === "session/cancel") {
      // ACP semantics: cancel is a notification. We accept it either as
      // a notification (no id) or as a request (id present); either way
      // it is forwarded as a notification to the child. If the client
      // sent it with an id, we still return a JSON-RPC response (null)
      // so HTTP clients that always include id do not hang. SPEC.md §9.
      try {
        manager.forwardNotification(sessionId, msg.method, msg.params ?? {});
      } catch (err) {
        if (err instanceof SessionNotFoundError || err instanceof SessionTerminatedError) {
          respondJson(res, 410, { error: err.message });
          return;
        }
        throw err;
      }
      if (isNotification) {
        res.statusCode = 202;
        res.end();
      } else {
        respondJsonRpc(res, msg.id ?? null, null);
      }
      return;
    }

    if (isNotification) {
      // Generic notification path: forward and 202.
      manager.forwardNotification(sessionId, msg.method, msg.params ?? {});
      res.statusCode = 202;
      res.end();
      return;
    }

    // Generic request path: forward and proxy the child's response.
    const childResp = await manager.forwardRequest(sessionId, msg.method, msg.params ?? {});
    if (childResp.error) {
      respondJsonRpc(res, msg.id ?? null, null, childResp.error);
    } else {
      respondJsonRpc(res, msg.id ?? null, childResp.result);
    }
  } catch (err) {
    if (err instanceof SessionNotFoundError || err instanceof SessionTerminatedError) {
      respondJson(res, 410, { error: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    respondJsonRpc(res, msg.id ?? null, null, {
      code: -32603,
      message,
      data: { source: "daemon" },
    });
  }
}

async function handleEvents(
  req: IncomingMessage,
  res: ServerResponse,
  manager: SessionManager,
): Promise<void> {
  const sessionHeader = req.headers[SESSION_HEADER];
  const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
  if (!sessionId) {
    respondJson(res, 400, { error: `missing ${SESSION_HEADER}` });
    return;
  }
  if (!isValidSessionId(sessionId)) {
    respondJson(res, 400, {
      error: `${SESSION_HEADER} must match [A-Za-z0-9][A-Za-z0-9_-]{0,127}`,
    });
    return;
  }
  const lastEventHeader = req.headers[LAST_EVENT_HEADER];
  const lastEventRaw = Array.isArray(lastEventHeader) ? lastEventHeader[0] : lastEventHeader;
  let fromCursor = 0;
  if (lastEventRaw !== undefined && lastEventRaw !== "") {
    const parsed = Number.parseInt(lastEventRaw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      respondJson(res, 400, { error: `invalid Last-Event-ID: ${lastEventRaw}` });
      return;
    }
    fromCursor = parsed;
  }

  // SSE headers must be sent BEFORE any data frames. Once headers are
  // out, errors can only flow as SSE events.
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const ac = new AbortController();
  const onClose = (): void => ac.abort();
  req.once("close", onClose);

  const keepalive = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      ac.abort();
    }
  }, SSE_KEEPALIVE_MS);
  keepalive.unref();

  try {
    for await (const event of manager.subscribe(sessionId, fromCursor, ac.signal)) {
      // _daemon/terminated is the synthetic exit marker.
      let isTerminated = false;
      try {
        const parsed = JSON.parse(event.data) as JsonRpcMessage;
        isTerminated = parsed.method === "_daemon/terminated";
      } catch {
        // event.data is always JSON we produced — but be defensive.
      }
      if (isTerminated) {
        res.write(`id: ${event.id}\nevent: terminated\ndata: ${event.data}\n\n`);
        // Close after the terminate event reaches the client.
        break;
      }
      res.write(`id: ${event.id}\ndata: ${event.data}\n\n`);
    }
  } catch (err) {
    if (err instanceof CursorLostError) {
      res.write(
        `event: cursor_lost\ndata: ${JSON.stringify({
          requested: err.requested,
          oldestAvailable: err.oldestAvailable,
        })}\n\n`,
      );
    } else if (err instanceof SessionNotFoundError || err instanceof SessionTerminatedError) {
      // The session disappeared between the handler attaching and a
      // first event being produced. Treat as terminated.
      res.write(`event: terminated\ndata: ${JSON.stringify({ reason: err.message })}\n\n`);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
    }
  } finally {
    clearInterval(keepalive);
    req.off("close", onClose);
    try {
      res.end();
    } catch {
      // ignore
    }
  }
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function respondJsonRpc(
  res: ServerResponse,
  id: number | string | null,
  result: unknown,
  error?: { code: number; message: string; data?: unknown },
): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  const body: JsonRpcMessage = error
    ? { jsonrpc: "2.0", id, error }
    : { jsonrpc: "2.0", id, result };
  res.end(JSON.stringify(body));
}

function extractParamsSessionId(params: unknown): string | undefined {
  if (params === null || typeof params !== "object") return undefined;
  const candidate = (params as { sessionId?: unknown }).sessionId;
  return typeof candidate === "string" ? candidate : undefined;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
