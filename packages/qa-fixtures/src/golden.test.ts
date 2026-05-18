import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normalizeEvents, serializeNormalized } from "./projection";
import { runCanonicalTurn } from "./golden";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "__fixtures__", "m1-fake-turn.golden.json");

// golden.test.ts
//
// Three layered assertions defend three independent contracts:
//
//   (A) Live yield = durable replay.
//       The events SessionEngine yields to the caller must equal the events
//       JsonlEventLog.replay() reads back. Any drift between "what the UI
//       sees" and "what disk holds" is a durability/replay invariant bug.
//
//   (B) Replayed events match the committed JSON fixture.
//       The fixture is the SINGLE SOURCE OF TRUTH for the on-the-wire
//       contract of one canonical fake-provider turn. Reordering events,
//       renaming payload fields, or changing the projection logic breaks
//       this assertion.
//
//   (C) The session-scoped replay (which includes session.created) also
//       matches its own committed fixture slice — guards the boundary
//       between "session create" and "first turn".

describe("golden: canonical fake-provider turn", () => {
  it("live turn events equal replayed turn events (durable-then-visible)", async () => {
    const { liveTurnEvents, replayedTurnEvents } = await runCanonicalTurn();

    const liveNormalized = serializeNormalized(normalizeEvents(liveTurnEvents));
    const replayNormalized = serializeNormalized(normalizeEvents(replayedTurnEvents));

    expect(replayNormalized).toBe(liveNormalized);
  });

  it("replayed (all) events match the committed golden fixture", async () => {
    const { replayedAllEvents } = await runCanonicalTurn();
    const actual = serializeNormalized(normalizeEvents(replayedAllEvents));
    const expected = await readFile(fixturePath, "utf8");

    expect(actual).toBe(expected);
  });

  it("live turn events plus the session.created prefix equal the committed fixture", async () => {
    // This is the strongest drift detector: if the engine reorders events,
    // changes the prompt-preview slicing, renames a payload field, or stops
    // emitting one of the five canonical event types, this comparison
    // catches it regardless of which layer regressed.
    const { liveTurnEvents, replayedAllEvents } = await runCanonicalTurn();

    // replayedAllEvents = [session.created, ...liveTurnEvents] semantically.
    expect(replayedAllEvents.length).toBe(liveTurnEvents.length + 1);
    expect(replayedAllEvents[0].type).toBe("session.created");
    expect(replayedAllEvents.slice(1).map((e) => e.type)).toEqual(
      liveTurnEvents.map((e) => e.type),
    );

    const actual = serializeNormalized(normalizeEvents(replayedAllEvents));
    const expected = await readFile(fixturePath, "utf8");
    expect(actual).toBe(expected);
  });
});
