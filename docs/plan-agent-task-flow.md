# `plan` agent 调用 `build` / 子 agent 的任务链路说明

本文基于 `packages/opencode/src/tool/plan.ts`、`packages/opencode/src/tool/task.ts`、`packages/opencode/src/session/prompt.ts`、`packages/opencode/src/tool/tool.ts`、`packages/opencode/src/agent/agent.ts` 的源码整理。

## 1. 先说结论

`plan` agent 本身**不会直接“调用某个 build agent”去执行任务**。仓库里实际存在两条不同链路：

1. **`plan -> build` 切换链路**
   - 由 `plan_exit` 工具触发。
   - 它不会创建一个真正的“子任务代理调用”，而是通过写入一条新的 `user` 消息，把当前 session 的下一轮 agent 切到 `build`。

2. **主 agent -> 子 agent 委派链路**
   - 由 `task` 工具触发。
   - 它会根据 `subagent_type` 选择一个具体的 agent，创建或恢复子会话，然后执行子任务。
   - 这条链路常用于 `build`、`general`、`explore` 等非 `primary` agent 的任务分发。

所以：
- 如果你问的是“计划完成后怎么切到实现阶段”，答案是 `plan_exit`。
- 如果你问的是“一个 agent 如何把局部工作交给别的 agent”，答案是 `task`。

---

## 2. `plan -> build` 是怎么切的

对应实现：`packages/opencode/src/tool/plan.ts`

### 2.1 入口：`PlanExitTool.execute()`

`plan_exit` 只负责“确认是否切换到 `build`”。流程是：

1. 读取当前 session。
2. 计算 plan 文件路径。
3. 通过 `Question.ask()` 询问用户是否切换到 `build`。
4. 如果用户选择 `No`，抛出 `Question.RejectedError()`。
5. 如果用户选择 `Yes`：
   - 读取最近一次的模型 `getLastModel()`；
   - 新建一条 `user` 消息，并把 `agent` 设为 `build`；
   - 再插入一条 synthetic 文本 part，提示 `build` 开始执行计划。
6. 返回标准 tool result。

### 2.2 关键点

这里的“切换”不是直接调用另一个 agent 的函数，而是：

- **写入新的 user message**
- **把这条 message 的 `agent` 标记为 `build`**
- **让下一轮 `SessionPrompt.loop()` 按 `build` 重新进入执行**

也就是说，`plan_exit` 更像是一个“会话状态切换器”。

### 2.3 `plan_exit` 的返回结果

`PlanExitTool.execute()` 返回的是标准 tool result：

- `title: "Switching to build agent"`
- `output: "User approved switching to build agent..."`
- `metadata: {}`

这份返回值会被外层 tool 执行器写回当前 tool call，对模型来说是可见的工具响应。

---

## 3. `task` 工具如何把任务交给别的 agent

对应实现：`packages/opencode/src/tool/task.ts`

### 3.1 参数接口

`TaskTool` 的参数 schema 是：

```ts
{
  description: string
  prompt: string
  subagent_type: string
  task_id?: string
  command?: string
}
```

含义：
- `description`：任务摘要
- `prompt`：真正给子 agent 的任务内容
- `subagent_type`：要用哪个 agent
- `task_id`：可选，恢复之前的子会话
- `command`：可选，触发该任务的命令

### 3.2 调用链

`TaskTool.execute()` 的核心流程是：

1. 先拿到可用 agent 列表。
   - 只允许 `mode !== "primary"` 的 agent 作为子 agent。
   - 再根据当前调用者权限过滤。
2. 通过 `Agent.get(params.subagent_type)` 找到目标 agent。
3. 计算是否需要禁用递归工具：
   - 如果子 agent 没有 `task` 权限，就禁用 `task`
   - 如果子 agent 没有 `todowrite` 权限，就禁用 `todowrite`
4. 根据 `task_id` 决定：
   - 有 `task_id` 时尝试恢复旧会话
   - 没有则创建新子会话，`parentID` 指向当前 session
5. 通过 `SessionPrompt.resolvePromptParts()` 解析任务 prompt。
6. 调用 `SessionPrompt.prompt()` 启动子会话。
7. 从子会话结果里抽取最后一条文本，作为任务结果输出。

### 3.3 为什么这样设计

这样做有两个好处：

- **子任务隔离**：每个子 agent 都有自己的会话、自己的消息历史、自己的权限上下文。
- **可恢复**：`task_id` 能把同一个子会话继续跑下去，不必每次都新建。

---

## 4. 任务结果是怎么返回给父 agent 的

这里的“返回”不是回调函数，而是**通过 tool result 回写到父会话的 tool part**。

### 4.1 外层执行器：`SessionPrompt.resolveTools()`

对应实现：`packages/opencode/src/session/prompt.ts`

当模型在当前会话里调用 `task` 时，`resolveTools()` 会把工具包装成 AI SDK 可执行的 tool：

1. 构造 `Tool.Context`。
2. 调用真实工具 `item.execute(args, ctx)`。
3. 把工具返回值包装成 AI SDK 输出。
4. 再由会话循环把结果写入当前消息的 tool part。

### 4.2 结果回写的位置

`task` 执行完后，`SessionPrompt.prompt()` 会：

- 生成一个 `assistant` 消息，里面有一个 `tool` part，状态先是 `running`。
- 调用 `TaskTool.execute()`。
- 如果成功：
  - 把 tool part 更新为 `completed`
  - 写入 `title / metadata / output / attachments`
- 如果失败：
  - 把 tool part 更新为 `error`

所以父 agent 实际看到的是：

- 工具输出文本
- 工具元数据
- 附件
- 最终都挂在同一条 assistant 消息的 tool part 上

之后模型会在下一轮推理里把这段 tool 输出当作上下文继续处理。

### 4.3 `TaskTool.execute()` 的返回结构

`TaskTool.execute()` 最终返回：

```ts
{
  title: string
  metadata: {
    sessionId: string
    model: { providerID: string; modelID: string }
  }
  output: string
}
```

其中 `output` 的格式是：

```text
task_id: <session-id>

<task_result>
<子 agent 最终文本结果>
</task_result>
```

这就是父 agent 后续继续追问、继续规划、继续分解任务所依据的返回内容。

---

## 5. `Tool` 接口是什么

对应实现：`packages/opencode/src/tool/tool.ts`

### 5.1 `Tool.Info`

每个工具都遵守同一个接口：

```ts
{
  id: string
  init(ctx?): Promise<{
    description: string
    parameters: ZodSchema
    execute(args, ctx): Promise<{
      title: string
      metadata: object
      output: string
      attachments?: FilePart[]
    }>
  }>
}
```

### 5.2 `Tool.Context`

执行工具时会拿到一个上下文：

```ts
{
  sessionID: string
  messageID: string
  agent: string
  abort: AbortSignal
  callID?: string
  extra?: object
  messages: MessageV2.WithParts[]
  metadata(input): void
  ask(input): Promise<void>
}
```

这里最重要的两个方法是：

- `metadata()`：更新当前 tool part 的标题和元数据
- `ask()`：触发权限确认

### 5.3 `PlanExitTool` 和 `TaskTool` 的差异

- `PlanExitTool`
  - 参数为空
  - 作用是切换会话进入 `build`
  - 不创建子会话

- `TaskTool`
  - 参数里有 `subagent_type`
  - 作用是创建/恢复子会话
  - 任务结果会作为 tool output 返回给父会话

---

## 6. `plan` agent 相关的权限边界

对应实现：`packages/opencode/src/agent/agent.ts`

### 6.1 `plan` 的权限

`plan` 是 `primary` agent，默认：

- 允许 `question`
- 允许 `plan_exit`
- 禁止绝大多数编辑行为
- 仅对计划文件路径开放写权限

### 6.2 为什么 `plan` 不能直接改代码

因为 `plan` 的目标是：

- 研究
- 设计
- 产出计划
- 等用户确认后再切到 `build`

真正的代码实施阶段由 `build` 承担。

---

## 7. 一张流程图

```mermaid
flowchart TD
    A[plan agent 产出计划] --> B[调用 plan_exit]
    B --> C{用户是否确认切换?}
    C -->|No| D[继续留在 plan]
    C -->|Yes| E[写入新的 user message: agent=build]
    E --> F[下一轮 loop 进入 build]

    G[当前 agent 需要委派局部任务] --> H[调用 task(subagent_type=...)]
    H --> I[创建/恢复子会话]
    I --> J[SessionPrompt.prompt 执行子 agent]
    J --> K[子 agent 最终文本结果]
    K --> L[作为 tool output 写回父会话 tool part]
    L --> M[父 agent 读取结果继续推理]
```

---

## 8. 结论

如果只回答一句话：

- **`plan` agent 切到 `build`**：靠 `plan_exit`，本质是写入一条新的 `build` 用户消息。
- **`plan` 或其他 agent 委派任务给别的 agent**：靠 `task`，本质是创建/恢复子会话并把结果作为 tool output 回传。
- **结果回传接口**：统一走 `Tool.Context` + `Tool.Info.execute()` 的标准工具接口，最终落到当前会话的 tool part。

如果你想继续深挖实现细节，可以接着看：
- `packages/opencode/src/tool/plan.ts`
- `packages/opencode/src/tool/task.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/tool/tool.ts`
- `packages/opencode/src/agent/agent.ts`

