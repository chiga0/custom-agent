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

import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream } from "@custom-agent/schema/acp";
import { CustomAgent } from "./agent";

const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
const stream = ndJsonStream(output, input);

// The SDK invokes `toAgent(connection)` once and uses the returned Agent
// to dispatch incoming requests / notifications. The AgentSideConnection
// is kept alive by holding stream references; node exits when stdin closes.
new AgentSideConnection((conn) => new CustomAgent({ conn }), stream);
