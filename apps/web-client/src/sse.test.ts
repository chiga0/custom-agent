import { describe, expect, it } from "vitest";
import { SseFrameParser } from "./sse";

describe("SseFrameParser", () => {
  it("parses a single id+data frame", () => {
    const p = new SseFrameParser();
    p.push('id: 7\ndata: {"a":1}\n\n');
    expect(p.take()).toEqual([{ id: 7, data: '{"a":1}' }]);
  });

  it("parses multiple frames in one push", () => {
    const p = new SseFrameParser();
    p.push("id: 1\ndata: a\n\nid: 2\ndata: b\n\n");
    expect(p.take()).toEqual([
      { id: 1, data: "a" },
      { id: 2, data: "b" },
    ]);
  });

  it("buffers partial frames across pushes", () => {
    const p = new SseFrameParser();
    p.push("id: 1\nda");
    expect(p.take()).toEqual([]);
    p.push("ta: split\n\n");
    expect(p.take()).toEqual([{ id: 1, data: "split" }]);
  });

  it("ignores comment-only keepalives (lines starting with ': ')", () => {
    const p = new SseFrameParser();
    p.push(": ping\n\nid: 1\ndata: x\n\n");
    expect(p.take()).toEqual([{ id: 1, data: "x" }]);
  });

  it("parses event-only frames (no id, no data) — used for terminated / cursor_lost", () => {
    const p = new SseFrameParser();
    p.push("event: terminated\ndata: {}\n\n");
    expect(p.take()).toEqual([{ event: "terminated", data: "{}" }]);
  });

  it("emits frames in the order they arrived", () => {
    const p = new SseFrameParser();
    p.push("id: 5\ndata: a\n\nid: 6\ndata: b\n\nid: 7\ndata: c\n\n");
    expect(p.take().map((f) => f.id)).toEqual([5, 6, 7]);
  });

  it("drops malformed id lines silently (leaves id undefined)", () => {
    const p = new SseFrameParser();
    p.push("id: notanumber\ndata: x\n\n");
    expect(p.take()).toEqual([{ data: "x" }]);
  });

  it("take() drains and resets the pending list", () => {
    const p = new SseFrameParser();
    p.push("id: 1\ndata: a\n\n");
    expect(p.take()).toHaveLength(1);
    expect(p.take()).toEqual([]);
  });
});
