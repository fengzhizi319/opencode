# 源码级逐函数说明：Plan / Build 任务链路

本文是对 `docs/requirements-and-architecture-plan-build.md` 的源码级补充。它不再只讲概念，而是按**函数跳转顺序**把 OpenCode 的“先规划、后执行”链路拆开说明。

重点文件：

- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/tool/plan.ts`
- `packages/opencode/src/tool/task.ts`
- `packages/opencode/src/session/system.ts`
- `packages/opencode/src/agent/agent.ts`
- `packages/opencode/src/session/message-v2.ts`
- `packages/opencode/src/session/index.ts`
- `packages/opencode/src/session/session.sql.ts`
- `packages/opencode/src/session/todo.ts`

---

## 1. 阅读方式

建议按下面顺序理解这条链路：

1. 先看 `session/prompt.ts` 的主入口 `prompt()` 和主循环 `loop()`。
2. 再看 `tool/plan.ts`，理解计划阶段如何退出并切换到 build。
3. 再看 `tool/task.ts`，理解如何把工作拆给子会话。
4. 再看 `session/system.ts` 与 `agent/agent.ts`，理解系统提示词和 agent 约束是怎么来的。
5. 最后看 `message-v2.ts`、`session/index.ts`、`session/session.sql.ts`、`session/todo.ts`，补齐状态落盘和数据结构。

---

## 2. `packages/opencode/src/session/prompt.ts`

这是整条链路的中枢文件。

### 2.1 `SessionPrompt.prompt(input)`

这是用户请求进入会话的入口。

#### 主要职责

- 读取当前 session。
- 清理 revert 现场。
- 创建用户消息。
- 更新 session 活跃时间。
- 兼容旧版 `tools` 权限输入。
- 决定是否直接返回，或者进入对话 loop。

#### 跳转路径

`prompt()` 的典型调用顺序：

1. `Session.get(input.sessionID)`
2. `SessionRevert.cleanup(session)`
3. `createUserMessage(input)`
4. `Session.touch(input.sessionID)`
5. 如果 `noReply === true`，直接返回。
6. 否则进入 `loop({ sessionID })`

#### 边界条件

- 如果 session 正在处理，会被 `assertNotBusy()` 阻止。
- 如果用户要求只创建消息不回复，会停在 `prompt()`。
- 如果 user 的 `tools` 传入了旧格式，会被转换成 `permission`。

---

### 2.2 `SessionPrompt.assertNotBusy(sessionID)`

这是一个简单但关键的守卫。

#### 作用

- 检查当前 session 是否已经在执行中。
- 如果存在活跃状态，抛出 `Session.BusyError`。

#### 意义

它避免了同一个会话同时跑两个主循环，防止：

- 消息交错写入
- 工具 part 状态乱序
- 模型流与用户输入互相覆盖

---

### 2.3 `SessionPrompt.cancel(sessionID)`

#### 作用

- 中止当前 session 的执行。
- 把状态切回 `idle`。
- 清理内部的 abort controller 和 callback 队列。

#### 适用场景

- 用户主动停止当前任务。
- shell / tool 执行结束后，需要收尾。
- 某些恢复场景需要清掉旧状态。

---

### 2.4 `createUserMessage(input)`

这是把用户输入转成结构化消息的关键函数。

#### 主要职责

- 确定 `agent`。
- 确定 `model`。
- 生成 `MessageV2.Info`。
- 处理输入 `parts`。
- 把文件、目录、MCP 资源、`@agent` 引用变成可消费的 parts。
- 保存消息和 parts 到数据库。

#### 典型输入处理分支

1. **文本 part**
   - 直接保存。

2. **文件 part**
   - 如果是 MCP resource，走 `MCP.readResource()`。
   - 如果是 `data:` URL，解码成文本。
   - 如果是 `file:` URL，读取真实文件或目录。

3. **agent part**
   - 被转换成后续的语义提示。
   - 促使模型调用 `task` 工具把工作交给指定 subagent。

#### 跳转路径

- `createUserMessage()` 会调用 `resolvePromptParts()` 解析模板中的文件引用。
- 然后会写入 `Session.updateMessage(info)`。
- 再对每个 part 调用 `Session.updatePart(part)`。

#### 边界条件

- 读不到文件时，会写错误提示 part，而不是直接崩溃。
- MCP resource 不存在时，会生成失败文本。
- agent 不存在时，会抛出 `NamedError.Unknown` 并广播错误事件。

---

### 2.5 `resolvePromptParts(template)`

这是模板解析器。

#### 作用

把用户输入中的文件路径、目录、`@agent` 等引用解析成 parts。

#### 主要逻辑

- 扫描文本中的文件标记。
- 判断路径是文件、目录还是不存在。
- 如果是 agent 名称，就转换成 agent part。
- 如果是目录，生成目录型 file part。
- 如果是普通文件，生成 text/file part。

#### 边界条件

- 同一个引用只处理一次。
- `~/` 会展开为 home 目录。
- 找不到文件时会尝试作为 agent 名称解析。

---

### 2.6 `loop({ sessionID, resume_existing? })`

这是主循环，是整个系统的核心调度器。

#### 主要职责

- 读取会话历史。
- 找到最后的 user / assistant 消息。
- 判断是否已经结束。
- 处理 subtask / compaction / normal generation。
- 构建 tools。
- 启动 `SessionProcessor`。
- 根据结果决定继续、压缩或停止。

#### 内部关键步骤

1. `SessionStatus.set(sessionID, { type: "busy" })`
2. `MessageV2.filterCompacted(MessageV2.stream(sessionID))`
3. 识别 `lastUser`、`lastAssistant`、`lastFinished`
4. 执行 `insertReminders()`
5. 调用 `resolveTools()`
6. 创建 assistant message
7. `SessionProcessor.create(...)`
8. `processor.process(...)`

#### 结束条件

- 模型自然结束。
- 发生错误。
- 用户中断。
- 需要压缩上下文。
- structured output 已捕获。

#### 边界条件

- 如果找不到 user message，会直接抛错。
- 如果模型未找到，会向 session 广播错误。
- 如果上下文超限，交给 compaction 处理。

---

### 2.7 `insertReminders(input)`

这是 plan/build 语义切换最重要的函数之一。

#### 作用

根据当前 agent 和当前历史，向 user message 注入提醒文本。

#### 主要分支

1. **普通模式**
   - 如果 agent 是 `plan`，插入 plan 模式提醒。
   - 如果之前出现过 plan，而当前切到 build，插入 build switch 提醒。

2. **实验性 plan 模式**
   - 当 agent 切换逻辑启用时，显式创建或更新 plan 文件路径。
   - 用 `<system-reminder>` 强化：
     - 只能写计划文件
     - 不能执行非只读工具
     - 计划阶段必须增量推进

#### 跳转路径

- `insertReminders()` 会直接修改 `userMessage.parts`。
- 这意味着它不是单纯的“提示词文本”，而是写入了下一轮模型真正要看的消息结构。

#### 边界条件

- 没有 user message 时不会注入。
- 从 plan 切到 build 时，如果计划文件存在，会附加路径提示。

---

### 2.8 `resolveTools(input)`

这是把可用工具组装成 AI SDK 工具集的地方。

#### 主要职责

- 从 `ToolRegistry` 获取内置工具。
- 从 `MCP` 获取远程工具。
- 统一包装权限检查。
- 增加 `metadata()` 和 `ask()` 回调。
- 把工具参数 schema 转成模型侧可用格式。

#### 跳转路径

- 先构建 `Tool.Context`。
- 每个工具都会包一层 `before/after` 插件钩子。
- MCP 工具会额外进行输出扁平化和附件转换。

#### 边界条件

- 无效工具不会加入。
- 被权限禁用的工具会被过滤。
- 输出过长会被 `Truncate.output()` 截断。

---

### 2.9 `createStructuredOutputTool(input)`

这是结构化输出通道。

#### 作用

当用户要求 JSON schema 输出时，它作为一个专门工具让模型把最终结果写成结构化对象。

#### 关键行为

- 使用传入 schema 创建工具输入校验。
- 在 `execute()` 中把解析结果保存到外部变量。
- 返回一个简短的确认输出。

#### 边界条件

- 如果模型没有调用这个工具，后续会进入结构化输出错误分支。

---

### 2.10 `SessionPrompt.command(input)`

这是命令系统入口。

#### 作用

- 读取用户定义的 command。
- 解析参数占位符。
- 处理 shell 嵌套替换。
- 决定是否转成 subtask。
- 最终还是回到 `prompt()`。

#### 关键跳转

- `Command.get()`
- `resolvePromptParts(template)`
- `prompt({...})`

#### 边界条件

- command 不存在时抛错。
- model 不存在时抛错。
- agent 不存在时抛错。

---

### 2.11 `SessionPrompt.shell(input)`

这是 shell 命令执行通道。

#### 作用

- 在当前 session 中记录一条用户执行命令的消息。
- 创建对应的 assistant/tool part。
- 启动系统 shell 进程。
- 捕获 stdout/stderr。
- 在结束时写回输出。

#### 边界条件

- shell 被中断时，会在输出中追加 aborted metadata。
- 结束后会恢复 session loop。

---

## 3. `packages/opencode/src/tool/plan.ts`

### 3.1 `PlanExitTool.execute()`

这是计划阶段退出的正式入口。

#### 作用

- 找到当前 session 对应的 plan 文件。
- 向用户确认是否切换到 build。
- 如果用户同意，注入新的 build user message。
- 把当前模型延续到 build 阶段。

#### 跳转路径

1. `Session.get(ctx.sessionID)`
2. `Session.plan(session)`
3. `Question.ask(...)`
4. `getLastModel(ctx.sessionID)`
5. 写入新的 `MessageV2.User`

#### 边界条件

- 用户选择 No，会抛 `Question.RejectedError()`。
- 退出后不重新生成全局状态，而是继续同一 session。

---

## 4. `packages/opencode/src/tool/task.ts`

### 4.1 `TaskTool.execute()`

这是子任务分发器。

#### 作用

- 允许主 agent 把工作交给子 agent。
- 创建或者恢复子会话。
- 记录子任务执行结果。
- 避免递归无限调用。

#### 关键行为

- 检查当前用户/agent 权限。
- 调用 `Agent.get(params.subagent_type)`。
- 根据 `task_id` 决定是恢复已有子会话还是创建新会话。
- 给子会话设置权限限制。
- 在子会话中执行任务。

#### 边界条件

- agent 不存在会直接报错。
- 子 agent 没有 `task` 或 `todowrite` 权限时，会被显式 deny。
- 任务失败时会写入 error part。

---

## 5. `packages/opencode/src/session/system.ts`

### 5.1 `SystemPrompt.environment(model)`

构建运行环境相关的系统提示。

#### 作用

- 注入当前项目、工作区、平台、模型相关环境信息。
- 让模型知道自己处在哪个仓库、哪个路径、哪个上下文中。

### 5.2 `SystemPrompt.skills(agent)`

读取与当前 agent 相关的 skills。

#### 作用

- 把技能文件或技能内容注入系统提示。
- 让 plan/build 在本项目既有约束内工作。

### 5.3 `SystemPrompt.provider(model)`

根据不同 provider 生成不同的 provider prompt。

#### 作用

- 适配不同模型厂商的输入风格。
- 保证 prompt 拼装尽量贴合 provider 兼容性。

---

## 6. `packages/opencode/src/agent/agent.ts`

### 6.1 `Agent.Info`

这是 agent 定义的核心 schema。

#### 关键字段

- `name`
- `mode`
- `permission`
- `model`
- `prompt`
- `options`
- `steps`

#### 作用

它决定当前 agent 能执行什么工具、最大能跑多少步、默认模型是什么。

### 6.2 `Agent.get(name)` / `Agent.list()` / `Agent.defaultAgent()`

#### 作用

- `get()`：按名字取 agent。
- `list()`：列出所有 agent。
- `defaultAgent()`：取默认 agent 名称。

#### 边界条件

- 找不到 agent 时会抛出错误并提示可用 agent。
- 默认 agent 是整个系统的兜底入口。

---

## 7. `packages/opencode/src/session/message-v2.ts`

这是消息结构和转换的核心模块。

### 7.1 `MessageV2.Info`

定义 message 的基础信息。

### 7.2 `MessageV2.Part`

定义每个 message part 的类型。

### 7.3 `MessageV2.toModelMessages()`

把内部消息转成 AI SDK 可消费的 `ModelMessage[]`。

#### 作用

- 将 text / file / tool / reasoning 等 part 映射到模型输入格式。
- 是 prompt 进入 LLM 前的最后一层转换。

### 7.4 `MessageV2.stream(sessionID)`

按会话流式读取消息。

#### 作用

- 主循环依赖它回放历史。
- 适合在 compaction、恢复、总结等场景里增量消费历史。

---

## 8. `packages/opencode/src/session/index.ts`

这是 Session 的聚合入口。

### 8.1 常用公开入口

- `Session.get()`
- `Session.create()`
- `Session.updateMessage()`
- `Session.updatePart()`
- `Session.plan(session)`
- `Session.setTitle()`
- `Session.touch()`

### 8.2 作用

它不是单一算法，而是整个 session 领域的门面（facade）。

### 8.3 在架构中的地位

- `prompt.ts` 依赖它创建和更新会话。
- `plan.ts` 依赖它定位计划文件。
- `task.ts` 依赖它创建子会话。

---

## 9. `packages/opencode/src/session/session.sql.ts`

这是数据库持久化层。

### 9.1 `SessionTable`

保存会话级信息。

### 9.2 `MessageTable`

保存消息记录。

### 9.3 `PartTable`

保存消息分片信息。

### 9.4 `TodoTable`

保存待办信息。

### 9.5 为什么重要

因为 plan/build、task/subtask、tool part、todo 状态最终都要落到这里，才能支持：

- 恢复
- 回放
- 紧凑化
- 调试
- 图形界面展示

---

## 10. `packages/opencode/src/session/todo.ts`

### 10.1 `Todo.Info`

定义单个待办项。

### 10.2 `Todo.update()`

以“全量替换”的方式更新 session 下的 todos。

### 10.3 `Todo.get(sessionID)`

按顺序读取 todo 列表。

### 10.4 作用

它是计划阶段和长任务执行时的轻量任务板，用来提醒模型当前还有哪些没完成。

---

## 11. 边界条件总表

### 11.1 计划阶段

- 找不到 plan 文件路径。
- 用户拒绝切换到 build。
- 只能只读或写计划文件。

### 11.2 构建阶段

- tool 被权限拒绝。
- 模型超出上下文需要 compaction。
- structured output 未按要求返回。

### 11.3 子任务

- subagent 不存在。
- task_id 恢复失败。
- 子任务递归过深。

### 11.4 会话状态

- busy / idle 切换不一致。
- 中断后需要清理未完成 parts。
- revert / summary / compaction 交错。

---

## 12. 结论

从源码角度看，OpenCode 的“先规划、后执行”不是一个简单开关，而是一条完整的状态链：

- `prompt.ts` 负责把输入变成会话流。
- `system.ts` 负责把环境和 skills 送进系统提示。
- `plan.ts` 负责计划阶段的退出与切换。
- `task.ts` 负责把任务拆成树。
- `message-v2.ts` / `session.sql.ts` / `todo.ts` 负责状态落盘。
- `agent.ts` 负责控制 agent 能力边界。

真正的关键是：**每一步都是在同一个 session 中通过消息与工具状态往前推进的。**

