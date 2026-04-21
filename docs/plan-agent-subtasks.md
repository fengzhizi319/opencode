# Plan -> Build: 子任务（subtask）调度与执行流程说明（中文）

本文档保存了对话中关于：当 Plan agent 规划出多个小任务（例如 10 个 subtask）后，父会话（例如 Build agent 的 loop）如何调度与执行这些子任务的说明。

概述结论（先看要点）

- 每个 subtask 通常由 `TaskTool` 发起；`TaskTool` 会为该子任务创建或恢复一个独立的子会话（child session），并在该子会话中用指定的 `subagent` 运行提示。换言之，子任务通常是由单独的子 agent 在独立子会话中完成，而不是在父会话内复用同一 `MessageV2` 来并行完成多个子任务。
- 默认处理策略是串行（serial）：父会话的 `loop()` 会按 LIFO（后进先出）顺序取出 `tasks.pop()` 并 `await` 每个 `TaskTool.execute(...)` 的完成，然后再处理下一个任务。
- 所有的权限、abort（中止）信号、以及工具状态都通过 `TaskTool` / `SessionPrompt` 的接口进行传递和记录，父会话会为子任务建立一个 `tool` 类型的 part（state: running），在子任务完成后更新为 `completed` 或 `error`。

关键实现点（与代码对应）

- 在 `packages/opencode/src/session/prompt.ts`：
  - 读取历史消息并收集任务 parts（`compaction`、`subtask`）到 `tasks` 列表（反向遍历历史，见 `for (let i = msgs.length - 1; i >= 0; i--)` 和 `tasks.push(...)`）。
  - 取任务时使用 `const task = tasks.pop()`（LIFO）。
  - 子任务处理分支：`if (task?.type === "subtask") { ... }`，其中会：
    - 创建父会话内的 assistant message 和一个 `tool` part（标记为 running）。
    - 构建 `taskCtx`（包含 `abort`、`ask`、`metadata` 回调等），并调用 `taskTool.execute(taskArgs, taskCtx)`。
    - 根据 `taskTool` 返回更新 part 状态并写回父会话历史。

- 在 `packages/opencode/src/tool/task.ts`：
  - `TaskTool` 会解析参数（`description`、`prompt`、`subagent_type`、可选的 `task_id` 等）。
  - 校验权限（`ctx.ask({...})`）并根据子 agent 的权限创建或恢复子会话（`Session.create`，如果有 `task_id` 则尝试恢复）。
  - 为子会话配置权限规则，显式 deny 某些权限（例如 `task`、`todowrite`）以防止递归或越权。
  - 注册父 abort 到子会话的监听器（`ctx.abort.addEventListener("abort", cancel)`），保证父中止时可以取消子任务。
  - 调用 `SessionPrompt.prompt(...)` 在子会话内发起提示，并等待子会话 `loop()` 完成，最后返回子任务的文本结果给父会话。

执行顺序与并发策略

- 默认行为：串行执行、LIFO 顺序（最新的子任务优先）。
- 并发执行：当前实现并不并行触发多个 `TaskTool.execute`。要并发化需要对 `loop()` 或 `TaskTool` 做改动（例如收集一批 tasks 后用 `Promise.all()` 并发执行），但这会带来资源争用、并发写回父会话 `parts`、权限竞态等复杂性，需要仔细设计。

父会话与子会话之间的数据流

1. 父会话在消息历史中插入一个 `tool` part（`tool: TaskTool.id`，`status: running`），记录 `callID`。
2. 父会话调用 `taskTool.execute(...)` 并传入 `taskCtx`（包含 `messages`、`abort`、`ask`、`metadata` 回调等）。
3. `TaskTool` 创建/恢复一个子会话，并在子会话中调用 `SessionPrompt.prompt(...)` 发起真正的 LLM/agent 交互。子会话自身有完整的 `loop()`、`AbortController`、权限与 compaction 流程。 
4. 子任务完成后，`TaskTool.execute` 返回结果，父会话更新 `tool` part（`completed` 或 `error`）并可能插入合成用户消息以保持后续模型推理的正确性。

错误、取消与清理

- 父会话的 `abort` 信号会传递给 `TaskTool` 的 `ctx.abort`，`TaskTool` 注册监听器以在父中止时取消子会话（并在返回路径中清理监听器）。
- 若子任务失败，父会话会把对应的 `tool` part 标为 `error` 并写入错误信息，`assistantMessage.finish` 会被设置为 `tool-calls`，以便 loop 后续处理。

示例时序（10 个子任务）

- Plan 产出 10 个 `subtask` parts（假设顺序为 #1..#10）。
- 父 loop 收集 tasks 并使用 `tasks.pop()`：第一次迭代执行 #10、第二次执行 #9、以此类推，直到 #1。
- 每个子任务执行包含：父写入 tool part -> 调用 `TaskTool.execute` -> 子会话创建/恢复并运行 -> 子会话完成并返回 -> 父更新 part 状态 -> loop 继续。

可选改进与建议

- 如果需要 FIFO（先入先出）语义，可改为 `tasks.shift()` 或在收集阶段维护队列顺序。
- 并行执行：可实现一个并行池（例如并发 N 个子任务）来提升吞吐，但需要：
  - 严格的并发写回逻辑（避免多个并发任务同时修改相同 parent message 的 parts）
  - 权限与中止协调（确保 abort 时正确取消所有子会话）
  - 更细粒度的资源/费用控制（避免并发触发大量 LLM 调用）

参考文件

- `packages/opencode/src/session/prompt.ts`（`loop()` 中的 subtask 分支）
- `packages/opencode/src/tool/task.ts`（`TaskTool` 的实现）


---

(此文件由会话助手自动生成，保存当前讨论的要点，若需补充示例或图表请告知将继续追加。)

