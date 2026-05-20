import type {
  ModelCapabilities,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  PreflightResult,
} from "../ports/model-provider";

// Fake streaming provider used in M1-03 to end-to-end exercise the turn state
// machine without a real model. Tests inject a deterministic `chunks` list so
// they can assert exact `model.delta` event counts.

const DEFAULT_CHUNKS: readonly string[] = ["Custom Agent ", "project ", "spine ", "is ", "ready."];

// Tests opt into a tight context window by overriding capabilities. Approximate
// 1 token per 4 characters — the canonical rule-of-thumb shared by most
// English-trained tokenizers; sufficient for a test-only heuristic.
const CHARS_PER_TOKEN = 4;

export type FakeStreamingProviderOptions = {
  readonly chunks?: readonly string[];
  // If true, throw a synthetic error after emitting the first chunk so tests
  // can cover the provider-failure branch deterministically.
  readonly throwAfterFirstChunk?: boolean;
  // Override the default 8 000-token context window so tests can drive the
  // preflight failure path with a small message.
  readonly maxContextTokens?: number;
};

export class FakeStreamingProvider implements ModelProvider {
  readonly id = "fake-streaming";
  readonly capabilities: ModelCapabilities;

  private readonly chunks: readonly string[];
  private readonly throwAfterFirstChunk: boolean;

  constructor(options: FakeStreamingProviderOptions = {}) {
    this.chunks = options.chunks ?? DEFAULT_CHUNKS;
    this.throwAfterFirstChunk = options.throwAfterFirstChunk ?? false;
    this.capabilities = {
      streaming: true,
      toolCall: false,
      parallelToolCall: false,
      reasoning: false,
      maxContextTokens: options.maxContextTokens ?? 8_000,
    };
  }

  preflightCheck(request: ModelRequest): PreflightResult {
    const totalChars = request.messages.reduce((acc, m) => acc + m.content.length, 0);
    const estimatedTokens = Math.ceil(totalChars / CHARS_PER_TOKEN);
    if (estimatedTokens > this.capabilities.maxContextTokens) {
      return {
        ok: false,
        reason: "context_overflow",
        estimatedTokens,
        maxContextTokens: this.capabilities.maxContextTokens,
      };
    }
    return { ok: true, estimatedTokens };
  }

  async *stream(_request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    let emitted = 0;
    for (const delta of this.chunks) {
      if (signal.aborted) {
        yield { type: "failed", reason: "aborted" };
        return;
      }

      yield { type: "text_delta", delta };
      emitted += 1;

      if (this.throwAfterFirstChunk && emitted === 1) {
        throw new Error("fake-provider synthetic failure");
      }
    }
    yield { type: "completed", usage: { promptTokens: 0, completionTokens: 0 } };
  }
}
