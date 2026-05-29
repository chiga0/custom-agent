import type { AgentEvent } from "@custom-agent/schema";
import type { SessionUpdate } from "@custom-agent/schema/acp";

// AgentEvent → ACP SessionUpdate.
//
// Per [[adr-0004]] §1 this is the **only** path by which an internal
// AgentEvent reaches an external client. The mapper produces real ACP
// SessionUpdate variants (canonical `sessionUpdate` discriminator).
//
// Returns null when the event is not surfaced over the wire:
//   - session.created → already in newSession response
//   - turn.started    → implicit when prompt() begins
//
// Mapped variants:
//   - user.message              → user_message_chunk
//   - model.delta               → agent_message_chunk
//   - turn.completed (w/ usage) → usage_update
//   - tool.permission_requested → tool_call (pending)
//   - tool.permission_resolved  → tool_call_update (_meta)
//   - tool.started              → tool_call_update (in_progress)
//   - tool.delta                → tool_call_update (content)
//   - tool.completed            → tool_call_update (completed)
//   - tool.failed               → tool_call_update (failed)

export function mapEventToUpdate(event: AgentEvent): SessionUpdate | null {
  switch (event.type) {
    case "session.created":
    case "turn.started":
      return null;
    case "turn.completed": {
      const u = event.payload.usage;
      if (!u) return null;
      const total = u.promptTokens + u.completionTokens;
      return { sessionUpdate: "usage_update", size: total, used: total } as SessionUpdate;
    }
    case "tool.permission_requested":
      return {
        sessionUpdate: "tool_call",
        toolCallId: event.payload.toolCallId ?? event.payload.requestId,
        title: event.payload.toolName,
        status: "pending",
        kind: mapRiskToToolKind(event.payload.risk),
        _meta: { risk: event.payload.risk, decision: event.payload.decision },
      } as SessionUpdate;
    case "tool.permission_resolved":
      return {
        sessionUpdate: "tool_call_update",
        toolCallId: event.payload.toolCallId ?? event.payload.requestId,
        _meta: { outcome: event.payload.outcome, source: event.payload.source },
      } as SessionUpdate;
    case "tool.started":
      return {
        sessionUpdate: "tool_call_update",
        toolCallId: event.payload.toolCallId,
        status: "in_progress",
        ...(event.payload.argsPreview && { rawInput: event.payload.argsPreview }),
      } as SessionUpdate;
    case "tool.delta":
      return {
        sessionUpdate: "tool_call_update",
        toolCallId: event.payload.toolCallId,
        content: [{ type: "content", content: { type: "text", text: event.payload.text } }],
      } as SessionUpdate;
    case "tool.completed":
      return {
        sessionUpdate: "tool_call_update",
        toolCallId: event.payload.toolCallId,
        status: "completed",
      } as SessionUpdate;
    case "tool.failed":
      return {
        sessionUpdate: "tool_call_update",
        toolCallId: event.payload.toolCallId,
        status: "failed",
        _meta: { errorCode: event.payload.errorCode, message: event.payload.message },
      } as SessionUpdate;
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

function mapRiskToToolKind(risk: string): string {
  switch (risk) {
    case "read":
      return "read";
    case "write":
      return "edit";
    case "execute":
      return "execute";
    case "network":
      return "fetch";
    default:
      return "other";
  }
}
