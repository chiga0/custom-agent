import type {
  ModelCapabilities,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  PreflightResult,
} from "@custom-agent/core";
import {
  ProviderContextOverflow,
  ProviderRateLimit,
  ProviderServerError,
  ProviderUnauthorized,
  ProviderUnknownError,
} from "../errors";

// RecordedProvider
//
// Replays a previously-recorded model interaction from a fixture so that
// CI does not need network or API keys. Two intents:
//
//   1. Network-disabled CI for the SessionEngine ↔ provider boundary.
//   2. A reference shape for M2-02b (real SDK adapter) — the same
//      fixture format works for "record real provider response" once the
//      M2-02b adapter learns how to write it.
//
// Fixture shape (`ProviderFixture`):
//
//   {
//     "tokenEstimate": 42,
//     "maxContextTokens": 8000,
//     "events": [
//       { "kind": "text_delta", "delta": "Hello, " },
//       { "kind": "text_delta", "delta": "world." },
//       { "kind": "completed", "usage": { "promptTokens": 5, "completionTokens": 2 } }
//     ]
//   }
//
// To drive error paths a fixture may set `failBefore` (number of
// text_delta events to emit before throwing) and `failWith` (a tagged
// ProviderError descriptor). The recorded fixture is the single source
// of truth for an entire interaction.

export type RecordedProviderEvent =
  | { readonly kind: "text_delta"; readonly delta: string }
  | {
      readonly kind: "completed";
      readonly usage?: { promptTokens: number; completionTokens: number };
    }
  | { readonly kind: "failed"; readonly reason: string };

export type RecordedProviderError =
  | { readonly kind: "rate_limit"; readonly message: string; readonly retryAfterMs?: number }
  | { readonly kind: "unauthorized"; readonly message: string }
  | { readonly kind: "context_overflow"; readonly message: string }
  | { readonly kind: "server_error"; readonly message: string }
  | { readonly kind: "unknown"; readonly message: string };

export type ProviderFixture = {
  /**
   * Token estimate the recorded provider reports from preflightCheck.
   * Tests drive the failure path by setting this > maxContextTokens.
   */
  readonly tokenEstimate: number;
  readonly maxContextTokens: number;
  /**
   * Optional advertised capabilities; defaults to the same shape
   * FakeStreamingProvider exposes so the fixture can stand in.
   */
  readonly capabilities?: Partial<ModelCapabilities>;
  /** Sequence of normalized stream events to yield. */
  readonly events: readonly RecordedProviderEvent[];
  /**
   * Optional failure injection. When set, the provider throws after
   * emitting `failBefore` text_delta events. The thrown error is a
   * concrete ProviderError subclass — same surface a real SDK adapter
   * is expected to raise.
   */
  readonly failBefore?: number;
  readonly failWith?: RecordedProviderError;
};

export type RecordedProviderOptions = {
  readonly id?: string;
  readonly fixture: ProviderFixture;
};

const DEFAULT_CAPS: ModelCapabilities = {
  streaming: true,
  toolCall: false,
  parallelToolCall: false,
  reasoning: false,
  maxContextTokens: 8_000,
};

export class RecordedProvider implements ModelProvider {
  readonly id: string;
  readonly capabilities: ModelCapabilities;
  private readonly fixture: ProviderFixture;

  constructor(opts: RecordedProviderOptions) {
    this.id = opts.id ?? "recorded";
    this.fixture = opts.fixture;
    this.capabilities = {
      ...DEFAULT_CAPS,
      ...(opts.fixture.capabilities ?? {}),
      maxContextTokens: opts.fixture.maxContextTokens,
    };
  }

  preflightCheck(_request: ModelRequest): PreflightResult {
    void _request;
    if (this.fixture.tokenEstimate > this.capabilities.maxContextTokens) {
      return {
        ok: false,
        reason: "context_overflow",
        estimatedTokens: this.fixture.tokenEstimate,
        maxContextTokens: this.capabilities.maxContextTokens,
      };
    }
    return { ok: true, estimatedTokens: this.fixture.tokenEstimate };
  }

  async *stream(_request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    void _request;
    let emittedDeltas = 0;
    for (const event of this.fixture.events) {
      if (signal.aborted) {
        yield { type: "failed", reason: "aborted" };
        return;
      }
      switch (event.kind) {
        case "text_delta": {
          yield { type: "text_delta", delta: event.delta };
          emittedDeltas += 1;
          if (
            this.fixture.failWith !== undefined &&
            this.fixture.failBefore !== undefined &&
            emittedDeltas >= this.fixture.failBefore
          ) {
            throw fromRecordedError(this.fixture.failWith);
          }
          break;
        }
        case "completed":
          yield { type: "completed", usage: event.usage };
          return;
        case "failed":
          yield { type: "failed", reason: event.reason };
          return;
      }
    }
  }
}

function fromRecordedError(err: RecordedProviderError): Error {
  switch (err.kind) {
    case "rate_limit":
      return new ProviderRateLimit(err.message, err.retryAfterMs);
    case "unauthorized":
      return new ProviderUnauthorized(err.message);
    case "context_overflow":
      return new ProviderContextOverflow(err.message);
    case "server_error":
      return new ProviderServerError(err.message);
    case "unknown":
      return new ProviderUnknownError(err.message);
  }
}
