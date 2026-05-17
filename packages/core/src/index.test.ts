import { describe, expect, it } from "vitest";
import { isAgentEvent } from "@custom-agent/schema";
import { SessionEngine } from "./index";

describe("SessionEngine", () => {
  it("creates replayable fake turn events", () => {
    let id = 0;
    const engine = new SessionEngine({
      now: () => new Date("2026-05-17T00:00:00.000Z"),
      createId: (prefix) => `${prefix}_${++id}`,
    });

    const session = engine.createSession("/tmp/custom-agent");
    const turn = engine.runFakeTurn({
      sessionId: session.sessionId,
      cwd: "/tmp/custom-agent",
      prompt: "Initialize the project.",
    });

    expect([session, ...turn].every(isAgentEvent)).toBe(true);
    expect(turn.map((event) => event.type)).toEqual([
      "turn.started",
      "user.message",
      "model.delta",
      "turn.completed",
    ]);
  });
});
