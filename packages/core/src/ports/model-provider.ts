// Provider-neutral port that Core uses to drive any model adapter. Concrete
// adapters (fake / real provider) implement this contract; Core MUST NOT
// import provider SDKs directly.

import type { ToolRisk } from "@custom-agent/schema";

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
  readonly toolCallId?: string;
  readonly toolName?: string;
};

export type ModelToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly risk: ToolRisk;
};

export type ModelRequest = {
  readonly modelId: string;
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly ModelToolDefinition[];
  readonly metadata?: Record<string, unknown>;
};

export type ModelUsage = {
  readonly promptTokens: number;
  readonly completionTokens: number;
};

export type ModelStreamEvent =
  | { readonly type: "text_delta"; readonly delta: string }
  | { readonly type: "tool_call_request"; readonly toolCallId: string; readonly toolName: string; readonly toolArgs: unknown }
  | { readonly type: "completed"; readonly usage?: ModelUsage }
  | { readonly type: "failed"; readonly reason: string };

/**
 * Result of a synchronous, network-free check that a ModelRequest fits
 * within the provider's hard constraints (currently context window).
 *
 * Per [[adr-0003]] §2, real providers MUST run this BEFORE opening a
 * stream so the daemon never relies on the upstream API rejecting an
 * over-budget request asynchronously (which can hang or 5xx without a
 * clean error frame). Core consumes the result and surfaces failures
 * as `turn.completed { stopReason: "error", errorCode: "context_overflow" }`
 * — see `SessionEngine.runTurn`.
 */
export type PreflightResult =
  | { readonly ok: true; readonly estimatedTokens: number }
  | {
      readonly ok: false;
      readonly reason: "context_overflow";
      readonly estimatedTokens: number;
      readonly maxContextTokens: number;
    };

export type ModelProvider = {
  readonly id: string;
  readonly capabilities: ModelCapabilities;
  /**
   * Estimate token usage for the request and report whether it fits
   * within the provider's hard limits. MUST be synchronous (or close
   * to it) and MUST NOT hit the network — this runs on every turn
   * before the stream and must stay cheap.
   *
   * Implementations are expected to use the provider's own tokenizer
   * (or a conservative approximation) over `request.messages`. Fake
   * providers in tests may use a character-count heuristic.
   */
  preflightCheck(request: ModelRequest): PreflightResult;
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>;
};
