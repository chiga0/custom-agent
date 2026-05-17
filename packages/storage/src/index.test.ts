import { describe, expect, it } from "vitest";
import { decodeEvent, encodeEvent } from "./index";

describe("event log encoding", () => {
  it("round-trips a valid event", () => {
    const line = encodeEvent({
      id: "evt_1",
      schemaVersion: 1,
      sessionId: "sess_1",
      sequence: 1,
      timestamp: "2026-05-17T00:00:00.000Z",
      type: "model.delta",
      payload: {
        text: "hello",
      },
    });

    expect(decodeEvent(line).type).toBe("model.delta");
  });
});
