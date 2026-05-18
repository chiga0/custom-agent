// ACP wire-protocol contract re-export.
//
// We use the official Zed-published SDK so the protocol stays bit-for-bit in
// sync with the canonical spec at https://agentclientprotocol.com. Pinning
// the contract here (in @custom-agent/schema) satisfies AGENTS.md's
// non-negotiable rule that public contracts live in a schema package — the
// SDK is the contract, and we expose it through the project's schema barrel.
//
// Per [[adr-0004]] this is the **single** wire protocol for client ↔ core
// communication. Adapters under apps/* (acp-server, future acp-daemon) and
// any client (web / cli / TUI / IDE) must speak ACP and only ACP.
//
// Two layers of the SDK are re-exported:
//
// 1. Static TypeScript types (`schema.*`) for compile-time checks and IDE
//    autocompletion. Zero runtime cost.
// 2. The `AgentSideConnection` runtime helper + `ndJsonStream` factory —
//    used by apps/acp-server to wire stdio. We keep this re-export at the
//    schema-package level so future adapters (acp-daemon HTTP transport)
//    can pull from the same place without each app re-declaring the dep.

export {
  AgentSideConnection,
  ndJsonStream,
  type Agent,
  type Client,
  type Stream,
} from "@agentclientprotocol/sdk";

// Re-export every generated schema type. The SDK's `schema/types.gen.ts`
// keeps these in sync with the upstream JSON schema; we don't curate a
// subset because future ACP additions (e.g. session.fork) should flow in
// without forcing a schema-package edit.
export type * from "@agentclientprotocol/sdk";
