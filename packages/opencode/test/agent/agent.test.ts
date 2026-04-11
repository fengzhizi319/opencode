/**
 * Agent 模块单元测试文件
 * 
 * 测试目标：验证 Agent 系统的核心功能
 * - 内置 Agent 的默认配置和权限
 * - 自定义 Agent 的创建和配置覆盖
 * - Agent 权限规则的合并与评估
 * - 默认 Agent 的选择逻辑
 * - Agent 的启用/禁用机制
 */
import { afterEach, test, expect } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "@/project/instance.ts"
import { Agent } from "@/agent/agent.ts"
import { Permission } from "@/permission"
// import { Instance } from "../../src/project/instance"
// import { Agent } from "../../src/agent/agent"
// import { Permission } from "../../src/permission"

/**
 * 辅助函数：评估 Agent 对某个工具的权限（使用通配符模式）
 * 
 * @param agent - Agent 信息对象
 * @param permission - 工具名称（如 "edit", "bash", "read"）
 * @returns 权限动作："allow" | "deny" | "ask" | undefined
 * 
 * 用途：简化测试代码，避免重复编写 Permission.evaluate 调用
 */
function evalPerm(agent: Agent.Info | undefined, permission: string): Permission.Action | undefined {
  if (!agent) return undefined
  // 使用通配符 "*" 评估通用权限规则
  return Permission.evaluate(permission, "*", agent.permission).action
}

/**
 * 测试清理：每个测试用例执行后销毁所有 Instance
 * 确保测试之间的隔离性，避免状态污染
 */
afterEach(async () => {
  await Instance.disposeAll()
})

/**
 * 测试用例1：无配置时返回默认的内置 Agent 列表
 * 
 * 测试目的：
 * - 验证在没有用户配置的情况下，系统会加载所有内置 Agent
 * - 确保核心 Agent（build、plan、explore 等）都存在
 * 
 * 预期结果：
 * - 包含 7 个内置 Agent：build, plan, general, explore, compaction, title, summary
 */
test("returns default native agents when no config", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agents = await Agent.list()
      const names = agents.map((a) => a.name)
      expect(names).toContain("build")
      expect(names).toContain("plan")
      expect(names).toContain("general")
      expect(names).toContain("explore")
      expect(names).toContain("compaction")
      expect(names).toContain("title")
      expect(names).toContain("summary")
    },
  })
})

/**
 * 测试用例2：build Agent 具有正确的默认属性
 * 
 * 测试目的：
 * - 验证 build Agent（默认 Agent）的基本配置
 * - 确认其权限设置允许编辑和执行命令
 * 
 * 预期结果：
 * - mode: "primary"（可以作为主 Agent）
 * - native: true（内置 Agent）
 * - edit: allow（允许编辑文件）
 * - bash: allow（允许执行命令）
 */
test("build agent has correct default properties", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(build).toBeDefined()
      expect(build?.mode).toBe("primary")
      expect(build?.native).toBe(true)
      expect(evalPerm(build, "edit")).toBe("allow")
      expect(evalPerm(build, "bash")).toBe("allow")
    },
  })
})

/**
 * 测试用例3：plan Agent 拒绝所有编辑操作，除了 .opencode/plans/* 路径
 * 
 * 测试目的：
 * - 验证 plan Agent 的权限限制（只能规划，不能修改代码）
 * - 确认例外规则：允许写入计划文件
 * 
 * 预期结果：
 * - 通配符编辑：deny（禁止编辑所有文件）
 * - 特定路径编辑：allow（允许编辑 .opencode/plans/*.md）
 */
test("plan agent denies edits except .opencode/plans/*", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const plan = await Agent.get("plan")
      expect(plan).toBeDefined()
      // 通配符被拒绝
      expect(evalPerm(plan, "edit")).toBe("deny")
      // 但特定路径被允许
      expect(Permission.evaluate("edit", ".opencode/plans/foo.md", plan!.permission).action).toBe("allow")
    },
  })
})

/**
 * 测试用例4：explore Agent 拒绝编辑和写入操作
 * 
 * 测试目的：
 * - 验证 explore Agent 作为只读 Agent 的权限限制
 * - 确认其不能修改任何文件或任务列表
 * 
 * 预期结果：
 * - mode: "subagent"（只能作为子 Agent）
 * - edit: deny（禁止编辑）
 * - write: deny（禁止写入）
 * - todowrite: deny（禁止写入 Todo）
 */
test("explore agent denies edit and write", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const explore = await Agent.get("explore")
      expect(explore).toBeDefined()
      expect(explore?.mode).toBe("subagent")
      expect(evalPerm(explore, "edit")).toBe("deny")
      expect(evalPerm(explore, "write")).toBe("deny")
      expect(evalPerm(explore, "todowrite")).toBe("deny")
    },
  })
})

/**
 * 测试用例5：explore Agent 对外部目录询问权限，但允许 Truncate.GLOB
 * 
 * 测试目的：
 * - 验证 explore Agent 访问外部目录时的权限行为
 * - 确认 Truncate.GLOB（截断工具的通配符）被特殊允许
 * 
 * 背景：
 * - Truncate.GLOB 是上下文截断工具需要的特殊路径模式
 * - 即使 explore 是只读 Agent，也需要读取截断相关文件
 * 
 * 预期结果：
 * - 任意外部路径：ask（询问用户）
 * - Truncate.GLOB：allow（自动允许）
 */
test("explore agent asks for external directories and allows Truncate.GLOB", async () => {
  const { Truncate } = await import("../../src/tool/truncate")
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const explore = await Agent.get("explore")
      expect(explore).toBeDefined()
      expect(Permission.evaluate("external_directory", "/some/other/path", explore!.permission).action).toBe("ask")
      expect(Permission.evaluate("external_directory", Truncate.GLOB, explore!.permission).action).toBe("allow")
    },
  })
})

/**
 * 测试用例6：general Agent 拒绝 Todo 工具
 * 
 * 测试目的：
 * - 验证 general Agent 不能使用 todowrite 工具
 * - 防止子 Agent 创建嵌套的 Todo 列表
 * 
 * 预期结果：
 * - mode: "subagent"（子 Agent 模式）
 * - hidden: undefined（不隐藏）
 * - todowrite: deny（禁止写入 Todo）
 */
test("general agent denies todo tools", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const general = await Agent.get("general")
      expect(general).toBeDefined()
      expect(general?.mode).toBe("subagent")
      expect(general?.hidden).toBeUndefined()
      expect(evalPerm(general, "todowrite")).toBe("deny")
    },
  })
})

/**
 * 测试用例7：compaction Agent 拒绝所有权限
 * 
 * 测试目的：
 * - 验证 compaction Agent（压缩 Agent）没有任何工具权限
 * - 确保它只能读取消息历史进行压缩，不能执行任何操作
 * 
 * 预期结果：
 * - hidden: true（UI 中隐藏）
 * - bash: deny
 * - edit: deny
 * - read: deny（甚至不能读取文件）
 */
test("compaction agent denies all permissions", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const compaction = await Agent.get("compaction")
      expect(compaction).toBeDefined()
      expect(compaction?.hidden).toBe(true)
      expect(evalPerm(compaction, "bash")).toBe("deny")
      expect(evalPerm(compaction, "edit")).toBe("deny")
      expect(evalPerm(compaction, "read")).toBe("deny")
    },
  })
})

/**
 * 测试用例8：从配置创建自定义 Agent
 * 
 * 测试目的：
 * - 验证用户可以通过配置文件创建新的 Agent
 * - 确认自定义 Agent 的属性正确设置
 * 
 * 配置示例：
 * ```json
 * {
 *   "agent": {
 *     "my_custom_agent": {
 *       "model": "openai/gpt-4",
 *       "description": "My custom agent",
 *       "temperature": 0.5,
 *       "top_p": 0.9
 *     }
 *   }
 * }
 * ```
 * 
 * 预期结果：
 * - model: openai/gpt-4
 * - native: false（非内置）
 * - mode: "all"（默认模式）
 */
test("custom agent from config creates new agent", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        my_custom_agent: {
          model: "openai/gpt-4",
          description: "My custom agent",
          temperature: 0.5,
          top_p: 0.9,
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const custom = await Agent.get("my_custom_agent")
      expect(custom).toBeDefined()
      expect(String(custom?.model?.providerID)).toBe("openai")
      expect(String(custom?.model?.modelID)).toBe("gpt-4")
      expect(custom?.description).toBe("My custom agent")
      expect(custom?.temperature).toBe(0.5)
      expect(custom?.topP).toBe(0.9)
      expect(custom?.native).toBe(false)
      expect(custom?.mode).toBe("all")
    },
  })
})

/**
 * 测试用例9：自定义配置覆盖内置 Agent 属性
 * 
 * 测试目的：
 * - 验证用户可以修改内置 Agent 的配置
 * - 确认覆盖后的属性生效，但 native 标志保持不变
 * 
 * 配置示例：
 * ```json
 * {
 *   "agent": {
 *     "build": {
 *       "model": "anthropic/claude-3",
 *       "description": "Custom build agent",
 *       "temperature": 0.7,
 *       "color": "#FF0000"
 *     }
 *   }
 * }
 * ```
 * 
 * 预期结果：
 * - model 被覆盖为 anthropic/claude-3
 * - description、temperature、color 被覆盖
 * - native: true（仍然是内置 Agent）
 */
test("custom agent config overrides native agent properties", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: {
          model: "anthropic/claude-3",
          description: "Custom build agent",
          temperature: 0.7,
          color: "#FF0000",
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(build).toBeDefined()
      expect(String(build?.model?.providerID)).toBe("anthropic")
      expect(String(build?.model?.modelID)).toBe("claude-3")
      expect(build?.description).toBe("Custom build agent")
      expect(build?.temperature).toBe(0.7)
      expect(build?.color).toBe("#FF0000")
      expect(build?.native).toBe(true)
    },
  })
})

/**
 * 测试用例10：禁用 Agent 会将其从列表中移除
 * 
 * 测试目的：
 * - 验证用户可以通过配置禁用不需要的 Agent
 * - 确认禁用的 Agent 无法通过 get() 获取，也不在 list() 中
 * 
 * 配置示例：
 * ```json
 * {
 *   "agent": {
 *     "explore": { "disable": true }
 *   }
 * }
 * ```
 * 
 * 预期结果：
 * - Agent.get("explore") 返回 undefined
 * - Agent.list() 不包含 "explore"
 */
test("agent disable removes agent from list", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        explore: { disable: true },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const explore = await Agent.get("explore")
      expect(explore).toBeUndefined()
      const agents = await Agent.list()
      const names = agents.map((a) => a.name)
      expect(names).not.toContain("explore")
    },
  })
})

/**
 * 测试用例11：Agent 权限配置与默认值合并
 * 
 * 测试目的：
 * - 验证用户配置的权限规则会与默认规则合并
 * - 确认特定模式的权限覆盖通配符规则
 * 
 * 配置示例：
 * ```json
 * {
 *   "agent": {
 *     "build": {
 *       "permission": {
 *         "bash": {
 *           "rm -rf *": "deny"
 *         }
 *       }
 *     }
 *   }
 * }
 * ```
 * 
 * 预期结果：
 * - bash "rm -rf *": deny（特定模式被拒绝）
 * - edit: allow（其他工具仍允许）
 */
test("agent permission config merges with defaults", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: {
          permission: {
            bash: {
              "rm -rf *": "deny",
            },
          },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(build).toBeDefined()
      // 特定模式被拒绝
      expect(Permission.evaluate("bash", "rm -rf *", build!.permission).action).toBe("deny")
      // Edit 仍然允许
      expect(evalPerm(build, "edit")).toBe("allow")
    },
  })
})

/**
 * 测试用例12：全局权限配置应用到所有 Agent
 * 
 * 测试目的：
 * - 验证全局 permission 配置会影响所有 Agent
 * - 确认全局规则的优先级高于 Agent 默认规则
 * 
 * 配置示例：
 * ```json
 * {
 *   "permission": {
 *     "bash": "deny"
 *   }
 * }
 * ```
 * 
 * 预期结果：
 * - 即使 build Agent 默认允许 bash，全局配置也会拒绝
 */
test("global permission config applies to all agents", async () => {
  await using tmp = await tmpdir({
    config: {
      permission: {
        bash: "deny",
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(build).toBeDefined()
      expect(evalPerm(build, "bash")).toBe("deny")
    },
  })
})

test("agent steps/maxSteps config sets steps property", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: { steps: 50 },
        plan: { maxSteps: 100 },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      const plan = await Agent.get("plan")
      expect(build?.steps).toBe(50)
      expect(plan?.steps).toBe(100)
    },
  })
})

test("agent mode can be overridden", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        explore: { mode: "primary" },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const explore = await Agent.get("explore")
      expect(explore?.mode).toBe("primary")
    },
  })
})

test("agent name can be overridden", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: { name: "Builder" },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(build?.name).toBe("Builder")
    },
  })
})

test("agent prompt can be set from config", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: { prompt: "Custom system prompt" },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(build?.prompt).toBe("Custom system prompt")
    },
  })
})

test("unknown agent properties are placed into options", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: {
          random_property: "hello",
          another_random: 123,
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(build?.options.random_property).toBe("hello")
      expect(build?.options.another_random).toBe(123)
    },
  })
})

test("agent options merge correctly", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: {
          options: {
            custom_option: true,
            another_option: "value",
          },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(build?.options.custom_option).toBe(true)
      expect(build?.options.another_option).toBe("value")
    },
  })
})

test("multiple custom agents can be defined", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        agent_a: {
          description: "Agent A",
          mode: "subagent",
        },
        agent_b: {
          description: "Agent B",
          mode: "primary",
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agentA = await Agent.get("agent_a")
      const agentB = await Agent.get("agent_b")
      expect(agentA?.description).toBe("Agent A")
      expect(agentA?.mode).toBe("subagent")
      expect(agentB?.description).toBe("Agent B")
      expect(agentB?.mode).toBe("primary")
    },
  })
})

test("Agent.list keeps the default agent first and sorts the rest by name", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "plan",
      agent: {
        zebra: {
          description: "Zebra",
          mode: "subagent",
        },
        alpha: {
          description: "Alpha",
          mode: "subagent",
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const names = (await Agent.list()).map((a) => a.name)
      expect(names[0]).toBe("plan")
      expect(names.slice(1)).toEqual(names.slice(1).toSorted((a, b) => a.localeCompare(b)))
    },
  })
})

test("Agent.get returns undefined for non-existent agent", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const nonExistent = await Agent.get("does_not_exist")
      expect(nonExistent).toBeUndefined()
    },
  })
})

test("default permission includes doom_loop and external_directory as ask", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(evalPerm(build, "doom_loop")).toBe("ask")
      expect(evalPerm(build, "external_directory")).toBe("ask")
    },
  })
})

test("webfetch is allowed by default", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(evalPerm(build, "webfetch")).toBe("allow")
    },
  })
})

test("legacy tools config converts to permissions", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: {
          tools: {
            bash: false,
            read: false,
          },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(evalPerm(build, "bash")).toBe("deny")
      expect(evalPerm(build, "read")).toBe("deny")
    },
  })
})

test("legacy tools config maps write/edit/patch/multiedit to edit permission", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: {
          tools: {
            write: false,
          },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(evalPerm(build, "edit")).toBe("deny")
    },
  })
})

test("Truncate.GLOB is allowed even when user denies external_directory globally", async () => {
  const { Truncate } = await import("../../src/tool/truncate")
  await using tmp = await tmpdir({
    config: {
      permission: {
        external_directory: "deny",
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(Permission.evaluate("external_directory", Truncate.GLOB, build!.permission).action).toBe("allow")
      expect(Permission.evaluate("external_directory", Truncate.DIR, build!.permission).action).toBe("deny")
      expect(Permission.evaluate("external_directory", "/some/other/path", build!.permission).action).toBe("deny")
    },
  })
})

test("Truncate.GLOB is allowed even when user denies external_directory per-agent", async () => {
  const { Truncate } = await import("../../src/tool/truncate")
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: {
          permission: {
            external_directory: "deny",
          },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(Permission.evaluate("external_directory", Truncate.GLOB, build!.permission).action).toBe("allow")
      expect(Permission.evaluate("external_directory", Truncate.DIR, build!.permission).action).toBe("deny")
      expect(Permission.evaluate("external_directory", "/some/other/path", build!.permission).action).toBe("deny")
    },
  })
})

test("explicit Truncate.GLOB deny is respected", async () => {
  const { Truncate } = await import("../../src/tool/truncate")
  await using tmp = await tmpdir({
    config: {
      permission: {
        external_directory: {
          "*": "deny",
          [Truncate.GLOB]: "deny",
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(Permission.evaluate("external_directory", Truncate.GLOB, build!.permission).action).toBe("deny")
      expect(Permission.evaluate("external_directory", Truncate.DIR, build!.permission).action).toBe("deny")
    },
  })
})

test("skill directories are allowed for external_directory", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".opencode", "skill", "perm-skill")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: perm-skill
description: Permission skill.
---

# Permission Skill
`,
      )
    },
  })

  const home = process.env.OPENCODE_TEST_HOME
  process.env.OPENCODE_TEST_HOME = tmp.path

  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const build = await Agent.get("build")
        const skillDir = path.join(tmp.path, ".opencode", "skill", "perm-skill")
        const target = path.join(skillDir, "reference", "notes.md")
        expect(Permission.evaluate("external_directory", target, build!.permission).action).toBe("allow")
      },
    })
  } finally {
    process.env.OPENCODE_TEST_HOME = home
  }
})

/**
 * 测试用例13：defaultAgent 在无配置时返回 build
 * 
 * 测试目的：
 * - 验证默认情况下，build Agent 被选为默认 Agent
 */
test("defaultAgent returns build when no default_agent config", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.defaultAgent()
      expect(agent).toBe("build")
    },
  })
})

/**
 * 测试用例14：defaultAgent 尊重 default_agent 配置（设置为 plan）
 * 
 * 测试目的：
 * - 验证用户可以通过配置更改默认 Agent
 * 
 * 配置示例：
 * ```json
 * {
 *   "default_agent": "plan"
 * }
 * ```
 */
test("defaultAgent respects default_agent config set to plan", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "plan",
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.defaultAgent()
      expect(agent).toBe("plan")
    },
  })
})

test("defaultAgent respects default_agent config set to custom agent with mode all", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "my_custom",
      agent: {
        my_custom: {
          description: "My custom agent",
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.defaultAgent()
      expect(agent).toBe("my_custom")
    },
  })
})

/**
 * 测试用例15：defaultAgent 指向子 Agent 时抛出错误
 * 
 * 测试目的：
 * - 验证不能将 subagent 模式的 Agent 设为默认 Agent
 * - 确保默认 Agent 必须是 primary 或 all 模式
 * 
 * 预期结果：
 * - 抛出错误：'default agent "explore" is a subagent'
 */
test("defaultAgent throws when default_agent points to subagent", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "explore",
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(Agent.defaultAgent()).rejects.toThrow('default agent "explore" is a subagent')
    },
  })
})

/**
 * 测试用例16：defaultAgent 指向隐藏 Agent 时抛出错误
 * 
 * 测试目的：
 * - 验证不能将 hidden Agent 设为默认 Agent
 * - 隐藏的 Agent 是系统内部使用的，不应暴露给用户
 * 
 * 预期结果：
 * - 抛出错误：'default agent "compaction" is hidden'
 */
test("defaultAgent throws when default_agent points to hidden agent", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "compaction",
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(Agent.defaultAgent()).rejects.toThrow('default agent "compaction" is hidden')
    },
  })
})

test("defaultAgent throws when default_agent points to non-existent agent", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "does_not_exist",
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(Agent.defaultAgent()).rejects.toThrow('default agent "does_not_exist" not found')
    },
  })
})

/**
 * 测试用例17：当 build 被禁用时，defaultAgent 返回下一个可用的 primary Agent
 * 
 * 测试目的：
 * - 验证当默认 Agent 被禁用时，系统会自动选择下一个合适的 Agent
 * - 确保 fallback 逻辑正确工作
 * 
 * 配置示例：
 * ```json
 * {
 *   "agent": {
 *     "build": { "disable": true }
 *   }
 * }
 * ```
 * 
 * 预期结果：
 * - 返回 "plan"（下一个 primary Agent）
 */
test("defaultAgent returns plan when build is disabled and default_agent not set", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: { disable: true },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.defaultAgent()
      // build 被禁用，所以应该返回 plan（下一个 primary Agent）
      expect(agent).toBe("plan")
    },
  })
})

test("defaultAgent throws when all primary agents are disabled", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: { disable: true },
        plan: { disable: true },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // build and plan are disabled, no primary-capable agents remain
      await expect(Agent.defaultAgent()).rejects.toThrow("no primary visible agent found")
    },
  })
})
