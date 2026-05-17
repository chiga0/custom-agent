import { describe, expect, it } from "vitest";
import { eventTypes, isAgentEvent, type AgentEvent } from "./index";

describe("agent event schema", () => {
  it("accepts a valid event envelope", () => {
    const event: AgentEvent = {
      id: "evt_1",
      schemaVersion: 1,
      sessionId: "sess_1",
      sequence: 1,
      timestamp: "2026-05-17T00:00:00.000Z",
      type: "session.created",
      payload: {
        cwd: "/tmp/project",
        client: "test",
      },
    };

    expect(isAgentEvent(event)).toBe(true);
  });

  it("keeps the initial public event list intentionally small", () => {
    expect(eventTypes).toEqual([
      "session.created",
      "turn.started",
      "user.message",
      "model.delta",
      "turn.completed",
    ]);
  });
});
