# Permission 模块

Permission 模块负责评估和执行工具调用的权限规则，支持 `allow`、`deny`、`ask` 三种动作。

## 核心文件

- `packages/opencode/src/permission/index.ts` — 权限服务主入口
- `packages/opencode/src/permission/evaluate.ts` — 规则评估算法
- `packages/opencode/src/permission/arity.ts` — Bash 命令参数计数（用于权限模式匹配）

## 权限模型

权限由一组规则（Ruleset）组成：

```ts
export type Rule = {
  permission: string   // 权限名称，如 "edit", "bash", "skill"
  pattern: string      // 匹配模式，支持通配符
  action: "allow" | "deny" | "ask"
}
```

多个 Ruleset 可以合并（`Permission.merge`），后出现的规则优先。

## 规则评估

`Permission.evaluate(permission, pattern, ...rulesets)` 会按顺序在所有 Ruleset 中查找匹配的规则：
- 先匹配 `permission` 字段（支持通配符 `*`）
- 再匹配 `pattern` 字段（支持通配符 `*`、`?` 等）
- 返回最后一条匹配规则的 `action`

如果没有匹配到任何规则，默认行为取决于调用方（通常视为需要询问）。

## 权限来源

一个 Tool 调用最终生效的权限是三层合并的结果：

1. **Agent 默认权限**（`Agent` 模块中 `defaults`）
2. **Agent 专属权限**（如 `build` Agent 额外允许 `question`）
3. **用户配置权限**（`cfg.permission`）
4. **会话级权限**（`session.permission`，通过 `SessionPrompt.prompt()` 传入的 `tools` 参数转换而来）

在 `SessionPrompt.resolveTools()` 中，最终权限用于：
- 过滤掉被 `deny` 的工具
- 在 Tool 执行时通过 `ctx.ask()` 触发用户确认

## 用户确认流程

当规则评估结果为 `ask` 时，系统会：

1. 创建一个 `Permission.Request`，包含权限名、模式、元数据等
2. 通过 `Bus.publish(Permission.Event.Asked, ...)` 向 UI 发送确认请求
3. 使用 `Deferred` 挂起当前 Effect，等待用户回复
4. 用户回复后调用 `Permission.reply()`：
   - `once` — 仅允许本次调用
   - `always` — 将对应 pattern 加入 `approved` Ruleset，永久允许
   - `reject` — 拒绝本次调用，并取消同一会话中所有待处理的权限请求

### 错误类型

- `Permission.DeniedError` — 规则明确 `deny`，无需询问直接拒绝
- `Permission.RejectedError` — 用户在弹窗中点击了拒绝
- `Permission.CorrectedError` — 用户拒绝并附带了反馈信息

## 特殊权限

### `doom_loop`
当模型连续重复调用同一工具时触发，需要用户确认是否继续。

### `external_directory`
`bash` 工具会解析命令中的文件路径。如果操作指向项目工作区之外的目录，会请求 `external_directory` 权限。

### `skill`
`skill` 工具加载特定 Skill 前会请求 `skill` 权限，pattern 为 Skill 名称。

### `task`
`task` 工具调度子 Agent 前会请求 `task` 权限，pattern 为子 Agent 名称。

### `read`
`read` 工具对 `.env` 文件默认设置为 `ask`，保护敏感配置。

### `edit`
`edit`、`write`、`apply_patch`、`multiedit` 共享 `edit` 权限命名空间。

## 工具禁用集合

`Permission.disabled(tools, ruleset)` 用于快速找出被全局 `deny` 的工具：
- 如果某条规则的 `pattern === "*"` 且 `action === "deny"`，则该工具被完全禁用
- 编辑类工具（`edit`, `write`, `apply_patch`, `multiedit`）统一受 `edit` 权限控制
