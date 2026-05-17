# 可行性复盘

日期：2026-05-17

## 复盘范围

目标是从 0 构建一个类似 Claude Code、Codex、Gemini CLI、Qwen Code 的 Agent 工具，同时保证内部 core 可以复用于 Web、CLI、TUI、IDE、ACP 和各种 channel client。

本轮复盘覆盖：

- 模型通信。
- Session 管理。
- ACP 通信。
- MCP server 集成。
- Skill 加载。
- Memory 管理。
- CI、自动化测试和长期可维护性。

## 第一轮：产品范围可行性

结论：可行，但必须严格分阶段。

这类工具的共同形态已经很清晰：复用型 agent core、client adapter、MCP 外部能力、项目指令文件、skills、权限系统、session replay 和自动化回归。

最大风险不是技术不可做，而是第一版范围过大。不能一开始就同时做完整 CLI、IDE、ACP、多 provider、多 agent、memory 和插件市场。

MVP 必须裁剪：

- MVP 不做 multi-agent orchestration。
- MVP 不做 IDE extension。
- MVP 不做远端 cloud workspace。
- MVP 不做未经审查的自动 memory 写入。
- MVP 不做插件市场。
- MVP 不做复杂向量记忆，先用可审计 Markdown memory。

## 第二轮：架构可行性

结论：可行，但边界必须由代码和 CI 强制，而不能只靠约定。

核心架构应采用 event-first：

```text
User input -> SessionEngine -> ModelGateway -> ToolRouter -> PermissionEngine
                          |             |             |
                          v             v             v
                    EventLog       Provider API     Local/MCP tools
```

事件日志是产品骨架。Client 只消费和渲染事件，不拥有 agent 行为。这样 Web、CLI、ACP、IDE 和 channel client 才能保持薄适配层。

主要架构风险：

- Provider 的原始响应结构泄漏进 core。
- MCP 工具语义泄漏进 local tools。
- Web UI 为了方便直接访问 session 内部实现。
- Memory 变成无类型、不可审计的 prompt 文本堆。

必须设置的控制：

- 所有公共事件和工具契约进入 `schema` 包。
- `core` 禁止依赖任何 client package。
- Golden transcript replay 测试。
- 边界变更必须写 ADR。

## 第三轮：协议可行性

结论：可行，但 MCP 和 ACP 应分阶段接入。

MCP 应该先于 ACP。MCP 扩展 agent 能力，ACP 扩展 client 接入方式。Agent 自身必须先有用，再变成可被外部 client 驱动的协议服务。

推荐顺序：

1. 内部事件模型。
2. Local tools。
3. Stdio MCP client。
4. Streamable HTTP MCP client。
5. ACP server adapter。

MCP 最小实现：

- `initialize`。
- `tools/list`。
- `tools/call`。
- `resources/list`。
- `resources/read`。
- `prompts/list`。
- `prompts/get`。
- timeout、cancellation、health state、tool namespace。

ACP 最小实现：

- `initialize`。
- `session/new`。
- `session/load`。
- `session/prompt`。
- `session/cancel`。
- `session/update` notifications。
- permission request forwarding。

## 第四轮：安全可行性

结论：只有把权限收口到一个 `PermissionEngine` 才可行。

这是安全敏感项目，因为模型输出可能触发本地文件读写、shell、网络、MCP server 和 memory 写入。所有 model-suggested action 都必须当作不可信意图处理。

不可妥协的约束：

- 每次 tool invocation 都经过 `PermissionEngine`。
- MCP server 默认不可信。
- Skills 不能绕过权限。
- Memory 写入在成熟前必须先进入候选 diff，由用户审查。
- Shell 需要 command policy、timeout、cwd restriction、environment redaction、output budget。
- Tool output 重新进入上下文前必须被清洗和截断。

## 第五轮：可维护性可行性

结论：可行，但项目必须有主线，并持续拒绝偏离主线的“有用小功能”。

长期最大失败模式是架构熵增：provider、tools、UI、memory、protocol 相互交叉依赖，最后 core 无法安全改动。

项目主线：

> 构建一个 local-first、event-sourced 的 agent core，并用严格 adapter 隔离 models、tools、memory、skills、protocols 和 clients。

任何不强化或不保持这条主线的变更，都要被视为可疑。

必要治理：

- `AGENTS.md` 项目规则。
- `rules/mainline.md` 架构主线。
- `mainline-guardian` skill 做 AI-assisted review。
- PR template 要求 roadmap item、boundary impact、tests、rollback plan。
- CI 中加入 architecture fitness tests。

## 最终结论

方案可行。

第一交付物不应该是漂亮 CLI，而应该是围绕 agent core 的可复现 Web regression harness。这个选择会让之后 CLI、TUI、ACP、IDE、channel client 都能共享同一条 core event stream，并且可调试、可回放、可验证。

## 关键参考

- Claude Code overview and extension model: https://code.claude.com/docs/en/overview
- Claude memory model: https://code.claude.com/docs/en/memory
- OpenAI Codex `AGENTS.md`: https://developers.openai.com/codex/guides/agents-md
- MCP architecture: https://modelcontextprotocol.io/specification/2025-06-18/architecture
- MCP transports: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
- ACP overview: https://agentclientprotocol.com/protocol/overview
- Gemini CLI repository and docs: https://github.com/google-gemini/gemini-cli
- Qwen Code memory docs: https://qwenlm.github.io/qwen-code-docs/en/users/features/memory/
