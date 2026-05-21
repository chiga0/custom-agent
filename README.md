# Custom Agent


Custom Agent is a local-first AI coding agent project. The core idea is to build an event-sourced agent engine that can be reused by Web, CLI, ACP, IDE, and channel clients without mixing UI, provider, tool, memory, or protocol concerns.

## Project Mainline

Build a local-first, event-sourced agent core with strict adapters for models, tools, memory, skills, protocols, and clients.

## Repository Layout

```text
apps/
  web-client      Web regression and observability surface
  cli             Future CLI adapter
  acp-server      Future ACP adapter
packages/
  schema          Shared public contracts
  core            Session orchestration boundary
  storage         Event log and indexes
  permissions     Central permission policy
docs/             Language-scoped architecture, roadmap, CI, and governance docs
rules/            Project mainline rules
skills/           Project-specific AI review skills
tests/            Cross-package architecture tests
```

## First Milestone

The current repository state implements the M0 project spine:

- Monorepo skeleton.
- Shared event schema.
- Minimal core package.
- Minimal storage and permission package placeholders.
- Buildable Web client shell.
- Architecture fitness test.
- CI outline.
- Project governance docs and mainline review skill.

## Commands

```bash
npm install
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run test:architecture
npm run build:web
```

## Docs

Planning docs live in the separate source-of-truth repository:

- [custom-agent-docs](https://github.com/chiga0/custom-agent-docs)
- Local recommended path: `../custom-agent-docs`
- Roadmap status: `../custom-agent-docs/docs/zh/03-roadmap-status.md`
- Repository relationship: `../custom-agent-docs/docs/zh/08-repository-relationship.md`

This implementation repository keeps only local development notes and links to the docs source of truth.
