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

export type TurnCompletedEvent = EventEnvelope<
  "turn.completed",
  {
    stopReason: "final" | "cancelled" | "error";
  }
>;

export type AgentEvent =
  | SessionCreatedEvent
  | TurnStartedEvent
  | UserMessageEvent
  | ModelDeltaEvent
  | TurnCompletedEvent;

export const eventTypes = [
  "session.created",
  "turn.started",
  "user.message",
  "model.delta",
  "turn.completed",
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
