import { describe, expect, it } from "vitest";
import { FakeToolCallProvider } from "./fake-tool-provider";

describe("FakeToolCallProvider", () => {
  it("emits tool_call_request on first stream call", async () => {
    const provider = new FakeToolCallProvider({
      sequence: {
        toolName: "echo",
        toolArgs: { message: "hello" },
        finalResponse: "The echo said: hello",
      },
    });

    const events = [];
    for await (const event of provider.stream(
      { modelId: "fake-tool-call", messages: [{ role: "user", content: "say hello" }] },
      new AbortController().signal,
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "tool_call_request",
      toolCallId: "tc_1",
      toolName: "echo",
      toolArgs: { message: "hello" },
    });
  });

  it("emits text_delta on second stream call (with tool result)", async () => {
    const provider = new FakeToolCallProvider({
      sequence: {
        toolName: "echo",
        toolArgs: { message: "hello" },
        finalResponse: "The result",
      },
    });

    const events = [];
    for await (const event of provider.stream(
      {
        modelId: "fake-tool-call",
        messages: [
          { role: "user", content: "say hello" },
          { role: "assistant", content: "" },
          { role: "tool", content: "hello", toolCallId: "tc_1", toolName: "echo" },
        ],
      },
      new AbortController().signal,
    )) {
      events.push(event);
    }

    const textEvents = events.filter((e) => e.type === "text_delta");
    expect(textEvents.length).toBeGreaterThan(0);
    const fullText = textEvents.map((e) => (e as { delta: string }).delta).join("");
    expect(fullText.trim()).toBe("The result");
  });
});
