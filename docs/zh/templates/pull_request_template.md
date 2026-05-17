# Pull Request

## Roadmap / ADR

- Roadmap item：
- ADR：

## 摘要

-

## 变更包

-

## 边界影响

- [ ] 没有 core/client boundary change。
- [ ] 没有 provider payload 泄漏进 core。
- [ ] 没有 MCP transport 泄漏进 core。
- [ ] 没有 client 直接写 session storage。

## 权限影响

- [ ] 没有 tool execution behavior change。
- [ ] Tool execution 仍经过 `PermissionEngine`。
- [ ] 需要时已添加 permission tests。

## Memory / Context 影响

- [ ] 没有 memory behavior change。
- [ ] Memory changes 可审计、可回滚。
- [ ] Context budget behavior 变更已测试。

## Event / Replay 影响

- [ ] 没有 event schema change。
- [ ] Event schema fixtures 已更新。
- [ ] Replay tests 已更新。

## 测试

-

## Web Regression

-

## Mainline Guardian

结果：

Blocking findings：

## Rollback Plan

-
