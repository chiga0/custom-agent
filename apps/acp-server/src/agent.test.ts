import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@custom-agent/schema";
import type { ContentBlock, SessionNotification, StopReason } from "@custom-agent/schema/acp";
import {
  FakeStreamingProvider,
  type EventStore,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
} from "@custom-agent/core";
import { ACP_PROTOCOL_VERSION, CustomAgent } from "./agent";

// In-memory EventStore for fast tests.
class InMemoryStore implements EventStore {
  readonly events: AgentEvent[] = [];
  async append(_sessionId: string, event: AgentEvent): Promise<void> {
    this.events.push(event);
  }
  async *replay(sessionId: string): AsyncIterable<AgentEvent> {
    for (const e of this.events) if (e.sessionId === sessionId) yield e;
  }
}

// Minimal mock of AgentSideConnection's sessionUpdate channel — collects
// notifications so tests can assert ordering / content.
class NotificationCollector {
  readonly notifications: SessionNotification[] = [];
  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.notifications.push(params);
  }
}

function makeAgent(
  opts: {
    provider?: ModelProvider;
    store?: EventStore;
  } = {},
): { agent: CustomAgent; conn: NotificationCollector; store: InMemoryStore } {
  const conn = new NotificationCollector();
  const store = (opts.store as InMemoryStore) ?? new InMemoryStore();
  let id = 0;
  const agent = new CustomAgent({
    conn,
    eventStore: store,
    provider: opts.provider ?? new FakeStreamingProvider({ chunks: ["hi", " there"] }),
    now: () => new Date("2026-05-18T00:00:00.000Z"),
    createId: (prefix) => `${prefix}_${++id}`,
  });
  return { agent, conn, store };
}

const text = (s: string): ContentBlock => ({ type: "text", text: s });

describe("CustomAgent (ACP Agent interface)", () => {
  it("initialize returns ACP-compliant InitializeResponse", async () => {
    const { agent } = makeAgent();
    const res = await agent.initialize({ protocolVersion: 1 });
    expect(res.protocolVersion).toBe(ACP_PROTOCOL_VERSION);
    expect(res.agentCapabilities).toMatchObject({
      loadSession: true,
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      mcpCapabilities: { http: false, sse: false },
    });
    expect(res.authMethods).toEqual([]);
    expect(res.agentInfo).toMatchObject({ name: "Custom Agent" });
  });

  it("authenticate returns an empty response (no auth methods)", async () => {
    const { agent } = makeAgent();
    const res = await agent.authenticate({ methodId: "" });
    expect(res).toEqual({});
  });

  it("newSession creates a session and returns sessionId; ignores mcpServers", async () => {
    const { agent } = makeAgent();
    const res = await agent.newSession({ cwd: "/tmp", mcpServers: [] });
    expect(res.sessionId).toBeDefined();
    expect(typeof res.sessionId).toBe("string");
  });

  it("rejects a second newSession (one acp-server process owns one session)", async () => {
    const { agent } = makeAgent();
    await agent.newSession({ cwd: "/tmp", mcpServers: [] });
    await expect(agent.newSession({ cwd: "/tmp", mcpServers: [] })).rejects.toThrow(
      /already owns a session/i,
    );
  });

  it("prompt runs a turn: emits user_message_chunk + agent_message_chunk × N + returns end_turn", async () => {
    const { agent, conn } = makeAgent({
      provider: new FakeStreamingProvider({ chunks: ["foo ", "bar"] }),
    });
    const { sessionId } = await agent.newSession({ cwd: "/tmp", mcpServers: [] });

    const res = await agent.prompt({ sessionId, prompt: [text("hello")] });
    expect(res.stopReason).toBe<StopReason>("end_turn");

    expect(conn.notifications.map((n) => n.update.sessionUpdate)).toEqual([
      "user_message_chunk",
      "agent_message_chunk",
      "agent_message_chunk",
    ]);
    expect(conn.notifications.every((n) => n.sessionId === sessionId)).toBe(true);
  });

  it("rejects prompt with unknown sessionId", async () => {
    const { agent } = makeAgent();
    await agent.newSession({ cwd: "/tmp", mcpServers: [] });
    await expect(agent.prompt({ sessionId: "sess_bogus", prompt: [text("x")] })).rejects.toThrow(
      /Unknown sessionId/,
    );
  });

  it("accepts baseline resource_link ContentBlocks (ACP MUST) and renders them deterministically", async () => {
    const { agent, store } = makeAgent({
      provider: new FakeStreamingProvider({ chunks: ["ok"] }),
    });
    const { sessionId } = await agent.newSession({ cwd: "/tmp", mcpServers: [] });

    const res = await agent.prompt({
      sessionId,
      prompt: [
        { type: "text", text: "see " },
        {
          type: "resource_link",
          name: "README.md",
          uri: "file:///tmp/README.md",
          mimeType: "text/markdown",
        },
      ],
    });

    expect(res.stopReason).toBe<StopReason>("end_turn");

    // user.message payload must preserve the resource link deterministically.
    const userMessage = store.events.find((e) => e.type === "user.message");
    expect(userMessage?.payload).toMatchObject({
      content: "see [README.md](file:///tmp/README.md) (text/markdown)",
    });
  });

  it("accepts resource_link without mimeType (mimeType is optional per ACP schema)", async () => {
    const { agent, store } = makeAgent({
      provider: new FakeStreamingProvider({ chunks: ["ok"] }),
    });
    const { sessionId } = await agent.newSession({ cwd: "/tmp", mcpServers: [] });

    await agent.prompt({
      sessionId,
      prompt: [{ type: "resource_link", name: "x.txt", uri: "file:///tmp/x.txt" }],
    });

    const userMessage = store.events.find((e) => e.type === "user.message");
    expect(userMessage?.payload).toMatchObject({
      content: "[x.txt](file:///tmp/x.txt)",
    });
  });

  it("rejects prompt with image ContentBlock (M1 advertises image=false)", async () => {
    const { agent } = makeAgent();
    const { sessionId } = await agent.newSession({ cwd: "/tmp", mcpServers: [] });
    await expect(
      agent.prompt({
        sessionId,
        prompt: [{ type: "image", data: "abc", mimeType: "image/png" }],
      }),
    ).rejects.toThrow(/baseline ACP ContentBlocks/);
  });

  it("rejects prompt with audio ContentBlock (M1 advertises audio=false)", async () => {
    const { agent } = makeAgent();
    const { sessionId } = await agent.newSession({ cwd: "/tmp", mcpServers: [] });
    await expect(
      agent.prompt({
        sessionId,
        prompt: [{ type: "audio", data: "abc", mimeType: "audio/wav" }],
      }),
    ).rejects.toThrow(/baseline ACP ContentBlocks/);
  });

  it("rejects prompt with empty content blocks", async () => {
    const { agent } = makeAgent();
    const { sessionId } = await agent.newSession({ cwd: "/tmp", mcpServers: [] });
    await expect(agent.prompt({ sessionId, prompt: [] })).rejects.toThrow();
  });

  it("cancel as notification (no id) triggers a cancelled stopReason on the in-flight prompt", async () => {
    // A slow provider so cancel can arrive mid-stream.
    class SlowProvider implements ModelProvider {
      readonly id = "slow";
      readonly capabilities = {
        streaming: true,
        toolCall: false,
        parallelToolCall: false,
        reasoning: false,
        maxContextTokens: 1000,
      };
      preflightCheck(): { ok: true; estimatedTokens: number } {
        return { ok: true, estimatedTokens: 0 };
      }
      async *stream(_req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
        void _req;
        const chunks = ["a", "b", "c", "d", "e", "f"];
        for (const c of chunks) {
          if (signal.aborted) {
            yield { type: "failed", reason: "aborted" };
            return;
          }
          yield { type: "text_delta", delta: c };
          await new Promise((r) => setTimeout(r, 30));
        }
        yield { type: "completed" };
      }
    }

    const { agent, conn } = makeAgent({ provider: new SlowProvider() });
    const { sessionId } = await agent.newSession({ cwd: "/tmp", mcpServers: [] });

    const promptPromise = agent.prompt({ sessionId, prompt: [text("go")] });
    // Wait for at least one agent_message_chunk before cancelling.
    await waitFor(() =>
      conn.notifications.some((n) => n.update.sessionUpdate === "agent_message_chunk"),
    );
    await agent.cancel({ sessionId });

    const res = await promptPromise;
    expect(res.stopReason).toBe<StopReason>("cancelled");
  });

  it("cancel with unknown sessionId is a silent no-op", async () => {
    const { agent } = makeAgent();
    await agent.newSession({ cwd: "/tmp", mcpServers: [] });
    await expect(agent.cancel({ sessionId: "sess_bogus" })).resolves.toBeUndefined();
  });

  it("cancel before any prompt is a silent no-op", async () => {
    const { agent } = makeAgent();
    const { sessionId } = await agent.newSession({ cwd: "/tmp", mcpServers: [] });
    await expect(agent.cancel({ sessionId })).resolves.toBeUndefined();
  });

  it("provider failure maps to refusal stopReason", async () => {
    const { agent } = makeAgent({
      provider: new FakeStreamingProvider({ chunks: ["x", "y"], throwAfterFirstChunk: true }),
    });
    const { sessionId } = await agent.newSession({ cwd: "/tmp", mcpServers: [] });
    const res = await agent.prompt({ sessionId, prompt: [text("boom")] });
    expect(res.stopReason).toBe<StopReason>("refusal");
  });
});

// M1-04: loadSession replays a persisted session's session/update
// notifications. The strongest test pairs a writer Agent (newSession +
// prompt) and a separate reader Agent (loadSession over the SAME store),
// asserting that the reader's emitted notifications exactly equal the
// writer's notifications. That mirrors how the daemon will use a
// separately-spawned acp-server child to replay.
describe("CustomAgent.loadSession (M1-04 replay)", () => {
  it("re-emits the writer's session/update notifications in order", async () => {
    const store = new InMemoryStore();
    // Writer agent: run a turn so the store gets populated.
    const { agent: writer, conn: writerConn } = makeAgent({
      provider: new FakeStreamingProvider({ chunks: ["Hello, ", "world."] }),
      store,
    });
    const { sessionId } = await writer.newSession({ cwd: "/tmp", mcpServers: [] });
    await writer.prompt({ sessionId, prompt: [text("hi")] });

    // Reader agent: fresh CustomAgent over the SAME store; only loadSession.
    const reader = new CustomAgent({
      conn: new NotificationCollector(),
      eventStore: store,
    });
    const readerConn = (reader as unknown as { conn: NotificationCollector }).conn;
    const res = await reader.loadSession({
      cwd: "/tmp",
      mcpServers: [],
      sessionId,
    });

    expect(res).toEqual({});
    // The reader must emit exactly the writer's surfaced notifications, in order.
    expect(readerConn.notifications.map(updateSig)).toEqual(
      writerConn.notifications.map(updateSig),
    );
    // The mapper drops session.created / turn.started / turn.completed,
    // so the user-message + model-deltas remain. For the canonical run
    // this is 1 user_message_chunk + 2 agent_message_chunk = 3 notifications.
    expect(readerConn.notifications).toHaveLength(3);
  });

  it("rejects loadSession for a session id that was never persisted", async () => {
    const store = new InMemoryStore();
    const reader = new CustomAgent({
      conn: new NotificationCollector(),
      eventStore: store,
    });
    await expect(
      reader.loadSession({ cwd: "/tmp", mcpServers: [], sessionId: "sess_does_not_exist" }),
    ).rejects.toThrow(/no such session/);
  });

  it("after loadSession, subsequent prompt is rejected (replay-only)", async () => {
    const store = new InMemoryStore();
    const { agent: writer } = makeAgent({
      provider: new FakeStreamingProvider({ chunks: ["x"] }),
      store,
    });
    const { sessionId } = await writer.newSession({ cwd: "/tmp", mcpServers: [] });
    await writer.prompt({ sessionId, prompt: [text("hi")] });

    const reader = new CustomAgent({ conn: new NotificationCollector(), eventStore: store });
    await reader.loadSession({ cwd: "/tmp", mcpServers: [], sessionId });
    await expect(reader.prompt({ sessionId, prompt: [text("more")] })).rejects.toThrow(
      /replay only/i,
    );
  });

  it("rejects loadSession if the process already owns a session", async () => {
    const store = new InMemoryStore();
    const { agent } = makeAgent({ store });
    await agent.newSession({ cwd: "/tmp", mcpServers: [] });
    await expect(
      agent.loadSession({ cwd: "/tmp", mcpServers: [], sessionId: "sess_other" }),
    ).rejects.toThrow(/already owns/);
  });
});

/** Stable signature for a SessionNotification's update field (without the sessionId). */
function updateSig(n: SessionNotification): string {
  return JSON.stringify(n.update);
}

describe("CustomAgent + JsonlSessionStore (filesystem integration)", () => {
  it("persists events to JSONL and a fresh JsonlEventLog replays them in order", async () => {
    const { JsonlSessionStore } = await import("./jsonl-store");
    const dir = await mkdtemp(join(tmpdir(), "acp-server-store-"));
    try {
      const store = new JsonlSessionStore(dir);
      const { agent, conn } = makeAgent({
        provider: new FakeStreamingProvider({ chunks: ["x", "y"] }),
        store,
      });
      const { sessionId } = await agent.newSession({ cwd: "/tmp", mcpServers: [] });
      await agent.prompt({ sessionId, prompt: [text("hello")] });

      expect(conn.notifications.length).toBeGreaterThan(0);

      const { JsonlEventLog } = await import("@custom-agent/storage");
      const log = new JsonlEventLog(join(dir, `${sessionId}.jsonl`));
      const events: AgentEvent[] = [];
      for await (const e of log.replay()) events.push(e);
      expect(events.map((e) => e.type)).toEqual([
        "session.created",
        "turn.started",
        "user.message",
        "model.delta",
        "model.delta",
        "turn.completed",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
