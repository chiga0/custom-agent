import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonRpcRequest, JsonRpcResponse, StreamEvent } from "./daemon-client";
import { DaemonError, loadSession, newSession, prompt, subscribe } from "./daemon-client";

// daemon-client.test.ts
//
// Drives the wire functions with a mocked global `fetch`. The aim is to
// pin the wire shape: headers (bearer, content-type, X-ACP-Session-Id),
// JSON-RPC body, and SSE chunking decoding. Real HTTP behaviour is the
// daemon's responsibility (covered by apps/acp-daemon tests).

const config = { baseUrl: "http://daemon.test", authToken: "secret" };

afterEach(() => {
  vi.restoreAllMocks();
});

function mockJsonResponse<T>(body: JsonRpcResponse<T>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockTextResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

describe("newSession / loadSession / prompt", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("newSession posts session/new with bearer auth + JSON content-type", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse<{ sessionId: string }>({
        jsonrpc: "2.0",
        id: 1,
        result: { sessionId: "sess_OK" },
      }),
    );
    const res = await newSession(config, { cwd: "/tmp", mcpServers: [] });
    expect(res).toEqual({ sessionId: "sess_OK" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://daemon.test/rpc");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-ACP-Session-Id"]).toBeUndefined();

    const body = JSON.parse((init as RequestInit).body as string) as JsonRpcRequest;
    expect(body.jsonrpc).toBe("2.0");
    expect(body.method).toBe("session/new");
    expect(body.params).toEqual({ cwd: "/tmp", mcpServers: [] });
  });

  it("loadSession posts session/load WITHOUT the X-ACP-Session-Id header", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse<Record<string, never>>({ jsonrpc: "2.0", id: 1, result: {} }),
    );
    await loadSession(config, { sessionId: "sess_LOAD", cwd: "/tmp", mcpServers: [] });
    const [, init] = fetchMock.mock.calls[0];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["X-ACP-Session-Id"]).toBeUndefined();
    const body = JSON.parse((init as RequestInit).body as string) as JsonRpcRequest;
    expect(body.method).toBe("session/load");
    expect(body.params).toMatchObject({ sessionId: "sess_LOAD" });
  });

  it("prompt sends X-ACP-Session-Id header for routing", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse<{ stopReason: string }>({
        jsonrpc: "2.0",
        id: 1,
        result: { stopReason: "end_turn" },
      }),
    );
    const res = await prompt(config, {
      sessionId: "sess_P",
      prompt: [{ type: "text", text: "hi" }],
    });
    expect(res).toEqual({ stopReason: "end_turn" });

    const [, init] = fetchMock.mock.calls[0];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["X-ACP-Session-Id"]).toBe("sess_P");
  });

  it("surfaces JSON-RPC error as DaemonError", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse<Record<string, never>>({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32602, message: "bad params" },
      }),
    );
    await expect(newSession(config, { cwd: "/tmp", mcpServers: [] })).rejects.toMatchObject({
      name: "DaemonError",
      rpcError: { code: -32602, message: "bad params" },
    });
  });

  it("surfaces HTTP non-2xx as DaemonError", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(mockTextResponse("{}", 401));
    await expect(newSession(config, { cwd: "/tmp", mcpServers: [] })).rejects.toBeInstanceOf(
      DaemonError,
    );
  });

  it("strips trailing slash from baseUrl before forming the path", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({ jsonrpc: "2.0", id: 1, result: { sessionId: "sess_X" } }),
    );
    await newSession(
      { baseUrl: "http://daemon.test/", authToken: "secret" },
      { cwd: "/tmp", mcpServers: [] },
    );
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("http://daemon.test/rpc");
  });
});

describe("subscribe (SSE)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  function sseResponse(chunks: string[]): Response {
    const encoded = chunks.map((c) => new TextEncoder().encode(c));
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < encoded.length) {
          controller.enqueue(encoded[i++]);
        } else {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  async function collectAll(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
    const out: StreamEvent[] = [];
    for await (const e of gen) out.push(e);
    return out;
  }

  it("yields update events parsed from the SSE stream", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        `id: 1\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "sess_A",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } },
          },
        })}\n\n`,
        `id: 2\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "sess_A",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "y" } },
          },
        })}\n\n`,
      ]),
    );
    const events = await collectAll(subscribe(config, "sess_A"));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "update", id: 1, sessionId: "sess_A" });
    expect(events[1]).toMatchObject({ kind: "update", id: 2, sessionId: "sess_A" });
  });

  it("includes Last-Event-ID when resuming from a cursor", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(sseResponse([]));
    await collectAll(subscribe(config, "sess_A", { lastEventId: 42 }));
    const [, init] = fetchMock.mock.calls[0];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Last-Event-ID"]).toBe("42");
  });

  it("surfaces a `terminated` SSE event as a control event and ends the stream", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      sseResponse([`id: 1\nevent: terminated\ndata: ${JSON.stringify({ reason: "ok" })}\n\n`]),
    );
    const events = await collectAll(subscribe(config, "sess_T"));
    expect(events).toEqual([{ kind: "control", control: { kind: "terminated", reason: "ok" } }]);
  });

  it("surfaces a `cursor_lost` event with the requested + oldestAvailable cursor", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        `event: cursor_lost\ndata: ${JSON.stringify({ requested: 3, oldestAvailable: 100 })}\n\n`,
      ]),
    );
    const events = await collectAll(subscribe(config, "sess_C"));
    expect(events).toEqual([
      { kind: "control", control: { kind: "cursor_lost", requested: 3, oldestAvailable: 100 } },
    ]);
  });

  it("ignores non-session/update payloads (forward-compat)", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        `id: 1\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "_daemon/something" })}\n\n`,
      ]),
    );
    const events = await collectAll(subscribe(config, "sess_X"));
    expect(events).toEqual([]);
  });

  it("throws DaemonError on non-2xx SSE response", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(mockTextResponse("nope", 401));
    await expect(collectAll(subscribe(config, "sess_X"))).rejects.toBeInstanceOf(DaemonError);
  });
});
