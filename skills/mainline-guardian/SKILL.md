---
name: mainline-guardian
description: Review a planned or completed change against the project mainline, architecture boundaries, permission model, memory rules, and roadmap alignment.
allowed_tools:
  - read_file
  - search_text
  - git_diff
  - list_files
---

# Mainline Guardian

Use this skill before implementing, reviewing, or merging a non-trivial change.

## Mainline

The project exists to build a local-first, event-sourced agent core with strict adapters for models, tools, memory, skills, protocols, and clients.

## Review Inputs

Collect:

- Roadmap item or ADR id.
- Work ID from `custom-agent-docs/docs/zh/07-roadmap-status.md`.
- Docs commit SHA used by the implementation PR.
- Roadmap status update.
- Changed files.
- Package ownership.
- New dependencies.
- Event schema changes.
- Permission behavior changes.
- Memory/context changes.
- Web regression evidence.
- Tests added or updated.

## Blocking Findings

Report a blocking finding if the change:

- Does not map to a roadmap item or ADR.
- Does not map to a Work ID for implementation work.
- Changes implementation status but does not update `custom-agent-docs/docs/zh/07-roadmap-status.md`.
- Makes `core` depend on a client, provider SDK, or MCP transport.
- Executes a tool without `PermissionEngine`.
- Adds runtime behavior that is not represented in the event log.
- Adds memory writes that are not auditable and reversible.
- Adds a skill that can bypass allowed tools.
- Changes context construction without context inspector or tests.
- Adds protocol behavior directly into core.
- Has no Web regression scenario for user-visible behavior.
- Introduces duplicate schemas or ad hoc payload parsing.

## Review Output

Return:

```text
Mainline Guardian Result: PASS | FAIL

Roadmap alignment:
- ...

Roadmap status:
- ...

Boundary review:
- ...

Permission review:
- ...

Memory/context review:
- ...

Event/replay review:
- ...

Test and Web regression review:
- ...

Blocking findings:
- [P0/P1] ...

Non-blocking suggestions:
- ...
```

## Pass Criteria

A change passes only when:

- It clearly advances the roadmap or an ADR.
- Boundaries remain intact.
- Permission flow remains centralized.
- Event replay remains possible.
- Memory remains auditable.
- Tests and Web regression cover the behavior.
