// Programmatic API surface of @custom-agent/acp-daemon.
//
// The daemon is normally launched via `bin/acp-daemon.mjs`. These exports
// exist so tests and a future in-process `--standalone` mode
// ([[adr-0004]] §4) can build the daemon without invoking the binary.

export { startServer, type DaemonServer, type ServerOptions } from "./server";
export {
  SessionManager,
  SessionNotFoundError,
  SessionTerminatedError,
  CursorLostError,
  DEFAULT_TERMINATED_GRACE_MS,
  type SessionManagerOptions,
  type SessionState,
} from "./session-manager";
export { ChildHandle, ACP_SERVER_BIN, type ChildHandleOptions } from "./child";
export { SessionCursor, DEFAULT_RING_SIZE, type CursorEvent } from "./cursor";
export { createAuthenticator, AuthFailed, type Authenticator } from "./auth";
