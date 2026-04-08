根据对 OpenCode 项目源码的深入分析，我来详细介绍其 **Memory 系统** 和 **编程任务的分步实现机制**。

---

## 一、Memory 系统架构

### 1.1 核心数据模型（树形结构）

OpenCode 的 Memory 系统采用 **三级树形结构**：

```
Session (根节点)
├── Message 1 (用户)
│   ├── Part: text
│   └── Part: file
├── Message 2 (助手)
│   ├── Part: text
│   ├── Part: tool-call (write)
│   └── Part: step-finish
├── Message 3 (用户 - 子任务)
│   └── Part: subtask
└── Session 1.1 (子会话，通过 parentID 关联)
    └── ...
```

**核心文件**：
- `packages/opencode/src/session/index.ts` — Session CRUD
- `packages/opencode/src/session/message-v2.ts` — 消息与 Part 数据模型
- `packages/opencode/src/session/prompt.ts` — 会话主循环 `loop()`

### 1.2 Part 类型系统

```ts
// User Message Parts
- text      // 用户输入文本
- file      // 附件（图片、PDF等）
- agent     // @agent 显式指定的 Agent
- subtask   // 子任务指令

// Assistant Message Parts  
- text       // 模型生成的文本
- reasoning  // 模型的推理过程
- tool       // 工具调用（pending/running/completed/error）
- step-start / step-finish  // LLM 调用标记
- patch      // 文件修改列表
- snapshot   // 代码快照
```

### 1.3 记忆压缩机制

当上下文超过模型限制时，触发 **Compaction**：

```
剪枝(Prune) → 压缩(Compact) → 摘要(Summary)
```

- **剪枝**：从后向前扫描，标记旧的 tool output 为 `compacted`
- **压缩**：调用 `compaction` Agent 生成对话摘要
- **摘要**：包含 Goal、Instructions、Discoveries、Accomplished、Relevant files

---

## 二、编程任务的分步实现

### 2.1 Plan 模式（5阶段工作流）

架构设计 **不是完全预写在 skill 中**，而是通过 **prompt 文件 + LLM 动态执行**：

**Prompt 文件位置**：
- `packages/opencode/src/session/prompt/plan.txt`
- `packages/opencode/src/session/prompt/build-switch.txt`

**5阶段流程**（定义在 `prompt.ts:1474-1544`）：

| 阶段 | 目标 | 关键动作 |
|------|------|----------|
| **Phase 1: Initial Understanding** | 全面理解需求 | 启动 1-3 个 `explore` subagent 并行探索代码库 |
| **Phase 2: Design** | 设计实现方案 | 启动 `general` agent 设计实现 |
| **Phase 3: Review** | 审查计划 | 读取关键文件，使用 `question` 工具澄清 |
| **Phase 4: Final Plan** | 写入计划文件 | 唯一可编辑的文件 `.opencode/plans/*.md` |
| **Phase 5: Call plan_exit** | 请求批准 | 切换到 `build` agent 开始执行 |

**如何保证无遗漏**：
- Plan agent 被配置为 **禁止所有编辑工具**（`edit: deny`）
- 只能写入计划文件，强制分离"规划"和"执行"
- `plan_exit` 工具需要用户显式批准后才切换 agent

### 2.2 Task 工具（子任务委派）

```ts
// packages/opencode/src/tool/task.ts
const parameters = z.object({
  description: z.string(),     // 任务简短描述
  prompt: z.string(),          // 任务详细指令
  subagent_type: z.string(),   // 使用的子 Agent
  task_id: z.string().optional(), // 恢复已有任务
})
```

**子任务创建**：
```ts
await Session.create({
  parentID: ctx.sessionID,  // 关键：建立父子关系
  title: params.description + ` (@${agent.name} subagent)`,
  permission: [
    { permission: "todowrite", pattern: "*", action: "deny" }, // 子任务禁止修改父 todo
    { permission: "task", pattern: "*", action: "deny" },      // 禁止递归 task
  ],
})
```

**防止无限循环**：
- 子 Agent 自动禁用 `todowrite` 和 `task` 工具
- 必须通过 `task` 工具调用，不能直接递归

### 2.3 Todo 工具（任务列表管理）

```ts
// packages/opencode/src/tool/todo.ts
export const TodoWriteTool = Tool.define("todowrite", {
  parameters: z.object({
    todos: z.array(z.object({
      id: z.string(),
      title: z.string(),
      status: z.enum(["pending", "in_progress", "completed"]),
      // ...
    }))
  })
})
```

**使用模式**：
1. LLM 分析任务后，调用 `todowrite` 创建任务列表
2. 每完成一个子任务，更新状态为 `completed`
3. 父会话可见所有 todo，子会话被禁止修改 todo（避免污染）

---

## 三、树形结构的管理机制

### 3.1 Session 树的构建

```ts
// Session.Info 定义
export type Info = {
  id: SessionID
  parentID?: SessionID  // 父会话 ID，形成树形结构
  // ...
}
```

**创建子会话**（Task 工具内部）：
```ts
const session = await Session.create({
  parentID: ctx.sessionID,  // 继承父会话 ID
  // ...
})
```

### 3.2 消息流的组织

```
主会话 (Session A)
├── User: "实现登录功能"
├── Assistant: 调用 task 工具
│   └── ToolPart: { type: "task", sessionId: "Session-B" }
├── (等待子会话完成)
├── Assistant: 收到子会话结果
│   └── "子会话 Session-B 完成，实现了用户认证..."
└── ...
    子会话 (Session B, parentID = Session A)
    ├── User: "实现用户认证模块"
    ├── Assistant: 写入 auth.ts
    └── Assistant: 返回结果
```

### 3.3 上下文隔离

**子 Agent 的隔离机制**：
```ts
// task.ts:86-111
permission: [
  // 子任务不能修改父会话的 todo
  ...(hasTodoWritePermission ? [] : [{
    permission: "todowrite",
    pattern: "*",
    action: "deny"
  }]),
  // 子任务不能继续创建子任务（防止深度递归）
  ...(hasTaskPermission ? [] : [{
    permission: "task", 
    pattern: "*",
    action: "deny"
  }]),
]
```

### 3.4 任务恢复机制

通过 `task_id` 可以恢复之前的子任务：
```ts
if (params.task_id) {
  const found = await Session.get(SessionID.make(params.task_id))
  if (found) return found  // 恢复已有会话
}
// 否则创建新会话
```

---

## 四、架构设计的来源

| 设计元素 | 来源 | 说明 |
|----------|------|------|
| **5阶段 Plan 流程** | `prompt.ts` 中的硬编码 prompt | 约 70 行的 system-reminder 注入 |
| **Agent 角色定义** | `agent/agent.ts` | `build`, `plan`, `explore`, `general` 等内置 agent |
| **Skill 知识** | `SKILL.md` 文件 + `skill/` 目录 | 动态加载，非预置 |
| **任务分解策略** | LLM 自主决定 + `todowrite` 约束 | 无固定模板，根据上下文生成 |

**关键设计原则**：
1. **渐进式披露**：Skill 内容按需加载（metadata → SKILL.md body → bundled resources）
2. **权限分层**：Agent 默认权限 → 用户配置 → 会话级权限，每层可覆盖
3. **事件驱动**：所有状态变更通过 `SyncEvent` 或 `BusEvent` 发布，UI 实时响应

---

## 五、总结

OpenCode 的 Memory 系统是一个 **树形结构的消息系统**，通过以下机制管理复杂编程任务：

1. **Plan 模式**：预定义的 5 阶段工作流（prompt 驱动），分离规划与执行
2. **Task 工具**：创建子会话形成树形结构，支持并行 subagent
3. **Todo 工具**：任务列表状态管理，保证执行无遗漏
4. **权限隔离**：子 Agent 自动禁用递归工具，防止无限循环
5. **记忆压缩**：自动剪枝和压缩，处理长上下文

架构设计 **部分是预定义的**（如 Plan 阶段的流程在 prompt 文件中），**部分是 LLM 动态生成**的（如具体的任务分解策略）。
