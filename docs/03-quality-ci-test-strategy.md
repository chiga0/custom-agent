# Quality, CI, and Test Strategy

## Quality Bar

This project must be treated as infrastructure. The agent will touch user files, execute commands, and connect to external tools. A broken abstraction is not just ugly; it can become unsafe.

Quality goals:

- Deterministic replay.
- Centralized permissions.
- Strict package boundaries.
- Typed protocol contracts.
- Regression visibility through Web.
- No hidden provider, MCP, or UI coupling in core.

## CI Pipeline

Recommended CI stages:

1. Format check.
2. Lint.
3. Typecheck.
4. Unit tests.
5. Contract tests.
6. Architecture fitness tests.
7. Web build.
8. Playwright regression tests.
9. Security checks.
10. Release dry run.

## Test Pyramid

### Unit Tests

Focus:

- Session state machine.
- Context builder.
- Permission policies.
- Tool argument validation.
- Memory import parsing.
- Skill metadata parsing.
- Event schema migrations.

Rules:

- Unit tests must not call real model APIs.
- Unit tests must not execute real destructive shell commands.
- Core tests should use fake providers and fake tools.

### Contract Tests

Focus:

- Model provider stream normalization.
- MCP client behavior.
- ACP server behavior.
- Tool schema compatibility.

Approach:

- Use recorded provider fixtures.
- Use fake MCP servers.
- Use JSON-RPC fixture messages.
- Validate every external payload at adapter boundaries.

### Integration Tests

Focus:

- Full turn with fake model requesting tools.
- Full turn with real local tools against fixture repo.
- Permission prompt lifecycle.
- Session replay after crash.
- Compaction and resume.

### Web Regression Tests

Use Playwright as the visible regression surface.

Scenarios:

- Create session.
- Stream fake model response.
- Approve tool call.
- Deny tool call.
- Render diff.
- Replay session.
- Inspect context budget.
- Inspect MCP server state.
- Run a roadmap scenario fixture.

### Architecture Fitness Tests

These are automated tests that prevent architectural drift.

Checks:

- `packages/core` does not import from `apps/*`.
- `packages/core` does not import provider SDKs.
- `packages/core` does not import MCP transport implementations.
- `apps/*` do not write session storage directly.
- Tool executors cannot be called without a permission decision.
- Every event type has a schema and fixture.
- Every public package has an owner and README.

### Security Tests

Minimum cases:

- Shell denylist/allowlist behavior.
- Prompt injection through tool output.
- MCP tool requesting dangerous action.
- Skill attempting undeclared tool use.
- Secret-looking output redaction.
- Path traversal attempts.
- Symlink behavior in file tools.
- Large output truncation.

## Release Gates

A release candidate must pass:

- All CI stages.
- Web regression suite.
- Replay compatibility tests for recent session logs.
- Permission bypass tests.
- Manual review of new tools, permissions, and memory behavior.

## Test Fixtures

Recommended fixture repos:

- `fixture-basic-js`: tiny Node project with tests.
- `fixture-python`: tiny Python package.
- `fixture-large-tree`: many files for context/search stress.
- `fixture-git-dirty`: repo with pre-existing user changes.
- `fixture-mcp-server`: deterministic fake MCP server.

## Observability

Record locally:

- Session id.
- Turn id.
- Model provider and model.
- Token usage.
- Context budget usage.
- Tool call count.
- Tool duration.
- Permission decisions.
- Errors by category.

Do not record secrets. Redaction must run before persistent logs.

## Code Review Checklist

Every PR must answer:

- Which roadmap item does this implement?
- Which package owns this behavior?
- Does this introduce a new boundary?
- Does this change permission behavior?
- Does this change memory behavior?
- Does this change context construction?
- What Web regression scenario proves it?
- What rollback path exists?
