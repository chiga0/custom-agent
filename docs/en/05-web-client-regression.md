# Web Client Regression Plan

## Purpose

The Web client should be the first client because it makes the agent observable. It should expose the exact event stream, tool calls, context construction, permissions, and diffs that other clients may hide.

This is how the project avoids debugging a black-box agent.

## MVP Web Screens

### Session List

Shows:

- Session id.
- CWD.
- Created time.
- Last turn status.
- Model.
- Error state.

### Transcript

Shows:

- User messages.
- Assistant deltas.
- Tool calls.
- Tool results.
- Final response.
- Compact summaries.

### Event Timeline

Shows every raw event in order, with filters:

- Model.
- Tool.
- Permission.
- Memory.
- Skill.
- Error.

### Permission Panel

Shows:

- Requested tool.
- Arguments.
- Risk class.
- CWD.
- Policy reason.
- Allow, deny, or edit decision.

### Tool Inspector

Shows:

- Tool source: local, MCP, skill.
- Input.
- Output.
- Duration.
- Truncation.
- Error.

### Diff Viewer

Shows:

- Files changed.
- Patch.
- User pre-existing changes warning.
- Generated changes by turn.

### Context Inspector

Shows:

- Instruction files loaded.
- Skills metadata loaded.
- Memory entries loaded.
- MCP resources included.
- Token budget.
- Truncation or compaction decisions.

### Regression Runner

Runs canned scenarios and stores:

- Input prompt.
- Fixture repo.
- Expected event predicates.
- Expected file diffs.
- Screenshots.
- Replay logs.

## Regression Scenario Format

Each scenario should define:

```yaml
id: basic-read-search
fixture: fixture-basic-js
model: fake-tool-model
prompt: "Find the add function and explain it."
expect:
  events:
    - tool.started: search_text
    - tool.completed: search_text
    - turn.completed
  filesChanged: []
```

## Initial Scenarios

### `session-basic-response`

Goal: prove session creation, streaming, and replay.

Expected:

- Session created.
- User message event.
- Model delta event.
- Turn completed.
- Replay matches live transcript.

### `permission-deny-shell`

Goal: prove dangerous tools can be denied.

Expected:

- Shell permission requested.
- User denies.
- Tool does not execute.
- Model receives denial result.

### `patch-small-file`

Goal: prove controlled file edit.

Expected:

- Read file.
- Patch permission requested.
- Patch applied.
- Diff displayed.
- Tests run after approval.

### `context-nested-agents`

Goal: prove instruction hierarchy.

Expected:

- Global instruction loaded.
- Project instruction loaded.
- Directory instruction loaded.
- Later instruction overrides earlier instruction in context order.

### `skill-lazy-load`

Goal: prove skills do not bloat base context.

Expected:

- Skill metadata available.
- Full skill body not loaded at session start.
- Skill loaded only after invocation.

### `mcp-stdio-tool`

Goal: prove MCP tool discovery and call.

Expected:

- MCP server initialized.
- Tools listed.
- Namespaced tool called.
- Permission event exists.

### `session-compact-resume`

Goal: prove compaction does not lose active instructions.

Expected:

- Context crosses budget threshold.
- Compaction event created.
- Session resumes.
- Instruction files still present in rebuilt context.

## Playwright Expectations

The UI tests should assert:

- No blank transcript during streaming.
- Permission panel appears before risky tool execution.
- Diff viewer renders changed files.
- Event filters work.
- Replay screen matches live transcript snapshot.

## Golden Event Tests

For each Web scenario, save a normalized event log fixture.

Normalize:

- Timestamps.
- Random ids.
- Durations.
- Provider request ids.

Do not normalize:

- Event order.
- Tool names.
- Permission decisions.
- File paths within fixture root.
- Error categories.
