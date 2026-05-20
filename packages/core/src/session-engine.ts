import type { AgentEvent, TurnErrorCode } from "@custom-agent/schema";
import type { EventStore } from "./ports/event-store";
import type { ModelMessage, ModelToolDefinition, ModelProvider } from "./ports/model-provider";
import type { ToolCallHandlerFactory } from "./ports/tool-call-handler";
import { ProviderError, toTurnErrorCode } from "./ports/provider-error";

// SessionEngine drives the turn state machine described in
// custom-agent-docs/docs/zh/handbook/layers/agent-core.md.
//
// State: idle -> running -> (completed | cancelled | failed)
// M1-03 path: turn.started -> user.message -> model.delta x N -> turn.completed
//
// Invariants:
//   - events are persisted via eventStore.append BEFORE being yielded to
//     consumers (durable-then-visible);
//   - sequence numbers are strictly increasing per session AND never have
//     gaps — sequence is reserved at the call site and only committed once
//     eventStore.append resolves successfully;
//   - cancellation is idempotent and surfaces via stopReason="cancelled" on
//     turn.completed (no separate turn.cancelled event type for M1);
//   - provider failures and infrastructure (event-store) failures are
//     surfaced through different paths: provider failure -> stopReason=
//     "error"; event-store failure aborts the turn and propagates as
//     EventStoreFailure so the caller can decide whether to retry.

export type SessionClient = "web" | "cli" | "acp" | "test";

export type TurnState = "idle" | "running" | "completed" | "cancelled" | "failed";

export type TurnTransition = {
  readonly from: TurnState;
  readonly to: TurnState;
  readonly reason: string;
};

export type CreateSessionInput = {
  readonly cwd: string;
  readonly client: SessionClient;
};

export type Session = {
  readonly sessionId: string;
  readonly cwd: string;
  readonly client: SessionClient;
  readonly createdAt: string;
};

export type RunTurnInput = {
  readonly sessionId: string;
  readonly userMessage: string;
  readonly signal?: AbortSignal;
};

export type CancelTurnInput = {
  readonly sessionId: string;
  readonly turnId?: string;
};

export type ReplaySessionInput = {
  readonly sessionId: string;
};

export type SessionEngineDeps = {
  readonly eventStore: EventStore;
  readonly provider: ModelProvider;
  readonly now?: () => Date;
  readonly createId?: (prefix: string) => string;
  readonly makeToolHandler?: ToolCallHandlerFactory;
};

type SessionState = {
  sessionId: string;
  cwd: string;
  client: SessionClient;
  createdAt: string;
  nextSequence: number;
  currentTurn?: {
    turnId: string;
    controller: AbortController;
    fsm: TurnFsm;
  };
};

type StopReason = "final" | "cancelled" | "error";

export class EventStoreFailure extends Error {
  constructor(
    message: string,
    readonly sessionId: string,
    readonly cause: unknown,
  ) {
    super(message);
    this.name = "EventStoreFailure";
  }
}

// Encapsulates the turn state machine. Every transition goes through
// `transition()` which asserts legality and appends to the history. The
// recorded history is exposed for tests / observability.
class TurnFsm {
  private current: TurnState = "idle";
  readonly history: TurnTransition[] = [];

  get state(): TurnState {
    return this.current;
  }

  transition(to: TurnState, reason: string): void {
    if (!LEGAL_TRANSITIONS[this.current].has(to)) {
      throw new Error(`Illegal turn transition: ${this.current} -> ${to} (${reason})`);
    }
    this.history.push({ from: this.current, to, reason });
    this.current = to;
  }
}

const LEGAL_TRANSITIONS: Record<TurnState, ReadonlySet<TurnState>> = {
  idle: new Set(["running"]),
  running: new Set(["completed", "cancelled", "failed"]),
  completed: new Set(),
  cancelled: new Set(),
  failed: new Set(),
};

export class SessionEngine {
  private readonly eventStore: EventStore;
  private readonly provider: ModelProvider;
  private readonly now: () => Date;
  private readonly createId: (prefix: string) => string;
  private readonly makeToolHandler: ToolCallHandlerFactory | undefined;
  private readonly sessions = new Map<string, SessionState>();

  constructor(deps: SessionEngineDeps) {
    this.eventStore = deps.eventStore;
    this.provider = deps.provider;
    this.now = deps.now ?? (() => new Date());
    this.createId = deps.createId ?? ((prefix) => `${prefix}_${crypto.randomUUID()}`);
    this.makeToolHandler = deps.makeToolHandler;
  }

  async createSession(input: CreateSessionInput): Promise<Session> {
    const sessionId = this.createId("sess");
    const createdAt = this.now().toISOString();

    const event: AgentEvent = {
      id: this.createId("evt"),
      schemaVersion: 1,
      sessionId,
      sequence: 1,
      timestamp: createdAt,
      type: "session.created",
      payload: { cwd: input.cwd, client: input.client },
    };

    await this.appendOrFail(sessionId, event);

    this.sessions.set(sessionId, {
      sessionId,
      cwd: input.cwd,
      client: input.client,
      createdAt,
      nextSequence: 2,
    });

    return {
      sessionId,
      cwd: input.cwd,
      client: input.client,
      createdAt,
    };
  }

  async *runTurn(input: RunTurnInput): AsyncIterable<AgentEvent> {
    const state = this.sessions.get(input.sessionId);
    if (!state) {
      throw new Error(`Unknown session: ${input.sessionId}`);
    }
    if (state.currentTurn) {
      throw new Error(`Session ${input.sessionId} already has an active turn`);
    }

    const turnId = this.createId("turn");
    const controller = new AbortController();
    const signal = mergeSignals(input.signal, controller.signal);
    const fsm = new TurnFsm();
    state.currentTurn = { turnId, controller, fsm };

    let stopReason: StopReason = "final";
    let errorCode: TurnErrorCode | undefined;

    try {
      fsm.transition("running", "turn.started");
      yield await this.emitTurnStarted(state, turnId, input.userMessage);
      yield await this.emitUserMessage(state, turnId, input.userMessage);

      const initialRequest = {
        modelId: this.provider.id,
        messages: [{ role: "user" as const, content: input.userMessage }],
      };

      const preflight = this.provider.preflightCheck(initialRequest);
      if (!preflight.ok) {
        stopReason = "error";
        errorCode = preflight.reason;
        fsm.transition(
          "failed",
          `turn.completed (stopReason=error, errorCode=${preflight.reason}, est=${preflight.estimatedTokens}, max=${preflight.maxContextTokens})`,
        );
        yield await this.emitTurnCompleted(state, turnId, stopReason, errorCode);
        return;
      }

      // Build tool handler for this turn (if tools are wired)
      const toolHandler = this.makeToolHandler
        ? this.makeToolHandler(
            async (partial: Pick<AgentEvent, "type" | "payload">): Promise<void> => {
              await this.commitEvent(state, { turnId, type: partial.type, payload: partial.payload } as Pick<AgentEvent, "turnId" | "type" | "payload">);
            },
            state.cwd,
            signal,
          )
        : undefined;

      const availableTools = toolHandler?.listTools() ?? [];

      let messages: ModelMessage[] = [
        { role: "user" as const, content: input.userMessage },
      ];

      toolLoop: while (true) {
        const request = {
          modelId: this.provider.id,
          messages,
          ...(availableTools.length > 0 && { tools: availableTools as ModelToolDefinition[] }),
        };

        const pendingToolCalls: Array<{ toolCallId: string; toolName: string; toolArgs: unknown }> = [];
        let assistantText = "";

        try {
          for await (const chunk of this.provider.stream(request, signal)) {
            if (signal.aborted) { stopReason = "cancelled"; break toolLoop; }
            if (chunk.type === "text_delta") {
              assistantText += chunk.delta;
              yield await this.emitModelDelta(state, turnId, chunk.delta);
            } else if (chunk.type === "tool_call_request") {
              pendingToolCalls.push({
                toolCallId: chunk.toolCallId,
                toolName: chunk.toolName,
                toolArgs: chunk.toolArgs,
              });
            } else if (chunk.type === "failed") {
              if (signal.aborted) { stopReason = "cancelled"; }
              else { stopReason = "error"; errorCode = "provider_failure"; }
              break toolLoop;
            }
            // "completed" just ends the inner for-await
          }
        } catch (error) {
          if (error instanceof EventStoreFailure) {
            stopReason = "error";
            fsm.transition("failed", `turn.completed (stopReason=error, cause=EventStoreFailure)`);
            try { yield await this.emitTurnCompleted(state, turnId, stopReason); } catch { /* swallow */ }
            throw error;
          }
          if (signal.aborted) { stopReason = "cancelled"; }
          else {
            stopReason = "error";
            errorCode = error instanceof ProviderError ? toTurnErrorCode(error) : "unknown";
          }
          break toolLoop;
        }

        if (signal.aborted && stopReason === "final") { stopReason = "cancelled"; break; }
        if (stopReason !== "final") break;
        if (pendingToolCalls.length === 0) break; // No tool calls → final text response

        if (!toolHandler) break; // No handler wired

        messages = [...messages, { role: "assistant" as const, content: assistantText }];

        for (const tc of pendingToolCalls) {
          if (signal.aborted) { stopReason = "cancelled"; break toolLoop; }
          const resultText = await toolHandler.handle(tc.toolCallId, tc.toolName, tc.toolArgs);
          messages = [
            ...messages,
            { role: "tool" as const, content: resultText, toolCallId: tc.toolCallId, toolName: tc.toolName },
          ];
        }
      }

      fsm.transition(stopReasonToState(stopReason), `turn.completed (stopReason=${stopReason})`);
      yield await this.emitTurnCompleted(state, turnId, stopReason, errorCode);
    } finally {
      state.currentTurn = undefined;
    }
  }

  async cancelTurn(input: CancelTurnInput): Promise<void> {
    const state = this.sessions.get(input.sessionId);
    if (!state || !state.currentTurn) {
      return;
    }
    if (input.turnId && state.currentTurn.turnId !== input.turnId) {
      return;
    }
    state.currentTurn.controller.abort();
  }

  async *replaySession(input: ReplaySessionInput): AsyncIterable<AgentEvent> {
    yield* this.eventStore.replay(input.sessionId);
  }

  /**
   * Test-only accessor: returns the immutable transition history of the
   * currently-active turn, or undefined when no turn is running.
   */
  getActiveTurnHistory(sessionId: string): TurnTransition[] | undefined {
    const turn = this.sessions.get(sessionId)?.currentTurn;
    return turn ? [...turn.fsm.history] : undefined;
  }

  // ---- private helpers ----

  private async emitTurnStarted(
    state: SessionState,
    turnId: string,
    userMessage: string,
  ): Promise<AgentEvent> {
    return this.commitEvent(state, {
      turnId,
      type: "turn.started",
      payload: { promptPreview: userMessage.slice(0, 80) },
    });
  }

  private async emitUserMessage(
    state: SessionState,
    turnId: string,
    userMessage: string,
  ): Promise<AgentEvent> {
    return this.commitEvent(state, {
      turnId,
      type: "user.message",
      payload: { content: userMessage },
    });
  }

  private async emitModelDelta(
    state: SessionState,
    turnId: string,
    text: string,
  ): Promise<AgentEvent> {
    return this.commitEvent(state, {
      turnId,
      type: "model.delta",
      payload: { text },
    });
  }

  private async emitTurnCompleted(
    state: SessionState,
    turnId: string,
    stopReason: StopReason,
    errorCode?: TurnErrorCode,
  ): Promise<AgentEvent> {
    // Only attach errorCode when stopReason is "error"; payload stays
    // backward-compatible for the M1 fixtures (final / cancelled paths
    // never had this field).
    const payload =
      stopReason === "error" && errorCode ? { stopReason, errorCode } : { stopReason };
    return this.commitEvent(state, {
      turnId,
      type: "turn.completed",
      payload,
    });
  }

  /**
   * Reserves a sequence number, persists the event, then commits the next
   * sequence ONLY on successful append. A failed append leaves the sequence
   * unchanged so the next attempt can reuse the same slot and the log never
   * has a numeric gap.
   */
  private async commitEvent(
    state: SessionState,
    partial: Pick<AgentEvent, "turnId" | "type" | "payload">,
  ): Promise<AgentEvent> {
    const sequence = state.nextSequence;
    const event = {
      id: this.createId("evt"),
      schemaVersion: 1 as const,
      sessionId: state.sessionId,
      turnId: partial.turnId,
      sequence,
      timestamp: this.now().toISOString(),
      type: partial.type,
      payload: partial.payload,
    } as AgentEvent;

    await this.appendOrFail(state.sessionId, event);
    state.nextSequence = sequence + 1;
    return event;
  }

  private async appendOrFail(sessionId: string, event: AgentEvent): Promise<void> {
    try {
      await this.eventStore.append(sessionId, event);
    } catch (error) {
      throw new EventStoreFailure(
        `EventStore.append failed for session ${sessionId} at sequence ${event.sequence}`,
        sessionId,
        error,
      );
    }
  }
}

function mergeSignals(external: AbortSignal | undefined, internal: AbortSignal): AbortSignal {
  if (!external) {
    return internal;
  }
  return AbortSignal.any([external, internal]);
}

function stopReasonToState(stopReason: StopReason): TurnState {
  switch (stopReason) {
    case "final":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "error":
      return "failed";
  }
}
