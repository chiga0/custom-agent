import { describe, expect, it } from "vitest";
import { PermissionEngine, type PermissionEventInput } from "@custom-agent/permissions";
import { ToolRouter, type ToolEventInput } from "./router";
import type { Tool } from "./tool";

// CapturingSink is reused for both permission and tool event flows.
class CapturingPermissionSink {
  readonly events: PermissionEventInput[] = [];
  async emit(e: PermissionEventInput): Promise<void> {
    this.events.push(e);
  }
}

class CapturingToolSink {
  readonly events: ToolEventInput[] = [];
  async emit(e: ToolEventInput): Promise<void> {
    this.events.push(e);
  }
}

function makeRouter(opts: {
  tool: Tool<unknown>;
  policyDecision?: "allow" | "ask" | "deny";
  userOutcome?: "allowed" | "denied";
}): {
  router: ToolRouter;
  permSink: CapturingPermissionSink;
  toolSink: CapturingToolSink;
} {
  const permSink = new CapturingPermissionSink();
  const toolSink = new CapturingToolSink();
  const policyDecision = opts.policyDecision ?? "allow";
  const policy =
    policyDecision === "allow"
      ? {
          byRisk: {
            read: "allow" as const,
            write: "allow" as const,
            execute: "allow" as const,
            network: "allow" as const,
          },
        }
      : policyDecision === "deny"
        ? { defaultDecision: "deny" as const }
        : { defaultDecision: "ask" as const };
  const engine = new PermissionEngine({
    policy,
    approvalSource: async () => ({ outcome: opts.userOutcome ?? "allowed" }),
    eventSink: permSink,
  });
  const router = new ToolRouter({
    permissionEngine: engine,
    toolEventSink: toolSink,
    cwd: "/tmp",
    tools: [opts.tool],
  });
  return { router, permSink, toolSink };
}

const echoTool: Tool<{ text: string }> = {
  name: "echo",
  risk: "read",
  async execute(args, ctx) {
    ctx.emit({ kind: "result", text: args.text });
    return { status: "ok" };
  },
};

const throwingTool: Tool<unknown> = {
  name: "boom",
  risk: "read",
  async execute() {
    throw new Error("oops");
  },
};

const enoentTool: Tool<unknown> = {
  name: "missing",
  risk: "read",
  async execute() {
    const err = new Error("not here") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  },
};

describe("ToolRouter — happy path", () => {
  it("dispatch emits tool.started → tool.delta → tool.completed for an allowed tool", async () => {
    const { router, toolSink } = makeRouter({ tool: echoTool });
    const result = await router.dispatch({
      toolName: "echo",
      args: { text: "hello" },
      reason: "agent wants to greet",
    });
    expect(result.outcome.status).toBe("ok");
    expect(toolSink.events.map((e) => e.type)).toEqual([
      "tool.started",
      "tool.delta",
      "tool.completed",
    ]);
    expect((toolSink.events[2].payload as { deltaCount: number }).deltaCount).toBe(1);
    expect((toolSink.events[2].payload as { truncated: boolean }).truncated).toBe(false);
  });

  it("registry: list() reports registered tools with risk", () => {
    const { router } = makeRouter({ tool: echoTool });
    expect(router.list()).toContainEqual({ name: "echo", risk: "read" });
    expect(router.has("echo")).toBe(true);
    expect(router.has("nope")).toBe(false);
  });

  it("duplicate register throws", () => {
    const { router } = makeRouter({ tool: echoTool });
    expect(() => router.register(echoTool)).toThrow(/duplicate/);
  });

  it("unknown tool: emits tool.failed with errorCode=not_found, no permission flow", async () => {
    const { router, permSink, toolSink } = makeRouter({ tool: echoTool });
    const result = await router.dispatch({
      toolName: "ghost",
      args: {},
      reason: "?",
    });
    expect(result.outcome.status).toBe("failed");
    expect((result.outcome as { errorCode: string }).errorCode).toBe("not_found");
    expect(toolSink.events.map((e) => e.type)).toEqual(["tool.failed"]);
    expect(permSink.events).toHaveLength(0); // never asked the engine
  });
});

describe("ToolRouter — permission gate", () => {
  it("deny-by-policy: tool.failed errorCode=permission_denied; executor never runs", async () => {
    let executed = false;
    const tool: Tool<unknown> = {
      name: "should_not_run",
      risk: "execute",
      async execute() {
        executed = true;
        return { status: "ok" };
      },
    };
    const { router, permSink, toolSink } = makeRouter({
      tool,
      policyDecision: "deny",
    });
    const result = await router.dispatch({
      toolName: "should_not_run",
      args: {},
      reason: "agent wants execute",
    });
    expect(executed).toBe(false);
    expect(result.outcome.status).toBe("failed");
    expect((result.outcome as { errorCode: string }).errorCode).toBe("permission_denied");
    expect(toolSink.events.map((e) => e.type)).toEqual(["tool.failed"]);
    // PermissionEngine still emits requested + resolved for audit.
    expect(permSink.events.map((e) => e.type)).toEqual([
      "tool.permission_requested",
      "tool.permission_resolved",
    ]);
  });

  it("ask + user denies: tool.failed errorCode=permission_denied, message mentions user", async () => {
    let executed = false;
    const tool: Tool<unknown> = {
      name: "ask_path",
      risk: "execute",
      async execute() {
        executed = true;
        return { status: "ok" };
      },
    };
    const { router, toolSink } = makeRouter({
      tool,
      policyDecision: "ask",
      userOutcome: "denied",
    });
    const result = await router.dispatch({
      toolName: "ask_path",
      args: {},
      reason: "agent wants execute",
    });
    expect(executed).toBe(false);
    expect((result.outcome as { errorCode: string }).errorCode).toBe("permission_denied");
    const failed = toolSink.events.at(-1);
    expect((failed?.payload as { message: string }).message).toMatch(/user/);
  });

  it("ask + user approves: full lifecycle runs", async () => {
    const { router, toolSink } = makeRouter({
      tool: echoTool,
      policyDecision: "ask",
      userOutcome: "allowed",
    });
    const result = await router.dispatch({
      toolName: "echo",
      args: { text: "hi" },
      reason: "x",
    });
    expect(result.outcome.status).toBe("ok");
    expect(toolSink.events.map((e) => e.type)).toEqual([
      "tool.started",
      "tool.delta",
      "tool.completed",
    ]);
  });
});

describe("ToolRouter — failure paths", () => {
  it("tool throws plain Error: errorCode=unknown", async () => {
    const { router, toolSink } = makeRouter({ tool: throwingTool });
    const result = await router.dispatch({
      toolName: "boom",
      args: {},
      reason: "x",
    });
    expect((result.outcome as { errorCode: string }).errorCode).toBe("unknown");
    const failed = toolSink.events.at(-1);
    expect((failed?.payload as { message: string }).message).toBe("oops");
  });

  it("tool throws ENOENT: errorCode=not_found", async () => {
    const { router } = makeRouter({ tool: enoentTool });
    const result = await router.dispatch({
      toolName: "missing",
      args: {},
      reason: "x",
    });
    expect((result.outcome as { errorCode: string }).errorCode).toBe("not_found");
  });
});

describe("ToolRouter — output budget", () => {
  it("excess emit() output is truncated and tool.completed.truncated=true", async () => {
    const flooderTool: Tool<unknown> = {
      name: "flood",
      risk: "read",
      async execute(_args, ctx) {
        void _args;
        ctx.emit({ kind: "result", text: "x".repeat(1000) });
        ctx.emit({ kind: "result", text: "y".repeat(1000) });
        return { status: "ok" };
      },
    };
    const permSink = new CapturingPermissionSink();
    const toolSink = new CapturingToolSink();
    const engine = new PermissionEngine({
      policy: { byRisk: { read: "allow" } },
      approvalSource: async () => ({ outcome: "allowed" }),
      eventSink: permSink,
    });
    const router = new ToolRouter({
      permissionEngine: engine,
      toolEventSink: toolSink,
      cwd: "/tmp",
      tools: [flooderTool],
      outputBudgetBytes: 500,
    });
    await router.dispatch({ toolName: "flood", args: {}, reason: "x" });
    const completed = toolSink.events.find((e) => e.type === "tool.completed");
    expect((completed?.payload as { truncated: boolean }).truncated).toBe(true);
  });
});
