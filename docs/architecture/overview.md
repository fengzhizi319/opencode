# OpenCode 架构概览

本文档介绍 OpenCode 核心架构，帮助开发者理解代码组织方式和关键模块的职责。

## 项目结构

核心代码位于 `packages/opencode/src/`，采用模块化设计，主要模块包括：

- **`skill/`** — Skill 发现、加载与注入
- **`agent/`** — Agent 定义、调度与权限配置
- **`tool/`** — Tool 定义、注册与执行
- **`session/`** — 会话管理、消息模型、记忆压缩与 LLM 交互
- **`permission/`** — 权限规则评估与用户确认机制
- **`provider/`** — 大模型提供商封装与适配
- **`project/`** — 项目实例、工作区与状态管理
- **`config/`** — 配置解析与迁移
- **`bus/`** — 内部事件总线
- **`plugin/`** — 插件系统

## 数据流概览

1. **用户输入** → `SessionPrompt.prompt()` 创建用户消息
2. **会话循环** → `SessionPrompt.loop()` 驱动多轮交互
3. **Agent 选择** → 根据用户消息中的 `agent` 字段选择对应 Agent
4. **工具解析** → `resolveTools()` 从 `ToolRegistry` 获取可用工具
5. **LLM 调用** → `LLM.stream()` 组装 system prompt、messages、tools 并流式调用模型
6. **事件处理** → `SessionProcessor` 处理流事件（reasoning、tool-call、text-delta 等）
7. **工具执行** → 模型发起 tool-call 后，对应 Tool 的 `execute()` 被调用
8. **记忆管理** → 当上下文超出限制时，`SessionCompaction` 触发压缩或剪枝

## 关键技术选型

- **Effect-TS**：用于依赖注入、错误处理、异步编排
- **AI SDK (Vercel)**：统一的大模型调用接口 (`streamText`, `generateObject`)
- **Zod**：运行时类型校验与 JSON Schema 生成
- **Drizzle ORM + SQLite**：本地数据持久化
- **Tree-sitter**：Bash/PowerShell 命令解析（用于权限扫描）
