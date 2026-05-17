import { isAgentEvent, type AgentEvent } from "@custom-agent/schema";
import { mkdir, readFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

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
  constructor(readonly filePath: string) {}

  async append(event: AgentEvent): Promise<void> {
    await this.appendMany([event]);
  }

  async appendMany(events: readonly AgentEvent[]): Promise<void> {
    validateEventOrder(events);

    if (events.length === 0) {
      return;
    }

    await ensureParentDirectory(this.filePath);
    await this.assertAppendable(events);
    await appendFile(this.filePath, events.map(encodeEvent).join(""), {
      encoding: "utf8",
      flag: "a",
    });
  }

  async readAll(options: ReadEventLogOptions = {}): Promise<AgentEvent[]> {
    return readEventLog(this.filePath, options);
  }

  async *replay(options: ReadEventLogOptions = {}): AsyncIterable<AgentEvent> {
    for (const event of await this.readAll(options)) {
      yield event;
    }
  }

  private async assertAppendable(events: readonly AgentEvent[]): Promise<void> {
    const existingEvents = await this.readAll({ recoveryMode: "strict" });
    const previous = existingEvents.at(-1);

    if (previous) {
      validateEventOrder([previous, ...events]);
    }
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

export async function appendEvent(filePath: string, event: AgentEvent): Promise<void> {
  await new JsonlEventLog(filePath).append(event);
}

export async function appendEvents(filePath: string, events: readonly AgentEvent[]): Promise<void> {
  await new JsonlEventLog(filePath).appendMany(events);
}

export async function readEventLog(
  filePath: string,
  options: ReadEventLogOptions = {},
): Promise<AgentEvent[]> {
  const recoveryMode = options.recoveryMode ?? "skip-trailing-partial";
  const content = await readFile(filePath, "utf8").catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "";
    }

    throw error;
  });

  const lines = content.split("\n");
  const events: AgentEvent[] = [];

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const isTrailingEmptyLine = index === lines.length - 1 && line === "";

    if (isTrailingEmptyLine) {
      continue;
    }

    try {
      events.push(decodeEvent(line));
    } catch (error) {
      const isTrailingLine = index === lines.length - 1;

      if (recoveryMode === "skip-trailing-partial" && isTrailingLine) {
        continue;
      }

      throw new EventLogDecodeError("Invalid event log line", lineNumber, line, error);
    }
  }

  validateEventOrder(events);
  return events;
}

export function validateEventOrder(events: readonly AgentEvent[]): void {
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1];
    const current = events[index];

    if (current.sequence <= previous.sequence) {
      throw new EventLogSequenceError(
        "Event log sequence must be strictly increasing",
        previous,
        current,
      );
    }
  }
}

async function ensureParentDirectory(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
