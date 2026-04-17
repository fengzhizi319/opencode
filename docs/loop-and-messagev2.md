<!--
Generated: loop-and-messagev2
-->
# `loop()` 函数与 `MessageV2` 详解（中文）

任务接收与计划
- 我将详细解析 `loop()` 的每一步逻辑（逐行/逐分支说明），并对 `MessageV2`（消息与 parts 的数据模型与重要方法）做系统说明。
- 输出：一份放在 `docs/loop-and-messagev2.md` 的中文文档，包含检查清单、逐步流程、关键代码引用与调试建议。

检查清单
- [x] 说明 `loop()` 的入口与返回值
- [x] 逐步解释循环内部的阶段（恢复/启动 abort、消息遍历、子任务/压缩/正常处理、创建 processor、调用模型、结构化输出处理、结果判断与循环结束）
- [x] 解释 `MessageV2` 的核心类型（Info、Part、ToolPart 状态等）与关键函数（toModelMessages、filterCompacted、parts、get 等）
- [x] 给出调试/单测建议与常见陷阱

相关代码位置（供跳转）
- `packages/opencode/src/session/prompt.ts` — `loop()` 实现（大约起始行 ~372）
- `packages/opencode/src/session/message-v2.ts` — `MessageV2` 定义（完整模型与工具状态，文件顶部）

---

前言（高层）
`loop()` 是会话驱动的主循环：它从会话历史中读取用户/助手消息、决定下一步要执行的任务（子任务、压缩、或向 LLM 发起一次生成），并反复执行直到会话完成或被中止。每轮循环会创建一个新的 Assistant message（用于承载 LLM 的回复），并用 `SessionProcessor` 对这个回复的流式事件进行消费，期间可能产生工具调用、补丁、摘要或结构化输出。

下面以 `prompt.ts` 中 `loop()` 的实现为蓝本（参见文件）逐步讲解。

1) 入口与初始步骤

- `loop` 的签名：接受 `{ sessionID, resume_existing? }`（`LoopInput`）。
- 功能：确保会话有一个 `AbortSignal`（由 `start` 创建），若已有正在运行的会话且 `resume_existing` 不为真，则把当前调用者注册到 `state()[sessionID].callbacks` 等待现有循环完成并返回结果。

关键点与示例代码片段（概念性）：

- start/resume（prompt.ts）
  - `start(sessionID)`：若当前 `state()[sessionID]` 不存在，创建 `AbortController` 并保存为 `state()[sessionID].abort`，返回 `controller.signal`。
  - `resume(sessionID)`：如果 `state()[sessionID]` 已存在，则返回该 `abort.signal`（用于恢复已存在会话）。

- 如果 `state()` 中已有该 session 且不是恢复调用，`loop()` 会返回一个 Promise，注册回调：
  - `state()[sessionID].callbacks.push({ resolve, reject })`，等待现有循环结束后被 resolve（见 `loop()` 结尾的回调分发逻辑）。

设计意图：防止针对同一 session 的并发 `loop()` 执行，同时支持短期复用/等待模式。

2) 资源管理与自动取消

- `loop()` 使用 `using _ = defer(() => cancel(sessionID))` 的资源管理（defer）模式，确保函数退出时会自动调用 `SessionPrompt.cancel(sessionID)`，避免泄漏 `AbortController`。

3) 循环主体（核心）

`while (true)` 中的每一次迭代代表一个“步骤/轮次”（step），下面按逻辑段拆解：

- a) 标记状态为 busy
  - `await SessionStatus.set(sessionID, { type: 'busy' })` —— 告知系统此会话正在处理。

- b) 检查 abort 信号
  - `if (abort.aborted) break` —— 若会话已被中止，退出循环。

- c) 读取消息流并过滤已压缩的消息
  - `let msgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID))`
  - `MessageV2.stream()` 从 DB 翻页读取消息；`filterCompacted()` 会在遇到已完成的 compaction 时停止并返回倒序的消息列表（保持最新到最旧，然后 reverse）。

- d) 从后向前扫描消息查找关键锚点
  - 目的：找到 `lastUser`（最近的用户消息）、`lastAssistant`（最近的助手消息）、`lastFinished`（最近的已完成助手消息），并收集待处理的 `tasks`（compaction/subtask）。
  - 这段代码保证 loop 的决策基于最近未处理的用户输入及排队任务。

- e) 早期退出判断
  - 若 `lastAssistant` 已完成并且其 finish 原因不是需要继续工具调用（例如不是 `tool-calls`），并且这个 assistant 是针对早于用户消息，则认为会话已处理完，退出循环。

- f) 步骤计数与首步工作
  - 维护 `step` 计数器。若为第一步（step === 1），会异步生成 session 标题（`ensureTitle`），并触发 `SessionSummary.summarize`。

- g) 处理排队的 `subtask`（子任务）
  - 若 `task?.type === 'subtask'`：
    - 初始化 `TaskTool`，创建一个新的 Assistant 消息承载子任务的执行
    - 创建一个 `tool` type 的 Part（status = running）并保存
    - 构建 `taskCtx`（Tool.Context），其中注入 `abort`、`ask`（权限请求）、`metadata` 更新回调等
    - 调用 `taskTool.execute(taskArgs, taskCtx)` 执行子任务；执行结束后更新 Part（completed 或 error），并更新 assistantMessage.finish = 'tool-calls'
    - 如果该子任务产生 command，还会合成一个用户消息作为后续上下文（为避免某些模型出现 thinking 签名缺失）。
  - 处理完子任务后 `continue`，进入下一轮 loop（因为子任务结果需要再次由模型处理）。

- h) 处理 pending `compaction`（压缩任务）
  - 若 `task?.type === 'compaction'`：调用 `SessionCompaction.process(...)` 执行压缩；若结果为 'stop' 则退出循环，否则 `continue`。

- i) 检测上下文溢出并创建 compaction
  - 通过 `SessionCompaction.isOverflow({ tokens, model })` 判断；若溢出则 `SessionCompaction.create(...)` 并 `continue`。

- j) 正常路径 — 生成模型回复
  - 获取 `agent` 配置（`Agent.get(lastUser.agent)`），计算 `maxSteps` 等并插入提醒（`insertReminders`）
  - 创建 `SessionProcessor`：
    - `processor = await SessionProcessor.create({ assistantMessage: Session.updateMessage({ ... }), sessionID, model, abort })`
    - 这里会创建一个新的 Assistant message（尚未完成），并在 `processor` 内持有该 message 的引用，用于在流事件中更新 parts。
  - 解析并准备 `tools`（`resolveTools({...})`）：从 `ToolRegistry`、MCP、内置等来源收集合并工具，包装入 AI SDK `tool({...})` 对象，并为每个 tool 的执行注入 `context`（含 `abort`、`metadata`、`ask`）
  - 若用户请求 `json_schema` 输出，则注入 `StructuredOutput` 工具并在成功回调中捕获结构化结果。
  - 构建 `system` 提示（环境、技能、InstructionPrompt.system），并把 `messages` 转换为模型消息 (`MessageV2.toModelMessages(msgs, model)`)。

- k) 调用 `processor.process({...})` 执行 LLM 调用
  - `processor.process` 会：
    - 调用 `llm.stream(streamInput)` 获取流事件
    - 对流事件逐个处理，`handleEvent` 负责处理 `start, text-delta, tool-call, tool-result, tool-error, start-step, finish-step` 等事件并更新 DB 部分
    - 在每个事件前会调用 `input.abort.throwIfAborted()`（确保及时终止）
    - 使用重试策略 `SessionRetry.policy`，并在最后用 `Effect.ensuring(cleanup())` 确保 cleanup 在终止/错误时执行
  - `processor.process` 最终返回 `'compact' | 'stop' | 'continue'` 之类结果，指示 loop 下一步操作

- l) 处理 `processor` 的返回值与结构化输出
  - 若捕获到 `structuredOutput`（由 StructuredOutput 工具回调保存），会把其赋给 `processor.message.structured` 并把消息标为 finish（stop），然后 break
  - 判断 `modelFinished`（`processor.message.finish` 存在并非 tool-calls/unknown）并处理 JSON schema 情况（若要求 JSON schema 但模型未调用 StructuredOutput，则写入 `StructuredOutputError`），并 `Session.updateMessage`
  - 根据 `result` 值：
    - `'stop'` -> break
    - `'compact'` -> 创建 compaction (`SessionCompaction.create(...)`) 然后 continue
    - otherwise continue loop

4) 循环结束后的收尾

- 在跳出 `while` 后，调用 `SessionCompaction.prune({ sessionID })` 清理已完成的 compaction 任务。
- 遍历 `MessageV2.stream(sessionID)`，找到第一条非用户消息作为返回结果；同时把 `state()[sessionID].callbacks` 队列中的等待者依次 `resolve(item)`，并返回该消息（这就是 `prompt()` 返回的 `MessageV2.WithParts`）

5) 错误、中止与 cleanup（交叉说明）

- `SessionProcessor` 内部定义了 `cleanup()` 与 `halt()`：
  - `cleanup()`：计算残余 snapshot 的 patch、完成未完成 text/reasoning parts、将未完成工具标记为 error（"Tool execution aborted"），并设置 assistantMessage.time.completed，最后 `session.updateMessage`。
  - `halt(e)`：将错误转换为 `MessageV2` error（`MessageV2.fromError(e, {providerID, aborted: input.abort.aborted})`），若是 ContextOverflowError 则设置 `needsCompaction`，否则设置 `assistantMessage.error` 并发布 `Session.Event.Error`，并设置 SessionStatus 为 idle。

在 `processor.process` 中，所有的流处理包裹在 Effect 的 `catchCause` 与 `retry` 逻辑里，最终不论正常结束或异常，`Effect.ensuring(cleanup())` 都会执行，保证未完成的 parts 被清理和持久化。

---

MessageV2 详解（核心类型、用途与重要方法）

MessageV2 是会话消息与组成部分（parts）的中心数据模型，重要点如下。

1) 根类型

- `MessageV2.Info`：一条消息的元信息，分 `User` 与 `Assistant` 两种：
  - `User` 包含：id, sessionID, time.created, agent, model, format, parts (在 WithParts 中存储)
  - `Assistant` 包含：id, sessionID, time.created/completed, error(optional), parentID, model/provider id, agent, tokens/cost, finish(optional), structured(optional)

- `MessageV2.Part`：消息的组成部分（discriminated union），可为：
  - `text`, `file`, `tool`, `reasoning`, `step-start`, `step-finish`, `snapshot`, `patch`, `agent`, `subtask`, `compaction`, `retry` 等。

2) ToolPart 与状态机

- `ToolPart` 是工具调用的结构，关键字段：`callID`, `tool`, `state`（ToolState），以及可选的 `metadata`。
- `ToolState` 有四种变体：
  - `pending`: 参数未完整
  - `running`: 工具正在执行（含 time.start）
  - `completed`: 执行成功（含 output, time.start/end, attachments）
  - `error`: 执行失败（含 error 文本, time.start/end）

3) 事件/辅助方法

- `MessageV2.toModelMessages(withParts[], model)`：把内部消息/parts 转换为供 LLM provider 使用的 ModelMessage[]。它会根据 provider 特性把工具输出拆分或注入 user messages（例如提取 media 到单独 user message），并为 tool results 生成 `toModelOutput` 处理器（见文件中 `toModelOutput` 逻辑）。

- `MessageV2.stream(sessionID)`：对 messages 表进行分页并 yield `WithParts`（包装 info+parts）。

- `MessageV2.filterCompacted(stream)`：沿着 stream 消费并在遇到已完成的 compaction 点后停止（用于 loop 只读取未被压缩或需要关注的消息段）。

- `MessageV2.parts(messageID)`、`MessageV2.get({sessionID,messageID})`、`MessageV2.page(...)`：用于检索 parts、单条消息或分页读取消息。

4) 错误类型与 fromError

- `MessageV2` 定义了多种标准化的错误类型（`AbortedError`, `APIError`, `ContextOverflowError`, `AuthError` 等），并提供 `fromError(e, ctx)` 函数将异常转换为 `Assistant.error` 的标准结构，其中会根据是否为 AbortError 把中止映射为 `AbortedError`。

---

调试建议与测试用例（实操）

1) 快速复现

- 场景 A（中止处理器）
  1. 发起一个 prompt 使 LLM 进入流式输出或发起工具调用
  2. 同时调用 `POST /session/:id/abort`（server route）或在代码中调用 `SessionPrompt.cancel(sessionID)`
  3. 观察 `SessionProcessor` 是否进入 `halt()` 与 `cleanup()`，并检查 DB 中对应 `tool` part 的状态是否为 `error` 且 error 内容包含 `Tool execution aborted`

- 场景 B（子任务）
  1. 触发一个 `subtask`，使 `TaskTool` 创建子会话
  2. 在父会话中中止，确认 `TaskTool` 注册的 `abort` listener 能调用 `SessionPrompt.cancel(childSession)` 并把子会话也中止

2) 推荐单元测试

- 测试 `loop()` 在 `processor.process()` 返回 `'compact'` 时会创建 compaction
- 测试 `loop()` 在收到结构化输出（StructuredOutput 工具）后，会把 `processor.message.structured` 写入并结束
- 测试中止路径：用一个假的 `llm.stream()`（yield 一些事件且长延迟），在处理器运行时触发 abort，断言 `cleanup()` 将未完成的 tool parts 标记为 error

3) 日志关键字

- 搜索：`session.prompt`、`session.processor`、`tool.execute.before`、`tool.execute.after`、`Tool execution aborted`、`process`、`halt`、`cleanup`

常见问题与注意事项

- 确保所有长时间运行的操作都能观察到 `AbortSignal`（通过传入 signal 并在合适位置调用 `throwIfAborted()` 或注册 `abort` listener），否则它们可能不会及时终止。
- 在新增工具或执行路径时，记得在中止情况下走 cleanup/最终化逻辑以保持 DB 的一致性（防止 dangling parts）。

---

结语

本文件旨在为开发者快速理解 `loop()` 内部的决策树、`MessageV2` 的数据结构与运行时交互提供清晰参考。若需要，我可以：

- 将本文翻译为英文或生成双语版
- 基于文中测试建议实现实际单测并运行（需要在 `packages/opencode/test` 下创建测试文件）
- 画出 Mermaid 时序图并把其加入当前 docs（若需要我也可把图嵌入此文件）

如需我继续（例如：添加测试或英文版），请回复要执行的下一步。

