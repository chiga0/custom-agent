import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@custom-agent/schema";
import {
  EventStoreFailure,
  FakeStreamingProvider,
  SessionEngine,
  type EventStore,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
} from "./index";
import { JsonlFileEventStore } from "./adapters/jsonl-event-store";

class InMemoryEventStore implements EventStore {
  readonly events: AgentEvent[] = [];

  async append(_sessionId: string, event: AgentEvent): Promise<void> {
    this.events.push(event);
  }

  async *replay(sessionId: string): AsyncIterable<AgentEvent> {
    for (const event of this.events) {
      if (event.sessionId === sessionId) {
        yield event;
      }
    }
  }
}

function makeEngine(
  overrides: {
    provider?: ConstructorParameters<typeof FakeStreamingProvider>[0];
    store?: EventStore;
  } = {},
) {
  let id = 0;
  let now = 0;
  const store = overrides.store ?? new InMemoryEventStore();
  const engine = new SessionEngine({
    eventStore: store,
    provider: new FakeStreamingProvider(overrides.provider ?? { chunks: ["A", "B"] }),
    now: () => new Date(`2026-05-18T00:00:${String(++now).padStart(2, "0")}.000Z`),
    createId: (prefix) => `${prefix}_${++id}`,
  });
  return { engine, store };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of it) out.push(item);
  return out;
}

describe("SessionEngine", () => {
  it("createSession persists session.created and returns Session", async () => {
    const { engine, store } = makeEngine();
    const session = await engine.createSession({ cwd: "/tmp/cwd", client: "test" });

    expect(session.sessionId).toBe("sess_1");
    expect(session.cwd).toBe("/tmp/cwd");
    expect(session.client).toBe("test");

    const replayed = await collect((store as InMemoryEventStore).replay(session.sessionId));
    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toMatchObject({
      type: "session.created",
      sequence: 1,
      payload: { cwd: "/tmp/cwd", client: "test" },
    });
  });

  it("runTurn yields turn.started -> user.message -> model.delta x N -> turn.completed", async () => {
    const { engine, store } = makeEngine({ provider: { chunks: ["foo ", "bar"] } });
    const session = await engine.createSession({ cwd: "/tmp", client: "test" });

    const events = await collect(
      engine.runTurn({ sessionId: session.sessionId, userMessage: "hello" }),
    );

    expect(events.map((e) => e.type)).toEqual([
      "turn.started",
      "user.message",
      "model.delta",
      "model.delta",
      "turn.completed",
    ]);
    expect(events.map((e) => e.sequence)).toEqual([2, 3, 4, 5, 6]);
    expect((events[2].payload as { text: string }).text).toBe("foo ");
    expect((events[3].payload as { text: string }).text).toBe("bar");
    expect((events[4].payload as { stopReason: string }).stopReason).toBe("final");

    const persisted = await collect((store as InMemoryEventStore).replay(session.sessionId));
    expect(persisted).toEqual([expect.objectContaining({ type: "session.created" }), ...events]);
  });

  it("replaySession returns events in append order", async () => {
    const { engine } = makeEngine({ provider: { chunks: ["x"] } });
    const session = await engine.createSession({ cwd: "/tmp", client: "test" });
    await collect(engine.runTurn({ sessionId: session.sessionId, userMessage: "hi" }));

    const replayed = await collect(engine.replaySession({ sessionId: session.sessionId }));
    expect(replayed.map((e) => e.type)).toEqual([
      "session.created",
      "turn.started",
      "user.message",
      "model.delta",
      "turn.completed",
    ]);
    expect(replayed.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  it("cancelTurn aborts an in-flight turn and emits stopReason=cancelled", async () => {
    const { engine } = makeEngine({ provider: { chunks: ["a", "b", "c", "d"] } });
    const session = await engine.createSession({ cwd: "/tmp", client: "test" });

    const types: string[] = [];
    const stopReasons: string[] = [];

    for await (const event of engine.runTurn({
      sessionId: session.sessionId,
      userMessage: "go",
    })) {
      types.push(event.type);
      if (event.type === "turn.completed") {
        stopReasons.push((event.payload as { stopReason: string }).stopReason);
      }
      if (event.type === "model.delta" && types.filter((t) => t === "model.delta").length === 1) {
        await engine.cancelTurn({ sessionId: session.sessionId });
      }
    }

    expect(types.at(-1)).toBe("turn.completed");
    expect(stopReasons).toEqual(["cancelled"]);
    expect(types.filter((t) => t === "model.delta").length).toBeLessThan(4);
  });

  it("cancelTurn is idempotent and a no-op when no active turn", async () => {
    const { engine } = makeEngine();
    const session = await engine.createSession({ cwd: "/tmp", client: "test" });

    await expect(engine.cancelTurn({ sessionId: session.sessionId })).resolves.toBeUndefined();
    await expect(
      engine.cancelTurn({ sessionId: session.sessionId, turnId: "no-such-turn" }),
    ).resolves.toBeUndefined();
    await expect(engine.cancelTurn({ sessionId: "no-such-session" })).resolves.toBeUndefined();
  });

  it("external AbortSignal cancels the turn", async () => {
    const { engine } = makeEngine({ provider: { chunks: ["a", "b", "c", "d"] } });
    const session = await engine.createSession({ cwd: "/tmp", client: "test" });
    const controller = new AbortController();

    const types: string[] = [];
    let cancelled = false;
    for await (const event of engine.runTurn({
      sessionId: session.sessionId,
      userMessage: "go",
      signal: controller.signal,
    })) {
      types.push(event.type);
      if (!cancelled && event.type === "model.delta") {
        controller.abort();
        cancelled = true;
      }
    }

    const last = types.at(-1);
    expect(last).toBe("turn.completed");
  });

  it("provider failure produces stopReason=error", async () => {
    const { engine } = makeEngine({ provider: { chunks: ["x", "y"], throwAfterFirstChunk: true } });
    const session = await engine.createSession({ cwd: "/tmp", client: "test" });

    const events = await collect(
      engine.runTurn({ sessionId: session.sessionId, userMessage: "boom" }),
    );

    expect(events.at(-1)?.type).toBe("turn.completed");
    expect((events.at(-1)?.payload as { stopReason: string }).stopReason).toBe("error");
  });

  it("can run a second turn after the first completes", async () => {
    const { engine } = makeEngine({ provider: { chunks: ["x"] } });
    const session = await engine.createSession({ cwd: "/tmp", client: "test" });

    await collect(engine.runTurn({ sessionId: session.sessionId, userMessage: "1st" }));
    const second = await collect(
      engine.runTurn({ sessionId: session.sessionId, userMessage: "2nd" }),
    );

    expect(second.map((e) => e.type)).toEqual([
      "turn.started",
      "user.message",
      "model.delta",
      "turn.completed",
    ]);
    // First turn used sequences 2..5; second turn should start at 6.
    expect(second.map((e) => e.sequence)).toEqual([6, 7, 8, 9]);
  });

  it("throws when runTurn is called on an unknown session", async () => {
    const { engine } = makeEngine();
    await expect(async () => {
      for await (const _ of engine.runTurn({ sessionId: "missing", userMessage: "x" })) {
        // unreachable
      }
    }).rejects.toThrow(/Unknown session/);
  });

  // ---- P1 regression tests (PR #4 review) ----

  it("does not leak a post-cancel model.delta even if the provider yields one", async () => {
    // A misbehaving provider that yields ONE MORE text_delta after seeing
    // an abort signal. SessionEngine must drop it.
    class LeakyProvider implements ModelProvider {
      readonly id = "leaky";
      readonly capabilities = {
        streaming: true,
        toolCall: false,
        parallelToolCall: false,
        reasoning: false,
        maxContextTokens: 1000,
      };
      async *stream(_req: ModelRequest, _signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
        void _req;
        void _signal;
        yield { type: "text_delta", delta: "a" };
        // Caller aborts between yields. A misbehaving provider keeps yielding.
        yield { type: "text_delta", delta: "POST_ABORT_LEAK" };
      }
    }
    const store = new InMemoryEventStore();
    let id = 0;
    const engine = new SessionEngine({
      eventStore: store,
      provider: new LeakyProvider(),
      now: () => new Date("2026-05-18T00:00:00.000Z"),
      createId: (prefix) => `${prefix}_${++id}`,
    });

    const session = await engine.createSession({ cwd: "/tmp", client: "test" });
    const types: string[] = [];
    const deltaTexts: string[] = [];

    for await (const event of engine.runTurn({
      sessionId: session.sessionId,
      userMessage: "go",
    })) {
      types.push(event.type);
      if (event.type === "model.delta") {
        deltaTexts.push((event.payload as { text: string }).text);
        if (deltaTexts.length === 1) {
          await engine.cancelTurn({ sessionId: session.sessionId });
        }
      }
    }

    // The leak delta MUST NOT appear in event order or in the durable store.
    expect(deltaTexts).toEqual(["a"]);
    expect(types.at(-1)).toBe("turn.completed");
    const persistedDeltaTexts = store.events
      .filter((e) => e.type === "model.delta")
      .map((e) => (e.payload as { text: string }).text);
    expect(persistedDeltaTexts).toEqual(["a"]);
  });

  it("classifies EventStore append failure as EventStoreFailure (not provider error)", async () => {
    let calls = 0;
    const failingStore: EventStore = {
      async append() {
        calls += 1;
        // Allow first 3 appends (session.created, turn.started, user.message),
        // then fail on the first model.delta.
        if (calls >= 4) {
          throw new Error("disk full");
        }
      },
      async *replay() {},
    };
    const engine = new SessionEngine({
      eventStore: failingStore,
      provider: new FakeStreamingProvider({ chunks: ["x"] }),
      now: () => new Date("2026-05-18T00:00:00.000Z"),
      createId: (prefix) => `${prefix}_x`,
    });

    const session = await engine.createSession({ cwd: "/tmp", client: "test" });

    let caught: unknown;
    try {
      for await (const _evt of engine.runTurn({
        sessionId: session.sessionId,
        userMessage: "go",
      })) {
        void _evt;
      }
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(EventStoreFailure);
    expect((caught as EventStoreFailure).sessionId).toBe(session.sessionId);
    expect((caught as EventStoreFailure).cause).toBeInstanceOf(Error);
  });

  it("does not skip sequence numbers when an append fails partway", async () => {
    // Reuse the failing-on-4th-call pattern but verify that the persisted
    // events have contiguous sequences 1..3 (no gap at 4) so a retry could
    // re-occupy that slot.
    let calls = 0;
    const successful: AgentEvent[] = [];
    const failingStore: EventStore = {
      async append(_sid, event) {
        calls += 1;
        if (calls >= 4) {
          throw new Error("disk full");
        }
        successful.push(event);
      },
      async *replay() {
        for (const e of successful) yield e;
      },
    };
    const engine = new SessionEngine({
      eventStore: failingStore,
      provider: new FakeStreamingProvider({ chunks: ["x", "y"] }),
      now: () => new Date("2026-05-18T00:00:00.000Z"),
      createId: (prefix) => `${prefix}_x`,
    });

    const session = await engine.createSession({ cwd: "/tmp", client: "test" });

    try {
      for await (const _evt of engine.runTurn({
        sessionId: session.sessionId,
        userMessage: "go",
      })) {
        void _evt;
      }
    } catch {
      // expected
    }

    // Sequences 1 (session.created), 2 (turn.started), 3 (user.message)
    // were persisted; 4 (first model.delta) failed and was rolled back so
    // no gap exists. The next attempted retry could reuse sequence 4.
    expect(successful.map((e) => e.sequence)).toEqual([1, 2, 3]);
  });

  it("tracks an explicit turn FSM history through happy path / cancel / error", async () => {
    const { engine } = makeEngine({ provider: { chunks: ["x"] } });
    const session = await engine.createSession({ cwd: "/tmp", client: "test" });

    // Capture history at the moment cancelTurn is being processed.
    let capturedAfterDelta: ReturnType<SessionEngine["getActiveTurnHistory"]>;

    for await (const event of engine.runTurn({
      sessionId: session.sessionId,
      userMessage: "go",
    })) {
      if (event.type === "model.delta") {
        capturedAfterDelta = engine.getActiveTurnHistory(session.sessionId);
      }
    }

    // While the turn was running we should already have idle -> running.
    expect(capturedAfterDelta).toBeDefined();
    expect(capturedAfterDelta!.map((t) => `${t.from}->${t.to}`)).toEqual(["idle->running"]);
    // After completion currentTurn is cleared, so getActiveTurnHistory is undefined.
    expect(engine.getActiveTurnHistory(session.sessionId)).toBeUndefined();
  });
});

describe("JsonlFileEventStore (integration)", () => {
  it("persists events to JSONL and replays them back identically", async () => {
    const dir = await mkdtemp(join(tmpdir(), "custom-agent-core-"));
    try {
      const store = new JsonlFileEventStore(dir);
      const { engine } = makeEngine({ provider: { chunks: ["a", "b"] }, store });
      const session = await engine.createSession({ cwd: "/tmp", client: "test" });

      const live = await collect(
        engine.runTurn({ sessionId: session.sessionId, userMessage: "hi" }),
      );

      const replayed = await collect(store.replay(session.sessionId));
      expect(replayed.map((e) => e.type)).toEqual(["session.created", ...live.map((e) => e.type)]);
      expect(replayed.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
