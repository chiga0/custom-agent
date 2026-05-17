# AI 协作治理与主线规则

## 为什么需要这份规则

这个项目很可能会大量使用 AI 辅助开发，因此更容易发生漂移：

- Agent 可能加入方便但破坏边界的 shortcut。
- Provider adapter 可能泄漏进 core。
- Web feature 可能直接操作 storage。
- Skill 可能变成隐藏 policy layer。
- Memory feature 可能跨 session 静默改变行为。

治理规则的目标是：多轮 AI-assisted commits 后，项目仍然保持可维护。

## 主线

> 构建一个 local-first、event-sourced 的 agent core，并用严格 adapter 隔离 models、tools、memory、skills、protocols 和 clients。

每个变更都必须强化或至少保持这条主线。

## 贡献规则

### 规则 1：必须关联 Roadmap

每个变更必须映射到 roadmap item 或已批准 ADR。

不接受“顺手加一下”的功能。

### 规则 2：Core Isolation

Core 只拥有 orchestration，不拥有 UI 或 protocol details。

禁止：

- `core` import Web、CLI 或 ACP packages。
- `core` 基于 raw provider payload 写分支。
- `core` 直接启动 MCP processes。
- Client code 直接修改 session storage。

### 规则 3：唯一权限入口

所有 tool execution 必须经过 `PermissionEngine`。

禁止：

- Skills 直接执行 shell。
- MCP calls 绕过 approval。
- Web client 直接调用 tool executors。
- Background memory jobs 未经 policy 直接写入。

### 规则 4：Event Log 是事实来源

重要行为必须有事件。

必需事件：

- Permission request and decision。
- Tool start and completion。
- Skill load。
- Memory candidate。
- Compaction。
- Errors。

### 规则 5：Memory 必须可审计

Memory 必须 inspectable、editable、reversible。

MVP 阶段 auto-memory 只能生成 candidate diffs，不能静默写入 durable memory。

### 规则 6：Skills 是流程，不是后门

Skills 可以描述 workflow 和使用 allowed tools，但不能重定义架构、绕过权限或隐藏持久化行为。

### 规则 7：Protocols 是 Adapters

MCP 和 ACP 很重要，但不是 core。

MCP 属于 tool/context adapter layer。ACP 属于 client/protocol adapter layer。

### 规则 8：Web Regression First

非平凡行为应先在 Web 中可见，再添加其他 client surface。

Web client 不只是 UX，也是 debugging 和 regression harness。

## PR 必填信息

每个 PR 必须包含：

- Roadmap item。
- Packages changed。
- Boundary impact。
- Permission impact。
- Memory/context impact。
- Test evidence。
- Web regression evidence。
- Rollback plan。
- `mainline-guardian` result。

## ADR 触发条件

以下变更必须先写 ADR：

- 新增 package。
- 改变 event schema。
- 新增 model provider capability。
- 新增 execution tool。
- 改变 permission policy semantics。
- 引入 automatic memory writes。
- 新增 protocol adapter。
- 允许 clients 影响 context construction。

## 坏味道清单

发现以下迹象要立即复盘：

- Raw provider JSON 出现在 core tests。
- UI state 被 core import。
- Tool execution 没有 permission events。
- Memory writes 不出现在 transcript。
- Skill trigger 宽泛模糊。
- MCP tools 自动加入而用户不可见。
- 多个 packages 独立读取同一 config key。
- Session state 不能从 JSONL 重建。
- 用户可见功能没有 Web regression scenario。

## Review 节奏

- 每个 PR：运行 `mainline-guardian` review。
- 每个 milestone：architecture boundary review。
- 每个 release：replay compatibility review。
- 每月：roadmap pruning 和 ADR cleanup。
