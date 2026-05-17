# Feasibility Review

Date: 2026-05-17

## Scope Reviewed

The proposal is to build an agent tool comparable to Claude Code, Codex, Gemini CLI, and Qwen Code, while keeping the internal core reusable across CLI, Web, IDE, ACP, and channel clients.

The reviewed core includes:

- Model communication.
- Session management.
- ACP communication.
- MCP server integration.
- Skill loading.
- Memory management.
- CI, regression, and long-term maintainability controls.

## Review Round 1: Product and Scope Feasibility

Verdict: feasible, with strict sequencing.

The idea is not only feasible, it is the correct decomposition for this class of product. The existing tools all converge on the same shape: a reusable agent core, protocol/client adapters, MCP for external capabilities, persistent instruction files, skills, permissions, and session replay.

The main feasibility risk is scope explosion. Building "Claude Code + Codex + Gemini CLI + Qwen Code" as one first release is too broad. Building a small, inspectable core with one Web client and one model provider is realistic.

Required scope cut for MVP:

- No multi-agent orchestration in MVP.
- No custom IDE extension in MVP.
- No remote cloud workspace in MVP.
- No autonomous auto-memory writes without review.
- No general plugin marketplace in MVP.
- No complex vector memory until deterministic Markdown memory is proven insufficient.

## Review Round 2: Architecture Feasibility

Verdict: feasible if boundaries are enforced by code and CI, not by convention alone.

The architecture should be event-first:

```text
User input -> SessionEngine -> ModelGateway -> ToolRouter -> PermissionEngine
                          |             |             |
                          v             v             v
                    EventLog       Provider API     Local/MCP tools
```

The strongest design choice is to make the event log the canonical contract. Clients should render events; they should not own agent logic. This keeps Web, CLI, ACP, and future channel clients thin.

Architecture risk:

- Provider-specific response shapes leaking into core.
- MCP-specific tool semantics leaking into local tools.
- Web UI convenience code reaching into session internals.
- Memory becoming an untyped pile of prompt text.

Required controls:

- Schema package for all public events and tool contracts.
- Dependency rules that prevent `core` from importing any client package.
- Golden transcript replay tests.
- ADR required for any boundary change.

## Review Round 3: Protocol Feasibility

Verdict: feasible, but MCP and ACP should be staged separately.

MCP should arrive before ACP because MCP expands agent capability, while ACP expands client surfaces. The local agent must be useful before it becomes protocol-accessible.

Recommended protocol order:

1. Internal event model.
2. Local tools.
3. Stdio MCP client.
4. Streamable HTTP MCP client.
5. ACP server adapter.

MCP implementation minimum:

- `initialize`.
- `tools/list`.
- `tools/call`.
- `resources/list`.
- `resources/read`.
- `prompts/list`.
- `prompts/get`.
- Timeout, cancellation, health state, and tool namespace handling.

ACP implementation minimum:

- `initialize`.
- `session/new`.
- `session/load`.
- `session/prompt`.
- `session/cancel`.
- `session/update` notifications.
- Permission request forwarding.

## Review Round 4: Security Feasibility

Verdict: feasible only with one central permission engine.

This project is security-sensitive because untrusted model output can trigger local files, shell commands, network calls, MCP servers, and memory updates. The project must treat all model-suggested actions as untrusted intent.

Non-negotiable constraints:

- Every tool invocation passes through `PermissionEngine`.
- MCP servers are untrusted by default.
- Skills cannot bypass permissions.
- Memory writes require explicit review until the project has mature memory diffing.
- Shell execution has a command policy, timeout, cwd restriction, environment redaction, and output budget.
- Tool outputs are sanitized before being reintroduced into model context.

## Review Round 5: Maintainability Feasibility

Verdict: feasible if the project has a mainline and rejects attractive detours.

The biggest long-term failure mode is not technical impossibility. It is architectural entropy: providers, tools, UI, memory, and protocols slowly cross-import each other until the agent cannot be changed safely.

The project needs a written mainline:

> Build a local-first, event-sourced agent core with strict adapters for models, tools, memory, skills, protocols, and clients.

Any change that does not strengthen that mainline must be treated as suspect, even if it is useful in isolation.

Required governance:

- `AGENTS.md` project rules.
- `rules/mainline.md` architectural doctrine.
- `mainline-guardian` skill for AI-assisted review.
- PR template requiring roadmap item, boundary impact, tests, and rollback plan.
- Architecture fitness tests in CI.

## Final Verdict

The plan is feasible.

The project should proceed only if the first deliverable is not "a polished CLI", but a reproducible Web-based regression harness around the agent core. That choice makes every later client safer: CLI, TUI, ACP, IDE, and channel integrations can all be tested against the same core event stream.

## Key Source Anchors

- Claude Code overview and extension model: https://code.claude.com/docs/en/overview
- Claude memory model: https://code.claude.com/docs/en/memory
- OpenAI Codex `AGENTS.md`: https://developers.openai.com/codex/guides/agents-md
- MCP architecture: https://modelcontextprotocol.io/specification/2025-06-18/architecture
- MCP transports: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
- ACP overview: https://agentclientprotocol.com/protocol/overview
- Gemini CLI repository and docs: https://github.com/google-gemini/gemini-cli
- Qwen Code memory docs: https://qwenlm.github.io/qwen-code-docs/en/users/features/memory/
