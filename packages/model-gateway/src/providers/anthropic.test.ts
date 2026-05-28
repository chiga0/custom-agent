import { describe, expect, it, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages/messages";
import type { Stream } from "@anthropic-ai/sdk/streaming";
import type { ModelMessage, ModelStreamEvent, ModelToolDefinition } from "@custom-agent/core";
import {
  ProviderContextOverflow,
  ProviderRateLimit,
  ProviderServerError,
  ProviderUnauthorized,
  ProviderUnknownError,
} from "../errors";
import {
  AnthropicProvider,
  mapAnthropicError,
  toAnthropicMessages,
  toAnthropicTool,
} from "./anthropic";

// ---- helpers ----

async function collectStream(iter: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const out: ModelStreamEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

// Shorthand for constructing SDK-typed events without filling every optional field.
// The adapter only reads the fields it cares about; casting is safe for tests.
function sseEvent(partial: Record<string, unknown>): RawMessageStreamEvent {
  return partial as unknown as RawMessageStreamEvent;
}

function messageStartEvent(inputTokens: number): RawMessageStreamEvent {
  return sseEvent({
    type: "message_start",
    message: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      content: [],
      model: "claude-sonnet-4-20250514",
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: 0,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
    },
  });
}

function textBlockStart(index: number): RawMessageStreamEvent {
  return sseEvent({
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "", citations: null },
  });
}

function textDelta(index: number, text: string): RawMessageStreamEvent {
  return sseEvent({
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  });
}

function toolUseStart(index: number, id: string, name: string): RawMessageStreamEvent {
  return sseEvent({
    type: "content_block_start",
    index,
    content_block: { type: "tool_use", id, name, input: {} },
  });
}

function inputJsonDelta(index: number, partial_json: string): RawMessageStreamEvent {
  return sseEvent({
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json },
  });
}

function blockStop(index: number): RawMessageStreamEvent {
  return sseEvent({ type: "content_block_stop", index });
}

function messageDelta(
  outputTokens: number,
  stopReason: string = "end_turn",
): RawMessageStreamEvent {
  return sseEvent({
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
}

function messageStop(): RawMessageStreamEvent {
  return sseEvent({ type: "message_stop" });
}

// ---- toAnthropicMessages ----

describe("toAnthropicMessages", () => {
  it("extracts system messages into a separate string", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hi" },
    ];
    const result = toAnthropicMessages(messages);
    expect(result.system).toBe("You are helpful.");
    expect(result.messages).toEqual([{ role: "user", content: "Hi" }]);
  });

  it("concatenates multiple system messages", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "Rule 1" },
      { role: "system", content: "Rule 2" },
      { role: "user", content: "Go" },
    ];
    const result = toAnthropicMessages(messages);
    expect(result.system).toBe("Rule 1\n\nRule 2");
  });

  it("returns undefined system when no system messages exist", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "Hello" }];
    const result = toAnthropicMessages(messages);
    expect(result.system).toBeUndefined();
  });

  it("converts a simple user-assistant conversation", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "4" },
      { role: "user", content: "Thanks" },
    ];
    const result = toAnthropicMessages(messages);
    expect(result.messages).toEqual([
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "4" },
      { role: "user", content: "Thanks" },
    ]);
  });

  it("injects tool_use blocks into assistant message when followed by tool messages", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "Read the file" },
      { role: "assistant", content: "Let me check." },
      { role: "tool", content: "file contents here", toolCallId: "call_1", toolName: "read_file" },
    ];
    const result = toAnthropicMessages(messages);

    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]).toEqual({ role: "user", content: "Read the file" });

    const assistantMsg = result.messages[1];
    expect(assistantMsg.role).toBe("assistant");
    expect(Array.isArray(assistantMsg.content)).toBe(true);
    const content = assistantMsg.content as unknown[];
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "text", text: "Let me check." });
    expect(content[1]).toEqual({
      type: "tool_use",
      id: "call_1",
      name: "read_file",
      input: {},
    });

    const toolResultMsg = result.messages[2];
    expect(toolResultMsg.role).toBe("user");
    const toolContent = toolResultMsg.content as Array<{ type: string; tool_use_id: string }>;
    expect(toolContent[0].type).toBe("tool_result");
    expect(toolContent[0].tool_use_id).toBe("call_1");
  });

  it("groups consecutive tool messages into a single user message with tool_results", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "Read both files" },
      { role: "assistant", content: "" },
      { role: "tool", content: "content A", toolCallId: "call_1", toolName: "read_file" },
      { role: "tool", content: "content B", toolCallId: "call_2", toolName: "read_file" },
    ];
    const result = toAnthropicMessages(messages);

    const toolResultMsg = result.messages[2];
    expect(toolResultMsg.role).toBe("user");
    expect(Array.isArray(toolResultMsg.content)).toBe(true);
    const content = toolResultMsg.content as Array<{ type: string; tool_use_id: string }>;
    expect(content).toHaveLength(2);
    expect(content[0].type).toBe("tool_result");
    expect(content[0].tool_use_id).toBe("call_1");
    expect(content[1].type).toBe("tool_result");
    expect(content[1].tool_use_id).toBe("call_2");
  });

  it("handles a full tool-loop cycle (user -> assistant -> tool -> user)", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "Check something" },
      { role: "assistant", content: "I will use a tool." },
      { role: "tool", content: "result data", toolCallId: "c1", toolName: "shell" },
      { role: "user", content: "What did you find?" },
    ];
    const result = toAnthropicMessages(messages);
    expect(result.messages).toHaveLength(4);
    expect(result.messages[0]).toEqual({ role: "user", content: "Check something" });
    expect(result.messages[1].role).toBe("assistant");
    expect(result.messages[2].role).toBe("user");
    expect(result.messages[3]).toEqual({ role: "user", content: "What did you find?" });
  });
});

// ---- toAnthropicTool ----

describe("toAnthropicTool", () => {
  it("translates a tool definition with inputSchema", () => {
    const def: ModelToolDefinition = {
      name: "read_file",
      description: "Read a file",
      risk: "read",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    };
    const result = toAnthropicTool(def);
    expect(result.name).toBe("read_file");
    expect(result.description).toBe("Read a file");
    expect(result.input_schema).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    });
  });

  it("uses a permissive empty schema when inputSchema is missing", () => {
    const def: ModelToolDefinition = {
      name: "shell",
      description: "Run a shell command",
      risk: "execute",
    };
    const result = toAnthropicTool(def);
    expect(result.input_schema).toEqual({
      type: "object",
      properties: {},
    });
  });
});

// ---- mapAnthropicError ----

describe("mapAnthropicError", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stubHeaders = { get: () => null } as any;

  function makeSdkError(status: number, message: string): Error {
    return Anthropic.APIError.generate(
      status,
      { type: "error", error: { type: "error", message } },
      message,
      stubHeaders,
    );
  }

  it("maps 401 to ProviderUnauthorized", () => {
    const err = mapAnthropicError(makeSdkError(401, "invalid key"));
    expect(err).toBeInstanceOf(ProviderUnauthorized);
  });

  it("maps 403 to ProviderUnauthorized", () => {
    const err = mapAnthropicError(makeSdkError(403, "forbidden"));
    expect(err).toBeInstanceOf(ProviderUnauthorized);
  });

  it("maps 429 to ProviderRateLimit", () => {
    const err = mapAnthropicError(makeSdkError(429, "rate limited"));
    expect(err).toBeInstanceOf(ProviderRateLimit);
  });

  it("maps 413 to ProviderContextOverflow", () => {
    const err = mapAnthropicError(makeSdkError(413, "too large"));
    expect(err).toBeInstanceOf(ProviderContextOverflow);
  });

  it("maps 500 to ProviderServerError", () => {
    const err = mapAnthropicError(makeSdkError(500, "internal error"));
    expect(err).toBeInstanceOf(ProviderServerError);
  });

  it("maps 529 (overloaded) to ProviderServerError", () => {
    const err = mapAnthropicError(makeSdkError(529, "overloaded"));
    expect(err).toBeInstanceOf(ProviderServerError);
  });

  it("maps unknown status to ProviderUnknownError", () => {
    const err = mapAnthropicError(makeSdkError(418, "teapot"));
    expect(err).toBeInstanceOf(ProviderUnknownError);
  });

  it("wraps non-SDK errors in ProviderUnknownError", () => {
    const err = mapAnthropicError(new TypeError("network failure"));
    expect(err).toBeInstanceOf(ProviderUnknownError);
    expect(err.message).toBe("network failure");
  });

  it("wraps non-Error values in ProviderUnknownError", () => {
    const err = mapAnthropicError("string error");
    expect(err).toBeInstanceOf(ProviderUnknownError);
    expect(err.message).toBe("string error");
  });
});

// ---- AnthropicProvider constructor and preflightCheck ----

describe("AnthropicProvider", () => {
  it("has correct default capabilities", () => {
    const provider = new AnthropicProvider({ apiKey: "test-key" });
    expect(provider.id).toContain("anthropic/");
    expect(provider.capabilities.streaming).toBe(true);
    expect(provider.capabilities.toolCall).toBe(true);
    expect(provider.capabilities.maxContextTokens).toBe(200_000);
  });

  it("accepts custom modelId and maxContextTokens", () => {
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      modelId: "claude-3-haiku-20240307",
      maxContextTokens: 100_000,
    });
    expect(provider.id).toBe("anthropic/claude-3-haiku-20240307");
    expect(provider.capabilities.maxContextTokens).toBe(100_000);
  });

  describe("preflightCheck", () => {
    it("passes when estimated tokens are within budget", () => {
      const provider = new AnthropicProvider({ apiKey: "test-key" });
      const result = provider.preflightCheck({
        modelId: "test",
        messages: [{ role: "user", content: "Hello" }],
      });
      expect(result.ok).toBe(true);
    });

    it("fails when estimated tokens exceed maxContextTokens", () => {
      const provider = new AnthropicProvider({
        apiKey: "test-key",
        maxContextTokens: 10,
      });
      const longContent = "x".repeat(100);
      const result = provider.preflightCheck({
        modelId: "test",
        messages: [{ role: "user", content: longContent }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("context_overflow");
        expect(result.estimatedTokens).toBe(25);
        expect(result.maxContextTokens).toBe(10);
      }
    });
  });
});

// ---- stream (mocked SDK) ----

describe("AnthropicProvider.stream (mocked)", () => {
  function makeProvider(mockEvents: RawMessageStreamEvent[]): AnthropicProvider {
    const provider = new AnthropicProvider({ apiKey: "test-key" });

    async function* generateEvents() {
      for (const event of mockEvents) {
        yield event;
      }
    }

    const fakeStream = generateEvents() as unknown as Stream<RawMessageStreamEvent>;
    const mockCreate = vi.fn().mockResolvedValue(fakeStream);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).client = { messages: { create: mockCreate } };

    return provider;
  }

  it("yields text_delta events for text content", async () => {
    const provider = makeProvider([
      messageStartEvent(10),
      textBlockStart(0),
      textDelta(0, "Hello"),
      textDelta(0, " world"),
      blockStop(0),
      messageDelta(5),
      messageStop(),
    ]);

    const events = await collectStream(
      provider.stream(
        { modelId: "test", messages: [{ role: "user", content: "Hi" }] },
        new AbortController().signal,
      ),
    );

    expect(events).toEqual([
      { type: "text_delta", delta: "Hello" },
      { type: "text_delta", delta: " world" },
      { type: "completed", usage: { promptTokens: 10, completionTokens: 5 } },
    ]);
  });

  it("accumulates tool-use blocks and yields tool_call_request", async () => {
    const provider = makeProvider([
      messageStartEvent(15),
      toolUseStart(0, "toolu_01", "read_file"),
      inputJsonDelta(0, '{"path":'),
      inputJsonDelta(0, '"/tmp/test.txt"}'),
      blockStop(0),
      messageDelta(8, "tool_use"),
      messageStop(),
    ]);

    const events = await collectStream(
      provider.stream(
        { modelId: "test", messages: [{ role: "user", content: "Read it" }] },
        new AbortController().signal,
      ),
    );

    expect(events).toEqual([
      {
        type: "tool_call_request",
        toolCallId: "toolu_01",
        toolName: "read_file",
        toolArgs: { path: "/tmp/test.txt" },
      },
      { type: "completed", usage: { promptTokens: 15, completionTokens: 8 } },
    ]);
  });

  it("handles mixed text and tool_use blocks", async () => {
    const provider = makeProvider([
      messageStartEvent(20),
      textBlockStart(0),
      textDelta(0, "Let me check."),
      blockStop(0),
      toolUseStart(1, "toolu_02", "shell"),
      inputJsonDelta(1, '{"command":"ls"}'),
      blockStop(1),
      messageDelta(12, "tool_use"),
      messageStop(),
    ]);

    const events = await collectStream(
      provider.stream(
        { modelId: "test", messages: [{ role: "user", content: "List files" }] },
        new AbortController().signal,
      ),
    );

    expect(events).toEqual([
      { type: "text_delta", delta: "Let me check." },
      {
        type: "tool_call_request",
        toolCallId: "toolu_02",
        toolName: "shell",
        toolArgs: { command: "ls" },
      },
      { type: "completed", usage: { promptTokens: 20, completionTokens: 12 } },
    ]);
  });

  it("handles tool_use with empty input JSON", async () => {
    const provider = makeProvider([
      messageStartEvent(5),
      toolUseStart(0, "toolu_03", "no_args_tool"),
      blockStop(0),
      messageDelta(3, "tool_use"),
      messageStop(),
    ]);

    const events = await collectStream(
      provider.stream(
        { modelId: "test", messages: [{ role: "user", content: "Go" }] },
        new AbortController().signal,
      ),
    );

    expect(events[0]).toEqual({
      type: "tool_call_request",
      toolCallId: "toolu_03",
      toolName: "no_args_tool",
      toolArgs: {},
    });
  });

  it("yields failed:aborted when signal fires mid-stream", async () => {
    const ac = new AbortController();
    const provider = new AnthropicProvider({ apiKey: "test-key" });

    async function* generateEvents(): AsyncGenerator<RawMessageStreamEvent> {
      yield messageStartEvent(5);
      ac.abort();
      yield textBlockStart(0);
    }

    const fakeStream = generateEvents() as unknown as Stream<RawMessageStreamEvent>;
    const mockCreate = vi.fn().mockResolvedValue(fakeStream);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).client = { messages: { create: mockCreate } };

    const events = await collectStream(
      provider.stream({ modelId: "test", messages: [{ role: "user", content: "Hi" }] }, ac.signal),
    );

    expect(events).toContainEqual({ type: "failed", reason: "aborted" });
  });

  it("throws ProviderError when SDK create call fails", async () => {
    const provider = new AnthropicProvider({ apiKey: "test-key" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stubHeaders = { get: () => null } as any;
    const sdkError = Anthropic.APIError.generate(
      429,
      { type: "error", error: { type: "error", message: "rate limited" } },
      "rate limited",
      stubHeaders,
    );
    const mockCreate = vi.fn().mockRejectedValue(sdkError);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).client = { messages: { create: mockCreate } };

    await expect(async () => {
      for await (const _ of provider.stream(
        { modelId: "test", messages: [{ role: "user", content: "Hi" }] },
        new AbortController().signal,
      )) {
        void _;
      }
    }).rejects.toBeInstanceOf(ProviderRateLimit);
  });
});
