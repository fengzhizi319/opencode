# 任务执行数据流示例：写冒泡排序算法

本文以"写一个冒泡排序算法"为例，详细展示 OpenCode 从接收用户输入到生成最终代码的完整数据流。

## 场景设定

**用户输入**: `"帮我写一个 Python 的冒泡排序算法"`

**当前环境**: 
- 工作目录: `/home/user/myproject`
- 已配置 Agent: `build` (默认)
- 可用 Skill: `python-best-practices`, `algorithm-templates`

---

## 阶段一：会话初始化与消息创建

### 1.1 用户消息创建
```
用户输入 → SessionPrompt.prompt()
    ↓
创建 User Message:
  - id: "msg_01..."
  - role: "user"
  - parts: [
      { type: "text", text: "帮我写一个 Python 的冒泡排序算法" }
    ]
  - agent: "build"
  - model: { providerID: "openai", modelID: "gpt-4" }
```

### 1.2 启动会话循环
```
SessionPrompt.loop() 启动
    ↓
state[sessionID] = {
  abort: AbortController,
  callbacks: []
}
```

---

## 阶段二：Agent 选择与工具解析

### 2.1 Agent 解析
```
从最后一条 User Message 读取 agent 字段 → "build"
    ↓
Agent.get("build") → 返回 Agent.Info:
  {
    name: "build",
    mode: "primary",
    permission: [...],  // 包含 edit/bash/read 等权限
    model: undefined,   // 使用用户指定的模型
    prompt: undefined   // 无额外 prompt
  }
```

### 2.2 工具注册表初始化
```
ToolRegistry.tools(model, agent) 被调用
    ↓
收集所有可用工具:
  内置: [bash, read, edit, write, skill, task, ...]
  自定义: []  // 本次无
  插件: []    // 本次无
    ↓
过滤工具 (基于模型类型):
  - apply_patch? 否 (非 GPT 模型)
  - edit/write? 是
    ↓
并行初始化每个工具的 init()
    ↓
返回 tools 数组
```

### 2.3 系统 Prompt 组装
```
SystemPrompt.environment(model) → 基础环境信息
    +
SystemPrompt.skills(agent) → 查询可用 skills
    ↓
Skill.available(build) → 过滤出 Agent 有权限使用的 skills:
  - "python-best-practices"
  - "algorithm-templates"
    ↓
组装 system[] 数组:
  [
    "You are an expert software engineer...",
    "## Available Skills\n- python-best-practices...\n- algorithm-templates...",
    "Current time: 2026-03-30...",
    "Current directory: /home/user/myproject"
  ]
```

---

## 阶段三：首次 LLM 调用

### 3.1 消息转换
```
MessageV2.toModelMessages(msgs, model)
    ↓
转换后的 messages:
  [
    { role: "system", content: "You are an expert..." },
    { role: "user", parts: [{type: "text", text: "帮我写一个 Python..."}] }
  ]
    ↓
转换为 AI SDK ModelMessage[] 格式
```

### 3.2 流式调用
```
LLM.stream({
  user,
  agent,
  system,
  messages,
  tools: { bash, read, edit, write, skill, ... },
  model,
  ...
})
    ↓
streamText({...}) 调用 AI SDK
    ↓
返回 Event Stream
```

### 3.3 流事件处理（Processor）

#### 事件序列示例：

```
1. start-step
   → snapshot.track() 记录代码快照
   → 创建 StepStartPart

2. text-start
   → 创建 TextPart (id: part_01)

3. text-delta: "我来帮你"
   → TextPart.text += "我来帮你"
   → 发布 PartDelta 事件 (UI 实时更新)

4. text-delta: "写一个冒泡排序..."
   → TextPart.text += "写一个冒泡排序..."

5. text-end
   → TextPart.time.end = Date.now()
   → 持久化 TextPart

6. tool-input-start (callID: "call_01", toolName: "write")
   → 创建 ToolPart:
      {
        type: "tool",
        tool: "write",
        callID: "call_01",
        state: { status: "pending", input: {}, raw: "" }
      }

7. tool-call (callID: "call_01")
   → ToolPart.state = {
       status: "running",
       input: {
         filePath: "/home/user/myproject/bubble_sort.py",
         content: "def bubble_sort(arr):..."
       },
       time: { start: Date.now() }
     }
   → 执行 WriteTool.execute()

8. tool-result (callID: "call_01")
   → ToolPart.state = {
       status: "completed",
       output: "File written successfully...",
       title: "Created bubble_sort.py",
       time: { start: ..., end: Date.now() }
     }

9. finish-step
   → 计算 token 使用量和费用
   → 创建 StepFinishPart
   → SessionSummary.summarize() 异步计算 diff
```

---

## 阶段四：工具执行详情

### 4.1 WriteTool 执行流程
```
WriteTool.execute({
  filePath: "/home/user/myproject/bubble_sort.py",
  content: "def bubble_sort(arr):\n    n = len(arr)..."
}, ctx)
    ↓
1. 参数校验 (Zod schema)
    ↓
2. Permission.ask({
     permission: "edit",
     patterns: ["bubble_sort.py"],
     ...
   })
   → 评估权限规则
   → 规则未明确 allow → 需要用户确认
   → UI 弹出确认对话框
    ↓
用户点击 "Allow"
    ↓
3. 写入文件
   Filesystem.write("/home/user/myproject/bubble_sort.py", content)
    ↓
4. 格式化文件 (如果配置了 formatter)
   Format.file(filepath)
    ↓
5. 发布事件
   Bus.publish(File.Event.Edited, { file })
   Bus.publish(FileWatcher.Event.Updated, { file, event: "add" })
    ↓
6. 返回结果
   {
     title: "Created bubble_sort.py",
     output: "File created successfully...",
     metadata: { filepath, size: 256 }
   }
```

---

## 阶段五：会话循环继续

### 5.1 检查循环条件
```
loop() 迭代结束，检查:
  - lastAssistant.finish === "tool-calls" → 需要继续
  - 无错误发生
  - 未超过 maxSteps
    ↓
继续下一轮循环
```

### 5.2 第二次 LLM 调用
```
messages 现在包含:
  [
    { role: "system", content: "..." },
    { role: "user", content: "帮我写一个 Python..." },
    { role: "assistant", content: "我来帮你写一个冒泡排序算法。" },
    { role: "assistant", content: null, tool_calls: [...] },
    { role: "tool", content: "File created successfully..." }
  ]
    ↓
LLM.stream({...}) 再次调用
    ↓
模型看到工具已执行成功，决定结束对话
    ↓
返回 "stop" finish reason
```

### 5.3 循环结束
```
lastAssistant.finish === "stop"
    ↓
非 "tool-calls" 或 "unknown"
    ↓
break 循环
```

---

## 阶段六：清理与持久化

### 6.1 压缩检查
```
SessionCompaction.prune({ sessionID })
    ↓
扫描消息历史
    ↓
总 token < PRUNE_PROTECT → 无需剪枝
```

### 6.2 会话摘要
```
SessionSummary.summarize({ sessionID, messageID })
    ↓
computeDiff({ messages })
    ↓
比较 step-start 和 step-finish 的快照
    ↓
发现新增文件: bubble_sort.py
    ↓
Session.setSummary({
  additions: 15,
  deletions: 0,
  files: 1
})
```

### 6.3 返回结果
```
返回最后一条 Assistant Message 给调用方
    ↓
UI 展示完成状态
```

---

## 整体数据流图

见 [workflow-diagram.md](./workflow-diagram.md) 的 Mermaid 流程图。

---

## 关键设计要点

1. **异步事件驱动**: 所有状态变更通过 `SyncEvent` 或 `BusEvent` 发布，UI 和其他监听器可以实时响应

2. **权限分层**: 
   - Agent 默认权限 → 用户配置权限 → 会话级权限
   - 每层都可以 deny/ask/allow

3. **工具隔离**: 每个工具执行在独立的 `Tool.Context` 中，包含自己的 abort 信号和 metadata 回调

4. **记忆管理**: 
   - 短期：完整的消息历史用于 LLM 上下文
   - 中期：Compaction 压缩旧对话
   - 长期：Session 摘要统计文件变更

5. **流式处理**: LLM 响应是流式的，Processor 实时处理事件并更新 UI
