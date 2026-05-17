import { isAgentEvent, type AgentEvent } from "@custom-agent/schema";

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
