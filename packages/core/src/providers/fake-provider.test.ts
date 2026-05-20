import { describe, expect, it } from "vitest";
import { FakeStreamingProvider } from "./fake-provider";
import type { ModelRequest } from "../ports/model-provider";

// fake-provider.test.ts
//
// M2-01 contract test for the FakeStreamingProvider. The intent is to
// pin the ModelProvider port semantics (capabilities, preflightCheck,
// stream shape) so any future real-provider adapter has a reference
// behaviour to align with. Real providers in M2-02+ should produce the
// same observable shape — same event ordering, same preflight result
// surface — even if the tokenizer differs.

const request = (content: string): ModelRequest => ({
  modelId: "test",
  messages: [{ role: "user", content }],
});

describe("FakeStreamingProvider — port contract", () => {
  it("advertises a coherent capabilities object", () => {
    const p = new FakeStreamingProvider();
    expect(p.id).toBe("fake-streaming");
    expect(p.capabilities.streaming).toBe(true);
    expect(p.capabilities.toolCall).toBe(false);
    expect(p.capabilities.parallelToolCall).toBe(false);
    expect(p.capabilities.reasoning).toBe(false);
    expect(p.capabilities.maxContextTokens).toBeGreaterThan(0);
  });

  it("preflightCheck returns ok for an empty request", () => {
    const p = new FakeStreamingProvider();
    const result = p.preflightCheck(request(""));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.estimatedTokens).toBe(0);
  });

  it("preflightCheck returns ok for a small request well under the limit", () => {
    const p = new FakeStreamingProvider({ maxContextTokens: 100 });
    const result = p.preflightCheck(request("hello"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.estimatedTokens).toBeLessThan(100);
  });

  it("preflightCheck returns failure when estimated tokens exceed maxContextTokens", () => {
    // maxContextTokens=10 means budget ≈ 40 chars (4 chars/token heuristic).
    const p = new FakeStreamingProvider({ maxContextTokens: 10 });
    const result = p.preflightCheck(request("x".repeat(200)));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("context_overflow");
      expect(result.maxContextTokens).toBe(10);
      expect(result.estimatedTokens).toBeGreaterThan(result.maxContextTokens);
    }
  });

  it("preflightCheck sums all message contents (multi-turn budget)", () => {
    const p = new FakeStreamingProvider({ maxContextTokens: 10 });
    const result = p.preflightCheck({
      modelId: "test",
      messages: [
        { role: "user", content: "x".repeat(100) },
        { role: "assistant", content: "y".repeat(100) },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("stream yields the configured chunks in order, then completed", async () => {
    const p = new FakeStreamingProvider({ chunks: ["a", "b", "c"] });
    const ac = new AbortController();
    const events: unknown[] = [];
    for await (const e of p.stream(request("hi"), ac.signal)) events.push(e);
    expect(events).toEqual([
      { type: "text_delta", delta: "a" },
      { type: "text_delta", delta: "b" },
      { type: "text_delta", delta: "c" },
      { type: "completed", usage: { promptTokens: 0, completionTokens: 0 } },
    ]);
  });

  it("stream surfaces abort as a `failed` event with reason='aborted'", async () => {
    const p = new FakeStreamingProvider({ chunks: ["a", "b", "c"] });
    const ac = new AbortController();
    ac.abort();
    const events: unknown[] = [];
    for await (const e of p.stream(request("hi"), ac.signal)) events.push(e);
    expect(events).toEqual([{ type: "failed", reason: "aborted" }]);
  });

  it("stream throwAfterFirstChunk surfaces the synthetic failure", async () => {
    const p = new FakeStreamingProvider({
      chunks: ["a", "b", "c"],
      throwAfterFirstChunk: true,
    });
    const ac = new AbortController();
    const iter = p.stream(request("hi"), ac.signal);
    const events: unknown[] = [];
    let threw = false;
    try {
      for await (const e of iter) events.push(e);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(events).toEqual([{ type: "text_delta", delta: "a" }]);
  });
});
