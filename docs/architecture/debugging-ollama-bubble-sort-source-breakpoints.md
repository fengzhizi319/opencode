# Ollama + Python 冒泡排序 源码断点版

本文是更偏源码追踪的调试说明，目标是帮助你沿着 OpenCode 的真实调用链，一步步定位“为什么模型会这样做、工具为什么会被调用、文件为什么会被写入”。

它假设你已经知道如何启动 Ollama，以及如何运行 OpenCode。若你想先跑通最小流程，请先看 [debugging-ollama-bubble-sort-beginner.md](./debugging-ollama-bubble-sort-beginner.md)。

---

## 目录

- [调试目标](#调试目标)
- [源码总路径](#源码总路径)
- [关键断点表](#关键断点表)
- [推荐观察变量](#推荐观察变量)
- [源码跳转顺序](#源码跳转顺序)
- [如何单步追踪](#如何单步追踪)
- [常见异常定位](#常见异常定位)
- [推荐命令](#推荐命令)

---

## 调试目标

我们以这个任务为例：

```text
请帮我用 Python 语言实现一个冒泡排序算法，并验证结果正确性
```

你要追踪的不是“最终输出文本”，而是这条链路：

1. 用户输入进入 `SessionPrompt.prompt()`
2. 创建 user message
3. 进入 `loop()`
4. 构建 system prompt 和 tools
5. 进入 `LLM.stream()`
6. 接收流事件并落盘到 message / part
7. 遇到 `write` / `edit` / `bash` 等 tool call 时执行工具
8. 通过权限判断和事件回写观察它为什么能改文件

---

## 源码总路径

这条任务通常会经过以下文件：

- `packages/opencode/src/index.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/system.ts`
- `packages/opencode/src/session/llm.ts`
- `packages/opencode/src/session/processor.ts`
- `packages/opencode/src/session/message-v2.ts`
- `packages/opencode/src/agent/agent.ts`
- `packages/opencode/src/skill/index.ts`
- `packages/opencode/src/tool/registry.ts`
- `packages/opencode/src/tool/write.ts`
- `packages/opencode/src/tool/edit.ts`
- `packages/opencode/src/permission/index.ts`
- `packages/opencode/src/provider/provider.ts`

如果你想把“为什么它这么调度”看得更细，还可以继续往下追到 `session/sql.ts`、`session/index.ts` 和 `todo.ts`。

---

## 关键断点表

下面这些位置最适合打断点：

| 文件 | 函数 / 位置 | 你要看的东西 | 说明 |
|---|---|---|---|
| `src/index.ts` | CLI 入口、`--print-logs`、`--log-level` | 启动参数、日志级别 | 确认你到底是通过 `run`、`debug config` 还是 TUI 进入的 |
| `session/prompt.ts` | `prompt()` | `input`、`session`、`message` | 查看 user message 是怎么创建的 |
| `session/prompt.ts` | `loop()` | `lastUser`、`lastAssistant`、`tools` | 主循环是否进入、是否在 compaction / subtask 分支 |
| `session/prompt.ts` | `insertReminders()` | `agent.name`、`session.plan` | 看 plan/build 的提醒是否被注入 |
| `session/prompt.ts` | `resolveTools()` | `input.agent`、`tools`、`bypassAgentCheck` | 看最终工具集是怎么生成的 |
| `session/system.ts` | `environment()` / `skills()` | `system` 数组 | 看 system prompt 拼了哪些内容 |
| `session/llm.ts` | `stream()` | `messages`、`tools`、`provider` | 查看送进模型的最终请求 |
| `session/message-v2.ts` | `toModelMessages()` | `WithParts[]`、`ModelMessage[]` | 看消息是如何转成模型输入的 |
| `session/processor.ts` | `handleEvent()` | `value.type`、`ctx.currentText`、`ctx.toolcalls` | 看流事件如何被落成 part |
| `tool/write.ts` | `execute()` | `params.filePath`、`params.content` | 看写文件参数和最终写入路径 |
| `tool/edit.ts` | `execute()` | `params.filePath`、`params.search`、`params.replace` | 看编辑是否命中预期文本 |
| `permission/index.ts` | `ask()` / `evaluate()` | `permission`、`pattern`、`action` | 看工具为什么被允许或拒绝 |
| `agent/agent.ts` | `get()` / `defaultAgent()` | `agent.name`、`permission` | 看 build / plan / subagent 的配置 |
| `skill/index.ts` | `available()` | `skills` 列表 | 看技能是否被当前 agent 过滤掉 |
| `provider/provider.ts` | `getModel()` / `list()` | `providerID`、`modelID` | 看 `ollama/qwen3.5:0.8b` 是否被正确解析 |

---

## 推荐观察变量

### 1. `session/prompt.ts` 里看什么

重点看：

- `input.sessionID`
- `input.agent`
- `input.model`
- `message.parts`
- `lastUser`
- `lastAssistant`
- `tools`
- `system`

你会经常想回答这几个问题：

- 这次是 `build` 还是 `plan`？
- system prompt 是否包含技能和环境信息？
- 工具是否被正确装配？
- 当前轮是否已经有一个 assistant message？

### 2. `session/llm.ts` 里看什么

重点看：

- `input.model.providerID`
- `input.model.id`
- `input.system`
- `input.messages`
- `input.tools`
- `input.agent.name`

你要确认：

- 是否真的是 `ollama` provider
- 是否真的是 `qwen3.5:0.8b`
- messages 里有没有把文件或子任务 part 展进去

### 3. `session/processor.ts` 里看什么

重点看：

- `value.type`
- `ctx.currentText`
- `ctx.reasoningMap`
- `ctx.toolcalls`
- `ctx.snapshot`
- `ctx.needsCompaction`

你要确认：

- 文本是否一段一段收到
- tool call 是否进入 running 状态
- tool result 是否成功回写
- 是否因为上下文超限进入压缩

### 4. `tool/write.ts` / `tool/edit.ts` 里看什么

重点看：

- `params.filePath`
- `params.content`
- `ctx.ask()` 的返回
- 最终文件路径是否是你期望的工作区文件

你要确认：

- 真的写到了工作区，而不是别的位置
- 文件内容和模型输出是否一致
- 权限是否在写文件前被拒绝

---

## 源码跳转顺序

如果你想按最少路径追踪，建议按这个顺序走：

```mermaid
flowchart TD
    A[CLI 入口 src/index.ts] --> B[SessionPrompt.prompt()]
    B --> C[createUserMessage()]
    C --> D[loop()]
    D --> E[insertReminders()]
    E --> F[resolveTools()]
    F --> G[SessionPrompt.system / SessionPrompt.llm]
    G --> H[LLM.stream()]
    H --> I[SessionProcessor.handleEvent()]
    I --> J{tool-call?}
    J -->|是| K[Tool.execute()]
    J -->|否| L[继续 text-delta / finish-step]
    K --> M[Permission.ask()]
    M --> N[Session.updatePart() / Session.updateMessage()]
    N --> D
```

### 读图说明

- `src/index.ts` 决定你是从 CLI、调试命令还是 TUI 进入。
- `prompt()` 和 `loop()` 是总入口。
- `resolveTools()` 是工具决定性节点。
- `SessionProcessor.handleEvent()` 是流式输出的核心。
- `Tool.execute()` 与 `Permission.ask()` 决定文件是否真的会被改写。

---

## 如何单步追踪

### 第 1 步：先确认 CLI 入口

启动命令推荐：

```bash
cd /Users/charles/Documents/AI/opencode/packages/opencode
bun --inspect run --conditions=browser ./src/index.ts --print-logs --log-level DEBUG run --model ollama/qwen3.5:0.8b --agent build -- "请帮我用 Python 语言实现一个冒泡排序算法，并验证结果正确性"
```

此时你应该先在 `src/index.ts` 看到：

- `--print-logs`
- `--log-level DEBUG`
- `run`
- `--model ollama/qwen3.5:0.8b`
- `--agent build`

### 第 2 步：断在 `prompt()`

看 `input` 是否正确、`session` 是否存在、`createUserMessage()` 是否被调用。

### 第 3 步：断在 `loop()`

看：

- `lastUser` 是否存在
- `lastAssistant` 是否存在
- `tools` 是否为空
- `insertReminders()` 是否注入了 plan/build 提醒

### 第 4 步：断在 `LLM.stream()`

看模型最终请求：

- provider 是否为 Ollama
- model 是否为 `qwen3.5:0.8b`
- system prompt 是否含技能
- messages 是否含任务上下文

### 第 5 步：断在 `SessionProcessor.handleEvent()`

看每个事件：

- `start`
- `text-start`
- `text-delta`
- `tool-input-start`
- `tool-call`
- `tool-result`
- `finish-step`

### 第 6 步：断在 `write` / `edit`

看是否真的创建了文件，是否真的写到了工作区。

---

## 常见异常定位

### 1. 没有进入工具调用
先看：

- `resolveTools()` 是否返回了 write/edit/bash
- `Permission.evaluate()` 是否把工具禁掉了
- 模型是否支持工具调用

### 2. 模型不是 Ollama
先看：

- `debug config` 是否配置了 `ollama`
- `provider.provider.ts` 是否能列出这个 provider
- `debug config` 中 `model` 是否真的是 `ollama/qwen3.5:0.8b`

### 3. 写文件失败
先看：

- `tool/write.ts` 的 `params.filePath`
- `ctx.ask()` 是否拒绝
- 工作区路径是否正确

### 4. 结果生成了，但没有验证
先看：

- `prompt()` 的输入是否要求“验证结果正确性”
- 模型是否真的收到了测试边界条件
- `finish-step` 后是否继续了下一轮

### 5. 断点断不到
通常检查：

- 你是否真的用 `--inspect` 启动
- 调试器是否附加到了正确的进程
- 你是否在 `packages/opencode` 目录下运行

---

## 推荐命令

### 查看配置

```bash
cd /Users/charles/Documents/AI/opencode/packages/opencode
bun run --conditions=browser ./src/index.ts debug config
```

### 查看模型

```bash
cd /Users/charles/Documents/AI/opencode/packages/opencode
bun run --conditions=browser ./src/index.ts models ollama --verbose
```

### 跑真实任务

```bash
cd /Users/charles/Documents/AI/opencode/packages/opencode
bun --inspect run --conditions=browser ./src/index.ts --print-logs --log-level DEBUG run --model ollama/qwen3.5:0.8b --agent build -- "请帮我用 Python 语言实现一个冒泡排序算法，并验证结果正确性"
```

### 只看调试脚本演示

```bash
cd /Users/charles/Documents/AI/opencode/packages/opencode
bun debug-execution.ts
```

或者：

```bash
node debug-execution-node.mjs
```

---

## 你应该重点盯住的三处

如果你只想抓最重要的三个断点，建议是：

1. `packages/opencode/src/session/prompt.ts` 的 `prompt()` / `loop()`
2. `packages/opencode/src/session/processor.ts` 的 `handleEvent()`
3. `packages/opencode/src/tool/write.ts` 的 `execute()`

这三处基本覆盖：

- 任务如何进入
- 流式输出如何处理
- 文件如何真正落盘

---

## 结尾建议

如果你现在是第一次调试，建议先看：

1. [debugging-ollama-bubble-sort-beginner.md](./debugging-ollama-bubble-sort-beginner.md)
2. 再看本文
3. 最后回到 [debugging-guide.md](./debugging-guide.md) 逐断点深挖

