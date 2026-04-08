# Session Module Architecture & Details

本文档详细介绍了 OpenCode 项目中 `packages/opencode/src/session` 目录下的所有代码及功能。
Session 模块是整个 Agent 对话、任务追踪、上下文管理的绝对核心，几乎所有与 LLM 的交互和状态驻留都依赖于此。

## 目录结构与功能概览

以下是 `session` 目录下核心文件及职责介绍：

### 1. 核心状态与数据定义
- **`schema.ts`**: 定义了 Session ID、Message ID 等基于 `Effect/Schema` 和 `Zod` 的强类型标识符。它是模块间传递引用的基础。
- **`session.sql.ts`**: 会话模块的数据库 Schema（基于 Drizzle ORM）。包含 `SessionTable`（会话基本信息、树形关系、Diff快照等）和 `MessageTable`（对话历史、Token用量等）。
- **`message-v2.ts` / `message.ts`**: 消息实体的定义与存取。封装了与 LLM 对话过程中的 User Message, Assistant Reasoning, 以及 Tool Call 等不同阶段的数据结构。
- **`todo.ts`**: 会话的待办事项系统（Task/TODO）。通过统一的结构 `TodoTable` 及内存 Bus 事件通知，进行多智能体分工协同的状态跟进，防止核心步骤遗漏。

### 2. 对话处理与上下文机制
- **`processor.ts`**: 会话消息处理流水线。负责接收用户输入、调用 LLM、触发工具执行，并将结果循环推入上下文，直到得出最终结论。
- **`llm.ts`**: 与底层模型提供商 (Provider / SDK) 通信的桥梁。处理模型的上下文组装、流式返回（Streaming）重组等。
- **`compaction.ts` & `summary.ts`**: Token 上下文压缩器。当长期对话历史快要超过模型长度限制时，在此处通过聚合并总结早期的无用记录来保证不会丢弃关键记忆。
- **`overflow.ts`**: 协助处理超出上下文长度阈值时的截断和保护逻辑。

### 3. 指令与提示词体系
- **`prompt.ts` / `prompt/`**: Prompt 构建器。负责读取和生成系统级别的 System Prompts。根据不同 Agent 的特性（如 Plan、Build 等），注入当前项目环境、可用的 Tools、当前的工作区等信息。
- **`instruction.ts` & `system.ts`**: 用户定制化指令（如 `SKILL.md` 的读取与注入）和操作系统的底层信息挂载。

### 4. 容错与状态控制
- **`retry.ts`**: 处理工具调用失败、大模型格式错误时的可控重试机制。
- **`revert.ts` / `status.ts`**: 会话的状态回滚与恢复机制。允许由于某些致命错误使得整个任务树偏离时，恢复到之前的安全节点快照（Snapshot）。

## 工作流关联关系

1. **新建会话**：通过 `schema.ts` 生成唯一标识，存入 `session.sql.ts`。
2. **上下文组装**：调用 `prompt.ts` 和 `system.ts` 结合之前的 `message-v2.ts` 聚合成当前请求。
3. **压缩检查**：由 `compaction.ts` 确保发送给 `llm.ts` 的 Token 是安全的。
4. **进度反馈**：LLM 处理中触发 Tool 进而通过 `todo.ts` 更新该分支节点任务的状态，直到标记完成。

