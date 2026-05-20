import type {
  PermissionDecision,
  PermissionOutcome,
  PermissionOutcomeSource,
  ToolRisk,
} from "@custom-agent/schema";

// PermissionEngine (M3-01)
//
// Central gate for tool execution. M0 shipped a one-shot
// `classifyPermission` helper; M3-01 expands that to a full engine with:
//
//   1. A *policy matrix* — default decisions per (toolName | risk).
//   2. An *ask flow* — when the synchronous policy returns `ask`, the
//      engine consults an injected `ApprovalSource` (client / human /
//      future heuristic) and awaits a typed outcome.
//   3. *Event emission* — every request emits exactly two AgentEvents
//      via the injected `eventSink`:
//        - `tool.permission_requested` (always, captures decision + args)
//        - `tool.permission_resolved`  (after policy or ask resolves)
//      The audit log can reconstruct every tool intent BEFORE any
//      side effect runs.
//
// The engine does NOT execute tools; that's the M3-02+ ToolRouter's job.
// Tool routers MUST call `requestPermission(req)` and await the outcome
// before any side-effecting work. The signature returns Promise — even
// for `allow`-by-policy decisions — so the call site cannot accidentally
// bypass the engine by reading the synchronous decision and skipping the
// ask round-trip.
//
// Dependency direction is one-way: PermissionEngine depends only on
// `@custom-agent/schema` for AgentEvent shapes and the policy types
// defined there. Tool implementations depend on this package; this
// package never imports tool code (enforced by architecture-fitness).

export type PermissionPolicy = {
  /**
   * Per-tool override. Wins over `byRisk`.
   * Use sparingly — most tools should fall under the per-risk default.
   */
  readonly byTool?: Readonly<Record<string, PermissionDecision>>;
  /** Default decision for each risk tier; falls back to `defaultDecision`. */
  readonly byRisk?: Readonly<Partial<Record<ToolRisk, PermissionDecision>>>;
  /** Used when neither `byTool` nor `byRisk` matches. */
  readonly defaultDecision?: PermissionDecision;
};

/**
 * Production-default policy: read = allow, everything else = ask. Matches
 * M0's `classifyPermission` shape so existing callers keep working.
 */
export const DEFAULT_POLICY: PermissionPolicy = {
  byRisk: {
    read: "allow",
    write: "ask",
    execute: "ask",
    network: "ask",
  },
  defaultDecision: "ask",
};

export type PermissionRequest = {
  readonly toolName: string;
  readonly risk: ToolRisk;
  /** Human-readable reason the agent wants to run this. Surfaced to user in ask flow. */
  readonly reason: string;
  /** Optional ACP-style tool call id; recorded on events for cross-stream correlation. */
  readonly toolCallId?: string;
  /** Optional truncated args preview (rendered to user in ask flow). */
  readonly argsPreview?: string;
};

/**
 * Result of `requestPermission`. Always includes the synchronous
 * `decision` so the caller can distinguish "auto-allowed by policy" from
 * "user explicitly approved" — both have `outcome === "allowed"` but
 * different audit semantics.
 */
export type PermissionResolution = {
  readonly requestId: string;
  readonly decision: PermissionDecision;
  readonly outcome: PermissionOutcome;
  readonly source: PermissionOutcomeSource;
  readonly reason?: string;
};

/**
 * Injected source for resolving `ask` decisions. Real implementations:
 *   - ACP `request_permission` over the wire (M3 wires this in M3-02+).
 *   - CLI / TUI interactive prompt.
 *   - Pre-configured allowlist (returns `allowed` without involving user).
 */
export type ApprovalSource = (
  request: ResolvedAskRequest,
  signal: AbortSignal,
) => Promise<UserApproval>;

export type ResolvedAskRequest = PermissionRequest & {
  readonly requestId: string;
};

export type UserApproval = {
  readonly outcome: PermissionOutcome;
  readonly reason?: string;
};

/** Minimal event sink — engine emits AgentEvent-shaped objects through it. */
export type PermissionEventSink = {
  emit(event: PermissionEventInput): Promise<void>;
};

/**
 * Engine-emitted event shape BEFORE the EventStore stamps id / sequence /
 * timestamp. Kept narrow so tests / SessionEngine integration can wire it
 * to AgentEvent commit logic without depending on the storage layer.
 */
export type PermissionEventInput =
  | {
      readonly type: "tool.permission_requested";
      readonly payload: {
        requestId: string;
        toolCallId?: string;
        toolName: string;
        risk: ToolRisk;
        decision: PermissionDecision;
        reason: string;
        argsPreview?: string;
      };
    }
  | {
      readonly type: "tool.permission_resolved";
      readonly payload: {
        requestId: string;
        toolCallId?: string;
        toolName: string;
        outcome: PermissionOutcome;
        source: PermissionOutcomeSource;
        reason?: string;
      };
    };

export type PermissionEngineOptions = {
  readonly policy?: PermissionPolicy;
  readonly approvalSource: ApprovalSource;
  readonly eventSink: PermissionEventSink;
  /** Test injection: deterministic requestId generation. */
  readonly createRequestId?: () => string;
};

export class PermissionEngine {
  private readonly policy: PermissionPolicy;
  private readonly approvalSource: ApprovalSource;
  private readonly eventSink: PermissionEventSink;
  private readonly createRequestId: () => string;
  private nextRequestId = 1;

  constructor(opts: PermissionEngineOptions) {
    this.policy = opts.policy ?? DEFAULT_POLICY;
    this.approvalSource = opts.approvalSource;
    this.eventSink = opts.eventSink;
    this.createRequestId = opts.createRequestId ?? (() => `perm_${this.nextRequestId++}`);
  }

  /**
   * Pure policy evaluation. Returns the synchronous decision without
   * touching the approval source or the event sink. Exposed for
   * UI/diagnostic use; callers MUST still go through `requestPermission`
   * to commit events and resolve the outcome.
   */
  evaluate(request: PermissionRequest): PermissionDecision {
    const byTool = this.policy.byTool?.[request.toolName];
    if (byTool !== undefined) return byTool;
    const byRisk = this.policy.byRisk?.[request.risk];
    if (byRisk !== undefined) return byRisk;
    return this.policy.defaultDecision ?? "ask";
  }

  /**
   * End-to-end flow: emit `tool.permission_requested`, resolve via policy
   * or ask, emit `tool.permission_resolved`, return the resolution.
   *
   * `signal` is forwarded to the approval source so a turn cancellation
   * can short-circuit a pending ask. When the signal aborts before the
   * source returns, the engine resolves to `denied` with `source: "policy"`
   * and `reason: "cancelled"` — this matches the broader cancellation
   * semantic (any aborted intent ends as a non-action).
   */
  async requestPermission(
    request: PermissionRequest,
    signal: AbortSignal = neverAbort(),
  ): Promise<PermissionResolution> {
    const requestId = this.createRequestId();
    const decision = this.evaluate(request);

    await this.eventSink.emit({
      type: "tool.permission_requested",
      payload: {
        requestId,
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        risk: request.risk,
        decision,
        reason: request.reason,
        argsPreview: request.argsPreview,
      },
    });

    let outcome: PermissionOutcome;
    let source: PermissionOutcomeSource;
    let resolvedReason: string | undefined;

    if (decision === "allow") {
      outcome = "allowed";
      source = "policy";
    } else if (decision === "deny") {
      outcome = "denied";
      source = "policy";
    } else {
      // ask flow
      if (signal.aborted) {
        outcome = "denied";
        source = "policy";
        resolvedReason = "cancelled";
      } else {
        const approval = await this.approvalSource({ ...request, requestId }, signal);
        if (signal.aborted) {
          outcome = "denied";
          source = "policy";
          resolvedReason = "cancelled";
        } else {
          outcome = approval.outcome;
          source = "user";
          resolvedReason = approval.reason;
        }
      }
    }

    await this.eventSink.emit({
      type: "tool.permission_resolved",
      payload: {
        requestId,
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        outcome,
        source,
        reason: resolvedReason,
      },
    });

    return { requestId, decision, outcome, source, reason: resolvedReason };
  }
}

function neverAbort(): AbortSignal {
  return new AbortController().signal;
}

/**
 * Legacy one-shot helper kept for backwards-compat with M0 callers.
 * Prefer constructing a `PermissionEngine` so policy + event emission
 * + ask flow stay coherent.
 *
 * @deprecated Use `new PermissionEngine({...}).evaluate(request)` instead.
 */
export function classifyPermission(request: PermissionRequest): PermissionDecision {
  if (request.risk === "read") return "allow";
  return "ask";
}
