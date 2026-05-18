import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// End-to-end smoke test: spawn the published `acp-server` binary as a real
// subprocess and round-trip JSON-RPC over stdio. This is the verification
// path that Codex Round 1 P1 #3 demanded — we don't trust in-process tests
// to prove an editor (Zed) can actually launch the binary.
//
// The binary is `apps/acp-server/bin/acp-server.mjs` (shebang `#!/usr/bin/env
// node`). It uses tsx's programmatic loader to import the TS source so no
// pre-build is required.
//
// Test pattern:
// 1. spawn the binary
// 2. write JSON-RPC frames to stdin (newline-delimited JSON)
// 3. read responses + notifications from stdout
// 4. close stdin; expect clean exit

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, "..", "bin", "acp-server.mjs");

type RpcMessage = {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};

async function withSpawnedServer<T>(
  fn: (api: {
    send: (msg: unknown) => void;
    next: () => Promise<RpcMessage>;
    waitForId: (id: number) => Promise<RpcMessage>;
    stderr: () => string;
  }) => Promise<T>,
): Promise<T> {
  const child = spawn(process.execPath, [BIN], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stderrChunks: Buffer[] = [];
  child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));

  const messages: RpcMessage[] = [];
  const waiters: Array<(m: RpcMessage) => void> = [];
  let buffer = "";
  child.stdout.on("data", (c: Buffer) => {
    buffer += c.toString("utf8");
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as RpcMessage;
      const waiter = waiters.shift();
      if (waiter) waiter(msg);
      else messages.push(msg);
    }
  });

  const api = {
    send(msg: unknown) {
      child.stdin.write(JSON.stringify(msg) + "\n");
    },
    next(): Promise<RpcMessage> {
      if (messages.length > 0) return Promise.resolve(messages.shift() as RpcMessage);
      return new Promise((resolve) => waiters.push(resolve));
    },
    async waitForId(id: number): Promise<RpcMessage> {
      while (true) {
        const msg = await api.next();
        if (msg.id === id) return msg;
      }
    },
    stderr(): string {
      return Buffer.concat(stderrChunks).toString("utf8");
    },
  };

  try {
    return await fn(api);
  } finally {
    child.stdin.end();
    await new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
      // Force kill after 5s if it didn't exit cleanly.
      setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5000).unref();
    });
  }
}

describe("acp-server binary (spawn smoke test)", () => {
  it("binary is executable and round-trips initialize + newSession + prompt", async () => {
    await withSpawnedServer(async ({ send, waitForId, stderr }) => {
      // 1. initialize
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
      const init = await waitForId(1);
      expect(init.error, `initialize errored. stderr=${stderr()}`).toBeUndefined();
      expect((init.result as { protocolVersion: number }).protocolVersion).toBe(1);

      // 2. newSession (ACP requires mcpServers per session/new spec)
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "session/new",
        params: { cwd: "/tmp", mcpServers: [] },
      });
      const newSess = await waitForId(2);
      expect(newSess.error, `newSession errored. stderr=${stderr()}`).toBeUndefined();
      const sessionId = (newSess.result as { sessionId: string }).sessionId;
      expect(typeof sessionId).toBe("string");

      // 3. prompt with ContentBlock[] (not bare string — that was the bug
      //    in the previous wire shape)
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: {
          sessionId,
          prompt: [{ type: "text", text: "hello" }],
        },
      });

      const promptResp = await waitForId(3);
      expect(promptResp.error, `prompt errored. stderr=${stderr()}`).toBeUndefined();
      const result = promptResp.result as { stopReason: string };
      expect(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"]).toContain(
        result.stopReason,
      );
      expect(result.stopReason).toBe("end_turn");
    });
  }, 20_000);

  it("accepts a baseline resource_link ContentBlock over the spawned wire (ACP MUST)", async () => {
    await withSpawnedServer(async ({ send, waitForId, stderr }) => {
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
      await waitForId(1);

      send({
        jsonrpc: "2.0",
        id: 2,
        method: "session/new",
        params: { cwd: "/tmp", mcpServers: [] },
      });
      const sessionId = ((await waitForId(2)).result as { sessionId: string }).sessionId;

      // resource_link block — Codex Round 2 manually verified this used
      // to fail before the fix; this regression test catches that path.
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: {
          sessionId,
          prompt: [
            { type: "text", text: "see " },
            { type: "resource_link", name: "README.md", uri: "file:///tmp/README.md" },
          ],
        },
      });

      const resp = await waitForId(3);
      expect(resp.error, `expected success, got: ${JSON.stringify(resp.error)}`).toBeUndefined();
      expect((resp.result as { stopReason: string }).stopReason).toBe("end_turn");
      expect(stderr(), `stderr: ${stderr()}`).not.toMatch(/Error|SyntaxError/);
    });
  }, 20_000);

  it("session/cancel is accepted as a notification (no id) and server stays alive", async () => {
    await withSpawnedServer(async ({ send, waitForId, stderr }) => {
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
      await waitForId(1);

      send({
        jsonrpc: "2.0",
        id: 2,
        method: "session/new",
        params: { cwd: "/tmp", mcpServers: [] },
      });
      const newSess = await waitForId(2);
      const sessionId = (newSess.result as { sessionId: string }).sessionId;

      // Send cancel as NOTIFICATION (no id) — this is the failure path
      // Codex flagged in P1 #2. The server must accept it (not reject as
      // "drop unknown notification") and must NOT crash.
      send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
      // Give the notification dispatcher a moment.
      await new Promise((r) => setTimeout(r, 30));

      // Confirm server still alive by issuing a follow-up prompt.
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: { sessionId, prompt: [{ type: "text", text: "ping" }] },
      });
      const resp = await waitForId(3);

      expect(resp.id).toBe(3);
      expect(resp.error, `unexpected prompt error: ${JSON.stringify(resp.error)}`).toBeUndefined();
      expect(stderr(), `binary crashed mid-test. stderr=${stderr()}`).not.toMatch(
        /Cannot find|SyntaxError/,
      );
    });
  }, 20_000);
});
