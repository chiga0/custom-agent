# ACP Streamable HTTP Transport — Project Spec

> Status: Draft (M1-ACP-HTTP).
>
> This document describes the **transport** used by `@custom-agent/acp-daemon`
> to expose the [Zed Agent Client Protocol][acp] over HTTP+SSE. It is **not**
> a fork or extension of the ACP protocol itself — the JSON-RPC message
> shapes are unchanged. Only the wire framing differs from the canonical
> stdio binding.
>
> See also: [`adr-0004` (ACP unified transport)][adr-0004].

[acp]: https://agentclientprotocol.com
[adr-0004]: https://github.com/chiga0/custom-agent-docs/blob/main/docs/zh/adr/0004-acp-unified-transport.md

## 1. Naming & Scope

The transport is named **"ACP Streamable HTTP"** by analogy with MCP's
Streamable HTTP transport. It is a **project-internal extension** and
MUST NOT be presented to upstream Zed ACP consumers as part of the
canonical wire form. The canonical wire form remains stdio.

What this transport provides:

- POST JSON-RPC request → JSON-RPC response.
- Long-lived SSE stream for `session/update` notifications.
- Per-session routing via header.
- Cursor-based reconnect.
- Bearer-token auth gating both endpoints.

What this transport does **not** provide:

- Client-bound JSON-RPC requests (the daemon never originates a request
  to the client over this transport). All client→agent traffic is
  initiated by the client.
- Bidirectional streaming inside a single HTTP request.

## 2. Endpoints

| Method | Path       | Purpose                                                                                                                |
| ------ | ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/rpc`     | Send JSON-RPC request or notification; receive JSON-RPC response (for requests) or `202 Accepted` (for notifications). |
| `GET`  | `/events`  | Open SSE stream of `session/update` notifications for the session named by `X-ACP-Session-Id`.                         |
| `GET`  | `/healthz` | Liveness probe (no auth). Returns `200 ok`.                                                                            |

All other paths return `404 Not Found`.

## 3. Authentication

Every request to `/rpc` and `/events` MUST present:

```
Authorization: Bearer <token>
```

The token is configured via the `ACP_DAEMON_AUTH_TOKEN` environment
variable when the daemon starts. The daemon refuses to start if the
variable is unset or empty (fail-closed). The token is compared in
constant time.

Failure modes:

- Missing `Authorization` header → `401 Unauthorized`.
- Wrong scheme (not `Bearer`) → `401 Unauthorized`.
- Token mismatch → `401 Unauthorized`.

`/healthz` is the only endpoint exempt from auth so external supervisors
(systemd, k8s liveness, local launcher) can probe the daemon without a
token.

### Browser CORS

The daemon is local-first, but the Web client usually runs from a different
loopback origin (for example `http://127.0.0.1:5173`). Browsers therefore
preflight `/rpc` and `/events` because requests carry `Authorization` and
session-routing headers.

For loopback browser origins only (`localhost`, `127.0.0.0/8`, `::1`) and
`Origin: null` local-file contexts, the daemon:

- Responds to unauthenticated `OPTIONS /rpc`, `OPTIONS /events`, and
  `OPTIONS /healthz` with `204 No Content`.
- Allows `GET`, `POST`, and `OPTIONS`.
- Allows `Authorization`, `Content-Type`, `X-ACP-Session-Id`, and
  `Last-Event-ID`.
- Reflects the allowed origin and sets `Vary: Origin`.

Non-loopback browser origins are rejected with `403 Forbidden` before auth
or session mutation. Non-browser clients that omit `Origin` are unaffected.

## 4. JSON-RPC Envelope

The body of `POST /rpc` is a single JSON-RPC 2.0 message:

```jsonc
{
  "jsonrpc": "2.0",
  "id": 7,           // omitted for notifications
  "method": "session/prompt",
  "params": { ... }
}
```

The response body for **requests** is a JSON-RPC 2.0 response:

```jsonc
{
  "jsonrpc": "2.0",
  "id": 7,
  "result": { ... }
}
```

or, on error:

```jsonc
{
  "jsonrpc": "2.0",
  "id": 7,
  "error": { "code": -32603, "message": "..." },
}
```

For **notifications** (no `id`), the daemon returns `202 Accepted` with
an empty body. Notifications never receive a JSON-RPC response.

Routing rules:

| Method           | Session header required | Forwarded to                    |
| ---------------- | ----------------------- | ------------------------------- |
| `initialize`     | No                      | Embedded handshake (see §6)     |
| `session/new`    | No                      | Spawned child after handshake   |
| `session/load`   | No (id is in params)    | Spawned child after handshake   |
| `session/prompt` | Yes                     | Existing child for that session |
| `session/cancel` | Yes (notification)      | Existing child as notification  |
| `authenticate`   | Optional                | Embedded (returns empty result) |

Unknown methods return JSON-RPC error `-32601 Method not found`.

## 5. Session Header

After a successful `session/new`, the daemon returns a `sessionId` in
the JSON-RPC result. The client MUST include this id on every
subsequent `/rpc` and `/events` request:

```
X-ACP-Session-Id: <sessionId>
```

The daemon constrains session ids to the regex
`[A-Za-z0-9][A-Za-z0-9_-]{0,127}` (max 128 characters, starts with an
alphanumeric, only alphanumerics + `_` + `-` thereafter). Ids are used
as filesystem path components, HTTP header values, and log tokens; the
constraint blocks path traversal, header continuation, and noisy log
lines from a hostile or buggy client. The daemon REJECTS:

- A `session/load` whose `params.sessionId` violates the pattern
  (`-32602` "invalid params").
- Any session-scoped request whose `X-ACP-Session-Id` violates the
  pattern (HTTP `400 Bad Request`).

Daemon behavior when the header is missing on a session-scoped method
or `/events`:

- `400 Bad Request` with body `{ "error": "missing X-ACP-Session-Id" }`.

When the header names an unknown or terminated session:

- `410 Gone` with body `{ "error": "session not found or terminated" }`.

When the body carries `params.sessionId` AND it disagrees with the
routing header, the daemon rejects with `400 Bad Request`. Routing
identity and body identity must agree; otherwise the request is
almost certainly a client bug (wrong header or stale body) and the
daemon's logs would be misleading. Clients that prefer header-only
addressing may simply omit `params.sessionId`.

## 6. session/new and session/load Handshakes

Two methods create state in the daemon: `session/new` (live, fresh) and
`session/load` (replay an existing on-disk session). Both spawn a fresh
`apps/acp-server` child and run an embedded `initialize` before
forwarding the high-level request.

### 6.1 session/new

1. Client POSTs `session/new` (no session header).
2. Daemon spawns one `apps/acp-server` child process.
3. Daemon performs the embedded `initialize` handshake with the child
   over stdio (so the child is fully ready before user prompts arrive).
   In M1 the daemon always initializes the child with
   `protocolVersion: 1`. The daemon-level `initialize` call is currently
   stateless — it echoes the client's negotiated version back but does
   not thread it into the child handshake. Real per-session version
   negotiation lands with M2 when more than one protocol version exists.
4. Daemon forwards `session/new` to the child as a JSON-RPC request,
   awaits the response, and returns the child's `sessionId` to the
   client in the HTTP body.
5. Daemon remembers the mapping `sessionId → child handle` until the
   child exits or `terminate` is called.

The daemon-level `initialize` call is OPTIONAL; if the client calls it
before `session/new`, the daemon responds with the same
`InitializeResponse` the child would produce in M1, so the daemon-level
capability negotiation matches what the child later advertises. The
call is purely informational in M1 and does not influence child spawn
parameters.

### 6.2 session/load (replay)

`session/load` resurrects an existing on-disk session and re-emits its
historical `session/update` notifications. The client supplies the
sessionId in the request body (NOT the header). Flow:

1. Client POSTs `session/load` with `params.sessionId` (no session
   header).
2. Daemon spawns a fresh `apps/acp-server` child process, passing
   `ACP_EVENT_LOG_ROOT` via env so the child can find the persisted
   JSONL log written earlier by the original writer process.
3. Daemon wires the cursor + notification listener BEFORE issuing
   `session/load` — the child's `loadSession` handler synchronously
   emits one `session/update` per mapped historical AgentEvent, and
   those notifications must land in the cursor (so SSE consumers can
   read them) rather than be dropped between request issue and response
   receipt.
4. Daemon runs the embedded `initialize` (same as §6.1).
5. Daemon forwards `session/load` to the child as a JSON-RPC request.
   The child reads its JSONL, emits `session/update` notifications via
   stdio, then returns an empty `LoadSessionResponse`.
6. Daemon returns the empty response to the client. The client may now
   attach to `GET /events` with `X-ACP-Session-Id` set to the loaded id
   and replay the buffered notifications.

The daemon refuses to load a sessionId that is already alive in this
daemon process — concurrent writer+replay over the same JSONL is not
supported in M1 (each acp-server child opens the log fresh). Subsequent
`session/prompt` on a loaded session is rejected by acp-server because
the in-memory engine state was not reconstructed; this is the
"replay-only" semantic. Resuming a loaded session (engine state
reconstruction) is reserved for a future "resume" semantic.

The shared event log root is set via the `ACP_EVENT_LOG_ROOT`
environment variable on the daemon process. When unset the daemon
mkdtemps a per-process directory and propagates it to every spawned
child; that mode supports cross-process load WITHIN one daemon lifetime
but not across daemon restarts.

The ACP `LoadSessionRequest.additionalDirectories` field is **ignored
in M1** — the writer-side cwd is already pinned in the `session.created`
event payload and reproducing the writer's directory roots is a M3+
MCP concern. Future revisions may activate additional roots before the
replay; clients SHOULD NOT depend on the field having any effect today.

## 7. SSE Stream

`GET /events` upgrades to an SSE stream. The response sets:

```
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
```

Each `session/update` notification produced by the child is forwarded
as one SSE event:

```
id: 42
data: {"jsonrpc":"2.0","method":"session/update","params":{...}}

```

(The trailing blank line is mandatory per SSE.)

The `id:` field carries a **monotonic per-session sequence number**
starting at `1`. The cursor is purely positional — it has no time
ordering guarantee beyond "the daemon received this event from the
child in this order."

The SSE stream stays open until any of:

- Client disconnects.
- Child process exits (daemon writes one final event with
  `event: terminated` and closes the stream).
- Daemon shutdown.

When the child exits the daemon writes the final frame as:

```
id: <next-cursor-id>
event: terminated
data: {"jsonrpc":"2.0","method":"_daemon/terminated","params":{"sessionId":"<id>","reason":"child_exited(code=<code>, signal=<signal>)"}}
```

The `data:` field carries a JSON-RPC-shaped notification with a
daemon-reserved method name (`_daemon/terminated`, underscore prefix to
avoid collision with ACP-defined methods). Clients SHOULD parse the
`reason` field for diagnostics but MUST NOT route the frame as a real
JSON-RPC notification. The daemon never delivers `_daemon/terminated`
on the JSON-RPC channel — only as the SSE wrapper above.

The daemon SHOULD send a comment-only keep-alive frame (`: ping\n\n`)
every 15 seconds to detect dead intermediate proxies.

## 8. Reconnect & Cursor

When the SSE stream drops, the client MAY reconnect with:

```
Last-Event-ID: <n>
```

The daemon replays every buffered event with sequence > `n`, then
continues from live. If `n` is older than the daemon's retention
window, the daemon writes:

```
event: cursor_lost
data: {"requested":<n>,"oldestAvailable":<m>}

```

and closes the stream; the client SHOULD restart the session from
`session/load` (M1-04) rather than guess.

Retention window: in-memory ring buffer of the last **256** events per
session. The number is conservative (typical `session/update` payloads
are < 4 KiB; 256 × 4 KiB ≈ 1 MiB per session worst case). The retention
window is NOT persisted across daemon restarts — daemon restart is a
"cursor_lost" event for every active session, signalled by the
connection drop.

## 9. Cancel

`session/cancel` is sent as a JSON-RPC **notification** (no `id`) via
POST `/rpc`. The daemon validates the session header, forwards the
notification to the child, and immediately returns `202 Accepted`. The
child handles the cancellation per ACP rules.

If the client mistakenly sends `session/cancel` as a JSON-RPC request
(with an `id`), the daemon still forwards it as a notification to the
child and returns a JSON-RPC response with `result: null` so HTTP
clients that always include `id` do not hang.

## 10. Crash & Lifecycle

When a child process exits unexpectedly (non-zero exit, signal, or
parser detects framing corruption):

1. Daemon marks the session as `terminated`.
2. The SSE stream for that session emits one final event of the form:

   ```
   event: terminated
   data: {"reason":"child_exited","code":<code>}

   ```

   and closes.

3. Subsequent `/rpc` calls for that `sessionId` return `410 Gone`.
4. Other sessions are unaffected — by construction each session owns
   its own child process.

When the daemon receives `SIGINT` / `SIGTERM`:

1. Stop accepting new connections.
2. Send each child a graceful shutdown signal.
3. Close all SSE streams.
4. Exit after a 5-second grace period (force-kill remaining children).

## 11. Errors

HTTP layer:

| Status                       | Reason                                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `200 OK`                     | Successful JSON-RPC response (including JSON-RPC `error` bodies)                                                     |
| `202 Accepted`               | JSON-RPC notification accepted                                                                                       |
| `400 Bad Request`            | Malformed JSON, missing session header, or invalid Last-Event-ID                                                     |
| `401 Unauthorized`           | Missing / wrong bearer token                                                                                         |
| `404 Not Found`              | Unknown path                                                                                                         |
| `405 Method Not Allowed`     | Wrong HTTP verb for a known path                                                                                     |
| `410 Gone`                   | Session terminated                                                                                                   |
| `415 Unsupported Media Type` | POST without `Content-Type: application/json`                                                                        |
| `500 Internal Server Error`  | Daemon-internal failure (does not include child-originated errors; those flow back as JSON-RPC errors with `200 OK`) |

JSON-RPC errors flow through unchanged from the child. The daemon does
not invent additional codes; it only annotates with `data: { "source": "daemon" }`
when the error originates in the daemon (e.g. spawn failure on
`session/new`).

## 12. Versioning

The transport spec itself is versioned independently of the ACP
protocol. Current version: **0.1.0**. Breaking changes update the
minor version pre-1.0 and the major version after.

Clients MAY include `X-ACP-Transport-Version` on requests for forward
compatibility; the daemon currently ignores this header and always
serves 0.1.0.
