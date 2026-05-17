import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import Database, { type Database as DatabaseInstance } from "better-sqlite3";
import type { AgentEvent } from "@custom-agent/schema";
import { JsonlEventLog } from "./index";

// SQLite-backed projection of the JSONL event log. Maintains a session
// roster + per-session turn list so clients do not have to replay every
// event to render a session list.
//
// Authoritative source: the JSONL event logs. This file can be deleted at
// any time and rebuilt via rebuildFromEventLogs.
//
// Concurrency: better-sqlite3 calls are synchronous and the DB is owned by
// a single SessionIndex instance. Sharing across processes is unsupported.

export type SessionClient = "web" | "cli" | "acp" | "test";

export type SessionIndexRow = {
  sessionId: string;
  cwd: string;
  client: SessionClient;
  createdAt: string;
  lastSequence: number;
  lastEventTimestamp: string;
  turnCount: number;
};

export type TurnIndexRow = {
  sessionId: string;
  turnId: string;
  startedAt: string | undefined;
  completedAt: string | undefined;
  stopReason: "final" | "cancelled" | "error" | undefined;
};

type SessionRow = {
  session_id: string;
  cwd: string;
  client: string;
  created_at: string;
  last_sequence: number;
  last_event_timestamp: string;
  turn_count: number;
};

type TurnRow = {
  session_id: string;
  turn_id: string;
  started_at: string | null;
  completed_at: string | null;
  stop_reason: string | null;
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    cwd TEXT NOT NULL,
    client TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_sequence INTEGER NOT NULL,
    last_event_timestamp TEXT NOT NULL,
    turn_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS turns (
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    stop_reason TEXT,
    PRIMARY KEY (session_id, turn_id)
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
`;

export class SessionIndex {
  private readonly db: DatabaseInstance;

  constructor(readonly dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  apply(event: AgentEvent): void {
    this.applyInternal(event);
  }

  applyMany(events: readonly AgentEvent[]): void {
    const tx = this.db.transaction((batch: readonly AgentEvent[]) => {
      for (const event of batch) {
        this.applyInternal(event);
      }
    });
    tx(events);
  }

  listSessions(): SessionIndexRow[] {
    const rows = this.db
      .prepare<[], SessionRow>("SELECT * FROM sessions ORDER BY created_at DESC, session_id ASC")
      .all();
    return rows.map(toSessionRow);
  }

  getSession(sessionId: string): SessionIndexRow | undefined {
    const row = this.db
      .prepare<[string], SessionRow>("SELECT * FROM sessions WHERE session_id = ?")
      .get(sessionId);
    return row ? toSessionRow(row) : undefined;
  }

  listTurns(sessionId: string): TurnIndexRow[] {
    const rows = this.db
      .prepare<
        [string],
        TurnRow
      >("SELECT * FROM turns WHERE session_id = ? ORDER BY started_at IS NULL, started_at ASC, turn_id ASC")
      .all(sessionId);
    return rows.map(toTurnRow);
  }

  async rebuildFromEventLogs(rootDir: string): Promise<void> {
    this.reset();

    const files = await collectJsonlFiles(rootDir);
    if (files.length === 0) {
      return;
    }

    // Stream each log under a single transaction to avoid per-event commit
    // overhead. better-sqlite3 transactions are sync, but apply() itself only
    // issues sync queries inside the loop body, so wrapping async iteration
    // this way is safe.
    this.db.exec("BEGIN");
    try {
      for (const file of files) {
        const log = new JsonlEventLog(file);
        for await (const event of log.replay()) {
          this.applyInternal(event);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  reset(): void {
    this.db.exec("DELETE FROM turns; DELETE FROM sessions;");
  }

  close(): void {
    this.db.close();
  }

  private applyInternal(event: AgentEvent): void {
    switch (event.type) {
      case "session.created":
        this.upsertSessionCreated(event);
        break;
      case "turn.started":
        this.upsertTurnStarted(event);
        break;
      case "turn.completed":
        this.upsertTurnCompleted(event);
        break;
      case "user.message":
      case "model.delta":
        // No turn-table mutation; tail bookkeeping happens below.
        break;
    }

    this.touchSessionTail(event);
  }

  private upsertSessionCreated(event: AgentEvent & { type: "session.created" }): void {
    this.db
      .prepare(
        `INSERT INTO sessions (
           session_id, cwd, client, created_at,
           last_sequence, last_event_timestamp, turn_count
         )
         VALUES (?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(session_id) DO UPDATE SET
           cwd = excluded.cwd,
           client = excluded.client,
           created_at = excluded.created_at`,
      )
      .run(
        event.sessionId,
        event.payload.cwd,
        event.payload.client,
        event.timestamp,
        event.sequence,
        event.timestamp,
      );
  }

  private upsertTurnStarted(event: AgentEvent & { type: "turn.started" }): void {
    const turnId = event.turnId;
    if (!turnId) return;

    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO turns (session_id, turn_id, started_at)
         VALUES (?, ?, ?)`,
      )
      .run(event.sessionId, turnId, event.timestamp);

    if (result.changes > 0) {
      this.incrementTurnCount(event.sessionId);
    } else {
      this.db
        .prepare(
          `UPDATE turns
              SET started_at = COALESCE(started_at, ?)
            WHERE session_id = ? AND turn_id = ?`,
        )
        .run(event.timestamp, event.sessionId, turnId);
    }
  }

  private upsertTurnCompleted(event: AgentEvent & { type: "turn.completed" }): void {
    const turnId = event.turnId;
    if (!turnId) return;

    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO turns (session_id, turn_id, completed_at, stop_reason)
         VALUES (?, ?, ?, ?)`,
      )
      .run(event.sessionId, turnId, event.timestamp, event.payload.stopReason);

    if (result.changes > 0) {
      // turn.completed observed before turn.started — still count it.
      this.incrementTurnCount(event.sessionId);
    } else {
      this.db
        .prepare(
          `UPDATE turns
              SET completed_at = ?, stop_reason = ?
            WHERE session_id = ? AND turn_id = ?`,
        )
        .run(event.timestamp, event.payload.stopReason, event.sessionId, turnId);
    }
  }

  private incrementTurnCount(sessionId: string): void {
    this.db
      .prepare("UPDATE sessions SET turn_count = turn_count + 1 WHERE session_id = ?")
      .run(sessionId);
  }

  private touchSessionTail(event: AgentEvent): void {
    this.db
      .prepare(
        `UPDATE sessions
            SET last_sequence = ?, last_event_timestamp = ?
          WHERE session_id = ?`,
      )
      .run(event.sequence, event.timestamp, event.sessionId);
  }
}

function toSessionRow(row: SessionRow): SessionIndexRow {
  return {
    sessionId: row.session_id,
    cwd: row.cwd,
    client: row.client as SessionClient,
    createdAt: row.created_at,
    lastSequence: row.last_sequence,
    lastEventTimestamp: row.last_event_timestamp,
    turnCount: row.turn_count,
  };
}

function toTurnRow(row: TurnRow): TurnIndexRow {
  return {
    sessionId: row.session_id,
    turnId: row.turn_id,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    stopReason: (row.stop_reason as TurnIndexRow["stopReason"]) ?? undefined,
  };
}

async function collectJsonlFiles(rootDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(rootDir, { recursive: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return entries
    .filter((entry) => entry.endsWith(".jsonl"))
    .map((entry) => join(rootDir, entry))
    .sort((left, right) => relative(rootDir, left).localeCompare(relative(rootDir, right)));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
