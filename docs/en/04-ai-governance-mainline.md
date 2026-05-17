# AI Governance and Mainline Rules

## Why This Exists

This project will likely be built with heavy AI assistance. That makes drift more likely:

- An agent may add convenient shortcuts.
- A provider adapter may leak into core.
- A Web feature may reach into storage directly.
- A skill may become a hidden policy layer.
- A memory feature may silently change behavior across sessions.

Governance exists to keep the project coherent after many assisted commits.

## Mainline Statement

The project mainline is:

> Build a local-first, event-sourced agent core with strict adapters for models, tools, memory, skills, protocols, and clients.

Every change must strengthen or preserve this line.

## Contribution Rules

### Rule 1: Roadmap Link

Every change must map to a roadmap item or an approved ADR.

No "while we are here" features.

### Rule 2: Core Isolation

The core owns orchestration, not UI or protocol details.

Forbidden:

- `core` importing Web, CLI, or ACP packages.
- `core` branching on raw provider payloads.
- `core` directly starting MCP processes.
- Client code mutating session storage directly.

### Rule 3: One Permission Gate

All tool execution must pass through `PermissionEngine`.

Forbidden:

- Skills executing shell directly.
- MCP calls bypassing approval.
- Web client calling tool executors directly.
- Background memory jobs writing without policy.

### Rule 4: Event Log Is Canonical

If something matters, it must be represented as an event.

Required events:

- Permission request and decision.
- Tool start and completion.
- Skill load.
- Memory candidate.
- Compaction.
- Errors.

### Rule 5: Memory Is Auditable

Memory must be inspectable, editable, and reversible.

Auto-memory starts as candidate diffs. Do not silently write durable memory in MVP.

### Rule 6: Skills Are Procedures, Not Backdoors

Skills may describe workflows and use allowed tools. They must not redefine architecture, bypass permission, or hide persistent behavior.

### Rule 7: Protocols Are Adapters

MCP and ACP are important, but they are not the core.

MCP belongs in the tool/context adapter layer. ACP belongs in the client/protocol adapter layer.

### Rule 8: Web Regression First

Every non-trivial behavior should be observable in Web before adding another client surface.

The Web client is not just UX. It is the debugging and regression harness.

## Required PR Metadata

Each PR must include:

- Roadmap item.
- Packages changed.
- Boundary impact.
- Permission impact.
- Memory/context impact.
- Test evidence.
- Web regression evidence.
- Rollback plan.
- `mainline-guardian` result.

## ADR Triggers

Write an ADR before:

- Adding a new package.
- Changing event schema.
- Adding a model provider interface capability.
- Adding a new execution tool.
- Changing permission policy semantics.
- Introducing automatic memory writes.
- Adding a new protocol adapter.
- Letting clients influence context construction.

## Smell List

Investigate immediately if a change introduces:

- Raw provider JSON in core tests.
- UI state imported by core.
- Tool execution without permission events.
- Memory writes that do not appear in transcript.
- Skills with broad, vague triggers.
- MCP tools automatically included without user visibility.
- Config keys read from multiple packages independently.
- Session state that cannot be rebuilt from JSONL.
- A feature with no Web regression scenario.

## Review Cadence

- Every PR: `mainline-guardian` review.
- Every milestone: architecture boundary review.
- Every release: replay compatibility review.
- Every month: roadmap pruning and ADR cleanup.
