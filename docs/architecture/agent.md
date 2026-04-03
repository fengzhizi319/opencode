# Agent 模块

Agent 模块定义了 OpenCode 中的智能体（Agent）概念，包括内置 Agent、用户自定义 Agent 的加载，以及 Agent 生成器。

## 核心文件

- `packages/opencode/src/agent/agent.ts`

## Agent 定义

一个 Agent 包含以下核心属性：

```ts
export type Info = {
  name: string
  description?: string
  mode: "subagent" | "primary" | "all"
  native?: boolean
  hidden?: boolean
  topP?: number
  temperature?: number
  color?: string
  permission: Permission.Ruleset
  model?: { modelID: ModelID; providerID: ProviderID }
  variant?: string
  prompt?: string
  options: Record<string, any>
  steps?: number
}
```

### 关键字段说明

| 字段 | 说明 |
|------|------|
| `name` | Agent 唯一标识 |
| `mode` | `primary` 表示可直接与用户交互的主 Agent；`subagent` 表示只能通过 `task` 工具调用的子 Agent；`all` 表示两者皆可 |
| `permission` | 该 Agent 拥有的工具权限规则集 |
| `model` | 可选的专属模型配置，未指定则继承用户消息中的模型 |
| `prompt` | 注入到 system prompt 中的额外提示词 |
| `steps` | 该 Agent 在一次用户输入中最多可执行的步数 |
| `hidden` | 是否在 UI 的 Agent 选择列表中隐藏 |

## 内置 Agent

系统预定义了以下内置 Agent：

### `build`（默认主 Agent）
- **模式**: `primary`
- **职责**: 执行常规开发任务，拥有大部分工具的默认权限
- **特点**: 允许 `question`、`plan_enter` 等交互型工具

### `plan`
- **模式**: `primary`
- **职责**: 计划模式，禁止所有编辑类工具（`edit` 等被 deny）
- **特点**: 只允许在 `.opencode/plans/` 或全局 plans 目录下写入计划文件

### `general`
- **模式**: `subagent`
- **职责**: 通用子 Agent，适合复杂多步任务
- **特点**: 禁止 `todowrite` 工具，避免子任务污染父会话的 todo 列表

### `explore`
- **模式**: `subagent`
- **职责**: 快速探索代码库
- **特点**: 仅允许 `grep`、`glob`、`list`、`bash`、`read`、`webfetch`、`websearch`、`codesearch` 等只读/探索型工具

### `compaction`
- **模式**: `primary`
- **职责**: 上下文压缩
- **特点**: `hidden`，禁止所有工具，仅用于生成对话摘要

### `title`
- **模式**: `primary`
- **职责**: 自动生成会话标题
- **特点**: `hidden`，低 temperature

### `summary`
- **模式**: `primary`
- **职责**: 生成会话总结
- **特点**: `hidden`

## 自定义 Agent

用户可以在配置文件中定义自定义 Agent：

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
      }
    }
  }
}
```

配置中的 Agent 会合并到内置 Agent 列表中。如果指定 `disable: true`，则可以禁用内置 Agent。

## Agent 调度

Agent 调度发生在 `SessionPrompt.loop()` 中：

1. 从最后一条用户消息中读取 `agent` 字段
2. 调用 `Agent.get(agentName)` 获取 Agent 配置
3. 如果是子任务（`subtask` part），则使用 `SubtaskPart` 中指定的 Agent
4. 通过 `resolveTools()` 结合 Agent 的 `permission` 和会话的 `permission` 过滤可用工具

## Agent 生成器

`Agent.generate()` 允许通过自然语言描述自动生成 Agent 配置：
- 使用默认模型或指定模型
- 向模型发送生成提示词
- 返回 `{ identifier, whenToUse, systemPrompt }`
- 用户可将返回结果保存到配置文件中
