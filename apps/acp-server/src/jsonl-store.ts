import { join } from "node:path";
import { JsonlEventLog } from "@custom-agent/storage";
import type { AgentEvent } from "@custom-agent/schema";
import type { EventStore } from "@custom-agent/core";

// Filesystem-backed EventStore used by apps/acp-server. Each session's events
// live in `<rootDir>/<sessionId>.jsonl`, served by an M1-01 JsonlEventLog
// instance (tail-cache + in-process write queue).
//
// NOTE: this duplicates packages/core/src/adapters/jsonl-event-store.ts on
// purpose. The plan ([[adr-0005]] / RESTRUCTURE-PLAN Phase 3-4) is to migrate
// that adapter to packages/storage; this acp-server-local copy will then be
// replaced with a direct import from @custom-agent/storage. Keeping the
// duplication localized here lets acp-server land without first refactoring
// the core/storage boundary.

export class JsonlSessionStore implements EventStore {
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
