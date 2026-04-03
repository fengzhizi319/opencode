# OpenCode 源码调试指南

本文介绍如何使用源码调试 OpenCode，以"生成python冒泡排序代码，并验证结果正确性"任务为例，展示关键断点位置和调试技巧。

## 目录
- [环境准备](#环境准备)
- [启动调试](#启动调试)
- [关键断点](#关键断点)
- [数据流跟踪](#数据流跟踪)
- [调试技巧](#调试技巧)

---

## 环境准备

### 1. 安装依赖

```bash
cd /Users/charles/Documents/AI/opencode
bun install
```

### 2. 配置调试环境

创建 `.vscode/launch.json`（如果使用 VS Code）：

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug OpenCode CLI",
      "type": "bun",
      "request": "launch",
      "program": "${workspaceFolder}/packages/opencode/src/index.ts",
      "args": ["run", "--", "生成python冒泡排序代码，并验证结果正确性"],
      "cwd": "${workspaceFolder}/packages/opencode",
      "env": {
        "OPENCODE_LOG_LEVEL": "debug",
        "OPENCODE_DEBUG": "true"
      }
    },
    {
      "name": "Debug OpenCode Server",
      "type": "bun",
      "request": "launch",
      "program": "${workspaceFolder}/packages/opencode/src/index.ts",
      "args": ["serve"],
      "cwd": "${workspaceFolder}/packages/opencode",
      "env": {
        "OPENCODE_LOG_LEVEL": "debug"
      }
    }
  ]
}
```

### 3. 日志配置

在 `packages/opencode/.env` 或环境变量中设置：

```bash
# 日志级别: trace, debug, info, warn, error
OPENCODE_LOG_LEVEL=debug

# 启用特定模块的详细日志
OPENCODE_DEBUG=true
OPENCODE_DEBUG_SESSION=true
OPENCODE_DEBUG_TOOL=true
OPENCODE_DEBUG_LLM=true
```

---

## 启动调试

### 方式一：VS Code 调试

1. 打开 VS Code
2. 切换到 "Run and Debug" 面板 (Ctrl+Shift+D)
3. 选择 "Debug OpenCode CLI"
4. 按 F5 启动调试

### 方式二：命令行调试

```bash
cd packages/opencode

# 使用 bun 的调试器
bun --inspect run --conditions=browser ./src/index.ts run -- "生成python冒泡排序代码，并验证结果正确性"

# 或者使用 node 调试协议
bun --inspect=9229 run --conditions=browser ./src/index.ts run -- "生成python冒泡排序代码，并验证结果正确性"
```

然后在 Chrome 中打开 `chrome://inspect` 或使用 VS Code 附加调试器。

### 方式三：TUI 模式调试

```bash
cd packages/opencode
bun run --conditions=browser ./src/index.ts

# 进入交互式界面后，输入任务
> 生成python冒泡排序代码，并验证结果正确性
```

---

## 关键断点

### 阶段一：会话初始化

#### 1. 消息创建
```typescript
// packages/opencode/src/session/prompt.ts:162
export const prompt = fn(PromptInput, async (input) => {
  const session = await Session.get(input.sessionID)
  await SessionRevert.cleanup(session)

  const message = await createUserMessage(input)  // ← 断点 1: 查看创建的消息
  await Session.touch(input.sessionID)
  // ...
})
```

**查看变量：**
- `input` - 用户输入参数
- `message` - 创建的 User Message
- `session` - 当前会话信息

#### 2. 主循环入口
```typescript
// packages/opencode/src/session/prompt.ts:278
export const loop = fn(LoopInput, async (input) => {
  const { sessionID, resume_existing } = input

  const abort = resume_existing ? resume(sessionID) : start(sessionID)
  // ...
  
  while (true) {  // ← 断点 2: 主循环入口
    await SessionStatus.set(sessionID, { type: "busy" })
    // ...
  }
})
```

**查看变量：**
- `sessionID` - 当前会话 ID
- `abort.signal` - 取消信号

---

### 阶段二：Agent 与工具准备

#### 3. Agent 获取
```typescript
// packages/opencode/src/agent/agent.ts:319
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // ...
    const get = Effect.fn("Agent.get")(function* (agent: string) {
      return yield* InstanceState.useEffect(state, (s) => s.get(agent))  // ← 断点 3
    })
    // ...
  })
)
```

**查看变量：**
- `agent` - Agent 名称 (如 "build")
- 返回的 Agent 配置 (权限、模型、prompt 等)

#### 4. Skill 加载
```typescript
// packages/opencode/src/skill/index.ts:230
const available = Effect.fn("Skill.available")(function* (agent?: Agent.Info) {
  const s = yield* InstanceState.get(state)
  const list = Object.values(s.skills).toSorted((a, b) => a.name.localeCompare(b.name))
  if (!agent) return list
  return list.filter((skill) => Permission.evaluate("skill", skill.name, agent.permission).action !== "deny")  // ← 断点 4
})
```

**查看变量：**
- `list` - 所有可用 Skills
- `agent.permission` - 当前 Agent 的权限规则

#### 5. 工具解析
```typescript
// packages/opencode/src/session/prompt.ts:772
export async function resolveTools(input: {
  agent: Agent.Info
  model: Provider.Model
  session: Session.Info
  tools?: Record<string, boolean>
  processor: SessionProcessor.Info
  bypassAgentCheck: boolean
  messages: MessageV2.WithParts[]
}) {
  using _ = log.time("resolveTools")
  const tools: Record<string, AITool> = {}
  // ← 断点 5: 查看输入参数

  for (const item of await ToolRegistry.tools(
    { modelID: ModelID.make(input.model.api.id), providerID: input.model.providerID },
    input.agent,
  )) {
    // 工具初始化...
  }
}
```

**查看变量：**
- `input.agent` - Agent 信息
- `input.session` - 会话信息
- `tools` - 最终解析的工具集合

---

### 阶段三：LLM 调用

#### 6. 流式调用入口
```typescript
// packages/opencode/src/session/llm.ts:68
export async function stream(input: StreamInput) {
  const l = log
    .clone()
    .tag("providerID", input.model.providerID)
    .tag("modelID", input.model.id)
    .tag("sessionID", input.sessionID)
    .tag("agent", input.agent.name)
  l.info("stream", {
    modelID: input.model.id,
    providerID: input.model.providerID,
  })  // ← 断点 6: 查看完整的 LLM 输入

  const [language, cfg, provider, auth] = await Promise.all([
    Provider.getLanguage(input.model),
    Config.get(),
    Provider.getProvider(input.model.providerID),
    Auth.get(input.model.providerID),
  ])
  // ...
}
```

**查看变量：**
- `input.system` - System Prompt 数组
- `input.messages` - 历史消息
- `input.tools` - 可用工具定义
- `input.agent` - Agent 配置

#### 7. 消息转换
```typescript
// packages/opencode/src/session/message-v2.ts:576
export async function toModelMessages(
  input: WithParts[],
  model: Provider.Model,
  options?: { stripMedia?: boolean },
): Promise<ModelMessage[]> {
  const result: UIMessage[] = []
  // ← 断点 7: 查看原始消息结构

  for (const msg of input) {
    // 转换逻辑...
  }

  return await convertToModelMessages(result, { tools })  // ← 查看转换结果
}
```

**查看变量：**
- `input` - 内部消息格式 (WithParts)
- `result` - 转换后的 UI Message 格式

---

### 阶段四：流事件处理

#### 8. 事件处理核心
```typescript
// packages/opencode/src/session/processor.ts:115
const handleEvent = Effect.fn("SessionProcessor.handleEvent")(function* (value: StreamEvent) {
  switch (value.type) {  // ← 断点 8: 查看所有流事件
    case "start":
      // ...
    case "text-delta":
      // ← 最常见的文本增量事件
      if (!ctx.currentText) return
      ctx.currentText.text += value.text
      yield* session.updatePartDelta({
        sessionID: ctx.currentText.sessionID,
        messageID: ctx.currentText.messageID,
        partID: ctx.currentText.id,
        field: "text",
        delta: value.text,
      })
      return
    case "tool-call":
      // ← 工具调用事件
      // ...
    case "tool-result":
      // ← 工具结果事件
      // ...
  }
})
```

**查看变量：**
- `value` - 流事件对象 (type, text, toolCallId 等)
- `ctx` - Processor 上下文

#### 9. 工具调用执行
```typescript
// packages/opencode/src/session/prompt.ts:819
 for (const item of await ToolRegistry.tools(/* ... */)) {
  tools[item.id] = tool({
    id: item.id as any,
    description: item.description,
    inputSchema: jsonSchema(schema as any),
    async execute(args, options) {
      const ctx = context(args, options)  // ← 断点 9: 查看工具执行上下文
      await Plugin.trigger("tool.execute.before", /* ... */)
      const result = await item.execute(args, ctx)  // ← 实际执行工具
      await Plugin.trigger("tool.execute.after", /* ... */)
      return result
    },
  })
}
```

**查看变量：**
- `item.id` - 工具 ID (如 "write")
- `args` - 工具参数 (如 { filePath, content })
- `ctx` - Tool Context (sessionID, messageID, ask 函数等)

---

### 阶段五：具体工具执行

#### 10. WriteTool 执行
```typescript
// packages/opencode/src/tool/write.ts (或 edit.ts)
export const WriteTool = Tool.define("write", {
  // ...
  async execute(params, ctx) {
    // ← 断点 10: 查看写入参数
    const filepath = path.isAbsolute(params.filePath) 
      ? params.filePath 
      : path.join(Instance.directory, params.filePath)
    
    await ctx.ask({  // ← 权限检查点
      permission: "edit",
      patterns: [filepath],
      // ...
    })
    
    await Filesystem.write(filepath, params.content)  // ← 实际写入文件
    // ...
  },
})
```

**查看变量：**
- `params.filePath` - 目标文件路径
- `params.content` - 文件内容
- `ctx.sessionID` - 当前会话 ID

#### 11. 权限检查
```typescript
// packages/opencode/src/permission/index.ts:166
const ask = Effect.fn("Permission.ask")(function* (input: z.infer<typeof AskInput>) {
  const { approved, pending } = yield* InstanceState.get(state)
  const { ruleset, ...request } = input
  let needsAsk = false

  for (const pattern of request.patterns) {
    const rule = evaluate(request.permission, pattern, ruleset, approved)  // ← 断点 11: 查看规则评估
    if (rule.action === "deny") {
        return yield* new DeniedError({ ruleset: [] })
    }
    if (rule.action === "allow") continue
    needsAsk = true
  }
  // ...
})
```

**查看变量：**
- `request.permission` - 权限名称 (如 "edit")
- `request.patterns` - 匹配模式 (如文件路径)
- `ruleset` - 合并后的权限规则
- `rule.action` - 评估结果 (allow/deny/ask)

---

## 数据流跟踪

### 跟踪任务：生成冒泡排序

以下是在关键位置添加的 `console.log` 调试输出：

```typescript
// 在 packages/opencode/src/session/prompt.ts:278 添加
console.log("[DEBUG] loop started", { sessionID, step: 0 })

// 在 packages/opencode/src/session/prompt.ts:596 添加
console.log("[DEBUG] Agent selected", { 
  agent: agent.name, 
  mode: agent.mode,
  permissions: agent.permission 
})

// 在 packages/opencode/src/session/prompt.ts:681 添加
console.log("[DEBUG] System prompt assembled", { 
  systemLength: system.length,
  skills: skills ? "included" : "none"
})

// 在 packages/opencode/src/session/processor.ts:115 添加
console.log("[DEBUG] Stream event", { type: value.type, ...value })
```

### 预期输出流程

```
[DEBUG] loop started { sessionID: 'sess_01...', step: 0 }
[DEBUG] Agent selected { agent: 'build', mode: 'primary', permissions: [...] }
[DEBUG] System prompt assembled { systemLength: 3, skills: 'included' }
[DEBUG] Stream event { type: 'start' }
[DEBUG] Stream event { type: 'text-start' }
[DEBUG] Stream event { type: 'text-delta', text: '我来' }
[DEBUG] Stream event { type: 'text-delta', text: '帮你' }
[DEBUG] Stream event { type: 'text-delta', text: '写一个' }
...
[DEBUG] Stream event { type: 'tool-call', toolCallId: 'call_01', toolName: 'write' }
[DEBUG] Stream event { type: 'tool-result', toolCallId: 'call_01', ... }
[DEBUG] Stream event { type: 'finish-step' }
```

---

## 调试技巧

### 1. 使用 Log 模块

```typescript
import { Log } from "@/util/log"

const log = Log.create({ service: "my-debug" })

// 不同级别
log.trace("详细跟踪", { data: "..." })
log.debug("调试信息", { variable: value })
log.info("一般信息")
log.warn("警告")
log.error("错误", { error })

// 带标签
log.tag("sessionID", sessionID).tag("step", step).debug("上下文")
```

### 2. 使用 Effect 的调试功能

```typescript
import { Effect } from "effect"

const program = Effect.gen(function* () {
  const result = yield* someEffect
  yield* Effect.logDebug("Current result").pipe(Effect.annotateLogs({ result }))
  return result
})
```

### 3. 检查数据库状态

```bash
# 会话数据存储在 SQLite
cd ~/.local/share/opencode  # 或对应平台的数据目录
sqlite3 opencode.db

# 常用查询
.tables
SELECT * FROM sessions ORDER BY time_created DESC LIMIT 5;
SELECT * FROM messages WHERE session_id = 'your_session_id';
SELECT * FROM parts WHERE session_id = 'your_session_id';
```

### 4. 使用 REPL 快速测试

```bash
cd packages/opencode
bun repl

# 在 REPL 中
> const { Session } = await import("./src/session")
> const session = await Session.create({})
> console.log(session)
```

### 5. 性能分析

```typescript
// 使用 console.time
console.time("tool-execution")
const result = await tool.execute(args, ctx)
console.timeEnd("tool-execution")

// 使用 Log 的时间追踪
using _ = log.time("resolveTools")
const tools = await resolveTools(input)
```

### 6. 条件断点

在 VS Code 中设置条件断点：

```typescript
// 只在处理 write 工具时中断
// 条件: item.id === "write"
for (const item of await ToolRegistry.tools(/* ... */)) {
  // 断点条件: item.id === "write"
}

// 只在特定会话时中断
// 条件: sessionID === "your_specific_id"
```

### 7. 网络请求调试

```bash
# 查看 LLM API 请求和响应
OPENCODE_LOG_LEVEL=trace bun run --conditions=browser ./src/index.ts run -- "生成python冒泡排序代码，并验证结果正确性"

# 或使用代理
HTTPS_PROXY=http://localhost:8080 bun run --conditions=browser ./src/index.ts run -- "生成python冒泡排序代码，并验证结果正确性"
```

---

## 常见问题排查

### Q: 工具没有被调用
- 检查 `ToolRegistry.tools()` 是否正确初始化
- 检查权限规则是否 deny 了该工具
- 检查 LLM 的 `toolChoice` 参数

### Q: 权限确认对话框不弹出
- 检查 `Permission.evaluate()` 是否返回 "ask"
- 检查 `Bus.publish(Permission.Event.Asked)` 是否被调用
- 检查 UI 是否正确监听该事件

### Q: 消息没有持久化
- 检查 `SyncEvent.run()` 是否被调用
- 检查 SQLite 数据库是否可写
- 检查 `MessageV2.Event.Updated` 事件

### Q: Skill 没有加载
- 检查 `Skill.available()` 是否正确扫描目录
- 检查 Agent 的 permission 是否 deny 了该 skill
- 检查 SKILL.md 文件格式是否正确
