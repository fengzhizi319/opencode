/**
 * @file processor.ts
 * @description SessionProcessor 模块 - LLM 流事件处理器
 * 此文件是核心的消息处理器 (Message Processor)，充当了主要的对话协调引擎。
 * 它主要负责：
 * 1. 接收用户的输入（Prompt/Instruction）。
 * 2. 处理大语言模型 (LLM) 相关的调用过程。
 * 3. 协调各类工具的运行 (Tool Execution)。
 * 4. 推送流式的进度更新或结果。
 * ## 核心职责
 * 此模块是 OpenCode 的"神经中枢",负责处理与 LLM 的实时流式交互。
 * 它将 AI SDK 的原始流事件（如 text-delta、tool-call）转换为结构化的 Part 实体，
 * 并持久化到会话存储中。
 * 
 * ## 处理流程
 * ```
 * LLM.stream() ──> StreamEvent ──> handleEvent() ──> Part 更新 ──> 持久化
 *      │                                              │
 *      │         1. start-step (记录代码快照)          │
 *      │         2. text-delta (流式文本更新)          │
 *      │         3. tool-call (工具调用执行)           │
 *      │         4. finish-step (计算 token/费用)      │
 *      ▼                                              ▼
 *  Event Stream                                 UI 实时更新
 * ```
 * 
 * ## 关键概念
 * 
 * ### Doom Loop 检测
 * 当模型连续 3 次以相同参数调用同一工具时,触发 doom_loop 权限询问,
 * 防止模型陷入无限循环。
 * 
 * ### 状态机
 * ToolPart 状态转换:
 * ```
 * pending (收到 tool-input-start)
 *   │
 *   ▼
 * running (收到 tool-call,参数完整)
 *   │
 *   ├──────────> completed (收到 tool-result)
 *   │
 *   └──────────> error (收到 tool-error 或异常)
 * ```
 * 
 * ### 流事件处理
 * - **异步流式处理**: LLM 响应是实时流式的,Processor 边接收边处理
 * - **增量更新**: text-delta 事件触发 PartDelta 事件,UI 实时显示
 * - **容错重试**: 使用 SessionRetry.policy 自动重试可恢复错误
 */

// 导入 Effect-TS 核心模块，用于函数式响应式编程和错误处理
import { Cause, Effect, Exit, Layer, ServiceMap } from "effect"
// 导入 Effect-TS 流处理模块，用于处理 LLM 的流式输出
import * as Stream from "effect/Stream"
// 导入智能体模块，用于获取和管理 AI 智能体
import { Agent } from "@/agent/agent"
// 导入事件总线模块，用于发布和订阅系统事件
import { Bus } from "@/bus"
// 导入运行时创建工具，用于初始化 Effect-TS 服务
import { makeRuntime } from "@/effect/run-service"
// 导入配置模块，用于读取系统配置
import { Config } from "@/config/config"
// 导入权限模块，用于管理和验证用户权限
import { Permission } from "@/permission"
// 导入插件模块，支持扩展点触发
import { Plugin } from "@/plugin"
// 导入快照模块，用于文件系统状态跟踪和差异计算
import { Snapshot } from "@/snapshot"
// 导入日志模块，用于记录处理器运行信息
import { Log } from "@/util/log"
// 导入会话模块的核心功能
import { Session } from "."
// 导入 LLM 模块，用于与大语言模型交互
import { LLM } from "./llm"
// 导入消息 V2 模块，用于处理会话消息的结构和操作
import { MessageV2 } from "./message-v2"
// 导入溢出检测函数，用于判断上下文是否超出限制
import { isOverflow } from "./overflow"
// 导入部分 ID 类型
import { PartID } from "./schema"
// 导入会话 ID 类型
import type { SessionID } from "./schema"
// 导入重试策略模块，用于 LLM 调用失败时的自动重试
import { SessionRetry } from "./retry"
// 导入会话状态模块，用于管理会话的忙碌/空闲状态
import { SessionStatus } from "./status"
// 导入会话摘要模块，用于生成对话内容的压缩摘要
import { SessionSummary } from "./summary"
// 导入提供者模型类型
import type { Provider } from "@/provider/provider"
// 导入问题模块，用于处理需要用户澄清的问题
import { Question } from "@/question"

/**
 * SessionProcessor 命名空间
 * SessionProcessor 模块：处理 LLM 流式事件并更新消息部分
 *
 * 为每个助手轮次创建一个处理器实例，将 `streamText` 的事件
 * （文本、推理、工具调用、步骤）处理为持久化的 Part 实体。
 *
 * 核心职责：
 * - 解析 LLM 流式事件（文本增量、推理过程、工具调用等）
 * - 实时更新消息部分到数据库
 * - 检测异常循环（doom loop）并请求用户确认
 * - 管理快照和补丁，跟踪文件变化
 * - 处理错误、中止和清理逻辑
 * - 判断是否需要上下文压缩（compaction）
 *
 * 每个 Assistant Message 对应一个 Processor 实例。
 * Processor 的生命周期 = 一次 LLM 调用 (从 start-step 到 finish-step)。
 * 
 * @example
 * ```ts
 * // 创建处理器实例
 * const processor = await SessionProcessor.create({
 *   assistantMessage,  // 关联的 Assistant Message
 *   sessionID,         // 所属会话
 *   model,             // 使用的模型
 *   abort,             // 中止信号
 * })
 * 
 * // 处理 LLM 流
 * const result = await processor.process({
 *   system,    // System Prompt
 *   messages,  // 历史消息
 *   tools,     // 可用工具
 *   model,
 * })
 * ```
 */
export namespace SessionProcessor {
  /**
   * Doom Loop 阈值
   * 
   * 当模型连续 3 次以完全相同的参数调用同一工具时,
   * 触发 doom_loop 检测,防止无限循环。
   * 
   * 场景示例:
   * - 模型反复调用 grep 搜索同一模式
   * - 模型循环调用 read 读取同一文件
   * - 模型在错误修正中反复调用同一编辑工具
   */
  const DOOM_LOOP_THRESHOLD = 3
  
  /** 日志记录器,用于调试和追踪处理器行为 */
  const log = Log.create({ service: "session.processor" })

  /**
   * 处理器执行结果
   * 
   * - "compact": 上下文溢出,需要压缩记忆
   * - "stop": 停止循环(出错、被拒绝、用户中止)
   * - "continue": 继续下一轮循环(通常是 tool-calls)
   */
  export type Result = "compact" | "stop" | "continue"

  /** 流事件类型,直接复用 LLM 模块的事件定义 */
  export type Event = LLM.Event

  /**
   * 内部处理器句柄 (Effect-TS 风格)
   * 
   * 用于 Effect 内部的流处理,提供函数式接口。
   * 与 Info 接口的区别在于 process 返回 Effect 而非 Promise。
   */
  export interface Handle {
    /** 关联的 Assistant Message 实体 */
    readonly message: MessageV2.Assistant
    
    /**
     * 根据 toolCallID 查找对应的 ToolPart
     * 
     * 用于在工具执行过程中追踪特定工具调用的状态。
     * 例如:在 tool-result 事件中根据 callID 找到对应的 pending tool。
     */
    readonly partFromToolCall: (toolCallID: string) => MessageV2.ToolPart | undefined
    
    /** 中止当前处理器 */
    readonly abort: () => Effect.Effect<void>
    
    /** 核心处理流程 */
    readonly process: (streamInput: LLM.StreamInput) => Effect.Effect<Result>
  }

  /**
   * 公共处理器信息接口
   * 
   * 对外暴露的接口,process 返回 Promise 便于常规异步代码使用。
   * 通过 create() 工厂函数创建。
   */
  export interface Info {
    readonly message: MessageV2.Assistant
    readonly partFromToolCall: (toolCallID: string) => MessageV2.ToolPart | undefined
    readonly process: (streamInput: LLM.StreamInput) => Promise<Result>
  }

  /**
   * 处理器创建参数
   * 
   * @property assistantMessage - 本次处理关联的 Assistant Message
   * @property sessionID - 会话 ID,用于上下文关联
   * @property model - 使用的模型配置(影响 token 计算、provider 选项等)
   * @property abort - 中止信号,用户取消时触发
   */
  type Input = {
    assistantMessage: MessageV2.Assistant
    sessionID: SessionID
    model: Provider.Model
    abort: AbortSignal
  }

  /**
   * 处理器服务接口
   * 
   * 遵循 Effect-TS 服务模式的接口定义,
   * 通过 Layer 提供具体实现。
   */
  export interface Interface {
    readonly create: (input: Input) => Effect.Effect<Handle>
  }

  /**
   * 处理器上下文 (可变状态)
   * 
   * 维护单次 LLM 调用过程中的所有状态。
   * 注意:这是可变对象,在 handleEvent 中被修改。
   * 
   * 状态字段说明:
   * - toolcalls: 追踪当前步骤中所有工具调用的状态
   * - shouldBreak: 遇到权限拒绝时是否中断循环
   * - snapshot: start-step 时记录的文件系统快照
   * - blocked: 是否被权限系统阻止
   * - needsCompaction: 是否需要记忆压缩
   * - currentText: 当前正在流式生成的文本 Part
   * - reasoningMap: 多个 reasoning 流的映射(支持并行推理)
   */
  interface ProcessorContext extends Input {
    toolcalls: Record<string, MessageV2.ToolPart>
    shouldBreak: boolean
    snapshot: string | undefined
    blocked: boolean
    needsCompaction: boolean
    currentText: MessageV2.TextPart | undefined
    reasoningMap: Record<string, MessageV2.ReasoningPart>
  }

  /** 流事件类型别名 */
  type StreamEvent = Event

  /**
   * Effect-TS 服务标签
   * 
   * 使用 Effect-TS 的 ServiceMap 模式定义服务,
   * 便于依赖注入和测试 mock。
   */
  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/SessionProcessor") {}

  /**
   * Effect-TS 服务层
   * 
   * 定义 SessionProcessor 服务的依赖关系图:
   * - 依赖: Session, Config, Bus, Snapshot, Agent, LLM, Permission, Plugin, SessionStatus
   * 
   * 使用 Layer.effect 创建,内部使用 Effect.gen 进行依赖注入。
   */
  export const layer: Layer.Layer<
    Service,
    never,
    | Session.Service
    | Config.Service
    | Bus.Service
    | Snapshot.Service
    | Agent.Service
    | LLM.Service
    | Permission.Service
    | Plugin.Service
    | SessionStatus.Service
  > = Layer.effect(
    Service,
    Effect.gen(function* () {
      // 通过 yield* 获取所有依赖服务
      const session = yield* Session.Service
      const config = yield* Config.Service
      const bus = yield* Bus.Service
      const snapshot = yield* Snapshot.Service
      const agents = yield* Agent.Service
      const llm = yield* LLM.Service
      const permission = yield* Permission.Service
      const plugin = yield* Plugin.Service
      const status = yield* SessionStatus.Service

      /**
       * 创建处理器实例
       * 
       * 初始化 ProcessorContext 并返回包含 process/abort/partFromToolCall 的句柄。
       */
      const create = Effect.fn("SessionProcessor.create")(function* (input: Input) {
        // 初始化处理器上下文,所有字段从 input 复制,状态字段设初始值
        const ctx: ProcessorContext = {
          assistantMessage: input.assistantMessage,
          sessionID: input.sessionID,
          model: input.model,
          abort: input.abort,
          toolcalls: {},           // 空对象,等待 tool-input-start 填充
          shouldBreak: false,      // 默认继续循环
          snapshot: undefined,     // 等待 start-step 设置
          blocked: false,          // 初始未阻塞
          needsCompaction: false,  // 初始无需压缩
          currentText: undefined,  // 等待 text-start 设置
          reasoningMap: {},        // 空对象,支持多路 reasoning
        }

        /**
         * 错误解析器
         * 
         * 将各种错误类型转换为标准化的 MessageV2 错误格式。
         * 考虑因素:是否用户中止、provider 信息。
         */
        const parse = (e: unknown) =>
          MessageV2.fromError(e, {
            providerID: input.model.providerID,
            aborted: input.abort.aborted,
          })

        /**
         * 核心事件处理器
         * 
         * 这是整个模块的核心函数!处理所有来自 LLM 的流事件。
         * 每个 case 对应一种事件类型,执行相应的状态更新和持久化。
         * 
         * @param value - 流事件对象
         */
        const handleEvent = Effect.fn("SessionProcessor.handleEvent")(function* (value: StreamEvent) {
          switch (value.type) {
            /**
             * 流开始事件
             * 
             * 当 LLM 开始生成响应时触发。
             * 设置会话状态为 busy,UI 显示加载中。
             */
            case "start":
              yield* status.set(ctx.sessionID, { type: "busy" })
              return

            /**
             * Reasoning 开始事件 (如 Claude extended thinking)
             * 
             * 某些模型(如 Claude 3.7 Sonnet)支持显式推理模式。
             * 创建 ReasoningPart 并持久化,后续 reasoning-delta 会追加内容。
             */
            case "reasoning-start":
              if (value.id in ctx.reasoningMap) return  // 已存在则跳过
              ctx.reasoningMap[value.id] = {
                id: PartID.ascending(),
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.assistantMessage.sessionID,
                type: "reasoning",
                text: "",
                time: { start: Date.now() },
                metadata: value.providerMetadata,
              }
              yield* session.updatePart(ctx.reasoningMap[value.id])
              return

            /**
             * Reasoning 增量事件
             * 
             * 追加 reasoning 文本,发布增量更新供 UI 实时显示。
             */
            case "reasoning-delta":
              if (!(value.id in ctx.reasoningMap)) return
              ctx.reasoningMap[value.id].text += value.text
              if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
              yield* session.updatePartDelta({
                sessionID: ctx.reasoningMap[value.id].sessionID,
                messageID: ctx.reasoningMap[value.id].messageID,
                partID: ctx.reasoningMap[value.id].id,
                field: "text",
                delta: value.text,
              })
              return

            /**
             * Reasoning 结束事件
             * 
             * 清理文本、设置结束时间、持久化最终状态。
             */
            case "reasoning-end":
              if (!(value.id in ctx.reasoningMap)) return
              ctx.reasoningMap[value.id].text = ctx.reasoningMap[value.id].text.trimEnd()
              ctx.reasoningMap[value.id].time = { ...ctx.reasoningMap[value.id].time, end: Date.now() }
              if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
              yield* session.updatePart(ctx.reasoningMap[value.id])
              delete ctx.reasoningMap[value.id]  // 清理内存
              return

            /**
             * 工具输入开始事件
             * 
             * LLM 开始生成工具调用的参数(JSON 格式)。
             * 创建 ToolPart,状态为 pending(参数尚未完整)。
             */
            case "tool-input-start":
              ctx.toolcalls[value.id] = (yield* session.updatePart({
                id: ctx.toolcalls[value.id]?.id ?? PartID.ascending(),
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.assistantMessage.sessionID,
                type: "tool",
                tool: value.toolName,
                callID: value.id,
                state: { status: "pending", input: {}, raw: "" },
              })) as MessageV2.ToolPart
              return

            /**
             * 工具输入增量事件
             * 
             * 当前未处理,因为工具参数在 tool-call 事件中已完整提供。
             * 保留此 case 以兼容 AI SDK 的事件流。
             */
            case "tool-input-delta":
              return

            /**
             * 工具输入结束事件
             * 
             * 当前未处理,参数解析在 tool-call 中完成。
             */
            case "tool-input-end":
              return

            /**
             * 工具调用事件
             * 
             * 关键事件!工具参数已完整,开始实际执行。
             * 1. 更新 ToolPart 状态为 running
             * 2. 记录开始时间
             * 3. Doom Loop 检测
             */
            case "tool-call": {
              const match = ctx.toolcalls[value.toolCallId]
              if (!match) return
              
              // 更新状态为 running,记录输入参数
              ctx.toolcalls[value.toolCallId] = (yield* session.updatePart({
                ...match,
                tool: value.toolName,
                state: { status: "running", input: value.input, time: { start: Date.now() } },
                metadata: value.providerMetadata,
              })) as MessageV2.ToolPart

              /**
               * Doom Loop 检测逻辑
               * 
               * 检查最近 3 个工具调用:
               * - 是否都是同一工具
               * - 是否参数完全相同
               * 
               * 如果是,触发权限询问,让用户决定是否继续。
               */
              const parts = yield* Effect.promise(() => MessageV2.parts(ctx.assistantMessage.id))
              const recentParts = parts.slice(-DOOM_LOOP_THRESHOLD)

              if (
                recentParts.length !== DOOM_LOOP_THRESHOLD ||
                !recentParts.every(
                  (part) =>
                    part.type === "tool" &&
                    part.tool === value.toolName &&
                    part.state.status !== "pending" &&
                    JSON.stringify(part.state.input) === JSON.stringify(value.input),
                )
              ) {
                return  // 未触发阈值,正常返回
              }

              // 触发 doom_loop 权限询问
              const agent = yield* agents.get(ctx.assistantMessage.agent)
              yield* permission.ask({
                permission: "doom_loop",
                patterns: [value.toolName],
                sessionID: ctx.assistantMessage.sessionID,
                metadata: { tool: value.toolName, input: value.input },
                always: [value.toolName],
                ruleset: agent.permission,
              })
              return
            }

            /**
             * 工具结果事件
             * 
             * 工具执行成功,更新状态为 completed。
             * 包含:输出内容、元数据、附件、执行时间。
             */
            case "tool-result": {
              const match = ctx.toolcalls[value.toolCallId]
              if (!match || match.state.status !== "running") return
              yield* session.updatePart({
                ...match,
                state: {
                  status: "completed",
                  input: value.input ?? match.state.input,
                  output: value.output.output,
                  metadata: value.output.metadata,
                  title: value.output.title,
                  time: { start: match.state.time.start, end: Date.now() },
                  attachments: value.output.attachments,
                },
              })
              delete ctx.toolcalls[value.toolCallId]  // 清理追踪
              return
            }

            /**
             * 工具错误事件
             * 
             * 工具执行失败,更新状态为 error。
             * 特殊处理:如果是权限拒绝或问题拒绝,设置 blocked 标志。
             */
            case "tool-error": {
              const match = ctx.toolcalls[value.toolCallId]
              if (!match || match.state.status !== "running") return
              yield* session.updatePart({
                ...match,
                state: {
                  status: "error",
                  input: value.input ?? match.state.input,
                  error: value.error instanceof Error ? value.error.message : String(value.error),
                  time: { start: match.state.time.start, end: Date.now() },
                },
              })
              // 权限拒绝时根据 shouldBreak 决定是否阻塞
              if (value.error instanceof Permission.RejectedError || value.error instanceof Question.RejectedError) {
                ctx.blocked = ctx.shouldBreak
              }
              delete ctx.toolcalls[value.toolCallId]
              return
            }

            /**
             * 错误事件
             * 
             * 流处理中的非工具错误,直接抛出由上层处理。
             */
            case "error":
              throw value.error

            /**
             * 步骤开始事件
             * 
             * 标记一次 LLM 调用的开始。
             * 1. 记录文件系统快照(用于后续 diff 计算)
             * 2. 创建 step-start Part
             */
            case "start-step":
              ctx.snapshot = yield* snapshot.track()
              yield* session.updatePart({
                id: PartID.ascending(),
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.sessionID,
                snapshot: ctx.snapshot,
                type: "step-start",
              })
              return

            /**
             * 步骤结束事件
             * 
             * 标记一次 LLM 调用的结束,包含丰富的处理逻辑:
             * 1. 计算 token 使用量和费用
             * 2. 更新 Assistant Message 的 finish 原因
             * 3. 创建 step-finish Part
             * 4. 计算文件变更 patch
             * 5. 异步生成会话摘要
             * 6. 检查上下文溢出
             */
            case "finish-step": {
              // 计算使用量和费用
              const usage = Session.getUsage({
                model: ctx.model,
                usage: value.usage,
                metadata: value.providerMetadata,
              })
              ctx.assistantMessage.finish = value.finishReason
              ctx.assistantMessage.cost += usage.cost
              ctx.assistantMessage.tokens = usage.tokens
              
              // 创建 step-finish Part
              yield* session.updatePart({
                id: PartID.ascending(),
                reason: value.finishReason,
                snapshot: yield* snapshot.track(),  // 结束时的快照
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.assistantMessage.sessionID,
                type: "step-finish",
                tokens: usage.tokens,
                cost: usage.cost,
              })
              yield* session.updateMessage(ctx.assistantMessage)

              // 计算文件变更 patch
              if (ctx.snapshot) {
                const patch = yield* snapshot.patch(ctx.snapshot)
                if (patch.files.length) {
                  yield* session.updatePart({
                    id: PartID.ascending(),
                    messageID: ctx.assistantMessage.id,
                    sessionID: ctx.sessionID,
                    type: "patch",
                    hash: patch.hash,
                    files: patch.files,
                  })
                }
                ctx.snapshot = undefined
              }

              // 异步生成会话摘要(不阻塞主流程)
              yield* Effect.promise(() =>
                SessionSummary.summarize({
                  sessionID: ctx.sessionID,
                  messageID: ctx.assistantMessage.parentID,
                }),
              ).pipe(Effect.ignoreCause({ log: true, message: "session summary failed" }), Effect.forkDetach)

              // 检查上下文溢出
              if (
                !ctx.assistantMessage.summary &&
                isOverflow({ cfg: yield* config.get(), tokens: usage.tokens, model: ctx.model })
              ) {
                ctx.needsCompaction = true
              }
              return
            }

            /**
             * 文本开始事件
             * 
             * LLM 开始生成文本响应,创建 TextPart。
             */
            case "text-start":
              ctx.currentText = {
                id: PartID.ascending(),
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.assistantMessage.sessionID,
                type: "text",
                text: "",
                time: { start: Date.now() },
                metadata: value.providerMetadata,
              }
              yield* session.updatePart(ctx.currentText)
              return

            /**
             * 文本增量事件
             * 
             * 核心事件!实时追加文本并发布增量更新。
             * UI 订阅 PartDelta 事件实现打字机效果。
             */
            case "text-delta":
              if (!ctx.currentText) return
              ctx.currentText.text += value.text
              if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
              yield* session.updatePartDelta({
                sessionID: ctx.currentText.sessionID,
                messageID: ctx.currentText.messageID,
                partID: ctx.currentText.id,
                field: "text",
                delta: value.text,
              })
              return

            /**
             * 文本结束事件
             * 
             * 清理文本、触发插件钩子、设置结束时间。
             * experimental.text.complete 插件可修改最终文本。
             */
            case "text-end":
              if (!ctx.currentText) return
              ctx.currentText.text = ctx.currentText.text.trimEnd()
              ctx.currentText.text = (yield* plugin.trigger(
                "experimental.text.complete",
                {
                  sessionID: ctx.sessionID,
                  messageID: ctx.assistantMessage.id,
                  partID: ctx.currentText.id,
                },
                { text: ctx.currentText.text },
              )).text
              ctx.currentText.time = { start: Date.now(), end: Date.now() }
              if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
              yield* session.updatePart(ctx.currentText)
              ctx.currentText = undefined
              return

            /**
             * 流结束事件
             * 
             * 正常结束标记,无需特殊处理。
             */
            case "finish":
              return

            /**
             * 未处理事件类型
             * 
             * 记录日志以便发现新的事件类型。
             */
            default:
              log.info("unhandled", { ...value })
              return
          }
        })

        /**
         * 清理函数
         * 
         * 确保在中止或错误时正确收尾:
         * 1. 如果有未完成的 snapshot,计算 patch
         * 2. 如果有未完成的 text,设置结束时间
         * 3. 如果有未完成的 reasoning,设置结束时间
         * 4. 将所有 pending/running 的工具标记为 error
         * 5. 设置 Assistant Message 完成时间
         */
        const cleanup = Effect.fn("SessionProcessor.cleanup")(function* () {
          // 处理未完成的 snapshot
          if (ctx.snapshot) {
            const patch = yield* snapshot.patch(ctx.snapshot)
            if (patch.files.length) {
              yield* session.updatePart({
                id: PartID.ascending(),
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.sessionID,
                type: "patch",
                hash: patch.hash,
                files: patch.files,
              })
            }
            ctx.snapshot = undefined
          }

          // 处理未完成的 text
          if (ctx.currentText) {
            const end = Date.now()
            ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
            yield* session.updatePart(ctx.currentText)
            ctx.currentText = undefined
          }

          // 处理未完成的 reasoning
          for (const part of Object.values(ctx.reasoningMap)) {
            const end = Date.now()
            yield* session.updatePart({
              ...part,
              time: { start: part.time.start ?? end, end },
            })
          }
          ctx.reasoningMap = {}

          // 将未完成工具标记为 error
          const parts = yield* Effect.promise(() => MessageV2.parts(ctx.assistantMessage.id))
          for (const part of parts) {
            if (part.type !== "tool" || part.state.status === "completed" || part.state.status === "error") continue
            yield* session.updatePart({
              ...part,
              state: {
                ...part.state,
                status: "error",
                error: "Tool execution aborted",
                time: { start: Date.now(), end: Date.now() },
              },
            })
          }
          ctx.assistantMessage.time.completed = Date.now()
          yield* session.updateMessage(ctx.assistantMessage)
        })

        /**
         * 错误终止处理
         * 
         * 处理不可恢复的错误:
         * - 上下文溢出:设置 needsCompaction,发布错误事件
         * - 其他错误:设置 message.error,发布错误,设置状态为 idle
         */
        const halt = Effect.fn("SessionProcessor.halt")(function* (e: unknown) {
          log.error("process", { error: e, stack: JSON.stringify((e as any)?.stack) })
          const error = parse(e)
          if (MessageV2.ContextOverflowError.isInstance(error)) {
            ctx.needsCompaction = true
            yield* bus.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
            return
          }
          ctx.assistantMessage.error = error
          yield* bus.publish(Session.Event.Error, {
            sessionID: ctx.assistantMessage.sessionID,
            error: ctx.assistantMessage.error,
          })
          yield* status.set(ctx.sessionID, { type: "idle" })
        })

        /**
         * 核心处理流程
         * 
         * 这是处理器的入口函数,协调整个 LLM 调用流程:
         * 
         * 1. 初始化状态
         * 2. 调用 llm.stream() 获取事件流
         * 3. 使用 Effect Stream 处理每个事件
         * 4. 配置重试策略(SessionRetry.policy)
         * 5. 错误处理和中止处理
         * 6. 确保 cleanup 执行
         * 
         * @param streamInput - LLM 调用参数(system prompt, messages, tools 等)
         * @returns Result - 处理结果(compact/stop/continue)
         */
        const process = Effect.fn("SessionProcessor.process")(function* (streamInput: LLM.StreamInput) {
          log.info("process")
          ctx.needsCompaction = false
          // 根据配置决定是否遇到拒绝时中断循环
          ctx.shouldBreak = (yield* config.get()).experimental?.continue_loop_on_deny !== true

          yield* Effect.gen(function* () {
            ctx.currentText = undefined
            ctx.reasoningMap = {}
            const stream = llm.stream(streamInput)

            // 使用 Effect Stream 处理事件流
            yield* stream.pipe(
              Stream.tap((event) =>
                Effect.gen(function* () {
                  input.abort.throwIfAborted()  // 检查是否被用户取消
                  yield* handleEvent(event)      // 处理每个事件
                }),
              ),
              Stream.takeUntil(() => ctx.needsCompaction),  // 需要压缩时停止
              Stream.runDrain,  // 消费整个流
            )
          }).pipe(
            // 错误处理:排除中断异常
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) => Effect.fail(Cause.squash(cause)),
            ),
            // 重试策略:指数退避,最多 3 次
            Effect.retry(
              SessionRetry.policy({
                parse,
                set: (info) =>
                  status.set(ctx.sessionID, {
                    type: "retry",
                    attempt: info.attempt,
                    message: info.message,
                    next: info.next,
                  }),
              }),
            ),
            // 最终错误处理
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? halt(new DOMException("Aborted", "AbortError"))
                : halt(Cause.squash(cause)),
            ),
            Effect.ensuring(cleanup()),  // 确保 cleanup 始终执行
          )

          // 根据最终状态返回结果
          if (input.abort.aborted && !ctx.assistantMessage.error) {
            yield* abort()
          }
          if (ctx.needsCompaction) return "compact"
          if (ctx.blocked || ctx.assistantMessage.error || input.abort.aborted) return "stop"
          return "continue"
        })

        /**
         * 中止处理器
         * 
         * 用户取消时调用,执行 halt 和 cleanup。
         */
        const abort = Effect.fn("SessionProcessor.abort")(() =>
          Effect.gen(function* () {
            if (!ctx.assistantMessage.error) {
              yield* halt(new DOMException("Aborted", "AbortError"))
            }
            if (!ctx.assistantMessage.time.completed) {
              yield* cleanup()
              return
            }
            yield* session.updateMessage(ctx.assistantMessage)
          }),
        )

        // 返回处理器句柄
        return {
          get message() {
            return ctx.assistantMessage
          },
          partFromToolCall(toolCallID: string) {
            return ctx.toolcalls[toolCallID]
          },
          abort,
          process,
        } satisfies Handle
      })

      return Service.of({ create })
    }),
  )

  /**
   * 默认服务层
   * 
   * 提供所有依赖的默认实现,便于直接使用。
   * 使用 Layer.unwrap 处理 Effect.sync 返回的 Layer。
   */
  export const defaultLayer = Layer.unwrap(
    Effect.sync(() =>
      layer.pipe(
        Layer.provide(Session.defaultLayer),
        Layer.provide(Snapshot.defaultLayer),
        Layer.provide(Agent.defaultLayer),
        Layer.provide(LLM.defaultLayer),
        Layer.provide(Permission.layer),
        Layer.provide(Plugin.defaultLayer),
        Layer.provide(SessionStatus.layer.pipe(Layer.provide(Bus.layer))),
        Layer.provide(Bus.layer),
        Layer.provide(Config.defaultLayer),
      ),
    ),
  )

  // 创建 Effect 运行时,绑定到 Service
  const { runPromise } = makeRuntime(Service, defaultLayer)

  /**
   * 创建处理器实例 (公共 API)
   * 
   * 将 Effect 风格的 Handle 转换为 Promise 风格的 Info,
   * 便于常规异步代码使用。
   * 
   * @example
   * ```ts
   * const processor = await SessionProcessor.create({
   *   assistantMessage,
   *   sessionID,
   *   model,
   *   abort: new AbortController().signal,
   * })
   * const result = await processor.process(streamInput)
   * ```
   */
  export async function create(input: Input): Promise<Info> {
    const hit = await runPromise((svc) => svc.create(input))
    return {
      get message() {
        return hit.message
      },
      partFromToolCall(toolCallID: string) {
        return hit.partFromToolCall(toolCallID)
      },
      async process(streamInput: LLM.StreamInput) {
        const exit = await Effect.runPromiseExit(hit.process(streamInput), { signal: input.abort })
        if (Exit.isFailure(exit)) {
          if (Cause.hasInterrupts(exit.cause) && input.abort.aborted) {
            await Effect.runPromise(hit.abort())
            return "stop"
          }
          throw Cause.squash(exit.cause)
        }
        return exit.value
      },
    }
  }
}
