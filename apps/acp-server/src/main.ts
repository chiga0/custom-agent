// Binary entry: wires the ACP SDK to process.stdin/stdout.
//
// Per [[adr-0004]] §3 the stdio wire form is the canonical entrypoint —
// editors (Zed, etc.) spawn this binary directly; the daemon
// (M1-ACP-HTTP) will spawn one child per session.
//
// We use the SDK's ndJsonStream + AgentSideConnection so framing,
// JSON-RPC dispatch, error wrapping, and notification semantics
// (especially `session/cancel` as notification, not request) all come
// from the official implementation. Our job is only to implement the
// `Agent` interface (see ./agent.ts).
//
// Environment:
//   ACP_EVENT_LOG_ROOT — directory used to persist per-session JSONL
//     event logs. The daemon (M1-ACP-HTTP) sets this once at daemon
//     startup and propagates it to every spawned acp-server child so
//     that a separately-spawned replay child (M1-04 session/load) can
//     find the same file the writer child appended to. When unset
//     (e.g. an editor invoking acp-server directly), CustomAgent
//     defaults to a per-process tmpdir — that mode does not support
//     cross-process session/load.

import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream } from "@custom-agent/schema/acp";
import { CustomAgent } from "./agent";

const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
const stream = ndJsonStream(output, input);

const eventLogRoot = process.env.ACP_EVENT_LOG_ROOT;

// The SDK invokes `toAgent(connection)` once and uses the returned Agent
// to dispatch incoming requests / notifications. The AgentSideConnection
// is kept alive by holding stream references; node exits when stdin closes.
new AgentSideConnection((conn) => new CustomAgent({ conn, eventLogRoot }), stream);
