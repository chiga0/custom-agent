import type {
  ModelCapabilities,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  PreflightResult,
} from "../ports/model-provider";

export type FakeToolCallSequence = {
  readonly toolName: string;
  readonly toolArgs: unknown;
  readonly finalResponse: string;
};

export type FakeToolCallProviderOptions = {
  readonly sequence: FakeToolCallSequence;
  readonly maxContextTokens?: number;
};

export class FakeToolCallProvider implements ModelProvider {
  readonly id = "fake-tool-call";
  readonly capabilities: ModelCapabilities;
  private readonly sequence: FakeToolCallSequence;

  constructor(options: FakeToolCallProviderOptions) {
    this.sequence = options.sequence;
    this.capabilities = {
      streaming: true,
      toolCall: true,
      parallelToolCall: false,
      reasoning: false,
      maxContextTokens: options.maxContextTokens ?? 8_000,
    };
  }

  preflightCheck(request: ModelRequest): PreflightResult {
    const totalChars = request.messages.reduce((acc, m) => acc + m.content.length, 0);
    const estimatedTokens = Math.ceil(totalChars / 4);
    if (estimatedTokens > this.capabilities.maxContextTokens) {
      return { ok: false, reason: "context_overflow", estimatedTokens, maxContextTokens: this.capabilities.maxContextTokens };
    }
    return { ok: true, estimatedTokens };
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    const hasToolResult = request.messages.some((m) => m.role === "tool");

    if (!hasToolResult) {
      if (signal.aborted) return;
      yield {
        type: "tool_call_request",
        toolCallId: "tc_1",
        toolName: this.sequence.toolName,
        toolArgs: this.sequence.toolArgs,
      };
      yield { type: "completed" };
    } else {
      for (const word of this.sequence.finalResponse.split(" ")) {
        if (signal.aborted) return;
        yield { type: "text_delta", delta: word + " " };
      }
      yield { type: "completed" };
    }
  }
}
