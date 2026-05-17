import { join } from "node:path";
import { JsonlEventLog } from "@custom-agent/storage";
import type { AgentEvent } from "@custom-agent/schema";
import type { EventStore } from "../ports/event-store";

// Filesystem adapter mapping each session to one JSONL file under rootDir.
// Reuses M1-01's JsonlEventLog so every append goes through the tail-cache
// + in-process write queue (no cross-session contention because each session
// owns its own JsonlEventLog instance).

export class JsonlFileEventStore implements EventStore {
  private readonly logs = new Map<string, JsonlEventLog>();

  constructor(private readonly rootDir: string) {}

  async append(sessionId: string, event: AgentEvent): Promise<void> {
    await this.logFor(sessionId).append(event);
  }

  async *replay(sessionId: string): AsyncIterable<AgentEvent> {
    yield* this.logFor(sessionId).replay();
  }

  private logFor(sessionId: string): JsonlEventLog {
    let log = this.logs.get(sessionId);
    if (!log) {
      log = new JsonlEventLog(join(this.rootDir, `${sessionId}.jsonl`));
      this.logs.set(sessionId, log);
    }
    return log;
  }
}
