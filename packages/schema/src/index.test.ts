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

  it("keeps the M1/M2/M3 public event list", () => {
    expect(eventTypes).toEqual([
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
    ]);
  });

  it("accepts a tool.started event (M3-02 additive)", () => {
    const event = {
      id: "evt_1",
      schemaVersion: 1,
      sessionId: "sess_1",
      turnId: "turn_1",
      sequence: 1,
      timestamp: "2026-05-20T00:00:00.000Z",
      type: "tool.started",
      payload: {
        toolCallId: "tc_1",
        toolName: "read_file",
      },
    } as AgentEvent;
    expect(isAgentEvent(event)).toBe(true);
  });

  it("accepts a tool.completed event (M3-02 additive)", () => {
    const event = {
      id: "evt_2",
      schemaVersion: 1,
      sessionId: "sess_1",
      turnId: "turn_1",
      sequence: 2,
      timestamp: "2026-05-20T00:00:00.000Z",
      type: "tool.completed",
      payload: {
        toolCallId: "tc_1",
        toolName: "read_file",
        deltaCount: 1,
        truncated: false,
      },
    } as AgentEvent;
    expect(isAgentEvent(event)).toBe(true);
  });

  it("accepts a tool.failed event (M3-02 additive)", () => {
    const event = {
      id: "evt_3",
      schemaVersion: 1,
      sessionId: "sess_1",
      turnId: "turn_1",
      sequence: 3,
      timestamp: "2026-05-20T00:00:00.000Z",
      type: "tool.failed",
      payload: {
        toolCallId: "tc_1",
        toolName: "read_file",
        errorCode: "path_unsafe",
        message: "blocked",
      },
    } as AgentEvent;
    expect(isAgentEvent(event)).toBe(true);
  });

  it("accepts a tool.permission_requested event (M3-01 additive)", () => {
    const event = {
      id: "evt_perm_1",
      schemaVersion: 1,
      sessionId: "sess_1",
      turnId: "turn_1",
      sequence: 7,
      timestamp: "2026-05-20T00:00:00.000Z",
      type: "tool.permission_requested",
      payload: {
        requestId: "perm_1",
        toolName: "shell",
        risk: "execute",
        decision: "ask",
        reason: "agent wants to run npm test",
      },
    } as AgentEvent;
    expect(isAgentEvent(event)).toBe(true);
  });

  it("accepts a tool.permission_resolved event (M3-01 additive)", () => {
    const event = {
      id: "evt_perm_2",
      schemaVersion: 1,
      sessionId: "sess_1",
      turnId: "turn_1",
      sequence: 8,
      timestamp: "2026-05-20T00:00:00.000Z",
      type: "tool.permission_resolved",
      payload: {
        requestId: "perm_1",
        toolName: "shell",
        outcome: "allowed",
        source: "user",
        reason: "looks safe",
      },
    } as AgentEvent;
    expect(isAgentEvent(event)).toBe(true);
  });

  it("accepts a turn.completed with optional errorCode (M2-01 additive)", () => {
    const event = {
      id: "evt_2",
      schemaVersion: 1,
      sessionId: "sess_1",
      turnId: "turn_1",
      sequence: 5,
      timestamp: "2026-05-20T00:00:00.000Z",
      type: "turn.completed",
      payload: { stopReason: "error", errorCode: "context_overflow" },
    } as AgentEvent;
    expect(isAgentEvent(event)).toBe(true);
  });

  it("accepts a turn.completed WITHOUT errorCode (back-compat for M1 happy path)", () => {
    const event = {
      id: "evt_3",
      schemaVersion: 1,
      sessionId: "sess_1",
      turnId: "turn_1",
      sequence: 5,
      timestamp: "2026-05-20T00:00:00.000Z",
      type: "turn.completed",
      payload: { stopReason: "final" },
    } as AgentEvent;
    expect(isAgentEvent(event)).toBe(true);
  });
});
