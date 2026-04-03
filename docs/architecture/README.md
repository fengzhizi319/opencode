# OpenCode 架构文档

本文档目录包含 OpenCode 核心架构的详细说明，帮助开发者理解系统设计和进行源码调试。

## 文档索引

### 核心架构

| 文档 | 说明 |
|------|------|
| [overview.md](./overview.md) | 架构概览、模块结构、数据流、技术选型 |
| [skill.md](./skill.md) | Skill 发现、加载、注入机制 |
| [agent.md](./agent.md) | Agent 定义、内置 Agent、调度机制 |
| [tool.md](./tool.md) | Tool 定义、注册、执行流程 |
| [session-memory.md](./session-memory.md) | 会话管理、消息模型、记忆压缩 |
| [permission.md](./permission.md) | 权限规则、评估、用户确认 |

### 执行流程与调试

| 文档 | 说明 |
|------|------|
| [workflow-example.md](./workflow-example.md) | 完整任务执行数据流示例（冒泡排序） |
| [workflow-diagram.md](./workflow-diagram.md) | Mermaid 流程图集合（6 张图） |
| [live-execution.md](./live-execution.md) | **实际执行演示**：逐行代码跟踪 |
| [debugging-guide.md](./debugging-guide.md) | 详细调试指南（断点、日志、技巧） |
| [debugging-cheatsheet.md](./debugging-cheatsheet.md) | 调试速查表（快速参考） |
| [debugging-workflow.md](./debugging-workflow.md) | 逐步调试工作流 |

---

## 快速导航

### 我想了解整体架构
→ 阅读 [overview.md](./overview.md) 和查看 [workflow-diagram.md](./workflow-diagram.md) 的流程图

### 我想理解 Skill 如何工作
→ 阅读 [skill.md](./skill.md) 和查看 workflow-diagram 中的 "Skill 使用流程图"

### 我想理解 Agent 调度
→ 阅读 [agent.md](./agent.md) 和查看 workflow-diagram 中的 "Agent 调度流程图"

### 我想理解 Tool 执行
→ 阅读 [tool.md](./tool.md) 和 [session-memory.md](./session-memory.md) 的 "Processor" 部分

### 我想开始调试代码
→ 阅读 [debugging-guide.md](./debugging-guide.md) 和 [debugging-cheatsheet.md](./debugging-cheatsheet.md)

### 我想跟踪一个具体任务的执行
→ 阅读 [workflow-example.md](./workflow-example.md)、[live-execution.md](./live-execution.md) 和 [debugging-workflow.md](./debugging-workflow.md)

---

## 关键流程图预览

### 整体架构流程
```
用户输入 → SessionPrompt → loop() → Agent.get() → Skill.available()
    ↓
ToolRegistry.tools() → LLM.stream() → Processor.handleEvent()
    ↓
Tool.execute() → Permission.ask() → 用户确认 → 文件写入
    ↓
SessionSummary.summarize() → 返回结果
```

### 核心数据流
1. **用户层**: 输入任务描述
2. **会话层**: 创建消息、管理对话状态
3. **Agent 层**: 选择执行策略、权限配置
4. **Skill 层**: 注入领域知识
5. **Tool 层**: 提供操作能力
6. **LLM 层**: 生成回复、决策工具调用
7. **记忆层**: 持久化消息、压缩历史
8. **权限层**: 控制访问、用户确认

---

## 调试冒泡排序任务

### 最小调试命令
```bash
cd packages/opencode
OPENCODE_LOG_LEVEL=debug bun run --conditions=browser ./src/index.ts run -- "生成python冒泡排序代码，并验证结果正确性"
```

### 关键断点位置

| 文件 | 行 | 目的 |
|------|-----|------|
| `session/prompt.ts` | 162 | 查看用户消息创建 |
| `session/prompt.ts` | 278 | 进入主循环 |
| `agent/agent.ts` | 319 | 检查 Agent 配置 |
| `skill/index.ts` | 230 | 检查 Skills |
| `session/prompt.ts` | 772 | 检查工具列表 |
| `session/llm.ts` | 68 | 检查 LLM 输入 |
| `session/processor.ts` | 115 | 跟踪流事件 |
| `tool/write.ts` | ~30 | 跟踪文件写入 |
| `permission/index.ts` | 166 | 检查权限评估 |

更多详情见 [live-execution.md](./live-execution.md) 和 [debugging-cheatsheet.md](./debugging-cheatsheet.md)

---

## 代码结构

```
packages/opencode/src/
├── skill/           # Skill 模块
│   ├── index.ts     # Skill 服务
│   └── discovery.ts # 远程 Skill 发现
├── agent/           # Agent 模块
│   └── agent.ts     # Agent 定义和服务
├── tool/            # Tool 模块
│   ├── tool.ts      # Tool 类型定义
│   ├── registry.ts  # Tool 注册表
│   ├── skill.ts     # Skill 工具
│   ├── task.ts      # 子任务工具
│   ├── bash.ts      # Bash 执行
│   ├── read.ts      # 文件读取
│   ├── edit.ts      # 文件编辑
│   └── write.ts     # 文件写入
├── session/         # Session 模块
│   ├── index.ts     # 会话 CRUD
│   ├── message-v2.ts# 消息数据模型
│   ├── prompt.ts    # 主循环 loop()
│   ├── processor.ts # 流事件处理
│   ├── llm.ts       # LLM 调用
│   ├── compaction.ts# 记忆压缩
│   └── summary.ts   # 会话摘要
└── permission/      # 权限模块
    └── index.ts     # 权限评估和确认
```

---

## 相关链接

- [项目 README](../../README.md)
- [CONTRIBUTING.md](../../CONTRIBUTING.md)
- [AGENTS.md](../../AGENTS.md) - 项目编码规范
