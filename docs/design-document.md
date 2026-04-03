# 设计文档 (Design Document)

## 1. 项目概述

OpenCode 是一个开源的 AI 辅助编程系统（AI Coding Agent），旨在提供智能的代码编辑、项目管理和开发辅助功能。它采用客户端/服务器架构，支持多种交互方式（TUI、Web UI、桌面应用）。

### 1.1 核心特性

- **多提供商支持**：支持 OpenAI、Anthropic、Google 等多种 LLM 提供商
- **Agent 系统**：内置多种专业 Agent（build、plan、explore 等）
- **丰富工具集**：文件操作、代码搜索、命令执行、网络请求等
- **Skill 系统**：可扩展的领域知识注入机制
- **权限控制**：细粒度的工具权限管理
- **会话管理**：支持多会话、会话分叉、记忆压缩

### 1.2 架构设计原则

- **模块化设计**：各功能模块职责清晰，易于扩展
- **Provider-Agnostic**：不绑定特定 LLM 提供商
- **类型安全**：使用 TypeScript + Zod 确保运行时类型安全
- **函数式编程**：使用 Effect-TS 进行错误处理和异步编排

## 2. 系统架构

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              用户界面层                                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐ │
│  │   TUI/CLI    │  │   Web UI     │  │ Desktop App  │  │   API Server     │ │
│  │  (Terminal)  │  │   (Browser)  │  │(Electron/    │  │   (Headless)     │ │
│  │              │  │              │  │   Tauri)     │  │                  │ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘ │
│         │                 │                 │                   │           │
│         └─────────────────┴─────────────────┴───────────────────┘           │
│                                       │                                     │
│                              API / RPC 接口                                  │
└───────────────────────────────────────┼─────────────────────────────────────┘
                                        │
┌───────────────────────────────────────┼─────────────────────────────────────┐
│                              核心业务层                                       │
│                                       │                                     │
│  ┌────────────────────────────────────┼──────────────────────────────────┐  │
│  │                          Session 模块                                 │  │
│  │  ┌──────────┐  ┌──────────┐  ┌─────┴─────┐  ┌──────────┐  ┌────────┐ │  │
│  │  │  Prompt  │  │  Memory  │  │  Message  │  │   LLM    │  │ Summary│ │  │
│  │  │  (Loop)  │  │(Compact) │  │  (Parts)  │  │ (Stream) │  │        │ │  │
│  │  └──────────┘  └──────────┘  └───────────┘  └──────────┘  └────────┘ │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────────────────────┐ │
│  │   Agent 模块    │  │   Tool 模块     │  │      Permission 模块            │ │
│  │  (调度/配置)    │  │ (执行/注册)     │  │      (权限评估)                 │ │
│  └────────────────┘  └────────────────┘  └────────────────────────────────┘ │
│                                                                             │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────────────────────┐ │
│  │ Provider 模块   │  │   Skill 模块    │  │      Plugin 模块                │ │
│  │ (LLM 适配器)   │  │ (知识注入)      │  │      (扩展机制)                 │ │
│  └────────────────┘  └────────────────┘  └────────────────────────────────┘ │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                              基础设施层                                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐ │
│  │   Config     │  │   SQLite     │  │   Event Bus  │  │   File System    │ │
│  │   (配置)      │  │  (持久化)    │  │   (事件总线)  │  │   (文件操作)     │ │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 核心模块职责

| 模块 | 职责 | 核心文件 |
|------|------|----------|
| **Session** | 会话管理、消息持久化、LLM 交互循环 | `session/*.ts` |
| **Agent** | Agent 定义、调度、权限配置 | `agent/*.ts` |
| **Tool** | 工具定义、注册、执行 | `tool/*.ts` |
| **Permission** | 权限规则评估、用户确认 | `permission/*.ts` |
| **Provider** | LLM 提供商封装与适配 | `provider/*.ts` |
| **Skill** | Skill 发现、加载与注入 | `skill/*.ts` |
| **Plugin** | 插件系统 | `plugin/*.ts` |
| **Config** | 配置解析与迁移 | `config/*.ts` |
| **Project** | 项目实例、工作区管理 | `project/*.ts` |

### 2.3 关键技术选型

| 技术 | 用途 |
|------|------|
| **Bun** | 运行时、包管理、构建 |
| **TypeScript** | 类型安全 |
| **Effect-TS** | 依赖注入、错误处理、异步编排 |
| **AI SDK (Vercel)** | 统一的大模型调用接口 |
| **Zod** | 运行时类型校验与 JSON Schema 生成 |
| **Drizzle ORM** | SQLite 数据库操作 |
| **Tree-sitter** | Bash/PowerShell 命令解析 |
| **Solid.js** | TUI/Web UI 框架 |
| **Tauri / Electron** | 桌面应用框架 |

## 3. 模块详细设计

### 3.1 包结构

```
packages/
├── opencode/           # 核心系统（CLI、服务器、业务逻辑）
├── app/                # 共享 Web UI 组件
├── desktop/            # Tauri 桌面应用
├── desktop-electron/   # Electron 桌面应用
├── console/            # 控制台应用
├── sdk/                # SDK（JS/TS）
├── plugin/             # 插件包
├── containers/         # 容器化配置
└── web/                # Web 前端
```

### 3.2 数据流

```
用户输入 → SessionPrompt.prompt() → 创建 User Message
              ↓
        SessionPrompt.loop() ←←←←←←←←←←←←←←←←←←←←┐
              ↓                                     │
    1. 读取会话历史                                 │
    2. 检查待处理 subtask                           │
    3. 检查上下文压缩需求                            │
    4. 选择 Agent                                   │
    5. 解析可用 Tools                               │
    6. 组装 system prompt                           │
    7. 调用 LLM.stream()                            │
    8. SessionProcessor 处理流事件                   │
              ↓                                     │
    Tool 调用 → Tool.execute() → 返回结果 ────────────┘
              ↓
    结束条件检查 → 结束循环
```

### 3.3 Agent 系统

Agent 是 OpenCode 的核心概念，代表具有特定能力和权限的 AI 助手：

| Agent | 模式 | 用途 | 特点 |
|-------|------|------|------|
| **build** | primary | 默认开发 Agent | 完整权限，执行代码编辑 |
| **plan** | primary | 计划模式 | 只读，禁止编辑，适合分析 |
| **general** | subagent | 通用子 Agent | 用于复杂任务分解 |
| **explore** | subagent | 代码库探索 | 仅允许只读工具 |
| **compaction** | primary | 上下文压缩 | 生成对话摘要 |
| **title** | primary | 生成会话标题 | hidden |
| **summary** | primary | 生成会话总结 | hidden |

### 3.4 工具系统

内置工具分类：

| 类别 | 工具 |
|------|------|
| **文件操作** | read, edit, write, apply_patch, multiedit |
| **搜索** | glob, grep, codesearch |
| **执行** | bash |
| **网络** | webfetch, websearch |
| **会话** | todo, task, question |
| **知识** | skill |
| **开发** | lsp, batch |

### 3.5 权限系统

权限规则结构：

```ts
{
  permission: string    // 权限名称（如 "edit", "bash"）
  pattern: string       // 匹配模式（支持通配符 *、?）
  action: "allow" | "deny" | "ask"
}
```

权限评估优先级（后出现的规则优先）：
1. Agent 默认权限
2. Agent 专属权限
3. 用户配置权限
4. 会话级权限

### 3.6 会话与记忆

会话结构：

```ts
{
  id: SessionID
  slug: string
  projectID: ProjectID
  title: string
  summary?: { additions, deletions, files }
  time: { created, updated, compacting? }
  permission?: Permission.Ruleset
}
```

消息 Part 类型：

| Part 类型 | 说明 |
|-----------|------|
| text | 文本内容 |
| file | 附件（图片、PDF）|
| agent | Agent 指定 |
| subtask | 子任务指令 |
| reasoning | 模型推理过程 |
| tool | 工具调用及结果 |
| step-start/finish | 步骤标记 |

### 3.7 Skill 系统

Skill 是包含 `SKILL.md` 的目录，使用 YAML frontmatter 描述元数据：

```yaml
---
name: my-skill
description: 技能描述
---

详细说明、示例、工作流程...
```

Skill 来源优先级：
1. 外部全局目录（`~/.claude/skills/`）
2. 项目级目录（向上遍历 `.claude/skills/`）
3. 配置目录下的 `skill/` 或 `skills/`
4. 自定义路径（配置 `skills.paths`）
5. 远程 URL（配置 `skills.urls`）

### 3.8 配置系统

配置文件位置（按优先级）：
1. 项目级：`opencode.json`
2. 全局：`~/.config/opencode/opencode.jsonc`

配置内容：
- `provider`: LLM 提供商配置
- `agent`: 自定义 Agent 定义
- `skill`: Skill 路径配置
- `permission`: 权限规则
- `model`: 默认模型设置

## 4. 接口设计

### 4.1 核心类型定义

```ts
// Agent 定义
interface AgentInfo {
  name: string
  description?: string
  mode: "subagent" | "primary" | "all"
  permission: Permission.Ruleset
  model?: { modelID: ModelID; providerID: ProviderID }
  prompt?: string
  steps?: number
  hidden?: boolean
}

// Tool 定义
interface ToolInfo<Parameters extends z.ZodType> {
  id: string
  init: (ctx?: InitContext) => Promise<{
    description: string
    parameters: Parameters
    execute(args: z.infer<Parameters>, ctx: Context): Promise<{
      title: string
      metadata: M
      output: string
      attachments?: FilePart[]
    }>
  }>
}

// Tool 执行上下文
interface ToolContext {
  sessionID: SessionID
  messageID: MessageID
  agent: string
  abort: AbortSignal
  messages: MessageV2.WithParts[]
  metadata(input: { title?: string; metadata?: M }): void
  ask(input: PermissionRequest): Promise<void>
}
```

### 4.2 API 接口

#### 会话管理 API

```ts
// 创建会话
session.create(input: {
  projectID: ProjectID
  directory: string
  title?: string
  parentID?: SessionID
}): Effect.Effect<SessionInfo>

// 获取会话
session.get(id: SessionID): Effect.Effect<SessionInfo | undefined>

// 获取会话消息
session.messages(id: SessionID): Effect.Effect<MessageV2.WithParts[]>

// 发送消息
session.prompt(sessionID: SessionID, input: {
  text: string
  agent?: string
  files?: FileInput[]
}): Effect.Effect<void>

// 分叉会话
session.fork(sessionID: SessionID, messageID: MessageID): Effect.Effect<SessionInfo>
```

#### Agent API

```ts
// 获取 Agent
agent.get(name: string): Effect.Effect<AgentInfo | undefined>

// 列出所有 Agent
agent.all(): Effect.Effect<AgentInfo[]>

// 生成 Agent
agent.generate(description: string): Effect.Effect<GeneratedAgent>
```

#### Tool API

```ts
// 执行工具
tool.execute(id: string, args: unknown, ctx: ToolContext): Promise<ToolResult>

// 获取工具定义
tool.registry.get(id: string): ToolInfo | undefined

// 列出可用工具
tool.registry.all(): ToolInfo[]
```

## 5. 核心工作流

### 5.1 用户交互流程

```
1. 用户启动 OpenCode
   └─ 加载配置 → 初始化项目 → 启动服务器

2. 用户输入消息
   └─ 创建 User Message → 触发 loop()

3. Agent 处理
   └─ 选择 Agent → 解析权限 → 获取可用 Tools

4. LLM 调用
   └─ 组装 prompt → stream() → 处理流事件

5. 工具执行
   └─ 解析 tool-call → 权限检查 → execute() → 返回结果

6. 循环或结束
   └─ 继续 loop() 或 finish

7. 会话保存
   └─ 持久化消息 → 生成摘要
```

### 5.2 上下文压缩流程

```
1. 溢出检测
   └─ 检查 token 数是否超过限制

2. 剪枝 (Prune)
   └─ 从后向前扫描 → 标记旧 tool output 为 compacted

3. 压缩 (Compaction)
   └─ 调用 compaction Agent → 生成对话摘要
   └─ 保存为 summary message

4. 继续
   └─ 自动插入 "Continue..." 用户消息
```

### 5.3 权限确认流程

```
1. 权限评估
   └─ evaluate(permission, pattern, ...rulesets)
   └─ 返回 "allow" | "deny" | "ask"

2. 自动允许/拒绝
   └─ allow → 继续执行
   └─ deny → 抛出 DeniedError

3. 用户确认 (ask)
   └─ 创建 Permission.Request
   └─ 发送 UI 事件
   └─ 等待用户回复
   └─ once/always/reject

4. 执行或取消
   └─ 允许 → 继续执行
   └─ 拒绝 → 抛出 RejectedError
```

## 6. 扩展机制

### 6.1 自定义 Agent

在配置文件中定义：

```json
{
  "agent": {
    "my-agent": {
      "description": "Custom agent for specific tasks",
      "mode": "subagent",
      "model": "claude-sonnet-4",
      "permission": {
        "edit": "allow",
        "bash": "ask"
      },
      "prompt": "额外的 system prompt..."
    }
  }
}
```

### 6.2 自定义 Tool

在配置目录的 `tool/` 或 `tools/` 下创建 `.ts` 或 `.js` 文件：

```ts
// tools/my-tool.ts
import { Tool } from "@opencode/sdk"

export const myTool = Tool.define("my_tool", async () => ({
  description: "My custom tool",
  parameters: z.object({
    input: z.string()
  }),
  execute: async (args, ctx) => ({
    title: "My Tool",
    metadata: {},
    output: `Result: ${args.input}`
  })
}))
```

### 6.3 自定义 Skill

创建包含 `SKILL.md` 的目录：

```markdown
---
name: my-skill
description: 我的自定义技能
---

# 使用说明

这是技能的详细说明...

## 示例

```
示例代码...
```
```

### 6.4 MCP 集成

通过配置接入 MCP 服务器：

```json
{
  "mcp": {
    "my-mcp": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
    }
  }
}
```

## 7. 安全设计

### 7.1 密钥管理

- API 密钥存储在 `~/.local/share/opencode/auth.json`
- 支持加密存储
- 不将密钥硬编码在配置文件中

### 7.2 权限控制

- 细粒度的工具权限规则
- 对外部目录操作的特殊权限检查
- 对 `.env` 等敏感文件的默认保护
- Doom Loop 检测防止无限循环

### 7.3 命令安全

- 使用 Tree-sitter 解析 Bash/PowerShell 命令
- 识别文件系统操作路径
- 请求外部目录操作权限

## 8. 性能优化

### 8.1 上下文管理

- 智能上下文压缩
- Token 数预估与溢出检测
- Skill 输出受保护不被剪枝

### 8.2 流式处理

- LLM 响应流式处理
- UI 实时更新
- 增量渲染

### 8.3 缓存机制

- Skill 远程下载缓存
- 会话数据本地持久化
- 文件操作缓存

## 9. 部署模式

### 9.1 本地模式

- CLI/TUI 直接运行
- 本地 SQLite 数据库
- 本地文件系统操作

### 9.2 服务器模式

- Headless API Server (`opencode serve`)
- 支持远程客户端连接
- WebSocket 实时通信

### 9.3 桌面模式

- Electron / Tauri 应用
- 嵌入式服务器
- 原生系统集成
