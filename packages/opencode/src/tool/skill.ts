// 导入 Node.js 路径模块，用于处理文件路径
import path from "path"
// 导入 URL 转换工具，将文件路径转换为 file:// URL 格式
import { pathToFileURL } from "url"
// 导入 Zod 库用于运行时类型验证和 schema 定义
import z from "zod"
// 导入 Tool 基类，用于定义工具的标准接口和行为
import { Tool } from "./tool"
// 导入 Skill 模块，提供技能管理的核心功能
import { Skill } from "../skill"
// 导入 Ripgrep 模块，用于快速文件搜索和遍历
import { Ripgrep } from "../file/ripgrep"
// 导入立即执行函数工具（IIFE），用于简化异步代码块
import { iife } from "@/util/iife"

/**
 * SkillTool - 技能加载工具
 *
 * 该工具用于将专用技能（skill）加载到对话上下文中。
 *
 * 当模型识别出任务与可用技能匹配时，会调用此工具并传入技能名称。
 * 工具返回完整的 SKILL.md 内容以及技能目录中辅助文件的采样列表。
 *
 * 技能可以为特定领域任务提供：
 * - 详细的工作流和指令
 * - 捆绑的资源（脚本、参考文档、模板等）
 * - 领域特定的最佳实践
 */
export const SkillTool = Tool.define("skill", async (ctx) => {
  // 获取当前智能体可用的技能列表
  const list = await Skill.available(ctx?.agent)

  /**
   * 动态生成工具描述
   * 根据是否有可用技能，生成不同的描述文本
   */
  const description =
    list.length === 0
      ? // 没有可用技能时的简化描述
        "Load a specialized skill that provides domain-specific instructions and workflows. No skills are currently available."
      : // 有可用技能时的详细描述
        [
          "Load a specialized skill that provides domain-specific instructions and workflows.",
          "",
          "When you recognize that a task matches one of the available skills listed below, use this tool to load the full skill instructions.",
          "",
          "The skill will inject detailed instructions, workflows, and access to bundled resources (scripts, references, templates) into the conversation context.",
          "",
          'Tool output includes a `<skill_content name="...">` block with the loaded content.',
          "",
          "The following skills provide specialized sets of instructions for particular tasks",
          "Invoke this tool to load a skill when a task matches one of the available skills listed below:",
          "",
          // 使用 Skill.fmt 格式化技能列表（非详细模式）
          Skill.fmt(list, { verbose: false }),
        ].join("\n")

  /**
   * 生成示例技能名称，用于参数提示
   * 取前 3 个技能名称作为示例
   */
  const examples = list
    .map((skill) => `'${skill.name}'`)
    .slice(0, 3)
    .join(", ")

  // 构建提示后缀，如果有示例则显示
  const hint = examples.length > 0 ? ` (e.g., ${examples}, ...)` : ""

  /**
   * 参数 Schema 定义
   * 使用 Zod 验证输入参数的结构
   */
  const parameters = z.object({
    // name: 要加载的技能名称，必须来自可用技能列表
    name: z.string().describe(`The name of the skill from available_skills${hint}`),
  })

  return {
    // 工具描述：包含可用技能列表的动态说明
    description,

    // 参数定义：使用上面定义的 Zod schema
    parameters,

    /**
     * 执行函数：加载请求的技能并返回其内容和文件列表
     *
     * @param params - 包含技能名称的参数对象
     * @param ctx - 执行上下文，包含会话信息和权限控制方法
     * @returns 包含技能内容、文件列表和元数据的对象
     */
    async execute(params: z.infer<typeof parameters>, ctx) {
      // 根据名称获取技能实例
      const skill = await Skill.get(params.name)

      // 如果技能不存在，抛出错误并列出所有可用技能
      if (!skill) {
        const available = await Skill.all().then((x) => x.map((skill) => skill.name).join(", "))
        throw new Error(`Skill "${params.name}" not found. Available skills: ${available || "none"}`)
      }

      // 请求用户权限确认
      // permission: 权限类型为 "skill"
      // patterns: 匹配指定的技能名称
      // always: 始终允许该技能的操作
      // metadata: 额外的元数据（当前为空对象）
      await ctx.ask({
        permission: "skill",
        patterns: [params.name],
        always: [params.name],
        metadata: {},
      })

      // 获取技能所在目录的路径
      const dir = path.dirname(skill.location)

      // 将目录路径转换为 file:// URL 格式，便于在输出中引用
      const base = pathToFileURL(dir).href

      // 设置文件列表的最大数量限制（采样上限）
      const limit = 10

      /**
       * 扫描技能目录中的文件列表（排除 SKILL.md）
       * 使用 Ripgrep 进行高效的文件遍历
       */
      const files = await iife(async () => {
        const arr = []

        // 异步遍历目录中的所有文件
        for await (const file of Ripgrep.files({
          cwd: dir,              // 当前工作目录
          follow: false,         // 不跟随符号链接
          hidden: true,          // 包含隐藏文件
          signal: ctx.abort,     // 支持中止信号
        })) {
          // 跳过 SKILL.md 文件（主内容已单独处理）
          if (file.includes("SKILL.md")) {
            continue
          }

          // 解析文件的绝对路径并添加到数组
          arr.push(path.resolve(dir, file))

          // 达到数量限制时停止扫描
          if (arr.length >= limit) {
            break
          }
        }

        return arr
      }).then((f) =>
        // 将文件路径数组转换为 XML 格式的字符串
        f.map((file) => `<file>${file}</file>`).join("\n")
      )

      /**
       * 返回执行结果
       * 包含技能标题、格式化输出和元数据
       */
      return {
        // 标题：显示已加载的技能名称
        title: `Loaded skill: ${skill.name}`,

        // 输出：格式化的技能内容和文件列表
        output: [
          // 技能内容块的开始标签
          `<skill_content name="${skill.name}">`,

          // 技能标题（Markdown 格式）
          `# Skill: ${skill.name}`,
          "",

          // 技能的完整内容（去除首尾空白）
          skill.content.trim(),
          "",

          // 技能的基础目录 URL
          `Base directory for this skill: ${base}`,

          // 路径说明：相对路径基于基础目录
          "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",

          // 提示：文件列表是采样的，可能不完整
          "Note: file list is sampled.",
          "",

          // 文件列表块的开始标签
          "<skill_files>",

          // 采样后的文件列表（XML 格式）
          files,

          // 文件列表块的结束标签
          "</skill_files>",

          // 技能内容块的结束标签
          "</skill_content>",
        ].join("\n"),

        // 元数据：包含技能名称和目录路径
        metadata: {
          name: skill.name,
          dir,
        },
      }
    },
  }
})

