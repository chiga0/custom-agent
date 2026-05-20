import type { AgentEvent } from "@custom-agent/schema";
import type { SessionUpdate } from "@custom-agent/schema/acp";

// AgentEvent → ACP SessionUpdate.
//
// Per [[adr-0004]] §1 this is the **only** path by which an internal
// AgentEvent reaches an external client. The mapper is intentionally narrow:
// it produces real Zed ACP SessionUpdate variants (with the canonical
// `sessionUpdate` discriminator and `ContentBlock` content), not a
// project-local approximation.
//
// Returns null when the event is not surfaced over the wire:
//   - session.created → already in newSession response; no separate update
//   - turn.started     → ACP has no "turn started" update; the turn is
//                        implicit when prompt() begins
//   - turn.completed   → ACP returns the outcome via PromptResponse.stopReason;
//                        no SessionUpdate is emitted for completion
//
// Mapped variants for M1:
//   - user.message  → `user_message_chunk`
//   - model.delta   → `agent_message_chunk`
//
// M3+ will add tool_call / tool_call_update / plan when ToolRouter and the
// PermissionEngine emit the corresponding internal events.
//
// M3-01 lands `tool.permission_requested` and `tool.permission_resolved`
// in the schema but does NOT surface them on the ACP wire yet. The audit
// trail lives in the event log; the wire-surface (e.g. ACP `request_permission`
// / `request_permission_response`) is M3-02's responsibility when actual
// tool calls start arriving over `session/prompt`.

export function mapEventToUpdate(event: AgentEvent): SessionUpdate | null {
  switch (event.type) {
    case "session.created":
    case "turn.started":
    case "turn.completed":
    case "tool.permission_requested":
    case "tool.permission_resolved":
    case "tool.started":
    case "tool.delta":
    case "tool.completed":
    case "tool.failed":
      // Tool events are audit-only in M3-02; the ACP wire surface for
      // tool calls (session/update tool_call / tool_call_update) is
      // M3-02b's responsibility when the SessionEngine actually drives
      // tool calls from the model loop. Today's transcript only shows
      // user / agent text chunks.
      return null;
    case "user.message":
      return {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: event.payload.content },
      };
    case "model.delta":
      return {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: event.payload.text },
      };
  }
}
