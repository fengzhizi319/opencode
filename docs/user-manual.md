# 用户手册 (User Manual)

## 目录

1. [简介](#1-简介)
2. [安装](#2-安装)
3. [快速上手](#3-快速上手)
4. [配置 LLM 提供商](#4-配置-llm-提供商)
5. [基本使用](#5-基本使用)
6. [Agent 系统](#6-agent-系统)
7. [工具使用](#7-工具使用)
8. [命令参考](#8-命令参考)
9. [配置详解](#9-配置详解)
10. [高级功能](#10-高级功能)
11. [故障排除](#11-故障排除)

## 1. 简介

OpenCode 是一个开源的 AI 编程助手，帮助你更高效地进行软件开发。它支持多种 LLM 提供商，提供丰富的工具集，包括文件编辑、代码搜索、命令执行等功能。

### 主要特性

- 🚀 **多提供商支持**：OpenAI、Anthropic、Google、本地模型等
- 🤖 **智能 Agent**：内置多种专业 Agent，按 Tab 键快速切换
- 🛠️ **丰富工具集**：文件操作、代码搜索、网页抓取、待办管理等
- 📚 **Skill 系统**：可扩展的领域知识库
- 🔒 **权限控制**：细粒度的工具权限管理
- 💻 **多界面支持**：TUI、Web UI、桌面应用

## 2. 安装

### 2.1 系统要求

- **操作系统**: macOS、Linux、Windows (WSL 推荐)
- **运行环境**: Bun 1.3+
- **硬件**: 建议 4GB+ RAM

### 2.2 安装方法

#### 方法 1：快速安装脚本（推荐）

```bash
curl -fsSL https://opencode.ai/install | bash
```

#### 方法 2：包管理器

```bash
# npm
npm i -g opencode-ai@latest

# bun
bun i -g opencode-ai@latest

# Homebrew (macOS/Linux)
brew install anomalyco/tap/opencode

# Scoop (Windows)
scoop install opencode

# Arch Linux
sudo pacman -S opencode
paru -S opencode-bin

# mise
mise use -g opencode
```

#### 方法 3：从源码安装

```bash
git clone https://github.com/opencode/opencode.git
cd opencode
bun install
bun run --cwd packages/opencode --conditions=browser src/index.ts
```

### 2.3 安装目录

安装脚本按以下优先级选择安装路径：

1. `$OPENCODE_INSTALL_DIR` - 自定义安装目录
2. `$XDG_BIN_DIR` - XDG 规范路径
3. `$HOME/bin` - 用户二进制目录
4. `$HOME/.opencode/bin` - 默认路径

```bash
# 示例：安装到 /usr/local/bin
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
```

### 2.4 桌面应用

| 平台 | 下载 |
|------|------|
| macOS (Apple Silicon) | `opencode-desktop-darwin-aarch64.dmg` |
| macOS (Intel) | `opencode-desktop-darwin-x64.dmg` |
| Windows | `opencode-desktop-windows-x64.exe` |
| Linux | `.deb`、`.rpm` 或 AppImage |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop

# Windows (Scoop)
scoop bucket add extras
scoop install extras/opencode-desktop
```

## 3. 快速上手

### 3.1 启动 OpenCode

```bash
# 在项目目录中启动
opencode

# 指定目录启动
opencode /path/to/project

# 启动无头服务器
opencode serve

# 启动 Web 界面
opencode web
```

### 3.2 首次使用

1. **启动 TUI 模式**
   ```bash
   opencode
   ```

2. **配置 API 密钥**
   
   在 TUI 中输入：
   ```
   /connect
   ```
   
   按提示输入：
   - Provider ID（如 `openai`、`anthropic`）
   - API 密钥

3. **开始对话**
   
   输入你的问题或指令，例如：
   ```
   帮我解释一下这个项目的结构
   ```

### 3.3 开发模式（源码运行）

如果你从源码安装：

```bash
# 在项目根目录
cd /path/to/opencode

# 启动开发模式
bun run dev

# 或运行单次命令
bun run --cwd packages/opencode --conditions=browser src/index.ts run -- "你的问题"
```

## 4. 配置 LLM 提供商

### 4.1 使用 /connect 命令

在 TUI 中输入：
```
/connect
```

交互式配置：
```
┌  Add credential
│
◇  Enter provider id
│  openai
│
◇  Enter your API key
│  sk-xxxxxxxxxxxxxxxx
└
```

密钥将安全存储在 `~/.local/share/opencode/auth.json`。

### 4.2 配置文件方式

编辑 `~/.config/opencode/opencode.jsonc`：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "openai": {
      "name": "OpenAI",
      "models": {
        "gpt-4o": { "name": "GPT-4o" }
      }
    }
  }
}
```

### 4.3 自定义提供商

配置兼容 OpenAI API 的第三方服务：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "myprovider": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "自定义模型服务",
      "options": {
        "baseURL": "https://api.myprovider.com/v1"
      },
      "models": {
        "my-model": { "name": "我的模型" }
      }
    }
  }
}
```

参数说明：
- `npm`: SDK 包名（OpenAI 兼容服务使用 `@ai-sdk/openai-compatible`）
- `name`: 显示名称
- `options.baseURL`: API 基础 URL
- `models`: 可用模型列表

### 4.4 切换模型

在 TUI 中输入：
```
/model
```

选择要使用的模型。

## 5. 基本使用

### 5.1 对话模式

OpenCode 运行在交互式 TUI 模式中，你可以：

- 直接输入自然语言指令
- 使用 `@agent` 指定 Agent
- 使用 `/command` 执行内置命令

### 5.2 文件操作

让 OpenCode 帮你操作文件：

```
请读取 src/index.ts 文件并解释其功能
```

```
帮我在 utils 目录下创建一个日期格式化工具
```

```
修改 src/config.ts，添加一个 debug 选项
```

### 5.3 代码搜索

```
搜索项目中所有使用 useEffect 的地方
```

```
查找定义 User 类型的文件
```

### 5.4 运行命令

```
运行 npm test 并分析测试结果
```

```
执行 git status 查看当前变更
```

### 5.5 网络请求

```
搜索最新的 React 19 新特性
```

```
抓取 https://example.com/docs 的文档内容
```

## 6. Agent 系统

### 6.1 内置 Agent

| Agent | 描述 | 用途 |
|-------|------|------|
| **build** | 默认 Agent | 完整权限，适合开发工作 |
| **plan** | 计划模式 | 只读，适合代码分析 |

### 6.2 切换 Agent

**方法 1：Tab 键切换**

在输入框中按 `Tab` 键快速切换 Agent。

**方法 2：@ 符号指定**

```
@plan 请分析这个项目的架构
```

**方法 3：使用内置 Agent**

```
@general 帮我搜索所有包含 "TODO" 的代码
```

### 6.3 Agent 模式

| 模式 | 说明 |
|------|------|
| **primary** | 主 Agent，可直接与用户交互 |
| **subagent** | 子 Agent，只能通过 `task` 工具调用 |
| **all** | 两者皆可 |

### 6.4 内置子 Agent

| Agent | 用途 |
|-------|------|
| **general** | 通用任务，复杂搜索和多步任务 |
| **explore** | 快速探索代码库 |

调用方式：
```
@general 帮我分析这个函数的所有调用链
```

## 7. 工具使用

### 7.1 文件操作工具

#### read - 读取文件

```
请读取 README.md 文件
```

支持参数：
- 指定行范围：`读取 src/index.ts 的第 10-50 行`
- 读取目录：`列出 src 目录的内容`

#### edit - 编辑文件

```
请将 src/config.ts 中的 port: 3000 改为 port: 8080
```

OpenCode 会自动匹配字符串并替换。

#### write - 写入文件

```
帮我在 src/utils.ts 中写入一个日期格式化函数
```

### 7.2 搜索工具

#### glob - 文件搜索

```
查找所有 .test.ts 文件
```

#### grep - 内容搜索

```
搜索所有包含 "useState" 的代码
```

#### codesearch - 语义搜索

```
使用语义搜索查找处理用户认证的代码
```

### 7.3 执行工具

#### bash - 执行命令

```
运行 npm install
```

```
执行 ls -la
```

安全提示：
- 对外部目录操作会请求确认
- 敏感命令会触发权限询问

### 7.4 网络工具

#### websearch - 网络搜索

```
搜索 Next.js 14 的新特性
```

#### webfetch - 网页抓取

```
抓取 https://api.example.com/docs
```

### 7.5 会话工具

#### todo - 待办事项

```
添加待办：完成用户认证模块
```

```
列出所有待办事项
```

#### task - 子任务

```
创建一个子任务来专门分析 package.json 的依赖
```

### 7.6 知识工具

#### skill - 加载技能

```
使用 skill:typescript 帮我优化这段代码
```

## 8. 命令参考

### 8.1 斜杠命令

在 TUI 中输入 `/` 开头的命令：

| 命令 | 描述 |
|------|------|
| `/connect` | 添加或管理 API 密钥 |
| `/model` | 切换模型 |
| `/agent` | 切换 Agent |
| `/compact` | 手动触发上下文压缩 |
| `/clear` | 清空当前会话 |
| `/help` | 显示帮助 |
| `/exit` | 退出程序 |

### 8.2 CLI 参数

```bash
opencode [options] [directory]

选项：
  --help              显示帮助信息
  --version           显示版本号
  serve               启动无头服务器
  web                 启动 Web 界面
  attach <url>        连接到远程服务器
  
示例：
  opencode                    # 在当前目录启动
  opencode /path/to/project   # 在指定目录启动
  opencode serve --port 8080  # 启动服务器在 8080 端口
```

### 8.3 键盘快捷键

| 快捷键 | 功能 |
|--------|------|
| `Tab` | 切换 Agent |
| `Ctrl+C` | 取消当前操作 |
| `Ctrl+D` | 退出程序 |
| `↑/↓` | 浏览历史记录 |

## 9. 配置详解

### 9.1 配置文件位置

- **项目级**: `opencode.json`
- **全局**: `~/.config/opencode/opencode.jsonc`

### 9.2 配置结构

```json
{
  "$schema": "https://opencode.ai/config.json",
  
  // 默认模型
  "model": "claude-sonnet-4",
  
  // LLM 提供商配置
  "provider": {
    "openai": {
      "name": "OpenAI",
      "models": { ... }
    }
  },
  
  // 自定义 Agent
  "agent": {
    "my-agent": {
      "description": "My custom agent",
      "mode": "subagent",
      "permission": { ... }
    }
  },
  
  // Skill 配置
  "skills": {
    "paths": ["/path/to/skills"],
    "urls": ["https://example.com/skills/index.json"]
  },
  
  // 权限配置
  "permission": [
    { "permission": "bash", "pattern": "npm *", "action": "allow" }
  ],
  
  // MCP 服务器配置
  "mcp": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
    }
  }
}
```

### 9.3 权限配置

权限规则格式：

```json
{
  "permission": [
    { "permission": "edit", "pattern": "*", "action": "allow" },
    { "permission": "bash", "pattern": "rm *", "action": "ask" },
    { "permission": "bash", "pattern": "sudo *", "action": "deny" }
  ]
}
```

动作类型：
- `allow`: 自动允许
- `deny`: 自动拒绝
- `ask`: 询问用户

## 10. 高级功能

### 10.1 Skill 系统

Skill 是领域知识的载体，帮助 Agent 更好地完成特定任务。

**使用 Skill：**
```
/skill my-skill
```

**创建自定义 Skill：**

创建 `~/.config/opencode/skills/my-skill/SKILL.md`：

```markdown
---
name: my-skill
description: 我的自定义技能
---

# 说明

详细的使用说明...

## 示例

```typescript
// 示例代码
```
```

### 10.2 MCP 集成

MCP（Model Context Protocol）允许你连接外部工具和服务。

**配置 MCP 服务器：**

```json
{
  "mcp": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/docs"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "<token>"
      }
    }
  }
}
```

### 10.3 会话管理

**创建新会话：**
```
/new
```

**切换会话：**
```
/sessions
```

**分叉会话：**
```
/fork
```

### 10.4 上下文压缩

当对话历史过长时，OpenCode 会自动压缩上下文。你也可以手动触发：

```
/compact
```

### 10.5 代码快照

OpenCode 会自动记录代码变更的快照，方便回溯和生成 diff。

## 11. 故障排除

### 11.1 常见问题

#### Q: 无法启动 OpenCode

检查 Bun 版本：
```bash
bun --version  # 需要 1.3+
```

#### Q: API 密钥配置失败

检查配置文件权限：
```bash
ls -la ~/.local/share/opencode/
```

#### Q: 模型响应很慢

- 检查网络连接
- 尝试切换到更快的模型
- 使用 `/compact` 压缩上下文

#### Q: 工具执行失败

检查权限配置，或尝试：
```
/permission
```

### 11.2 日志查看

日志文件位置：
- Linux/macOS: `~/.local/share/opencode/logs/`
- Windows: `%LOCALAPPDATA%\opencode\logs\`

### 11.3 重置配置

```bash
# 备份配置
mv ~/.config/opencode ~/.config/opencode.backup

# 重启 OpenCode 会重新创建默认配置
```

### 11.4 获取帮助

- **Discord**: https://opencode.ai/discord
- **GitHub Issues**: https://github.com/anomalyco/opencode/issues
- **文档**: https://opencode.ai/docs
