import { isAgentEvent, type AgentEvent } from "@custom-agent/schema";
import { appendFile, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";

export {
  SessionIndex,
  type SessionIndexRow,
  type TurnIndexRow,
  type SessionClient,
} from "./session-index";

// JSONL event log for an event-sourced session.
//
// Durability: writes go through fs.promises.appendFile without an explicit
// fsync. For the M1 MVP this trades crash-durability for simplicity; an
// fsync-on-commit pass is deferred to M9 hardening.
//
// Concurrency: a single JsonlEventLog instance serializes its own writes via
// an internal promise chain. Sharing a log file across multiple JsonlEventLog
// instances or across processes is unsupported.
//
// Trailing-partial recovery: readers default to `skip-trailing-partial`
// (tolerant). Writers always load the tail in `strict` mode, so an existing
// partial line will block further appends until the file is truncated to its
// last valid newline.

export type EventLogRecoveryMode = "strict" | "skip-trailing-partial";

export type ReadEventLogOptions = {
  readonly recoveryMode?: EventLogRecoveryMode;
};

export class EventLogDecodeError extends Error {
  constructor(
    message: string,
    readonly lineNumber: number,
    readonly line: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "EventLogDecodeError";
  }
}

export class EventLogSequenceError extends Error {
  constructor(
    message: string,
    readonly previous: AgentEvent,
    readonly current: AgentEvent,
  ) {
    super(message);
    this.name = "EventLogSequenceError";
  }
}

export class JsonlEventLog {
  private tailEvent: AgentEvent | undefined;
  private tailLoaded = false;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(readonly filePath: string) {}

  async append(event: AgentEvent): Promise<void> {
    await this.appendMany([event]);
  }

  async appendMany(events: readonly AgentEvent[]): Promise<void> {
    validateEventOrder(events);

    if (events.length === 0) {
      return;
    }

    const task = this.writeQueue.then(() => this.appendBatchInternal(events));
    this.writeQueue = task.catch(() => undefined);
    return task;
  }

  async readAll(options: ReadEventLogOptions = {}): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];

    for await (const event of this.replay(options)) {
      events.push(event);
    }

    return events;
  }

  async *replay(options: ReadEventLogOptions = {}): AsyncIterable<AgentEvent> {
    const recoveryMode = options.recoveryMode ?? "skip-trailing-partial";
    const handle = await openForRead(this.filePath);

    if (!handle) {
      return;
    }

    try {
      const decoder = new StringDecoder("utf8");
      const chunk = Buffer.alloc(64 * 1024);
      let buffer = "";
      let lineNumber = 0;
      let previous: AgentEvent | undefined;

      while (true) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);

        if (bytesRead === 0) {
          break;
        }

        buffer += decoder.write(chunk.subarray(0, bytesRead));

        let newlineIdx = buffer.indexOf("\n");
        while (newlineIdx !== -1) {
          const line = buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 1);
          lineNumber += 1;

          const event = decodeOrThrow(line, lineNumber);
          assertStrictlyIncreasing(previous, event);
          previous = event;
          yield event;

          newlineIdx = buffer.indexOf("\n");
        }
      }

      buffer += decoder.end();

      if (buffer.length > 0) {
        lineNumber += 1;

        if (recoveryMode === "skip-trailing-partial") {
          return;
        }

        const event = decodeOrThrow(buffer, lineNumber);
        assertStrictlyIncreasing(previous, event);
        yield event;
      }
    } finally {
      await handle.close();
    }
  }

  private async appendBatchInternal(events: readonly AgentEvent[]): Promise<void> {
    await ensureParentDirectory(this.filePath);
    await this.loadTailIfNeeded();

    const first = events[0];
    if (this.tailEvent && this.tailEvent.sequence >= first.sequence) {
      throw new EventLogSequenceError(
        `Event log sequence must be strictly increasing (previous=${this.tailEvent.sequence}, current=${first.sequence})`,
        this.tailEvent,
        first,
      );
    }

    const payload = events.map(encodeEvent).join("");

    try {
      await appendFile(this.filePath, payload, { encoding: "utf8" });
    } catch (error) {
      // Surface raw error and invalidate cache: a partial write may have
      // landed on disk, so the in-memory tail can no longer be trusted.
      this.tailLoaded = false;
      this.tailEvent = undefined;
      throw error;
    }

    this.tailEvent = events[events.length - 1];
    this.tailLoaded = true;
  }

  private async loadTailIfNeeded(): Promise<void> {
    if (this.tailLoaded) {
      return;
    }

    let last: AgentEvent | undefined;
    for await (const event of this.replay({ recoveryMode: "strict" })) {
      last = event;
    }

    this.tailEvent = last;
    this.tailLoaded = true;
  }
}

export function encodeEvent(event: AgentEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export function decodeEvent(line: string): AgentEvent {
  const parsed: unknown = JSON.parse(line);

  if (!isAgentEvent(parsed)) {
    throw new Error("Invalid agent event");
  }

  return parsed;
}

// Convenience wrapper. Each call instantiates a fresh JsonlEventLog, so it
// pays the lazy tail load on every invocation; prefer a long-lived
// JsonlEventLog instance when writing many events.
export async function appendEvent(filePath: string, event: AgentEvent): Promise<void> {
  await new JsonlEventLog(filePath).append(event);
}

// Convenience wrapper. See appendEvent for the long-lived-instance caveat.
export async function appendEvents(filePath: string, events: readonly AgentEvent[]): Promise<void> {
  await new JsonlEventLog(filePath).appendMany(events);
}

export async function readEventLog(
  filePath: string,
  options: ReadEventLogOptions = {},
): Promise<AgentEvent[]> {
  return new JsonlEventLog(filePath).readAll(options);
}

export function validateEventOrder(events: readonly AgentEvent[]): void {
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1];
    const current = events[index];

    if (current.sequence <= previous.sequence) {
      throw new EventLogSequenceError(
        `Event log sequence must be strictly increasing (previous=${previous.sequence}, current=${current.sequence})`,
        previous,
        current,
      );
    }
  }
}

function assertStrictlyIncreasing(previous: AgentEvent | undefined, current: AgentEvent): void {
  if (previous && current.sequence <= previous.sequence) {
    throw new EventLogSequenceError(
      `Event log sequence must be strictly increasing (previous=${previous.sequence}, current=${current.sequence})`,
      previous,
      current,
    );
  }
}

function decodeOrThrow(line: string, lineNumber: number): AgentEvent {
  try {
    return decodeEvent(line);
  } catch (error) {
    throw new EventLogDecodeError("Invalid event log line", lineNumber, line, error);
  }
}

async function openForRead(filePath: string) {
  try {
    return await open(filePath, "r");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function ensureParentDirectory(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
