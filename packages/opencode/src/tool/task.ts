// 导入 Tool 基类，用于定义工具的标准接口和行为
import { Tool } from "./tool"
// 导入 task 工具的描述文本（从外部文件加载）
import DESCRIPTION from "./task.txt"
// 导入 Zod 库用于运行时类型验证和 schema 定义
import z from "zod"
// 导入 Session 模块，提供会话管理的核心功能
import { Session } from "../session"
// 导入会话 ID 和消息 ID 的类型定义
import { SessionID, MessageID } from "../session/schema"
// 导入消息 V2 模块，用于处理会话消息的读取和操作
import { MessageV2 } from "../session/message-v2"
// 导入标识符生成器，用于创建唯一的 ID
import { Identifier } from "../id/id"
// 导入 Agent 模块，提供智能体的管理和配置功能
import { Agent } from "../agent/agent"
// 导入会话提示模块，用于处理和执行用户提示
import { SessionPrompt } from "../session/prompt"
// 导入立即执行函数工具（IIFE），用于简化异步代码块
import { iife } from "@/util/iife"
// 导入延迟清理工具，用于资源管理和事件监听器清理
import { defer } from "@/util/defer"
// 导入配置模块，用于获取系统配置信息
import { Config } from "../config/config"
// 导入权限模块，用于评估和管理工具访问权限
import { Permission } from "@/permission"

/**
 * 任务工具参数 Schema 定义
 * 使用 Zod 验证输入参数的结构和类型
 */
const parameters = z.object({
  // description: 任务的简短描述（3-5 个词）
  description: z.string().describe("A short (3-5 words) description of the task"),

  // prompt: 要执行的具体任务指令
  prompt: z.string().describe("The task for the agent to perform"),

  // subagent_type: 使用的专用智能体类型
  subagent_type: z.string().describe("The type of specialized agent to use for this task"),

  // task_id: 可选参数，用于恢复之前的任务会话
  // 仅在需要继续之前的任务时设置，传入 prior task_id 可以延续相同的子智能体会话
  task_id: z
    .string()
    .describe(
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
    )
    .optional(),

  // command: 触发此任务的命令（可选）
  command: z.string().describe("The command that triggered this task").optional(),
})

/**
 * TaskTool - 任务委托工具
 *
 * 该工具通过将工作委托给子智能体（subagent）来完成任务。
 * 它会创建一个子会话（child session），子会话继承父会话的 ID，
 * 并可以通过 task_id 在后续恢复。
 *
 * 子智能体的权限会自动禁用递归的 task 和 todowrite 工具，
 * 以防止无限循环。
 */
export const TaskTool = Tool.define("task", async (ctx) => {
  // 获取所有非 primary 模式的智能体列表
  // primary 模式的智能体不能作为子智能体被调用
  const agents = await Agent.list().then((x) => x.filter((a) => a.mode !== "primary"))

  // 根据权限过滤可用的智能体
  const caller = ctx?.agent
  const accessibleAgents = caller
    ? agents.filter((a) => Permission.evaluate("task", a.name, caller.permission).action !== "deny")
    : agents

  // 按名称字母顺序排序智能体列表
  const list = accessibleAgents.toSorted((a, b) => a.name.localeCompare(b.name))

  // 动态生成工具描述，替换占位符 {agents} 为实际的智能体列表
  const description = DESCRIPTION.replace(
    "{agents}",
    list
      .map((a) => `- ${a.name}: ${a.description ?? "This subagent should only be called manually by the user."}`)
      .join("\n"),
  )

  return {
    // 工具描述：包含可用智能体列表的动态说明
    description,

    // 参数定义：使用上面定义的 Zod schema
    parameters,

    /**
     * 执行函数：创建或恢复子会话并运行子智能体提示
     *
     * @param params - 任务参数对象
     * @param ctx - 执行上下文，包含会话信息和权限控制方法
     * @returns 包含任务执行结果的对象
     */
    async execute(params: z.infer<typeof parameters>, ctx) {
      // 获取当前系统配置
      const config = await Config.get()

      // 如果用户没有显式通过 @ 或命令子任务绕过检查，则进行权限验证
      if (!ctx.extra?.bypassAgentCheck) {
        await ctx.ask({
          permission: "task",
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      // 获取指定的智能体实例，如果不存在则抛出错误
      const agent = await Agent.get(params.subagent_type)
      if (!agent) throw new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`)

      // 检查该智能体是否具有 task 和 todowrite 权限
      const hasTaskPermission = agent.permission.some((rule) => rule.permission === "task")
      const hasTodoWritePermission = agent.permission.some((rule) => rule.permission === "todowrite")

      /**
       * 创建或恢复子会话
       * 使用 IIFE（立即执行函数表达式）封装逻辑
       */
      const session = await iife(async () => {
        // 如果提供了 task_id，尝试恢复之前的会话
        if (params.task_id) {
          const found = await Session.get(SessionID.make(params.task_id)).catch(() => {})
          if (found) return found
        }

        // 如果没有找到现有会话，则创建新的子会话
        return await Session.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${agent.name} subagent)`,

          // 配置子会话的权限规则
          permission: [
            // 如果子智能体没有 todowrite 权限，则显式拒绝该权限
            ...(hasTodoWritePermission
              ? []
              : [
                  {
                    permission: "todowrite" as const,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),

            // 如果子智能体没有 task 权限，则显式拒绝该权限（防止递归调用）
            ...(hasTaskPermission
              ? []
              : [
                  {
                    permission: "task" as const,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),

            // 允许配置中指定的 experimental primary_tools
            ...(config.experimental?.primary_tools?.map((t) => ({
              pattern: "*",
              action: "allow" as const,
              permission: t,
            })) ?? []),
          ],
        })
      })

      // 获取当前消息，验证其角色必须是 assistant
      const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
      if (msg.info.role !== "assistant") throw new Error("Not an assistant message")

      // 确定使用的模型：优先使用智能体配置的模型，否则使用当前消息的模型
      const model = agent.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }

      // 设置元数据：记录任务标题、会话 ID 和使用的模型
      ctx.metadata({
        title: params.description,
        metadata: {
          sessionId: session.id,
          model,
        },
      })

      // 生成递增的消息 ID
      const messageID = MessageID.ascending()

      /**
       * 取消函数：用于中止子会话的提示执行
       */
      function cancel() {
        SessionPrompt.cancel(session.id)
      }

      // 注册 abort 事件监听器，当父任务中止时取消子任务
      ctx.abort.addEventListener("abort", cancel)

      // 使用 defer 确保在函数退出时清理事件监听器（资源管理）
      using _ = defer(() => ctx.abort.removeEventListener("abort", cancel))

      // 解析提示内容，将字符串转换为可执行的提示部分
      const promptParts = await SessionPrompt.resolvePromptParts(params.prompt)

      // 执行子会话提示，传递必要的配置参数
      const result = await SessionPrompt.prompt({
        messageID,
        sessionID: session.id,
        model: {
          modelID: model.modelID,
          providerID: model.providerID,
        },
        agent: agent.name,

        // 工具配置：根据权限禁用相应的工具
        tools: {
          // 如果没有 todowrite 权限，则禁用该工具
          ...(hasTodoWritePermission ? {} : { todowrite: false }),

          // 如果没有 task 权限，则禁用该工具（防止递归）
          ...(hasTaskPermission ? {} : { task: false }),

          // 禁用配置中指定的 primary_tools
          ...Object.fromEntries((config.experimental?.primary_tools ?? []).map((t) => [t, false])),
        },

        parts: promptParts,
      })

      // 提取最后一条文本类型的消息内容作为任务结果
      const text = result.parts.findLast((x) => x.type === "text")?.text ?? ""

      // 构建输出格式：包含 task_id 和任务结果
      const output = [
        `task_id: ${session.id} (for resuming to continue this task if needed)`,
        "",
        "<task_result>",
        text,
        "</task_result>",
      ].join("\n")

      // 返回执行结果
      return {
        title: params.description,
        metadata: {
          sessionId: session.id,
          model,
        },
        output,
      }
    },
  }
})

