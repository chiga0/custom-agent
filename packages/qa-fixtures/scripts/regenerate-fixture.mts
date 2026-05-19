import { runCanonicalTurn } from "../src/golden";
import { normalizeEvents, serializeNormalized } from "../src/projection";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// One-shot fixture regenerator. Run via:
//   FIXTURES_REGENERATE=1 npx tsx packages/qa-fixtures/scripts/regenerate-fixture.mts
// after intentionally changing the canonical-turn contract (e.g. payload
// shape, event ordering). Do NOT run this to "fix" a failing golden test
// without first auditing whether the change is intentional.
//
// The FIXTURES_REGENERATE env gate exists because this script unconditionally
// overwrites the committed golden fixture. A no-op safety check prevents
// accidental runs (e.g. piped from a misconfigured npm script).

if (process.env.FIXTURES_REGENERATE !== "1") {
  process.stderr.write(
    "regenerate-fixture: refusing to overwrite m1-fake-turn.golden.json without\n" +
      "FIXTURES_REGENERATE=1 set. Re-run with that env if the contract change is\n" +
      "intentional.\n",
  );
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "src", "__fixtures__", "m1-fake-turn.golden.json");

const { replayedAllEvents } = await runCanonicalTurn();
const serialized = serializeNormalized(normalizeEvents(replayedAllEvents));
await writeFile(fixturePath, serialized, "utf8");
process.stdout.write(`Wrote ${fixturePath}\n`);
