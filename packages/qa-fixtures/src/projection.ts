import type { AgentEvent } from "@custom-agent/schema";

// projection.ts
//
// Normalizes AgentEvent streams into a deterministic, drift-detection-friendly
// shape so that "same logical turn" produces byte-identical output across
// runs.
//
// `normalizeEvents` projects each event to `{ type, payload }`. The envelope
// fields that vary run-to-run (id, sessionId, turnId, sequence, timestamp,
// schemaVersion) are dropped by virtue of the projection picking only
// `type` and `payload`. The payload itself is passed through verbatim
// (only key-sorted at serialization time) — we intentionally do NOT
// recurse into payload to strip fields by name, because a future event
// may legitimately use names like `id` in its payload (e.g. a tool-call
// id) and silently dropping them would mask a real contract change.
//
// Output is a list of { type, payload } where payload keys are sorted so
// JSON.stringify of two equivalent runs produces byte-identical strings.

export type NormalizedEvent = {
  readonly type: AgentEvent["type"];
  readonly payload: unknown;
};

/**
 * Project a stream of AgentEvent into a normalized, drift-detection shape.
 *
 * Ordering is preserved exactly: a re-ordering of the input is intentionally
 * visible in the output so the golden test catches event-order drift.
 */
export function normalizeEvents(events: readonly AgentEvent[]): NormalizedEvent[] {
  return events.map((event) => ({
    type: event.type,
    payload: event.payload,
  }));
}

/**
 * Returns a canonical JSON serialization of a normalized stream. Two streams
 * compare equal byte-for-byte iff they are logically equivalent under the
 * projection: same ordering, same types, same payload contents.
 *
 * The serialization uses sorted object keys at every depth so that, e.g.,
 * `{ stopReason: "final" }` and `{ stopReason: "final" }` from different
 * runtime sources stringify identically regardless of insertion order.
 */
export function serializeNormalized(events: readonly NormalizedEvent[]): string {
  return `${JSON.stringify(events, sortedKeysReplacer, 2)}\n`;
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
