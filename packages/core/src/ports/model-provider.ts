// Provider-neutral port that Core uses to drive any model adapter. Concrete
// adapters (fake / real provider) implement this contract; Core MUST NOT
// import provider SDKs directly.

export type ModelCapabilities = {
  readonly streaming: boolean;
  readonly toolCall: boolean;
  readonly parallelToolCall: boolean;
  readonly reasoning: boolean;
  readonly maxContextTokens: number;
};

export type ModelMessage = {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
};

export type ModelRequest = {
  readonly modelId: string;
  readonly messages: readonly ModelMessage[];
  readonly metadata?: Record<string, unknown>;
};

export type ModelUsage = {
  readonly promptTokens: number;
  readonly completionTokens: number;
};

export type ModelStreamEvent =
  | { readonly type: "text_delta"; readonly delta: string }
  | { readonly type: "completed"; readonly usage?: ModelUsage }
  | { readonly type: "failed"; readonly reason: string };

export type ModelProvider = {
  readonly id: string;
  readonly capabilities: ModelCapabilities;
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>;
};
