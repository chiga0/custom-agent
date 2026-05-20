import { describe, expect, it } from "vitest";
import type { ModelRequest, ModelStreamEvent } from "@custom-agent/core";
import { RecordedProvider, type ProviderFixture } from "./recorded";
import {
  ProviderContextOverflow,
  ProviderRateLimit,
  ProviderServerError,
  ProviderUnauthorized,
  ProviderUnknownError,
} from "../errors";

const request = (content: string): ModelRequest => ({
  modelId: "test",
  messages: [{ role: "user", content }],
});

async function collectStream(iter: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const out: ModelStreamEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

describe("RecordedProvider — happy fixtures", () => {
  it("yields the recorded events in order then terminates", async () => {
    const fixture: ProviderFixture = {
      tokenEstimate: 12,
      maxContextTokens: 1000,
      events: [
        { kind: "text_delta", delta: "Hello, " },
        { kind: "text_delta", delta: "world." },
        { kind: "completed", usage: { promptTokens: 3, completionTokens: 2 } },
      ],
    };
    const provider = new RecordedProvider({ fixture });
    const events = await collectStream(
      provider.stream(request("hi"), new AbortController().signal),
    );
    expect(events).toEqual([
      { type: "text_delta", delta: "Hello, " },
      { type: "text_delta", delta: "world." },
      { type: "completed", usage: { promptTokens: 3, completionTokens: 2 } },
    ]);
  });

  it("preflightCheck uses the recorded tokenEstimate", () => {
    const fixture: ProviderFixture = {
      tokenEstimate: 42,
      maxContextTokens: 1000,
      events: [{ kind: "completed" }],
    };
    const provider = new RecordedProvider({ fixture });
    const result = provider.preflightCheck(request("hi"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.estimatedTokens).toBe(42);
  });

  it("preflightCheck fails when recorded tokenEstimate exceeds maxContextTokens", () => {
    const fixture: ProviderFixture = {
      tokenEstimate: 1500,
      maxContextTokens: 1000,
      events: [{ kind: "completed" }],
    };
    const provider = new RecordedProvider({ fixture });
    const result = provider.preflightCheck(request("hi"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("context_overflow");
      expect(result.estimatedTokens).toBe(1500);
      expect(result.maxContextTokens).toBe(1000);
    }
  });

  it("stream terminates with `failed` event when fixture records one", async () => {
    const fixture: ProviderFixture = {
      tokenEstimate: 1,
      maxContextTokens: 1000,
      events: [
        { kind: "text_delta", delta: "x" },
        { kind: "failed", reason: "model_decided_to_stop" },
      ],
    };
    const provider = new RecordedProvider({ fixture });
    const events = await collectStream(
      provider.stream(request("hi"), new AbortController().signal),
    );
    expect(events).toEqual([
      { type: "text_delta", delta: "x" },
      { type: "failed", reason: "model_decided_to_stop" },
    ]);
  });

  it("aborts mid-stream when the signal fires", async () => {
    const fixture: ProviderFixture = {
      tokenEstimate: 1,
      maxContextTokens: 1000,
      events: [
        { kind: "text_delta", delta: "a" },
        { kind: "text_delta", delta: "b" },
        { kind: "text_delta", delta: "c" },
      ],
    };
    const provider = new RecordedProvider({ fixture });
    const ac = new AbortController();
    ac.abort();
    const events = await collectStream(provider.stream(request("hi"), ac.signal));
    expect(events).toEqual([{ type: "failed", reason: "aborted" }]);
  });
});

describe("RecordedProvider — error injection (M2-02b reference shape)", () => {
  it("throws ProviderRateLimit after the configured failBefore", async () => {
    const fixture: ProviderFixture = {
      tokenEstimate: 1,
      maxContextTokens: 1000,
      events: [
        { kind: "text_delta", delta: "a" },
        { kind: "text_delta", delta: "b" },
      ],
      failBefore: 1,
      failWith: { kind: "rate_limit", message: "rate limited", retryAfterMs: 1500 },
    };
    const provider = new RecordedProvider({ fixture });
    const ac = new AbortController();
    const events: ModelStreamEvent[] = [];
    let threw: unknown;
    try {
      for await (const e of provider.stream(request("hi"), ac.signal)) events.push(e);
    } catch (err) {
      threw = err;
    }
    expect(events).toEqual([{ type: "text_delta", delta: "a" }]);
    expect(threw).toBeInstanceOf(ProviderRateLimit);
    if (threw instanceof ProviderRateLimit) {
      expect(threw.retryAfterMs).toBe(1500);
    }
  });

  it("throws ProviderUnauthorized when fixture marks unauthorized", async () => {
    const fixture: ProviderFixture = {
      tokenEstimate: 1,
      maxContextTokens: 1000,
      events: [{ kind: "text_delta", delta: "a" }],
      failBefore: 1,
      failWith: { kind: "unauthorized", message: "bad key" },
    };
    const provider = new RecordedProvider({ fixture });
    await expect(async () => {
      for await (const _ of provider.stream(request("hi"), new AbortController().signal)) {
        // drain
        void _;
      }
    }).rejects.toBeInstanceOf(ProviderUnauthorized);
  });

  it("throws ProviderContextOverflow / ProviderServerError / ProviderUnknownError on matching fixtures", async () => {
    const cases: Array<{
      kind: "context_overflow" | "server_error" | "unknown";
      ctor: unknown;
    }> = [
      { kind: "context_overflow", ctor: ProviderContextOverflow },
      { kind: "server_error", ctor: ProviderServerError },
      { kind: "unknown", ctor: ProviderUnknownError },
    ];
    for (const { kind, ctor } of cases) {
      const fixture: ProviderFixture = {
        tokenEstimate: 1,
        maxContextTokens: 1000,
        events: [{ kind: "text_delta", delta: "a" }],
        failBefore: 1,
        failWith: { kind, message: kind } as ProviderFixture["failWith"],
      };
      const provider = new RecordedProvider({ fixture });
      let threw: unknown;
      try {
        for await (const _ of provider.stream(request("hi"), new AbortController().signal)) {
          void _;
        }
      } catch (err) {
        threw = err;
      }
      expect(threw).toBeInstanceOf(ctor as new () => Error);
    }
  });
});
