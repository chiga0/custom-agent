# Web Client 回归方案

## 目的

Web client 是第一个 client，因为它让 agent 可观察。它要暴露完整 event stream、tool calls、context construction、permissions 和 diffs。

这样项目不会变成难以调试的黑盒 agent。

## MVP Web Screens

### Session List

展示：

- Session id。
- CWD。
- Created time。
- Last turn status。
- Model。
- Error state。

### Transcript

展示：

- User messages。
- Assistant deltas。
- Tool calls。
- Tool results。
- Final response。
- Compact summaries。

### Event Timeline

展示所有 raw events，并支持过滤：

- Model。
- Tool。
- Permission。
- Memory。
- Skill。
- Error。

### Permission Panel

展示：

- Requested tool。
- Arguments。
- Risk class。
- CWD。
- Policy reason。
- Allow、deny 或 edit decision。

### Tool Inspector

展示：

- Tool source：local、MCP、skill。
- Input。
- Output。
- Duration。
- Truncation。
- Error。

### Diff Viewer

展示：

- Files changed。
- Patch。
- 用户已有改动提醒。
- 当前 turn 生成的变更。

### Context Inspector

展示：

- Loaded instruction files。
- Loaded skill metadata。
- Loaded memory entries。
- Included MCP resources。
- Token budget。
- Truncation 或 compaction decisions。

### Regression Runner

运行 canned scenarios 并保存：

- Input prompt。
- Fixture repo。
- Expected event predicates。
- Expected file diffs。
- Screenshots。
- Replay logs。

## Regression Scenario Format

每个 scenario 定义：

```yaml
id: basic-read-search
fixture: fixture-basic-js
model: fake-tool-model
prompt: "Find the add function and explain it."
expect:
  events:
    - tool.started: search_text
    - tool.completed: search_text
    - turn.completed
  filesChanged: []
```

## 初始场景

### `session-basic-response`

目标：证明 session creation、streaming 和 replay。

预期：

- Session created。
- User message event。
- Model delta event。
- Turn completed。
- Replay matches live transcript。

### `permission-deny-shell`

目标：证明危险工具可以被拒绝。

预期：

- Shell permission requested。
- User denies。
- Tool does not execute。
- Model receives denial result。

### `patch-small-file`

目标：证明受控文件编辑。

预期：

- Read file。
- Patch permission requested。
- Patch applied。
- Diff displayed。
- Tests run after approval。

### `context-nested-agents`

目标：证明 instruction hierarchy。

预期：

- Global instruction loaded。
- Project instruction loaded。
- Directory instruction loaded。
- Later instruction overrides earlier instruction in context order。

### `skill-lazy-load`

目标：证明 skills 不膨胀 base context。

预期：

- Skill metadata available。
- Full skill body not loaded at session start。
- Skill loaded only after invocation。

### `mcp-stdio-tool`

目标：证明 MCP tool discovery 和 call。

预期：

- MCP server initialized。
- Tools listed。
- Namespaced tool called。
- Permission event exists。

### `session-compact-resume`

目标：证明 compaction 不会丢失 active instructions。

预期：

- Context crosses budget threshold。
- Compaction event created。
- Session resumes。
- Instruction files still present in rebuilt context。

## Playwright Expectations

UI tests 应断言：

- Streaming 时 transcript 不为空白。
- Risky tool execution 前出现 permission panel。
- Diff viewer 能渲染 changed files。
- Event filters 可用。
- Replay screen 与 live transcript snapshot 一致。

## Golden Event Tests

每个 Web scenario 保存 normalized event log fixture。

Normalize：

- Timestamps。
- Random ids。
- Durations。
- Provider request ids。

不要 normalize：

- Event order。
- Tool names。
- Permission decisions。
- Fixture root 内的 file paths。
- Error categories。
