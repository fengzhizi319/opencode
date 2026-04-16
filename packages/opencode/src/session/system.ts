import { Ripgrep } from "../file/ripgrep"

import { Instance } from "../project/instance"

// 导入针对不同模型优化的系统提示模板
import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"

/**
 * SystemPrompt 命名空间：生成和优化 AI 助手的系统提示
 * 
 * 主要功能：
 * - 根据模型类型选择最优的系统提示模板
 * - 提供运行环境信息（工作目录、平台、日期等）
 * - 加载和格式化可用技能列表
 */
export namespace SystemPrompt {
  /**
   * 根据模型 ID 选择合适的系统提示模板
   * 
   * 执行逻辑：
   * 1. 检查模型 ID 是否包含特定关键词（如 gpt-4、claude、gemini 等）
   * 2. 返回针对该模型优化的提示模板数组
   * 3. 如果没有匹配的模板，返回默认模板
   * 
   * @param model - 模型信息对象，包含 providerID 和 api.id
   * @returns 系统提示文本数组
   */
  export function provider(model: Provider.Model) {
    // GPT-4、o1、o3 系列使用 Beast 提示模板（针对高级模型优化）
    if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
      return [PROMPT_BEAST]
    // GPT 系列模型的处理
    if (model.api.id.includes("gpt")) {
      // Codex 模型使用专门的 Codex 提示模板
      if (model.api.id.includes("codex")) {
        return [PROMPT_CODEX]
      }
      // 其他 GPT 模型使用标准 GPT 提示模板
      return [PROMPT_GPT]
    }
    // Gemini 系列模型
    if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
    // Claude 系列模型（Anthropic）
    if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
    // Trinity 模型（不区分大小写匹配）
    if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
    // 未匹配的模型使用默认提示模板
    return [PROMPT_DEFAULT]
  }

  /**
   * 生成环境信息系统提示
   * 
   * 作用：
   * 向 AI 助手提供当前运行环境的详细信息，帮助其更好地理解上下文
   * 
   * 包含的信息：
   * - 模型名称和 ID
   * - 工作目录和根目录路径
   * - 是否为 Git 仓库
   * - 操作系统平台
   * - 当前日期
   * - 项目目录结构（如果启用且是 Git 仓库）
   * 
   * @param model - 模型信息对象
   * @returns 包含环境信息的字符串数组
   */
  export async function environment(model: Provider.Model) {
    const project = Instance.project
    return [
      [
        // 模型身份信息
        `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
        // 环境信息说明
        `Here is some useful information about the environment you are running in:`,
        `<env>`,
        `  Working directory: ${Instance.directory}`,           // 当前工作目录
        `  Workspace root folder: ${Instance.worktree}`,        // 工作区根目录
        `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,  // 是否为 Git 仓库
        `  Platform: ${process.platform}`,                      // 操作系统平台（darwin、linux、win32 等）
        `  Today's date: ${new Date().toDateString()}`,         // 当前日期
        `</env>`,
        `<directories>`,
        // 目录树结构（目前被禁用：&& false）
        // 如果启用，将使用 ripgrep 扫描最多 50 个目录项
        `  ${
          project.vcs === "git" && false
            ? await Ripgrep.tree({
                cwd: Instance.directory,
                limit: 50,
              })
            : ""
        }`,
        `</directories>`,
      ].join("\n"),
    ]
  }

  /**
   * 生成技能信息系统提示
   * 
   * 作用：
   * 向 AI 助手展示可用的技能（Skills）列表，使其知道可以加载哪些 specialized instructions
   * 
   * 执行逻辑：
   * 1. 检查 agent 的权限配置，如果 skill 工具被禁用则直接返回 undefined
   * 2. 获取当前 agent 可用的所有技能列表
   * 3. 格式化技能信息为详细版本（verbose: true），便于 AI 理解和使用
   * 
   * 注意：
   * - 使用详细格式（verbose）而非简洁格式，因为测试表明 AI 更容易吸收这种形式的信息
   * - 技能的简要描述在工具定义中提供，而这里提供更详细的使用指南
   * 
   * @param agent - 代理信息对象，包含权限配置
   * @returns 技能信息系统提示字符串，如果技能被禁用则返回 undefined
   */
  export async function skills(agent: Agent.Info) {
    // 检查权限：如果 skill 工具在 agent 配置中被禁用，则不加载技能信息
    if (Permission.disabled(["skill"], agent.permission).has("skill")) return

    // 获取当前 agent 可用的所有技能列表
    const list = await Skill.available(agent)

    return [
      // 技能系统的介绍说明
      "Skills provide specialized instructions and workflows for specific tasks.",
      "Use the skill tool to load a skill when a task matches its description.",
      // 格式化技能列表为详细版本
      // the agents seem to ingest the information about skills a bit better if we present a more verbose
      // version of them here and a less verbose version in tool description, rather than vice versa.
      Skill.fmt(list, { verbose: true }),
    ].join("\n")
  }
}
