# Implementation Backlog

This backlog converts the roadmap into issue-sized work. Each item should become one PR unless the implementation proves smaller.

## Definition of Done for Every Item

- Roadmap id is named in PR.
- Package ownership is clear.
- Tests are added or updated.
- Web regression impact is documented.
- No architecture fitness rule is weakened.
- `mainline-guardian` has no blocking finding.

## M0: Project Spine

### M0-01: Create Monorepo Skeleton

Depends on: none

Deliverables:

- `apps/web-client`.
- `apps/cli`.
- `apps/acp-server`.
- `packages/core`.
- `packages/schema`.
- `packages/storage`.
- `packages/permissions`.

Tests:

- Workspace install.
- Empty package typecheck.

Acceptance:

- CI can discover all packages.
- No package has circular dependencies.

### M0-02: Add Architecture Fitness Test Harness

Depends on: M0-01

Deliverables:

- Import boundary test.
- Circular dependency test.
- Forbidden dependency list.

Tests:

- Positive fixture.
- Negative fixture that fails on `core -> apps/*`.

Acceptance:

- CI fails when core imports a client package.

### M0-03: Add Event Schema Foundation

Depends on: M0-01

Deliverables:

- Versioned event envelope.
- Initial event union.
- Fixture normalization helper.

Tests:

- Schema parse tests.
- Fixture round-trip tests.

Acceptance:

- A fake event log validates fully from disk.

### M0-04: Add Web Shell

Depends on: M0-03

Deliverables:

- Session list screen.
- Transcript screen.
- Event timeline screen.
- Fixture event loader.

Tests:

- Playwright loads fixture session.
- Screenshot smoke test.

Acceptance:

- Web renders a static fake session without a backend.

## M1: Session Core

### M1-01: Implement Append-Only Event Log

Depends on: M0-03

Deliverables:

- JSONL writer.
- JSONL reader.
- Event ordering guarantees.
- Corrupt-line recovery policy.

Tests:

- Append/replay test.
- Crash-safe partial write test.

Acceptance:

- Replay returns exactly the events that were committed.

### M1-02: Implement Session Index

Depends on: M1-01

Deliverables:

- SQLite session index.
- Turn index.
- Rebuild index from JSONL.

Tests:

- Index rebuild test.
- Missing index recovery test.

Acceptance:

- Deleting SQLite and rebuilding from JSONL restores session list.

### M1-03: Implement Fake Provider Turn

Depends on: M1-01

Deliverables:

- `SessionEngine.createSession`.
- `SessionEngine.runTurn`.
- Fake streaming model provider.

Tests:

- Turn state machine test.
- Cancellation test.

Acceptance:

- Web can display live fake streaming from backend events.

### M1-04: Implement Replay API

Depends on: M1-01, M1-03

Deliverables:

- Session replay endpoint/API.
- Normalized transcript projection.

Tests:

- Golden transcript test.
- Replay/live equivalence test.

Acceptance:

- Web replay matches the live transcript.

## M2: Model Gateway

### M2-01: Define Model Provider Port

Depends on: M1-03

Deliverables:

- Provider interface.
- Normalized stream event types.
- Capability model.

Tests:

- Fake provider contract test.

Acceptance:

- Core depends only on provider port, not SDKs.

### M2-02: Add First Real Provider

Depends on: M2-01

Deliverables:

- One provider adapter.
- Fixture recording format.
- Error normalization.

Tests:

- Recorded stream fixture test.
- Network-disabled CI test.

Acceptance:

- Real provider works locally.
- CI can test provider behavior without network.

## M3: Tools and Permissions

### M3-01: Implement Permission Engine

Depends on: M1-03

Deliverables:

- Permission request schema.
- Policy evaluator.
- Ask/allow/deny decisions.

Tests:

- Policy matrix tests.
- Permission event emission tests.

Acceptance:

- No tool executor can be reached without a permission result.

### M3-02: Implement Read/Search Tools

Depends on: M3-01

Deliverables:

- `read_file`.
- `list_files`.
- `search_text`.
- Output budget.

Tests:

- Path safety tests.
- Gitignore behavior tests.
- Output truncation tests.

Acceptance:

- Read-only tool calls are visible in Web event timeline.

### M3-03: Implement Shell Tool

Depends on: M3-01

Deliverables:

- Command execution.
- Timeout.
- CWD restriction.
- Environment redaction.

Tests:

- Deny dangerous command.
- Timeout.
- Output budget.

Acceptance:

- Risky shell calls require approval by default.

### M3-04: Implement Patch Tool

Depends on: M3-01

Deliverables:

- Apply patch.
- Diff capture.
- Dirty worktree warning.

Tests:

- Patch success.
- Patch conflict.
- Existing user change preservation.

Acceptance:

- Web diff viewer shows generated changes by turn.

## M4: Context, Instructions, and Compaction

### M4-01: Implement Instruction Discovery

Depends on: M1-03

Deliverables:

- Global instruction file loading.
- Project instruction file loading.
- Directory-scoped instruction loading.
- Configurable fallback file names.

Tests:

- Nested instruction order.
- Override behavior.
- Missing file behavior.
- Max bytes behavior.

Acceptance:

- Web context inspector shows every loaded instruction source in order.

### M4-02: Implement Context Budget Accounting

Depends on: M4-01, M2-01

Deliverables:

- Context part model.
- Token estimation.
- Budget categories.
- Truncation policy.

Tests:

- Budget calculation fixtures.
- Deterministic truncation tests.

Acceptance:

- Every model request records a `context.built` event with budget details.

### M4-03: Implement Deterministic Compaction

Depends on: M4-02

Deliverables:

- Compaction trigger.
- Summary event.
- Replay integration.
- Instruction preservation.

Tests:

- Compaction replay test.
- Instruction survival test.
- Golden transcript after compaction.

Acceptance:

- A compacted session can continue and replay without losing active instructions.

### M4-04: Implement Memory Candidate Workflow

Depends on: M4-01

Deliverables:

- Memory candidate schema.
- Markdown diff candidate storage.
- Review/apply/discard model.
- Web memory candidate panel.

Tests:

- Candidate creation.
- Candidate apply.
- Candidate discard.
- Rollback.

Acceptance:

- No durable memory write can happen without an auditable candidate event.

## M5: Skills

### M5-01: Implement Skill Discovery

Depends on: M4-02

Deliverables:

- Skill directory scan.
- `SKILL.md` metadata parser.
- Skill registry.
- Startup metadata context.

Tests:

- Valid skill metadata.
- Invalid skill metadata.
- Duplicate skill names.

Acceptance:

- Base context includes skill metadata only, not full skill bodies.

### M5-02: Implement Skill Lazy Loading

Depends on: M5-01

Deliverables:

- Skill invocation model.
- Full body load on demand.
- `skill.loaded` event.
- Allowed tool policy.

Tests:

- Lazy-load behavior.
- Tool policy enforcement.
- Missing skill behavior.

Acceptance:

- Skill bodies load only when invoked and cannot exceed declared tool policy.

### M5-03: Add Skill UX and Regression

Depends on: M5-02

Deliverables:

- `/skill list`.
- `/skill run`.
- Web skill inspector.
- Regression skill fixture.

Tests:

- CLI command test.
- Web skill inspector test.
- End-to-end skill scenario.

Acceptance:

- A skill can drive a repeatable workflow with visible events and Web regression evidence.

## M6: MCP Stdio

### M6-01: Implement MCP Server Lifecycle

Depends on: M3-01

Deliverables:

- MCP server config schema.
- Stdio process startup.
- Initialize handshake.
- Shutdown.
- Health state.

Tests:

- Fake MCP server initialize.
- Startup failure.
- Shutdown cleanup.

Acceptance:

- Web MCP panel shows configured servers and health.

### M6-02: Implement MCP Tool Discovery and Calls

Depends on: M6-01

Deliverables:

- `tools/list`.
- `tools/call`.
- Tool namespace.
- Include/exclude config.
- Tool output normalization.

Tests:

- Tool list contract.
- Tool call contract.
- Namespace collision.
- Invalid arguments.

Acceptance:

- MCP tools appear in the tool registry with namespaced identifiers.

### M6-03: Integrate MCP With Permissions

Depends on: M6-02

Deliverables:

- MCP risk classification.
- Permission event integration.
- Timeout and cancellation.
- Server crash recovery behavior.

Tests:

- MCP tool requires approval.
- MCP timeout.
- MCP cancellation.
- MCP crash during call.

Acceptance:

- No MCP tool can execute without a permission decision.

## M7: MCP Resources, Prompts, and HTTP

### M7-01: Implement MCP Resources

Depends on: M6-01

Deliverables:

- `resources/list`.
- `resources/read`.
- Resource selection model.
- Web resource browser.

Tests:

- Resource list contract.
- Resource read contract.
- Explicit inclusion only.

Acceptance:

- MCP resources can be included in context only by explicit user or policy action.

### M7-02: Implement MCP Prompts

Depends on: M6-01

Deliverables:

- `prompts/list`.
- `prompts/get`.
- Prompt argument validation.
- Prompt invocation UX.

Tests:

- Prompt list contract.
- Prompt get contract.
- Missing argument behavior.

Acceptance:

- MCP prompts can be surfaced as user-invoked commands.

### M7-03: Implement Streamable HTTP MCP

Depends on: M6-02

Deliverables:

- HTTP transport.
- Protocol version header.
- Session id header handling.
- SSE response handling.
- Reconnect behavior.

Tests:

- HTTP initialize.
- SSE response stream.
- Session id propagation.
- 404 session restart behavior.

Acceptance:

- A Streamable HTTP MCP test server passes the same tool contract suite as stdio.

## M8: ACP Server

### M8-01: Implement ACP JSON-RPC Transport

Depends on: M1-04

Deliverables:

- JSON-RPC message parser.
- Request/response mapping.
- Error model.
- Initialization method.

Tests:

- Valid JSON-RPC request.
- Invalid JSON-RPC request.
- Initialize negotiation.

Acceptance:

- ACP client can initialize and receive declared capabilities.

### M8-02: Implement ACP Session Methods

Depends on: M8-01, M1-04

Deliverables:

- `session/new`.
- `session/load`.
- `session/prompt`.
- `session/cancel`.
- Session id mapping.

Tests:

- New session.
- Load session.
- Prompt session.
- Cancel turn.

Acceptance:

- ACP session behavior matches core session behavior.

### M8-03: Translate Core Events to ACP Updates

Depends on: M8-02

Deliverables:

- Event-to-update mapper.
- Permission request forwarding.
- Tool update forwarding.
- Plan/update extension hooks.

Tests:

- Streaming update fixture.
- Permission request fixture.
- Tool call fixture.

Acceptance:

- ACP replay and Web replay show equivalent turn semantics.

## M9: Hardening and Beta

### M9-01: Add Sandbox Execution Profiles

Depends on: M3-03

Deliverables:

- Sandbox config schema.
- Local sandbox adapter.
- Policy integration.
- Web sandbox visibility.

Tests:

- Read-only sandbox.
- Workspace-write sandbox.
- Denied path write.

Acceptance:

- Shell and patch behavior can be constrained by sandbox policy.

### M9-02: Add Secret Redaction and Audit Export

Depends on: M1-01, M3-03

Deliverables:

- Secret pattern redactor.
- Log redaction pipeline.
- Audit export.
- Redaction test fixtures.

Tests:

- API-key-like string redaction.
- Redaction before persistence.
- Audit export integrity.

Acceptance:

- Secret-looking values are redacted before durable logs.

### M9-03: Add Release Packaging

Depends on: M8-03

Deliverables:

- CLI package.
- Web build package.
- ACP server entrypoint.
- Version metadata.
- Release dry run.

Tests:

- Clean install smoke test.
- Version command.
- Packaged Web launch.

Acceptance:

- A clean machine can install and run the beta build.

### M9-04: Add Beta Regression Suite

Depends on: M9-01, M9-02

Deliverables:

- Fixture repo suite.
- Golden event logs.
- Playwright screenshot baselines.
- Replay compatibility suite.

Tests:

- Basic coding task.
- Permission denial.
- MCP tool call.
- Skill workflow.
- Compaction/resume.

Acceptance:

- Release candidates must pass the full beta regression suite.
