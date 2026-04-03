# 开发指南 (Development Guide)

## 目录

1. [开发环境准备](#1-开发环境准备)
2. [项目结构](#2-项目结构)
3. [代码规范](#3-代码规范)
4. [开发工作流](#4-开发工作流)
5. [调试技巧](#5-调试技巧)
6. [添加新功能](#6-添加新功能)
7. [测试](#7-测试)
8. [贡献指南](#8-贡献指南)

## 1. 开发环境准备

### 1.1 系统要求

- **Bun**: 1.3.11+（必需）
- **Git**: 2.x+
- **Node.js**: 18+（部分工具依赖）
- **Rust**: 1.70+（桌面应用开发）

### 1.2 安装 Bun

```bash
# macOS/Linux
curl -fsSL https://bun.sh/install | bash

# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"

# 验证安装
bun --version
```

### 1.3 克隆仓库

```bash
git clone https://github.com/anomalyco/opencode.git
cd opencode
```

### 1.4 安装依赖

```bash
# 安装项目依赖
bun install

# 验证安装
bun run dev --help
```

### 1.5 开发工具推荐

| 工具 | 用途 | 配置 |
|------|------|------|
| **VSCode** | 代码编辑 | 使用 `.vscode/settings.example.json` |
| **Zed** | 代码编辑 | 配置见 `.zed/` 目录 |
| **IntelliJ IDEA** | 代码编辑 | 配置见 `.idea/` 目录 |

## 2. 项目结构

### 2.1 整体架构

```
opencode/
├── packages/                    # 核心包目录
│   ├── opencode/               # 核心系统（CLI、服务器、业务逻辑）
│   │   ├── src/
│   │   │   ├── agent/          # Agent 系统
│   │   │   ├── bus/            # 事件总线
│   │   │   ├── config/         # 配置管理
│   │   │   ├── permission/     # 权限系统
│   │   │   ├── plugin/         # 插件系统
│   │   │   ├── project/        # 项目管理
│   │   │   ├── provider/       # LLM 提供商
│   │   │   ├── session/        # 会话管理
│   │   │   ├── skill/          # Skill 系统
│   │   │   ├── tool/           # 工具系统
│   │   │   ├── cli/            # CLI 入口
│   │   │   └── server/         # HTTP 服务器
│   │   ├── script/             # 构建脚本
│   │   └── test/               # 测试文件
│   │
│   ├── app/                    # 共享 Web UI 组件（Solid.js）
│   ├── desktop/                # Tauri 桌面应用
│   ├── desktop-electron/       # Electron 桌面应用
│   ├── console/                # 控制台应用
│   ├── sdk/                    # SDK（JS/TS）
│   ├── plugin/                 # 插件包
│   ├── containers/             # 容器化配置
│   └── web/                    # Web 前端
│
├── docs/                       # 文档
├── script/                     # 根目录脚本
├── patches/                    # 依赖补丁
└── infra/                      # 基础设施配置
```

### 2.2 核心模块详解

#### Agent 模块 (`packages/opencode/src/agent/`)

```
agent/
├── index.ts           # 服务入口
├── agent.ts           # Agent 类型定义
├── generate.ts        # Agent 生成器
└── prompt/            # Agent 提示词模板
```

#### Tool 模块 (`packages/opencode/src/tool/`)

```
tool/
├── index.ts           # 服务入口
├── tool.ts            # Tool 类型定义与工厂
├── registry.ts        # Tool 注册表
├── bash.ts            # Bash 工具
├── read.ts            # 读取文件工具
├── edit.ts            # 编辑文件工具
├── write.ts           # 写入文件工具
├── glob.ts            # 文件搜索工具
├── grep.ts            # 内容搜索工具
├── task.ts            # 子任务工具
├── skill.ts           # Skill 工具
├── todo.ts            # 待办工具
├── webfetch.ts        # 网页抓取工具
├── websearch.ts       # 网络搜索工具
└── ...
```

#### Session 模块 (`packages/opencode/src/session/`)

```
session/
├── index.ts           # 服务入口（CRUD、消息管理）
├── message-v2.ts      # 消息与 Part 数据模型
├── prompt.ts          # 会话主循环（loop）
├── processor.ts       # LLM 流事件处理器
├── llm.ts             # LLM 调用封装
├── compaction.ts      # 上下文压缩与剪枝
├── summary.ts         # 会话摘要与 diff 计算
└── snapshot.ts        # 代码快照
```

#### Permission 模块 (`packages/opencode/src/permission/`)

```
permission/
├── index.ts           # 服务入口
├── evaluate.ts        # 规则评估算法
└── arity.ts           # Bash 命令参数计数
```

### 2.3 关键技术栈

| 技术 | 版本 | 用途 |
|------|------|------|
| Bun | 1.3.11+ | 运行时、包管理、构建 |
| TypeScript | 5.8.2+ | 类型系统 |
| Effect-TS | 4.0.0-beta.42+ | 函数式编程、错误处理 |
| AI SDK | 6.0.138+ | LLM 调用接口 |
| Zod | 4.1.8+ | 类型校验、Schema |
| Solid.js | 1.9.10+ | UI 框架 |
| Drizzle ORM | 1.0.0-beta+ | 数据库操作 |
| Tree-sitter | - | 命令解析 |

## 3. 代码规范

### 3.1 命名规范

**强制要求：优先使用单字命名**

```ts
// ✅ 推荐
const cfg = config
const pid = processID
const err = error
const opts = options
const dir = directory
const root = rootDir
const child = childProcess
const state = currentState
const timeout = connectionTimeout

// ❌ 避免
const configData = config
const inputPID = processID
const existingClient = client
const connectTimeout = timeout
const workerPath = path
```

### 3.2 变量声明

**优先使用 `const`，避免 `let`**

```ts
// ✅ 推荐
const foo = condition ? 1 : 2

// ❌ 避免
let foo
if (condition) foo = 1
else foo = 2
```

### 3.3 解构规范

**避免不必要的解构，使用点符号保留上下文**

```ts
// ✅ 推荐
obj.a
obj.b
obj.c

// ❌ 避免
const { a, b, c } = obj
```

### 3.4 控制流

**避免 `else`，使用提前返回**

```ts
// ✅ 推荐
function foo() {
  if (condition) return 1
  return 2
}

// ❌ 避免
function foo() {
  if (condition) return 1
  else return 2
}
```

### 3.5 错误处理

**避免 `try/catch`，使用 Effect 或 `.catch()`**

```ts
// ✅ 推荐（Effect）
const program = Effect.gen(function* () {
  const result = yield* Effect.tryPromise({
    try: () => fetchData(),
    catch: (e) => new FetchError(e)
  })
  return result
})

// ✅ 推荐（Promise）
fetchData()
  .then(handleSuccess)
  .catch(handleError)

// ❌ 避免
try {
  const result = await fetchData()
  handleSuccess(result)
} catch (e) {
  handleError(e)
}
```

### 3.6 数组操作

**优先使用函数式方法**

```ts
// ✅ 推荐
const result = items
  .filter(item => item.active)
  .map(item => item.name)
  .flatMap(name => name.split(' '))

// ❌ 避免
const result = []
for (const item of items) {
  if (item.active) {
    result.push(item.name)
  }
}
```

### 3.7 类型定义

**使用推断，避免显式注解**

```ts
// ✅ 推荐
const user = { name: "John", age: 30 }
const users: User[] = []

// ❌ 避免
const user: { name: string; age: number } = { name: "John", age: 30 }
```

### 3.8 函数定义

**保持函数单一职责**

```ts
// ✅ 推荐
function validate(input: string) {
  if (!input) return false
  return input.length > 0
}

function process(data: string) {
  if (!validate(data)) return null
  return data.toUpperCase()
}

// ❌ 避免
function process(data: string) {
  if (!data || data.length === 0) return null
  return data.toUpperCase()
}
```

### 3.9 Drizzle Schema

**使用 snake_case 字段名**

```ts
// ✅ 推荐
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// ❌ 避免
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

### 3.10 文件组织

**保持相关代码在一起**

```ts
// ✅ 推荐（类型、常量、函数在一起）
// tool/read.ts
import { z } from "zod"

const MAX_SIZE = 50 * 1024

const Params = z.object({
  file_path: z.string(),
  offset: z.number().optional(),
})

export const ReadTool = Tool.define("read", async () => ({
  description: "Read file content",
  parameters: Params,
  execute: async (args, ctx) => {
    // ...
  }
}))
```

## 4. 开发工作流

### 4.1 常用命令

```bash
# 启动开发模式
bun run dev

# 在指定目录启动
bun run dev /path/to/project

# 启动无头服务器
bun run dev serve
bun run dev serve --port 8080

# 启动 Web UI
bun run dev web

# 类型检查
bun run typecheck

# 构建
bun run --cwd packages/opencode build
```

### 4.2 在特定目录测试

```bash
# 运行 OpenCode 在指定目录
bun run dev /path/to/test-project

# 或使用构建的二进制文件
./packages/opencode/dist/opencode-darwin-arm64/bin/opencode /path/to/test-project
```

### 4.3 添加依赖

```bash
# 添加运行时依赖
bun add <package>

# 添加开发依赖
bun add -d <package>

# 在特定包中添加
bun add --cwd packages/opencode <package>

# 使用工作区目录
bun add --cwd packages/opencode @scope/package@catalog:
```

### 4.4 脚本构建

```bash
# 构建本地可执行文件
./packages/opencode/script/build.ts

# 构建单一平台
./packages/opencode/script/build.ts --single

# 查看帮助
./packages/opencode/script/build.ts --help
```

### 4.5 代码生成

```bash
# 重新生成 SDK
./script/generate.ts

# 重新生成 JavaScript SDK
./packages/sdk/js/script/build.ts
```

## 5. 调试技巧

### 5.1 基本调试

```bash
# 启用检查器（Inspector）
bun run --inspect=ws://localhost:6499/ dev

# 等待调试器连接
bun run --inspect-wait dev

# 在断点处停止
bun run --inspect-brk dev
```

### 5.2 VSCode 调试

复制示例配置：

```bash
cp .vscode/settings.example.json .vscode/settings.json
cp .vscode/launch.example.json .vscode/launch.json
```

配置示例：

```json
// .vscode/launch.json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "bun",
      "request": "attach",
      "name": "Attach to OpenCode",
      "url": "ws://localhost:6499/"
    }
  ]
}
```

### 5.3 服务器调试

```bash
# 方法 1：使用 spawn 模式
bun run --inspect=ws://localhost:6499/ dev spawn

# 方法 2：分别调试服务器和 TUI
# 终端 1：调试服务器
bun run --inspect=ws://localhost:6499/ --cwd packages/opencode ./src/index.ts serve --port 4096

# 终端 2：调试 TUI
bun run --inspect=ws://localhost:6499/ --cwd packages/opencode --conditions=browser ./src/index.ts
# 或连接已有服务器
opencode attach http://localhost:4096
```

### 5.4 环境变量调试

```bash
# 启用详细日志
DEBUG=opencode:* bun run dev

# 设置 Bun 选项
export BUN_OPTIONS=--inspect=ws://localhost:6499/
bun run dev
```

### 5.5 常见问题

**问题：断点不生效**
- 使用 `bun run --inspect=ws://localhost:6499/ dev spawn` 代替 `bun dev`
- 确保使用 `"request": "attach"` 而非 `"request": "launch"`

**问题：Worker 线程断点**
- Worker 中的断点可能无法正常工作
- 使用 `spawn` 模式或分别调试服务器和 TUI

## 6. 添加新功能

### 6.1 添加新工具

1. **创建工具文件** (`packages/opencode/src/tool/my_tool.ts`)

```ts
import { z } from "zod"
import { Tool } from "./tool.js"

export const MyTool = Tool.define("my_tool", async () => ({
  description: "我的自定义工具",
  parameters: z.object({
    input: z.string().describe("输入参数"),
  }),
  execute: async (args, ctx) => {
    // 执行逻辑
    return {
      title: "执行成功",
      metadata: { input: args.input },
      output: `处理结果: ${args.input}`
    }
  }
}))
```

2. **注册工具** (`packages/opencode/src/tool/registry.ts`)

```ts
import { MyTool } from "./my_tool.js"

export const builtins = [
  // ... 其他工具
  MyTool,
]
```

3. **添加权限规则**（如需）

```ts
// 在 Agent 定义中添加
permission: [
  { permission: "my_tool", pattern: "*", action: "allow" }
]
```

### 6.2 添加新 Agent

1. **在配置文件中定义**

编辑 `~/.config/opencode/opencode.jsonc`：

```json
{
  "agent": {
    "my-agent": {
      "description": "我的自定义 Agent",
      "mode": "subagent",
      "model": "claude-sonnet-4",
      "permission": {
        "edit": "allow",
        "bash": "ask"
      },
      "prompt": "额外的 system prompt...",
      "steps": 10
    }
  }
}
```

2. **或在内置 Agent 中添加** (`packages/opencode/src/agent/agent.ts`)

```ts
export const defaults: Record<string, Info> = {
  // ... 其他 Agent
  "my-agent": {
    name: "my-agent",
    description: "我的自定义 Agent",
    mode: "subagent",
    permission: [...],
    model: { modelID: "...", providerID: "..." },
    prompt: "...",
    options: {},
    steps: 10
  }
}
```

### 6.3 添加新 Provider

1. **安装 AI SDK 提供商包**

```bash
bun add @ai-sdk/<provider>
```

2. **创建 Provider 适配器** (`packages/opencode/src/provider/my_provider.ts`)

```ts
import { create<Provider> } from "@ai-sdk/<provider>"

export const MyProvider = {
  create(apiKey: string) {
    return create<Provider>({ apiKey })
  }
}
```

3. **在配置中注册**

```json
{
  "provider": {
    "myprovider": {
      "npm": "@ai-sdk/<provider>",
      "name": "My Provider",
      "options": {
        "baseURL": "https://api.myprovider.com"
      },
      "models": {
        "my-model": { "name": "My Model" }
      }
    }
  }
}
```

### 6.4 添加自定义 Skill

1. **创建 Skill 目录**

```bash
mkdir -p ~/.config/opencode/skills/my-skill
```

2. **编写 SKILL.md**

```markdown
---
name: my-skill
description: 我的自定义技能
---

# 使用说明

详细说明...

## 示例

```typescript
// 示例代码
```
```

3. **使用 Skill**

```
/skill my-skill
```

## 7. 测试

### 7.1 测试原则

- **避免 mock**：测试真实实现
- **在包目录运行**：不要在根目录运行测试
- **最小化测试范围**：测试具体功能，而非整个流程

### 7.2 运行测试

```bash
# 在包目录中运行测试
cd packages/opencode
bun test

# 运行特定测试文件
bun test src/tool/bash.test.ts

# 运行类型检查
bun typecheck
```

### 7.3 测试示例

```ts
// tool/my_tool.test.ts
import { describe, it, expect } from "bun:test"
import { MyTool } from "./my_tool.js"

describe("MyTool", () => {
  it("should process input correctly", async () => {
    const tool = await MyTool.init()
    const result = await tool.execute({
      input: "test"
    }, mockContext)
    
    expect(result.output).toContain("test")
  })
})
```

### 7.4 注意事项

**不要在根目录运行测试**：

```bash
# ❌ 错误
bun test

# ✅ 正确
cd packages/opencode && bun test
```

根目录的 `package.json` 已配置阻止：

```json
{
  "scripts": {
    "test": "echo 'do not run tests from root' && exit 1"
  }
}
```

## 8. 贡献指南

### 8.1 提交 PR 前

1. **创建 Issue**：所有 PR 必须关联现有 Issue
2. **代码检查**：确保代码符合规范
3. **测试通过**：在相关包目录运行测试
4. **类型检查**：运行 `bun typecheck`

### 8.2 PR 标题规范

使用约定式提交（Conventional Commits）：

```
feat: 添加新功能
fix: 修复 bug
docs: 文档更新
chore: 维护任务
refactor: 代码重构
test: 添加测试
```

可添加作用域：

```
feat(agent): 添加新 Agent 类型
fix(tool): 修复编辑工具的问题
docs(readme): 更新安装说明
```

### 8.3 代码审查

PR 描述应包含：
- 关联的 Issue：`Fixes #123`
- 变更说明
- 测试方法
- 截图（如果是 UI 变更）

### 8.4 禁止事项

- ❌ AI 生成的大段文本（PR 描述、Issue）
- ❌ 未关联 Issue 的 PR
- ❌ 在根目录运行测试
- ❌ 引入不必要的依赖
- ❌ 破坏向后兼容性（无正当理由）

### 8.5 获取帮助

- **Discord**: https://opencode.ai/discord
- **GitHub Issues**: https://github.com/anomalyco/opencode/issues
- **文档**: https://opencode.ai/docs

### 8.6 信任系统

本项目使用 [vouch](https://github.com/mitchellh/vouch) 管理贡献者信任：

- 被信任（Vouched）的贡献者：明确信任的长期贡献者
- 被否定（Denounced）的贡献者：提交低质量 AI 生成内容的用户
- 其他用户：可正常参与

维护者可通过评论管理信任状态：
- `vouch` / `vouch @username` - 信任用户
- `denounce` / `denounce @username <reason>` - 否定用户
