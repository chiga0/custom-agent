import { describe, expect, it } from "vitest";
import { SessionEngine } from "./session-engine";
import { FakeToolCallProvider } from "./providers/fake-tool-provider";
import type { ToolCallHandlerFactory } from "./ports/tool-call-handler";
import type { AgentEvent, TurnCompletedEvent, ModelDeltaEvent } from "@custom-agent/schema";

// Simple in-memory event store
class MemoryEventStore {
  private events = new Map<string, AgentEvent[]>();

  async append(sessionId: string, event: AgentEvent): Promise<void> {
    const arr = this.events.get(sessionId) ?? [];
    arr.push(event);
    this.events.set(sessionId, arr);
  }

  async *replay(sessionId: string): AsyncIterable<AgentEvent> {
    for (const event of this.events.get(sessionId) ?? []) {
      yield event;
    }
  }
}

// Simple tool handler factory for tests
function makeEchoToolHandlerFactory(): ToolCallHandlerFactory {
  return (_commitEvent, _cwd, _signal) => {
    return {
      listTools: () => [{ name: "echo", description: "echo a message", risk: "read" }],
      async handle(_toolCallId: string, _toolName: string, toolArgs: unknown): Promise<string> {
        const args = toolArgs as { message?: string };
        return args.message ?? "(no message)";
      },
    };
  };
}

describe("SessionEngine tool call loop", () => {
  it("dispatches tool call and feeds result back to model", async () => {
    const store = new MemoryEventStore();
    const provider = new FakeToolCallProvider({
      sequence: {
        toolName: "echo",
        toolArgs: { message: "hello world" },
        finalResponse: "Got result",
      },
    });

    const engine = new SessionEngine({
      eventStore: store,
      provider,
      makeToolHandler: makeEchoToolHandlerFactory(),
      now: () => new Date("2024-01-01T00:00:00Z"),
      createId: (() => {
        let n = 0;
        return (prefix: string) => `${prefix}_${++n}`;
      })(),
    });

    const session = await engine.createSession({ cwd: "/tmp", client: "test" });

    const events: AgentEvent[] = [];
    for await (const event of engine.runTurn({
      sessionId: session.sessionId,
      userMessage: "use echo tool",
    })) {
      events.push(event);
    }

    // Should have turn.started, user.message, model.delta x N, turn.completed
    const turnCompleted = events.find((e) => e.type === "turn.completed") as
      | TurnCompletedEvent
      | undefined;
    expect(turnCompleted).toBeDefined();
    expect(turnCompleted?.payload.stopReason).toBe("final");

    const modelDeltas = events.filter((e) => e.type === "model.delta") as ModelDeltaEvent[];
    expect(modelDeltas.length).toBeGreaterThan(0);
    const text = modelDeltas.map((e) => e.payload.text).join("");
    expect(text.trim()).toContain("Got result");
  });

  it("completes without tools when makeToolHandler is not provided", async () => {
    const store = new MemoryEventStore();
    // Regular provider without tool calls
    const { FakeStreamingProvider } = await import("./providers/fake-provider");
    const provider = new FakeStreamingProvider({ chunks: ["Hello"] });

    const engine = new SessionEngine({
      eventStore: store,
      provider,
      now: () => new Date("2024-01-01T00:00:00Z"),
      createId: (() => {
        let n = 0;
        return (prefix: string) => `${prefix}_${++n}`;
      })(),
    });

    const session = await engine.createSession({ cwd: "/tmp", client: "test" });
    const events: AgentEvent[] = [];
    for await (const event of engine.runTurn({
      sessionId: session.sessionId,
      userMessage: "hello",
    })) {
      events.push(event);
    }

    const completed = events.find((e) => e.type === "turn.completed") as
      | TurnCompletedEvent
      | undefined;
    expect(completed?.payload.stopReason).toBe("final");
  });
});
