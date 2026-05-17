# Architecture Design

## Design Goal

Build a local-first AI coding agent whose core can be reused by Web, CLI, TUI, IDE, ACP, and channel clients.

The core should own agent behavior. Clients should only own presentation, input, approval UX, and rendering.

## Mainline

The project mainline is:

> A local-first, event-sourced agent core with strict adapters for models, tools, memory, skills, protocols, and clients.

This is the architectural anchor for all roadmap and code review decisions.

## System Shape

```text
apps/
  web-client
  cli
  acp-server

packages/
  core
  schema
  model-gateway
  tool-router
  local-tools
  mcp-client
  memory
  skills
  permissions
  storage
  telemetry
```

## Runtime Flow

```text
Client
  -> AgentHost API
  -> SessionEngine
  -> ContextBuilder
  -> ModelGateway
  -> ToolRouter
  -> PermissionEngine
  -> ToolExecutor
  -> EventLog
  -> Client event stream
```

The event stream is the product's backbone. A client can disconnect and reconnect because the session can replay events.

## Canonical Event Types

The event schema should be stable, versioned, and stored as JSONL.

Minimum event types:

- `session.created`
- `turn.started`
- `user.message`
- `context.built`
- `model.requested`
- `model.delta`
- `model.tool_call_requested`
- `permission.requested`
- `permission.resolved`
- `tool.started`
- `tool.delta`
- `tool.completed`
- `tool.failed`
- `memory.candidate_created`
- `skill.loaded`
- `turn.completed`
- `turn.failed`
- `session.compacted`

## Core Packages

### `schema`

Owns all public TypeScript/Zod schemas:

- Event schema.
- Tool schema.
- Session schema.
- Permission request schema.
- Provider normalized stream schema.
- MCP server config schema.

No package should define ad hoc copies of these contracts.

### `core`

Owns `SessionEngine`, turn state machine, cancellation, compaction triggers, and orchestration.

Must not import:

- Web UI.
- CLI UI.
- ACP server.
- Provider SDKs directly.
- MCP transport implementations directly.

It talks through ports/interfaces.

### `model-gateway`

Owns provider adapters:

- OpenAI Responses.
- Anthropic Messages.
- Gemini.
- OpenAI-compatible providers such as Qwen/DashScope/OpenRouter.

Provider outputs are normalized into core stream events. Provider-specific metadata may live in `_meta`, but the core must not branch on provider internals except via declared capabilities.

### `tool-router`

Owns tool discovery, tool namespace, tool eligibility, and tool-call routing.

Tool categories:

- Built-in local tools.
- MCP tools.
- Skill-provided scripts.
- Future remote tools.

The router does not execute directly. It asks `PermissionEngine`, then delegates to an executor.

### `permissions`

Owns approval and policy decisions.

Inputs:

- Tool name.
- Arguments.
- CWD.
- Session mode.
- Source: model, user, skill, MCP prompt.
- Risk classification.

Outputs:

- Allow.
- Deny.
- Ask user.
- Ask client via ACP.

### `mcp-client`

Owns MCP server lifecycle:

- Start stdio servers.
- Connect to Streamable HTTP servers.
- Initialize.
- Discover tools/resources/prompts.
- Call tools.
- Read resources.
- Handle health, timeout, and shutdown.

MCP tools are untrusted by default.

### `memory`

Owns context files and durable memory.

Layers:

1. Global user instructions.
2. Project instructions.
3. Directory-scoped instructions.
4. Reviewed project memory.
5. Reviewed user memory.
6. Auto-memory candidates.

Auto-memory starts as candidate diffs, not automatic writes.

### `skills`

Owns skill discovery and lazy loading.

A skill is a directory with `SKILL.md`.

Only skill metadata is loaded at startup:

- Name.
- Description.
- Trigger.
- Allowed tools.

The full skill body is loaded only when selected by user command, model tool choice, or router heuristic.

### `storage`

Owns:

- Session JSONL.
- SQLite indexes.
- Artifact files.
- Transcript replay.
- Compaction summaries.

The append-only event log is canonical. SQLite is an index, not the source of truth.

### `telemetry`

Owns local observability:

- Token usage.
- Latency.
- Tool duration.
- Permission decision counts.
- Error categories.
- Regression scenario result history.

Telemetry should be local-first and opt-in for remote export.

## Client Adapters

### Web Client

First-class test and regression surface.

Responsibilities:

- Session list.
- Event timeline.
- Transcript view.
- Tool call inspector.
- Permission approval panel.
- Diff viewer.
- Scenario runner.
- Replay viewer.

### CLI

Thin wrapper around the same host API.

Responsibilities:

- Prompt input.
- Stream output.
- Approval prompts.
- Slash commands.
- Non-interactive mode.

### ACP Server

Protocol adapter around core sessions.

Responsibilities:

- JSON-RPC transport.
- ACP method mapping.
- Session lifecycle.
- Permission forwarding.
- Event-to-`session/update` translation.

ACP must not own business logic.

## Configuration

Use layered config:

1. Built-in defaults.
2. System config.
3. User config.
4. Project config.
5. Environment variables.
6. CLI flags or client-provided session config.

Config must be validated at startup and surfaced in the Web client.

## Non-Goals for MVP

- Cloud execution.
- Plugin marketplace.
- Multi-agent teams.
- Mobile client.
- Background scheduled automations.
- Vector-store memory.
- Self-modifying system prompts.

## Architecture Fitness Rules

- `core` cannot import from `apps/*`.
- `core` cannot import provider SDKs.
- `core` cannot import MCP transport code directly.
- Tool calls cannot execute without a permission decision.
- Session state must be reconstructable from JSONL.
- Every new public event requires schema, fixture, replay test, and documentation.
- Every roadmap phase must end with Web regression scenarios.
