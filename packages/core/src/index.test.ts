import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@custom-agent/schema";
import {
  FakeStreamingProvider,
  JsonlFileEventStore,
  SessionEngine,
  type EventStore,
} from "./index";

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
