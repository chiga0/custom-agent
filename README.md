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
docs/             Architecture, roadmap, CI, and governance docs
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

- [Feasibility Review](docs/00-feasibility-review.md)
- [Architecture Design](docs/01-architecture-design.md)
- [Executable Roadmap](docs/02-roadmap.md)
- [Quality, CI, and Test Strategy](docs/03-quality-ci-test-strategy.md)
- [AI Governance and Mainline Rules](docs/04-ai-governance-mainline.md)
- [Web Client Regression Plan](docs/05-web-client-regression.md)
- [Implementation Backlog](docs/06-implementation-backlog.md)
