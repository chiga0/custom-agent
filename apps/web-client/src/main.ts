import type { AgentEvent } from "@custom-agent/schema";
import "./styles.css";

const fixtureEvents: AgentEvent[] = [
  {
    id: "evt_1",
    schemaVersion: 1,
    sessionId: "sess_demo",
    sequence: 1,
    timestamp: "2026-05-17T00:00:00.000Z",
    type: "session.created",
    payload: {
      cwd: "/workspace/custom-agent",
      client: "web",
    },
  },
  {
    id: "evt_2",
    schemaVersion: 1,
    sessionId: "sess_demo",
    turnId: "turn_demo",
    sequence: 2,
    timestamp: "2026-05-17T00:00:01.000Z",
    type: "user.message",
    payload: {
      content: "Initialize Custom Agent.",
    },
  },
  {
    id: "evt_3",
    schemaVersion: 1,
    sessionId: "sess_demo",
    turnId: "turn_demo",
    sequence: 3,
    timestamp: "2026-05-17T00:00:02.000Z",
    type: "model.delta",
    payload: {
      text: "Project spine is ready.",
    },
  },
];

export function renderEventSummary(events: AgentEvent[]): string {
  return events.map((event) => `${event.sequence}. ${event.type}`).join("\n");
}

function render(): void {
  const app = document.querySelector<HTMLDivElement>("#app");

  if (!app) {
    return;
  }

  app.innerHTML = `
    <section class="shell">
      <header>
        <p class="eyebrow">Custom Agent</p>
        <h1>Web regression shell</h1>
        <p class="lede">The first client surface renders the canonical event stream.</p>
      </header>
      <section class="panel" aria-label="Session event timeline">
        <h2>Demo Session</h2>
        <pre>${renderEventSummary(fixtureEvents)}</pre>
      </section>
    </section>
  `;
}

if (typeof document !== "undefined") {
  render();
}
