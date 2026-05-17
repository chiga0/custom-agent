# Project Instructions

## Mission

Build a local-first, event-sourced AI coding agent core with strict adapters for models, tools, memory, skills, protocols, and clients.

The Web client is the first regression and observability surface. CLI, ACP, IDE, and channel clients must remain adapters over the same core.

## Documentation Language

Chinese documentation under `docs/zh` is the default working documentation. English documentation lives under `docs/en` and may be synchronized later.

When changing architecture, roadmap, CI, permissions, memory, MCP, ACP, skills, or governance rules, update `docs/zh` first.

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

- Every change must map to `docs/zh/02-roadmap.md` or an approved ADR.
- Do not add "nice to have" features outside the current milestone.
- Do not duplicate event, tool, provider, permission, or config schemas.
- Do not introduce circular dependencies.
- Do not make clients write session storage directly.
- Do not let provider-specific raw payloads leak into core tests.
- Do not add a new tool without permission tests and Web visibility.
- Do not add memory behavior without audit and rollback behavior.

## Review Rule

Before merging any substantial change, run the `mainline-guardian` skill manually or through CI and resolve all blocking findings.
