# Skill 模块

Skill 模块负责发现、加载和向 LLM 上下文注入领域特定的技能说明（`SKILL.md`）。

## 核心文件

- `packages/opencode/src/skill/index.ts` — Skill 服务主入口
- `packages/opencode/src/skill/discovery.ts` — 远程 Skill 发现与下载

## Skill 是什么

Skill 是一个包含 `SKILL.md` 文件的目录。`SKILL.md` 使用 YAML frontmatter 描述技能元数据：

```yaml
---
name: my-skill
description: A short description of what this skill does
---

Detailed instructions, workflows, and examples go here...
```

当 Agent 调用 `skill` 工具时，对应 Skill 的完整内容会被注入到对话上下文中，帮助模型获得领域专业知识。

## Skill 来源

系统按以下优先级扫描并加载 Skill：

1. **外部目录**（全局）
   - `~/.claude/skills/`
   - `~/.agents/skills/`
   - 可通过环境变量 `OPENCODE_DISABLE_EXTERNAL_SKILLS` 禁用

2. **外部目录**（项目级，向上遍历到工作区根）
   - 从当前目录向上查找 `.claude/skills/` 和 `.agents/skills/`

3. **配置目录**
   - OpenCode 配置目录下的 `skill/` 或 `skills/` 子目录

4. **自定义路径**
   - 用户配置 `skills.paths` 中指定的本地目录

5. **远程 URL**
   - 用户配置 `skills.urls` 中指定的远程索引
   - 远程索引需提供一个 `index.json`，格式如下：
     ```json
     {
       "skills": [
         { "name": "my-skill", "files": ["SKILL.md", "script.js"] }
       ]
     }
     ```
   - `Discovery` 服务会下载所有文件到本地缓存目录 (`~/.cache/opencode/skills/`)

## Skill 服务接口

```ts
export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly all: () => Effect.Effect<Info[]>
  readonly dirs: () => Effect.Effect<string[]>
  readonly available: (agent?: Agent.Info) => Effect.Effect<Info[]>
}
```

- `get(name)` — 按名称获取 Skill
- `all()` — 获取所有已加载的 Skill
- `dirs()` — 获取所有 Skill 所在的目录（用于权限白名单）
- `available(agent)` — 根据 Agent 的权限规则过滤可用的 Skill

## 权限控制

Skill 的加载受 Agent `permission` 中的 `skill` 规则控制。如果某个 Skill 名称被规则 `deny`，则该 Agent 无法看到或使用它。

## 相关 Tool

`packages/opencode/src/tool/skill.ts` 实现了 `skill` 工具：
- 接收 `name` 参数
- 查找并返回 Skill 内容
- 同时列出 Skill 目录下的辅助文件（脚本、模板等），方便模型引用
