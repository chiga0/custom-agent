# Project Instructions

## Mission

Build a local-first, event-sourced AI coding agent core with strict adapters for models, tools, memory, skills, protocols, and clients.

The Web client is the first regression and observability surface. CLI, ACP, IDE, and channel clients must remain adapters over the same core.

## Documentation Language

Planning documentation lives in `custom-agent-docs`: https://github.com/chiga0/custom-agent-docs

Chinese documentation in `custom-agent-docs/docs/zh` is the canonical working documentation.

When changing architecture, roadmap, CI, permissions, memory, MCP, ACP, skills, or governance rules, update `custom-agent-docs` first or in the same change sequence.

`custom-agent-docs` is the centralized coordination source for active work, current technical design, roadmap status, and multi-agent process state. Docs-only updates to `custom-agent-docs` do not require a PR; push them directly so the coordination state stays current.

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

## Pull Request Module

Multi-agent collaboration depends on every PR being visible early and reviewed deeply. This section governs PR lifecycle, reviewer behavior, draft rules, and code-review quality.

### 1. PR Lifecycle (Author)

- **Open every PR as `draft` first.** Push the branch as soon as there is a meaningful first commit (scaffold + failing tests is fine; an empty branch is not). Open via `gh pr create --draft`. This makes the work visible, lets other agents leave comments and code suggestions during development, and prevents accidental early merges.
- **A PR based on an unmerged branch MUST stay `draft`.** If your branch is rebased on top of another open PR (because you depend on its in-flight changes), the PR must remain `draft` until that base PR is merged. This signals to other agents that the diff includes upstream-pending changes.
- **When the base branch is merged**, the author must:
  1. Immediately fetch and `git rebase main` (or the new base).
  2. Force-push the rebased branch.
  3. Promote the PR from `draft` to ready via `gh pr ready <number>` once Section 2 promotion checklist passes.
- **Promotion to "ready for review" requires all of:**
  - All deliverables for the `Work ID` are implemented.
  - `mainline-guardian` self-check is PASS.
  - `format:check`, `lint`, `typecheck`, `test`, `test:architecture`, `test:contract`, `test:security` pass locally.
  - Web regression suites (`build:web`, `test:web`) pass locally when the change is user-visible.
  - Tests cover all relevant levels (see Section 4 below): unit, integration, end-to-end where applicable.
  - PR description fully completed (Roadmap Status, Boundary/Permission/Memory/Event Impact, Tests, Web Regression, Mainline Guardian, Rollback Plan).
  - `custom-agent-docs/docs/zh/03-roadmap-status.md` updated (or a justification recorded for why an update is unnecessary).
- **Once promoted, follow the normal review/CI/merge gate** described in `custom-agent-docs/docs/zh/03-roadmap-status.md §10`.

### 2. Reviewer Responsibilities

Reviewing is not optional and not gated on being asked.

- **Proactively review every open PR (draft or ready) from other agents** as soon as you become aware of it. Do not wait for a request, mention, or assignment. The cost of an unreviewed multi-agent PR sitting open is misalignment for the whole team.
- **Always leave the review as a PR comment** (`gh pr review` or `gh pr comment`), not just chat or out-of-band notes. The PR thread is the only durable audit trail.
- **Every review comment must end with a "Generated by xx" attribution line** identifying the reviewer model, e.g. `Generated by Claude Opus 4.7` or `Generated by Codex GPT-4.1`. This lets downstream agents know who reviewed the work and weigh the perspective accordingly.
- **Self-approval is structurally blocked by GitHub.** Authors must not approve their own PRs even when acting in a reviewer role. If the project is currently single-maintainer, merge with `--admin` after a documented Round 2 PASS comment from the reviewer agent.

### 3. Reviewer Lifecycle on a Draft

Draft PRs are not "ignore until ready." During the draft phase, reviewer agents should:

- Triage the diff within one work cycle of becoming aware of the PR.
- Post `mainline-guardian`-formatted findings even if the PR is incomplete — the author wants to iterate against feedback, not surface bugs after they reach "ready."
- Re-review on every push that meaningfully changes the diff, not just on promotion.

### 4. Code Review Quality Standards

A review must **not** be limited to surface-level reading of the changed files. Every reviewer agent must, at minimum, evaluate:

- **Alignment with design docs.** Read the `custom-agent-docs/docs/zh/handbook` layer docs and any ADRs touched by the PR. Does the implementation match the documented contract? Do the events emitted match `agent-core.md`? Does the provider conform to `model-gateway.md`? If the PR contradicts the docs, that is a blocking finding.
- **Implementation soundness.** Is there a better algorithm, data structure, or API shape? Walk through the chosen approach and consider obvious alternatives. Document the trade-off you considered, not just "looks fine."
- **Feasibility & completeness.** Does the PR actually deliver the `Work ID` acceptance criteria? Are there missing branches, untested error paths, or `TODO`s pretending to be done?
- **Side effects.** What does this change break or weaken elsewhere? Cross-package contract changes, perf regressions, durability/concurrency invariants, schema migrations, replay equivalence — name the ones touched, not just "no side effects."
- **Test coverage at all relevant levels:**
  - Unit tests for individual functions and class methods.
  - Integration tests for cross-module interactions (e.g. SessionEngine + EventStore, storage + index).
  - End-to-end tests for user-visible flows (e.g. Web regression scenarios, ACP turn lifecycle).
  - State-machine tests for any FSM (turn lifecycle, permission flow, MCP handshake).
  - Failure-path and cancellation tests, not only happy paths.
- **Quality gates.** Run or verify the author has run: `format:check`, `lint`, `typecheck`, `test`, `test:architecture`, `test:contract`, `test:security`, `build:web`, `test:web`. CI green is necessary but not sufficient — confirm the suite actually exercises the change.
- **Documentation parity.** Has the author updated `03-roadmap-status.md`, the relevant handbook layer doc, ADRs, and any user-facing README/CHANGELOG? Missing roadmap updates are blocking.
- **Mainline / boundary discipline.** Does the change preserve every rule in `Non-Negotiable Architecture Rules`? In particular: does `core` stay independent of clients/SDKs/MCP? Does every meaningful runtime action emit an event? Does every tool path pass through `PermissionEngine`?

The above is a floor, not a ceiling. A shallow review that flags only typos, style nits, or "common pattern" suggestions is itself a blocking finding for the reviewer agent and should be redone.
