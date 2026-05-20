import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager";
import { startServer } from "./server";

// Binary entry: parse env, start the HTTP+SSE daemon.
//
// Per [[adr-0004]] §3-§5 the daemon listens on a local port, authenticates
// every request with a bearer token, and spawns one apps/acp-server child
// per ACP session.
//
// Environment variables:
//   ACP_DAEMON_AUTH_TOKEN — required, non-empty; bearer credential.
//   ACP_DAEMON_PORT       — optional, default 0 (ephemeral). The actual
//                            bound port is logged after listen() resolves.
//   ACP_DAEMON_HOST       — optional, default 127.0.0.1.
//   ACP_EVENT_LOG_ROOT    — optional, shared directory for per-session
//                            JSONL logs. When unset, the daemon mkdtemps
//                            a per-process dir and propagates it to every
//                            spawned acp-server child so M1-04 session/load
//                            can find the writer's log from a replay
//                            child. When set, the daemon honors the
//                            operator's path (e.g. ~/.cache/custom-agent).

async function main(): Promise<void> {
  const authToken = process.env.ACP_DAEMON_AUTH_TOKEN;
  if (!authToken || authToken.trim() === "") {
    process.stderr.write("acp-daemon: ACP_DAEMON_AUTH_TOKEN is required and must be non-empty.\n");
    process.exit(2);
  }
  const portEnv = process.env.ACP_DAEMON_PORT;
  const port = portEnv ? Number.parseInt(portEnv, 10) : 0;
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    process.stderr.write(`acp-daemon: invalid ACP_DAEMON_PORT=${portEnv}\n`);
    process.exit(2);
  }
  const host = process.env.ACP_DAEMON_HOST ?? "127.0.0.1";

  // Resolve a stable event-log root for all spawned children so the
  // M1-04 replay path can find the writer's JSONL from a different child.
  const eventLogRoot = process.env.ACP_EVENT_LOG_ROOT
    ? ensureDir(process.env.ACP_EVENT_LOG_ROOT)
    : mkdtempSync(join(tmpdir(), "acp-daemon-"));

  const manager = new SessionManager({
    childEnv: { ...process.env, ACP_EVENT_LOG_ROOT: eventLogRoot },
  });
  const server = await startServer({ port, host, authToken, manager });
  process.stdout.write(
    `acp-daemon listening on http://${server.address.address}:${server.address.port}\n` +
      `acp-daemon event log root: ${eventLogRoot}\n`,
  );

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    process.stderr.write(`acp-daemon: received ${signal}, shutting down\n`);
    // SPEC.md §10: 5-second grace before force exit. If server.close()
    // hangs (e.g. a child refuses to die), this ensures the daemon
    // process terminates in bounded time.
    const hardTimeout = setTimeout(() => {
      process.stderr.write("acp-daemon: shutdown grace period exceeded; forcing exit\n");
      process.exit(1);
    }, 5_000);
    hardTimeout.unref();
    await server.close();
    clearTimeout(hardTimeout);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`acp-daemon: fatal error: ${message}\n`);
  process.exit(1);
});
