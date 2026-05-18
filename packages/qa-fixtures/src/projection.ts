import type { AgentEvent } from "@custom-agent/schema";

// projection.ts
//
// Normalizes AgentEvent streams into a deterministic, drift-detection-friendly
// shape so that "same logical turn" produces byte-identical output across
// runs. The projection strips:
//   - identity fields (id, sessionId, turnId, eventId)
//   - timing fields (timestamp, createdAt, startedAt, completedAt)
//   - per-store ordering metadata (sequence)
// and keeps:
//   - the discriminator (type) — drift in event ordering breaks the golden
//   - the surviving payload fields (e.g. promptPreview, text, stopReason),
//     which are the actual contract that downstream code depends on.
//
// Output is a list of { type, payload } where payload keys are sorted so
// JSON.stringify of two equivalent runs produces byte-identical strings.

export type NormalizedEvent = {
  readonly type: AgentEvent["type"];
  readonly payload: unknown;
};

const VOLATILE_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "sessionId",
  "turnId",
  "eventId",
  "timestamp",
  "createdAt",
  "startedAt",
  "completedAt",
  "sequence",
]);

/**
 * Project a stream of AgentEvent into a normalized, drift-detection shape.
 *
 * Ordering is preserved exactly: a re-ordering of the input is intentionally
 * visible in the output so the golden test catches event-order drift.
 */
export function normalizeEvents(events: readonly AgentEvent[]): NormalizedEvent[] {
  return events.map((event) => ({
    type: event.type,
    payload: stripVolatile(event.payload),
  }));
}

/**
 * Returns a canonical JSON serialization of a normalized stream. Two streams
 * compare equal byte-for-byte iff they are logically equivalent under the
 * projection: same ordering, same types, same surviving payload fields.
 *
 * The serialization uses sorted object keys at every depth so that, e.g.,
 * `{ stopReason: "final" }` and `{ stopReason: "final" }` from different
 * runtime sources stringify identically regardless of insertion order.
 */
export function serializeNormalized(events: readonly NormalizedEvent[]): string {
  return `${JSON.stringify(events, sortedKeysReplacer, 2)}\n`;
}

function stripVolatile(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(stripVolatile);
  }

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (VOLATILE_FIELDS.has(key)) {
      continue;
    }
    out[key] = stripVolatile((value as Record<string, unknown>)[key]);
  }
  return out;
}

// Recursive key-sort replacer for JSON.stringify. We cannot rely on insertion
// order alone because the source events come from disparate constructors
// (SessionEngine.commitEvent vs JsonlEventLog.decode), and JSON.parse is
// permitted to reorder keys in theory. Sorting at every depth is the only
// stable comparison strategy.
function sortedKeysReplacer(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[k] = (value as Record<string, unknown>)[k];
  }
  return sorted;
}
