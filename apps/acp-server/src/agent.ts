import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  ContentBlock,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  StopReason,
} from "@custom-agent/schema/acp";
import {
  EventStoreFailure,
  FakeStreamingProvider,
  SessionEngine,
  type EventStore,
  type ModelProvider,
} from "@custom-agent/core";
import { mapEventToUpdate } from "./event-mapper";
import { JsonlSessionStore } from "./jsonl-store";

// Implementation of the Zed Agent Client Protocol (Agent side).
//
// Per [[adr-0004]] §3 / §5:
// - One acp-server process owns at most one ACP session. Multi-session is
//   the daemon's responsibility (M1-ACP-HTTP spawns one acp-server child
//   per session).
// - Protocol bytes / framing / dispatch / error responses are handled by
//   the SDK's `AgentSideConnection`. This class implements the high-level
//   `Agent` interface — initialize / authenticate / newSession / prompt /
//   cancel — and delegates streaming model output to SessionEngine.
//
// ACP wire protocol details we depend on (the SDK enforces all of this):
// - `cancel` arrives as a JSON-RPC **notification**, not request (the SDK
//   wires it via NotificationHandler, so its `Promise<void>` return value
//   is never sent back over the wire).
// - `prompt` accepts an array of `ContentBlock`. M1 only knows how to read
//   `{ type: "text" }` blocks; non-text blocks raise an error because
//   `promptCapabilities` advertises image=false / audio=false /
//   embeddedContext=false.
// - StopReason values are strictly ACP — `end_turn` / `cancelled` /
//   `refusal` / `max_tokens` / `max_turn_requests`. Core's internal
//   `final` / `cancelled` / `error` mapping happens at the boundary below.

export const ACP_PROTOCOL_VERSION = 1;

export type CustomAgentOptions = {
  // The SDK passes the live connection so the agent can emit
  // session/update notifications back to the client.
  readonly conn: Pick<AgentSideConnection, "sessionUpdate">;
  readonly eventStore?: EventStore;
  readonly eventLogRoot?: string;
  readonly provider?: ModelProvider;
  readonly now?: () => Date;
  readonly createId?: (prefix: string) => string;
};

export class CustomAgent implements Agent {
  private readonly conn: Pick<AgentSideConnection, "sessionUpdate">;
  private readonly engine: SessionEngine;
  private sessionId: string | undefined;

  constructor(options: CustomAgentOptions) {
    this.conn = options.conn;
    const store =
      options.eventStore ?? new JsonlSessionStore(resolveEventLogRoot(options.eventLogRoot));
    const provider = options.provider ?? new FakeStreamingProvider();

    this.engine = new SessionEngine({
      eventStore: store,
      provider,
      now: options.now,
      createId: options.createId,
    });
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    void _params;
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentInfo: { name: "Custom Agent", version: "0.1.0" },
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false },
      },
      authMethods: [],
    };
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    void _params;
    // M1 advertises no auth methods; if a client calls authenticate anyway,
    // return an empty response (no _meta payload). Clients that respect the
    // empty authMethods list never reach this path.
    return {};
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    if (this.sessionId) {
      // ACP does not currently reserve a discriminated error for this case;
      // the SDK turns thrown errors into JSON-RPC INTERNAL_ERROR. Daemon
      // (M1-ACP-HTTP) avoids this by spawning a fresh acp-server per session.
      throw new Error(
        "This acp-server process already owns a session; spawn a new process for additional sessions",
      );
    }
    // M1 ignores params.mcpServers (M6 connects MCP). cwd is recorded into
    // the session.created event payload.
    const session = await this.engine.createSession({ cwd: params.cwd, client: "acp" });
    this.sessionId = session.sessionId;
    return { sessionId: session.sessionId };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    if (params.sessionId !== this.sessionId) {
      throw new Error(`Unknown sessionId: ${params.sessionId}`);
    }

    const userText = extractPromptText(params.prompt);
    if (userText === null) {
      throw new Error(
        "M1 acp-server only accepts baseline ACP ContentBlocks (text + resource_link); " +
          "image / audio / resource (embedded) blocks are not supported " +
          "(agentCapabilities.promptCapabilities advertises image=false, audio=false, embeddedContext=false)",
      );
    }

    let coreStopReason: "final" | "cancelled" | "error" = "final";
    try {
      for await (const event of this.engine.runTurn({
        sessionId: this.sessionId,
        userMessage: userText,
      })) {
        const update = mapEventToUpdate(event);
        if (update) {
          await this.conn.sessionUpdate({
            sessionId: this.sessionId,
            update,
          });
        }
        if (event.type === "turn.completed") {
          coreStopReason = event.payload.stopReason;
        }
      }
    } catch (error) {
      if (error instanceof EventStoreFailure) {
        // Surface as ACP error (SDK wraps thrown errors into JSON-RPC error
        // responses). Distinguishing from refusal lets clients show "agent
        // infrastructure failure" rather than "agent refused to continue".
        throw new Error(`EventStore failure: ${(error.cause as Error)?.message ?? "unknown"}`);
      }
      throw error;
    }

    return { stopReason: mapStopReason(coreStopReason) };
  }

  async cancel(params: CancelNotification): Promise<void> {
    if (params.sessionId !== this.sessionId) {
      return;
    }
    await this.engine.cancelTurn({ sessionId: this.sessionId });
  }
}

// ---- helpers ----

// Per ACP spec, baseline Agent capability mandates support for `text` AND
// `resource_link` ContentBlocks regardless of advertised promptCapabilities:
//
// > As a baseline, the Agent MUST support `ContentBlock::Text` and
// > `ContentBlock::ResourceLink`.
// > `PromptCapabilities` opt-ins are only for the extended variants
// > (`image`, `audio`, embedded `resource`).
//
// For resource_link M1 doesn't yet dereference the URI (no fs/http access
// in this slice; M3 ToolRouter + M9a sandbox would gate that). What we DO
// do is preserve the link metadata deterministically inside the
// user.message payload so:
//   - replay/audit can reconstruct exactly what the client sent;
//   - downstream layers (M2 ContextBuilder / M4 memory) can choose to
//     fetch the resource later;
//   - a fake model still sees a stable textual representation.
//
// Returns null when the prompt is empty or contains a block we can't
// represent (image / audio / embedded resource).
function extractPromptText(blocks: readonly ContentBlock[]): string | null {
  if (blocks.length === 0) return null;
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        parts.push(block.text);
        break;
      case "resource_link": {
        // Deterministic Markdown-link rendering. Includes name (REQUIRED per
        // ACP schema) + uri (REQUIRED), plus mimeType if present so a
        // future agent can decide how to handle it.
        const mimeSuffix = block.mimeType ? ` (${block.mimeType})` : "";
        parts.push(`[${block.name}](${block.uri})${mimeSuffix}`);
        break;
      }
      default:
        return null;
    }
  }
  return parts.join("");
}

function mapStopReason(coreReason: "final" | "cancelled" | "error"): StopReason {
  switch (coreReason) {
    case "final":
      return "end_turn";
    case "cancelled":
      return "cancelled";
    case "error":
      // ACP doesn't have a generic "internal_error" stopReason; "refusal"
      // is the closest available terminal state. A future ACP revision
      // may add a discriminated error stop reason; until then we surface
      // infrastructure errors as thrown exceptions via the SDK error path
      // (see prompt() above) and only fall through here for provider-side
      // errors (e.g. provider's stream yielded { type: "failed" }).
      return "refusal";
  }
}

function resolveEventLogRoot(override: string | undefined): string {
  if (override) {
    mkdirSync(override, { recursive: true });
    return override;
  }
  return mkdtempSync(join(tmpdir(), "acp-server-"));
}
