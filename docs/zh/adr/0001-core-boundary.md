# ADR 0001: Core 边界与 Event-Sourced 架构

状态：Accepted

日期：2026-05-17

## 背景

项目目标是支持多个 client surface：Web、CLI、TUI、ACP、IDE 和 channel。项目也需要多个 model providers、local tools、MCP servers、skills 和 memory。

如果没有严格 core boundary，client 和 provider 细节会逐步泄漏到 agent loop。

## 决策

项目采用 local-first、event-sourced agent core。

Core 负责：

- Session orchestration。
- Turn state machine。
- Context build request。
- Tool call lifecycle。
- Permission lifecycle。
- Event emission。
- Replay semantics。

Core 不负责：

- Web UI。
- CLI rendering。
- ACP transport。
- Provider SDK payload details。
- MCP transport process management。
- Persistent UI state。

所有重要 runtime behavior 都必须进入 versioned event schema。

## 后果

收益：

- Clients 可以保持很薄。
- Session replay 可测试。
- Web 可以作为 regression harness。
- ACP 可以在不改变 core behavior 的情况下加入。
- Provider adapters 可以独立演进。

成本：

- Event schema 需要纪律。
- Adapter code 会更多。
- 任何跨边界 shortcut 都要被拒绝。

## 执行约束

- Architecture fitness tests。
- Import boundary rules。
- `mainline-guardian` review。
- Boundary changes 必须写 ADR。
