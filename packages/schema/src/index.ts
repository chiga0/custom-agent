export type EventEnvelope<TType extends string, TPayload extends Record<string, unknown>> = {
  id: string;
  schemaVersion: 1;
  sessionId: string;
  turnId?: string;
  sequence: number;
  timestamp: string;
  type: TType;
  payload: TPayload;
};

export type SessionCreatedEvent = EventEnvelope<
  "session.created",
  {
    cwd: string;
    client: "web" | "cli" | "acp" | "test";
  }
>;

export type TurnStartedEvent = EventEnvelope<
  "turn.started",
  {
    promptPreview: string;
  }
>;

export type UserMessageEvent = EventEnvelope<
  "user.message",
  {
    content: string;
  }
>;

export type ModelDeltaEvent = EventEnvelope<
  "model.delta",
  {
    text: string;
  }
>;

/**
 * Structured diagnostic code attached to `turn.completed` when
 * `stopReason === "error"`. Open string union: M2-01 introduces
 * `context_overflow` (ADR-0003 §2); future provider / tool failures
 * may add more variants (e.g. `provider_unavailable`, `tool_denied`).
 *
 * Omitted on successful turns (`stopReason === "final"`) and on
 * user-cancelled turns (`stopReason === "cancelled"`).
 */
export type TurnErrorCode = "context_overflow" | "provider_failure" | "unknown";

/** Coarse risk tier on a tool invocation (M3-01). Drives default policy. */
export type ToolRisk = "read" | "write" | "execute" | "network";

/** Synchronous policy decision returned by PermissionEngine.evaluate (M3-01). */
export type PermissionDecision = "allow" | "ask" | "deny";

/** Resolved outcome after the (possibly async) ask flow finishes. */
export type PermissionOutcome = "allowed" | "denied";

/**
 * Source of the resolved outcome — was it a static policy match
 * (no human-in-the-loop), or did a human / client explicitly approve?
 * Recorded on `tool.permission_resolved` for audit.
 */
export type PermissionOutcomeSource = "policy" | "user";

export type TurnCompletedEvent = EventEnvelope<
  "turn.completed",
  {
    stopReason: "final" | "cancelled" | "error";
    errorCode?: TurnErrorCode;
    usage?: { promptTokens: number; completionTokens: number };
  }
>;

/**
 * Emitted by PermissionEngine when a tool invocation needs evaluation
 * (M3-01). Always emitted — even for `allow`-by-policy decisions — so
 * the audit log captures every tool intent BEFORE execution.
 */
export type ToolPermissionRequestedEvent = EventEnvelope<
  "tool.permission_requested",
  {
    /** Stable id correlating request <-> resolved events for the same call. */
    requestId: string;
    /** ACP-style tool call id, when available (M3 wires this from tool router). */
    toolCallId?: string;
    toolName: string;
    risk: ToolRisk;
    /** Synchronous policy decision: allow / ask / deny. */
    decision: PermissionDecision;
    /** Free-form reason from the agent (helps the user judge ask-flow prompts). */
    reason: string;
    /** Tool arguments preview (truncated; M3-02 will pin the budget). */
    argsPreview?: string;
  }
>;

/**
 * Emitted by PermissionEngine when a `requestId` reaches its terminal
 * `allowed` / `denied` outcome. For `decision: "allow" | "deny"` policy
 * matches the resolved event fires synchronously after the requested
 * event; for `decision: "ask"` the resolved event fires when the
 * injected approval source returns.
 */
export type ToolPermissionResolvedEvent = EventEnvelope<
  "tool.permission_resolved",
  {
    requestId: string;
    toolCallId?: string;
    toolName: string;
    outcome: PermissionOutcome;
    /** Where the outcome came from (`policy` for auto-decided, `user` for ask). */
    source: PermissionOutcomeSource;
    /** Optional free-form reason supplied by the deciding party. */
    reason?: string;
  }
>;

/**
 * Emitted when ToolRouter has confirmed permission and is about to
 * invoke the executor (M3-02). Provides correlation across the
 * lifecycle and a pre-execution snapshot of the args (already
 * truncated by the router).
 */
export type ToolStartedEvent = EventEnvelope<
  "tool.started",
  {
    /** Stable per-invocation id; same value appears on delta / completed / failed. */
    toolCallId: string;
    /** Optional id linking back to the matching tool.permission_resolved. */
    permissionRequestId?: string;
    toolName: string;
    argsPreview?: string;
  }
>;

/** Stream chunk from a tool execution (e.g. a shell line, a search hit). */
export type ToolDeltaEvent = EventEnvelope<
  "tool.delta",
  {
    toolCallId: string;
    /** Discriminator for the chunk content variant. */
    kind: "stdout" | "stderr" | "result";
    text: string;
  }
>;

export type ToolCompletedEvent = EventEnvelope<
  "tool.completed",
  {
    toolCallId: string;
    toolName: string;
    /** Number of `tool.delta` events emitted in this invocation (for audit). */
    deltaCount: number;
    /** Was the output truncated by the budget? */
    truncated: boolean;
  }
>;

/**
 * Open string union for structured tool failure reasons. M3-02 lays
 * down the initial vocabulary; M3-03+ will extend.
 */
export type ToolErrorCode =
  | "permission_denied"
  | "path_unsafe"
  | "not_found"
  | "io_error"
  | "budget_exceeded"
  | "cancelled"
  | "unknown";

export type ToolFailedEvent = EventEnvelope<
  "tool.failed",
  {
    toolCallId: string;
    toolName: string;
    errorCode: ToolErrorCode;
    message: string;
  }
>;

export type AgentEvent =
  | SessionCreatedEvent
  | TurnStartedEvent
  | UserMessageEvent
  | ModelDeltaEvent
  | TurnCompletedEvent
  | ToolPermissionRequestedEvent
  | ToolPermissionResolvedEvent
  | ToolStartedEvent
  | ToolDeltaEvent
  | ToolCompletedEvent
  | ToolFailedEvent;

export const eventTypes = [
  "session.created",
  "turn.started",
  "user.message",
  "model.delta",
  "turn.completed",
  "tool.permission_requested",
  "tool.permission_resolved",
  "tool.started",
  "tool.delta",
  "tool.completed",
  "tool.failed",
] as const satisfies readonly AgentEvent["type"][];

// ACP (Agent Client Protocol) wire-contract types live in a separate
// subpath (`@custom-agent/schema/acp`) so non-ACP consumers of this schema
// package don't transitively load the ACP SDK runtime. Import only what
// you need:
//   - AgentEvent types / isAgentEvent → `@custom-agent/schema`
//   - ACP wire types / AgentSideConnection / ndJsonStream → `@custom-agent/schema/acp`
// See packages/schema/src/acp.ts for what the subpath exports.

export function isAgentEvent(value: unknown): value is AgentEvent {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<AgentEvent>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.id === "string" &&
    typeof candidate.sessionId === "string" &&
    typeof candidate.sequence === "number" &&
    typeof candidate.timestamp === "string" &&
    typeof candidate.type === "string" &&
    eventTypes.includes(candidate.type as AgentEvent["type"]) &&
    typeof candidate.payload === "object" &&
    candidate.payload !== null
  );
}
