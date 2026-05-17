# Executable Roadmap

This roadmap is intentionally staged around testable increments. Each milestone should produce a working Web regression surface, not only library code.

## Milestone 0: Project Spine and Governance

Target: 1 week

Goal: create the repo skeleton, rules, CI baseline, and architectural fitness checks before agent behavior grows.

Tasks:

- Create monorepo structure.
- Add `AGENTS.md`, `rules/mainline.md`, and `mainline-guardian` skill.
- Add package boundaries and import rules.
- Add schema package with initial event types.
- Add CI workflow skeleton.
- Add PR template.
- Add ADR template.
- Add Web app shell with empty session list.

Acceptance criteria:

- CI runs lint, typecheck, unit tests, and architecture checks.
- A fake session fixture can be rendered in Web.
- Any cross-boundary import violation fails CI.
- Every PR must reference a roadmap item.

## Milestone 1: Event-Sourced Session Core

Target: 2 weeks

Goal: build a minimal session engine without tools.

Tasks:

- Implement append-only JSONL event log.
- Implement SQLite index for sessions and turns.
- Implement `SessionEngine.createSession`.
- Implement `SessionEngine.runTurn` with fake model provider.
- Implement cancellation.
- Implement session replay.
- Build Web event timeline and transcript viewer.

Acceptance criteria:

- A user message produces a deterministic fake assistant response.
- Session replay reconstructs the exact transcript.
- Web can display live and replayed events.
- Golden transcript tests pass.

## Milestone 2: Model Gateway

Target: 2 weeks

Goal: connect one real model provider behind the normalized stream interface.

Tasks:

- Define `ModelProvider` interface.
- Implement one provider first, preferably OpenAI Responses or OpenAI-compatible.
- Normalize text delta, tool call request, usage, and errors.
- Add provider fixture tests with recorded responses.
- Add token and cost accounting fields.
- Add Web model request inspector.

Acceptance criteria:

- A real model can answer in a session.
- Provider-specific raw payloads are not used by core.
- Fixture tests do not require network.
- Web shows model latency, usage, and normalized stream events.

## Milestone 3: Local Tools and Permission Engine

Target: 2 weeks

Goal: give the agent safe local coding capabilities.

Tasks:

- Implement `PermissionEngine`.
- Implement local tools:
  - `read_file`
  - `list_files`
  - `search_text`
  - `shell`
  - `apply_patch`
  - `git_diff`
- Add command risk classifier.
- Add output budget and truncation.
- Add Web approval UI.
- Add Web diff viewer.

Acceptance criteria:

- Every tool call has a permission event.
- Read-only tools can be auto-approved by policy.
- Shell and patch tools require approval by default.
- Tool output is bounded and visible in Web.
- Regression scenario can modify a fixture repo and show diff.

## Milestone 4: Context Builder, Instructions, and Compaction

Target: 2 weeks

Goal: make sessions aware of project rules without letting context become unbounded.

Tasks:

- Implement instruction discovery:
  - global file
  - project root file
  - directory-scoped file
- Support `AGENTS.md` as the default project instruction file.
- Add configurable fallback names.
- Add context budget accounting.
- Add deterministic compaction.
- Add Web context inspector.

Acceptance criteria:

- Nested instructions load in documented order.
- Context budget is visible before model call.
- Compaction creates a replayable `session.compacted` event.
- Instructions survive compaction.

## Milestone 5: Skills

Target: 2 weeks

Goal: package repeatable workflows without bloating every prompt.

Tasks:

- Implement skill discovery.
- Parse skill metadata.
- Load only metadata at startup.
- Lazy-load full `SKILL.md` on invocation.
- Add `allowed_tools` enforcement.
- Add `/skill list` and `/skill run`.
- Add Web skill inspector.

Acceptance criteria:

- Skills cannot use tools outside their declared policy.
- Skill load events appear in transcript.
- A regression skill can run a documented workflow.
- Adding a new skill does not change base context size except metadata.

## Milestone 6: MCP Stdio

Target: 2 weeks

Goal: connect external tools through MCP without bypassing permissions.

Tasks:

- Implement MCP stdio transport.
- Implement server lifecycle.
- Implement `initialize`.
- Implement `tools/list` and `tools/call`.
- Implement tool namespacing.
- Implement include/exclude tool config.
- Add timeout, cancellation, and health state.
- Add Web MCP server panel.

Acceptance criteria:

- A local MCP server can expose a tool.
- MCP tool calls go through `PermissionEngine`.
- Tool name conflicts are resolved by namespace.
- Server crash is visible and recoverable.
- MCP contract tests pass against a fake MCP server.

## Milestone 7: MCP Resources and Prompts

Target: 1-2 weeks

Goal: support MCP context and reusable prompt templates.

Tasks:

- Implement `resources/list`.
- Implement `resources/read`.
- Implement `prompts/list`.
- Implement `prompts/get`.
- Add resource selection model.
- Add prompt invocation model.
- Add Web resource and prompt browser.

Acceptance criteria:

- Resource content can be explicitly included in context.
- Prompt templates can be invoked by user command.
- MCP resources are not automatically dumped into model context.

## Milestone 8: ACP Server

Target: 2 weeks

Goal: expose the core to ACP-compatible clients.

Tasks:

- Implement JSON-RPC server.
- Implement `initialize`.
- Implement `session/new`.
- Implement `session/load`.
- Implement `session/prompt`.
- Implement `session/cancel`.
- Translate core events into ACP updates.
- Forward permission requests.
- Add ACP protocol fixture tests.

Acceptance criteria:

- ACP client can start a session and receive streamed updates.
- ACP session replay matches Web replay.
- ACP adapter owns no agent logic.
- ACP errors are typed and tested.

## Milestone 9: Hardening and Beta

Target: 3-4 weeks

Goal: make the tool reliable enough for real projects.

Tasks:

- Add sandbox profile support.
- Add secret redaction.
- Add audit log export.
- Add large output summarization.
- Add retry/backoff for providers.
- Add failure taxonomy.
- Add benchmark scenarios.
- Add release packaging.

Acceptance criteria:

- Regression suite covers common coding tasks.
- Permission bypass tests pass.
- Large repo fixture does not exceed context budget unexpectedly.
- A release can be installed and used on a clean machine.

## Roadmap Rule

No milestone should be considered complete until:

- Web regression scenario exists.
- Unit tests cover core behavior.
- Contract tests cover external protocol behavior.
- Documentation is updated.
- `mainline-guardian` review has no blocking findings.
