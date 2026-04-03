# 调试速查表 - 冒泡排序任务

快速参考：调试 "生成python冒泡排序代码，并验证结果正确性" 任务的关键位置和命令。

## 🚀 快速开始

```bash
# 1. 进入目录
cd packages/opencode

# 2. 使用调试模式运行
OPENCODE_LOG_LEVEL=debug bun run --conditions=browser ./src/index.ts run -- "生成python冒泡排序代码，并验证结果正确性"

# 或者使用 TUI 模式（可交互调试）
bun run --conditions=browser ./src/index.ts
```

---

## 📍 关键断点速查

| 阶段 | 文件 | 行号 | 函数/位置 | 查看什么 |
|------|------|------|-----------|----------|
| **输入** | `session/prompt.ts` | 162 | `prompt()` | `input` 参数 |
| **循环** | `session/prompt.ts` | 278 | `loop()` while | `sessionID`, `step` |
| **Agent** | `agent/agent.ts` | 319 | `Agent.get()` | Agent 配置 |
| **Skill** | `skill/index.ts` | 230 | `Skill.available()` | 可用 Skills |
| **工具** | `session/prompt.ts` | 772 | `resolveTools()` | 工具列表 |
| **LLM** | `session/llm.ts` | 68 | `stream()` | `input.system`, `input.messages` |
| **事件** | `session/processor.ts` | 115 | `handleEvent()` | `value.type` |
| **工具执行** | `session/prompt.ts` | 819 | `execute()` | `args`, `ctx` |
| **写文件** | `tool/write.ts` | ~30 | `execute()` | `params.filePath`, `params.content` |
| **权限** | `permission/index.ts` | 166 | `Permission.ask()` | `rule.action` |

---

## 🔍 快速添加日志

在任意位置插入：

```typescript
// 简单打印
console.log("[DEBUG] 位置描述", { variableName })

// 使用 Log 模块
import { Log } from "@/util/log"
const log = Log.create({ service: "debug" })
log.debug("描述", { data: value })

// 追踪时间
console.time("label")
// ... 代码
console.timeEnd("label")
```

---

## 📊 数据流检查清单

### 1. 消息是否创建？
```typescript
// session/prompt.ts:162
console.log("[MSG] 创建消息", { 
  sessionID: input.sessionID, 
  parts: input.parts 
})
```

### 2. Agent 是否正确？
```typescript
// session/prompt.ts:596 (loop 内部)
console.log("[AGENT] 使用 Agent", { 
  name: agent.name, 
  mode: agent.mode,
  hasPrompt: !!agent.prompt 
})
```

### 3. System Prompt 内容？
```typescript
// session/prompt.ts:681
console.log("[SYSTEM] Prompt 内容:")
system.forEach((s, i) => console.log(`  [${i}] ${s.substring(0, 100)}...`))
```

### 4. 工具是否注册？
```typescript
// session/prompt.ts:772
console.log("[TOOLS] 可用工具:", Object.keys(tools))
```

### 5. LLM 返回什么事件？
```typescript
// session/processor.ts:115
console.log("[EVENT]", value.type, value)
```

### 6. 工具参数是什么？
```typescript
// session/prompt.ts:841 (在 execute 内部)
console.log("[TOOL EXEC]", { tool: item.id, args })
```

### 7. 权限评估结果？
```typescript
// permission/index.ts:172
console.log("[PERMISSION]", { 
  permission: request.permission, 
  pattern: request.patterns[0],
  action: rule.action 
})
```

---

## 🛠️ 常用调试命令

### 查看数据库
```bash
# 找到数据库位置
ls ~/.local/share/opencode/*.db

# 查看最近会话
sqlite3 ~/.local/share/opencode/opencode.db "SELECT id, title, time_created FROM sessions ORDER BY time_created DESC LIMIT 3;"

# 查看特定会话的消息
sqlite3 ~/.local/share/opencode/opencode.db "SELECT id, role, data FROM messages WHERE session_id = 'YOUR_ID';"
```

### 实时监控日志
```bash
# 只显示特定服务的日志
OPENCODE_LOG_LEVEL=debug bun run --conditions=browser ./src/index.ts run -- "生成python冒泡排序代码，并验证结果正确性" 2>&1 | grep "session.processor"

# 保存日志到文件
OPENCODE_LOG_LEVEL=trace bun run --conditions=browser ./src/index.ts run -- "生成python冒泡排序代码，并验证结果正确性" 2>&1 > debug.log
```

### 检查文件系统
```bash
# 查看工作目录
cat ~/.config/opencode/config.json | jq '.directory'

# 查看生成的文件
ls -la /path/to/workdir/
```

---

## 🐛 常见问题速查

### 问题：模型不调用 write 工具
**检查点：**
1. `resolveTools()` 是否包含 `write`？
2. `input.tools` 是否传入了 `{ write: false }`？
3. Agent 的 permission 是否 deny 了 `edit`？

### 问题：权限对话框不弹出
**检查点：**
1. `Permission.evaluate()` 返回什么 action？
2. `Bus.publish(Permission.Event.Asked)` 是否执行？
3. UI 层是否正确订阅事件？

### 问题：文件没有写入
**检查点：**
1. `WriteTool.execute()` 是否被调用？
2. `Filesystem.write()` 是否成功？
3. 路径是否正确（绝对 vs 相对）？

### 问题：Skill 没有生效
**检查点：**
1. `Skill.available()` 是否返回该 Skill？
2. `SystemPrompt.skills()` 是否被调用？
3. Skill 内容是否在 system prompt 中？

---

## 📝 调试脚本模板

创建 `debug-script.ts`：

```typescript
// packages/opencode/debug-script.ts
import { Session } from "./src/session"
import { Agent } from "./src/agent/agent"
import { Skill } from "./src/skill"
import { ToolRegistry } from "./src/tool/registry"
import { Provider } from "./src/provider/provider"

async function main() {
  // 1. 创建会话
  const session = await Session.create({})
  console.log("[1] 创建会话:", session.id)

  // 2. 获取默认 Agent
  const agentName = await Agent.defaultAgent()
  const agent = await Agent.get(agentName)
  console.log("[2] Agent:", agent.name, "mode:", agent.mode)

  // 3. 列出可用 Skills
  const skills = await Skill.available(agent)
  console.log("[3] Skills:", skills.map(s => s.name))

  // 4. 列出可用 Tools
  const model = await Provider.defaultModel()
  const tools = await ToolRegistry.tools(
    { providerID: model.providerID, modelID: model.id },
    agent
  )
  console.log("[4] Tools:", tools.map(t => t.id))

  console.log("\n调试信息收集完成!")
}

main().catch(console.error)
```

运行：
```bash
bun run debug-script.ts
```

---

## 🎯 最小复现示例

创建一个最小的测试来验证工具链：

```typescript
// test-bubble-sort.ts
import { Effect } from "effect"
import { SessionPrompt } from "./src/session/prompt"
import { Session } from "./src/session"
import { Agent } from "./src/agent/agent"

async function test() {
  // 创建会话
  const session = await Session.create({})
  console.log("会话创建:", session.id)

  // 发送提示
  try {
    const result = await SessionPrompt.prompt({
      sessionID: session.id,
      parts: [{ type: "text", text: "写一个Python冒泡排序" }],
    })
    console.log("结果:", result)
  } catch (e) {
    console.error("错误:", e)
  }
}

test()
```
