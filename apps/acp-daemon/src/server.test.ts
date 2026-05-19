import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, type DaemonServer } from "./server";
import { SessionManager } from "./session-manager";
import type { ChildHandle, JsonRpcMessage } from "./child";

// In-process HTTP test: start a real node:http server on an ephemeral
// port, route via the production SessionManager + a FakeChildHandle
// (avoids spawning real Node subprocesses for each test).
//
// The server tests focus on:
//   - auth (401 paths)
//   - session-header routing
//   - JSON-RPC request/response shape
//   - notification (202) shape
//   - SSE event stream framing + cursor replay
//   - multi-session no crosstalk
//
// Real-subprocess end-to-end coverage lives in smoke.test.ts.

type FakeBehavior = {
  /** Map<method, response>. */
  responses?: Record<string, (params: unknown) => JsonRpcMessage | Promise<JsonRpcMessage>>;
  /** session id reported on session/new. */
  sessionId: string;
};

class FakeChild extends EventEmitter {
  pid = 99999;
  isExited = false;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private readonly behavior: FakeBehavior;
  notifications: Array<{ method: string; params: unknown }> = [];

  constructor(behavior: FakeBehavior) {
    super();
    this.behavior = behavior;
  }

  async request(method: string, params: unknown): Promise<JsonRpcMessage> {
    if (this.isExited) throw new Error("child exited");
    const custom = this.behavior.responses?.[method];
    if (custom) return custom(params);
    if (method === "initialize") {
      return { jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } };
    }
    if (method === "session/new") {
      return { jsonrpc: "2.0", id: 2, result: { sessionId: this.behavior.sessionId } };
    }
    if (method === "session/prompt") {
      // Emit one streaming update notification, then return end_turn.
      queueMicrotask(() => {
        this.emit("notification", {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: this.behavior.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "hello" },
            },
          },
        });
      });
      return { jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } };
    }
    return { jsonrpc: "2.0", id: 99, error: { code: -32601, message: "method not found" } };
  }

  notify(method: string, params: unknown): void {
    if (this.isExited) return;
    this.notifications.push({ method, params });
  }

  async terminate(): Promise<void> {
    if (this.isExited) return;
    this.isExited = true;
    this.exit = { code: 0, signal: null };
    this.emit("exit", this.exit);
  }

  simulateCrash(): void {
    this.isExited = true;
    this.exit = { code: 1, signal: null };
    this.emit("exit", this.exit);
  }

  emitNotification(msg: JsonRpcMessage): void {
    this.emit("notification", msg);
  }
}

type Harness = {
  server: DaemonServer;
  manager: SessionManager;
  baseUrl: string;
  token: string;
  pendingChildren: FakeChild[];
};

async function startHarness(opts: {
  childFactory: (index: number) => FakeChild;
}): Promise<Harness> {
  const pendingChildren: FakeChild[] = [];
  let index = 0;
  const manager = new SessionManager({
    spawnChild: () => {
      const child = opts.childFactory(index++);
      pendingChildren.push(child);
      return child as unknown as ChildHandle;
    },
  });
  const token = "test-token";
  const server = await startServer({ authToken: token, manager, port: 0, host: "127.0.0.1" });
  return {
    server,
    manager,
    baseUrl: `http://127.0.0.1:${server.address.port}`,
    token,
    pendingChildren,
  };
}

async function teardown(h: Harness | null): Promise<void> {
  if (!h) return;
  await h.server.close();
}

function authHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

describe("daemon HTTP server", () => {
  let h: Harness | null = null;

  beforeEach(() => {
    h = null;
  });
  afterEach(async () => {
    await teardown(h);
  });

  it("rejects requests without bearer token (401)", async () => {
    h = await startHarness({ childFactory: () => new FakeChild({ sessionId: "s_1" }) });
    const res = await fetch(`${h.baseUrl}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects wrong-token (401)", async () => {
    h = await startHarness({ childFactory: () => new FakeChild({ sessionId: "s_1" }) });
    const res = await fetch(`${h.baseUrl}/rpc`, {
      method: "POST",
      headers: { Authorization: "Bearer wrong", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    expect(res.status).toBe(401);
  });

  it("GET /healthz returns 200 ok with no auth", async () => {
    h = await startHarness({ childFactory: () => new FakeChild({ sessionId: "s_1" }) });
    const res = await fetch(`${h.baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("daemon-level initialize answers without spawning a child", async () => {
    h = await startHarness({ childFactory: () => new FakeChild({ sessionId: "s_1" }) });
    const res = await fetch(`${h.baseUrl}/rpc`, {
      method: "POST",
      headers: authHeaders(h.token),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1 },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonRpcMessage;
    expect(body.id).toBe(1);
    expect((body.result as { protocolVersion: number }).protocolVersion).toBe(1);
    expect(h.pendingChildren).toHaveLength(0);
  });

  it("session/new spawns a child and returns sessionId", async () => {
    h = await startHarness({ childFactory: () => new FakeChild({ sessionId: "sess_HTTP_1" }) });
    const res = await fetch(`${h.baseUrl}/rpc`, {
      method: "POST",
      headers: authHeaders(h.token),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "session/new",
        params: { cwd: "/tmp", mcpServers: [] },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonRpcMessage;
    expect((body.result as { sessionId: string }).sessionId).toBe("sess_HTTP_1");
    expect(h.pendingChildren).toHaveLength(1);
  });

  it("session-scoped methods require X-ACP-Session-Id (400 missing)", async () => {
    h = await startHarness({ childFactory: () => new FakeChild({ sessionId: "sess_X" }) });
    const res = await fetch(`${h.baseUrl}/rpc`, {
      method: "POST",
      headers: authHeaders(h.token),
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: {} }),
    });
    expect(res.status).toBe(400);
  });

  it("session/prompt forwards to the right child and returns its result", async () => {
    h = await startHarness({ childFactory: () => new FakeChild({ sessionId: "sess_P" }) });
    // Create.
    await fetch(`${h.baseUrl}/rpc`, {
      method: "POST",
      headers: authHeaders(h.token),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} }),
    });
    const res = await fetch(`${h.baseUrl}/rpc`, {
      method: "POST",
      headers: authHeaders(h.token, { "X-ACP-Session-Id": "sess_P" }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "session/prompt",
        params: { sessionId: "sess_P", prompt: [{ type: "text", text: "hi" }] },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonRpcMessage;
    expect((body.result as { stopReason: string }).stopReason).toBe("end_turn");
  });

  it("session/cancel as notification returns 202 and forwards to child", async () => {
    h = await startHarness({ childFactory: () => new FakeChild({ sessionId: "sess_C" }) });
    await fetch(`${h.baseUrl}/rpc`, {
      method: "POST",
      headers: authHeaders(h.token),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new" }),
    });
    const res = await fetch(`${h.baseUrl}/rpc`, {
      method: "POST",
      headers: authHeaders(h.token, { "X-ACP-Session-Id": "sess_C" }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId: "sess_C" },
      }),
    });
    expect(res.status).toBe(202);
    expect(h.pendingChildren[0].notifications).toEqual([
      { method: "session/cancel", params: { sessionId: "sess_C" } },
    ]);
  });

  it("rejects when params.sessionId disagrees with X-ACP-Session-Id header (400)", async () => {
    h = await startHarness({ childFactory: () => new FakeChild({ sessionId: "sess_OK" }) });
    await fetch(`${h.baseUrl}/rpc`, {
      method: "POST",
      headers: authHeaders(h.token),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new" }),
    });
    const res = await fetch(`${h.baseUrl}/rpc`, {
      method: "POST",
      headers: authHeaders(h.token, { "X-ACP-Session-Id": "sess_OK" }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "session/prompt",
        params: { sessionId: "sess_WRONG", prompt: [{ type: "text", text: "x" }] },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/does not match/);
  });

  it("returns 410 Gone for requests to a terminated session", async () => {
    h = await startHarness({ childFactory: () => new FakeChild({ sessionId: "sess_G" }) });
    await fetch(`${h.baseUrl}/rpc`, {
      method: "POST",
      headers: authHeaders(h.token),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new" }),
    });
    h.pendingChildren[0].simulateCrash();
    const res = await fetch(`${h.baseUrl}/rpc`, {
      method: "POST",
      headers: authHeaders(h.token, { "X-ACP-Session-Id": "sess_G" }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "session/prompt",
        params: { sessionId: "sess_G", prompt: [{ type: "text", text: "x" }] },
      }),
    });
    expect(res.status).toBe(410);
  });

  it("malformed JSON yields 400", async () => {
    h = await startHarness({ childFactory: () => new FakeChild({ sessionId: "_" }) });
    const res = await fetch(`${h.baseUrl}/rpc`, {
      method: "POST",
      headers: authHeaders(h.token),
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects Content-Type other than application/json (415)", async () => {
    h = await startHarness({ childFactory: () => new FakeChild({ sessionId: "_" }) });
    const res = await fetch(`${h.baseUrl}/rpc`, {
      method: "POST",
      headers: { Authorization: `Bearer ${h.token}`, "Content-Type": "text/plain" },
      body: "{}",
    });
    expect(res.status).toBe(415);
  });

  it("unknown path is 404, wrong verb is 405 (auth required first)", async () => {
    h = await startHarness({ childFactory: () => new FakeChild({ sessionId: "_" }) });
    const bearer = { Authorization: `Bearer ${h.token}` };
    expect((await fetch(`${h.baseUrl}/nope`, { headers: bearer })).status).toBe(404);
    expect((await fetch(`${h.baseUrl}/rpc`, { method: "GET", headers: bearer })).status).toBe(405);
  });

  it("SSE /events streams session/update notifications with monotonic ids", async () => {
    h = await startHarness({ childFactory: () => new FakeChild({ sessionId: "sess_S" }) });
    await fetch(`${h.baseUrl}/rpc`, {
      method: "POST",
      headers: authHeaders(h.token),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new" }),
    });
    const child = h.pendingChildren[0];
    const ac = new AbortController();
    const sseRes = await fetch(`${h.baseUrl}/events`, {
      headers: { Authorization: `Bearer ${h.token}`, "X-ACP-Session-Id": "sess_S" },
      signal: ac.signal,
    });
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get("content-type")).toContain("text/event-stream");

    // Emit two events from the child.
    child.emitNotification({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_S",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a" } },
      },
    });
    child.emitNotification({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_S",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "b" } },
      },
    });

    const events = await readSseEvents(sseRes, 2, ac);
    expect(events.map((e) => e.id)).toEqual([1, 2]);
    expect(events[0].data).toContain('"text":"a"');
    expect(events[1].data).toContain('"text":"b"');
  });

  it("SSE Last-Event-ID replays missed events from the cursor", async () => {
    h = await startHarness({ childFactory: () => new FakeChild({ sessionId: "sess_R" }) });
    await fetch(`${h.baseUrl}/rpc`, {
      method: "POST",
      headers: authHeaders(h.token),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new" }),
    });
    const child = h.pendingChildren[0];
    // Emit 3 events before the SSE client connects.
    for (let i = 0; i < 3; i += 1) {
      child.emitNotification({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess_R",
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: String(i) },
          },
        },
      });
    }
    const ac = new AbortController();
    const res = await fetch(`${h.baseUrl}/events`, {
      headers: {
        Authorization: `Bearer ${h.token}`,
        "X-ACP-Session-Id": "sess_R",
        "Last-Event-ID": "1",
      },
      signal: ac.signal,
    });
    const events = await readSseEvents(res, 2, ac);
    expect(events.map((e) => e.id)).toEqual([2, 3]);
  });

  it("SSE emits 'event: terminated' when the child exits", async () => {
    h = await startHarness({ childFactory: () => new FakeChild({ sessionId: "sess_T" }) });
    await fetch(`${h.baseUrl}/rpc`, {
      method: "POST",
      headers: authHeaders(h.token),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new" }),
    });
    const child = h.pendingChildren[0];
    const ac = new AbortController();
    const res = await fetch(`${h.baseUrl}/events`, {
      headers: { Authorization: `Bearer ${h.token}`, "X-ACP-Session-Id": "sess_T" },
      signal: ac.signal,
    });

    // Crash after a microtask so the SSE handler has time to attach.
    setTimeout(() => child.simulateCrash(), 10);
    const events = await readSseEvents(res, 1, ac, { acceptEvents: ["terminated"] });
    expect(events[0].event).toBe("terminated");
  });

  it("3 concurrent sessions: streams do not cross-talk", async () => {
    let nextId = 0;
    const harness = await startHarness({
      childFactory: () => new FakeChild({ sessionId: `sess_M_${nextId++}` }),
    });
    h = harness;
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await fetch(`${harness.baseUrl}/rpc`, {
        method: "POST",
        headers: authHeaders(harness.token),
        body: JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "session/new" }),
      });
      const body = (await res.json()) as JsonRpcMessage;
      ids.push((body.result as { sessionId: string }).sessionId);
    }
    expect(new Set(ids).size).toBe(3);

    // Open 3 SSE streams.
    const acs = ids.map(() => new AbortController());
    const responses = await Promise.all(
      ids.map((sid, i) =>
        fetch(`${harness.baseUrl}/events`, {
          headers: { Authorization: `Bearer ${harness.token}`, "X-ACP-Session-Id": sid },
          signal: acs[i].signal,
        }),
      ),
    );

    // Emit a unique notification per child.
    harness.pendingChildren.forEach((child, i) => {
      child.emitNotification({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: ids[i],
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `unique_${i}` },
          },
        },
      });
    });

    const perStream = await Promise.all(responses.map((res, i) => readSseEvents(res, 1, acs[i])));
    perStream.forEach((events, i) => {
      expect(events).toHaveLength(1);
      expect(events[0].data).toContain(`"unique_${i}"`);
    });
  });
});

type SseEvent = { id: number; event?: string; data: string };

/**
 * Read up to `n` SSE events from a fetch Response, then abort the request.
 *
 * The browser/whatwg fetch SSE shape uses ReadableStream byte chunks; we
 * parse the same frame format as the daemon writes (id: + data:, blank
 * line). Times out after 2s defensively so a stuck stream doesn't hang
 * the whole suite.
 */
async function readSseEvents(
  res: Response,
  n: number,
  ac: AbortController,
  opts: { acceptEvents?: string[] } = {},
): Promise<SseEvent[]> {
  if (!res.body) throw new Error("response has no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  let buffer = "";
  const timer = setTimeout(() => ac.abort(), 2000);
  try {
    while (events.length < n) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let blank: number;
      while ((blank = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, blank);
        buffer = buffer.slice(blank + 2);
        if (!frame || frame.startsWith(": ")) continue;
        const event = parseSseFrame(frame);
        if (event) {
          if (opts.acceptEvents && (!event.event || !opts.acceptEvents.includes(event.event))) {
            // not a frame we care about (e.g. comment / unrelated event)
            continue;
          }
          events.push(event);
          if (events.length >= n) break;
        }
      }
    }
  } finally {
    clearTimeout(timer);
    ac.abort();
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
  return events;
}

function parseSseFrame(frame: string): SseEvent | null {
  let id: number | null = null;
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("id:")) id = Number.parseInt(line.slice(3).trim(), 10);
    else if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (id === null && !event) return null;
  return { id: id ?? 0, event, data: dataLines.join("\n") };
}
