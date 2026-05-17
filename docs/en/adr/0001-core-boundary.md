# ADR 0001: Core Boundary and Event-Sourced Architecture

Status: Accepted

Date: 2026-05-17

## Context

The project aims to support multiple client surfaces: Web, CLI, TUI, ACP, IDE, and channels. It also needs multiple model providers, local tools, MCP servers, skills, and memory.

Without a strict core boundary, client and provider details will leak into the agent loop.

## Decision

The project will use a local-first, event-sourced agent core.

The core owns:

- Session orchestration.
- Turn state machine.
- Context build request.
- Tool call lifecycle.
- Permission lifecycle.
- Event emission.
- Replay semantics.

The core does not own:

- Web UI.
- CLI rendering.
- ACP transport.
- Provider SDK payload details.
- MCP transport process management.
- Persistent UI state.

All meaningful runtime behavior must be represented in a versioned event schema.

## Consequences

Benefits:

- Clients can be thin.
- Session replay becomes testable.
- Web can serve as regression harness.
- ACP can be added without changing core behavior.
- Provider adapters can change without rewriting session logic.

Costs:

- Event schema design requires discipline.
- More adapter code is needed.
- Small shortcuts will be rejected if they cross boundaries.

## Enforcement

- Architecture fitness tests.
- Import boundary rules.
- `mainline-guardian` review.
- ADR required for boundary changes.
