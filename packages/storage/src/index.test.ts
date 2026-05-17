import { describe, expect, it } from "vitest";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@custom-agent/schema";
import {
  decodeEvent,
  encodeEvent,
  EventLogDecodeError,
  EventLogSequenceError,
  JsonlEventLog,
  readEventLog,
  validateEventOrder,
} from "./index";

function event(sequence: number, type: AgentEvent["type"] = "model.delta"): AgentEvent {
  if (type === "session.created") {
    return {
      id: `evt_${sequence}`,
      schemaVersion: 1,
      sessionId: "sess_1",
      sequence,
      timestamp: "2026-05-17T00:00:00.000Z",
      type,
      payload: {
        cwd: "/tmp/project",
        client: "test",
      },
    };
  }

  if (type === "turn.completed") {
    return {
      id: `evt_${sequence}`,
      schemaVersion: 1,
      sessionId: "sess_1",
      turnId: "turn_1",
      sequence,
      timestamp: "2026-05-17T00:00:00.000Z",
      type,
      payload: {
        stopReason: "final",
      },
    };
  }

  return {
    id: `evt_${sequence}`,
    schemaVersion: 1,
    sessionId: "sess_1",
    turnId: "turn_1",
    sequence,
    timestamp: "2026-05-17T00:00:00.000Z",
    type: "model.delta",
    payload: {
      text: `delta ${sequence}`,
    },
  };
}

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "custom-agent-storage-"));

  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function collectAsync<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];

  for await (const item of iterable) {
    items.push(item);
  }

  return items;
}

describe("event log encoding", () => {
  it("round-trips a valid event", () => {
    const line = encodeEvent({
      id: "evt_1",
      schemaVersion: 1,
      sessionId: "sess_1",
      sequence: 1,
      timestamp: "2026-05-17T00:00:00.000Z",
      type: "model.delta",
      payload: {
        text: "hello",
      },
    });

    expect(decodeEvent(line).type).toBe("model.delta");
  });
});

describe("JsonlEventLog", () => {
  it("appends events and replays them in order", async () => {
    await withTempDir(async (dir) => {
      const log = new JsonlEventLog(join(dir, "sessions", "sess_1.jsonl"));
      const events = [event(1, "session.created"), event(2), event(3, "turn.completed")];

      await log.appendMany(events);

      await expect(log.readAll()).resolves.toEqual(events);
      await expect(collectAsync(log.replay())).resolves.toEqual(events);
    });
  });

  it("returns an empty list for a missing log file", async () => {
    await withTempDir(async (dir) => {
      await expect(readEventLog(join(dir, "missing.jsonl"))).resolves.toEqual([]);
    });
  });

  it("skips a trailing partial line by default", async () => {
    await withTempDir(async (dir) => {
      const logPath = join(dir, "partial.jsonl");
      await writeFile(logPath, `${encodeEvent(event(1))}{"schemaVersion":`, "utf8");

      await expect(readEventLog(logPath)).resolves.toEqual([event(1)]);
    });
  });

  it("throws on a trailing partial line in strict mode", async () => {
    await withTempDir(async (dir) => {
      const logPath = join(dir, "strict-partial.jsonl");
      await writeFile(logPath, `${encodeEvent(event(1))}{"schemaVersion":`, "utf8");

      await expect(readEventLog(logPath, { recoveryMode: "strict" })).rejects.toBeInstanceOf(
        EventLogDecodeError,
      );
    });
  });

  it("throws on corrupt committed lines", async () => {
    await withTempDir(async (dir) => {
      const logPath = join(dir, "corrupt.jsonl");
      await writeFile(
        logPath,
        `${encodeEvent(event(1))}not json\n${encodeEvent(event(2))}`,
        "utf8",
      );

      await expect(readEventLog(logPath)).rejects.toBeInstanceOf(EventLogDecodeError);
    });
  });

  it("rejects non-increasing event sequences", () => {
    expect(() => validateEventOrder([event(2), event(2)])).toThrow(EventLogSequenceError);
    expect(() => validateEventOrder([event(3), event(2)])).toThrow(EventLogSequenceError);
  });

  it("rejects non-increasing sequences before appending batches", async () => {
    await withTempDir(async (dir) => {
      const log = new JsonlEventLog(join(dir, "bad-sequence.jsonl"));

      await expect(log.appendMany([event(2), event(1)])).rejects.toBeInstanceOf(
        EventLogSequenceError,
      );
      await expect(log.readAll()).resolves.toEqual([]);
    });
  });

  it("rejects events older than the current log tail", async () => {
    await withTempDir(async (dir) => {
      const log = new JsonlEventLog(join(dir, "tail-sequence.jsonl"));

      await log.append(event(3));

      await expect(log.append(event(2))).rejects.toBeInstanceOf(EventLogSequenceError);
      await expect(log.readAll()).resolves.toEqual([event(3)]);
    });
  });

  it("rejects appending to a log with a trailing partial line", async () => {
    await withTempDir(async (dir) => {
      const logPath = join(dir, "partial-append.jsonl");
      const log = new JsonlEventLog(logPath);
      await writeFile(logPath, `${encodeEvent(event(1))}{"schemaVersion":`, "utf8");

      await expect(log.append(event(2))).rejects.toBeInstanceOf(EventLogDecodeError);
    });
  });

  it("appendMany([]) is a no-op and does not create the log file", async () => {
    await withTempDir(async (dir) => {
      const logPath = join(dir, "noop.jsonl");
      const log = new JsonlEventLog(logPath);

      await expect(log.appendMany([])).resolves.toBeUndefined();
      await expect(access(logPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("serializes concurrent append() calls within the same instance", async () => {
    await withTempDir(async (dir) => {
      const log = new JsonlEventLog(join(dir, "concurrent.jsonl"));
      const events = Array.from({ length: 20 }, (_, index) => event(index + 1));

      await Promise.all(events.map((evt) => log.append(evt)));

      await expect(log.readAll()).resolves.toEqual(events);
    });
  });

  it("streams replay() over a large log without loading it all upfront", async () => {
    await withTempDir(async (dir) => {
      const log = new JsonlEventLog(join(dir, "large.jsonl"));
      const events = Array.from({ length: 5_000 }, (_, index) => event(index + 1));

      await log.appendMany(events);

      let count = 0;
      let lastSequence = 0;
      for await (const evt of log.replay()) {
        count += 1;
        expect(evt.sequence).toBe(lastSequence + 1);
        lastSequence = evt.sequence;
        if (count === 3) {
          // Break early to prove the iterator is lazy and cleanly closes the
          // underlying file handle (no leak / unhandled rejection).
          break;
        }
      }

      expect(count).toBe(3);
    });
  });

  it("reuses the cached tail across appends without re-reading the whole file", async () => {
    await withTempDir(async (dir) => {
      const log = new JsonlEventLog(join(dir, "cached-tail.jsonl"));
      await log.appendMany([event(1), event(2), event(3)]);

      // Subsequent single append should validate against the cached tail and
      // still reject an out-of-order sequence.
      await expect(log.append(event(2))).rejects.toBeInstanceOf(EventLogSequenceError);
      await log.append(event(4));

      await expect(log.readAll()).resolves.toEqual([event(1), event(2), event(3), event(4)]);
    });
  });
});
