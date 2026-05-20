import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  PermissionEngine,
  classifyPermission,
  type ApprovalSource,
  type PermissionEventInput,
  type PermissionEventSink,
  type PermissionPolicy,
  type PermissionRequest,
} from "./index";

// Test-only event sink that captures everything the engine emits, in
// order. Doubles as the "audit log" assertions verify against.
class CapturingSink implements PermissionEventSink {
  readonly events: PermissionEventInput[] = [];
  async emit(event: PermissionEventInput): Promise<void> {
    this.events.push(event);
  }
}

function alwaysApproveSource(reason = "user said yes"): ApprovalSource {
  return async () => ({ outcome: "allowed", reason });
}

function alwaysDenySource(reason = "user said no"): ApprovalSource {
  return async () => ({ outcome: "denied", reason });
}

const baseRequest: PermissionRequest = {
  toolName: "read_file",
  risk: "read",
  reason: "list project layout",
};

describe("PermissionEngine — policy matrix", () => {
  it("default policy: read=allow, write=ask, execute=ask, network=ask", () => {
    const engine = new PermissionEngine({
      approvalSource: alwaysApproveSource(),
      eventSink: new CapturingSink(),
    });
    expect(engine.evaluate({ ...baseRequest, risk: "read" })).toBe("allow");
    expect(engine.evaluate({ ...baseRequest, risk: "write" })).toBe("ask");
    expect(engine.evaluate({ ...baseRequest, risk: "execute" })).toBe("ask");
    expect(engine.evaluate({ ...baseRequest, risk: "network" })).toBe("ask");
  });

  it("byTool override wins over byRisk default", () => {
    const policy: PermissionPolicy = {
      byTool: { dangerous_tool: "deny" },
      byRisk: { execute: "ask" },
      defaultDecision: "ask",
    };
    const engine = new PermissionEngine({
      policy,
      approvalSource: alwaysApproveSource(),
      eventSink: new CapturingSink(),
    });
    expect(engine.evaluate({ toolName: "dangerous_tool", risk: "execute", reason: "" })).toBe(
      "deny",
    );
    expect(engine.evaluate({ toolName: "other_tool", risk: "execute", reason: "" })).toBe("ask");
  });

  it("falls back to defaultDecision when neither byTool nor byRisk match", () => {
    const policy: PermissionPolicy = {
      byTool: {},
      byRisk: {},
      defaultDecision: "deny",
    };
    const engine = new PermissionEngine({
      policy,
      approvalSource: alwaysApproveSource(),
      eventSink: new CapturingSink(),
    });
    expect(engine.evaluate({ toolName: "x", risk: "read", reason: "" })).toBe("deny");
  });

  it("falls back to 'ask' when defaultDecision is unset", () => {
    const engine = new PermissionEngine({
      policy: {},
      approvalSource: alwaysApproveSource(),
      eventSink: new CapturingSink(),
    });
    expect(engine.evaluate({ toolName: "x", risk: "read", reason: "" })).toBe("ask");
  });

  it("exposes the canonical DEFAULT_POLICY for documentation", () => {
    expect(DEFAULT_POLICY.byRisk?.read).toBe("allow");
    expect(DEFAULT_POLICY.byRisk?.write).toBe("ask");
    expect(DEFAULT_POLICY.defaultDecision).toBe("ask");
  });
});

describe("PermissionEngine — requestPermission lifecycle + event emission", () => {
  it("allow-by-policy: emits requested + resolved with source=policy and outcome=allowed", async () => {
    const sink = new CapturingSink();
    const engine = new PermissionEngine({
      approvalSource: alwaysApproveSource(),
      eventSink: sink,
    });
    const res = await engine.requestPermission({ ...baseRequest, risk: "read" });
    expect(res.outcome).toBe("allowed");
    expect(res.source).toBe("policy");
    expect(res.decision).toBe("allow");

    expect(sink.events).toHaveLength(2);
    const [req, resolved] = sink.events;
    expect(req.type).toBe("tool.permission_requested");
    expect(resolved.type).toBe("tool.permission_resolved");
    expect(req.payload.requestId).toBe(resolved.payload.requestId);
    expect((req.payload as { decision: string }).decision).toBe("allow");
    expect((resolved.payload as { outcome: string }).outcome).toBe("allowed");
    expect((resolved.payload as { source: string }).source).toBe("policy");
  });

  it("deny-by-policy: emits requested + resolved with source=policy and outcome=denied", async () => {
    const sink = new CapturingSink();
    const engine = new PermissionEngine({
      policy: {
        byRisk: { execute: "deny" },
        defaultDecision: "ask",
      },
      approvalSource: alwaysApproveSource(),
      eventSink: sink,
    });
    const res = await engine.requestPermission({ ...baseRequest, risk: "execute" });
    expect(res.outcome).toBe("denied");
    expect(res.source).toBe("policy");
    expect(res.decision).toBe("deny");
  });

  it("ask + user approves: source=user, outcome=allowed", async () => {
    const sink = new CapturingSink();
    const engine = new PermissionEngine({
      approvalSource: alwaysApproveSource("looks safe"),
      eventSink: sink,
    });
    const res = await engine.requestPermission({ ...baseRequest, risk: "write" });
    expect(res.decision).toBe("ask");
    expect(res.outcome).toBe("allowed");
    expect(res.source).toBe("user");
    expect(res.reason).toBe("looks safe");

    const resolved = sink.events.at(-1);
    expect((resolved?.payload as { source: string }).source).toBe("user");
    expect((resolved?.payload as { reason?: string }).reason).toBe("looks safe");
  });

  it("ask + user denies: source=user, outcome=denied", async () => {
    const sink = new CapturingSink();
    const engine = new PermissionEngine({
      approvalSource: alwaysDenySource("seems risky"),
      eventSink: sink,
    });
    const res = await engine.requestPermission({ ...baseRequest, risk: "execute" });
    expect(res.outcome).toBe("denied");
    expect(res.source).toBe("user");
    expect(res.reason).toBe("seems risky");
  });

  it("ask flow: aborted signal short-circuits to denied with source=policy reason=cancelled", async () => {
    const sink = new CapturingSink();
    const engine = new PermissionEngine({
      // Deliberately slow source; the abort should beat it.
      approvalSource: () =>
        new Promise((resolve) => setTimeout(() => resolve({ outcome: "allowed" }), 1_000)),
      eventSink: sink,
    });
    const ac = new AbortController();
    ac.abort();
    const res = await engine.requestPermission({ ...baseRequest, risk: "execute" }, ac.signal);
    expect(res.outcome).toBe("denied");
    expect(res.source).toBe("policy");
    expect(res.reason).toBe("cancelled");
  });

  it("threads toolCallId + argsPreview through both events", async () => {
    const sink = new CapturingSink();
    const engine = new PermissionEngine({
      approvalSource: alwaysApproveSource(),
      eventSink: sink,
    });
    await engine.requestPermission({
      toolName: "read_file",
      risk: "read",
      reason: "x",
      toolCallId: "tc_42",
      argsPreview: "path=/etc/hosts",
    });
    expect((sink.events[0].payload as { toolCallId?: string }).toolCallId).toBe("tc_42");
    expect((sink.events[0].payload as { argsPreview?: string }).argsPreview).toBe(
      "path=/etc/hosts",
    );
    expect((sink.events[1].payload as { toolCallId?: string }).toolCallId).toBe("tc_42");
  });

  it("requestId is unique per call and shared between requested + resolved", async () => {
    const sink = new CapturingSink();
    const engine = new PermissionEngine({
      approvalSource: alwaysApproveSource(),
      eventSink: sink,
    });
    await engine.requestPermission({ ...baseRequest, risk: "read" });
    await engine.requestPermission({ ...baseRequest, risk: "read" });
    expect(sink.events).toHaveLength(4);
    expect(sink.events[0].payload.requestId).toBe(sink.events[1].payload.requestId);
    expect(sink.events[2].payload.requestId).toBe(sink.events[3].payload.requestId);
    expect(sink.events[0].payload.requestId).not.toBe(sink.events[2].payload.requestId);
  });

  it("approvalSource is NOT called for allow-by-policy decisions", async () => {
    let called = false;
    const engine = new PermissionEngine({
      approvalSource: () => {
        called = true;
        return Promise.resolve({ outcome: "allowed" });
      },
      eventSink: new CapturingSink(),
    });
    await engine.requestPermission({ ...baseRequest, risk: "read" });
    expect(called).toBe(false);
  });

  it("approvalSource IS called for ask decisions", async () => {
    let called = false;
    const engine = new PermissionEngine({
      approvalSource: () => {
        called = true;
        return Promise.resolve({ outcome: "denied" });
      },
      eventSink: new CapturingSink(),
    });
    await engine.requestPermission({ ...baseRequest, risk: "execute" });
    expect(called).toBe(true);
  });
});

describe("classifyPermission — legacy one-shot helper", () => {
  it("allows read-only actions by default", () => {
    expect(classifyPermission({ toolName: "read_file", risk: "read", reason: "x" })).toBe("allow");
  });

  it("asks before write or execute actions by default", () => {
    expect(classifyPermission({ toolName: "shell", risk: "execute", reason: "x" })).toBe("ask");
  });
});
