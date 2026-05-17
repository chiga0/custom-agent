# 质量、CI 与测试策略

## 质量目标

这个项目要按基础设施标准建设。Agent 会触碰用户文件、执行命令、连接外部工具。坏抽象不只是难看，还可能不安全。

质量目标：

- Deterministic replay。
- Centralized permissions。
- Strict package boundaries。
- Typed protocol contracts。
- Web regression visibility。
- Core 中没有隐藏 provider、MCP 或 UI coupling。

## CI Pipeline

推荐 CI stages：

1. Format check。
2. Lint。
3. Typecheck。
4. Unit tests。
5. Contract tests。
6. Architecture fitness tests。
7. Web build。
8. Playwright regression tests。
9. Security checks。
10. Release dry run。

## 测试金字塔

### Unit Tests

覆盖重点：

- Session state machine。
- Context builder。
- Permission policies。
- Tool argument validation。
- Memory import parsing。
- Skill metadata parsing。
- Event schema migrations。

规则：

- Unit tests 不能调用真实模型 API。
- Unit tests 不能执行真实 destructive shell commands。
- Core tests 使用 fake providers 和 fake tools。

### Contract Tests

覆盖重点：

- Model provider stream normalization。
- MCP client behavior。
- ACP server behavior。
- Tool schema compatibility。

方法：

- 使用 recorded provider fixtures。
- 使用 fake MCP servers。
- 使用 JSON-RPC fixture messages。
- Adapter 边界必须校验所有 external payload。

### Integration Tests

覆盖重点：

- Fake model 请求 tools 的完整 turn。
- Local tools 在 fixture repo 上执行完整 turn。
- Permission prompt lifecycle。
- Crash 后 session replay。
- Compaction 与 resume。

### Web Regression Tests

Web 是可见回归面，建议使用 Playwright。

场景：

- Create session。
- Stream fake model response。
- Approve tool call。
- Deny tool call。
- Render diff。
- Replay session。
- Inspect context budget。
- Inspect MCP server state。
- Run roadmap scenario fixture。

### Architecture Fitness Tests

这些测试用于阻止架构漂移。

检查：

- `packages/core` 不 import `apps/*`。
- `packages/core` 不 import provider SDK。
- `packages/core` 不 import MCP transport implementations。
- `apps/*` 不直接写 session storage。
- Tool executors 不能绕过 permission decision。
- 每个 event type 都有 schema 和 fixture。
- 每个 public package 都有 owner 和 README。

### Security Tests

最小用例：

- Shell denylist/allowlist。
- Tool output 中的 prompt injection。
- MCP tool 请求危险动作。
- Skill 尝试使用未声明 tool。
- Secret-looking output redaction。
- Path traversal。
- Symlink behavior in file tools。
- Large output truncation。

## Release Gates

Release candidate 必须通过：

- 全部 CI stages。
- Web regression suite。
- 最近 session logs 的 replay compatibility tests。
- Permission bypass tests。
- 新 tools、permissions、memory behavior 的人工审查。

## Test Fixtures

推荐 fixture repos：

- `fixture-basic-js`：小型 Node project。
- `fixture-python`：小型 Python package。
- `fixture-large-tree`：大量文件用于 context/search 压测。
- `fixture-git-dirty`：包含用户已有改动的 repo。
- `fixture-mcp-server`：确定性 fake MCP server。

## Observability

本地记录：

- Session id。
- Turn id。
- Model provider and model。
- Token usage。
- Context budget usage。
- Tool call count。
- Tool duration。
- Permission decisions。
- Errors by category。

不要记录 secrets。Redaction 必须在持久化日志前执行。

## Code Review Checklist

每个 PR 必须回答：

- 实现哪个 roadmap item？
- 哪个 package 拥有该行为？
- 是否引入新边界？
- 是否改变权限行为？
- 是否改变 memory 行为？
- 是否改变 context construction？
- 哪个 Web regression scenario 证明它？
- 回滚路径是什么？
