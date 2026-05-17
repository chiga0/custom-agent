# Project Mainline

## Mainline Statement

Build a local-first, event-sourced agent core with strict adapters for models, tools, memory, skills, protocols, and clients.

## What Belongs On The Mainline

- Session engine.
- Canonical event log.
- Schema-first contracts.
- Model provider adapters.
- Tool router.
- Permission engine.
- Local tools.
- MCP client.
- ACP adapter.
- Instruction files.
- Lazy-loaded skills.
- Auditable memory.
- Web regression harness.
- CI architecture fitness tests.

## What Is Off-Mainline For MVP

- Multi-agent orchestration.
- Plugin marketplace.
- Remote cloud workspace.
- Mobile app.
- Autonomous memory writes without review.
- Vector memory.
- IDE-specific custom logic in core.
- Provider-specific logic in core.
- MCP server implementation beyond test fixtures.

## Required Check Before Any Change

Ask:

1. Which roadmap item does this serve?
2. Which package owns it?
3. Does it preserve the core boundary?
4. Does it pass through the permission engine if it executes anything?
5. Is the behavior visible in the event log?
6. Is the behavior visible in Web regression?
7. Does it add a new architectural decision that needs an ADR?

If any answer is unclear, stop and clarify before implementation.
