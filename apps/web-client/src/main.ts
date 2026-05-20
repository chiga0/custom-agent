import {
  DaemonError,
  loadSession,
  newSession,
  prompt,
  subscribe,
  type DaemonConfig,
  type StreamEvent,
} from "./daemon-client";
import { EMPTY_TRANSCRIPT, applySessionUpdate, type TranscriptState } from "./transcript";
import "./styles.css";

// main.ts
//
// Wires DOM controls to the daemon client + transcript reducer. The
// view is intentionally minimal — bind config inputs, two session
// entry points (new / load), one prompt path, one rolling transcript.
// All actual protocol logic lives in daemon-client.ts; this file is the
// last-mile glue.

type UiState = {
  config: DaemonConfig | null;
  sessionId: string | null;
  transcript: TranscriptState;
  status: string;
  /** Aborts the in-flight SSE subscription on session teardown / unload. */
  streamAbort: AbortController | null;
};

const state: UiState = {
  config: null,
  sessionId: null,
  transcript: EMPTY_TRANSCRIPT,
  status: "idle",
  streamAbort: null,
};

// ---- pure render helpers (exported for tests) ----

/**
 * Build a transcript HTML fragment string. Pure function over the
 * TranscriptState — kept exported because the existing main.test.ts
 * (now replaced by transcript.test.ts) relied on a pure render helper.
 */
export function renderTranscriptHtml(transcript: TranscriptState): string {
  if (transcript.turns.length === 0) {
    return `<p class="empty">No turns yet. Start a new session or load an existing one.</p>`;
  }
  return transcript.turns
    .map(
      (turn) =>
        `<article class="turn turn--${turn.role}"><h3>${turn.role}</h3><p>${escapeHtml(turn.text)}</p></article>`,
    )
    .join("");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---- DOM bootstrap ----

function readConfigFromInputs(): DaemonConfig | null {
  const baseUrl = (document.querySelector<HTMLInputElement>("#cfg-url")?.value ?? "").trim();
  const authToken = (document.querySelector<HTMLInputElement>("#cfg-token")?.value ?? "").trim();
  if (!baseUrl || !authToken) return null;
  return { baseUrl, authToken };
}

function setStatus(msg: string): void {
  state.status = msg;
  const el = document.querySelector<HTMLElement>("#status");
  if (el) el.textContent = msg;
}

function rerenderTranscript(): void {
  const el = document.querySelector<HTMLElement>("#transcript");
  if (el) el.innerHTML = renderTranscriptHtml(state.transcript);
}

function rerenderSession(): void {
  const el = document.querySelector<HTMLElement>("#session-id");
  if (el) el.textContent = state.sessionId ?? "(no session)";
}

function resetSessionState(): void {
  state.streamAbort?.abort();
  state.streamAbort = null;
  state.sessionId = null;
  state.transcript = EMPTY_TRANSCRIPT;
  rerenderTranscript();
  rerenderSession();
}

async function startSession(): Promise<void> {
  const cfg = readConfigFromInputs();
  if (!cfg) {
    setStatus("Set daemon URL and bearer token first.");
    return;
  }
  resetSessionState();
  state.config = cfg;
  setStatus("Creating session...");
  try {
    const res = await newSession(cfg, { cwd: "/tmp", mcpServers: [] });
    state.sessionId = res.sessionId;
    rerenderSession();
    setStatus(`Live session ${res.sessionId} — open. Send a prompt to drive a turn.`);
    void attachStream();
  } catch (err) {
    handleError(err, "session/new failed");
  }
}

async function loadSavedSession(): Promise<void> {
  const cfg = readConfigFromInputs();
  if (!cfg) {
    setStatus("Set daemon URL and bearer token first.");
    return;
  }
  const sessionId = (
    document.querySelector<HTMLInputElement>("#load-session-id")?.value ?? ""
  ).trim();
  if (!sessionId) {
    setStatus("Enter a session id to load.");
    return;
  }
  resetSessionState();
  state.config = cfg;
  setStatus(`Loading session ${sessionId}...`);
  try {
    await loadSession(cfg, { sessionId, cwd: "/tmp", mcpServers: [] });
    state.sessionId = sessionId;
    rerenderSession();
    setStatus(`Replaying session ${sessionId} (read-only).`);
    void attachStream();
  } catch (err) {
    handleError(err, "session/load failed");
  }
}

function endSession(): void {
  if (!state.sessionId) {
    setStatus("No session to end.");
    return;
  }
  const ended = state.sessionId;
  resetSessionState();
  setStatus(`Disconnected from session ${ended}. Daemon-side session continues running.`);
}

async function sendPrompt(): Promise<void> {
  if (!state.config || !state.sessionId) {
    setStatus("Start or load a session before sending a prompt.");
    return;
  }
  const input = document.querySelector<HTMLInputElement>("#prompt-text");
  const text = (input?.value ?? "").trim();
  if (!text) return;
  if (input) input.value = "";
  setStatus("Sending prompt...");
  try {
    const res = await prompt(state.config, {
      sessionId: state.sessionId,
      prompt: [{ type: "text", text }],
    });
    setStatus(`Turn done (stopReason=${res.stopReason}).`);
  } catch (err) {
    handleError(err, "session/prompt failed");
  }
}

async function attachStream(): Promise<void> {
  if (!state.config || !state.sessionId) return;
  const ac = new AbortController();
  state.streamAbort = ac;
  try {
    for await (const event of subscribe(state.config, state.sessionId, { signal: ac.signal })) {
      handleStreamEvent(event);
    }
  } catch (err) {
    if (ac.signal.aborted) return;
    handleError(err, "SSE stream error");
  }
}

function handleStreamEvent(event: StreamEvent): void {
  if (event.kind === "update") {
    state.transcript = applySessionUpdate(state.transcript, event.update);
    rerenderTranscript();
    return;
  }
  if (event.control.kind === "terminated") {
    setStatus(
      `Session ${state.sessionId ?? "?"} terminated${event.control.reason ? ` (${event.control.reason})` : ""}.`,
    );
    return;
  }
  // cursor_lost
  setStatus(
    `SSE cursor lost (requested=${event.control.requested ?? "?"}, oldestAvailable=${event.control.oldestAvailable ?? "?"}). Reload the session.`,
  );
}

function handleError(err: unknown, prefix: string): void {
  const message =
    err instanceof DaemonError
      ? `${prefix}: ${err.message}`
      : `${prefix}: ${err instanceof Error ? err.message : String(err)}`;
  setStatus(message);
}

function render(): void {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) return;

  app.innerHTML = `
    <section class="shell">
      <header>
        <p class="eyebrow">Custom Agent</p>
        <h1>Web event timeline</h1>
        <p class="lede">Live and replayed session transcripts via the ACP daemon HTTP+SSE wire.</p>
      </header>

      <section class="panel" aria-label="Daemon configuration">
        <h2>Daemon</h2>
        <label>URL <input id="cfg-url" type="url" placeholder="http://127.0.0.1:3000" /></label>
        <label>Token <input id="cfg-token" type="password" placeholder="ACP_DAEMON_AUTH_TOKEN" /></label>
      </section>

      <section class="panel" aria-label="Session controls">
        <h2>Session</h2>
        <p>Current: <code id="session-id">(no session)</code></p>
        <div class="controls">
          <button id="btn-new" type="button">Start new session</button>
          <span class="sep">or</span>
          <label>Load by id <input id="load-session-id" type="text" placeholder="sess_..." /></label>
          <button id="btn-load" type="button">Load</button>
          <button id="btn-end" type="button" class="btn-secondary">End session</button>
        </div>
      </section>

      <section class="panel" aria-label="Session event timeline">
        <h2>Transcript</h2>
        <div id="transcript" class="transcript"></div>
      </section>

      <section class="panel" aria-label="Prompt">
        <h2>Prompt</h2>
        <div class="controls">
          <input id="prompt-text" type="text" placeholder="say hi" />
          <button id="btn-prompt" type="button">Send</button>
        </div>
      </section>

      <footer><p id="status" class="status">idle</p></footer>
    </section>
  `;

  document.querySelector<HTMLButtonElement>("#btn-new")?.addEventListener("click", () => {
    void startSession();
  });
  document.querySelector<HTMLButtonElement>("#btn-load")?.addEventListener("click", () => {
    void loadSavedSession();
  });
  document.querySelector<HTMLButtonElement>("#btn-prompt")?.addEventListener("click", () => {
    void sendPrompt();
  });
  document.querySelector<HTMLButtonElement>("#btn-end")?.addEventListener("click", () => {
    endSession();
  });

  rerenderTranscript();
}

if (typeof document !== "undefined") {
  render();
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    state.streamAbort?.abort();
  });
}
