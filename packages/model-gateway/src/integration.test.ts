import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@custom-agent/schema";
import { SessionEngine, type EventStore } from "@custom-agent/core";
import { RecordedProvider, type ProviderFixture } from "./providers/recorded";

// integration.test.ts
//
// Drives a real SessionEngine turn against RecordedProvider so the
// cross-package shape is exercised end-to-end without core depending
// on model-gateway. The test belongs in model-gateway (consumer of
// core's port) — same direction as packages/qa-fixtures (consumer of
// core's event store + provider).

class InMemoryEventStore implements EventStore {
  readonly events: AgentEvent[] = [];
  async append(_sessionId: string, event: AgentEvent): Promise<void> {
    this.events.push(event);
  }
  async *replay(sessionId: string): AsyncIterable<AgentEvent> {
    for (const e of this.events) if (e.sessionId === sessionId) yield e;
  }
}

function makeEngine(fixture: ProviderFixture) {
  let id = 0;
  let now = 0;
  const store = new InMemoryEventStore();
  const engine = new SessionEngine({
    eventStore: store,
    provider: new RecordedProvider({ fixture }),
    now: () => new Date(`2026-05-20T00:00:${String(++now).padStart(2, "0")}.000Z`),
    createId: (prefix) => `${prefix}_${++id}`,
  });
  return { engine, store };
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

describe("SessionEngine + RecordedProvider (integration)", () => {
  it("runs a canonical recorded turn end-to-end (network-disabled CI)", async () => {
    const { engine } = makeEngine({
      tokenEstimate: 5,
      maxContextTokens: 1000,
      events: [
        { kind: "text_delta", delta: "Hello, " },
        { kind: "text_delta", delta: "world." },
        { kind: "completed", usage: { promptTokens: 3, completionTokens: 2 } },
      ],
    });
    const session = await engine.createSession({ cwd: "/tmp", client: "test" });
    const events = await collect(
      engine.runTurn({ sessionId: session.sessionId, userMessage: "hi" }),
    );
    expect(events.map((e) => e.type)).toEqual([
      "turn.started",
      "user.message",
      "model.delta",
      "model.delta",
      "turn.completed",
    ]);
    const completed = events.at(-1)?.payload as { stopReason: string };
    expect(completed.stopReason).toBe("final");
  });

  it("recorded preflight failure short-circuits to turn.completed errorCode=context_overflow", async () => {
    const { engine } = makeEngine({
      tokenEstimate: 5000,
      maxContextTokens: 10,
      events: [{ kind: "completed" }],
    });
    const session = await engine.createSession({ cwd: "/tmp", client: "test" });
    const events = await collect(
      engine.runTurn({ sessionId: session.sessionId, userMessage: "hi" }),
    );
    // No model.delta because the stream never opened.
    expect(events.map((e) => e.type)).toEqual(["turn.started", "user.message", "turn.completed"]);
    const payload = events.at(-1)?.payload as { stopReason: string; errorCode?: string };
    expect(payload.stopReason).toBe("error");
    expect(payload.errorCode).toBe("context_overflow");
  });

  it("recorded mid-stream rate-limit maps to errorCode=provider_failure via toTurnErrorCode", async () => {
    const { engine } = makeEngine({
      tokenEstimate: 5,
      maxContextTokens: 1000,
      events: [{ kind: "text_delta", delta: "partial" }],
      failBefore: 1,
      failWith: { kind: "rate_limit", message: "slow down", retryAfterMs: 1000 },
    });
    const session = await engine.createSession({ cwd: "/tmp", client: "test" });
    const events = await collect(
      engine.runTurn({ sessionId: session.sessionId, userMessage: "hi" }),
    );
    expect(events.map((e) => e.type)).toEqual([
      "turn.started",
      "user.message",
      "model.delta",
      "turn.completed",
    ]);
    const payload = events.at(-1)?.payload as { stopReason: string; errorCode?: string };
    expect(payload.stopReason).toBe("error");
    expect(payload.errorCode).toBe("provider_failure");
  });

  it("recorded tool_call_request without handler breaks loop cleanly", async () => {
    const { engine } = makeEngine({
      tokenEstimate: 10,
      maxContextTokens: 1000,
      capabilities: { toolCall: true },
      events: [
        { kind: "text_delta", delta: "Checking." },
        {
          kind: "tool_call_request",
          toolCallId: "call_1",
          toolName: "echo_tool",
          toolArgs: { text: "hello" },
        },
        { kind: "completed", usage: { promptTokens: 8, completionTokens: 5 } },
      ],
    });
    const session = await engine.createSession({ cwd: "/tmp", client: "test" });
    const events = await collect(
      engine.runTurn({ sessionId: session.sessionId, userMessage: "echo hello" }),
    );

    const types = events.map((e) => e.type);
    expect(types).toContain("turn.started");
    expect(types).toContain("user.message");
    expect(types).toContain("model.delta");
    expect(types).toContain("turn.completed");

    const completed = events.at(-1)?.payload as { stopReason: string };
    expect(completed.stopReason).toBe("final");
  });

  it("recorded mid-stream context_overflow throw maps to errorCode=context_overflow", async () => {
    const { engine } = makeEngine({
      tokenEstimate: 5,
      maxContextTokens: 1000,
      events: [{ kind: "text_delta", delta: "partial" }],
      failBefore: 1,
      failWith: { kind: "context_overflow", message: "exceeded mid-stream" },
    });
    const session = await engine.createSession({ cwd: "/tmp", client: "test" });
    const events = await collect(
      engine.runTurn({ sessionId: session.sessionId, userMessage: "hi" }),
    );
    const payload = events.at(-1)?.payload as { stopReason: string; errorCode?: string };
    expect(payload.stopReason).toBe("error");
    expect(payload.errorCode).toBe("context_overflow");
  });
});
