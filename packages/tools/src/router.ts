import type { PermissionEngine, PermissionEventInput } from "@custom-agent/permissions";
import type {
  ToolCompletedEvent,
  ToolDeltaEvent,
  ToolErrorCode,
  ToolFailedEvent,
  ToolStartedEvent,
} from "@custom-agent/schema";
import { BudgetAccumulator, DEFAULT_OUTPUT_BUDGET_BYTES } from "./budget";
import type { Tool, ToolChunk, ToolFailure, ToolOutcome } from "./tool";

// ToolRouter — the single entry point through which any tool invocation
// reaches an executor. Holds a registry of `Tool` instances by name and
// owns the lifecycle:
//
//   1. requestPermission(engine) — engine emits tool.permission_*.
//      Denied: emit tool.failed { errorCode: "permission_denied" }, return.
//   2. Emit tool.started.
//   3. Open BudgetAccumulator. Run `tool.execute(args, ctx)`. Every
//      `ctx.emit(chunk)` becomes a tool.delta event.
//   4. Emit tool.completed (success) or tool.failed (executor returned
//      failure / threw).
//
// The router emits events through the same `PermissionEventInput`-style
// sink shape used by PermissionEngine, except parameterised over the
// tool event variants. ToolRouter is session-agnostic; the SessionEngine
// adapter (M3-02b) fills envelope fields when committing.

export type ToolEventInput =
  | Pick<ToolStartedEvent, "type" | "payload">
  | Pick<ToolDeltaEvent, "type" | "payload">
  | Pick<ToolCompletedEvent, "type" | "payload">
  | Pick<ToolFailedEvent, "type" | "payload">;

export type ToolEventSink = {
  emit(event: ToolEventInput): Promise<void>;
};

export type ToolRouterOptions = {
  /** Tools to register at construction; more can be added via `register`. */
  readonly tools?: readonly Tool<unknown>[];
  readonly permissionEngine: PermissionEngine;
  readonly toolEventSink: ToolEventSink;
  /** Working directory for path-bound tools. M1 binds 1 session = 1 cwd. */
  readonly cwd: string;
  /** Override default output budget. Tests use small values to drive truncation. */
  readonly outputBudgetBytes?: number;
  /** Test injection: deterministic toolCallId. */
  readonly createCallId?: () => string;
};

export type ToolInvocation = {
  readonly toolName: string;
  readonly args: unknown;
  /** Reason surfaced to the user during ask flow. */
  readonly reason: string;
  /**
   * Optional preview of args. Truncated by PermissionEngine to 512 chars;
   * also shown on tool.started for the audit log.
   */
  readonly argsPreview?: string;
};

export type ToolDispatchResult = {
  readonly toolCallId: string;
  readonly outcome: ToolOutcome;
};

export class ToolRouter {
  private readonly tools = new Map<string, Tool<unknown>>();
  private readonly permissionEngine: PermissionEngine;
  private readonly toolEventSink: ToolEventSink;
  private readonly cwd: string;
  private readonly outputBudgetBytes: number;
  private readonly createCallId: () => string;
  private nextCallId = 1;

  constructor(opts: ToolRouterOptions) {
    this.permissionEngine = opts.permissionEngine;
    this.toolEventSink = opts.toolEventSink;
    this.cwd = opts.cwd;
    this.outputBudgetBytes = opts.outputBudgetBytes ?? DEFAULT_OUTPUT_BUDGET_BYTES;
    this.createCallId = opts.createCallId ?? (() => `tc_${this.nextCallId++}`);
    for (const t of opts.tools ?? []) this.register(t);
  }

  register<Args>(tool: Tool<Args>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`ToolRouter: duplicate registration for ${tool.name}`);
    }
    this.tools.set(tool.name, tool as Tool<unknown>);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): readonly {
    readonly name: string;
    readonly risk: string;
    readonly description?: string;
  }[] {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      risk: t.risk,
      description: t.description,
    }));
  }

  /**
   * Full lifecycle: permission check → tool.started → execute (streaming
   * via ctx.emit) → tool.completed | tool.failed. Returns the outcome
   * so callers (M3-02b SessionEngine) can decide what to feed back to
   * the model.
   */
  async dispatch(
    invocation: ToolInvocation,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ToolDispatchResult> {
    const toolCallId = this.createCallId();
    const tool = this.tools.get(invocation.toolName);
    if (!tool) {
      const message = `unknown tool: ${invocation.toolName}`;
      await this.toolEventSink.emit({
        type: "tool.failed",
        payload: {
          toolCallId,
          toolName: invocation.toolName,
          errorCode: "not_found",
          message,
        },
      });
      return {
        toolCallId,
        outcome: { status: "failed", errorCode: "not_found", message },
      };
    }

    // Permission gate. PermissionEngine emits tool.permission_*; that's
    // the audit trail for the policy decision. The router translates
    // a denial into a tool.failed event so the executor lifecycle is
    // symmetric whether the call succeeded or never started.
    const resolution = await this.permissionEngine.requestPermission(
      {
        toolName: tool.name,
        risk: tool.risk,
        reason: invocation.reason,
        toolCallId,
        argsPreview: invocation.argsPreview,
      },
      signal,
    );

    if (resolution.outcome === "denied") {
      const message = `permission ${resolution.source === "user" ? "denied by user" : "denied by policy"}`;
      await this.toolEventSink.emit({
        type: "tool.failed",
        payload: {
          toolCallId,
          toolName: tool.name,
          errorCode: "permission_denied",
          message,
        },
      });
      return {
        toolCallId,
        outcome: { status: "failed", errorCode: "permission_denied", message },
      };
    }

    // Permission granted. Open lifecycle.
    await this.toolEventSink.emit({
      type: "tool.started",
      payload: {
        toolCallId,
        permissionRequestId: resolution.requestId,
        toolName: tool.name,
        argsPreview: invocation.argsPreview,
      },
    });

    const budget = new BudgetAccumulator(this.outputBudgetBytes);
    let deltaCount = 0;
    // Sink writes (in M3-02b: EventStore.append) MUST preserve order to
    // honour the storage layer's sequence invariant. Per-chunk await
    // serializes delivery — that's the right semantic for the
    // SessionEngine integration path; profiling-driven concurrency can
    // come later if a real bottleneck shows up.
    let deltaChain: Promise<void> = Promise.resolve();

    const emit = (chunk: ToolChunk): void => {
      const trimmed = budget.take(chunk.text);
      if (!trimmed) return;
      deltaChain = deltaChain.then(() =>
        this.toolEventSink.emit({
          type: "tool.delta",
          payload: { toolCallId, kind: chunk.kind, text: trimmed },
        }),
      );
      deltaCount += 1;
    };

    let outcome: ToolOutcome;
    try {
      outcome = await tool.execute(invocation.args, {
        cwd: this.cwd,
        signal,
        emit,
        budget,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      outcome = {
        status: "failed",
        errorCode: classifyThrown(err),
        message,
      };
    }

    // Drain every in-flight delta emit BEFORE the terminal event lands.
    // Without this the audit log could see tool.completed before the
    // final tool.delta when the sink is async-slow.
    try {
      await deltaChain;
    } catch (err) {
      // A delta-sink failure is itself a tool failure; surface it.
      outcome = {
        status: "failed",
        errorCode: "io_error",
        message: `tool.delta sink failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (outcome.status === "ok") {
      await this.toolEventSink.emit({
        type: "tool.completed",
        payload: {
          toolCallId,
          toolName: tool.name,
          deltaCount,
          truncated: budget.truncated,
        },
      });
    } else {
      await this.toolEventSink.emit({
        type: "tool.failed",
        payload: {
          toolCallId,
          toolName: tool.name,
          errorCode: (outcome as ToolFailure).errorCode,
          message: (outcome as ToolFailure).message,
        },
      });
    }

    return { toolCallId, outcome };
  }
}

function classifyThrown(err: unknown): ToolErrorCode {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (code === "ENOENT") return "not_found";
    if (code === "EACCES" || code === "EPERM") return "io_error";
  }
  if (err instanceof Error && /aborted/i.test(err.message)) return "cancelled";
  return "unknown";
}

// Re-export PermissionEventInput shape from permissions so callers wiring
// the two sinks together only need a single import path.
export type { PermissionEventInput };
