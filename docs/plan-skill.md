<!--
Generated documentation: plan skill used by the `plan` agent.
Place in repository docs/ directory as requested by user.
-->
# Plan skill (for the plan agent)

This document explains the "plan" skill and how the OpenCode `plan` agent uses skills to help create, store, and act on plans. It covers discovery, authoring, invocation, permissions, integration patterns (Plan → Build workflow), security considerations, and troubleshooting.

## Overview

- What is a "skill"?
  - A skill is a directory that contains a `SKILL.md` file (Markdown with YAML frontmatter) and optionally bundled resources (scripts, templates, references).
  - Skills provide domain-specific instructions, workflows, and helper assets that the LLM can load into the conversation context.

- What is the "plan" skill?
  - "Plan" skill is a planning-focused skill or set of skills authors can provide that contain templates, workflows, and examples specifically designed to help the `plan` agent produce high-quality, actionable plans.
  - The `plan` agent uses skills to inject structured guidance (templates, checklists, constraints) into system or assistant prompts so the model can output plans in the desired format and location.

## How skills are discovered and loaded

- Discovery sources (order / locations):
  - Project-local skill directories: `.opencode/skill/` and `.opencode/skills/` (both supported).
  - Claude/Agents-compatible directories: `.claude/skills/` and `.agents/skills/`.
  - Configured skill paths in your opencode config (`cfg.skills.paths`). Paths may be absolute or relative to the project directory.
  - Remote skill URLs configured in `cfg.skills.urls` and pulled via the discovery mechanism.
  - Global user directories under the user home (e.g. `~/.claude/skills`, `~/.agents/skills`).

- Implementation notes (for maintainers):
  - Skills are detected by scanning for `SKILL.md` files (see `src/skill/index.ts`).
  - The skill loader parses YAML frontmatter and exposes `Skill.Info` objects with `{ name, description, location, content }`.
  - `Skill.fmt(list, { verbose })` formats the available skills for inclusion in tool descriptions or system prompts.

## What the Skill tool returns

- The `skill` tool (Tool id: `skill`) is the LLM-invokable tool to load a skill during a session.
- When invoked it accepts `{ name: string }` and returns an object that includes:
  - `title`: a short title like `Loaded skill: <name>`
  - `output`: a string that contains a `<skill_content name="...">` block with the skill's markdown content and a sampled `<skill_files>` list containing a small set of paths in XML-like tags.
  - `metadata`: object `{ name, dir }` where `dir` is the skill directory.

- Example of returned output (structure):

```xml
<skill_content name="example-plan-skill">
# Skill: example-plan-skill

... (SKILL.md content here) ...

Base directory for this skill: file:///.../path/to/skill/

<skill_files>
<file>/abs/path/to/skill/template.md</file>
<file>/abs/path/to/skill/scripts/generate.sh</file>
 ...
</skill_files>
</skill_content>
```

- Sampling limit: when returning the files list, the implementation samples up to 10 files from the skill directory (see `src/tool/skill.ts`, `limit = 10`).

## Permission interaction with the `plan` agent

- The `plan` agent has a tailored permission ruleset that is intentionally restrictive:
  - `edit` is denied for all general files but allowed for plan locations:
    - `.opencode/plans/*.md` (project-local plans) and the global plans directory under `Global.Path.data/plans`.
  - `plan_enter` and `plan_exit` are special permissions used to control switching into/out of plan mode.
  - `question` is typically allowed so the plan agent can ask clarifying questions.

- Skill loading requires asking the user for permission to load that skill in the current session. The `skill` tool calls `ctx.ask({ permission: 'skill', patterns: [params.name], always: [params.name], ... })` before returning content. This ensures the user (or host policy) consents to the skill being injected.

## Where plan files live

- Plan files are written to either:
  - Project worktree: `<project>/.opencode/plans/<timestamp>-<slug>.md` when the project is a git repo (or when working in a worktree).
  - Global plans directory: `<Global.Path.data>/plans/<timestamp>-<slug>.md` when no project worktree is present.

- Use `Session.plan({ slug, time })` helper to compute the canonical path.

## How to author a planning-focused SKILL.md

The typical `SKILL.md` is a Markdown document with YAML frontmatter. At minimum, frontmatter must include:

```yaml
---
name: my-plan-skill
description: Templates and workflows to produce structured implementation plans
---
```

Recommended structure inside the Markdown content:

- Title and short intro
- When to use this skill (scenarios)
- Plan templates (markdown snippets you expect the model to emit), e.g.:
  - Problem statement
  - Goals (success criteria)
  - Constraints
  - Step-by-step tasks
  - Acceptance criteria and tests
- Example plan(s)
- Files and templates (paths relative to skill base, e.g. `templates/plan-template.md`)
- Scripts or helper commands (in `scripts/`)

Best practices:
- Keep guidance prescriptive and structured (models follow explicit patterns well).
- Provide one or more ready-to-fill templates the model can copy into `.opencode/plans/`.
- Provide examples of expected file names and folder layout.
- Use relative paths in examples and mention that they are relative to the skill base directory.

### Minimal SKILL.md example

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

Place auxiliary resources under `templates/` or `scripts/` in the same skill directory.
```

### Advanced SKILL.md example (with templates and usage notes)

Include another fenced example showing `templates/plan.md` content and a sample script layout.

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

Notes:
- Keep template placeholders explicit like `{{goal}}` to make it easy for the model to substitute.

```

## Invoking and using the skill from a session

Typical flow when the user asks for a plan:

1. User asks: "Please make an implementation plan for X and save it as a plan file."
2. The model recognizes a matching skill and calls the `skill` tool with `{ name: '<skill-name>' }`.
3. The `skill` tool asks for permission and returns the skill content and a sampled file list.
4. The model uses the skill content (templates, examples) to generate a plan.
5. With the `plan` agent, the generated plan is written to `.opencode/plans/<timestamp>-<slug>.md` (allowed by the `plan` agent permission set).
6. When planning is finished, `plan_exit` permission lets the agent request to switch back to the `build` agent to implement the plan.

Example prompt patterns that work well:

```text
Please create a detailed implementation plan for adding a payment integration. Use the "plan-templates" skill and save the plan to .opencode/plans/payment-integration.md. Do not write code — only the plan.
```

Or shorter, letting the agent detect the skill:

```text
Plan: Add payment integration. Produce steps, tests, and files to create. Save plan to .opencode/plans/payment-integration.md.
```

## Integration: Plan → Build workflow

- Common workflow:
  1. Use the `plan` agent (it will not edit code except allowed plan files) to research and write a plan.
 2. Review the plan with the user; if accepted, call `plan_exit` to request switching to the `build` agent.
 3. Switch to `build` agent which has broader `edit` permissions and can implement the plan (create files, run scripts, edit code).

- The codebase includes examples and tests demonstrating this workflow (see `packages/opencode/test-kimi-execution.ts` for a real-world test harness).

## Security and permission considerations

- Skills can contain arbitrary files and scripts. Loading a skill injects its content into the conversation, which has security implications.

- The `skill` tool explicitly asks for permission before loading, via `ctx.ask({ permission: 'skill', patterns: [params.name], always: [params.name], ... })`.

- Default permission model for agents:
  - `external_directory` resources are generally `ask` (or `allow` for whitelisted skill dirs).
  - `plan` agent is intentionally restrictive: `edit` is denied except for plan files.

- Skill discovery respects configured whitelisted directories and will log missing or invalid `SKILL.md` files.

## Troubleshooting and testing tips

- If your skill is not discovered:
  - Ensure `SKILL.md` exists and begins with YAML frontmatter containing `name` and `description`.
  - Put the skill under one of the supported directories: `.opencode/skill`, `.opencode/skills`, `.claude/skills`, `.agents/skills`, or add a path to `cfg.skills.paths`.

- If the `skill` tool fails to return files or returns an empty content block:
  - Check that `SKILL.md` content is valid and not missing frontmatter (invalid frontmatter is skipped by the loader).
  - Review logs for `Skill` module errors — they emit helpful messages when parsing fails.

- Testing locally:
  - Create a temporary project directory with `.opencode/skill/<name>/SKILL.md` and run session tests or use the `skill` tool via the CLI session to load it.
  - Unit tests in the repo exercise skill discovery (see `packages/opencode/test/skill/skill.test.ts`).

## Example: full sample SKILL.md for a plan skill

This is a ready-to-drop `SKILL.md` you can use or adapt. Place it under `.opencode/skills/plan-skill/SKILL.md`.

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

## Final notes

Skills are a lightweight, powerful mechanism to provide the model with curated domain knowledge and templates. When combined with the `plan` agent's restrictive edit policy and the `plan → build` workflow, they enable a safe, auditable way to let models produce plans and only modify code when explicitly approved.

If you want, I can:
- Add a concrete sample skill directory under `packages/opencode/skills/` in this repo (example files), or
- Generate a small test harness that demonstrates loading and using the sample plan skill.

---

Document generated and saved to `docs/plan-skill.md`.

