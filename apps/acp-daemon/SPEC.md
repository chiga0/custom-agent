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

## 6. session/new Handshake

`session/new` is the only method that creates state in the daemon. The
flow:

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
