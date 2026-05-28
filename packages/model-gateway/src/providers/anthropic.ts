import Anthropic from "@anthropic-ai/sdk";
import type { Stream } from "@anthropic-ai/sdk/streaming";
import type {
  ModelCapabilities,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  ModelToolDefinition,
  PreflightResult,
} from "@custom-agent/core";
import {
  ProviderContextOverflow,
  ProviderRateLimit,
  ProviderServerError,
  ProviderUnauthorized,
  ProviderUnknownError,
} from "../errors";

export type AnthropicProviderOptions = {
  readonly apiKey: string;
  readonly modelId?: string;
  readonly baseUrl?: string;
  readonly maxContextTokens?: number;
};

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;
const DEFAULT_MAX_TOKENS = 8_192;
const CHARS_PER_TOKEN = 4;

export class AnthropicProvider implements ModelProvider {
  readonly id: string;
  readonly capabilities: ModelCapabilities;
  private readonly client: Anthropic;
  private readonly modelId: string;

  constructor(opts: AnthropicProviderOptions) {
    this.modelId = opts.modelId ?? DEFAULT_MODEL;
    this.id = `anthropic/${this.modelId}`;
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      ...(opts.baseUrl && { baseURL: opts.baseUrl }),
    });
    this.capabilities = {
      streaming: true,
      toolCall: true,
      parallelToolCall: true,
      reasoning: false,
      maxContextTokens: opts.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS,
    };
  }

  preflightCheck(request: ModelRequest): PreflightResult {
    let totalChars = 0;
    for (const m of request.messages) {
      totalChars += m.content.length;
    }
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

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    const { system, messages } = toAnthropicMessages(request.messages);
    const tools =
      request.tools && request.tools.length > 0 ? request.tools.map(toAnthropicTool) : undefined;

    let rawStream: Stream<Anthropic.RawMessageStreamEvent>;
    try {
      rawStream = await this.client.messages.create(
        {
          model: this.modelId,
          max_tokens: DEFAULT_MAX_TOKENS,
          ...(system && { system }),
          messages,
          ...(tools && { tools }),
          stream: true,
        },
        { signal },
      );
    } catch (error) {
      throw mapAnthropicError(error);
    }

    const toolBlocks = new Map<number, { id: string; name: string; jsonParts: string[] }>();
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      for await (const event of rawStream) {
        if (signal.aborted) {
          yield { type: "failed", reason: "aborted" };
          return;
        }

        switch (event.type) {
          case "message_start": {
            if (event.message.usage) {
              inputTokens = event.message.usage.input_tokens;
              outputTokens = event.message.usage.output_tokens;
            }
            break;
          }

          case "content_block_start": {
            if (event.content_block.type === "tool_use") {
              toolBlocks.set(event.index, {
                id: event.content_block.id,
                name: event.content_block.name,
                jsonParts: [],
              });
            }
            break;
          }

          case "content_block_delta": {
            if (event.delta.type === "text_delta") {
              yield { type: "text_delta", delta: event.delta.text };
            } else if (event.delta.type === "input_json_delta") {
              const block = toolBlocks.get(event.index);
              if (block) block.jsonParts.push(event.delta.partial_json);
            }
            break;
          }

          case "content_block_stop": {
            const block = toolBlocks.get(event.index);
            if (block) {
              const rawJson = block.jsonParts.join("");
              const toolArgs: unknown = rawJson ? JSON.parse(rawJson) : {};
              yield {
                type: "tool_call_request",
                toolCallId: block.id,
                toolName: block.name,
                toolArgs,
              };
              toolBlocks.delete(event.index);
            }
            break;
          }

          case "message_delta": {
            if (event.usage) {
              outputTokens += event.usage.output_tokens;
            }
            break;
          }

          case "message_stop": {
            break;
          }
        }
      }

      yield {
        type: "completed",
        usage: {
          promptTokens: inputTokens,
          completionTokens: outputTokens,
        },
      };
    } catch (error) {
      if (signal.aborted) {
        yield { type: "failed", reason: "aborted" };
        return;
      }
      throw mapAnthropicError(error);
    }
  }
}

// ---- translation helpers (exported for unit testing) ----

export function toAnthropicMessages(messages: readonly ModelMessage[]): {
  system: string | undefined;
  messages: Anthropic.MessageParam[];
} {
  const systemParts: string[] = [];
  const out: Anthropic.MessageParam[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "system") {
      systemParts.push(msg.content);
      continue;
    }

    if (msg.role === "user") {
      out.push({ role: "user", content: msg.content });
      continue;
    }

    if (msg.role === "assistant") {
      const toolUseBlocks = collectFollowingToolUseBlocks(messages, i);
      if (toolUseBlocks.length > 0) {
        const content: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = [];
        if (msg.content) {
          content.push({ type: "text" as const, text: msg.content });
        }
        content.push(...toolUseBlocks);
        out.push({ role: "assistant", content });
      } else {
        out.push({ role: "assistant", content: msg.content });
      }
      continue;
    }

    if (msg.role === "tool") {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      let j = i;
      while (j < messages.length && messages[j].role === "tool") {
        const tm = messages[j];
        toolResults.push({
          type: "tool_result" as const,
          tool_use_id: tm.toolCallId ?? "",
          content: tm.content,
        });
        j++;
      }
      out.push({ role: "user", content: toolResults });
      // Skip ahead past the tool messages we just consumed.
      // The loop will increment i at the top, so set to j - 1.
      i = j - 1;
      continue;
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: out,
  };
}

function collectFollowingToolUseBlocks(
  messages: readonly ModelMessage[],
  assistantIndex: number,
): Anthropic.ToolUseBlockParam[] {
  const blocks: Anthropic.ToolUseBlockParam[] = [];
  for (let j = assistantIndex + 1; j < messages.length; j++) {
    const m = messages[j];
    if (m.role !== "tool") break;
    blocks.push({
      type: "tool_use" as const,
      id: m.toolCallId ?? "",
      name: m.toolName ?? "",
      input: {},
    });
  }
  return blocks;
}

export function toAnthropicTool(def: ModelToolDefinition): Anthropic.Messages.Tool {
  return {
    name: def.name,
    description: def.description,
    input_schema: (def.inputSchema as Anthropic.Messages.Tool.InputSchema) ?? {
      type: "object" as const,
      properties: {},
    },
  };
}

export function mapAnthropicError(error: unknown): Error {
  if (error instanceof Anthropic.APIUserAbortError) {
    return error;
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status;
    const message = error.message;
    if (status === 401 || status === 403) {
      return new ProviderUnauthorized(message, error);
    }
    if (status === 429) {
      const retryAfter = parseRetryAfterHeader(error.headers);
      return new ProviderRateLimit(message, retryAfter, error);
    }
    if (status === 413 || isContextOverflowError(error)) {
      return new ProviderContextOverflow(message, error);
    }
    if (status !== undefined && status >= 500) {
      return new ProviderServerError(message, error);
    }
    return new ProviderUnknownError(message, error);
  }
  if (error instanceof Error) {
    return new ProviderUnknownError(error.message, error);
  }
  return new ProviderUnknownError(String(error), error);
}

function isContextOverflowError(error: InstanceType<typeof Anthropic.APIError>): boolean {
  const msg = error.message.toLowerCase();
  return msg.includes("context") && msg.includes("too long");
}

function parseRetryAfterHeader(headers: Headers | undefined): number | undefined {
  if (!headers) return undefined;
  const value = headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return seconds * 1000;
}
