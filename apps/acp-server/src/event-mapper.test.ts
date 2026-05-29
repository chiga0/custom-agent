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

  it("returns null for turn.completed without usage", () => {
    const e = event("turn.completed", { stopReason: "final" }, "turn_a");
    expect(mapEventToUpdate(e)).toBeNull();
  });

  it("returns usage_update for turn.completed with usage", () => {
    const e = event(
      "turn.completed",
      { stopReason: "final", usage: { promptTokens: 100, completionTokens: 50 } },
      "turn_a",
    );
    const update = mapEventToUpdate(e);
    expect(update).toEqual({
      sessionUpdate: "usage_update",
      size: 150,
      used: 150,
    });
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

  it("maps tool.permission_requested → tool_call with pending status", () => {
    const e = event(
      "tool.permission_requested",
      { requestId: "req_1", toolName: "read_file", risk: "read", decision: "allow", reason: "" },
      "turn_a",
    );
    const update = mapEventToUpdate(e) as Record<string, unknown>;
    expect(update).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "req_1",
      title: "read_file",
      status: "pending",
      kind: "read",
    });
    expect((update._meta as Record<string, unknown>).risk).toBe("read");
  });

  it("maps tool.permission_requested — uses toolCallId over requestId if present", () => {
    const e = event(
      "tool.permission_requested",
      {
        requestId: "req_1",
        toolCallId: "tc_1",
        toolName: "shell",
        risk: "execute",
        decision: "ask",
        reason: "",
      },
      "turn_a",
    );
    const update = mapEventToUpdate(e) as Record<string, unknown>;
    expect(update.toolCallId).toBe("tc_1");
    expect(update.kind).toBe("execute");
  });

  it("maps tool.permission_resolved → tool_call_update with outcome meta", () => {
    const e = event(
      "tool.permission_resolved",
      {
        requestId: "req_1",
        toolCallId: "tc_1",
        toolName: "shell",
        outcome: "allowed",
        source: "user",
      },
      "turn_a",
    );
    const update = mapEventToUpdate(e) as Record<string, unknown>;
    expect(update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc_1",
    });
    expect((update._meta as Record<string, unknown>).outcome).toBe("allowed");
    expect((update._meta as Record<string, unknown>).source).toBe("user");
  });

  it("maps tool.started → tool_call_update with in_progress status", () => {
    const e = event(
      "tool.started",
      { toolCallId: "tc_1", toolName: "shell", argsPreview: "ls" },
      "turn_a",
    );
    const update = mapEventToUpdate(e) as Record<string, unknown>;
    expect(update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc_1",
      status: "in_progress",
      rawInput: "ls",
    });
  });

  it("maps tool.delta → tool_call_update with content", () => {
    const e = event(
      "tool.delta",
      { toolCallId: "tc_1", kind: "stdout", text: "hello output" },
      "turn_a",
    );
    const update = mapEventToUpdate(e) as Record<string, unknown>;
    expect(update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc_1",
    });
    expect(update.content).toEqual([
      { type: "content", content: { type: "text", text: "hello output" } },
    ]);
  });

  it("maps tool.completed → tool_call_update with completed status", () => {
    const e = event(
      "tool.completed",
      { toolCallId: "tc_1", toolName: "shell", deltaCount: 3, truncated: false },
      "turn_a",
    );
    const update = mapEventToUpdate(e) as Record<string, unknown>;
    expect(update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc_1",
      status: "completed",
    });
  });

  it("maps tool.failed → tool_call_update with failed status and error meta", () => {
    const e = event(
      "tool.failed",
      { toolCallId: "tc_1", toolName: "shell", errorCode: "io_error", message: "timed out" },
      "turn_a",
    );
    const update = mapEventToUpdate(e) as Record<string, unknown>;
    expect(update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc_1",
      status: "failed",
    });
    expect((update._meta as Record<string, unknown>).errorCode).toBe("io_error");
    expect((update._meta as Record<string, unknown>).message).toBe("timed out");
  });

  it("mapRiskToToolKind: write → edit, network → fetch", () => {
    const eWrite = event(
      "tool.permission_requested",
      { requestId: "r1", toolName: "apply_patch", risk: "write", decision: "allow", reason: "" },
      "turn_a",
    );
    expect((mapEventToUpdate(eWrite) as Record<string, unknown>).kind).toBe("edit");

    const eNet = event(
      "tool.permission_requested",
      { requestId: "r2", toolName: "fetch", risk: "network", decision: "allow", reason: "" },
      "turn_a",
    );
    expect((mapEventToUpdate(eNet) as Record<string, unknown>).kind).toBe("fetch");
  });
});
