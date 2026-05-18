import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@custom-agent/schema";
import { mapEventToUpdate } from "./event-mapper";

function event<T extends AgentEvent["type"]>(
  type: T,
  payload: Extract<AgentEvent, { type: T }>["payload"],
  turnId?: string,
): AgentEvent {
  return {
    id: "evt_1",
    schemaVersion: 1,
    sessionId: "sess_1",
    turnId,
    sequence: 1,
    timestamp: "2026-05-18T00:00:00.000Z",
    type,
    payload,
  } as AgentEvent;
}

describe("mapEventToUpdate (ACP SessionUpdate)", () => {
  it("returns null for session.created — info is in newSession response", () => {
    const e = event("session.created", { cwd: "/tmp", client: "test" });
    expect(mapEventToUpdate(e)).toBeNull();
  });

  it("returns null for turn.started — ACP has no turn-started update", () => {
    const e = event("turn.started", { promptPreview: "hello" }, "turn_a");
    expect(mapEventToUpdate(e)).toBeNull();
  });

  it("returns null for turn.completed — outcome is in PromptResponse.stopReason", () => {
    const e = event("turn.completed", { stopReason: "final" }, "turn_a");
    expect(mapEventToUpdate(e)).toBeNull();
  });

  it("maps user.message → ACP user_message_chunk with text ContentBlock", () => {
    const e = event("user.message", { content: "hello world" }, "turn_a");
    expect(mapEventToUpdate(e)).toEqual({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "hello world" },
    });
  });

  it("maps model.delta → ACP agent_message_chunk with text ContentBlock", () => {
    const e = event("model.delta", { text: "chunk" }, "turn_a");
    expect(mapEventToUpdate(e)).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "chunk" },
    });
  });

  it("is deterministic — same input → same output object structure", () => {
    const e = event("model.delta", { text: "abc" }, "turn_a");
    const a = mapEventToUpdate(e);
    const b = mapEventToUpdate(e);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("uses the canonical sessionUpdate discriminator field name (not 'type')", () => {
    const e = event("model.delta", { text: "x" }, "turn_a");
    const update = mapEventToUpdate(e);
    expect(update).toHaveProperty("sessionUpdate");
    expect(update).not.toHaveProperty("type");
  });
});
