# 设计文档 (Design Document)

## 项目架构分析

OpenCode 是一个 AI 辅助编程系统，分为多个关键组件：
- **CLI / 控制台 (Console)**: 用户交互界面和命令行处理
- **LLM 提供商集成组件**: 与各个大型语言模型（如 OpenAI、Anthropic、自定义模型等）交互
- **工具链组件**: 提供操作本地文件系统、执行终端命令、进行搜索的功能
- **代理系统 (Agent)**: 构建业务逻辑流和状态机制，管理上下文和会话

## 模块结构

- **packages/opencode**: 核心系统与主包
- **packages/desktop-electron**: 桌面客户端图形界面
- **packages/console**: 控制台核心包
- **packages/desktop**: 桌面端 Web UI
- **docs**: 文档库

## 核心工作流

1. **输入解析**: 用户在终端执行 `bun run dev` 或传递 CLI 参数。
2. **状态初始化**: 读取本地配置 (`~/.config/opencode/opencode.jsonc`) 并加载密钥信息 (`~/.local/share/opencode/auth.json`)。
3. **分发任务**: 依赖内部 Agent 的调度系统，调用工具获取环境上下文（运行系统指令、检查文件内容等）。
4. **LLM 交互**: 把上下文和任务指令发给 LLM 获取代码修改计划或直接的代码替换方案。
5. **执行操作**: 基于 LLM 反馈，在本地进行编辑动作。
