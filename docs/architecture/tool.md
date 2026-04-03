# Tool 模块

Tool 模块是 OpenCode 与外部世界交互的接口层。所有文件操作、命令执行、网络请求、子任务调度等都通过 Tool 实现。

## 核心文件

- `packages/opencode/src/tool/tool.ts` — Tool 类型定义与工厂函数
- `packages/opencode/src/tool/registry.ts` — Tool 注册表，负责加载和过滤工具
- `packages/opencode/src/tool/*.ts` — 各具体 Tool 的实现

## Tool 定义

所有 Tool 都遵循统一的接口：

```ts
export interface Info<Parameters extends z.ZodType = z.ZodType, M extends Metadata = Metadata> {
  id: string
  init: (ctx?: InitContext) => Promise<{
    description: string
    parameters: Parameters
    execute(args: z.infer<Parameters>, ctx: Context): Promise<{
      title: string
      metadata: M
      output: string
      attachments?: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[]
    }>
    formatValidationError?(error: z.ZodError): string
  }>
}
```

### `Tool.define(id, init)`

工厂函数，封装了参数校验和输出截断逻辑：
- 在 `execute` 前自动调用 `parameters.parse(args)` 校验参数
- 如果参数非法，返回友好的错误提示
- 自动对 `output` 调用 `Truncate.output()` 进行截断（除非 Tool 自己设置了 `truncated`）

## Tool 注册表 (`ToolRegistry`)

`ToolRegistry` 负责收集所有可用 Tool，来源包括：

1. **内置 Tools**
   - `InvalidTool`, `QuestionTool`, `BashTool`, `ReadTool`, `GlobTool`, `GrepTool`
   - `EditTool`, `WriteTool`, `TaskTool`, `WebFetchTool`, `TodoWriteTool`
   - `WebSearchTool`, `CodeSearchTool`, `SkillTool`, `ApplyPatchTool`
   - 实验性工具：`LspTool`（需开启 flag）、`BatchTool`（配置开启）、`PlanExitTool`（CLI plan 模式）

2. **自定义 Tools**
   - 从配置目录的 `tool/` 或 `tools/` 下加载 `.js`/`.ts` 文件
   - 每个文件作为一个 namespace，导出的对象映射为 Tool 定义

3. **插件 Tools**
   - 从已加载的 Plugin 的 `tool` 字段中读取

4. **MCP Tools**
   - 在 `SessionPrompt.resolveTools()` 中动态从 MCP 服务器获取
   - 支持文本、图片、资源等多种返回类型

### 模型相关的工具过滤

`ToolRegistry.tools()` 会根据模型类型过滤工具：
- `codesearch` / `websearch`：仅在 `opencode` 提供商或开启 `OPENCODE_ENABLE_EXA` 时可用
- `apply_patch`：仅对非 OSS 的 GPT 模型启用（替代 `edit`/`write`）
- `edit` / `write`：当启用 `apply_patch` 时会被禁用

## 核心内置 Tool 说明

### `bash`
- **文件**: `tool/bash.ts`
- **功能**: 执行 shell 命令
- **安全特性**:
  - 使用 Tree-sitter 解析命令，识别文件系统操作路径
  - 对外部目录操作请求 `external_directory` 权限
  - 对命令本身请求 `bash` 权限
  - 支持超时控制（默认 2 分钟）

### `read`
- **文件**: `tool/read.ts`
- **功能**: 读取文件或目录内容
- **特性**:
  - 支持图片和 PDF 的 base64 附件返回
  - 自动检测二进制文件并拒绝读取
  - 支持 `offset` 和 `limit` 分页读取
  - 大文件自动截断（默认 50KB / 2000 行）

### `edit`
- **文件**: `tool/edit.ts`
- **功能**: 基于字符串替换编辑文件
- **特性**:
  - 支持多种容错匹配策略（Simple、LineTrimmed、BlockAnchor、WhitespaceNormalized 等）
  - 自动格式化修改后的文件
  - 调用 LSP 检查语法错误并返回诊断信息
  - 生成 diff 供用户确认

### `write`
- **文件**: `tool/write.ts`
- **功能**: 写入或覆盖文件

### `task`
- **文件**: `tool/task.ts`
- **功能**: 创建子会话并调度子 Agent 执行任务
- **特性**:
  - 子会话继承父会话的 `parentID`
  - 支持通过 `task_id` 恢复已有子会话
  - 自动根据子 Agent 的权限禁用 `task` 和 `todowrite` 工具，防止无限递归

### `skill`
- **文件**: `tool/skill.ts`
- **功能**: 加载并注入 Skill 内容到上下文

### `glob` / `grep` / `codesearch`
- **功能**: 文件搜索与代码搜索

### `webfetch` / `websearch`
- **功能**: 网页抓取与网络搜索

### `todo`
- **功能**: 管理会话内的待办事项

### `apply_patch`
- **功能**: 应用统一 diff patch（针对特定 GPT 模型优化）

## Tool 执行上下文 (`Tool.Context`)

每个 Tool 在执行时都会获得一个上下文对象：

```ts
export type Context = {
  sessionID: SessionID
  messageID: MessageID
  agent: string
  abort: AbortSignal
  callID?: string
  extra?: { [key: string]: any }
  messages: MessageV2.WithParts[]
  metadata(input: { title?: string; metadata?: M }): void
  ask(input: Omit<Permission.Request, "id" | "sessionID" | "tool">): Promise<void>
}
```

- `sessionID` / `messageID` — 当前会话和消息标识
- `messages` — 当前会话的完整消息历史（供 Tool 参考上下文）
- `metadata()` — 更新 Tool 执行中的元数据（UI 实时展示）
- `ask()` — 向权限系统发起确认请求，如果用户拒绝会抛出错误中断执行
- `abort` — 用于监听用户取消操作

## 插件钩子

Tool 执行前后会触发插件事件：
- `tool.execute.before` — 执行前
- `tool.execute.after` — 执行后
- `tool.definition` — 工具定义初始化后（可修改 description/parameters）
