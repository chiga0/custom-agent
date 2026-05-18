// Public API of @custom-agent/acp-server.
//
// Protocol types come from @custom-agent/schema (which re-exports the
// official Zed ACP SDK). This package only owns transport + dispatch +
// AgentEvent ↔ ACP SessionUpdate mapping. See ./agent.ts for the Agent
// interface implementation that backs the stdio binary.

export { CustomAgent, ACP_PROTOCOL_VERSION, type CustomAgentOptions } from "./agent";
export { mapEventToUpdate } from "./event-mapper";
export { JsonlSessionStore } from "./jsonl-store";
