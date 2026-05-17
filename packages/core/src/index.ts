import type { AgentEvent } from "@custom-agent/schema";

export type SessionEngineOptions = {
  readonly now?: () => Date;
  readonly createId?: (prefix: string) => string;
};

export type RunTurnInput = {
  readonly sessionId: string;
  readonly cwd: string;
  readonly prompt: string;
};

export class SessionEngine {
  private readonly now: () => Date;
  private readonly createId: (prefix: string) => string;

  constructor(options: SessionEngineOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? ((prefix) => `${prefix}_${crypto.randomUUID()}`);
  }

  createSession(cwd: string): AgentEvent {
    return {
      id: this.createId("evt"),
      schemaVersion: 1,
      sessionId: this.createId("sess"),
      sequence: 1,
      timestamp: this.now().toISOString(),
      type: "session.created",
      payload: {
        cwd,
        client: "test",
      },
    };
  }

  runFakeTurn(input: RunTurnInput): AgentEvent[] {
    const turnId = this.createId("turn");
    const timestamp = this.now().toISOString();

    return [
      {
        id: this.createId("evt"),
        schemaVersion: 1,
        sessionId: input.sessionId,
        turnId,
        sequence: 2,
        timestamp,
        type: "turn.started",
        payload: {
          promptPreview: input.prompt.slice(0, 80),
        },
      },
      {
        id: this.createId("evt"),
        schemaVersion: 1,
        sessionId: input.sessionId,
        turnId,
        sequence: 3,
        timestamp,
        type: "user.message",
        payload: {
          content: input.prompt,
        },
      },
      {
        id: this.createId("evt"),
        schemaVersion: 1,
        sessionId: input.sessionId,
        turnId,
        sequence: 4,
        timestamp,
        type: "model.delta",
        payload: {
          text: "Custom Agent project spine is ready.",
        },
      },
      {
        id: this.createId("evt"),
        schemaVersion: 1,
        sessionId: input.sessionId,
        turnId,
        sequence: 5,
        timestamp,
        type: "turn.completed",
        payload: {
          stopReason: "final",
        },
      },
    ];
  }
}
