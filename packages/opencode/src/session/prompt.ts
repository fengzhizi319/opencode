import path from "path"
import os from "os"
import fs from "fs/promises"
import z from "zod"
import { Filesystem } from "../util/filesystem"
import { SessionID, MessageID, PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { Log } from "../util/log"
import { SessionRevert } from "./revert"
import { Session } from "."
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { ModelID, ProviderID } from "../provider/schema"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions, asSchema } from "ai"
import { SessionCompaction } from "./compaction"
import { Instance } from "../project/instance"
import { Bus } from "../bus"
import { ProviderTransform } from "../provider/transform"
import { SystemPrompt } from "./system"
import { InstructionPrompt } from "./instruction"
import { Plugin } from "../plugin"
import PROMPT_PLAN from "../session/prompt/plan.txt"
import BUILD_SWITCH from "../session/prompt/build-switch.txt"
import MAX_STEPS from "../session/prompt/max-steps.txt"
import { defer } from "../util/defer"
import { ToolRegistry } from "../tool/registry"
import { MCP } from "../mcp"
import { LSP } from "../lsp"
import { ReadTool } from "../tool/read"
import { FileTime } from "../file/time"
import { NotFoundError } from "@/storage/db"
import { Flag } from "../flag/flag"
import { ulid } from "ulid"
import { spawn } from "child_process"
import { Command } from "../command"
import { pathToFileURL, fileURLToPath } from "url"
import { ConfigMarkdown } from "../config/markdown"
import { SessionSummary } from "./summary"
import { NamedError } from "@opencode-ai/util/error"
import { fn } from "@/util/fn"
import { SessionProcessor } from "./processor"
import { TaskTool } from "@/tool/task"
import { Tool } from "@/tool/tool"
import { Permission } from "@/permission"
import { SessionStatus } from "./status"
import { LLM } from "./llm"
import { iife } from "@/util/iife"
import { Shell } from "@/shell/shell"
import { Truncate } from "@/tool/truncate"
import { decodeDataUrl } from "@/util/data-url"
import { Process } from "@/util/process"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

/**
 * SessionPrompt 模块：会话提示的主要对话循环和提示组装。
 *
 * `prompt()` 启动用户消息并开始 `loop()`，后者驱动多轮交互：
 * 子任务处理、压缩、工具解析、LLM 流式传输和结构化输出捕获。
 *
 * 此模块负责：
 * - 管理会话状态和中断控制
 * - 处理消息流和历史记录
 * - 执行子任务和压缩操作
 * - 调用模型生成响应
 * - 处理工具调用和权限控制
 * - 支持结构化输出
 */

/** 当启用JSON schema模式时，注入到StructuredOutput工具中的描述。 */
/** Description injected into the StructuredOutput tool when JSON schema mode is enabled. */
const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

/** 当用户请求JSON schema输出时附加的系统提示。 */
/** System prompt appended when the user requests JSON schema output. */
const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`

export namespace SessionPrompt {
  const log = Log.create({ service: "session.prompt" })

  /** 内存状态跟踪活跃会话的中断控制器和待处理解析器。 */
  /** In-memory state tracking active session abort controllers and pending resolvers. */
  const state = Instance.state(
    () => {
      const data: Record<
        string,
        {
          abort: AbortController
          callbacks: {
            resolve(input: MessageV2.WithParts): void
            reject(reason?: any): void
          }[]
        }
      > = {}
      return data
    },
    async (current) => {
      for (const item of Object.values(current)) {
        item.abort.abort()
      }
    },
  )

  /** 如果会话当前正在被处理，则抛出错误（防止并发循环）。 */
  /** Throw if the session is currently being processed (prevents concurrent loops). */
  export function assertNotBusy(sessionID: SessionID) {
    const match = state()[sessionID]
    if (match) throw new Session.BusyError(sessionID)
  }
  /** Input schema for initiating a prompt (user message) in a session. */
  /** 用于在会话中启动提示（用户消息）的输入模式。 */
  export const PromptInput = z.object({
    sessionID: SessionID.zod,
    messageID: MessageID.zod.optional(),
    model: z
      .object({
        providerID: ProviderID.zod,
        modelID: ModelID.zod,
      })
      .optional(),
    agent: z.string().optional(),
    noReply: z.boolean().optional(),
    tools: z
      .record(z.string(), z.boolean())
      .optional()
      .describe(
        "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
      ),
    format: MessageV2.Format.optional(),
    system: z.string().optional(),
    variant: z.string().optional(),
    parts: z.array(
      z.discriminatedUnion("type", [
        MessageV2.TextPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "TextPartInput",
          }),
        MessageV2.FilePart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "FilePartInput",
          }),
        MessageV2.AgentPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "AgentPartInput",
          }),
        MessageV2.SubtaskPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "SubtaskPartInput",
          }),
      ]),
    ),
  })
  export type PromptInput = z.infer<typeof PromptInput>

  /**
   * 创建用户消息并进入对话循环
   * Create a user message and enter the conversation loop
   * 这是会话提示的核心入口函数,负责:
   * 1. 获取并清理会话状态
   * 2. 创建用户消息
   * 3. 处理工具权限配置(向后兼容)
   * 4. 根据配置决定是否启动对话循环
   *
   * @param input - 提示输入参数,包含会话ID、消息内容、工具权限等
   * @returns 返回创建的用户消息,或对话循环的最终结果
   */
  export const prompt = fn(PromptInput, async (input) => {
    // 获取当前会话对象
    const session = await Session.get(input.sessionID)
    // 清理会话的回滚状态,确保会话处于干净状态
    await SessionRevert.cleanup(session)

    // 创建用户消息对象,将输入转换为标准的消息格式
    const message = await createUserMessage(input)
    // 更新会话的最后活动时间戳
    await Session.touch(input.sessionID)

    // 以下为向后兼容逻辑:允许在提示时指定 tools 参数
    // 将 tools 配置转换为权限规则集
    const permissions: Permission.Ruleset = []
    for (const [tool, enabled] of Object.entries(input.tools ?? {})) {
      permissions.push({
        permission: tool,          // 工具名称作为权限标识
        action: enabled ? "allow" : "deny",  // 根据启用状态设置允许或拒绝
        pattern: "*",              // 通配符模式,应用于所有匹配项
      })
    }
    // 如果存在权限配置,则更新会话的权限规则
    if (permissions.length > 0) {
      session.permission = permissions
      await Session.setPermission({ sessionID: session.id, permission: permissions })
    }

    // 如果设置了 noReply 标志,仅创建消息但不触发AI回复
    // 适用于只需记录用户输入的场景
    if (input.noReply === true) {
      return message
    }

    // 启动对话循环,进入 agent-tool-llm 的生命周期处理
    // 这将持续执行直到对话完成或被取消
    return loop({ sessionID: input.sessionID })
  })

  /** 解析提示模板中的文件引用和agent提及，将它们扩展为部件。 */
  /** Parse a prompt template for file references and agent mentions, expanding them to parts. */

  export async function resolvePromptParts(template: string): Promise<PromptInput["parts"]> {
    // 初始化部件数组，首先添加原始模板作为文本部件
    const parts: PromptInput["parts"] = [
      {
        type: "text",
        text: template,
      },
    ]
    // 从模板中提取文件引用
    const files = ConfigMarkdown.files(template)
    // 使用Set避免重复处理同一文件
    const seen = new Set<string>()
    // 并行处理所有文件引用
    await Promise.all(
      files.map(async (match) => {
        const name = match[1]
        // 跳过已处理的文件
        if (seen.has(name)) return
        seen.add(name)
        // 解析文件路径，支持~表示用户主目录
        const filepath = name.startsWith("~/")
          ? path.join(os.homedir(), name.slice(2))
          : path.resolve(Instance.worktree, name)

        // 检查文件是否存在
        const stats = await fs.stat(filepath).catch(() => undefined)
        if (!stats) {
          // 如果文件不存在，检查是否为agent名称
          const agent = await Agent.get(name)
          if (agent) {
            // 添加agent部件
            parts.push({
              type: "agent",
              name: agent.name,
            })
          }
          return
        }

        // 根据文件类型创建相应的部件
        if (stats.isDirectory()) {
          // 目录部件
          parts.push({
            type: "file",
            url: pathToFileURL(filepath).href,
            filename: name,
            mime: "application/x-directory",
          })
          return
        }

        // 普通文件部件
        parts.push({
          type: "file",
          url: pathToFileURL(filepath).href,
          filename: name,
          mime: "text/plain",
        })
      }),
    )
    return parts
  }

  /**
   * 启动会话的中断控制器（AbortController），用于管理会话的中断信号。
   * 如果会话已存在控制器则直接返回，不重复创建。
   * @param sessionID 会话ID
   * @returns AbortSignal 用于监听会话中断
   */
  function start(sessionID: SessionID) {
    const s = state()
    if (s[sessionID]) return
    const controller = new AbortController()
    s[sessionID] = {
      abort: controller,
      callbacks: [],
    }
    return controller.signal
  }

  /**
   * 恢复已存在会话的中断信号（AbortSignal）。
   * 如果会话不存在则返回 undefined。
   * @param sessionID 会话ID
   * @returns AbortSignal | undefined
   */
  function resume(sessionID: SessionID) {
    const s = state()
    if (!s[sessionID]) return

    return s[sessionID].abort.signal
  }

  /**
   * 取消会话，触发中断信号并将会话状态设置为 idle。
   * 如果会话不存在则仅设置状态为 idle。
   * @param sessionID 会话ID
   */
  export async function cancel(sessionID: SessionID) {
    log.info("cancel", { sessionID })
    const s = state()
    const match = s[sessionID]
    if (!match) {
      await SessionStatus.set(sessionID, { type: "idle" })
      return
    }
    match.abort.abort()
    delete s[sessionID]
    await SessionStatus.set(sessionID, { type: "idle" })
    return
  }

  /** Input schema and main conversation loop driving the agent-tool-llm lifecycle. */
  export const LoopInput = z.object({
    sessionID: SessionID.zod,
    resume_existing: z.boolean().optional(),
  })
  /**
   * 主对话循环 - 驱动 agent-tool-llm 生命周期
   *
   * 这是会话处理的核心引擎,负责:
   * 1. 管理对话状态和中断控制
   * 2. 处理消息流和历史记录
   * 3. 执行子任务和压缩操作
   * 4. 调用模型生成响应
   * 5. 处理工具调用和权限控制
   * 6. 支持结构化输出
   *
   * @param input - 循环输入参数,包含会话ID和是否恢复现有会话
   * @returns 返回最终的助手消息及其组成部分
   */
  export const loop = fn(LoopInput, async (input) => {
    const { sessionID, resume_existing } = input

    // 初始化或恢复会话的中断控制器
    // resume_existing: true 表示恢复已存在的会话,false 表示创建新会话
    const abort = resume_existing ? resume(sessionID) : start(sessionID)
    // 如果会话已在运行中,将当前调用注册为回调,等待现有会话完成
    if (!abort) {
      return new Promise<MessageV2.WithParts>((resolve, reject) => {
        const callbacks = state()[sessionID].callbacks
        callbacks.push({ resolve, reject })
      })
    }

    // 使用资源管理模式,确保循环结束时自动取消会话
      await using _ = defer(() => cancel(sessionID))

    // 结构化输出状态变量
    // 注意:会话恢复时状态会重置,但 outputFormat 保留在用户消息中,
    // 将从下面的 lastUser 中检索
    // Structured output state
    // Note: On session resumption, state is reset but outputFormat is preserved
    // on the user message and will be retrieved from lastUser below
    let structuredOutput: unknown | undefined

    // 循环步骤计数器,用于跟踪对话轮次
    let step = 0
    // 获取当前会话对象
    const session = await Session.get(sessionID)
    // 主循环:持续处理直到对话完成或被中断
    while (true) {
      // 设置会话状态为忙碌
      await SessionStatus.set(sessionID, { type: "busy" })
      log.info("loop", { step, sessionID })
      // 检查是否被中断,如果是则退出循环
      if (abort.aborted) break
      // 获取过滤后的消息流(排除已压缩的消息)
      let msgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID))

      // 从后向前遍历消息,查找关键消息引用
      let lastUser: MessageV2.User | undefined          // 最后一条用户消息
      let lastAssistant: MessageV2.Assistant | undefined // 最后一条助手消息
      let lastFinished: MessageV2.Assistant | undefined  // 最后一条已完成的助手消息(有finish标志)
      let tasks: (MessageV2.CompactionPart | MessageV2.SubtaskPart)[] = [] // 待处理的任务列表
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i]
        // 查找最后一条用户消息
        if (!lastUser && msg.info.role === "user") lastUser = msg.info as MessageV2.User
        // 查找最后一条助手消息
        if (!lastAssistant && msg.info.role === "assistant") lastAssistant = msg.info as MessageV2.Assistant
        // 查找最后一条已完成的助手消息
        if (!lastFinished && msg.info.role === "assistant" && msg.info.finish)
          lastFinished = msg.info as MessageV2.Assistant
        // 如果已找到用户消息和已完成消息,停止搜索
        if (lastUser && lastFinished) break
        // 收集未完成消息中的压缩任务和子任务
        const task = msg.parts.filter((part) => part.type === "compaction" || part.type === "subtask")
        if (task && !lastFinished) {
          tasks.push(...task)
        }
      }

      // 验证必须存在用户消息,否则抛出错误(理论上不应发生)
      if (!lastUser) throw new Error("No user message found in stream. This should never happen.")
      // 检查是否应该退出循环:
      // - 助手消息已完成且有明确的结束原因
      // - 结束原因不是 "tool-calls"(表示还有工具需要执行)
      // - 用户消息ID小于助手消息ID(确保是最新的交互)
      if (
        lastAssistant?.finish &&
        ![
          "tool-calls",
          // v6中unknown变为other,但v5中other也存在且含义不同
          // 某些提供商可能有过错误的停止原因,不确定现在是否还有
          // "unknown",
        ].includes(lastAssistant.finish) &&
        lastUser.id < lastAssistant.id
      ) {
        log.info("exiting loop", { sessionID })
        break
      }

      // 增加步骤计数
      step++
      // 第一步时自动生成会话标题
      if (step === 1)
        ensureTitle({
          session,
          modelID: lastUser.model.modelID,
          providerID: lastUser.model.providerID,
          history: msgs,
        })

      // 获取模型配置,处理模型未找到的错误
      const model = await Provider.getModel(lastUser.model.providerID, lastUser.model.modelID).catch((e) => {
        if (Provider.ModelNotFoundError.isInstance(e)) {
          const hint = e.data.suggestions?.length ? ` Did you mean: ${e.data.suggestions.join(", ")}?` : ""
          Bus.publish(Session.Event.Error, {
            sessionID,
            error: new NamedError.Unknown({
              message: `Model not found: ${e.data.providerID}/${e.data.modelID}.${hint}`,
            }).toObject(),
          })
        }
        throw e
      })
      // 从任务队列中取出一个待处理任务(LIFO顺序)
      const task = tasks.pop()

      // ==================== 处理待执行的子任务 ====================
      // TODO: 集中化"调用工具"的逻辑
      if (task?.type === "subtask") {
        // 初始化工具处理器
        const taskTool = await TaskTool.init()
        // 确定子任务使用的模型(如果指定则使用指定的,否则继承父任务模型)
        const taskModel = task.model ? await Provider.getModel(task.model.providerID, task.model.modelID) : model
        // 创建助手消息来承载子任务的执行结果
        const assistantMessage = (await Session.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: lastUser.id,
          sessionID,
          mode: task.agent,           // 子任务使用的agent模式
          agent: task.agent,          // 子任务使用的agent名称
          variant: lastUser.variant,
          path: {
            cwd: Instance.directory,
            root: Instance.worktree,
          },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: taskModel.id,
          providerID: taskModel.providerID,
          time: {
            created: Date.now(),
          },
        })) as MessageV2.Assistant
        // 创建工具调用部分,标记为运行中状态
        let part = (await Session.updatePart({
          id: PartID.ascending(),
          messageID: assistantMessage.id,
          sessionID: assistantMessage.sessionID,
          type: "tool",
          callID: ulid(),
          tool: TaskTool.id,
          state: {
            status: "running",
            input: {
              prompt: task.prompt,
              description: task.description,
              subagent_type: task.agent,
              command: task.command,
            },
            time: {
              start: Date.now(),
            },
          },
        })) as MessageV2.ToolPart
        // 准备任务执行参数
        const taskArgs = {
          prompt: task.prompt,
          description: task.description,
          subagent_type: task.agent,
          command: task.command,
        }
        // 触发插件钩子:工具执行前
        await Plugin.trigger(
          "tool.execute.before",
          {
            tool: "task",
            sessionID,
            callID: part.id,
          },
          { args: taskArgs },
        )
        let executionError: Error | undefined
        // 获取子任务对应的agent配置
        const taskAgent = await Agent.get(task.agent)
        if (!taskAgent) {
          const available = await Agent.list().then((agents) => agents.filter((a) => !a.hidden).map((a) => a.name))
          const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
          const error = new NamedError.Unknown({ message: `Agent not found: "${task.agent}".${hint}` })
          Bus.publish(Session.Event.Error, {
            sessionID,
            error: error.toObject(),
          })
          throw error
        }
        // 构建工具执行上下文
        const taskCtx: Tool.Context = {
          agent: task.agent,
          messageID: assistantMessage.id,
          sessionID: sessionID,
          abort,
          callID: part.callID,
          extra: { bypassAgentCheck: true },  // 绕过agent检查(因为已经在上面验证过)
          messages: msgs,
          // 更新工具元数据的回调
          async metadata(input) {
            part = (await Session.updatePart({
              ...part,
              type: "tool",
              state: {
                ...part.state,
                ...input,
              },
            } satisfies MessageV2.ToolPart)) as MessageV2.ToolPart
          },
          // 请求权限的回调
          async ask(req) {
            await Permission.ask({
              ...req,
              sessionID: sessionID,
              ruleset: Permission.merge(taskAgent.permission, session.permission ?? []),
            })
          },
        }
        // 执行子任务工具,捕获可能的错误
        const result = await taskTool.execute(taskArgs, taskCtx).catch((error) => {
          executionError = error
          log.error("subtask execution failed", { error, agent: task.agent, description: task.description })
          return undefined
        })
        // 处理结果中的附件,为其分配新的ID和关联信息
        const attachments = result?.attachments?.map((attachment) => ({
          ...attachment,
          id: PartID.ascending(),
          sessionID,
          messageID: assistantMessage.id,
        }))
        // 触发插件钩子:工具执行后
        await Plugin.trigger(
          "tool.execute.after",
          {
            tool: "task",
            sessionID,
            callID: part.id,
            args: taskArgs,
          },
          result,
        )
        // 更新助手消息的完成状态和时间
        assistantMessage.finish = "tool-calls"
        assistantMessage.time.completed = Date.now()
        await Session.updateMessage(assistantMessage)
        // 如果执行成功且状态仍为运行中,更新为完成状态
        if (result && part.state.status === "running") {
          await Session.updatePart({
            ...part,
            state: {
              status: "completed",
              input: part.state.input,
              title: result.title,
              metadata: result.metadata,
              output: result.output,
              attachments,
              time: {
                ...part.state.time,
                end: Date.now(),
              },
            },
          } satisfies MessageV2.ToolPart)
        }
        // 如果执行失败,更新为错误状态
        if (!result) {
          await Session.updatePart({
            ...part,
            state: {
              status: "error",
              error: executionError ? `Tool execution failed: ${executionError.message}` : "Tool execution failed",
              time: {
                start: part.state.status === "running" ? part.state.time.start : Date.now(),
                end: Date.now(),
              },
              metadata: "metadata" in part.state ? part.state.metadata : undefined,
              input: part.state.input,
            },
          } satisfies MessageV2.ToolPart)
        }

        // 如果子任务包含command,添加合成的用户消息
        // 这是为了防止某些推理模型出错(如Gemini)
        // 如果在循环中间创建没有后续用户消息的助手消息,
        // thinking签名可能会缺失导致错误
        if (task.command) {
          // Add synthetic user message to prevent certain reasoning models from erroring
          // If we create assistant messages w/ out user ones following mid loop thinking signatures
          // will be missing and it can cause errors for models like gemini for example
          const summaryUserMsg: MessageV2.User = {
            id: MessageID.ascending(),
            sessionID,
            role: "user",
            time: {
              created: Date.now(),
            },
            agent: lastUser.agent,
            model: lastUser.model,
          }
          await Session.updateMessage(summaryUserMsg)
          await Session.updatePart({
            id: PartID.ascending(),
            messageID: summaryUserMsg.id,
            sessionID,
            type: "text",
            text: "Summarize the task tool output above and continue with your task.",
            synthetic: true,  // 标记为合成消息
          } satisfies MessageV2.TextPart)
        }

        // 继续下一轮循环,让模型处理子任务的结果
        continue
      }

      // ==================== 处理待执行的压缩任务 ====================
      // pending compaction
      if (task?.type === "compaction") {
        // 执行消息压缩,减少上下文长度
        const result = await SessionCompaction.process({
          messages: msgs,
          parentID: lastUser.id,
          abort,
          sessionID,
          auto: task.auto,        // 是否为自动压缩
          overflow: task.overflow, // 是否因溢出而触发
        })
        // 如果压缩结果为"stop",退出循环
        if (result === "stop") break
        // 否则继续下一轮循环
        continue
      }

      // ==================== 检查上下文溢出,需要压缩 ====================
      // context overflow, needs compaction
      // 如果最后一条助手消息已完成且不是摘要消息,
      // 并且token数量超过模型限制,则创建压缩任务
      if (
        lastFinished &&
        lastFinished.summary !== true &&
        (await SessionCompaction.isOverflow({ tokens: lastFinished.tokens, model }))
      ) {
        await SessionCompaction.create({
          sessionID,
          agent: lastUser.agent,
          model: lastUser.model,
          auto: true,  // 标记为自动触发的压缩
        })
        continue
      }

      // ==================== 正常处理流程 ====================
      // 获取用户指定的agent配置
      const agent = await Agent.get(lastUser.agent)
      if (!agent) {
        const available = await Agent.list().then((agents) => agents.filter((a) => !a.hidden).map((a) => a.name))
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${lastUser.agent}".${hint}` })
        Bus.publish(Session.Event.Error, {
          sessionID,
          error: error.toObject(),
        })
        throw error
      }
      // 获取agent的最大步骤限制(默认为无限)
      const maxSteps = agent.steps ?? Infinity
      // 判断是否已达到最大步骤数
      const isLastStep = step >= maxSteps
      // 插入提醒消息(如定时任务等)
      msgs = await insertReminders({
        messages: msgs,
        agent,
        session,
      })

      // 创建会话处理器,用于处理模型调用和工具执行
      const processor = await SessionProcessor.create({
        assistantMessage: (await Session.updateMessage({
          id: MessageID.ascending(),
          parentID: lastUser.id,
          role: "assistant",
          mode: agent.name,
          agent: agent.name,
          variant: lastUser.variant,
          path: {
            cwd: Instance.directory,
            root: Instance.worktree,
          },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: model.id,
          providerID: model.providerID,
          time: {
            created: Date.now(),
          },
          sessionID,
        })) as MessageV2.Assistant,
        sessionID: sessionID,
        model,
        abort,
      })
      // 使用资源管理,确保处理器结束时清理指令提示
      using _ = defer(() => InstructionPrompt.clear(processor.message.id))

      // 检查用户是否通过 @ 显式调用了某个agent
      const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
      const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false

      // 解析并准备可用的工具列表
      const tools = await resolveTools({
        agent,
        session,
        model,
        tools: lastUser.tools,
        processor,
        bypassAgentCheck,
        messages: msgs,
      })

      // 如果启用了JSON schema模式,注入结构化输出工具
      // Inject StructuredOutput tool if JSON schema mode enabled
      if (lastUser.format?.type === "json_schema") {
        tools["StructuredOutput"] = createStructuredOutputTool({
          schema: lastUser.format.schema,
          onSuccess(output) {
            structuredOutput = output  // 保存结构化输出结果
          },
        })
      }

      // 第一步时生成会话摘要
      if (step === 1) {
        SessionSummary.summarize({
          sessionID: sessionID,
          messageID: lastUser.id,
        })
      }

      // 如果不是第一步且有已完成的消息,为排队的用户消息添加系统提醒
      // 这有助于让模型保持专注并继续之前的任务
      if (step > 1 && lastFinished) {
        for (const msg of msgs) {
          if (msg.info.role !== "user" || msg.info.id <= lastFinished.id) continue
          for (const part of msg.parts) {
            if (part.type !== "text" || part.ignored || part.synthetic) continue
            if (!part.text.trim()) continue
            // 用系统提醒包裹原始文本
            part.text = [
              "<system-reminder>",
              "The user sent the following message:",
              part.text,
              "",
              "Please address this message and continue with your tasks.",
              "</system-reminder>",
            ].join("\n")
          }
        }
      }

      // 触发插件钩子:转换聊天消息
      await Plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })

      // 构建系统提示,如果需要则添加结构化输出指令
      const skills = await SystemPrompt.skills(agent)
      const system = [
        ...(await SystemPrompt.environment(model)),    // 环境信息
        ...(skills ? [skills] : []),                   // agent技能描述
        ...(await InstructionPrompt.system()),         // 系统指令
      ]
      // 确定输出格式(默认为文本)
      const format = lastUser.format ?? { type: "text" }
      // 如果是JSON schema模式,添加结构化输出的系统提示
      if (format.type === "json_schema") {
        system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)
      }

      // 执行处理器,调用模型生成响应
      const result = await processor.process({
        user: lastUser,
        agent,
        permission: session.permission,  // 会话权限规则
        abort,
        sessionID,
        system,                          // 系统提示
        messages: [
          ...(await MessageV2.toModelMessages(msgs, model)),  // 转换为模型消息格式
          // 如果是最后一步,添加最大步骤警告
          ...(isLastStep
            ? [
              {
                role: "assistant" as const,
                content: MAX_STEPS,
              },
            ]
            : []),
        ],
        tools,                           // 可用工具列表
        model,                           // 使用的模型
        toolChoice: format.type === "json_schema" ? "required" : undefined,  // JSON模式下强制使用工具
      })

      // 如果捕获到结构化输出,保存并立即退出
      // 这优先于其他逻辑,因为StructuredOutput工具已成功调用
      // If structured output was captured, save it and exit immediately
      // This takes priority because the StructuredOutput tool was called successfully
      if (structuredOutput !== undefined) {
        processor.message.structured = structuredOutput
        processor.message.finish = processor.message.finish ?? "stop"
        await Session.updateMessage(processor.message)
        break
      }

      // Check if model finished (finish reason is not "tool-calls" or "unknown")
      const modelFinished = processor.message.finish && !["tool-calls", "unknown"].includes(processor.message.finish)

      // 如果模型已完成且没有错误
      if (modelFinished && !processor.message.error) {
        // 如果是JSON schema模式但模型没有调用StructuredOutput工具,则报错
        if (format.type === "json_schema") {
          // Model stopped without calling StructuredOutput tool
          processor.message.error = new MessageV2.StructuredOutputError({
            message: "Model did not produce structured output",
            retries: 0,
          }).toObject()
          await Session.updateMessage(processor.message)
          break
        }
      }

      // 根据处理结果决定下一步操作
      if (result === "stop") break  // 停止信号,退出循环
      if (result === "compact") {   // 需要压缩
        await SessionCompaction.create({
          sessionID,
          agent: lastUser.agent,
          model: lastUser.model,
          auto: true,
          overflow: !processor.message.finish,  // 如果消息未完成,标记为溢出
        })
      }
      // 继续下一轮循环
      continue
    }

    // ==================== 循环结束后的清理和返回 ====================
    // 修剪已完成的压缩任务
    SessionCompaction.prune({ sessionID })
    // 遍历消息流,找到第一条非用户消息作为结果返回
    for await (const item of MessageV2.stream(sessionID)) {
      if (item.info.role === "user") continue  // 跳过用户消息
      // 解析所有等待的回调,将结果返回给所有调用者
      const queued = state()[sessionID]?.callbacks ?? []
      for (const q of queued) {
        q.resolve(item)
      }
      return item
    }
    // 理论上不应该到达这里
    throw new Error("Impossible")
  })

  async function lastModel(sessionID: SessionID) {
    for await (const item of MessageV2.stream(sessionID)) {
      if (item.info.role === "user" && item.info.model) return item.info.model
    }
    return Provider.defaultModel()
  }

  /** 为AI SDK构建工具集，合并内置、插件和MCP工具。用于测试的导出函数。 */
  export async function resolveTools(input: {
    agent: Agent.Info
    model: Provider.Model
    session: Session.Info
    tools?: Record<string, boolean>
    processor: SessionProcessor.Info
    bypassAgentCheck: boolean
    messages: MessageV2.WithParts[]
  }) {
    // 使用计时器记录工具解析耗时
    using _ = log.time("resolveTools")
    // 初始化工具记录对象
    const tools: Record<string, AITool> = {}

    /**
     * 创建工具执行上下文的工厂函数
     * 为每个工具调用提供统一的上下文信息
     */
    const context = (args: any, options: ToolExecutionOptions): Tool.Context => ({
      sessionID: input.session.id,
      abort: options.abortSignal!,  // 中断信号
      messageID: input.processor.message.id,  // 消息ID
      callID: options.toolCallId,  // 工具调用ID
      extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck },  // 额外配置
      agent: input.agent.name,  // agent名称
      messages: input.messages,  // 消息历史
      // 工具元数据更新回调
      metadata: async (val: { title?: string; metadata?: any }) => {
        const match = input.processor.partFromToolCall(options.toolCallId)
        if (match && match.state.status === "running") {
          await Session.updatePart({
            ...match,
            state: {
              title: val.title,
              metadata: val.metadata,
              status: "running",
              input: args,
              time: {
                start: Date.now(),
              },
            },
          })
        }
      },
      // 权限请求回调
      async ask(req) {
        await Permission.ask({
          ...req,
          sessionID: input.session.id,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
        })
      },
    })

    // ==================== 处理内置工具 ====================
    // 从工具注册表获取agent支持的工具
    for (const item of await ToolRegistry.tools(
      { modelID: ModelID.make(input.model.api.id), providerID: input.model.providerID },
      input.agent,
    )) {
      // 转换工具参数schema以适配模型提供商
      const schema = ProviderTransform.schema(input.model, z.toJSONSchema(item.parameters))
      // 创建AI SDK工具对象
      tools[item.id] = tool({
        id: item.id as any,
        description: item.description,
        inputSchema: jsonSchema(schema as any),
        // 工具执行函数
        async execute(args, options) {
          const ctx = context(args, options)
          // 触发工具执行前钩子
          await Plugin.trigger(
            "tool.execute.before",
            {
              tool: item.id,
              sessionID: ctx.sessionID,
              callID: ctx.callID,
            },
            {
              args,
            },
          )
          // 执行工具
          const result = await item.execute(args, ctx)
          // 处理附件，为其分配新的ID和关联信息
          const output = {
            ...result,
            attachments: result.attachments?.map((attachment) => ({
              ...attachment,
              id: PartID.ascending(),
              sessionID: ctx.sessionID,
              messageID: input.processor.message.id,
            })),
          }
          // 触发工具执行后钩子
          await Plugin.trigger(
            "tool.execute.after",
            {
              tool: item.id,
              sessionID: ctx.sessionID,
              callID: ctx.callID,
              args,
            },
            output,
          )
          return output
        },
      })
    }

    // ==================== 处理MCP工具 ====================
    // 获取所有MCP工具
    for (const [key, item] of Object.entries(await MCP.tools())) {
      const execute = item.execute
      if (!execute) continue

      // 获取并转换工具输入schema
      const schema = await asSchema(item.inputSchema).jsonSchema
      const transformed = ProviderTransform.schema(input.model, schema)
      item.inputSchema = jsonSchema(transformed)
      // 包装执行函数以添加插件钩子和输出格式化
      // Wrap execute to add plugin hooks and format output
      item.execute = async (args, opts) => {
        const ctx = context(args, opts)

        // 触发工具执行前钩子
        await Plugin.trigger(
          "tool.execute.before",
          {
            tool: key,
            sessionID: ctx.sessionID,
            callID: opts.toolCallId,
          },
          {
            args,
          },
        )

        // 请求工具权限
        await ctx.ask({
          permission: key,
          metadata: {},
          patterns: ["*"],
          always: ["*"],
        })

        // 执行MCP工具
        const result = await execute(args, opts)

        // 触发工具执行后钩子
        await Plugin.trigger(
          "tool.execute.after",
          {
            tool: key,
            sessionID: ctx.sessionID,
            callID: opts.toolCallId,
            args,
          },
          result,
        )

        // 处理MCP工具的复杂输出内容
        const textParts: string[] = []
        const attachments: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[] = []

        // 遍历MCP结果内容，根据类型分别处理
        for (const contentItem of result.content) {
          if (contentItem.type === "text") {
            // 文本内容直接添加到文本部分
            textParts.push(contentItem.text)
          } else if (contentItem.type === "image") {
            // 图像内容作为附件处理
            attachments.push({
              type: "file",
              mime: contentItem.mimeType,
              url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
            })
          } else if (contentItem.type === "resource") {
            // 资源内容处理
            const { resource } = contentItem
            if (resource.text) {
              textParts.push(resource.text)
            }
            if (resource.blob) {
              attachments.push({
                type: "file",
                mime: resource.mimeType ?? "application/octet-stream",
                url: `data:${resource.mimeType ?? "application/octet-stream"};base64,${resource.blob}`,
                filename: resource.uri,
              })
            }
          }
        }

        // 截断输出文本以控制长度
        const truncated = await Truncate.output(textParts.join("\n\n"), {}, input.agent)
        const metadata = {
          ...(result.metadata ?? {}),
          truncated: truncated.truncated,
          ...(truncated.truncated && { outputPath: truncated.outputPath }),
        }

        // 返回格式化的工具执行结果
        return {
          title: "",
          metadata,
          output: truncated.content,
          attachments: attachments.map((attachment) => ({
            ...attachment,
            id: PartID.ascending(),
            sessionID: ctx.sessionID,
            messageID: input.processor.message.id,
          })),
          content: result.content, // directly return content to preserve ordering when outputting to model，保留原始内容以供模型输出时使用
        }
      }
      tools[key] = item
    }

    return tools
  }

  /** Create a tool that captures structured JSON output from the model. Exported for testing. */
  export function createStructuredOutputTool(input: {
    schema: Record<string, any>
    onSuccess: (output: unknown) => void
  }): AITool {
    // Remove $schema property if present (not needed for tool input)
    const { $schema, ...toolSchema } = input.schema

    return tool({
      id: "StructuredOutput" as any,
      description: STRUCTURED_OUTPUT_DESCRIPTION,
      inputSchema: jsonSchema(toolSchema as any),
      async execute(args) {
        // AI SDK validates args against inputSchema before calling execute()
        input.onSuccess(args)
        return {
          output: "Structured output captured successfully.",
          title: "Structured Output",
          metadata: { valid: true },
        }
      },
      toModelOutput({ output }) {
        return {
          type: "text",
          value: output.output,
        }
      },
    })
  }

  /** Construct a user message from the prompt input and persist it. */
  async function createUserMessage(input: PromptInput) {
    const agentName = input.agent || (await Agent.defaultAgent())
    const agent = await Agent.get(agentName)
    if (!agent) {
      const available = await Agent.list().then((agents) => agents.filter((a) => !a.hidden).map((a) => a.name))
      const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
      const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
      Bus.publish(Session.Event.Error, {
        sessionID: input.sessionID,
        error: error.toObject(),
      })
      throw error
    }

    const model = input.model ?? agent.model ?? (await lastModel(input.sessionID))
    const full =
      !input.variant && agent.variant
        ? await Provider.getModel(model.providerID, model.modelID).catch(() => undefined)
        : undefined
    const variant = input.variant ?? (agent.variant && full?.variants?.[agent.variant] ? agent.variant : undefined)

    const info: MessageV2.Info = {
      id: input.messageID ?? MessageID.ascending(),
      role: "user",
      sessionID: input.sessionID,
      time: {
        created: Date.now(),
      },
      tools: input.tools,
      agent: agent.name,
      model,
      system: input.system,
      format: input.format,
      variant,
    }
    using _ = defer(() => InstructionPrompt.clear(info.id))

    type Draft<T> = T extends MessageV2.Part ? Omit<T, "id"> & { id?: string } : never
    const assign = (part: Draft<MessageV2.Part>): MessageV2.Part => ({
      ...part,
      id: part.id ? PartID.make(part.id) : PartID.ascending(),
    })

    const parts = await Promise.all(
      input.parts.map(async (part): Promise<Draft<MessageV2.Part>[]> => {
        if (part.type === "file") {
          // before checking the protocol we check if this is an mcp resource because it needs special handling
          if (part.source?.type === "resource") {
            const { clientName, uri } = part.source
            log.info("mcp resource", { clientName, uri, mime: part.mime })

            const pieces: Draft<MessageV2.Part>[] = [
              {
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Reading MCP resource: ${part.filename} (${uri})`,
              },
            ]

            try {
              const resourceContent = await MCP.readResource(clientName, uri)
              if (!resourceContent) {
                throw new Error(`Resource not found: ${clientName}/${uri}`)
              }

              // Handle different content types
              const contents = Array.isArray(resourceContent.contents)
                ? resourceContent.contents
                : [resourceContent.contents]

              for (const content of contents) {
                if ("text" in content && content.text) {
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: content.text as string,
                  })
                } else if ("blob" in content && content.blob) {
                  // Handle binary content if needed
                  const mimeType = "mimeType" in content ? content.mimeType : part.mime
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `[Binary content: ${mimeType}]`,
                  })
                }
              }

              pieces.push({
                ...part,
                messageID: info.id,
                sessionID: input.sessionID,
              })
            } catch (error: unknown) {
              log.error("failed to read MCP resource", { error, clientName, uri })
              const message = error instanceof Error ? error.message : String(error)
              pieces.push({
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Failed to read MCP resource ${part.filename}: ${message}`,
              })
            }

            return pieces
          }
          const url = new URL(part.url)
          switch (url.protocol) {
            case "data:":
              if (part.mime === "text/plain") {
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: decodeDataUrl(part.url),
                  },
                  {
                    ...part,
                    messageID: info.id,
                    sessionID: input.sessionID,
                  },
                ]
              }
              break
            case "file:":
              log.info("file", { mime: part.mime })
              // have to normalize, symbol search returns absolute paths
              // Decode the pathname since URL constructor doesn't automatically decode it
              const filepath = fileURLToPath(part.url)
              const s = Filesystem.stat(filepath)

              if (s?.isDirectory()) {
                part.mime = "application/x-directory"
              }

              if (part.mime === "text/plain") {
                let offset: number | undefined = undefined
                let limit: number | undefined = undefined
                const range = {
                  start: url.searchParams.get("start"),
                  end: url.searchParams.get("end"),
                }
                if (range.start != null) {
                  const filePathURI = part.url.split("?")[0]
                  let start = parseInt(range.start)
                  let end = range.end ? parseInt(range.end) : undefined
                  // some LSP servers (eg, gopls) don't give full range in
                  // workspace/symbol searches, so we'll try to find the
                  // symbol in the document to get the full range
                  if (start === end) {
                    const symbols = await LSP.documentSymbol(filePathURI).catch(() => [])
                    for (const symbol of symbols) {
                      let range: LSP.Range | undefined
                      if ("range" in symbol) {
                        range = symbol.range
                      } else if ("location" in symbol) {
                        range = symbol.location.range
                      }
                      if (range?.start?.line && range?.start?.line === start) {
                        start = range.start.line
                        end = range?.end?.line ?? start
                        break
                      }
                    }
                  }
                  offset = Math.max(start, 1)
                  if (end) {
                    limit = end - (offset - 1)
                  }
                }
                const args = { filePath: filepath, offset, limit }

                const pieces: Draft<MessageV2.Part>[] = [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                ]

                await ReadTool.init()
                  .then(async (t) => {
                    const model = await Provider.getModel(info.model.providerID, info.model.modelID)
                    const readCtx: Tool.Context = {
                      sessionID: input.sessionID,
                      abort: new AbortController().signal,
                      agent: input.agent!,
                      messageID: info.id,
                      extra: { bypassCwdCheck: true, model },
                      messages: [],
                      metadata: async () => {},
                      ask: async () => {},
                    }
                    const result = await t.execute(args, readCtx)
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: result.output,
                    })
                    if (result.attachments?.length) {
                      pieces.push(
                        ...result.attachments.map((attachment) => ({
                          ...attachment,
                          synthetic: true,
                          filename: attachment.filename ?? part.filename,
                          messageID: info.id,
                          sessionID: input.sessionID,
                        })),
                      )
                    } else {
                      pieces.push({
                        ...part,
                        messageID: info.id,
                        sessionID: input.sessionID,
                      })
                    }
                  })
                  .catch((error) => {
                    log.error("failed to read file", { error })
                    const message = error instanceof Error ? error.message : error.toString()
                    Bus.publish(Session.Event.Error, {
                      sessionID: input.sessionID,
                      error: new NamedError.Unknown({
                        message,
                      }).toObject(),
                    })
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                    })
                  })

                return pieces
              }

              if (part.mime === "application/x-directory") {
                const args = { filePath: filepath }
                const listCtx: Tool.Context = {
                  sessionID: input.sessionID,
                  abort: new AbortController().signal,
                  agent: input.agent!,
                  messageID: info.id,
                  extra: { bypassCwdCheck: true },
                  messages: [],
                  metadata: async () => {},
                  ask: async () => {},
                }
                const result = await ReadTool.init().then((t) => t.execute(args, listCtx))
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  },
                  {
                    ...part,
                    messageID: info.id,
                    sessionID: input.sessionID,
                  },
                ]
              }

              await FileTime.read(input.sessionID, filepath)
              return [
                {
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  text: `Called the Read tool with the following input: {"filePath":"${filepath}"}`,
                  synthetic: true,
                },
                {
                  id: part.id,
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "file",
                  url: `data:${part.mime};base64,` + (await Filesystem.readBytes(filepath)).toString("base64"),
                  mime: part.mime,
                  filename: part.filename!,
                  source: part.source,
                },
              ]
          }
        }

        if (part.type === "agent") {
          // Check if this agent would be denied by task permission
          const perm = Permission.evaluate("task", part.name, agent.permission)
          const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
          return [
            {
              ...part,
              messageID: info.id,
              sessionID: input.sessionID,
            },
            {
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              // An extra space is added here. Otherwise the 'Use' gets appended
              // to user's last word; making a combined word
              text:
                " Use the above message and context to generate a prompt and call the task tool with subagent: " +
                part.name +
                hint,
            },
          ]
        }

        return [
          {
            ...part,
            messageID: info.id,
            sessionID: input.sessionID,
          },
        ]
      }),
    ).then((x) => x.flat().map(assign))

    await Plugin.trigger(
      "chat.message",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        messageID: input.messageID,
        variant: input.variant,
      },
      {
        message: info,
        parts,
      },
    )

    const parsedInfo = MessageV2.Info.safeParse(info)
    if (!parsedInfo.success) {
      log.error("invalid user message before save", {
        sessionID: input.sessionID,
        messageID: info.id,
        agent: info.agent,
        model: info.model,
        issues: parsedInfo.error.issues,
      })
    }

    parts.forEach((part, index) => {
      const parsedPart = MessageV2.Part.safeParse(part)
      if (parsedPart.success) return
      log.error("invalid user part before save", {
        sessionID: input.sessionID,
        messageID: info.id,
        partID: part.id,
        partType: part.type,
        index,
        issues: parsedPart.error.issues,
        part,
      })
    })

    await Session.updateMessage(info)
    for (const part of parts) {
      await Session.updatePart(part)
    }

    return {
      info,
      parts,
    }
  }

  /**
   * 在用户消息中插入提醒内容
   * 
   * 根据当前agent模式和会话状态,向用户消息添加系统级别的提醒文本。
   * 支持两种模式:
   * 1. 传统模式(Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE = false)
   * 2. 实验性计划模式(Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE = true)
   * 
   * @param input - 包含消息列表、agent信息和会话信息的对象
   * @returns 处理后的消息列表
   */
  async function insertReminders(input: { messages: MessageV2.WithParts[]; agent: Agent.Info; session: Session.Info }) {
    // 查找最后一条用户消息
    const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
    if (!userMessage) return input.messages

    // ==================== 传统模式(实验性计划模式禁用时) ====================
    if (!Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE) {
      // 如果当前是plan agent,添加计划提示
      if (input.agent.name === "plan") {
        userMessage.parts.push({
          id: PartID.ascending(),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text: PROMPT_PLAN,  // 计划模式提示文本
          synthetic: true,     // 标记为合成消息
        })
      }
      // 检测是否从plan模式切换到build模式
      const wasPlan = input.messages.some((msg) => msg.info.role === "assistant" && msg.info.agent === "plan")
      if (wasPlan && input.agent.name === "build") {
        userMessage.parts.push({
          id: PartID.ascending(),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text: BUILD_SWITCH,  // 模式切换提示
          synthetic: true,
        })
      }
      return input.messages
    }

    // ==================== 实验性计划模式(Flag启用时) ====================
    // 查找最后一条助手消息
    const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")

    // 情况1: 从plan模式切换到build模式
    if (input.agent.name !== "plan" && assistantMessage?.info.agent === "plan") {
      // 获取计划文件路径
      const plan = Session.plan(input.session)
      const exists = await Filesystem.exists(plan)
      if (exists) {
        // 如果计划文件存在,添加提示信息引导执行计划
        const part = await Session.updatePart({
          id: PartID.ascending(),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text:
            BUILD_SWITCH + "\n\n" + `A plan files exists at ${plan}. You should execute on the plan defined within it`,
          synthetic: true,
        })
        userMessage.parts.push(part)
      }
      return input.messages
    }

    // 情况2: 进入plan模式
    if (input.agent.name === "plan" && assistantMessage?.info.agent !== "plan") {
      // 获取计划文件路径
      const plan = Session.plan(input.session)
      const exists = await Filesystem.exists(plan)
      // 如果文件不存在,创建目录
      if (!exists) await fs.mkdir(path.dirname(plan), { recursive: true })
      // 添加详细的计划模式工作流程说明
      const part = await Session.updatePart({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: `<system-reminder>
Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received.

## Plan File Info:
${exists ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.` : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`}
You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.

## Plan Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions. Critical: In this phase you should only use the explore subagent type.

1. Focus on understanding the user's request and the code associated with their request

2. **Launch up to 3 explore agents IN PARALLEL** (single message, multiple tool calls) to efficiently explore the codebase.
   - Use 1 agent when the task is isolated to known files, the user provided specific file paths, or you're making a small targeted change.
   - Use multiple agents when: the scope is uncertain, multiple areas of the codebase are involved, or you need to understand existing patterns before planning.
   - Quality over quantity - 3 agents maximum, but you should try to use the minimum number of agents necessary (usually just 1)
   - If using multiple agents: Provide each agent with a specific search focus or area to explore. Example: One agent searches for existing implementations, another explores related components, a third investigates testing patterns

3. After exploring the code, use the question tool to clarify ambiguities in the user request up front.

### Phase 2: Design
Goal: Design an implementation approach.

Launch general agent(s) to design the implementation based on the user's intent and your exploration results from Phase 1.

You can launch up to 1 agent(s) in parallel.

**Guidelines:**
- **Default**: Launch at least 1 Plan agent for most tasks - it helps validate your understanding and consider alternatives
- **Skip agents**: Only for truly trivial tasks (typo fixes, single-line changes, simple renames)

Examples of when to use multiple agents:
- The task touches multiple parts of the codebase
- It's a large refactor or architectural change
- There are many edge cases to consider
- You'd benefit from exploring different approaches

Example perspectives by task type:
- New feature: simplicity vs performance vs maintainability
- Bug fix: root cause vs workaround vs prevention
- Refactoring: minimal change vs clean architecture

In the agent prompt:
- Provide comprehensive background context from Phase 1 exploration including filenames and code path traces
- Describe requirements and constraints
- Request a detailed implementation plan

### Phase 3: Review
Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.
1. Read the critical files identified by agents to deepen your understanding
2. Ensure that the plans align with the user's original request
3. Use question tool to clarify any remaining questions with the user

### Phase 4: Final Plan
Goal: Write your final plan to the plan file (the only file you can edit).
- Include only your recommended approach, not all alternatives
- Ensure that the plan file is concise enough to scan quickly, but detailed enough to execute effectively
- Include the paths of critical files to be modified
- Include a verification section describing how to test the changes end-to-end (run the code, use MCP tools, run tests)

### Phase 5: Call plan_exit tool
At the very end of your turn, once you have asked the user questions and are happy with your final plan file - you should always call plan_exit to indicate to the user that you are done planning.
This is critical - your turn should only end with either asking the user a question or calling plan_exit. Do not stop unless it's for these 2 reasons.

**Important:** Use question tool to clarify requirements/approach, use plan_exit to request plan approval. Do NOT use question tool to ask "Is this plan okay?" - that's what plan_exit does.

NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.
</system-reminder>`,
        synthetic: true,
      })
      userMessage.parts.push(part)
      return input.messages
    }
    // 其他情况不做修改,直接返回
    return input.messages
  }

  /** Shell命令执行输入参数定义 */
  export const ShellInput = z.object({
    sessionID: SessionID.zod,
    agent: z.string(),
    model: z
      .object({
        providerID: ProviderID.zod,
        modelID: ModelID.zod,
      })
      .optional(),
    command: z.string(),  // 要执行的shell命令
  })
  export type ShellInput = z.infer<typeof ShellInput>
  
  /**
   * 执行Shell命令并记录到会话中
   * 
   * 在指定的会话中执行shell命令,将命令的输出作为工具调用结果记录到消息历史中。
   * 支持多种shell类型(zsh、bash、fish、nu、cmd、powershell等)。
   * 
   * @param input - shell命令输入参数
   * @returns 包含助手消息和工具部分的对象
   */
  export async function shell(input: ShellInput) {
    // 启动会话中断控制器,如果会话正忙则抛出错误
    const abort = start(input.sessionID)
    if (!abort) {
      throw new Session.BusyError(input.sessionID)
    }

    // 使用资源管理,确保清理时正确处理回调或取消会话
    using _ = defer(() => {
      // 如果没有等待的回调,直接取消会话
      const callbacks = state()[input.sessionID]?.callbacks ?? []
      if (callbacks.length === 0) {
        cancel(input.sessionID)
      } else {
        // 否则恢复会话循环以处理排队的项目
        loop({ sessionID: input.sessionID, resume_existing: true }).catch((error) => {
          log.error("session loop failed to resume after shell command", { sessionID: input.sessionID, error })
        })
      }
    })

    // 获取会话信息并清理回滚状态
    const session = await Session.get(input.sessionID)
    if (session.revert) {
      await SessionRevert.cleanup(session)
    }
    // 获取agent配置,如果不存在则抛出错误并提供可用agent列表
    const agent = await Agent.get(input.agent)
    if (!agent) {
      const available = await Agent.list().then((agents) => agents.filter((a) => !a.hidden).map((a) => a.name))
      const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
      const error = new NamedError.Unknown({ message: `Agent not found: "${input.agent}".${hint}` })
      Bus.publish(Session.Event.Error, {
        sessionID: input.sessionID,
        error: error.toObject(),
      })
      throw error
    }
    // 确定使用的模型(优先使用输入指定,其次agent默认,最后使用上次使用的模型)
    const model = input.model ?? agent.model ?? (await lastModel(input.sessionID))
    
    // 创建用户消息,标记为合成消息
    const userMsg: MessageV2.User = {
      id: MessageID.ascending(),
      sessionID: input.sessionID,
      time: {
        created: Date.now(),
      },
      role: "user",
      agent: input.agent,
      model: {
        providerID: model.providerID,
        modelID: model.modelID,
      },
    }
    await Session.updateMessage(userMsg)
    // 创建用户消息部分,说明这是用户执行的工具
    const userPart: MessageV2.Part = {
      type: "text",
      id: PartID.ascending(),
      messageID: userMsg.id,
      sessionID: input.sessionID,
      text: "The following tool was executed by the user",
      synthetic: true,
    }
    await Session.updatePart(userPart)

    // 创建助手消息来承载shell命令执行结果
    const msg: MessageV2.Assistant = {
      id: MessageID.ascending(),
      sessionID: input.sessionID,
      parentID: userMsg.id,
      mode: input.agent,
      agent: input.agent,
      cost: 0,
      path: {
        cwd: Instance.directory,
        root: Instance.worktree,
      },
      time: {
        created: Date.now(),
      },
      role: "assistant",
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: model.modelID,
      providerID: model.providerID,
    }
    await Session.updateMessage(msg)
    // 创建工具调用部分,标记为运行中状态
    const part: MessageV2.Part = {
      type: "tool",
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID: input.sessionID,
      tool: "bash",
      callID: ulid(),
      state: {
        status: "running",
        time: {
          start: Date.now(),
        },
        input: {
          command: input.command,
        },
      },
    }
    await Session.updatePart(part)
    // 获取首选shell及其名称
    const shell = Shell.preferred()
    const shellName = Shell.name(shell)

    // 定义不同shell的命令调用方式
    const invocations: Record<string, { args: string[] }> = {
      nu: {
        args: ["-c", input.command],
      },
      fish: {
        args: ["-c", input.command],
      },
      zsh: {
        args: [
          "-c",
          "-l",  // 登录shell模式
          `
            [[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true
            [[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true
            eval ${JSON.stringify(input.command)}
          `,
        ],
      },
      bash: {
        args: [
          "-c",
          "-l",  // 登录shell模式
          `
            shopt -s expand_aliases  // 启用别名扩展
            [[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true
            eval ${JSON.stringify(input.command)}
          `,
        ],
      },
      // Windows cmd
      cmd: {
        args: ["/c", input.command],
      },
      // Windows PowerShell
      powershell: {
        args: ["-NoProfile", "-Command", input.command],
      },
      pwsh: {
        args: ["-NoProfile", "-Command", input.command],
      },
      // 后备方案:任何不匹配的shell
      //  - 不使用-l标志,以获得最大兼容性
      "": {
        args: ["-c", `${input.command}`],
      },
    }

    // 根据shell名称选择对应的调用方式,如果没有匹配则使用后备方案
    const matchingInvocation = invocations[shellName] ?? invocations[""]
    const args = matchingInvocation?.args

    // 设置工作目录
    const cwd = Instance.directory
    // 触发插件钩子获取shell环境变量
    const shellEnv = await Plugin.trigger(
      "shell.env",
      { cwd, sessionID: input.sessionID, callID: part.callID },
      { env: {} },
    )
    // 生成shell进程
    const proc = spawn(shell, args, {
      cwd,
      detached: process.platform !== "win32",  // Unix系统分离进程
      windowsHide: process.platform === "win32",  // Windows隐藏窗口
      stdio: ["ignore", "pipe", "pipe"],  // 忽略stdin,捕获stdout和stderr
      env: {
        ...process.env,
        ...shellEnv.env,  // 合并插件提供的环境变量
        TERM: "dumb",  // 设置终端类型为dumb(不支持颜色等)
      },
    })

    // 收集命令输出
    let output = ""

    // 监听标准输出
    proc.stdout?.on("data", (chunk) => {
      output += chunk.toString()
      if (part.state.status === "running") {
        part.state.metadata = {
          output: output,
          description: "",
        }
        Session.updatePart(part)  // 实时更新工具状态
      }
    })

    // 监听错误输出
    proc.stderr?.on("data", (chunk) => {
      output += chunk.toString()
      if (part.state.status === "running") {
        part.state.metadata = {
          output: output,
          description: "",
        }
        Session.updatePart(part)  // 实时更新工具状态
      }
    })

    // 跟踪中断和退出状态
    let aborted = false
    let exited = false

    // 定义终止进程树的函数
    const kill = () => Shell.killTree(proc, { exited: () => exited })

    // 如果已经中断,立即终止进程
    if (abort.aborted) {
      aborted = true
      await kill()
    }

    // 定义中断处理函数
    const abortHandler = () => {
      aborted = true
      void kill()
    }

    // 注册一次性中断事件监听器
    abort.addEventListener("abort", abortHandler, { once: true })

    // 等待进程关闭
    await new Promise<void>((resolve) => {
      proc.on("close", () => {
        exited = true
        abort.removeEventListener("abort", abortHandler)  // 移除监听器
        resolve()
      })
    })

    // 如果被中断,在输出中添加提示信息
    if (aborted) {
      output += "\n\n" + ["<metadata>", "User aborted the command", "</metadata>"].join("\n")
    }
    // 更新助手消息的完成时间
    msg.time.completed = Date.now()
    await Session.updateMessage(msg)
    // 如果工具仍在运行中,更新为完成状态并保存输出
    if (part.state.status === "running") {
      part.state = {
        status: "completed",
        time: {
          ...part.state.time,
          end: Date.now(),
        },
        input: part.state.input,
        title: "",
        metadata: {
          output,
          description: "",
        },
        output,
      }
      await Session.updatePart(part)
    }
    // 返回助手消息和工具部分
    return { info: msg, parts: [part] }
  }

  /** Command命令执行输入参数定义 */
  export const CommandInput = z.object({
    messageID: MessageID.zod.optional(),
    sessionID: SessionID.zod,
    agent: z.string().optional(),
    model: z.string().optional(),
    arguments: z.string(),  // 命令参数
    command: z.string(),     // 命令名称
    variant: z.string().optional(),
    parts: z
      .array(
        z.discriminatedUnion("type", [
          MessageV2.FilePart.omit({
            messageID: true,
            sessionID: true,
          }).partial({
            id: true,
          }),
        ]),
      )
      .optional(),
  })
  export type CommandInput = z.infer<typeof CommandInput>
  
  // 匹配shell命令执行语法 !`command`
  const bashRegex = /!`([^`]+)`/g
  // 匹配参数: [Image N]、引号字符串或非空格序列
  const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
  // 匹配占位符 $1, $2, $ARGUMENTS等
  const placeholderRegex = /\$(\d+)/g
  // 去除首尾引号
  const quoteTrimRegex = /^["']|["']$/g
  /**
   * 执行自定义命令
   * 
   * 解析并执行预定义的命令模板,支持参数替换、shell命令执行等功能。
   * 命令可以以子任务形式执行,也可以直接作为提示发送。
   * 
   * @param input - 命令输入参数
   * @returns 执行结果消息
   */
  export async function command(input: CommandInput) {
    log.info("command", input)
    // 获取命令定义,如果不存在则抛出错误并提供可用命令列表
    const command = await Command.get(input.command)
    if (!command) {
      const available = await Command.list().then((cmds) => cmds.map((c) => c.name))
      const hint = available.length ? ` Available commands: ${available.join(", ")}` : ""
      const error = new NamedError.Unknown({ message: `Command not found: "${input.command}".${hint}` })
      Bus.publish(Session.Event.Error, {
        sessionID: input.sessionID,
        error: error.toObject(),
      })
      throw error
    }
    // 确定使用的agent(优先使用命令指定,其次输入指定,最后使用默认agent)
    const agentName = command.agent ?? input.agent ?? (await Agent.defaultAgent())

    // 解析参数字符串,去除首尾引号
    const raw = input.arguments.match(argsRegex) ?? []
    const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))

    // 获取命令模板
    const templateCommand = await command.template

    // 查找所有占位符($1, $2等)
    const placeholders = templateCommand.match(placeholderRegex) ?? []
    let last = 0
    for (const item of placeholders) {
      const value = Number(item.slice(1))
      if (value > last) last = value
    }

    // 替换占位符:最后一个占位符会吞掉所有剩余参数,使命令读起来更自然
    const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
      const position = Number(index)
      const argIndex = position - 1
      if (argIndex >= args.length) return ""
      if (position === last) return args.slice(argIndex).join(" ")
      return args[argIndex]
    })
    // 检查是否使用了$ARGUMENTS占位符
    const usesArgumentsPlaceholder = templateCommand.includes("$ARGUMENTS")
    // 替换$ARGUMENTS为用户提供的完整参数字符串
    let template = withArgs.replaceAll("$ARGUMENTS", input.arguments)

    // 如果命令没有显式处理参数(没有$N或$ARGUMENTS占位符)
    // 但用户提供了参数,则将参数附加到模板末尾
    if (placeholders.length === 0 && !usesArgumentsPlaceholder && input.arguments.trim()) {
      template = template + "\n\n" + input.arguments
    }

    // 查找并执行模板中的shell命令(!`command`语法)
    const shellMatches = ConfigMarkdown.shell(template)
    if (shellMatches.length > 0) {
      const sh = Shell.preferred()
      // 并行执行所有shell命令
      const results = await Promise.all(
        shellMatches.map(async ([, cmd]) => {
          const out = await Process.text([cmd], { shell: sh, nothrow: true })
          return out.text
        }),
      )
      // 将shell命令输出替换回模板
      let index = 0
      template = template.replace(bashRegex, () => results[index++])
    }
    template = template.trim()

    // 确定使用的模型(优先级:命令指定 > agent指定 > 输入指定 > 上次使用的模型)
    const taskModel = await (async () => {
      if (command.model) {
        return Provider.parseModel(command.model)
      }
      if (command.agent) {
        const cmdAgent = await Agent.get(command.agent)
        if (cmdAgent?.model) {
          return cmdAgent.model
        }
      }
      if (input.model) return Provider.parseModel(input.model)
      return await lastModel(input.sessionID)
    })()

    // 验证模型是否存在,处理模型未找到的错误
    try {
      await Provider.getModel(taskModel.providerID, taskModel.modelID)
    } catch (e) {
      if (Provider.ModelNotFoundError.isInstance(e)) {
        const { providerID, modelID, suggestions } = e.data
        const hint = suggestions?.length ? ` Did you mean: ${suggestions.join(", ")}?` : ""
        Bus.publish(Session.Event.Error, {
          sessionID: input.sessionID,
          error: new NamedError.Unknown({ message: `Model not found: ${providerID}/${modelID}.${hint}` }).toObject(),
        })
      }
      throw e
    }
    // 获取agent配置,如果不存在则抛出错误
    const agent = await Agent.get(agentName)
    if (!agent) {
      const available = await Agent.list().then((agents) => agents.filter((a) => !a.hidden).map((a) => a.name))
      const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
      const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
      Bus.publish(Session.Event.Error, {
        sessionID: input.sessionID,
        error: error.toObject(),
      })
      throw error
    }

    // 解析模板中的文件引用和agent提及,转换为消息部分
    const templateParts = await resolvePromptParts(template)
    // 判断是否以子任务形式执行(agent模式为subagent且未禁用,或显式启用)
    const isSubtask = (agent.mode === "subagent" && command.subtask !== false) || command.subtask === true
    // 根据是否为子任务构建不同的消息部分
    const parts = isSubtask
      ? [
        {
          type: "subtask" as const,
          agent: agent.name,
          description: command.description ?? "",
          command: input.command,
          model: {
            providerID: taskModel.providerID,
            modelID: taskModel.modelID,
          },
          // TODO: 如何让task工具接受更复杂的输入?
          prompt: templateParts.find((y) => y.type === "text")?.text ?? "",
        },
      ]
      : [...templateParts, ...(input.parts ?? [])]

    // 确定用户agent和用户模型(子任务模式下使用不同的值)
    const userAgent = isSubtask ? (input.agent ?? (await Agent.defaultAgent())) : agentName
    const userModel = isSubtask
      ? input.model
        ? Provider.parseModel(input.model)
        : await lastModel(input.sessionID)
      : taskModel

    // 触发插件钩子:命令执行前
    await Plugin.trigger(
      "command.execute.before",
      {
        command: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
      },
      { parts },
    )

    // 调用prompt函数执行命令,传入构建的消息部分
    const result = (await prompt({
      sessionID: input.sessionID,
      messageID: input.messageID,
      model: userModel,
      agent: userAgent,
      parts,
      variant: input.variant,
    })) as MessageV2.WithParts

    // 发布命令执行事件
    Bus.publish(Command.Event.Executed, {
      name: input.command,
      sessionID: input.sessionID,
      arguments: input.arguments,
      messageID: result.info.id,
    })

    return result
  }

  /**
   * 自动生成会话标题
   * 
   * 在会话的第一步,使用小型模型分析用户的第一条真实消息,
   * 生成一个简洁的标题来描述对话内容。
   * 
   * @param input - 包含会话、历史消息、提供商和模型信息的对象
   */
  async function ensureTitle(input: {
    session: Session.Info
    history: MessageV2.WithParts[]
    providerID: ProviderID
    modelID: ModelID
  }) {
    // 如果会话有父会话,不生成标题(子会话不需要标题)
    if (input.session.parentID) return
    // 如果会话标题已被修改(不是默认标题),不重新生成
    if (!Session.isDefaultTitle(input.session.title)) return

    // 查找第一条非合成的用户消息(排除自动生成的消息)
    const firstRealUserIdx = input.history.findIndex(
      (m) => m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic),
    )
    if (firstRealUserIdx === -1) return  // 没有找到真实用户消息

    // 确认这是第一条真实用户消息(之前没有其他真实用户消息)
    const isFirst =
      input.history.filter((m) => m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic))
        .length === 1
    if (!isFirst) return  // 如果不是第一条,不生成标题

    // 收集直到第一条真实用户消息的所有消息作为上下文
    // 这包括用户第一条提示之前的任何shell/子任务执行
    const contextMessages = input.history.slice(0, firstRealUserIdx + 1)
    const firstRealUser = contextMessages[firstRealUserIdx]

    // 对于仅包含子任务的消息(来自命令调用),直接提取prompt
    // 因为toModelMessage会将子任务部分转换为通用的"The following tool was executed by the user"
    const subtaskParts = firstRealUser.parts.filter((p) => p.type === "subtask") as MessageV2.SubtaskPart[]
    const hasOnlySubtaskParts = subtaskParts.length > 0 && firstRealUser.parts.every((p) => p.type === "subtask")

    // 获取title agent配置
    const agent = await Agent.get("title")
    if (!agent) return
    // 确定使用的模型(优先使用agent指定,其次使用小型模型,最后使用输入指定的模型)
    const model = await iife(async () => {
      if (agent.model) return await Provider.getModel(agent.model.providerID, agent.model.modelID)
      return (
        (await Provider.getSmallModel(input.providerID)) ?? (await Provider.getModel(input.providerID, input.modelID))
      )
    })
    try {
      // 调用LLM生成标题
      const result = await LLM.stream({
        agent,
        user: firstRealUser.info as MessageV2.User,
        system: [],  // 不使用系统提示
        small: true,  // 标记为小型模型调用
        tools: {},    // 不使用工具
        model,
        abort: new AbortController().signal,
        sessionID: input.session.id,
        retries: 2,   // 重试2次
        messages: [
          {
            role: "user",
            content: "Generate a title for this conversation:\n",  // 提示生成标题
          },
          // 如果只有子任务部分,直接使用prompt;否则转换为模型消息格式
          ...(hasOnlySubtaskParts
            ? [{ role: "user" as const, content: subtaskParts.map((p) => p.prompt).join("\n") }]
            : await MessageV2.toModelMessages(contextMessages, model)),
        ],
      })
      // 获取生成的文本
      const text = await result.text
      // 清理文本:移除<think>标签,找到第一个非空行
      const cleaned = text
        .replace(/<think>[\s\S]*?<\/think>\s*/g, "")  // 移除思考过程
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0)  // 找到第一个非空行
      if (!cleaned) return  // 如果没有有效内容,退出

      // 限制标题长度,超过100字符则截断并添加省略号
      const title = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
      // 设置会话标题,忽略NotFoundError(会话可能已被删除)
      return Session.setTitle({ sessionID: input.session.id, title }).catch((err) => {
        if (NotFoundError.isInstance(err)) return
        throw err
      })
    } catch (error) {
      // 记录标题生成失败的错误
      log.error("failed to generate title", { error })
    }
  }
}
