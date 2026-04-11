// 导入 Bun 测试框架的工具函数
import { afterEach, test, expect } from "bun:test"
// 导入 Skill 模块，用于技能发现和加载
import { Skill } from "../../src/skill"
// 导入 Instance 模块，管理项目上下文和生命周期
import { Instance } from "../../src/project/instance"
// 导入临时目录工具，创建隔离的测试环境
import { tmpdir } from "../fixture/fixture"
// 导入路径处理模块
import path from "path"
// 导入文件系统模块（异步版本）
import fs from "fs/promises"

/**
 这个测试文件采用了分层测试策略：
 测试目标：Skill 模块的技能发现功能
 ├── 本地项目技能
 │   ├── .opencode/skill/ （单数）
 │   ├── .opencode/skills/ （复数）
 │   ├── .claude/skills/ （Claude 兼容）
 │   └── .agents/skills/ （Agents 兼容）
 ├── 全局用户技能
 │   ├── ~/.claude/skills/
 │   └── ~/.agents/skills/
 └── 边界情况
 ├── 无技能文件
 ├── 无效的 frontmatter
 └── 重复的技能名称

 */
/**
 * 每个测试结束后清理所有 Instance 实例
 *
 * 确保测试之间的状态隔离，防止一个测试的 Instance
 * 影响另一个测试的结果。
 */
afterEach(async () => {
  await Instance.disposeAll()
})

/**
 * 辅助函数：在指定的主目录中创建全局技能
 *
 * 模拟用户在全局 ~/.claude/skills/ 目录下安装的技能。
 *
 * @param homeDir - 测试用的主目录路径（通常是临时目录）
 * @returns Promise<void>
 *
 * 目录结构：
 * {homeDir}/.claude/skills/global-test-skill/SKILL.md
 */
async function createGlobalSkill(homeDir: string) {
  // 构建技能目录的完整路径
  const skillDir = path.join(homeDir, ".claude", "skills", "global-test-skill")
  // 递归创建目录（如果不存在）
  await fs.mkdir(skillDir, { recursive: true })

  // 写入 SKILL.md 文件，包含 YAML frontmatter 和 Markdown 内容
  await Bun.write(
    path.join(skillDir, "SKILL.md"),
    `---
name: global-test-skill                    # 技能名称（必需）
description: A global skill from ~/.claude/skills for testing.  # 技能描述（必需）
---

# Global Test Skill

This skill is loaded from the global home directory.
`,
  )
}

/**
 * 测试：从 .opencode/skill/ 目录发现技能
 *
 * 验证 OpenCode 能够从项目的 .opencode/skill/ 目录中
 * 自动发现并加载技能文件。
 *
 * 目录结构：
 * {tmp}/.opencode/skill/test-skill/SKILL.md
 */
test.only("discovers skills from .opencode/skill/ directory", async () => {
  // 创建临时 Git 仓库，并在初始化时创建技能文件
    await using tmp = await tmpdir({
      git: true,  // 初始化为 Git 仓库
      init: async (dir) => {
        // 构建技能目录路径
        const skillDir = path.join(dir, ".opencode", "skill", "test-skill")

        // 写入 SKILL.md 文件
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: test-skill                           # 技能唯一标识符
description: A test skill for verification.  # 技能的简短描述
---

# Test Skill

Instructions here.
`,
        )
      },
    })

  // 在临时目录的项目上下文中执行测试
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // 获取所有已发现的技能
      const skills = await Skill.all()

      // 验证只发现了 1 个技能
      expect(skills.length).toBe(1)

      // 查找名为 "test-skill" 的技能
      const testSkill = skills.find((s) => s.name === "test-skill")

      // 验证技能存在
      expect(testSkill).toBeDefined()

      // 验证技能描述正确
      expect(testSkill!.description).toBe("A test skill for verification.")

      // 验证技能位置包含正确的路径片段
      expect(testSkill!.location).toContain(path.join("skill", "test-skill", "SKILL.md"))
    },
  })
})

/**
 * 测试：Skill.dirs 返回技能目录列表
 *
 * 验证 Skill.dirs() 方法能够正确返回所有包含技能的目录路径，
 * 这对于了解技能的来源非常有用。
 */
test("returns skill directories from Skill.dirs", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        // 创建一个技能目录
        const skillDir = path.join(dir, ".opencode", "skill", "dir-skill")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: dir-skill
description: Skill for dirs test.
---

# Dir Skill
`,
        )
      },
    })

  // 保存原始的 OPENCODE_TEST_HOME 环境变量
  const home = process.env.OPENCODE_TEST_HOME
  // 将测试临时目录设置为主目录，模拟全局技能搜索
  process.env.OPENCODE_TEST_HOME = tmp.path

  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // 获取所有技能所在的目录列表
        const dirs = await Skill.dirs()

        // 计算预期的技能目录路径
        const skillDir = path.join(tmp.path, ".opencode", "skill", "dir-skill")

        // 验证返回的目录列表中包含该技能目录
        expect(dirs).toContain(skillDir)

        // 验证只有一个技能目录
        expect(dirs.length).toBe(1)
      },
    })
  } finally {
    // 恢复原始的环境变量，避免影响其他测试
    process.env.OPENCODE_TEST_HOME = home
  }
})

/**
 * 测试：从 .opencode/skill/ 目录发现多个技能
 *
 * 验证系统能够同时发现并加载同一目录下的多个技能，
 * 并且不会相互覆盖或遗漏。
 */
test("discovers multiple skills from .opencode/skill/ directory", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        // 创建两个不同的技能目录
        const skillDir1 = path.join(dir, ".opencode", "skill", "skill-one")
        const skillDir2 = path.join(dir, ".opencode", "skill", "skill-two")

        // 写入第一个技能文件
        await Bun.write(
          path.join(skillDir1, "SKILL.md"),
          `---
name: skill-one
description: First test skill.
---

# Skill One
`,
        )

        // 写入第二个技能文件
        await Bun.write(
          path.join(skillDir2, "SKILL.md"),
          `---
name: skill-two
description: Second test skill.
---

# Skill Two
`,
        )
      },
    })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // 获取所有技能
      const skills = await Skill.all()

      // 验证发现了 2 个技能
      expect(skills.length).toBe(2)

      // 验证两个技能都存在
      expect(skills.find((s) => s.name === "skill-one")).toBeDefined()
      expect(skills.find((s) => s.name === "skill-two")).toBeDefined()
    },
  })
})

/**
 * 测试：跳过缺少 frontmatter 的技能文件
 *
 * 验证当 SKILL.md 文件缺少必需的 YAML frontmatter 时，
 * 系统会优雅地跳过该文件，而不是抛出错误。
 *
 * 这是一个重要的容错机制，防止无效的技能文件破坏整个系统。
 */
test("skips skills with missing frontmatter", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".opencode", "skill", "no-frontmatter")

        // 写入没有 frontmatter 的文件（只有纯 Markdown 内容）
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `# No Frontmatter

Just some content without YAML frontmatter.
`,
        )
      },
    })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // 获取所有技能
      const skills = await Skill.all()

      // 验证返回空数组（无效技能被跳过）
      expect(skills).toEqual([])
    },
  })
})

/**
 * 测试：从 .claude/skills/ 目录发现技能
 *
 * 验证系统兼容 Claude Code 的技能目录结构，
 * 允许用户迁移现有的 Claude 技能到 OpenCode。
 *
 * 目录结构：
 * {tmp}/.claude/skills/claude-skill/SKILL.md
 */
test("discovers skills from .claude/skills/ directory", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        // 使用 .claude/skills/ 目录结构（Claude Code 兼容）
        const skillDir = path.join(dir, ".claude", "skills", "claude-skill")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
        )
      },
    })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()

      // 验证发现了 1 个技能
      expect(skills.length).toBe(1)

      const claudeSkill = skills.find((s) => s.name === "claude-skill")
      expect(claudeSkill).toBeDefined()

      // 验证技能位置包含 .claude/skills 路径
      expect(claudeSkill!.location).toContain(path.join(".claude", "skills", "claude-skill", "SKILL.md"))
    },
  })
})

/**
 * 测试：从全局 ~/.claude/skills/ 目录发现技能
 *
 * 验证系统能够从用户的全家主目录中加载全局技能，
 * 这些技能对所有项目都可用。
 *
 * 这是模拟真实场景中用户在全局安装的共享技能。
 */
test("discovers global skills from ~/.claude/skills/ directory", async () => {
    await using tmp = await tmpdir({ git: true })

  // 保存原始的主目录配置
  const originalHome = process.env.OPENCODE_TEST_HOME
  // 将临时目录设置为主目录，隔离测试环境
  process.env.OPENCODE_TEST_HOME = tmp.path

  try {
    // 在临时"主目录"中创建全局技能
    await createGlobalSkill(tmp.path)

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = await Skill.all()

        // 验证发现了 1 个全局技能
        expect(skills.length).toBe(1)
        expect(skills[0].name).toBe("global-test-skill")
        expect(skills[0].description).toBe("A global skill from ~/.claude/skills for testing.")

        // 验证技能位置指向全局目录
        expect(skills[0].location).toContain(path.join(".claude", "skills", "global-test-skill", "SKILL.md"))
      },
    })
  } finally {
    // 恢复原始的主目录配置
    process.env.OPENCODE_TEST_HOME = originalHome
  }
})

/**
 * 测试：当没有任何技能时返回空数组
 *
 * 验证在没有技能文件的干净环境中，系统能够正常返回空数组，
 * 而不是抛出错误或返回 undefined。
 */
test("returns empty array when no skills exist", async () => {
    await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()

      // 验证返回空数组
      expect(skills).toEqual([])
    },
  })
})

/**
 * 测试：从 .agents/skills/ 目录发现技能
 *
 * 验证系统支持另一种常见的技能目录结构 .agents/skills/，
 * 提供更大的灵活性和兼容性。
 */
test("discovers skills from .agents/skills/ directory", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        // 使用 .agents/skills/ 目录结构
        const skillDir = path.join(dir, ".agents", "skills", "agent-skill")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: agent-skill
description: A skill in the .agents/skills directory.
---

# Agent Skill
`,
        )
      },
    })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()

      // 验证发现了 1 个技能
      expect(skills.length).toBe(1)

      const agentSkill = skills.find((s) => s.name === "agent-skill")
      expect(agentSkill).toBeDefined()

      // 验证技能位置包含 .agents/skills 路径
      expect(agentSkill!.location).toContain(path.join(".agents", "skills", "agent-skill", "SKILL.md"))
    },
  })
})

/**
 * 测试：从全局 ~/.agents/skills/ 目录发现技能
 *
 * 类似于全局 .claude/skills/ 测试，但使用 .agents/skills/ 路径。
 * 验证两种全局技能路径都能正常工作。
 */
test("discovers global skills from ~/.agents/skills/ directory", async () => {
    await using tmp = await tmpdir({ git: true })

  const originalHome = process.env.OPENCODE_TEST_HOME
  process.env.OPENCODE_TEST_HOME = tmp.path

  try {
    // 在全局 .agents/skills/ 目录中创建技能
    const skillDir = path.join(tmp.path, ".agents", "skills", "global-agent-skill")
    await fs.mkdir(skillDir, { recursive: true })
    await Bun.write(
      path.join(skillDir, "SKILL.md"),
      `---
name: global-agent-skill
description: A global skill from ~/.agents/skills for testing.
---

# Global Agent Skill

This skill is loaded from the global home directory.
`,
    )

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = await Skill.all()

        // 验证发现了 1 个全局技能
        expect(skills.length).toBe(1)
        expect(skills[0].name).toBe("global-agent-skill")
        expect(skills[0].description).toBe("A global skill from ~/.agents/skills for testing.")
        expect(skills[0].location).toContain(path.join(".agents", "skills", "global-agent-skill", "SKILL.md"))
      },
    })
  } finally {
    process.env.OPENCODE_TEST_HOME = originalHome
  }
})

/**
 * 测试：同时从 .claude/skills/ 和 .agents/skills/ 发现技能
 *
 * 验证系统能够合并来自不同目录结构的技能，
 * 用户可以混合使用多种技能组织方式。
 */
test("discovers skills from both .claude/skills/ and .agents/skills/", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        // 创建两个不同目录结构中的技能
        const claudeDir = path.join(dir, ".claude", "skills", "claude-skill")
        const agentDir = path.join(dir, ".agents", "skills", "agent-skill")

        // 写入 .claude/skills/ 中的技能
        await Bun.write(
          path.join(claudeDir, "SKILL.md"),
          `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
        )

        // 写入 .agents/skills/ 中的技能
        await Bun.write(
          path.join(agentDir, "SKILL.md"),
          `---
name: agent-skill
description: A skill in the .agents/skills directory.
---

# Agent Skill
`,
        )
      },
    })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()

      // 验证发现了 2 个技能（来自不同目录）
      expect(skills.length).toBe(2)
      expect(skills.find((s) => s.name === "claude-skill")).toBeDefined()
      expect(skills.find((s) => s.name === "agent-skill")).toBeDefined()
    },
  })
})

/**
 * 测试：正确解析技能所在的目录
 *
 * 验证 Skill.dirs() 能够正确识别和返回所有技能所在的目录，
 * 包括：
 * - .opencode/skill/ （单数形式）
 * - .opencode/skills/ （复数形式）
 * - .claude/skills/
 * - .agents/skills/
 *
 * 这确保了系统支持多种目录命名约定。
 */
test("properly resolves directories that skills live in", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        // 创建四种不同目录结构中的技能
        const opencodeSkillDir = path.join(dir, ".opencode", "skill", "agent-skill")     // 单数
        const opencodeSkillsDir = path.join(dir, ".opencode", "skills", "agent-skill")   // 复数
        const claudeDir = path.join(dir, ".claude", "skills", "claude-skill")
        const agentDir = path.join(dir, ".agents", "skills", "agent-skill")

        // 写入四个技能文件
        await Bun.write(
          path.join(claudeDir, "SKILL.md"),
          `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
        )
        await Bun.write(
          path.join(agentDir, "SKILL.md"),
          `---
name: agent-skill
description: A skill in the .agents/skills directory.
---

# Agent Skill
`,
        )
        await Bun.write(
          path.join(opencodeSkillDir, "SKILL.md"),
          `---
name: opencode-skill
description: A skill in the .opencode/skill directory.
---

# OpenCode Skill
`,
        )
        await Bun.write(
          path.join(opencodeSkillsDir, "SKILL.md"),
          `---
name: opencode-skill
description: A skill in the .opencode/skills directory.
---

# OpenCode Skill
`,
        )
      },
    })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // 获取所有技能所在的目录
      const dirs = await Skill.dirs()

      // 验证发现了 4 个不同的目录
      expect(dirs.length).toBe(4)
    },
  })
})
