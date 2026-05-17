import type { AgentEvent } from "@custom-agent/schema";
import type { EventStore } from "./ports/event-store";
import type { ModelProvider } from "./ports/model-provider";

// SessionEngine drives the turn state machine described in
// custom-agent-docs/docs/zh/handbook/layers/agent-core.md.
//
// State: idle -> running -> (completed | cancelled | failed)
// M1-03 path: turn.started -> user.message -> model.delta x N -> turn.completed
//
// Invariants:
//   - events are persisted via eventStore.append BEFORE being yielded to
//     consumers (durable-then-visible);
//   - sequence numbers are strictly increasing per session;
//   - cancellation is idempotent and surfaces via stopReason="cancelled" on
//     turn.completed (no separate turn.cancelled event type for M1).

export type SessionClient = "web" | "cli" | "acp" | "test";

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
  };
};

type StopReason = "final" | "cancelled" | "error";

export class SessionEngine {
  private readonly eventStore: EventStore;
  private readonly provider: ModelProvider;
  private readonly now: () => Date;
  private readonly createId: (prefix: string) => string;
  private readonly sessions = new Map<string, SessionState>();

  constructor(deps: SessionEngineDeps) {
    this.eventStore = deps.eventStore;
    this.provider = deps.provider;
    this.now = deps.now ?? (() => new Date());
    this.createId = deps.createId ?? ((prefix) => `${prefix}_${crypto.randomUUID()}`);
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

    await this.eventStore.append(sessionId, event);

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
    state.currentTurn = { turnId, controller };

    let stopReason: StopReason = "final";

    try {
      yield await this.emitTurnStarted(state, turnId, input.userMessage);
      yield await this.emitUserMessage(state, turnId, input.userMessage);

      // Stream model deltas inline so consumers can call cancelTurn between
      // any two yields. Accumulating into an array first would defeat that.
      try {
        const request = {
          modelId: this.provider.id,
          messages: [{ role: "user" as const, content: input.userMessage }],
        };
        for await (const chunk of this.provider.stream(request, signal)) {
          if (chunk.type === "text_delta") {
            yield await this.emitModelDelta(state, turnId, chunk.delta);
          } else if (chunk.type === "failed") {
            stopReason = signal.aborted ? "cancelled" : "error";
            break;
          }
          // "completed" just terminates the loop naturally.
        }

        if (signal.aborted && stopReason === "final") {
          stopReason = "cancelled";
        }
      } catch {
        stopReason = signal.aborted ? "cancelled" : "error";
      }

      yield await this.emitTurnCompleted(state, turnId, stopReason);
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

  // ---- private helpers ----

  private async emitTurnStarted(
    state: SessionState,
    turnId: string,
    userMessage: string,
  ): Promise<AgentEvent> {
    const event: AgentEvent = {
      id: this.createId("evt"),
      schemaVersion: 1,
      sessionId: state.sessionId,
      turnId,
      sequence: state.nextSequence,
      timestamp: this.now().toISOString(),
      type: "turn.started",
      payload: { promptPreview: userMessage.slice(0, 80) },
    };
    state.nextSequence += 1;
    await this.eventStore.append(state.sessionId, event);
    return event;
  }

  private async emitUserMessage(
    state: SessionState,
    turnId: string,
    userMessage: string,
  ): Promise<AgentEvent> {
    const event: AgentEvent = {
      id: this.createId("evt"),
      schemaVersion: 1,
      sessionId: state.sessionId,
      turnId,
      sequence: state.nextSequence,
      timestamp: this.now().toISOString(),
      type: "user.message",
      payload: { content: userMessage },
    };
    state.nextSequence += 1;
    await this.eventStore.append(state.sessionId, event);
    return event;
  }

  private async emitModelDelta(
    state: SessionState,
    turnId: string,
    text: string,
  ): Promise<AgentEvent> {
    const event: AgentEvent = {
      id: this.createId("evt"),
      schemaVersion: 1,
      sessionId: state.sessionId,
      turnId,
      sequence: state.nextSequence,
      timestamp: this.now().toISOString(),
      type: "model.delta",
      payload: { text },
    };
    state.nextSequence += 1;
    await this.eventStore.append(state.sessionId, event);
    return event;
  }

  private async emitTurnCompleted(
    state: SessionState,
    turnId: string,
    stopReason: StopReason,
  ): Promise<AgentEvent> {
    const event: AgentEvent = {
      id: this.createId("evt"),
      schemaVersion: 1,
      sessionId: state.sessionId,
      turnId,
      sequence: state.nextSequence,
      timestamp: this.now().toISOString(),
      type: "turn.completed",
      payload: { stopReason },
    };
    state.nextSequence += 1;
    await this.eventStore.append(state.sessionId, event);
    return event;
  }
}

function mergeSignals(external: AbortSignal | undefined, internal: AbortSignal): AbortSignal {
  if (!external) {
    return internal;
  }
  return AbortSignal.any([external, internal]);
}
