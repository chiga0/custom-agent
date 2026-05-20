import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
  CursorLostError,
  SessionManager,
  SessionNotFoundError,
  SessionTerminatedError,
} from "./session-manager";
import type { ChildHandle, JsonRpcMessage } from "./child";

// FakeChildHandle: in-memory stand-in for ChildHandle. The real handle
// spawns a Node subprocess and parses ndjson; here we just call back
// scripted responses synchronously so SessionManager logic can be unit
// tested without process boundaries.

type RequestHandler = (method: string, params: unknown) => Promise<JsonRpcMessage> | JsonRpcMessage;

class FakeChildHandle extends EventEmitter {
  pid = 12345;
  isExited = false;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private requestHandler: RequestHandler;
  notifications: Array<{ method: string; params: unknown }> = [];

  constructor(handler: RequestHandler) {
    super();
    this.requestHandler = handler;
  }

  async request(method: string, params: unknown): Promise<JsonRpcMessage> {
    if (this.isExited) throw new Error("child exited");
    return this.requestHandler(method, params);
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

  /** Test helper: simulate a child crash. */
  simulateCrash(code = 1): void {
    this.isExited = true;
    this.exit = { code, signal: null };
    this.emit("exit", this.exit);
  }

  /** Test helper: emit a notification as if the child sent one. */
  emitNotification(msg: JsonRpcMessage): void {
    this.emit("notification", msg);
  }
}

function makeChild(handler: RequestHandler): FakeChildHandle {
  return new FakeChildHandle(handler);
}

/** Standard handler: respond to initialize + session/new + session/prompt. */
function standardHandler(sessionId: string): RequestHandler {
  return async (method) => {
    if (method === "initialize") {
      return { jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } };
    }
    if (method === "session/new") {
      return { jsonrpc: "2.0", id: 2, result: { sessionId } };
    }
    if (method === "session/prompt") {
      return { jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } };
    }
    return { jsonrpc: "2.0", id: 99, error: { code: -32601, message: "method not found" } };
  };
}

describe("SessionManager", () => {
  const children: FakeChildHandle[] = [];
  afterEach(async () => {
    for (const c of children) {
      if (!c.isExited) await c.terminate();
    }
    children.length = 0;
  });

  it("createSession spawns child, performs initialize + session/new, returns sessionId", async () => {
    const child = makeChild(standardHandler("sess_1"));
    children.push(child);
    const manager = new SessionManager({
      spawnChild: () => child as unknown as ChildHandle,
    });
    const result = await manager.createSession({
      initializeParams: { protocolVersion: 1 },
      newSessionParams: { cwd: "/tmp", mcpServers: [] },
    });
    expect(result.sessionId).toBe("sess_1");
    expect(manager.get("sess_1")?.status).toBe("alive");
  });

  it("propagates child initialize error and cleans up", async () => {
    const child = makeChild(async (method) =>
      method === "initialize"
        ? { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "init boom" } }
        : { jsonrpc: "2.0", id: 99, error: { code: -32601, message: "no" } },
    );
    children.push(child);
    const manager = new SessionManager({
      spawnChild: () => child as unknown as ChildHandle,
    });
    await expect(
      manager.createSession({
        initializeParams: { protocolVersion: 1 },
        newSessionParams: {},
      }),
    ).rejects.toThrow(/init boom/);
    expect(child.isExited).toBe(true);
  });

  it("forwardRequest routes to the right child", async () => {
    const sessionIds = ["s_a", "s_b", "s_c"];
    const calls: string[] = [];
    const handlers: FakeChildHandle[] = sessionIds.map((sid) => {
      const c = makeChild(async (method) => {
        if (method === "initialize")
          return { jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } };
        if (method === "session/new") return { jsonrpc: "2.0", id: 2, result: { sessionId: sid } };
        calls.push(`${sid}:${method}`);
        return { jsonrpc: "2.0", id: 3, result: { ok: sid } };
      });
      children.push(c);
      return c;
    });
    let i = 0;
    const manager = new SessionManager({
      spawnChild: () => handlers[i++] as unknown as ChildHandle,
    });
    for (const sid of sessionIds) {
      await manager.createSession({
        initializeParams: { protocolVersion: 1 },
        newSessionParams: {},
      });
      void sid;
    }
    const respA = await manager.forwardRequest("s_a", "session/prompt", {});
    const respB = await manager.forwardRequest("s_b", "session/prompt", {});
    expect((respA.result as { ok: string }).ok).toBe("s_a");
    expect((respB.result as { ok: string }).ok).toBe("s_b");
    expect(calls).toEqual(["s_a:session/prompt", "s_b:session/prompt"]);
  });

  it("forwardRequest on unknown session throws SessionNotFoundError", async () => {
    const manager = new SessionManager({
      spawnChild: () =>
        makeChild(async () => ({ jsonrpc: "2.0", id: 1, result: {} })) as unknown as ChildHandle,
    });
    await expect(manager.forwardRequest("nope", "x", {})).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
  });

  it("subscribe replays buffered events then yields live ones", async () => {
    const child = makeChild(standardHandler("sess_x"));
    children.push(child);
    const manager = new SessionManager({
      spawnChild: () => child as unknown as ChildHandle,
    });
    await manager.createSession({
      initializeParams: { protocolVersion: 1 },
      newSessionParams: {},
    });

    // Emit 2 buffered events before subscribing.
    child.emitNotification({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_x",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a" } },
      },
    });
    child.emitNotification({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_x",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "b" } },
      },
    });

    const ac = new AbortController();
    const collected: number[] = [];
    const consumer = (async (): Promise<void> => {
      for await (const e of manager.subscribe("sess_x", 0, ac.signal)) {
        collected.push(e.id);
        if (collected.length === 3) ac.abort();
      }
    })();

    // Emit a third event live.
    await new Promise((r) => setTimeout(r, 5));
    child.emitNotification({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_x",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "c" } },
      },
    });

    await consumer;
    expect(collected).toEqual([1, 2, 3]);
  });

  it("subscribe from a cursor higher than buffer raises CursorLostError", async () => {
    const child = makeChild(standardHandler("sess_y"));
    children.push(child);
    const manager = new SessionManager({
      spawnChild: () => child as unknown as ChildHandle,
      ringSize: 2,
    });
    await manager.createSession({
      initializeParams: { protocolVersion: 1 },
      newSessionParams: {},
    });
    // Produce 5 events, ring keeps only 2 (ids 4,5)
    for (let i = 0; i < 5; i += 1) {
      child.emitNotification({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess_y",
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: String(i) },
          },
        },
      });
    }
    const ac = new AbortController();
    const iter = manager.subscribe("sess_y", 1, ac.signal)[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toBeInstanceOf(CursorLostError);
  });

  it("child crash marks session terminated and isolates other sessions", async () => {
    // Three sessions; A crashes, B and C must continue.
    const childA = makeChild(standardHandler("s_A"));
    const childB = makeChild(standardHandler("s_B"));
    const childC = makeChild(standardHandler("s_C"));
    children.push(childA, childB, childC);
    const queue = [childA, childB, childC];
    const manager = new SessionManager({
      spawnChild: () => queue.shift()! as unknown as ChildHandle,
    });
    await manager.createSession({ initializeParams: { protocolVersion: 1 }, newSessionParams: {} });
    await manager.createSession({ initializeParams: { protocolVersion: 1 }, newSessionParams: {} });
    await manager.createSession({ initializeParams: { protocolVersion: 1 }, newSessionParams: {} });

    childA.simulateCrash(137);

    // A is terminated; forwarding raises SessionTerminatedError.
    await expect(manager.forwardRequest("s_A", "session/prompt", {})).rejects.toBeInstanceOf(
      SessionTerminatedError,
    );
    expect(manager.get("s_A")?.status).toBe("terminated");

    // B and C still work.
    const respB = await manager.forwardRequest("s_B", "session/prompt", {});
    const respC = await manager.forwardRequest("s_C", "session/prompt", {});
    expect((respB.result as { stopReason: string }).stopReason).toBe("end_turn");
    expect((respC.result as { stopReason: string }).stopReason).toBe("end_turn");
  });

  it("crash pushes synthetic _daemon/terminated event into cursor", async () => {
    const child = makeChild(standardHandler("sess_t"));
    children.push(child);
    const manager = new SessionManager({
      spawnChild: () => child as unknown as ChildHandle,
    });
    await manager.createSession({ initializeParams: { protocolVersion: 1 }, newSessionParams: {} });
    const state = manager.get("sess_t");
    if (!state) throw new Error("state missing");
    child.simulateCrash(1);
    // Synthetic terminate event is the only event so latest is 1.
    expect(state.cursor.latest).toBe(1);
    const parsed = JSON.parse(state.cursor.replay(0)[0].data) as { method: string };
    expect(parsed.method).toBe("_daemon/terminated");
  });

  it("forwardNotification on terminated session is silently ignored", async () => {
    const child = makeChild(standardHandler("sess_n"));
    children.push(child);
    const manager = new SessionManager({
      spawnChild: () => child as unknown as ChildHandle,
    });
    await manager.createSession({ initializeParams: { protocolVersion: 1 }, newSessionParams: {} });
    child.simulateCrash();
    expect(() => manager.forwardNotification("sess_n", "session/cancel", {})).not.toThrow();
  });

  it("garbage-collects terminated sessions after the grace window", async () => {
    const child = makeChild(standardHandler("sess_gc"));
    children.push(child);
    const scheduled: Array<() => void> = [];
    const manager = new SessionManager({
      spawnChild: () => child as unknown as ChildHandle,
      terminatedGraceMs: 1, // value unused; scheduler is manual
      scheduleTimer: (handler) => {
        scheduled.push(handler);
        return () => {
          const idx = scheduled.indexOf(handler);
          if (idx >= 0) scheduled.splice(idx, 1);
        };
      },
    });
    await manager.createSession({ initializeParams: { protocolVersion: 1 }, newSessionParams: {} });
    expect(manager.list()).toHaveLength(1);

    child.simulateCrash(137);
    // Synthetic terminate event is now buffered; entry is still in map
    // until the grace timer fires.
    expect(manager.list()).toHaveLength(1);
    expect(manager.get("sess_gc")?.status).toBe("terminated");

    // Trigger the scheduled cleanup.
    expect(scheduled).toHaveLength(1);
    scheduled[0]();
    expect(manager.list()).toHaveLength(0);
    expect(manager.get("sess_gc")).toBeUndefined();
  });

  it("terminate() cancels the grace timer", async () => {
    const child = makeChild(standardHandler("sess_cancel"));
    children.push(child);
    let cancelCount = 0;
    const manager = new SessionManager({
      spawnChild: () => child as unknown as ChildHandle,
      scheduleTimer: () => {
        return () => {
          cancelCount += 1;
        };
      },
    });
    await manager.createSession({ initializeParams: { protocolVersion: 1 }, newSessionParams: {} });
    child.simulateCrash(0);
    await manager.terminate("sess_cancel");
    expect(cancelCount).toBe(1);
    expect(manager.list()).toHaveLength(0);
  });

  it("loadSession spawns child, runs initialize + session/load, registers under client sessionId", async () => {
    const targetId = "sess_load_1";
    // The child emits session/update notifications synchronously DURING
    // the session/load handler — that's the whole point of replay. Use a
    // handler that pushes notifications via emitNotification BEFORE
    // returning the response.
    let bound: FakeChildHandle | null = null;
    const child = makeChild(async (method) => {
      if (method === "initialize") {
        return { jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } };
      }
      if (method === "session/load") {
        bound?.emitNotification({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: targetId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a" } },
          },
        });
        bound?.emitNotification({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: targetId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "b" } },
          },
        });
        return { jsonrpc: "2.0", id: 2, result: {} };
      }
      return { jsonrpc: "2.0", id: 99, error: { code: -32601, message: "method not found" } };
    });
    bound = child;
    children.push(child);
    const manager = new SessionManager({
      spawnChild: () => child as unknown as ChildHandle,
    });
    const result = await manager.loadSession({
      initializeParams: { protocolVersion: 1 },
      loadSessionParams: { sessionId: targetId, cwd: "/tmp", mcpServers: [] },
    });
    expect(result.sessionId).toBe(targetId);
    expect(manager.get(targetId)?.status).toBe("alive");
    // Cursor should already hold the 2 replayed notifications because
    // the listener was wired BEFORE session/load was issued.
    expect(manager.get(targetId)?.cursor.latest).toBe(2);
  });

  it("loadSession rejects when sessionId is missing", async () => {
    const child = makeChild(standardHandler("unused"));
    children.push(child);
    const manager = new SessionManager({
      spawnChild: () => child as unknown as ChildHandle,
    });
    await expect(
      manager.loadSession({
        initializeParams: { protocolVersion: 1 },
        loadSessionParams: { sessionId: "" },
      }),
    ).rejects.toThrow(/non-empty/);
  });

  it("loadSession refuses to re-load a session already alive in the manager", async () => {
    const targetId = "sess_dup";
    const child1 = makeChild(async (method) => {
      if (method === "initialize") return { jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } };
      if (method === "session/load") return { jsonrpc: "2.0", id: 2, result: {} };
      return { jsonrpc: "2.0", id: 99, error: { code: -32601, message: "no" } };
    });
    children.push(child1);
    const queue = [child1];
    const manager = new SessionManager({
      spawnChild: () => queue.shift()! as unknown as ChildHandle,
    });
    await manager.loadSession({
      initializeParams: { protocolVersion: 1 },
      loadSessionParams: { sessionId: targetId, cwd: "/tmp", mcpServers: [] },
    });
    await expect(
      manager.loadSession({
        initializeParams: { protocolVersion: 1 },
        loadSessionParams: { sessionId: targetId, cwd: "/tmp", mcpServers: [] },
      }),
    ).rejects.toThrow(/already loaded/);
  });

  it("loadSession cleans up the daemon entry when the child returns an error", async () => {
    const targetId = "sess_err";
    const child = makeChild(async (method) => {
      if (method === "initialize") return { jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } };
      if (method === "session/load") {
        return { jsonrpc: "2.0", id: 2, error: { code: -32603, message: "no such session" } };
      }
      return { jsonrpc: "2.0", id: 99, error: { code: -32601, message: "no" } };
    });
    children.push(child);
    const manager = new SessionManager({
      spawnChild: () => child as unknown as ChildHandle,
    });
    await expect(
      manager.loadSession({
        initializeParams: { protocolVersion: 1 },
        loadSessionParams: { sessionId: targetId, cwd: "/tmp", mcpServers: [] },
      }),
    ).rejects.toThrow(/no such session/);
    // Failed load must NOT leave an entry behind in the registry.
    expect(manager.get(targetId)).toBeUndefined();
    expect(child.isExited).toBe(true);
  });

  it("terminateAll removes every session and kills children", async () => {
    const childA = makeChild(standardHandler("s_X"));
    const childB = makeChild(standardHandler("s_Y"));
    children.push(childA, childB);
    const queue = [childA, childB];
    const manager = new SessionManager({
      spawnChild: () => queue.shift()! as unknown as ChildHandle,
    });
    await manager.createSession({ initializeParams: { protocolVersion: 1 }, newSessionParams: {} });
    await manager.createSession({ initializeParams: { protocolVersion: 1 }, newSessionParams: {} });
    expect(manager.list()).toHaveLength(2);
    await manager.terminateAll();
    expect(manager.list()).toHaveLength(0);
    expect(childA.isExited).toBe(true);
    expect(childB.isExited).toBe(true);
  });
});
