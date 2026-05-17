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

Documentation is language-scoped. Chinese is the default working documentation, and English is maintained under `docs/en` for later synchronization.

- [Documentation Index](docs/README.md)
- [中文文档](docs/zh/README.md)
- [可行性复盘](docs/zh/00-feasibility-review.md)
- [架构设计](docs/zh/01-architecture-design.md)
- [可执行路线图](docs/zh/02-roadmap.md)
- [质量、CI 与测试策略](docs/zh/03-quality-ci-test-strategy.md)
- [AI 协作治理与主线规则](docs/zh/04-ai-governance-mainline.md)
- [Web Client 回归方案](docs/zh/05-web-client-regression.md)
- [实施 Backlog](docs/zh/06-implementation-backlog.md)
