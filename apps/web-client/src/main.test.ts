import { describe, expect, it } from "vitest";
import { renderEventSummary } from "./main";

describe("web event rendering", () => {
  it("renders the canonical event sequence", () => {
    expect(
      renderEventSummary([
        {
          id: "evt_1",
          schemaVersion: 1,
          sessionId: "sess_1",
          sequence: 1,
          timestamp: "2026-05-17T00:00:00.000Z",
          type: "turn.completed",
          payload: {
            stopReason: "final",
          },
        },
      ]),
    ).toBe("1. turn.completed");
  });
});
