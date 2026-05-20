import type { AgentEvent } from "@custom-agent/schema";

// Narrow commit callback — no AgentEvent envelope fields needed at call site.
export type ToolEventCommit = (
  partial: Pick<AgentEvent, "type" | "payload">,
) => Promise<void>;

// Per-turn handler created by the factory.
export type ToolCallHandler = {
  /**
   * List tools available to the model (used to populate ModelRequest.tools).
   */
  listTools(): readonly { readonly name: string; readonly description: string; readonly risk: string }[];
  /**
   * Dispatch one tool call. Emits tool lifecycle events via the commit
   * callback injected at construction. Returns the result text to feed
   * back to the model as a "tool" role message.
   */
  handle(toolCallId: string, toolName: string, toolArgs: unknown): Promise<string>;
};

// Factory called by SessionEngine at the start of each turn.
export type ToolCallHandlerFactory = (
  commitEvent: ToolEventCommit,
  cwd: string,
  signal: AbortSignal,
) => ToolCallHandler;
