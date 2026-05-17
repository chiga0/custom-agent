# 可执行路线图

路线图以“可测试增量”为单位推进。每个 milestone 结束时都必须有可运行 Web 回归面，而不是只交付 library code。

## M0：项目骨架与治理

目标周期：1 周

目标：建立 repo skeleton、规则、CI baseline 和 architecture fitness checks，先把项目骨架立住。

任务：

- 创建 monorepo structure。
- 添加 `AGENTS.md`、`rules/mainline.md` 和 `mainline-guardian` skill。
- 添加 package boundary 和 import rules。
- 添加 schema package 和初始 event types。
- 添加 CI workflow skeleton。
- 添加 PR template。
- 添加 ADR template。
- 添加 Web app shell 和空 session list。

验收：

- CI 运行 lint、typecheck、unit tests、architecture checks。
- Fake session fixture 可以在 Web 渲染。
- 跨边界 import violation 会让 CI 失败。
- 每个 PR 必须引用 roadmap item。

## M1：Event-Sourced Session Core

目标周期：2 周

目标：构建不带 tools 的最小 session engine。

任务：

- 实现 append-only JSONL event log。
- 实现 SQLite session/turn index。
- 实现 `SessionEngine.createSession`。
- 实现使用 fake model provider 的 `SessionEngine.runTurn`。
- 实现 cancellation。
- 实现 session replay。
- 建立 Web event timeline 和 transcript viewer。

验收：

- User message 可以产生 deterministic fake assistant response。
- Session replay 能重建完全一致 transcript。
- Web 可以显示 live 和 replayed events。
- Golden transcript tests 通过。

## M2：Model Gateway

目标周期：2 周

目标：接入一个真实 model provider，并隐藏在 normalized stream interface 后面。

任务：

- 定义 `ModelProvider` interface。
- 先实现一个 provider，优先 OpenAI Responses 或 OpenAI-compatible。
- 规范化 text delta、tool call request、usage 和 errors。
- 添加 recorded response fixture tests。
- 添加 token 和 cost accounting fields。
- 添加 Web model request inspector。

验收：

- 一个真实模型可以在 session 中回答。
- Core 不使用 provider-specific raw payload。
- Fixture tests 不需要网络。
- Web 展示 model latency、usage 和 normalized stream events。

## M3：Local Tools 与 Permission Engine

目标周期：2 周

目标：让 agent 具备安全的本地 coding 能力。

任务：

- 实现 `PermissionEngine`。
- 实现 local tools：
  - `read_file`
  - `list_files`
  - `search_text`
  - `shell`
  - `apply_patch`
  - `git_diff`
- 添加 command risk classifier。
- 添加 output budget 和 truncation。
- 添加 Web approval UI。
- 添加 Web diff viewer。

验收：

- 每个 tool call 都有 permission event。
- Read-only tools 可被 policy 自动 approve。
- Shell 和 patch 默认需要 approval。
- Tool output 有边界，并在 Web 可见。
- Regression scenario 可以修改 fixture repo 并显示 diff。

## M4：Context Builder、Instructions 与 Compaction

目标周期：2 周

目标：让 session 能感知项目规则，同时避免上下文无限膨胀。

任务：

- 实现 instruction discovery：
  - global file
  - project root file
  - directory-scoped file
- 默认支持 `AGENTS.md`。
- 支持 configurable fallback names。
- 添加 context budget accounting。
- 添加 deterministic compaction。
- 添加 Web context inspector。

验收：

- Nested instructions 按文档顺序加载。
- Model call 前可见 context budget。
- Compaction 产生可 replay 的 `session.compacted` event。
- Instructions 在 compaction 后仍保留。

## M5：Skills

目标周期：2 周

目标：把可复用 workflow 打包为 skills，但不让它们污染每次 prompt。

任务：

- 实现 skill discovery。
- 解析 skill metadata。
- 启动时只加载 metadata。
- Invocation 时 lazy-load 完整 `SKILL.md`。
- 添加 `allowed_tools` enforcement。
- 添加 `/skill list` 和 `/skill run`。
- 添加 Web skill inspector。

验收：

- Skills 不能使用声明之外的 tools。
- Skill load events 出现在 transcript。
- Regression skill 可以跑一个文档化 workflow。
- 新增 skill 只增加 metadata 上下文，不加载完整 body。

## M6：MCP Stdio

目标周期：2 周

目标：通过 MCP 接入外部工具，同时不绕过权限。

任务：

- 实现 MCP stdio transport。
- 实现 server lifecycle。
- 实现 `initialize`。
- 实现 `tools/list` 和 `tools/call`。
- 实现 tool namespacing。
- 实现 include/exclude tool config。
- 添加 timeout、cancellation 和 health state。
- 添加 Web MCP server panel。

验收：

- 本地 MCP server 可以暴露 tool。
- MCP tool calls 经过 `PermissionEngine`。
- Tool name conflicts 通过 namespace 解决。
- Server crash 可见且可恢复。
- Fake MCP server contract tests 通过。

## M7：MCP Resources 与 Prompts

目标周期：1-2 周

目标：支持 MCP context 和 reusable prompt templates。

任务：

- 实现 `resources/list`。
- 实现 `resources/read`。
- 实现 `prompts/list`。
- 实现 `prompts/get`。
- 添加 resource selection model。
- 添加 prompt invocation model。
- 添加 Web resource/prompt browser。

验收：

- Resource content 只能显式加入 context。
- Prompt templates 可以由用户命令调用。
- MCP resources 不会自动倾倒进 model context。

## M8：ACP Server

目标周期：2 周

目标：把 core 暴露给 ACP-compatible clients。

任务：

- 实现 JSON-RPC server。
- 实现 `initialize`。
- 实现 `session/new`。
- 实现 `session/load`。
- 实现 `session/prompt`。
- 实现 `session/cancel`。
- 把 core events 转换为 ACP updates。
- 转发 permission requests。
- 添加 ACP protocol fixture tests。

验收：

- ACP client 可以启动 session 并接收 streamed updates。
- ACP session replay 与 Web replay 等价。
- ACP adapter 不拥有 agent 逻辑。
- ACP errors 有类型并被测试。

## M9：Hardening 与 Beta

目标周期：3-4 周

目标：让工具可靠到可以用于真实项目。

任务：

- 添加 sandbox profile support。
- 添加 secret redaction。
- 添加 audit log export。
- 添加 large output summarization。
- 添加 provider retry/backoff。
- 添加 failure taxonomy。
- 添加 benchmark scenarios。
- 添加 release packaging。

验收：

- Regression suite 覆盖常见 coding tasks。
- Permission bypass tests 通过。
- Large repo fixture 不会意外超出 context budget。
- Release 可以在干净机器安装使用。

## Roadmap 完成规则

任何 milestone 不能只靠代码完成，必须同时满足：

- 有 Web regression scenario。
- Unit tests 覆盖 core behavior。
- Contract tests 覆盖 external protocol behavior。
- 文档已更新。
- `mainline-guardian` 无 blocking findings。
