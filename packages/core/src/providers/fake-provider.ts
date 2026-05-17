import type {
  ModelCapabilities,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
} from "../ports/model-provider";

// Fake streaming provider used in M1-03 to end-to-end exercise the turn state
// machine without a real model. Tests inject a deterministic `chunks` list so
// they can assert exact `model.delta` event counts.

const DEFAULT_CHUNKS: readonly string[] = ["Custom Agent ", "project ", "spine ", "is ", "ready."];

export type FakeStreamingProviderOptions = {
  readonly chunks?: readonly string[];
  // If true, throw a synthetic error after emitting the first chunk so tests
  // can cover the provider-failure branch deterministically.
  readonly throwAfterFirstChunk?: boolean;
};

export class FakeStreamingProvider implements ModelProvider {
  readonly id = "fake-streaming";
  readonly capabilities: ModelCapabilities = {
    streaming: true,
    toolCall: false,
    parallelToolCall: false,
    reasoning: false,
    maxContextTokens: 8_000,
  };

  private readonly chunks: readonly string[];
  private readonly throwAfterFirstChunk: boolean;

  constructor(options: FakeStreamingProviderOptions = {}) {
    this.chunks = options.chunks ?? DEFAULT_CHUNKS;
    this.throwAfterFirstChunk = options.throwAfterFirstChunk ?? false;
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
