# TaskTool 详解

## 概述

TaskTool 是 OpenCode 中最强大的工具之一,它允许将复杂的多步骤任务委托给专门的子智能体(subagent)自主执行。通过创建独立的子会话(child session),TaskTool 实现了任务的并行处理、权限隔离和上下文管理。

**文件位置**: `packages/opencode/src/tool/task.ts`

## 核心特性

### 1. 子会话架构
- 每个任务在**独立的子会话**中执行
- 子会话具有唯一的 `sessionID`,与父会话隔离
- 支持通过 `task_id` 恢复之前的子会话,保持上下文连续性

### 2. LLM 驱动的执行机制

**重要**: TaskTool **不是本地执行工具**,而是通过调用 LLM 来执行任务。

#### 执行流程

```
父会话 (Parent Session)
  ├─ LLM 调用 #1: 决定调用 TaskTool
  │
  └─ TaskTool.execute()
       └─ 创建子会话 (Child Session)
            ├─ LLM 调用 #2: 子任务自己的对话循环
            ├─ 可能调用其他工具 (read/write/bash...)
            ├─ 多轮对话直到任务完成
            └─ 返回最终结果
       
       └─ 将结果返回给父会话
            └─ 父会话继续 LLM 调用 #3 (基于子任务结果)
```

#### 代码证据

从 `packages/opencode/src/session/prompt.ts` 可以看到:

```typescript
// 确定子任务使用的模型(如果指定则使用指定的,否则继承父任务模型)
const taskModel = task.model 
  ? await Provider.getModel(task.model.providerID, task.model.modelID) 
  : model

// 执行子任务工具 - 这会触发完整的 LLM 对话循环
const result = await taskTool.execute(taskArgs, taskCtx)
```

而 `taskTool.execute` 内部会调用 `SessionPrompt.prompt()`,后者会:
1. 构建消息历史
2. **调用 LLM API** (`Provider.stream()`)
3. 处理流式响应
4. 执行工具调用
5. 继续下一轮对话...

#### 为什么这样设计?

1. **智能决策**: 子任务可以自主决定使用哪些工具、如何分解问题
2. **隔离性**: 每个子任务有独立的上下文和消息历史
3. **灵活性**: 可以为不同任务选择不同的 agent 和模型
4. **可恢复性**: 子会话可以独立保存和恢复
5. **权限控制**: 可以限制子任务的工具访问权限(如禁止嵌套 task)

这也是为什么需要控制 `MAX_PARALLEL_SUBTASKS = 3` —— 因为每个子任务都会发起独立的 LLM 调用,消耗 token 和 API 配额。

### 3. 权限控制
- 自动禁用递归的 `task` 和 `todowrite` 工具(防止无限循环)
- 基于父会话和子智能体的权限规则进行动态过滤
- 支持细粒度的子智能体访问控制(glob 模式匹配)

### 4. 并行执行
- 支持同时启动多个子任务(最多 MAX_PARALLEL_SUBTASKS 个)
- 通过单次消息中的多个 tool calls 实现真正的并发

### 5. 模型灵活性
- 可以为不同的子任务选择不同的模型
- 优先使用子智能体配置的模型,否则继承父会话的模型

## 参数定义

```typescript
const parameters = z.object({
  // 任务简短描述(3-5个词)
  description: z.string().describe("A short (3-5 words) description of the task"),
  
  // 要执行的具体任务指令
  prompt: z.string().describe("The task for the agent to perform"),
  
  // 使用的专用智能体类型
  subagent_type: z.string().describe("The type of specialized agent to use for this task"),
  
  // 可选:用于恢复之前的任务会话
  task_id: z.string()
    .describe("This should only be set if you mean to resume a previous task...")
    .optional(),
  
  // 可选:触发此任务的命令
  command: z.string().describe("The command that triggered this task").optional(),
})
```

### 参数说明

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `description` | string | ✅ | 任务的简短描述,用于UI显示和日志记录 |
| `prompt` | string | ✅ | 详细的任务指令,子智能体将基于此执行 |
| `subagent_type` | string | ✅ | 要使用的子智能体类型名称 |
| `task_id` | string | ❌ | 恢复之前子会话的ID,用于延续上下文 |
| `command` | string | ❌ | 触发任务的命令名称(内部使用) |

## 工作流程

### 阶段1: 初始化和权限检查

```typescript
// L101-116: 获取配置并进行权限验证
async execute(params, ctx) {
  const config = await Config.get()
  
  // 权限检查(除非显式绕过)
  if (!ctx.extra?.bypassAgentCheck) {
    await ctx.ask({
      permission: "task",
      patterns: [params.subagent_type],
      always: ["*"],
      metadata: {
        description: params.description,
        subagent_type: params.subagent_type,
      },
    })
  }
  
  // 获取指定的智能体
  const agent = await Agent.get(params.subagent_type)
  if (!agent) throw new Error(`Unknown agent type: ${params.subagent_type}`)
}
```

**关键点**:
- 检查调用者是否有权限使用指定的子智能体
- 如果用户通过 `@agent` 或命令显式调用,可以绕过检查(`bypassAgentCheck`)
- 抛出错误如果指定的智能体不存在

### 阶段2: 权限分析与会话创建

```typescript
// L122-174: 检查权限并创建子会话
const hasTaskPermission = agent.permission.some((rule) => rule.permission === "task")
const hasTodoWritePermission = agent.permission.some((rule) => rule.permission === "todowrite")

const session = await iife(async () => {
  // 尝试恢复现有会话
  if (params.task_id) {
    const found = await Session.get(SessionID.make(params.task_id)).catch(() => {})
    if (found) return found
  }
  
  // 创建新的子会话
  return await Session.create({
    parentID: ctx.sessionID,  // 设置父会话ID
    title: params.description + ` (@${agent.name} subagent)`,
    
    // 配置权限规则
    permission: [
      // 如果没有 todowrite 权限,显式拒绝
      ...(hasTodoWritePermission ? [] : [{
        permission: "todowrite",
        pattern: "*",
        action: "deny",
      }]),
      
      // 如果没有 task 权限,显式拒绝(防止递归)
      ...(hasTaskPermission ? [] : [{
        permission: "task",
        pattern: "*",
        action: "deny",
      }]),
      
      // 允许实验性的 primary_tools
      ...(config.experimental?.primary_tools?.map((t) => ({
        pattern: "*",
        action: "allow",
        permission: t,
      })) ?? []),
    ],
  })
})
```

**权限策略**:
1. **防止递归**: 如果子智能体没有 `task` 权限,禁止其再次调用 task tool
2. **限制待办事项**: 如果子智能体没有 `todowrite` 权限,禁用该工具
3. **实验性功能**: 允许配置中指定的 `primary_tools`

### 阶段3: 模型选择和元数据设置

```typescript
// L176-193: 确定模型并设置元数据
const msg = await MessageV2.get({ 
  sessionID: ctx.sessionID, 
  messageID: ctx.messageID 
})
if (msg.info.role !== "assistant") throw new Error("Not an assistant message")

// 模型优先级: agent配置 > 当前消息模型
const model = agent.model ?? {
  modelID: msg.info.modelID,
  providerID: msg.info.providerID,
}

// 设置元数据(UI实时显示)
ctx.metadata({
  title: params.description,
  metadata: {
    sessionId: session.id,
    model,
  },
})
```

### 阶段4: 中止控制和资源管理

```typescript
// L195-209: 设置中止监听器
const messageID = MessageID.ascending()

function cancel() {
  SessionPrompt.cancel(session.id)
}

// 当父任务中止时,自动取消子任务
ctx.abort.addEventListener("abort", cancel)

// 确保退出时清理事件监听器
using _ = defer(() => ctx.abort.removeEventListener("abort", cancel))
```

**资源管理**:
- 使用 `defer` 确保事件监听器被正确清理
- 父子任务的中止信号联动,避免孤儿任务

### 阶段5: 提示解析和执行

```typescript
// L211-237: 解析提示并执行子会话
const promptParts = await SessionPrompt.resolvePromptParts(params.prompt)

const result = await SessionPrompt.prompt({
  messageID,
  sessionID: session.id,
  model: {
    modelID: model.modelID,
    providerID: model.providerID,
  },
  agent: agent.name,
  
  // 工具配置:根据权限禁用相应工具
  tools: {
    ...(hasTodoWritePermission ? {} : { todowrite: false }),
    ...(hasTaskPermission ? {} : { task: false }),
    ...Object.fromEntries(
      (config.experimental?.primary_tools ?? []).map((t) => [t, false])
    ),
  },
  
  parts: promptParts,
})
```

**关键步骤**:
1. `resolvePromptParts`: 解析提示中的文件引用(@file)和智能体提及(@agent)
2. 传递禁用的工具列表,确保子智能体无法使用受限工具
3. 执行完整的 agent-tool-llm 循环

### 阶段6: 结果提取和返回

```typescript
// L239-260: 提取结果并构建输出
const text = result.parts.findLast((x) => x.type === "text")?.text ?? ""

const output = [
  `task_id: ${session.id} (for resuming to continue this task if needed)`,
  "",
  "<task_result>",
  text,
  "</task_result>",
].join("\n")

return {
  title: params.description,
  metadata: {
    sessionId: session.id,
    model,
  },
  output,
}
```

**输出格式**:
```
task_id: ses_abc123 (for resuming to continue this task if needed)

<task_result>
[子智能体的最后一条文本消息]
</task_result>
```

## 可用智能体过滤

TaskTool 在初始化时会动态生成可用智能体列表:

```typescript
// L66-85: 获取并过滤可用智能体
const agents = await Agent.list()
  .then((x) => x.filter((a) => a.mode !== "primary"))

// 根据权限进一步过滤
const caller = ctx?.agent
const accessibleAgents = caller
  ? agents.filter((a) => 
      Permission.evaluate("task", a.name, caller.permission).action !== "deny"
    )
  : agents

// 按名称排序
const list = accessibleAgents.toSorted((a, b) => 
  a.name.localeCompare(b.name)
)

// 动态生成描述
const description = DESCRIPTION.replace("{agents}", 
  list.map((a) => 
    `- ${a.name}: ${a.description ?? "..."}`
  ).join("\n")
)
```

**过滤规则**:
1. 排除 `mode: "primary"` 的智能体(不能作为子智能体)
2. 根据调用者的权限规则过滤被拒绝的智能体
3. 按字母顺序排序,便于查找

## 权限评估机制

### 权限规则示例

```json
{
  "agent": {
    "orchestrator": {
      "permission": {
        "task": {
          "*": "deny",              // 默认拒绝所有
          "orchestrator-*": "allow", // 但允许 orchestrator 前缀的
          "code-reviewer": "ask"     // code-reviewer 需要询问
        }
      }
    }
  }
}
```

### 评估逻辑

```typescript
// packages/opencode/src/permission/index.ts
Permission.evaluate("task", "code-reviewer", ruleset)
// 返回: { action: "ask", ... }

Permission.evaluate("task", "orchestrator-planner", ruleset)
// 返回: { action: "allow", ... } (匹配 orchestrator-*)

Permission.evaluate("task", "unknown-agent", ruleset)
// 返回: { action: "deny", ... } (匹配 *)
```

**规则匹配顺序**:
- 规则按声明顺序评估
- **最后一个匹配的规则获胜**(last match wins)
- 支持 glob 模式: `*`, `?`, `[abc]`, `[a-z]`

## 并行执行机制

在 `packages/opencode/src/session/prompt.ts` 中实现了批量并行执行:

```typescript
// L722-732: 收集批处理的子任务
const batch: MessageV2.SubtaskPart[] = [task as MessageV2.SubtaskPart]
for (let i = 1; i < MAX_PARALLEL_SUBTASKS; i++) {
  const t = tasks.pop()
  if (!t) break
  if (t.type === "subtask") batch.push(t as MessageV2.SubtaskPart)
  else {
    tasks.push(t)
    break
  }
}

// L788-850: 并行执行所有子任务
const execs = created.map(async ({ task: st, assistant, part }) => {
  // 为每个子任务创建独立的执行上下文
  const ctx: Tool.Context = { ... }
  
  // 并行执行
  const result = await taskTool.execute(taskArgs, ctx).catch(...)
  
  return { st, assistant, part, result, error }
})

// 等待所有任务完成
await Promise.all(execs)
```

**并行优势**:
- 多个探索任务可以同时执行
- 显著减少总执行时间
- 每个子任务独立运行,互不干扰

## 实际使用场景

### 场景1: 代码审查

```typescript
// 父会话
await prompt({
  sessionID: "ses_parent",
  parts: [
    {
      type: "text",
      text: "我刚刚完成了用户认证模块,请审查代码质量"
    }
  ]
})

// AI 决定调用 task tool
TaskTool.execute({
  description: "Review auth module",
  prompt: `请审查以下代码的质量和安全性:
  - src/auth/login.ts
  - src/auth/register.ts
  - src/auth/middleware.ts
  
  关注点:
  1. 安全漏洞
  2. 代码规范
  3. 性能问题
  4. 错误处理
  
  提供具体的改进建议。`,
  subagent_type: "code-reviewer"
})

// 子会话执行
// 1. 读取指定文件
// 2. 分析代码质量
// 3. 生成审查报告
// 4. 返回结果

// 父会话收到
{
  output: `task_id: ses_child123
  
  <task_result>
  代码审查报告:
  
  ✅ 优点:
  - 使用了 bcrypt 进行密码哈希
  - 实现了 JWT token 刷新机制
  
  ⚠️ 需要改进:
  1. login.ts 第45行: 缺少输入验证
  2. register.ts 第78行: 未处理数据库连接失败
  3. middleware.ts: 建议添加速率限制
  
  🔒 安全问题:
  - JWT secret 应从环境变量读取,不要硬编码
  </task_result>`
}
```

### 场景2: 多文件搜索和分析

```typescript
// 并行启动多个探索任务
// 单个消息中包含多个 tool calls

TaskTool.execute({
  description: "Find auth implementations",
  prompt: "搜索项目中所有认证相关的实现,包括 OAuth、JWT、session 等",
  subagent_type: "explorer"
})

TaskTool.execute({
  description: "Find security patterns",
  prompt: "查找项目中的安全相关代码模式和最佳实践",
  subagent_type: "explorer"
})

TaskTool.execute({
  description: "Find test coverage",
  prompt: "分析认证模块的测试覆盖情况",
  subagent_type: "explorer"
})

// 三个任务并行执行,完成后汇总结果
```

### 场景3: 恢复之前的任务

```typescript
// 第一次调用
const result1 = await TaskTool.execute({
  description: "Implement feature X",
  prompt: "实现功能X,包括API端点和前端组件",
  subagent_type: "developer"
})
// 返回: task_id: ses_task456

// ... 用户中断或需要暂停 ...

// 后续恢复
const result2 = await TaskTool.execute({
  description: "Continue feature X",
  prompt: "继续之前的工作,完成剩余的单元测试",
  subagent_type: "developer",
  task_id: "ses_task456"  // 恢复同一个子会话
})
// 子会话保留之前的上下文和文件状态
```

### 场景4: 命令触发的子任务

```typescript
// 用户执行命令: /review src/auth/
Command.execute({
  command: "review",
  arguments: "src/auth/",
  sessionID: "ses_main"
})

// 命令内部调用 task tool
TaskTool.execute({
  description: "Review auth directory",
  prompt: "/review src/auth/",
  subagent_type: "code-reviewer",
  command: "review"  // 标记为命令触发
})
```

## 与其他工具的对比

| 特性 | TaskTool | Read/Glob | Bash |
|------|----------|-----------|------|
| **适用场景** | 复杂多步骤任务 | 简单文件读取/搜索 | 命令行操作 |
| **上下文** | 独立子会话 | 当前会话 | 当前会话 |
| **并行能力** | ✅ 天然支持 | ❌ 串行 | ❌ 串行 |
| **权限隔离** | ✅ 完全隔离 | ❌ 共享权限 | ❌ 共享权限 |
| **模型选择** | ✅ 可自定义 | ❌ 固定 | ❌ 固定 |
| **执行成本** | 高(完整LLM循环) | 低 | 低 |
| **推荐用法** | 需要推理的任务 | 确定性操作 | 系统命令 |

**何时使用 TaskTool**:
- ✅ 需要理解和分析代码
- ✅ 多步骤的复杂任务
- ✅ 需要并行执行多个独立任务
- ✅ 需要权限隔离的场景

**何时不使用 TaskTool**:
- ❌ 只需读取特定文件 → 使用 `Read`
- ❌ 搜索类定义 → 使用 `Glob`
- ❌ 在已知文件中查找 → 使用 `Read`
- ❌ 简单的字符串替换 → 使用 `Edit`

## 最佳实践

### 1. 编写清晰的提示

```typescript
// ❌ 不好的提示
{
  prompt: "看看这个代码"
}

// ✅ 好的提示
{
  prompt: `请审查 src/auth/login.ts 文件:

1. 检查输入验证是否完整
2. 确认密码哈希实现是否正确
3. 查找潜在的安全漏洞
4. 评估错误处理机制

对于每个发现的问题,提供:
- 问题描述
- 风险等级(高/中/低)
- 修复建议
- 代码示例(如果需要)`
}
```

### 2. 明确期望的输出

```typescript
{
  prompt: `分析项目的依赖关系。

请在最终回复中包含:
1. 核心依赖列表(包名和版本)
2. 发现的过时依赖
3. 潜在的安全风险
4. 建议的更新策略

不需要提供中间分析过程,只需要最终结论。`
}
```

### 3. 利用并行执行

```typescript
// ❌ 串行执行(慢)
await TaskTool.execute({ prompt: "分析前端代码", subagent_type: "explorer" })
await TaskTool.execute({ prompt: "分析后端代码", subagent_type: "explorer" })
await TaskTool.execute({ prompt: "分析测试代码", subagent_type: "explorer" })

// ✅ 并行执行(快)
// 在单个消息中使用多个 tool calls
[
  TaskTool.execute({ prompt: "分析前端代码", subagent_type: "explorer" }),
  TaskTool.execute({ prompt: "分析后端代码", subagent_type: "explorer" }),
  TaskTool.execute({ prompt: "分析测试代码", subagent_type: "explorer" })
]
```

### 4. 合理使用 task_id

```typescript
// 场景: 长时间运行的任务可能被中断
const task1 = await TaskTool.execute({
  description: "Refactor database layer",
  prompt: "重构数据库层,分以下步骤:\n1. 分析现有架构\n2. 设计新架构\n3. 实施重构",
  subagent_type: "architect"
})

// 保存 task_id
saveTaskId(task1.metadata.sessionId)

// 稍后恢复
resumeTask(savedTaskId, "继续第3步:实施重构")
```

### 5. 选择合适的子智能体

```typescript
// ❌ 使用通用智能体做专业任务
{
  subagent_type: "general",
  prompt: "进行安全审计"
}

// ✅ 使用专业智能体
{
  subagent_type: "security-auditor",  // 如果有这个专业智能体
  prompt: "进行安全审计"
}
```

## 配置示例

### 配置子智能体权限

```json
{
  "agent": {
    "planner": {
      "mode": "subagent",
      "model": "openai/gpt-4",
      "permission": {
        "task": {
          "*": "deny",
          "researcher": "allow",
          "writer": "allow"
        },
        "file.read": {
          "*": "allow"
        },
        "file.write": {
          "*.md": "allow",
          "*": "ask"
        }
      }
    },
    
    "researcher": {
      "mode": "subagent",
      "model": "anthropic/claude-3",
      "permission": {
        "task": {
          "*": "deny"
        },
        "web.search": {
          "*": "allow"
        },
        "web.fetch": {
          "*": "allow"
        }
      }
    }
  }
}
```

### 配置实验性工具

```json
{
  "experimental": {
    "primary_tools": ["lsp", "batch"]
  }
}
```

这样所有子智能体都可以使用 `lsp` 和 `batch` 工具。

## 调试技巧

### 1. 查看子会话

```bash
# 列出所有会话(包括子会话)
opencode session list

# 查看特定子会话
opencode session get ses_child123
```

### 2. 启用详细日志

```bash
LOG_LEVEL=debug opencode run
```

会输出:
```
[DEBUG] task tool execution started
[DEBUG] creating child session: ses_child123
[DEBUG] parent session: ses_parent456
[DEBUG] agent: code-reviewer
[DEBUG] model: openai/gpt-4
[DEBUG] permissions configured: {...}
```

### 3. 检查权限配置

```typescript
// 在代码中添加日志
const evaluation = Permission.evaluate("task", agentName, ruleset)
console.log("Permission evaluation:", {
  agent: agentName,
  action: evaluation.action,
  matchedRule: evaluation.rule
})
```

## 常见问题

### Q1: 如何防止无限递归?

**A**: TaskTool 自动处理:
1. 检查子智能体的 `task` 权限
2. 如果没有权限,在子会话中禁用 `task` tool
3. 即使有权限,也可以配置规则限制可调用的子智能体

```json
{
  "permission": {
    "task": {
      "*": "deny"  // 禁止所有子任务调用
    }
  }
}
```

### Q2: 子智能体可以看到父会话的历史吗?

**A**: **不可以**。每个子会话都是独立的:
- 子智能体只能看到自己的消息历史
- 父会话需要通过 `prompt` 参数传递必要的上下文
- 这是设计上的隔离,避免上下文污染

### Q3: 如何传递大量上下文给子智能体?

**A**: 几种方法:
1. **文件引用**: 在 prompt 中使用 `@file/path`
2. **摘要传递**: 父智能体先总结,再传递给子智能体
3. **共享文件系统**: 写入临时文件,子智能体读取

```typescript
{
  prompt: `基于以下文件进行分析:
  @src/config/database.json
  @src/models/User.ts
  @src/services/AuthService.ts
  
  重点关注数据库配置和用户认证流程。`
}
```

### Q4: 子任务失败怎么办?

**A**: 错误会被捕获并返回:
```typescript
const result = await taskTool.execute(taskArgs, taskCtx).catch((error) => {
  executionError = error
  log.error("subtask execution failed", { error, agent: task.agent })
  return undefined  // 返回 undefined 表示失败
})

if (!result) {
  // 处理失败情况
  part.state = {
    status: "error",
    error: executionError.message,
    ...
  }
}
```

父智能体会收到错误信息,可以决定重试或采取其他措施。

### Q5: 如何选择子智能体使用的模型?

**A**: 优先级顺序:
1. 子智能体配置中的 `model` 字段
2. 父会话当前使用的模型

```json
{
  "agent": {
    "researcher": {
      "model": "openai/gpt-4",  // 始终使用 GPT-4
      ...
    }
  }
}
```

## 技术细节

### 会话层次结构

```
Session Hierarchy:
├─ ses_parent (parentID: null)
│  ├─ ses_child1 (parentID: ses_parent)
│  │  └─ ses_grandchild1 (parentID: ses_child1)  // 如果允许递归
│  ├─ ses_child2 (parentID: ses_parent)
│  └─ ses_child3 (parentID: ses_parent)
└─ ses_other (parentID: null)
```

### ID 生成

```typescript
// SessionID 格式
SessionID.make()  // "ses_" + ulid()
// 例如: "ses_01HXYZ123ABC456DEF789GHI"

// MessageID 格式
MessageID.ascending()  // "m_" + 递增计数器
// 例如: "m_000001", "m_000002", ...

// PartID 格式
PartID.ascending()  // "p_" + 递增计数器
// 例如: "p_000001", "p_000002", ...
```

### 资源清理

```typescript
// 使用 defer 确保资源清理
using _ = defer(() => {
  ctx.abort.removeEventListener("abort", cancel)
  // 其他清理操作...
})

// 即使发生错误或提前返回,清理函数也会执行
```

## 相关文件

- **核心实现**: `packages/opencode/src/tool/task.ts`
- **工具基类**: `packages/opencode/src/tool/tool.ts`
- **会话管理**: `packages/opencode/src/session/index.ts`
- **提示执行**: `packages/opencode/src/session/prompt.ts`
- **权限系统**: `packages/opencode/src/permission/index.ts`
- **智能体管理**: `packages/opencode/src/agent/agent.ts`
- **工具描述**: `packages/opencode/src/tool/task.txt`

## 总结

TaskTool 是 OpenCode 实现复杂任务自动化的核心机制:

✅ **强大功能**:
- 委托复杂任务给专业子智能体
- 支持并行执行,提高效率
- 灵活的权限控制和模型选择

✅ **安全可靠**:
- 会话隔离,避免上下文污染
- 自动防止递归调用
- 完善的资源管理和错误处理

✅ **易于使用**:
- 简单的参数接口
- 支持会话恢复
- 丰富的配置选项

**最佳实践**:
1. 为不同类型的任务选择合适的子智能体
2. 编写清晰详细的提示
3. 充分利用并行执行
4. 合理配置权限规则
5. 必要时使用 task_id 恢复任务

通过 TaskTool,OpenCode 能够实现复杂的自动化工作流,同时保持系统的可靠性和可维护性。
