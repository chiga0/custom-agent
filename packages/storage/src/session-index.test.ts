import { describe, expect, it } from "vitest";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@custom-agent/schema";
import { JsonlEventLog, SessionIndex } from "./index";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "custom-agent-session-index-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

let nextSequence = 0;
function nextSeq(): number {
  nextSequence += 1;
  return nextSequence;
}

function sessionCreated(sessionId: string, cwd = "/tmp/project"): AgentEvent {
  return {
    id: `evt_${nextSeq()}`,
    schemaVersion: 1,
    sessionId,
    sequence: nextSeq(),
    timestamp: new Date(2026, 4, 17, 0, 0, nextSequence).toISOString(),
    type: "session.created",
    payload: { cwd, client: "test" },
  };
}

function turnStarted(sessionId: string, turnId: string): AgentEvent {
  return {
    id: `evt_${nextSeq()}`,
    schemaVersion: 1,
    sessionId,
    turnId,
    sequence: nextSeq(),
    timestamp: new Date(2026, 4, 17, 0, 0, nextSequence).toISOString(),
    type: "turn.started",
    payload: { promptPreview: "hello" },
  };
}

function modelDelta(sessionId: string, turnId: string, text = "delta"): AgentEvent {
  return {
    id: `evt_${nextSeq()}`,
    schemaVersion: 1,
    sessionId,
    turnId,
    sequence: nextSeq(),
    timestamp: new Date(2026, 4, 17, 0, 0, nextSequence).toISOString(),
    type: "model.delta",
    payload: { text },
  };
}

function turnCompleted(
  sessionId: string,
  turnId: string,
  stopReason: "final" | "cancelled" | "error" = "final",
): AgentEvent {
  return {
    id: `evt_${nextSeq()}`,
    schemaVersion: 1,
    sessionId,
    turnId,
    sequence: nextSeq(),
    timestamp: new Date(2026, 4, 17, 0, 0, nextSequence).toISOString(),
    type: "turn.completed",
    payload: { stopReason },
  };
}

function fullSession(sessionId: string, turnId: string): AgentEvent[] {
  return [
    sessionCreated(sessionId),
    turnStarted(sessionId, turnId),
    modelDelta(sessionId, turnId, "hi"),
    turnCompleted(sessionId, turnId),
  ];
}

describe("SessionIndex", () => {
  it("projects session and turn lifecycle from events", async () => {
    await withTempDir(async (dir) => {
      const index = new SessionIndex(join(dir, "index.db"));
      const events = fullSession("sess_a", "turn_a1");

      try {
        index.applyMany(events);

        const sessions = index.listSessions();
        expect(sessions).toHaveLength(1);
        expect(sessions[0]).toMatchObject({
          sessionId: "sess_a",
          cwd: "/tmp/project",
          client: "test",
          turnCount: 1,
        });
        expect(sessions[0].lastSequence).toBe(events.at(-1)!.sequence);
        expect(sessions[0].lastEventTimestamp).toBe(events.at(-1)!.timestamp);

        const turns = index.listTurns("sess_a");
        expect(turns).toHaveLength(1);
        expect(turns[0]).toMatchObject({
          turnId: "turn_a1",
          stopReason: "final",
        });
        expect(turns[0].startedAt).toBeDefined();
        expect(turns[0].completedAt).toBeDefined();
      } finally {
        index.close();
      }
    });
  });

  it("orders sessions by createdAt DESC and supports multiple sessions", async () => {
    await withTempDir(async (dir) => {
      const index = new SessionIndex(join(dir, "index.db"));
      try {
        index.applyMany(fullSession("sess_old", "turn_o1"));
        index.applyMany(fullSession("sess_new", "turn_n1"));

        const sessions = index.listSessions();
        expect(sessions.map((s) => s.sessionId)).toEqual(["sess_new", "sess_old"]);
      } finally {
        index.close();
      }
    });
  });

  it("returns undefined for an unknown session and empty turns list", async () => {
    await withTempDir(async (dir) => {
      const index = new SessionIndex(join(dir, "index.db"));
      try {
        expect(index.getSession("missing")).toBeUndefined();
        expect(index.listTurns("missing")).toEqual([]);
      } finally {
        index.close();
      }
    });
  });

  it("rebuilds from JSONL after the index DB is deleted", async () => {
    await withTempDir(async (dir) => {
      const sessionsDir = join(dir, "sessions");
      const dbPath = join(dir, "index.db");

      const logA = new JsonlEventLog(join(sessionsDir, "sess_a.jsonl"));
      const eventsA = fullSession("sess_a", "turn_a1");
      await logA.appendMany(eventsA);

      const logB = new JsonlEventLog(join(sessionsDir, "sess_b.jsonl"));
      const eventsB = fullSession("sess_b", "turn_b1");
      await logB.appendMany(eventsB);

      const indexBefore = new SessionIndex(dbPath);
      try {
        indexBefore.applyMany(eventsA);
        indexBefore.applyMany(eventsB);
        const beforeSessions = indexBefore.listSessions();
        expect(beforeSessions.map((s) => s.sessionId).sort()).toEqual(["sess_a", "sess_b"]);
      } finally {
        indexBefore.close();
      }

      await unlink(dbPath);

      const indexAfter = new SessionIndex(dbPath);
      try {
        await indexAfter.rebuildFromEventLogs(sessionsDir);
        const afterSessions = indexAfter.listSessions();

        expect(afterSessions.map((s) => s.sessionId).sort()).toEqual(["sess_a", "sess_b"]);
        for (const sessionId of ["sess_a", "sess_b"]) {
          const session = indexAfter.getSession(sessionId)!;
          expect(session.turnCount).toBe(1);
          const turns = indexAfter.listTurns(sessionId);
          expect(turns).toHaveLength(1);
          expect(turns[0].stopReason).toBe("final");
        }
      } finally {
        indexAfter.close();
      }
    });
  });

  it("rebuild on a missing event log root yields an empty index", async () => {
    await withTempDir(async (dir) => {
      const index = new SessionIndex(join(dir, "index.db"));
      try {
        await index.rebuildFromEventLogs(join(dir, "no-such-dir"));
        expect(index.listSessions()).toEqual([]);
      } finally {
        index.close();
      }
    });
  });

  it("rebuild clears stale rows that no longer have a corresponding event log", async () => {
    await withTempDir(async (dir) => {
      const sessionsDir = join(dir, "sessions");
      const dbPath = join(dir, "index.db");

      const eventsA = fullSession("sess_a", "turn_a1");
      const logA = new JsonlEventLog(join(sessionsDir, "sess_a.jsonl"));
      await logA.appendMany(eventsA);

      const index = new SessionIndex(dbPath);
      try {
        // Seed the index with a session whose log file does not exist on disk.
        index.applyMany(fullSession("sess_stale", "turn_s1"));
        expect(
          index
            .listSessions()
            .map((s) => s.sessionId)
            .sort(),
        ).toEqual(["sess_stale"]);

        await index.rebuildFromEventLogs(sessionsDir);
        expect(index.listSessions().map((s) => s.sessionId)).toEqual(["sess_a"]);
      } finally {
        index.close();
      }
    });
  });
});
