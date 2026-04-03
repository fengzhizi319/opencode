# Session & Memory 模块

Session 模块是会话管理、消息持久化、LLM 交互循环和记忆压缩的核心。

## 核心文件

- `packages/opencode/src/session/index.ts` — Session 服务（CRUD、消息管理）
- `packages/opencode/src/session/message-v2.ts` — 消息与 Part 数据模型
- `packages/opencode/src/session/prompt.ts` — 会话主循环（`loop`）
- `packages/opencode/src/session/processor.ts` — LLM 流事件处理器
- `packages/opencode/src/session/llm.ts` — LLM 调用封装
- `packages/opencode/src/session/compaction.ts` — 上下文压缩与剪枝
- `packages/opencode/src/session/summary.ts` — 会话摘要与 diff 计算

## 会话 (Session)

一个 Session 代表一次完整的对话上下文，存储在 SQLite 中：

```ts
export type Info = {
  id: SessionID
  slug: string
  projectID: ProjectID
  workspaceID?: WorkspaceID
  directory: string
  parentID?: SessionID
  title: string
  version: string
  summary?: { additions: number; deletions: number; files: number; diffs?: Snapshot.FileDiff[] }
  share?: { url: string }
  time: { created: number; updated: number; compacting?: number; archived?: number }
  permission?: Permission.Ruleset
  revert?: { messageID: MessageID; partID?: PartID; snapshot?: string; diff?: string }
}
```

### 关键操作

- `create()` — 创建新会话
- `fork()` — 从指定消息处分叉会话，复制历史消息
- `messages()` — 获取会话的消息列表（带 Parts）
- `updateMessage()` / `updatePart()` — 更新消息或 Part（通过 SyncEvent 持久化）

## 消息模型 (MessageV2)

消息分为两类：`User` 和 `Assistant`。每条消息由多个 `Part` 组成。

### User Message Parts

- `text` — 用户输入文本
- `file` — 附件（图片、PDF、目录等）
- `agent` — 用户通过 `@agent` 显式指定的 Agent
- `subtask` — 子任务指令

### Assistant Message Parts

- `text` — 模型生成的文本
- `reasoning` — 模型的推理过程（如 Claude 的 extended thinking）
- `tool` — 工具调用及其结果状态（pending / running / completed / error）
- `step-start` / `step-finish` — 标记一次 LLM 调用的开始和结束
- `patch` — 记录该步骤中修改的文件列表
- `snapshot` — 代码快照标记

### Tool Part 状态机

```
pending -> running -> completed
                    -> error
```

- `pending` — 模型刚发起 tool-call，参数还在流式接收中
- `running` — 参数接收完毕，开始执行 Tool
- `completed` — 执行成功，包含 `output`、`title`、`metadata`、`attachments`
- `error` — 执行失败，包含 `error` 信息

## 会话主循环 (`SessionPrompt.loop`)

`loop()` 是 OpenCode 的核心调度器，伪代码如下：

```
while true:
  1. 读取会话消息历史
  2. 检查是否有待处理的 subtask → 执行 TaskTool
  3. 检查是否有待处理的 compaction → 执行上下文压缩
  4. 检查上下文是否溢出 → 创建 compaction 请求
  5. 选择 Agent 和模型
  6. 解析可用 Tools
  7. 组装 system prompt 和 messages
  8. 调用 LLM.stream() 获取流式响应
  9. SessionProcessor 处理流事件，更新 Parts
  10. 如果模型 finish 且不是 tool-calls → 结束循环
  11. 如果用户取消或出错 → 结束循环
```

### 步数限制

每个 Agent 可配置 `steps` 字段。当循环步数达到 `steps` 时，会在 messages 末尾注入 `MAX_STEPS` 提示词，强制模型结束响应。

### 结构化输出

如果用户请求 JSON Schema 输出，`loop()` 会注入 `StructuredOutput` 工具，并设置 `toolChoice: "required"`。模型必须调用该工具返回结果。

## LLM 流处理 (`SessionProcessor`)

`SessionProcessor` 将 AI SDK 的流事件转换为 Part 更新：

| 流事件 | 处理逻辑 |
|--------|----------|
| `start` | 设置会话状态为 `busy` |
| `text-start` | 创建新的 `TextPart` |
| `text-delta` | 追加文本到 `TextPart`，发布 `PartDelta` 事件 |
| `text-end` | 触发插件 `experimental.text.complete`，保存最终文本 |
| `reasoning-start` | 创建新的 `ReasoningPart` |
| `reasoning-delta` | 追加推理文本 |
| `reasoning-end` | 保存最终推理文本 |
| `tool-input-start` | 创建 `ToolPart`（状态 `pending`） |
| `tool-call` | 更新 `ToolPart` 为 `running`，检查 doom loop |
| `tool-result` | 更新 `ToolPart` 为 `completed`，保存输出 |
| `tool-error` | 更新 `ToolPart` 为 `error`，如果是权限拒绝则设置 `blocked` |
| `start-step` | 记录代码快照，创建 `step-start` part |
| `finish-step` | 计算 token 和费用，创建 `step-finish` part，生成 patch |

### Doom Loop 检测

如果模型连续 3 次以完全相同的参数调用同一个工具，系统会触发 `doom_loop` 权限询问，防止模型陷入死循环。

## 记忆压缩 (`SessionCompaction`)

当对话历史过长导致上下文窗口溢出时，系统会触发压缩：

### 剪枝 (Prune)

`prune()` 从消息历史末尾向前扫描，当累计的 tool output token 超过 `PRUNE_PROTECT`（40k）时，将更老的 tool output 标记为 `compacted`。被 compacted 的输出在后续转换为模型消息时会显示为 `[Old tool result content cleared]`。

`skill` 工具的输出受保护，不会被剪枝。

### 压缩 (Compaction)

`process()` 使用专门的 `compaction` Agent：
1. 收集当前会话的 messages
2. 如果是因为媒体附件过大导致的溢出（overflow），会剥离媒体并尝试重放最近的用户消息
3. 调用 `compaction` Agent 生成对话摘要（包含 Goal、Instructions、Discoveries、Accomplished、Relevant files）
4. 将摘要保存为一条 `summary: true` 的 Assistant 消息
5. 如果 `auto` 模式，自动插入一条 "Continue..." 的用户消息，让模型继续工作

### 溢出检测

`isOverflow()` 根据模型上下文限制和当前 token 数判断是否溢出。不同模型的限制不同，由 `ProviderTransform` 和配置中的 `contextWindow` 决定。

## 消息转换 (`MessageV2.toModelMessages`)

在发送给 LLM 之前，内部的 `WithParts[]` 需要转换为 AI SDK 的 `ModelMessage[]`：

- `text` part → 普通文本内容
- `file` part → `file` 或 `text`（如果剥离媒体）
- `tool` part → `tool-call` / `tool-result`
- `reasoning` part → `reasoning`
- `compaction` part → 转换为 "What did we do so far?"
- `subtask` part → 转换为 "The following tool was executed by the user"

### 媒体处理

某些提供商（如 OpenAI）不支持在 tool result 中直接返回图片。`toModelMessages()` 会自动将媒体附件提取出来，作为额外的 `user` 消息插入到对话中。

## 会话摘要 (`SessionSummary`)

每次 Assistant 消息完成时，系统会异步计算：
- **会话级摘要**：统计该会话中所有文件修改的 additions / deletions / files
- **消息级摘要**：计算当前用户消息及其后续 Assistant 消息导致的文件 diff

摘要数据通过 `Snapshot.diffFull(from, to)` 计算，基于 `step-start` 和 `step-finish` 中记录的快照。
