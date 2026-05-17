import type { AgentEvent } from "@custom-agent/schema";

// Port that lets SessionEngine persist + replay events without knowing the
// underlying storage layout. Concrete adapter (e.g. JsonlFileEventStore)
// lives outside core/ but inside packages/core because Core orchestrates it.

export type EventStore = {
  append(sessionId: string, event: AgentEvent): Promise<void>;
  replay(sessionId: string): AsyncIterable<AgentEvent>;
};
