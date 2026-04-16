<!--
生成文档：用于 `plan` agent 的 plan skill（中文翻译）。
存放于仓库的 docs/ 目录下，供用户参考。
-->
# 计划技能（Plan skill，用于 plan agent）

本文档说明了 "plan" skill 以及 OpenCode 中 `plan` agent 如何使用 skill 来创建、存储并执行计划。包含发现、编写、调用、权限、集成模式（Plan → Build 工作流）、安全考虑和故障排查等内容。

## 概述

- 什么是 "skill"？
  - skill 是一个目录，包含 `SKILL.md`（带 YAML frontmatter 的 Markdown）以及可选的资源（脚本、模板、参考资料）。
  - Skills 为 LLM 提供领域专用的指令、工作流和辅助资产，模型可以在对话中加载这些内容以辅助生成更符合要求的输出。

- 什么是 "plan" skill？
  - "Plan" skill 是专注于规划的 skill，包含模板、工作清单和示例，帮助 `plan` agent 生成高质量、可执行的计划。
  - `plan` agent 使用 skill 将结构化指导（如模板、检查表、约束）注入 system/assistant 提示中，以便模型按期望格式和位置生成计划。

## skill 的发现与加载

- 发现来源（优先与位置）：
  - 项目内 skill 目录：`.opencode/skill/` 或 `.opencode/skills/`。
  - 兼容 Claude/Agents 的目录：`.claude/skills/` 和 `.agents/skills/`。
  - 在 opencode 配置中指定的路径（`cfg.skills.paths`），可为绝对或相对项目目录。
  - 配置的远程 skill URL（`cfg.skills.urls`），通过发现机制拉取。
  - 全局用户目录（例如 `~/.claude/skills`、`~/.agents/skills`）。

- 维护者实现要点：
  - Skill 的检测通过扫描 `SKILL.md` 实现（参见 `src/skill/index.ts`）。
  - 加载器解析 YAML frontmatter，并以 `Skill.Info` 对象暴露 `{ name, description, location, content }`。
  - `Skill.fmt(list, { verbose })` 用于把可用技能格式化，供工具描述或系统提示使用。

## `skill` 工具返回的内容

- `skill` 工具（Tool id: `skill`）是 LLM 在会话中调用以加载 skill 的工具。
- 调用入参：`{ name: string }`，返回的对象通常包含：
  - `title`：例如 `Loaded skill: <name>` 的短标题。
  - `output`：字符串，包含一个 `<skill_content name="...">` 块，内含 skill 的 Markdown 内容以及采样的 `<skill_files>`（用 XML-like 标签列出若干文件路径）。
  - `metadata`：对象 `{ name, dir }`，其中 `dir` 为 skill 的目录路径。

- 返回示例结构（摘要）：

```xml
<skill_content name="example-plan-skill">
# Skill: example-plan-skill

... (SKILL.md 内容)...

Base directory for this skill: file:///.../path/to/skill/

<skill_files>
<file>/abs/path/to/skill/template.md</file>
<file>/abs/path/to/skill/scripts/generate.sh</file>
 ...
</skill_files>
</skill_content>
```

- 采样限制：当返回文件列表时，loader 会采样至多 10 个文件（见 `src/tool/skill.ts` 中的 `limit = 10` 设置）。

## 与 `plan` agent 的权限交互

- `plan` agent 使用专门的、相对严格的权限规则：
  - 默认对大多数文件的 `edit` 权限被拒绝，但允许对计划相关位置进行写入：
    - 项目内 `.opencode/plans/*.md`（项目工作区内的计划文件）以及全局数据目录下的 `plans`（例如 `Global.Path.data/plans`）。
  - `plan_enter` 和 `plan_exit` 为特殊权限，用于控制进入/退出计划模式。
  - `question`（提问）通常被允许，便于 agent 询问澄清问题。

- 加载 skill 时需要用户许可：`skill` 工具在返回内容前会调用 `ctx.ask({ permission: 'skill', patterns: [params.name], always: [params.name], ... })`。这保证在会话中注入 skill 内容前获得用户或主机策略的同意。

## 计划文件的存放位置

- 计划文件会写入以下位置之一：
  - 项目工作树：`<project>/.opencode/plans/<timestamp>-<slug>.md`（当仓库为 git repo 或工作树存在时）。
  - 全局计划目录：`<Global.Path.data>/plans/<timestamp>-<slug>.md`（当没有项目工作树时）。

- 使用 `Session.plan({ slug, time })` 辅助函数来计算规范路径。

## 如何编写适合规划的 `SKILL.md`

典型的 `SKILL.md` 是带 YAML frontmatter 的 Markdown 文档。最少 frontmatter 应包含：

```yaml
---
name: my-plan-skill
description: Templates and workflows to produce structured implementation plans
---
```

推荐结构：

- 标题和简介
- 使用场景（何时使用该 skill）
- 计划模板（模型应输出的 Markdown 片段），例如：
  - 问题陈述
  - 目标（成功标准）
  - 约束
  - 逐步任务
  - 验收标准与测试
- 示例计划
- 文件与模板（相对于 skill 根目录的路径，例如 `templates/plan-template.md`）
- 脚本或辅助命令（放在 `scripts/`）

最佳实践：
- 指导应具有可被模型遵循的结构化格式（模型更容易遵循明确模板）。
- 提供可直接填充的模板，方便模型将结果写入 `.opencode/plans/`。
- 在示例中使用相对路径并注明这些路径相对于 skill 根目录。

### 最简 `SKILL.md` 示例

```md
---
name: plan-templates
description: Planning templates and checklists for engineering tasks
---

# Plan Templates

## When to use
Use this skill when the user requests a multi-step implementation plan, tests, or a migration strategy.

## Plan Template: simple

### Problem
Describe the issue.

### Goal
State success criteria.

### Steps
- Step 1: ...
- Step 2: ...

### Tests / Acceptance
- Add unit tests: ...

## Example
Below is an example plan for adding a new API endpoint.

```
Problem: Add POST /items to create items.
Goal: ...
Steps:
- Create route
...etc
```

```

将辅助资源放在 `templates/` 或 `scripts/` 下。
```

### 进阶 `SKILL.md` 示例（含模板与使用说明）

可以包含另一个代码块示例，展示 `templates/plan.md` 的内容和脚本布局。

```md
---
name: plan-advanced
description: Advanced planning skill with templates and CI checklist
---

# Advanced Planning Skill

## Templates

Add `templates/implementation-plan.md` and `templates/test-plan.md`.

## Usage
When asked for a plan, the model should:
1. Choose an appropriate template.
2. Fill the sections.
3. Write the result to `.opencode/plans/<timestamp>-<slug>.md`.

```

注意：使用占位符（如 `{{goal}}`）可以帮助模型明确替换位置。

## 在会话中调用并使用 skill

用户请求计划时的典型流程：

1. 用户："请为 X 制定一个实施计划并保存为计划文件。"
2. 模型识别到匹配的 skill，调用 `skill` 工具：`{ name: '<skill-name>' }`。
3. `skill` 工具请求许可并返回 skill 内容与采样文件列表。
4. 模型使用 skill 内容（模板、示例）生成计划文本。
5. 对于 `plan` agent，生成的计划会被写入 `.opencode/plans/<timestamp>-<slug>.md`（`plan` agent 的权限集允许写入此位置）。
6. 完成计划后，`plan_exit` 权限允许 agent 请求切换到 `build` agent 去实现计划。

示例提示模板（推荐模式）：

```text
Please create a detailed implementation plan for adding a payment integration. Use the "plan-templates" skill and save the plan to .opencode/plans/payment-integration.md. Do not write code — only the plan.
```

或更简略的形式，让 agent 自行检测 skill：

```text
Plan: Add payment integration. Produce steps, tests, and files to create. Save plan to .opencode/plans/payment-integration.md.
```

## 集成：Plan → Build 工作流

- 常见工作流：
  1. 使用 `plan` agent（该 agent 除计划文件外不会编辑其他代码）来调研并撰写计划。
  2. 与用户一起审阅计划；若接受，调用 `plan_exit` 请求切换到 `build` agent。
  3. 切换到 `build` agent，`build` agent 拥有更宽泛的 `edit` 权限，可以实现计划（创建文件、运行脚本、修改代码）。

- 代码库中包含演示该工作流的示例与测试（参见 `packages/opencode/test-kimi-execution.ts`，它是一个真实的测试用例框架）。

## 安全与权限注意事项

- Skills 可能包含任意文件与脚本。加载 skill 会将其内容注入会话，这带来潜在的安全风险。

- `skill` 工具在加载前会明确请求许可：`ctx.ask({ permission: 'skill', patterns: [params.name], always: [params.name], ... })`。

- 对 agent 的默认权限模型：
  - 外部目录资源通常需要 `ask`（或对于白名单目录可 `allow`）。
  - `plan` agent 被设计为限制型：`edit` 默认拒绝，除非是计划文件相关路径。

- Skill 发现过程会遵循白名单配置并在解析失败时记录日志。

## 故障排查与测试建议

- 如果 skill 未被发现：
  - 确认 `SKILL.md` 存在并且以 YAML frontmatter 开头，包含 `name` 与 `description`。
  - 将 skill 放在支持的目录之一：`.opencode/skill`、`.opencode/skills`、`.claude/skills`、`.agents/skills`，或将路径添加到 `cfg.skills.paths`。

- 如果 `skill` 工具未返回文件或返回空内容块：
  - 检查 `SKILL.md` 内容是否合法，frontmatter 是否缺失（解析失败会导致 loader 跳过该 skill）。
  - 查看 Skill 模块的日志 —— 解析错误会有提示信息。

- 本地测试：
  - 在一个临时项目目录下创建 `.opencode/skill/<name>/SKILL.md`，然后运行会话测试或通过 CLI 会话使用 `skill` 工具加载它。
  - 仓库中的单元测试覆盖 skill 发现（参见 `packages/opencode/test/skill/skill.test.ts`）。

## 示例：可直接使用的 plan skill（SKILL.md）

下面是一个可直接放入 `.opencode/skills/plan-skill/SKILL.md` 的 `SKILL.md` 示例：

```md
---
name: plan-skill
description: Planning templates and checklists to help the plan agent produce structured, actionable plans.
---

# Plan Skill: templates and examples

## Overview
This skill contains templates and sample plans to help the model produce consistent, reviewable plans.

## Template: implementation-plan.md

### Problem
Describe the problem or feature request.

### Goal
State clear success criteria.

### Constraints
List constraints (time, backward-compatibility, API limits).

### Tasks
- Task 1: Describe and owner
- Task 2: Describe and estimate

### Acceptance
- Tests or manual verification steps.

## Example Plan: add-search-endpoint

Problem: Add a /search endpoint to query items.

Goal: ...

Steps:
- Design API
- Implement route
- Add tests

## Templates and scripts
- `templates/implementation-plan.md` — filled by the model
- `scripts/ci-checklist.sh` — optional helper script

## Usage notes
When asked for a plan, models should pick the `implementation-plan.md` template and write the filled plan to `.opencode/plans/<timestamp>-<slug>.md`.

```

## 最后说明

Skills 是一种轻量且强大的机制，可向模型提供策划好的领域知识和模板。结合 `plan` agent 的限制型编辑策略与 `plan → build` 工作流，能以安全、可审计的方式让模型产出计划，并在获得明确批准后再修改代码。

如果你希望，我可以：
- 在仓库中添加一个示例 skill 目录（`packages/opencode/skills/` 下的示例文件），或
- 生成一个简单的测试套件，展示如何加载并使用该计划 skill。

---

文档已生成并保存为 `docs/plan-skill.zh.md`。

