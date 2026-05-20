import { mkdtempSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type DaemonServer } from "./server";
import { SessionManager } from "./session-manager";

// Real-subprocess smoke test: the daemon spawns `apps/acp-server` via
// `process.execPath` + tsx loader, exactly as it would in production.
// This is the end-to-end verification the M1-ACP-HTTP acceptance
// criteria call for: "Web client can complete a fake turn via local
// daemon."
//
// We don't use a Web client here — fetch + SSE is the wire surface that
// every consumer (Web, CLI, TUI) speaks.

const AUTH = "smoke-test-token";

describe("acp-daemon end-to-end (real acp-server child)", () => {
  let server: DaemonServer | undefined;
  let baseUrl: string;
  let manager: SessionManager;

  beforeAll(async () => {
    manager = new SessionManager();
    server = await startServer({ authToken: AUTH, manager, port: 0, host: "127.0.0.1" });
    baseUrl = `http://127.0.0.1:${server.address.port}`;
  });

  afterAll(async () => {
    if (server) await server.close();
  });

  it("completes a fake turn over HTTP+SSE end-to-end", async () => {
    // session/new spawns the real acp-server child.
    const newRes = await fetch(`${baseUrl}/rpc`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AUTH}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "session/new",
        params: { cwd: "/tmp", mcpServers: [] },
      }),
    });
    expect(newRes.status).toBe(200);
    const newBody = (await newRes.json()) as { result: { sessionId: string } };
    const sessionId = newBody.result.sessionId;
    expect(typeof sessionId).toBe("string");

    // Open the SSE stream BEFORE issuing the prompt, so we catch all
    // streaming updates.
    const ac = new AbortController();
    const sseRes = await fetch(`${baseUrl}/events`, {
      headers: {
        Authorization: `Bearer ${AUTH}`,
        "X-ACP-Session-Id": sessionId,
      },
      signal: ac.signal,
    });
    expect(sseRes.status).toBe(200);

    // Kick off reading SSE concurrently.
    const collected = collectSseUntil(sseRes, ac, 3000);

    // Now send the prompt.
    const promptRes = await fetch(`${baseUrl}/rpc`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AUTH}`,
        "Content-Type": "application/json",
        "X-ACP-Session-Id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "session/prompt",
        params: { sessionId, prompt: [{ type: "text", text: "hi" }] },
      }),
    });
    expect(promptRes.status).toBe(200);
    const promptBody = (await promptRes.json()) as {
      result: { stopReason: string };
      error?: { message: string };
    };
    expect(promptBody.error, JSON.stringify(promptBody.error)).toBeUndefined();
    expect(promptBody.result.stopReason).toBe("end_turn");

    // Give the SSE stream a moment to drain, then abort to close it.
    await new Promise((r) => setTimeout(r, 200));
    ac.abort();
    const events = await collected;

    // We expect at least one session/update event.
    const updates = events.filter((e) => e.data.includes('"session/update"'));
    expect(updates.length).toBeGreaterThan(0);
  }, 30_000);

  it("rejects requests without bearer token (real server)", async () => {
    const res = await fetch(`${baseUrl}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} }),
    });
    expect(res.status).toBe(401);
  }, 10_000);

  it("/healthz works without auth", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});

// M1-04: live vs replay equivalence. The same canonical fake-provider
// turn is driven through session/new + prompt (the writer child writes a
// JSONL log under ACP_EVENT_LOG_ROOT), then a separate session/load
// (which spawns a fresh acp-server child against the same env) replays
// the saved session via session/update notifications. The two SSE
// streams' notification payloads must compare equal after a stable
// projection that strips per-run sessionId.
describe("acp-daemon session/load end-to-end equivalence", () => {
  let server: DaemonServer | undefined;
  let baseUrl: string;
  let manager: SessionManager;
  let rootDir: string;

  beforeAll(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "acp-daemon-load-"));
    manager = new SessionManager({
      childEnv: { ...process.env, ACP_EVENT_LOG_ROOT: rootDir },
    });
    server = await startServer({ authToken: AUTH, manager, port: 0, host: "127.0.0.1" });
    baseUrl = `http://127.0.0.1:${server.address.port}`;
  });

  afterAll(async () => {
    if (server) await server.close();
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("session/load replays the same session/update payloads the live prompt produced", async () => {
    // ---- Live phase: drive a turn end-to-end. ----
    const newRes = await fetch(`${baseUrl}/rpc`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "session/new",
        params: { cwd: "/tmp", mcpServers: [] },
      }),
    });
    expect(newRes.status).toBe(200);
    const sessionId = (await newRes.json()).result.sessionId as string;

    // Attach SSE BEFORE prompt so we capture every live update.
    const liveAc = new AbortController();
    const liveSse = await fetch(`${baseUrl}/events`, {
      headers: { Authorization: `Bearer ${AUTH}`, "X-ACP-Session-Id": sessionId },
      signal: liveAc.signal,
    });
    expect(liveSse.status).toBe(200);
    const liveCollect = collectSseUntil(liveSse, liveAc, 4000);

    const promptRes = await fetch(`${baseUrl}/rpc`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AUTH}`,
        "Content-Type": "application/json",
        "X-ACP-Session-Id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "session/prompt",
        params: { sessionId, prompt: [{ type: "text", text: "hi" }] },
      }),
    });
    expect(promptRes.status).toBe(200);
    expect((await promptRes.json()).result.stopReason).toBe("end_turn");

    // Drain SSE briefly, then abort.
    await new Promise((r) => setTimeout(r, 200));
    liveAc.abort();
    const liveEvents = await liveCollect;
    const liveUpdates = liveEvents
      .map((e) => parseUpdate(e.data))
      .filter((u): u is { sessionId: string; update: unknown } => u !== null);
    expect(liveUpdates.length).toBeGreaterThan(0);

    // Terminate the writer session so the JSONL is flushed and no
    // routing conflict blocks the load. session/cancel is a no-op here;
    // closing the underlying child via terminateAll is the cleanest path.
    await manager.terminate(sessionId);

    // ---- Replay phase: session/load the same id. ----
    const loadRes = await fetch(`${baseUrl}/rpc`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "session/load",
        params: { sessionId, cwd: "/tmp", mcpServers: [] },
      }),
    });
    expect(loadRes.status).toBe(200);
    const loadBody = (await loadRes.json()) as { result?: unknown; error?: { message: string } };
    expect(loadBody.error, JSON.stringify(loadBody.error)).toBeUndefined();
    expect(loadBody.result).toEqual({});

    const replayAc = new AbortController();
    const replaySse = await fetch(`${baseUrl}/events`, {
      headers: { Authorization: `Bearer ${AUTH}`, "X-ACP-Session-Id": sessionId },
      signal: replayAc.signal,
    });
    expect(replaySse.status).toBe(200);
    const replayEvents = await collectSseUntil(replaySse, replayAc, 2000);
    const replayUpdates = replayEvents
      .map((e) => parseUpdate(e.data))
      .filter((u): u is { sessionId: string; update: unknown } => u !== null);

    // ---- Equivalence: the surfaced `update` payloads must be byte-equal. ----
    const liveProjection = liveUpdates.map((u) => JSON.stringify(u.update));
    const replayProjection = replayUpdates.map((u) => JSON.stringify(u.update));
    expect(replayProjection).toEqual(liveProjection);
  }, 30_000);
});

function parseUpdate(raw: string): { sessionId: string; update: unknown } | null {
  try {
    const msg = JSON.parse(raw) as { method?: string; params?: unknown };
    if (msg.method !== "session/update") return null;
    const params = msg.params as { sessionId?: unknown; update?: unknown } | undefined;
    if (!params || typeof params.sessionId !== "string") return null;
    return { sessionId: params.sessionId, update: params.update };
  } catch {
    return null;
  }
}

type RawFrame = { id?: number; event?: string; data: string };

/** Read SSE frames until the abort signal fires or `timeoutMs` elapses. */
async function collectSseUntil(
  res: Response,
  ac: AbortController,
  timeoutMs: number,
): Promise<RawFrame[]> {
  if (!res.body) return [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const out: RawFrame[] = [];
  let buffer = "";
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        // aborted
        break;
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let blank: number;
      while ((blank = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, blank);
        buffer = buffer.slice(blank + 2);
        if (!frame || frame.startsWith(": ")) continue;
        const parsed = parseFrame(frame);
        if (parsed) out.push(parsed);
      }
    }
  } finally {
    clearTimeout(t);
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
  return out;
}

function parseFrame(frame: string): RawFrame | null {
  let id: number | undefined;
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("id:")) id = Number.parseInt(line.slice(3).trim(), 10);
    else if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (id === undefined && !event && dataLines.length === 0) return null;
  return { id, event, data: dataLines.join("\n") };
}
