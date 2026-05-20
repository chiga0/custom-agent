export {
  EventStoreFailure,
  SessionEngine,
  type CancelTurnInput,
  type CreateSessionInput,
  type ReplaySessionInput,
  type RunTurnInput,
  type Session,
  type SessionClient,
  type SessionEngineDeps,
  type TurnState,
  type TurnTransition,
} from "./session-engine";

export {
  FakeStreamingProvider,
  type FakeStreamingProviderOptions,
} from "./providers/fake-provider";

export {
  FakeToolCallProvider,
  type FakeToolCallProviderOptions,
  type FakeToolCallSequence,
} from "./providers/fake-tool-provider";

export type { ToolCallHandler, ToolCallHandlerFactory, ToolEventCommit } from "./ports/tool-call-handler";

// NOTE: JsonlFileEventStore intentionally NOT re-exported from this barrel.
// It is a storage-coupled adapter; importing it eagerly through the core
// barrel would pull @custom-agent/storage into every consumer of pure core
// types and weaken the EventStore port boundary. Tests inside this package
// import it via the relative path. A follow-up will move it to
// packages/storage where the implementation actually lives.

export type {
  ModelCapabilities,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  ModelUsage,
  PreflightResult,
} from "./ports/model-provider";

export type { EventStore } from "./ports/event-store";

export {
  ProviderError,
  ProviderRateLimit,
  ProviderUnauthorized,
  ProviderContextOverflow,
  ProviderServerError,
  ProviderUnknownError,
  toTurnErrorCode,
} from "./ports/provider-error";
