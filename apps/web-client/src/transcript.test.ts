import { describe, expect, it } from "vitest";
import type { SessionUpdate } from "@custom-agent/schema/acp";
import { EMPTY_TRANSCRIPT, applySessionUpdate, type TranscriptState } from "./transcript";

function user(text: string): SessionUpdate {
  return { sessionUpdate: "user_message_chunk", content: { type: "text", text } };
}

function agent(text: string): SessionUpdate {
  return { sessionUpdate: "agent_message_chunk", content: { type: "text", text } };
}

describe("applySessionUpdate", () => {
  it("opens a user turn from an empty transcript", () => {
    const next = applySessionUpdate(EMPTY_TRANSCRIPT, user("hello"));
    expect(next.turns).toHaveLength(1);
    expect(next.turns[0]).toEqual({ id: 1, role: "user", text: "hello" });
    expect(next.nextId).toBe(2);
  });

  it("opens an agent turn after a user turn", () => {
    let s: TranscriptState = EMPTY_TRANSCRIPT;
    s = applySessionUpdate(s, user("hi"));
    s = applySessionUpdate(s, agent("hello"));
    expect(s.turns.map((t) => `${t.role}:${t.text}`)).toEqual(["user:hi", "agent:hello"]);
    expect(s.turns[0].id).toBe(1);
    expect(s.turns[1].id).toBe(2);
  });

  it("coalesces back-to-back agent_message_chunk events into one turn", () => {
    let s: TranscriptState = EMPTY_TRANSCRIPT;
    s = applySessionUpdate(s, agent("Hello, "));
    s = applySessionUpdate(s, agent("world."));
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]).toEqual({ id: 1, role: "agent", text: "Hello, world." });
  });

  it("opens a new turn when role flips", () => {
    let s: TranscriptState = EMPTY_TRANSCRIPT;
    s = applySessionUpdate(s, user("a"));
    s = applySessionUpdate(s, agent("b"));
    s = applySessionUpdate(s, user("c"));
    expect(s.turns.map((t) => t.role)).toEqual(["user", "agent", "user"]);
    expect(s.turns.map((t) => t.id)).toEqual([1, 2, 3]);
  });

  it("is a no-op for non-text content (image / audio / embedded)", () => {
    const s = applySessionUpdate(EMPTY_TRANSCRIPT, {
      sessionUpdate: "agent_message_chunk",
      // SDK type allows other content variants; cast to test the defensive path.
      content: { type: "image", data: "x", mimeType: "image/png" },
    } as unknown as SessionUpdate);
    expect(s).toBe(EMPTY_TRANSCRIPT);
  });

  it("is a no-op for unknown SessionUpdate variants (tool_call, plan, ...)", () => {
    const s = applySessionUpdate(EMPTY_TRANSCRIPT, {
      sessionUpdate: "tool_call",
    } as unknown as SessionUpdate);
    expect(s).toBe(EMPTY_TRANSCRIPT);
  });

  it("returns a NEW state reference on real updates (cheap diffing)", () => {
    const next = applySessionUpdate(EMPTY_TRANSCRIPT, user("hi"));
    expect(next).not.toBe(EMPTY_TRANSCRIPT);
  });
});
