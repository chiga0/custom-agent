import { describe, expect, it } from "vitest";
import { DEFAULT_RING_SIZE, SessionCursor } from "./cursor";

describe("SessionCursor", () => {
  it("assigns monotonic ids starting at 1", () => {
    const cursor = new SessionCursor();
    expect(cursor.latest).toBe(0);
    expect(cursor.push("a")).toBe(1);
    expect(cursor.push("b")).toBe(2);
    expect(cursor.push("c")).toBe(3);
    expect(cursor.latest).toBe(3);
  });

  it("replays all events when fromCursor is 0", () => {
    const cursor = new SessionCursor();
    cursor.push("a");
    cursor.push("b");
    cursor.push("c");
    expect(cursor.replay(0).map((e) => e.data)).toEqual(["a", "b", "c"]);
  });

  it("replays only events with id > fromCursor", () => {
    const cursor = new SessionCursor();
    cursor.push("a");
    cursor.push("b");
    cursor.push("c");
    expect(cursor.replay(1).map((e) => e.data)).toEqual(["b", "c"]);
    expect(cursor.replay(2).map((e) => e.data)).toEqual(["c"]);
    expect(cursor.replay(3)).toEqual([]);
  });

  it("returns empty when fromCursor >= latest", () => {
    const cursor = new SessionCursor();
    cursor.push("a");
    expect(cursor.replay(1)).toEqual([]);
    expect(cursor.replay(5)).toEqual([]);
  });

  it("ring buffer drops oldest events past capacity", () => {
    const cursor = new SessionCursor(3);
    for (let i = 0; i < 5; i += 1) cursor.push(String(i));
    // seq is 1..5, ring holds last 3 (ids 3,4,5)
    expect(cursor.latest).toBe(5);
    expect(cursor.oldest).toBe(3);
    expect(cursor.replay(0).map((e) => e.id)).toEqual([3, 4, 5]);
  });

  it("canResumeFrom returns true for fresh connect (cursor 0)", () => {
    const cursor = new SessionCursor(3);
    cursor.push("a");
    expect(cursor.canResumeFrom(0)).toBe(true);
  });

  it("canResumeFrom returns false when client is too far behind", () => {
    const cursor = new SessionCursor(3);
    for (let i = 0; i < 10; i += 1) cursor.push(String(i));
    // ring holds ids 8,9,10; client at 1 is irrecoverable
    expect(cursor.canResumeFrom(1)).toBe(false);
    expect(cursor.canResumeFrom(7)).toBe(true); // boundary: next is 8
    expect(cursor.canResumeFrom(8)).toBe(true);
  });

  it("emits 'event' for each push and 'close' on close", () => {
    const cursor = new SessionCursor();
    const events: number[] = [];
    let closed = false;
    cursor.on("event", (e) => events.push(e.id));
    cursor.on("close", () => {
      closed = true;
    });
    cursor.push("a");
    cursor.push("b");
    cursor.close();
    expect(events).toEqual([1, 2]);
    expect(closed).toBe(true);
  });

  it("push after close throws", () => {
    const cursor = new SessionCursor();
    cursor.close();
    expect(() => cursor.push("x")).toThrow(/closed/);
  });

  it("DEFAULT_RING_SIZE is 256 (matches SPEC.md §8)", () => {
    expect(DEFAULT_RING_SIZE).toBe(256);
  });
});
