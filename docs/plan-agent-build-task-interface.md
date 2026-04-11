# Plan Agent 如何调用 Build / 子 Agent，以及结果如何返回

本文回答两个问题：

1. `plan` agent 是如何把工作交给不同的 `build` / 子 agent 执行的？
2. 执行结果又是如何返回给 `plan` agent 的？

本文基于这些源码：

- `packages/opencode/src/tool/plan.ts`
- `packages/opencode/src/tool/task.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/tool/tool.ts`
- `packages/opencode/src/session/index.ts`

---

## 1. 先说结论

`plan` agent **不会直接调用某个 build agent 的函数**。仓库里真正存在的是两条不同链路：

- **`plan -> build` 切换链路**
  - 入口是 `plan_exit`
  - 它不是“子 agent 调用”，而是**写入一条新的 user message**，把下一轮会话切到 `build`

- **`task` 子任务链路**
  - 入口是 `task`
  - 它会按 `subagent_type` 选择具体子 agent，创建或恢复子会话，然后运行子任务
  - 这条链路才是“把任务交给别的 agent 执行”

---

## 2. `plan -> build` 是怎么切换的

### 入口：`PlanExitTool.execute()`

文件：`packages/opencode/src/tool/plan.ts`

流程：

1. 读取当前 session
2. 计算 plan 文件路径
3. 通过 `Question.ask()` 询问用户是否切到 `build`
4. 如果用户选择 `No`，抛出 `Question.RejectedError()`
5. 如果用户选择 `Yes`：
   - 用 `getLastModel()` 读取最近一次模型
   - 新建一条 `user` 消息，并把 `agent` 设为 `build`
   - 再写入一条 synthetic 文本 part，提示进入执行阶段
6. 返回标准 tool result

### 本质

这里不是切一个全局 mode，而是：

- **写入新的 user 消息**
- **把这条消息标记成 `build` agent**
- **让下一轮 `SessionPrompt.loop()` 自然进入 build 阶段**

---

## 3. `plan` 如何把任务交给不同的子 agent

### 入口：`TaskTool.execute()`

文件：`packages/opencode/src/tool/task.ts`

`task` 工具的参数里有一个关键字段：

- `subagent_type`

它表示要调用哪个具体 agent，例如 `build`、`explore`、`general` 等非 `primary` agent。

### 核心流程

1. 获取可用 agent 列表
2. 过滤掉 `mode === "primary"` 的 agent
3. 根据 `subagent_type` 找到目标 agent
4. 根据是否有 `task_id`：
   - 有就恢复旧子会话
   - 没有就新建子会话，并把 `parentID` 指向当前 session
5. 解析任务 prompt
6. 调用 `SessionPrompt.prompt()` 启动子会话
7. 从子会话最终消息中提取结果文本
8. 把结果包装成 tool output 返回

### 关键点

`task` 不是“同步调用另一个 agent 的普通函数”，而是：

- 创建/恢复一个**独立子会话**
- 用子 agent 自己的上下文执行
- 再把结果作为 tool output 回传给父会话

---

## 4. 结果是怎么返回给 `plan` / 父 agent 的

### 外层接口：`SessionPrompt.resolveTools()`

文件：`packages/opencode/src/session/prompt.ts`

当模型调用工具时，`resolveTools()` 会：

1. 构造 `Tool.Context`
2. 调用真实工具的 `execute()`
3. 把返回值包装成 AI SDK 工具输出
4. 再由会话循环把结果写回当前消息的 tool part

### 也就是说

返回链路不是 callback，而是：

- `TaskTool.execute()` 返回 `title / metadata / output`
- `SessionPrompt.resolveTools()` 接住这个返回值
- 会话系统把它写进同一条 assistant 消息下的 `tool part`
- 父 agent 下一轮推理时就能看到这段结果

### `TaskTool.execute()` 的返回结构

大致是：

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

其中 `output` 的内容包含：

```text
task_id: <session-id>

<task_result>
<子 agent 最终文本结果>
</task_result>
```

---

## 5. `plan` 和 `task` 的区别

### `plan_exit`

- 用于 **plan 阶段结束**
- 作用是切换到 `build`
- 不会创建子会话
- 更像“阶段切换器”

### `task`

- 用于 **把局部工作委派给子 agent**
- 会创建或恢复子会话
- 会把结果回写到父会话
- 更像“任务树分发器”

---

## 6. 本地 Ollama 的实际测试

我用本地 Ollama `qwen3.5:0.8b` 跑过真实请求测试。

测试文件：

- `packages/opencode/test/session/plan-mode.test.ts`

推荐命令：

```bash
cd /Users/charles/Documents/Code/AI/opencode/packages/opencode
bun test test/session/plan-mode.test.ts --reporter=dot
```

如果你启用了实验性 plan mode，再跑一次：

```bash
cd /Users/charles/Documents/Code/AI/opencode/packages/opencode
OPENCODE_EXPERIMENTAL_PLAN_MODE=true bun test test/session/plan-mode.test.ts --reporter=dot
```

注意：

- 普通模式和实验性 plan mode 注入的 reminder 文本不同
- 测试应根据当前环境变量选择对应断言

---

## 7. 小结

一句话概括：

- `plan -> build` 是**通过新 user message 切阶段**
- `task` 是**通过子会话委派任务**
- 结果返回给父 agent 是**通过 tool result 回写到 tool part**

如果你要继续扩展这块，重点看这三个接口：

- `PlanExitTool.execute()`
- `TaskTool.execute()`
- `SessionPrompt.resolveTools()`

