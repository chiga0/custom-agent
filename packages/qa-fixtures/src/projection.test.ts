import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@custom-agent/schema";
import { normalizeEvents, serializeNormalized } from "./projection";

function makeEvent<T extends AgentEvent["type"]>(
  overrides: Partial<AgentEvent> & { type: T; payload: AgentEvent["payload"] },
): AgentEvent {
  return {
    id: "evt_default",
    schemaVersion: 1,
    sessionId: "sess_default",
    turnId: "turn_default",
    sequence: 1,
    timestamp: "2026-05-18T00:00:00.000Z",
    ...overrides,
  } as AgentEvent;
}

describe("normalizeEvents", () => {
  it("strips id, sessionId, turnId, timestamp, sequence and schemaVersion is not required in output", () => {
    const event = makeEvent({
      id: "evt_1",
      sessionId: "sess_1",
      turnId: "turn_1",
      sequence: 42,
      timestamp: "2026-05-18T00:00:00.000Z",
      type: "turn.completed",
      payload: { stopReason: "final" },
    });

    const normalized = normalizeEvents([event]);

    expect(normalized).toEqual([{ type: "turn.completed", payload: { stopReason: "final" } }]);
    // schemaVersion is not on the normalized type at all.
    expect(normalized[0]).not.toHaveProperty("id");
    expect(normalized[0]).not.toHaveProperty("sessionId");
    expect(normalized[0]).not.toHaveProperty("turnId");
    expect(normalized[0]).not.toHaveProperty("sequence");
    expect(normalized[0]).not.toHaveProperty("timestamp");
    expect(normalized[0]).not.toHaveProperty("schemaVersion");
  });

  it("preserves payload fields verbatim (no field renaming, no extra fields)", () => {
    const event = makeEvent({
      type: "model.delta",
      payload: { text: "Hello, world." },
    });

    expect(normalizeEvents([event])).toEqual([
      { type: "model.delta", payload: { text: "Hello, world." } },
    ]);
  });

  it("preserves event ordering exactly (re-ordering is a real change that must be visible)", () => {
    const a = makeEvent({ type: "turn.started", payload: { promptPreview: "first" } });
    const b = makeEvent({ type: "user.message", payload: { content: "first" } });

    const forward = normalizeEvents([a, b]).map((e) => e.type);
    const reverse = normalizeEvents([b, a]).map((e) => e.type);

    expect(forward).toEqual(["turn.started", "user.message"]);
    expect(reverse).toEqual(["user.message", "turn.started"]);
    expect(forward).not.toEqual(reverse);
  });

  it("preserves nested payload fields verbatim, including names that look like envelope keys", () => {
    // The projection intentionally does NOT recurse into payload to strip
    // fields by name. A future event may legitimately use a payload field
    // called `id` (e.g. a tool-call id); silently dropping it would mask
    // a real contract change. The envelope's own id/sessionId/etc are
    // dropped via the `{type, payload}` projection shape, not by name.
    const event = {
      id: "evt_x",
      schemaVersion: 1,
      sessionId: "sess_x",
      sequence: 1,
      timestamp: "2026-05-18T00:00:00.000Z",
      type: "session.created",
      payload: {
        cwd: "/tmp",
        client: "test",
        meta: { id: "nested_id", createdAt: "x", keep: "yes" },
      },
    } as unknown as AgentEvent;

    const normalized = normalizeEvents([event]);

    expect(normalized).toEqual([
      {
        type: "session.created",
        payload: {
          cwd: "/tmp",
          client: "test",
          meta: { id: "nested_id", createdAt: "x", keep: "yes" },
        },
      },
    ]);
  });

  it("round-trips through serializeNormalized with stable, byte-identical output", () => {
    const a = makeEvent({ type: "turn.started", payload: { promptPreview: "say hi" } });
    const b = makeEvent({ type: "model.delta", payload: { text: "Hello, " } });

    // Build the same logical events but with payload keys in a different
    // insertion order (objects don't guarantee key order in JS, but
    // JSON.stringify defaults to insertion order — so we need the sort).
    const reordered = makeEvent({
      type: "turn.started",
      // Two-field payload reordered: only one field today, so emulate by
      // running an extra event with multi-key payload below.
      payload: { promptPreview: "say hi" },
    });
    const reorderedB = makeEvent({
      type: "model.delta",
      payload: { text: "Hello, " },
    });

    const lhs = serializeNormalized(normalizeEvents([a, b]));
    const rhs = serializeNormalized(normalizeEvents([reordered, reorderedB]));
    expect(lhs).toBe(rhs);
  });

  it("serializeNormalized sorts payload keys so insertion order does not affect output", () => {
    // Force a payload where insertion order differs between two equivalent
    // events. Cast through unknown to attach a second key without expanding
    // the union's payload type.
    const lhs = {
      id: "evt_1",
      schemaVersion: 1,
      sessionId: "sess_1",
      turnId: "turn_1",
      sequence: 1,
      timestamp: "2026-05-18T00:00:00.000Z",
      type: "session.created",
      payload: { cwd: "/tmp", client: "test" },
    } as unknown as AgentEvent;

    const rhs = {
      id: "evt_2",
      schemaVersion: 1,
      sessionId: "sess_2",
      turnId: "turn_2",
      sequence: 2,
      timestamp: "2026-05-18T00:00:01.000Z",
      type: "session.created",
      payload: { client: "test", cwd: "/tmp" },
    } as unknown as AgentEvent;

    expect(serializeNormalized(normalizeEvents([lhs]))).toBe(
      serializeNormalized(normalizeEvents([rhs])),
    );
  });
});
