# Project Instructions

## Mission

Build a local-first, event-sourced AI coding agent core with strict adapters for models, tools, memory, skills, protocols, and clients.

The Web client is the first regression and observability surface. CLI, ACP, IDE, and channel clients must remain adapters over the same core.

## Documentation Language

Planning documentation lives in `custom-agent-docs`: https://github.com/chiga0/custom-agent-docs

Chinese documentation in `custom-agent-docs/docs/zh` is the canonical working documentation.

When changing architecture, roadmap, CI, permissions, memory, MCP, ACP, skills, or governance rules, update `custom-agent-docs` first or in the same change sequence.

## Roadmap Coordination

Before starting non-trivial work, read `../custom-agent-docs/docs/zh/03-roadmap-status.md`. It is the centralized roadmap status source for parallel agent development.

Every PR must name its `Work ID` from the docs repo status document and include the docs commit SHA it is based on.

## Non-Negotiable Architecture Rules

- Keep `core` independent of Web, CLI, ACP, provider SDKs, and MCP transport details.
- All public contracts must live in a schema package.
- Every meaningful runtime action must produce an event.
- Every tool execution must pass through `PermissionEngine`.
- MCP servers, skills, and model outputs are untrusted by default.
- Auto-memory must start as reviewable candidate diffs, not silent writes.
- Skills must be lazy-loaded and must not bypass tool permissions.
- Web regression scenarios are required for non-trivial behavior.
- Add or update an ADR before changing a package boundary or protocol contract.

## Development Rules

- Every change must map to `custom-agent-docs/docs/zh/02-roadmap.md` or an approved ADR.
- Every implementation PR must map to a `Work ID` in `custom-agent-docs/docs/zh/03-roadmap-status.md`.
- Do not add "nice to have" features outside the current milestone.
- Do not duplicate event, tool, provider, permission, or config schemas.
- Do not introduce circular dependencies.
- Do not make clients write session storage directly.
- Do not let provider-specific raw payloads leak into core tests.
- Do not add a new tool without permission tests and Web visibility.
- Do not add memory behavior without audit and rollback behavior.

## Review Rule

Before merging any substantial change, run the `mainline-guardian` skill manually or through CI and resolve all blocking findings.
