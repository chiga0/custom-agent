import type { ToolErrorCode, ToolRisk } from "@custom-agent/schema";
import type { BudgetAccumulator } from "./budget";

// The Tool port — every concrete tool implementation conforms to this
// shape. The port is intentionally narrow: a name, a risk class, and a
// single `execute` method that takes typed args + an execution
// context + a budget accumulator. Streaming chunks flow back via the
// `emit` callback inside the context; the final return value carries
// terminal status only.
//
// Tools do NOT call into PermissionEngine or write events directly.
// That's ToolRouter's job. A tool that wants to "be denied" can
// inspect ctx but still has no engine reference.

export type ToolEmit = (chunk: ToolChunk) => void;

export type ToolChunk =
  | { readonly kind: "stdout"; readonly text: string }
  | { readonly kind: "stderr"; readonly text: string }
  | { readonly kind: "result"; readonly text: string };

export type ToolContext = {
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly emit: ToolEmit;
  readonly budget: BudgetAccumulator;
};

export type ToolSuccess = { readonly status: "ok" };

export type ToolFailure = {
  readonly status: "failed";
  readonly errorCode: ToolErrorCode;
  readonly message: string;
};

export type ToolOutcome = ToolSuccess | ToolFailure;

export type Tool<Args = unknown> = {
  readonly name: string;
  readonly risk: ToolRisk;
  /**
   * Best-effort hint used by the router for ProviderError-style logs;
   * NOT used by PermissionEngine (the engine's policy works off `risk`).
   */
  readonly description?: string;
  execute(args: Args, ctx: ToolContext): Promise<ToolOutcome>;
};
