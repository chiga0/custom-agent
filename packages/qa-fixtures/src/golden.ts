import type { AgentEvent } from "@custom-agent/schema";
import { FakeStreamingProvider, SessionEngine, type EventStore } from "@custom-agent/core";
import { JsonlEventLog } from "@custom-agent/storage";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

// golden.ts
//
// Deterministic, in-package harness that drives ONE canonical FakeStreaming
// turn end-to-end. Two callers:
//
//   1. The "live" path: drive SessionEngine.runTurn, collect the event stream
//      yielded to the consumer; we use this to assert the consumer-visible
//      contract.
//   2. The "replayed" path: read the same events back through
//      JsonlEventLog.replay; we use this to assert durable-then-visible
//      equivalence.
//
// Both paths share the SAME prompt, provider chunks, clock, and id generator,
// so any byte-level drift between (1) and (2) is a real contract bug.

export const CANONICAL_USER_MESSAGE = "say hi";
export const CANONICAL_CHUNKS: readonly string[] = ["Hello, ", "world."];
export const CANONICAL_CLIENT = "test" as const;
export const CANONICAL_CWD = "/golden/cwd";

// Deterministic clock: 2026-05-18T00:00:NN.000Z — NN increments per event.
// Deterministic id generator: "<prefix>_<N>".
function makeDeterministicDeps() {
  let nowCounter = 0;
  let idCounter = 0;
  return {
    now: () => new Date(`2026-05-18T00:00:${String(++nowCounter).padStart(2, "0")}.000Z`),
    createId: (prefix: string) => `${prefix}_${++idCounter}`,
  };
}

// EventStore that fans out every append into both:
//   - an in-memory mirror (so the test can see what the engine yielded
//     without re-reading the JSONL file mid-turn);
//   - a JsonlEventLog so we exercise the same write path the real
//     JsonlFileEventStore uses.
//
// Kept inside qa-fixtures (not duplicated from core) on purpose: QA harnesses
// frequently need bifurcated stores, and embedding it here avoids reaching
// into core/ private adapters.
class TeeEventStore implements EventStore {
  readonly mirror: AgentEvent[] = [];

  constructor(private readonly log: JsonlEventLog) {}

  async append(_sessionId: string, event: AgentEvent): Promise<void> {
    await this.log.append(event);
    this.mirror.push(event);
  }

  async *replay(_sessionId: string): AsyncIterable<AgentEvent> {
    for (const event of this.mirror) {
      yield event;
    }
  }
}

export type CanonicalRunResult = {
  /**
   * Events as yielded by SessionEngine.runTurn (turn-scoped: turn.started ..
   * turn.completed). Excludes session.created which is emitted by
   * createSession before the turn.
   */
  readonly liveTurnEvents: readonly AgentEvent[];
  /**
   * All events for the session as recorded in the durable JSONL log, in
   * append order. Includes session.created.
   */
  readonly replayedAllEvents: readonly AgentEvent[];
  /**
   * Just the turn-scoped slice of replayedAllEvents — events whose
   * `turnId` equals the live turn's `turnId`. Aligned with `liveTurnEvents`
   * for equivalence assertions.
   */
  readonly replayedTurnEvents: readonly AgentEvent[];
};

/**
 * Run the canonical fake-provider turn end-to-end against a fresh JSONL log.
 * Caller is responsible for projecting the streams (`normalizeEvents`) and
 * for any cleanup. The returned object exposes both the live and the
 * replayed view so the equivalence assertion can be made by the caller.
 *
 * The function creates a tmpdir for the JSONL log and removes it before
 * returning, so callers do not need to manage disk state.
 */
export async function runCanonicalTurn(): Promise<CanonicalRunResult> {
  const dir = await mkdtemp(join(tmpdir(), "qa-fixtures-"));
  try {
    const deps = makeDeterministicDeps();
    const log = new JsonlEventLog(join(dir, "session.jsonl"));
    const store = new TeeEventStore(log);

    const engine = new SessionEngine({
      eventStore: store,
      provider: new FakeStreamingProvider({ chunks: CANONICAL_CHUNKS }),
      now: deps.now,
      createId: deps.createId,
    });

    const session = await engine.createSession({
      cwd: CANONICAL_CWD,
      client: CANONICAL_CLIENT,
    });

    const liveTurnEvents: AgentEvent[] = [];
    for await (const event of engine.runTurn({
      sessionId: session.sessionId,
      userMessage: CANONICAL_USER_MESSAGE,
    })) {
      liveTurnEvents.push(event);
    }

    // Replay back through JsonlEventLog directly so the test exercises the
    // decode path, not the in-memory mirror.
    const replayedAllEvents: AgentEvent[] = [];
    for await (const event of log.replay()) {
      replayedAllEvents.push(event);
    }

    const turnId = liveTurnEvents[0]?.turnId;
    const replayedTurnEvents = replayedAllEvents.filter((e) => e.turnId === turnId);

    return { liveTurnEvents, replayedAllEvents, replayedTurnEvents };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
