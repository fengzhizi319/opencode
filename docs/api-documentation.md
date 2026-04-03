# API 文档 (API Documentation)

## 目录

1. [概述](#1-概述)
2. [核心 API](#2-核心-api)
3. [工具 API](#3-工具-api)
4. [Agent API](#4-agent-api)
5. [会话 API](#5-会话-api)
6. [SDK 使用](#6-sdk-使用)
7. [配置 API](#7-配置-api)
8. [类型定义](#8-类型定义)

## 1. 概述

OpenCode 提供了多层次的 API 接口：

- **内部 API**: TypeScript 模块接口（`packages/opencode/src`）
- **SDK API**: `@opencode/sdk` 提供的公共接口
- **Server API**: HTTP/WebSocket API（`opencode serve` 模式）
- **CLI API**: 命令行接口

本文档主要介绍内部 API 和 SDK API。

## 2. 核心 API

### 2.1 Effect-TS 模式

OpenCode 核心使用 Effect-TS 进行错误处理和异步编排：

```ts
import { Effect } from "effect"

// Effect<SuccessType, ErrorType, Requirements>
const program: Effect.Effect<string, Error, never> = Effect.succeed("Hello")
```

### 2.2 服务依赖

通过 `Context` 获取服务：

```ts
import { Effect } from "effect"

const program = Effect.gen(function* () {
  const session = yield* Session.Session
  const agent = yield* Agent.Agent
  // ...
})
```

### 2.3 主要服务

| 服务 | 路径 | 描述 |
|------|------|------|
| Session | `session/index.ts` | 会话管理 |
| Agent | `agent/index.ts` | Agent 管理 |
| Tool | `tool/index.ts` | 工具管理 |
| Permission | `permission/index.ts` | 权限管理 |
| Config | `config/index.ts` | 配置管理 |
| Project | `project/index.ts` | 项目管理 |
| Bus | `bus/index.ts` | 事件总线 |

## 3. 工具 API

### 3.1 工具定义

```ts
import { Tool } from "@opencode/sdk"
import { z } from "zod"

const myTool = Tool.define("my_tool", async (ctx) => {
  return {
    description: "工具描述",
    parameters: z.object({
      input: z.string().describe("输入参数"),
      options: z.object({
        flag: z.boolean().optional()
      }).optional()
    }),
    
    async execute(args, toolCtx) {
      // 执行逻辑
      return {
        title: "执行结果标题",
        metadata: { key: "value" },
        output: "执行输出内容",
        attachments: []  // 可选附件
      }
    }
  }
})
```

### 3.2 工具执行上下文

```ts
interface ToolContext {
  // 会话和消息标识
  sessionID: string
  messageID: string
  
  // 当前 Agent
  agent: string
  
  // 取消信号
  abort: AbortSignal
  
  // 当前会话的消息历史
  messages: MessageV2.WithParts[]
  
  // 更新元数据（UI 实时展示）
  metadata(input: { title?: string; metadata?: any }): void
  
  // 请求权限确认
  ask(input: PermissionRequest): Promise<void>
}
```

### 3.3 内置工具列表

#### 文件操作工具

##### read - 读取文件

```ts
{
  id: "read",
  parameters: {
    file_path: string           // 文件路径
    offset?: number            // 起始行（可选）
    limit?: number             // 读取行数（可选）
  }
}
```

##### edit - 编辑文件

```ts
{
  id: "edit",
  parameters: {
    file_path: string           // 文件路径
    old_string: string          // 原字符串（用于匹配）
    new_string: string          // 新字符串（替换内容）
  }
}
```

支持多种匹配策略：
- **Simple**: 精确匹配
- **LineTrimmed**: 忽略行首尾空白
- **BlockAnchor**: 块锚点匹配
- **WhitespaceNormalized**: 标准化空白字符后匹配

##### write - 写入文件

```ts
{
  id: "write",
  parameters: {
    file_path: string           // 文件路径
    content: string             // 文件内容
  }
}
```

##### apply_patch - 应用补丁

```ts
{
  id: "apply_patch",
  parameters: {
    patch: string               // Unified diff 格式的补丁
  }
}
```

##### multiedit - 批量编辑

```ts
{
  id: "multiedit",
  parameters: {
    edits: Array<{
      file_path: string
      old_string: string
      new_string: string
    }>
  }
}
```

#### 搜索工具

##### glob - 文件搜索

```ts
{
  id: "glob",
  parameters: {
    pattern: string             // glob 模式，如 "**/*.ts"
    directory?: string          // 搜索目录（可选）
  }
}
```

##### grep - 内容搜索

```ts
{
  id: "grep",
  parameters: {
    pattern: string             // 正则或字符串
    path?: string               // 搜索路径（可选）
    output_mode?: "content" | "files_with_matches" | "count_matches"
    -n?: boolean                // 显示行号
    -C?: number                 // 上下文行数
    head_limit?: number         // 结果限制
  }
}
```

##### codesearch - 语义搜索

```ts
{
  id: "codesearch",
  parameters: {
    query: string               // 语义查询
    limit?: number              // 结果数量限制
  }
}
```

#### 执行工具

##### bash - 执行命令

```ts
{
  id: "bash",
  parameters: {
    command: string             // 命令
    description?: string        // 命令描述
    timeout?: number            // 超时时间（秒，默认 120）
  }
}
```

安全特性：
- 使用 Tree-sitter 解析命令
- 识别外部目录操作
- 默认 2 分钟超时

#### 网络工具

##### websearch - 网络搜索

```ts
{
  id: "websearch",
  parameters: {
    query: string               // 搜索查询
    limit?: number              // 结果数量
  }
}
```

##### webfetch - 网页抓取

```ts
{
  id: "webfetch",
  parameters: {
    url: string                 // 目标 URL
  }
}
```

#### 会话工具

##### todo - 待办事项

```ts
{
  id: "todo",
  parameters: {
    todos: Array<{
      id: string
      content: string
      status: "pending" | "in_progress" | "done"
      parent_id?: string
    }>
  }
}
```

##### task - 子任务

```ts
{
  id: "task",
  parameters: {
    description: string         // 任务描述
    agent?: string              // 指定 Agent（可选）
    task_id?: string            // 恢复已有子会话（可选）
  }
}
```

##### question - 询问用户

```ts
{
  id: "question",
  parameters: {
    text: string                // 问题内容
  }
}
```

#### 知识工具

##### skill - 加载技能

```ts
{
  id: "skill",
  parameters: {
    name: string                // Skill 名称
  }
}
```

#### 开发工具

##### lsp - LSP 操作

```ts
{
  id: "lsp",
  parameters: {
    operation: "diagnostics" | "hover" | "definition"
    file_path: string
    line?: number
    column?: number
  }
}
```

##### batch - 批量执行

```ts
{
  id: "batch",
  parameters: {
    commands: string[]          // 命令列表
  }
}
```

### 3.4 工具注册表

```ts
import { ToolRegistry } from "@opencode/sdk"

// 获取所有工具
const allTools = ToolRegistry.all()

// 获取特定工具
const tool = ToolRegistry.get("read")

// 根据 Agent 权限过滤工具
const allowedTools = ToolRegistry.tools(agent, modelType)
```

## 4. Agent API

### 4.1 Agent 定义

```ts
interface AgentInfo {
  // 唯一标识
  name: string
  
  // 描述
  description?: string
  
  // 模式：primary | subagent | all
  mode: "subagent" | "primary" | "all"
  
  // 是否原生内置
  native?: boolean
  
  // 是否在 UI 中隐藏
  hidden?: boolean
  
  // 采样参数
  topP?: number
  temperature?: number
  
  // 显示颜色
  color?: string
  
  // 权限规则集
  permission: Permission.Ruleset
  
  // 专属模型配置
  model?: {
    modelID: ModelID
    providerID: ProviderID
  }
  
  // 变体标识
  variant?: string
  
  // 额外的 system prompt
  prompt?: string
  
  // 其他选项
  options: Record<string, any>
  
  // 最大步数
  steps?: number
}
```

### 4.2 Agent 操作

```ts
import { Agent } from "@opencode/sdk"

// 获取 Agent
const agent = await Agent.get("build")

// 列出所有 Agent
const agents = await Agent.all()

// 生成 Agent
const generated = await Agent.generate("一个专门用于优化代码性能的 Agent")
// 返回：{ identifier, whenToUse, systemPrompt }
```

### 4.3 内置 Agent

| Agent | 模式 | 描述 |
|-------|------|------|
| build | primary | 默认开发 Agent |
| plan | primary | 计划模式（只读）|
| general | subagent | 通用子 Agent |
| explore | subagent | 代码库探索 |
| compaction | primary | 上下文压缩 |
| title | primary | 生成会话标题 |
| summary | primary | 生成会话总结 |

### 4.4 自定义 Agent 配置

```json
{
  "agent": {
    "my-agent": {
      "description": "Custom agent for specific tasks",
      "mode": "subagent",
      "model": "claude-sonnet-4",
      "permission": {
        "edit": "allow",
        "bash": "ask",
        "websearch": "deny"
      },
      "prompt": "额外的 system prompt...",
      "steps": 10
    }
  }
}
```

## 5. 会话 API

### 5.1 会话类型

```ts
interface SessionInfo {
  id: string                  // 会话 ID
  slug: string                // URL 友好的标识
  projectID: string           // 所属项目 ID
  workspaceID?: string        // 工作区 ID
  directory: string           // 工作目录
  parentID?: string           // 父会话 ID（分叉时）
  title: string               // 会话标题
  version: string             // 数据版本
  summary?: {
    additions: number         // 新增行数
    deletions: number         // 删除行数
    files: number             // 修改文件数
    diffs?: FileDiff[]        // 详细 diff
  }
  share?: { url: string }     // 分享链接
  time: {
    created: number           // 创建时间
    updated: number           // 更新时间
    compacting?: number       // 最后压缩时间
    archived?: number         // 归档时间
  }
  permission?: Permission.Ruleset  // 会话级权限
  revert?: {                  // 回滚信息
    messageID: string
    partID?: string
    snapshot?: string
    diff?: string
  }
}
```

### 5.2 会话操作

```ts
import { Session } from "@opencode/sdk"

// 创建会话
const session = await Session.create({
  projectID: "project-123",
  directory: "/path/to/project",
  title: "新会话"
})

// 获取会话
const session = await Session.get("session-id")

// 获取会话消息
const messages = await Session.messages("session-id")

// 发送消息
await Session.prompt("session-id", {
  text: "你好",
  agent: "build"
})

// 分叉会话
const forked = await Session.fork("session-id", "message-id")

// 归档会话
await Session.archive("session-id")
```

### 5.3 消息模型

```ts
// 用户消息
interface UserMessage {
  type: "user"
  id: string
  parts: UserPart[]
}

type UserPart = 
  | { type: "text"; content: string }
  | { type: "file"; path: string; mime?: string }
  | { type: "agent"; name: string }
  | { type: "subtask"; description: string }

// 助手消息
interface AssistantMessage {
  type: "assistant"
  id: string
  parts: AssistantPart[]
}

type AssistantPart =
  | { type: "text"; content: string }
  | { type: "reasoning"; content: string }
  | { 
      type: "tool"
      id: string
      tool: string
      params: any
      state: "pending" | "running" | "completed" | "error"
      output?: string
      error?: string
      title?: string
      metadata?: any
    }
  | { type: "step-start"; snapshot?: Snapshot }
  | { type: "step-finish"; tokens?: number; cost?: number }
  | { type: "patch"; files: string[] }
```

## 6. SDK 使用

### 6.1 安装 SDK

```bash
npm install @opencode/sdk
# 或
bun add @opencode/sdk
```

### 6.2 基础用法

```ts
import { OpenCode } from "@opencode/sdk"

const client = new OpenCode({
  baseURL: "http://localhost:4096"
})

// 创建会话
const session = await client.sessions.create({
  directory: "/path/to/project"
})

// 发送消息
await client.sessions.prompt(session.id, {
  text: "帮我分析这个项目"
})
```

### 6.3 流式响应

```ts
const stream = await client.sessions.promptStream(session.id, {
  text: "生成一个排序算法"
})

for await (const chunk of stream) {
  if (chunk.type === "text") {
    process.stdout.write(chunk.content)
  } else if (chunk.type === "tool") {
    console.log("Tool:", chunk.tool)
  }
}
```

### 6.4 自定义工具

```ts
import { defineTool } from "@opencode/sdk"

const customTool = defineTool({
  id: "my_tool",
  description: "我的自定义工具",
  parameters: z.object({
    input: z.string()
  }),
  async execute({ input }, context) {
    // 执行逻辑
    return {
      title: "执行成功",
      output: `处理结果: ${input}`
    }
  }
})

// 注册工具
client.tools.register(customTool)
```

## 7. 配置 API

### 7.1 配置类型

```ts
interface Config {
  // 默认模型
  model?: string
  
  // 提供商配置
  provider?: Record<string, ProviderConfig>
  
  // 自定义 Agent
  agent?: Record<string, AgentConfig>
  
  // Skill 配置
  skills?: SkillsConfig
  
  // 权限规则
  permission?: PermissionRule[]
  
  // MCP 配置
  mcp?: Record<string, MCPConfig>
}

interface ProviderConfig {
  npm?: string
  name?: string
  options?: Record<string, any>
  models: Record<string, ModelConfig>
}

interface AgentConfig {
  description?: string
  mode: "subagent" | "primary" | "all"
  model?: string
  permission?: PermissionRuleset
  prompt?: string
  steps?: number
  hidden?: boolean
}

interface SkillsConfig {
  paths?: string[]
  urls?: string[]
}

interface PermissionRule {
  permission: string
  pattern: string
  action: "allow" | "deny" | "ask"
}

interface MCPConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
}
```

### 7.2 配置加载

```ts
import { Config } from "@opencode/sdk"

// 加载配置
const config = await Config.load()

// 获取指定路径的值
const model = config.get("model")

// 设置值
config.set("model", "gpt-4o")

// 保存配置
await config.save()
```

### 7.3 配置文件路径

```ts
import { Config } from "@opencode/sdk"

// 获取全局配置路径
const globalPath = Config.globalPath()
// ~/.config/opencode/opencode.jsonc

// 获取项目配置路径
const projectPath = Config.projectPath("/path/to/project")
// /path/to/project/opencode.json
```

## 8. 类型定义

### 8.1 基础类型

```ts
// ID 类型
type SessionID = string
type MessageID = string
type PartID = string
type ProjectID = string
type WorkspaceID = string
type AgentID = string
type ToolID = string

// 时间戳
type Timestamp = number

// 文件路径
type FilePath = string
```

### 8.2 权限类型

```ts
// 权限动作
type PermissionAction = "allow" | "deny" | "ask"

// 权限规则
interface PermissionRule {
  permission: string
  pattern: string
  action: PermissionAction
}

// 权限规则集
type Ruleset = PermissionRule[]

// 权限请求
interface PermissionRequest {
  permission: string
  pattern: string
  metadata?: Record<string, any>
}
```

### 8.3 工具类型

```ts
// 工具信息
interface ToolInfo<P extends z.ZodType = z.ZodType, M = any> {
  id: string
  description: string
  parameters: P
  execute: (args: z.infer<P>, ctx: ToolContext) => Promise<ToolResult<M>>
}

// 工具执行上下文
interface ToolContext {
  sessionID: SessionID
  messageID: MessageID
  agent: string
  abort: AbortSignal
  callID?: string
  extra?: Record<string, any>
  messages: MessageV2.WithParts[]
  metadata(input: { title?: string; metadata?: any }): void
  ask(input: PermissionRequest): Promise<void>
}

// 工具执行结果
interface ToolResult<M = any> {
  title: string
  metadata: M
  output: string
  attachments?: FilePart[]
}
```

### 8.4 事件类型

```ts
// 事件总线
interface Bus {
  publish<T>(event: Event<T>, data: T): void
  subscribe<T>(event: Event<T>, handler: (data: T) => void): Subscription
}

// 主要事件
enum SessionEvent {
  Created = "session.created",
  Updated = "session.updated",
  MessageAdded = "session.message.added",
  MessageUpdated = "session.message.updated",
  Compacting = "session.compacting",
}

enum ToolEvent {
  ExecuteBefore = "tool.execute.before",
  ExecuteAfter = "tool.execute.after",
  Definition = "tool.definition",
}
```

## 9. HTTP API

当运行 `opencode serve` 时，以下 HTTP API 可用：

### 9.1 会话管理

```http
# 创建会话
POST /api/sessions
{
  "directory": "/path/to/project",
  "title": "可选标题"
}

# 获取会话列表
GET /api/sessions

# 获取会话详情
GET /api/sessions/:id

# 删除会话
DELETE /api/sessions/:id

# 发送消息（流式）
POST /api/sessions/:id/prompt
{
  "text": "消息内容",
  "agent": "可选 Agent"
}
```

### 9.2 WebSocket 事件

```javascript
const ws = new WebSocket('ws://localhost:4096/ws')

ws.onmessage = (event) => {
  const data = JSON.parse(event.data)
  // 处理事件
}
```

事件类型：
- `session.update`: 会话更新
- `message.delta`: 消息增量
- `tool.start`: 工具开始执行
- `tool.finish`: 工具执行完成
