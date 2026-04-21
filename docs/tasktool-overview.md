# `TaskTool` 概述与实现要点（中文）

本文档说明 `TaskTool` 的目的、参数、核心执行流程与实现细节，并把关键行为与 `SessionPrompt` / `loop()` 的交互关系说明清楚，方便阅读或在开发中查阅。

目标与用途

- `TaskTool` 是一个“任务委托”工具，用于将工作从父会话（caller）委托给专用的子智能体（subagent）。
- 使用场景：Plan agent 生成的子任务、命令触发的子任务、或手动调用 task 工具来运行一个子 agent 执行特定任务。

输入参数（schema）

- `description` (string): 简短描述（3-5 词），用于会话标题与元数据。
- `prompt` (string): 子任务要执行的具体提示（在子会话中执行）。
- `subagent_type` (string): 指定要用哪个子智能体类型来执行该任务（例如 `build`、`test` 等）。
- `task_id` (string, optional): 若想恢复之前的子会话，可传入此前的 `task_id`。
- `command` (string, optional): 触发该任务的命令名（用于记录或合成上下文）。

核心实现步骤（高层）

1. 验证与权限请求
   - 若调用上下文没有绕过检查（`ctx.extra?.bypassAgentCheck`），`TaskTool` 会调用 `ctx.ask({ permission: 'task', patterns: [subagent_type], ... })` 请求权限。

2. 找到目标子 agent，并决定子会话模型
   - 使用 `Agent.get(params.subagent_type)` 获取 agent 配置。
   - 确定用于子会话的模型：优先使用 agent 自己的默认模型，否则使用父消息的模型。

3. 创建或恢复子会话
   - 如果提供了 `task_id`，尝试恢复对应子会话（`Session.get(SessionID.make(task_id))`）。若未找到或没有 `task_id`，创建新子会话（`Session.create({ parentID: ctx.sessionID, title: ... })`）。
   - 在子会话的权限配置中，基于子 agent 的权限显式 `deny` 某些权限（例如 `task` 或 `todowrite`），以防止递归和越权。

4. 注册父 abort 到子会话的取消器
   - `ctx.abort.addEventListener('abort', cancel)`：父中止时会调用 `SessionPrompt.cancel(session.id)` 取消子会话。
   - 使用 `defer()` 或等价清理机制在函数结束时移除监听器。

5. 解析并运行子会话提示
   - 使用 `SessionPrompt.resolvePromptParts(prompt)` 将文本模板解析为 parts（文件、agent 引用等）。
   - 调用 `SessionPrompt.prompt({... sessionID: childSession.id, agent: subagent_type, parts, model })`，等待子会话完成其 `loop()`。

6. 返回结果
   - 从 `prompt` 的返回 `parts` 中提取文本结果（通常 `findLast` text 部分），构造 `output` 字符串并返回（包含 `task_id` 以便后续恢复）。

注意与边界条件

- 子会话权限：`TaskTool` 会根据子 agent 的权限显式 deny `task` 或 `todowrite`，避免子 agent 继续委托或向 TODO 文件写入，防止递归或破坏性操作。
- 中止传播：父 abort 会取消子会话，子会话自身的 `loop()` 会在收到 abort 信号后尽早 `break` 并执行 cleanup。
- 任务恢复：通过 `task_id` 可以让 TaskTool 恢复之前的子会话，继续未完成的工作。

与 `SessionPrompt` / `loop()` 的交互

- 父会话会在自己历史中创建一个 `tool` part（`tool: 'task'`），并将其状态设为 `running`。
- `TaskTool.execute` 会在子会话中调用 `SessionPrompt.prompt(...)`，该调用会创建子会话的用户消息并触发子会话的 `loop()` 完整执行。
- 子会话内的所有 LLM 交互、工具调用、压缩等都在子会话的 `loop()` 中独立进行，结果通过 `TaskTool` 返回给父会话并写回父会话的 part。

示例（伪流程）

- 父会话：push subtask part -> 写入 tool part(status=running) -> 调用 TaskTool.execute
- TaskTool：create child session -> prompt child -> wait child result -> return result
- 父会话：更新 tool part -> 若有 command 创建 synthetic user message -> loop 继续

实现引用

- `packages/opencode/src/tool/task.ts`：`TaskTool` 的完整实现
- `packages/opencode/src/session/prompt.ts`：`loop()` 中的 subtask 处理分支

该文档旨在给开发者快速理解 `TaskTool` 的行为与设计约束。如需加入时序图、示例日志片段或单元测试建议，我可以继续追加。
