import { describe, expect, it } from "vitest";
import type { SessionUpdate } from "@custom-agent/schema/acp";
import { EMPTY_TRANSCRIPT, applySessionUpdate, type TranscriptState } from "./transcript";

function user(text: string): SessionUpdate {
  return { sessionUpdate: "user_message_chunk", content: { type: "text", text } };
}

function agent(text: string): SessionUpdate {
  return { sessionUpdate: "agent_message_chunk", content: { type: "text", text } };
}

function toolCall(toolCallId: string, title: string, kind = "read"): SessionUpdate {
  return {
    sessionUpdate: "tool_call",
    toolCallId,
    title,
    status: "pending",
    kind,
    _meta: { risk: "read", decision: "auto-allow" },
  } as unknown as SessionUpdate;
}

function toolCallUpdate(toolCallId: string, fields: Record<string, unknown> = {}): SessionUpdate {
  return {
    sessionUpdate: "tool_call_update",
    toolCallId,
    ...fields,
  } as unknown as SessionUpdate;
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

  it("is a no-op for unknown SessionUpdate variants (plan, ...)", () => {
    const s = applySessionUpdate(EMPTY_TRANSCRIPT, {
      sessionUpdate: "plan",
    } as unknown as SessionUpdate);
    expect(s).toBe(EMPTY_TRANSCRIPT);
  });

  it("returns a NEW state reference on real updates (cheap diffing)", () => {
    const next = applySessionUpdate(EMPTY_TRANSCRIPT, user("hi"));
    expect(next).not.toBe(EMPTY_TRANSCRIPT);
  });

  it("handles usage_update by updating state.usage", () => {
    const s = applySessionUpdate(EMPTY_TRANSCRIPT, {
      sessionUpdate: "usage_update",
      size: 200,
      used: 150,
    } as unknown as SessionUpdate);
    expect(s.usage).toEqual({ used: 150, size: 200 });
    expect(s.turns).toHaveLength(0);
  });

  it("preserves usage across subsequent message updates", () => {
    let s: TranscriptState = EMPTY_TRANSCRIPT;
    s = applySessionUpdate(s, {
      sessionUpdate: "usage_update",
      size: 100,
      used: 50,
    } as unknown as SessionUpdate);
    s = applySessionUpdate(s, agent("Hello"));
    expect(s.usage).toEqual({ used: 50, size: 100 });
    expect(s.turns).toHaveLength(1);
  });

  it("creates a tool turn from tool_call", () => {
    const s = applySessionUpdate(EMPTY_TRANSCRIPT, toolCall("tc_1", "read_file", "read"));
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0].role).toBe("tool");
    expect(s.turns[0].toolCall).toMatchObject({
      toolCallId: "tc_1",
      title: "read_file",
      status: "pending",
      kind: "read",
      risk: "read",
    });
  });

  it("updates an existing tool turn on tool_call_update", () => {
    let s: TranscriptState = EMPTY_TRANSCRIPT;
    s = applySessionUpdate(s, toolCall("tc_1", "shell"));
    s = applySessionUpdate(
      s,
      toolCallUpdate("tc_1", { status: "in_progress", rawInput: "ls -la" }),
    );
    expect(s.turns[0].toolCall!.status).toBe("in_progress");
    expect(s.turns[0].toolCall!.input).toBe("ls -la");
  });

  it("accumulates output from tool_call_update content", () => {
    let s: TranscriptState = EMPTY_TRANSCRIPT;
    s = applySessionUpdate(s, toolCall("tc_1", "shell"));
    s = applySessionUpdate(
      s,
      toolCallUpdate("tc_1", {
        content: [{ type: "content", content: { type: "text", text: "line1\n" } }],
      }),
    );
    s = applySessionUpdate(
      s,
      toolCallUpdate("tc_1", {
        content: [{ type: "content", content: { type: "text", text: "line2\n" } }],
      }),
    );
    expect(s.turns[0].toolCall!.output).toBe("line1\nline2\n");
  });

  it("tracks status through full lifecycle", () => {
    let s: TranscriptState = EMPTY_TRANSCRIPT;
    s = applySessionUpdate(s, toolCall("tc_1", "apply_patch"));
    expect(s.turns[0].toolCall!.status).toBe("pending");
    s = applySessionUpdate(s, toolCallUpdate("tc_1", { status: "in_progress" }));
    expect(s.turns[0].toolCall!.status).toBe("in_progress");
    s = applySessionUpdate(s, toolCallUpdate("tc_1", { status: "completed" }));
    expect(s.turns[0].toolCall!.status).toBe("completed");
  });

  it("handles failed status with error metadata", () => {
    let s: TranscriptState = EMPTY_TRANSCRIPT;
    s = applySessionUpdate(s, toolCall("tc_1", "shell"));
    s = applySessionUpdate(
      s,
      toolCallUpdate("tc_1", {
        status: "failed",
        _meta: { errorCode: "TIMEOUT", message: "Command timed out" },
      }),
    );
    expect(s.turns[0].toolCall!.status).toBe("failed");
    expect(s.turns[0].toolCall!.errorMessage).toBe("Command timed out");
  });

  it("ignores tool_call_update with no matching toolCallId (orphan)", () => {
    let s: TranscriptState = EMPTY_TRANSCRIPT;
    s = applySessionUpdate(s, toolCall("tc_1", "read_file"));
    const before = s;
    s = applySessionUpdate(s, toolCallUpdate("tc_unknown", { status: "completed" }));
    expect(s).toBe(before);
  });

  it("ignores tool_call with empty toolCallId", () => {
    const s = applySessionUpdate(EMPTY_TRANSCRIPT, {
      sessionUpdate: "tool_call",
      toolCallId: "",
      title: "bad",
    } as unknown as SessionUpdate);
    expect(s).toBe(EMPTY_TRANSCRIPT);
  });
});
