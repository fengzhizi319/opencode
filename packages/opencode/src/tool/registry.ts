import { PlanExitTool } from "./plan"
import { QuestionTool } from "./question"
import { BashTool } from "./bash"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { BatchTool } from "./batch"
import { ReadTool } from "./read"
import { TaskTool } from "./task"
import { TodoWriteTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { SkillTool } from "./skill"
import type { Agent } from "../agent/agent"
import { Tool } from "./tool"
import { Config } from "../config/config"
import path from "path"
import { type ToolContext as PluginToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import z from "zod"
import { Plugin } from "../plugin"
import { ProviderID, type ModelID } from "../provider/schema"
import { WebSearchTool } from "./websearch"
import { CodeSearchTool } from "./codesearch"
import { Flag } from "@/flag/flag"
import { Log } from "@/util/log"
import { LspTool } from "./lsp"
import { Truncate } from "./truncate"
import { ApplyPatchTool } from "./apply_patch"
import { Glob } from "../util/glob"
import { pathToFileURL } from "url"
import { Effect, Layer, ServiceMap } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"

/**
 * ToolRegistry 模块：收集并初始化所有可用的工具。
 *
 * 工具来源包括：
 * - 内置工具（如 BashTool、ReadTool 等）
 * - 自定义工具（从配置目录加载）
 * - 插件提供的工具
 * - MCP 工具（在 SessionPrompt.resolveTools 中动态解析）
 */
export namespace ToolRegistry {
  const log = Log.create({ service: "tool.registry" })

  /** 状态类型定义：存储自定义工具列表 */
  type State = {
    custom: Tool.Info[]
  }

  /** 工具注册和检索的服务接口 */
  export interface Interface {
    /** 注册一个新工具到自定义工具列表中 */
    readonly register: (tool: Tool.Info) => Effect.Effect<void>
    /** 获取所有可用工具的 ID 列表 */
    readonly ids: () => Effect.Effect<string[]>
    /**
     * 根据模型和代理信息获取初始化的工具列表
     * @param model - 模型的提供者 ID 和模型 ID
     * @param agent - 可选的代理信息
     * @returns 初始化后的工具数组，包含工具 ID 和完整定义
     */
    readonly tools: (
      model: { providerID: ProviderID; modelID: ModelID },
      agent?: Agent.Info,
    ) => Effect.Effect<(Awaited<ReturnType<Tool.Info["init"]>> & { id: string })[]>
  }

  /** Effect-TS 服务标签，用于依赖注入 */
  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/ToolRegistry") {}

  /** Effect-TS 层，提供 ToolRegistry 服务的实现 */
  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      // 获取配置服务和插件服务
      const config = yield* Config.Service
      const plugin = yield* Plugin.Service

      /**
       * 创建实例状态缓存，用于存储自定义工具
       * 在首次访问时执行初始化逻辑，扫描并加载自定义工具
       */
      const cache = yield* InstanceState.make<State>(
        Effect.fn("ToolRegistry.state")(function* (ctx) {
          const custom: Tool.Info[] = []

          /**
           * 将插件工具定义转换为内部 Tool.Info 格式
           * @param id - 工具的唯一标识符
           * @param def - 插件提供的工具定义
           * @returns 符合内部规范的 Tool.Info 对象
           */
          function fromPlugin(id: string, def: ToolDefinition): Tool.Info {
            return {
              id,
              init: async (initCtx) => ({
                parameters: z.object(def.args),
                description: def.description,
                execute: async (args, toolCtx) => {
                  // 构建插件工具上下文，包含工作目录和工作树信息
                  const pluginCtx = {
                    ...toolCtx,
                    directory: ctx.directory,
                    worktree: ctx.worktree,
                  } as unknown as PluginToolContext
                  // 执行插件工具的实际逻辑
                  const result = await def.execute(args as any, pluginCtx)
                  // 对输出进行截断处理，防止过大的输出
                  const out = await Truncate.output(result, {}, initCtx?.agent)
                  return {
                    title: "",
                    output: out.truncated ? out.content : result,
                    metadata: { truncated: out.truncated, outputPath: out.truncated ? out.outputPath : undefined },
                  }
                },
              }),
            }
          }

          // 获取所有配置目录
          const dirs = yield* config.directories()
          // 扫描所有目录中的工具文件（支持 tool/*.ts、tools/*.js 等模式）
          const matches = dirs.flatMap((dir) =>
            Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true }),
          )
          // 如果有匹配的文件，等待配置依赖加载完成
          if (matches.length) yield* config.waitForDependencies()

          // 遍历所有找到的工具文件并加载
          for (const match of matches) {
            // 从文件名提取命名空间（去掉扩展名）
            const namespace = path.basename(match, path.extname(match))
            // 动态导入工具模块（Windows 需要特殊处理路径）
            const mod = yield* Effect.promise(
              () => import(process.platform === "win32" ? match : pathToFileURL(match).href),
            )
            // 遍历模块中的所有导出，转换为 Tool.Info 并添加到自定义工具列表
            for (const [id, def] of Object.entries<ToolDefinition>(mod)) {
              custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def))
            }
          }

          // 加载所有已安装的插件
          const plugins = yield* plugin.list()
          // 遍历插件，将其提供的工具转换为内部格式
          for (const p of plugins) {
            for (const [id, def] of Object.entries(p.tool ?? {})) {
              custom.push(fromPlugin(id, def))
            }
          }

          return { custom }
        }),
      )

      /**
       * 获取所有可用工具的完整列表
       * 根据配置和标志位动态决定启用哪些工具
       * @param custom - 自定义工具列表
       * @returns 所有可用工具的数组
       */
      const all = Effect.fn("ToolRegistry.all")(function* (custom: Tool.Info[]) {
        const cfg = yield* config.get()
        // 根据客户端类型或标志位决定是否启用问题工具
        const question = ["app", "cli", "desktop"].includes(Flag.OPENCODE_CLIENT) || Flag.OPENCODE_ENABLE_QUESTION_TOOL

        return [
          InvalidTool,
          ...(question ? [QuestionTool] : []),
          BashTool,
          ReadTool,
          GlobTool,
          GrepTool,
          EditTool,
          WriteTool,
          TaskTool,
          WebFetchTool,
          TodoWriteTool,
          WebSearchTool,
          CodeSearchTool,
          SkillTool,
          ApplyPatchTool,
          // 实验性 LSP 工具（仅在标志位启用时）
          ...(Flag.OPENCODE_EXPERIMENTAL_LSP_TOOL ? [LspTool] : []),
          // 批处理工具（仅在配置中启用时）
          ...(cfg.experimental?.batch_tool === true ? [BatchTool] : []),
          // 计划退出工具（仅在 CLI 客户端且实验性计划模式启用时）
          ...(Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE && Flag.OPENCODE_CLIENT === "cli" ? [PlanExitTool] : []),
          ...custom,
        ]
      })

      /**
       * 注册一个新工具
       * 如果工具已存在则更新，否则追加到列表末尾
       * @param tool - 要注册的工具信息
       */
      const register = Effect.fn("ToolRegistry.register")(function* (tool: Tool.Info) {
        const state = yield* InstanceState.get(cache)
        const idx = state.custom.findIndex((t) => t.id === tool.id)
        if (idx >= 0) {
          // 工具已存在，替换它
          state.custom.splice(idx, 1, tool)
          return
        }
        // 工具不存在，添加到列表末尾
        state.custom.push(tool)
      })

      /**
       * 获取所有可用工具的 ID 列表
       * @returns 工具 ID 字符串数组
       */
      const ids = Effect.fn("ToolRegistry.ids")(function* () {
        const state = yield* InstanceState.get(cache)
        const tools = yield* all(state.custom)
        return tools.map((t) => t.id)
      })

      /**
       * 根据模型和代理信息获取初始化后的工具列表
       * 执行逻辑：
       * 1. 获取所有可用工具
       * 2. 根据模型特性过滤工具（如不同模型使用不同的代码修改工具）
       * 3. 并行初始化所有过滤后的工具
       * 4. 触发插件钩子允许修改工具定义
       * 5. 返回完整的工具定义数组
       *
       * @param model - 模型的提供者 ID 和模型 ID
       * @param agent - 可选的代理信息
       * @returns 初始化后的工具数组
       */
      const tools = Effect.fn("ToolRegistry.tools")(function* (
        model: { providerID: ProviderID; modelID: ModelID },
        agent?: Agent.Info,
      ) {
        const state = yield* InstanceState.get(cache)
        const allTools = yield* all(state.custom)

        // 根据模型特性过滤工具
        const filtered = allTools.filter((tool) => {
          // codesearch 和 websearch 工具仅在特定条件下启用
          if (tool.id === "codesearch" || tool.id === "websearch") {
            return model.providerID === ProviderID.opencode || Flag.OPENCODE_ENABLE_EXA
          }

          // 对于 GPT 系列模型（非 OSS 和非 GPT-4），使用 apply_patch 工具
          const usePatch =
            model.modelID.includes("gpt-") && !model.modelID.includes("oss") && !model.modelID.includes("gpt-4")
          if (tool.id === "apply_patch") return usePatch
          // 对于其他模型，使用 edit 和 write 工具
          if (tool.id === "edit" || tool.id === "write") return !usePatch

          return true
        })

        // 并行初始化所有过滤后的工具
        return yield* Effect.forEach(
          filtered,
          Effect.fnUntraced(function* (tool) {
            using _ = log.time(tool.id)
            // 调用工具的 init 方法进行初始化
            const next = yield* Effect.promise(() => tool.init({ agent }))
            const output = {
              description: next.description,
              parameters: next.parameters,
            }
            // 触发插件钩子，允许插件修改工具定义
            yield* plugin.trigger("tool.definition", { toolID: tool.id }, output)
            return {
              id: tool.id,
              ...next,
              description: output.description,
              parameters: output.parameters,
            } as Awaited<ReturnType<Tool.Info["init"]>> & { id: string }
          }),
          { concurrency: "unbounded" },
        )
      })

      return Service.of({ register, ids, tools })
    }),
  )

  /** 默认层：自动注入配置和插件依赖 */
  export const defaultLayer = Layer.unwrap(
    Effect.sync(() => layer.pipe(Layer.provide(Config.defaultLayer), Layer.provide(Plugin.defaultLayer))),
  )

  /** 创建运行时环境，用于执行 Effect 程序 */
  const { runPromise } = makeRuntime(Service, defaultLayer)

  /**
   * 公开 API：注册一个工具
   * @param tool - 要注册的工具信息
   */
  export async function register(tool: Tool.Info) {
    return runPromise((svc) => svc.register(tool))
  }

  /**
   * 公开 API：获取所有工具 ID
   * @returns 工具 ID 数组
   */
  export async function ids() {
    return runPromise((svc) => svc.ids())
  }

  /**
   * 公开 API：获取初始化后的工具列表
   * @param model - 模型信息
   * @param agent - 可选的代理信息
   * @returns 初始化后的工具数组
   */
  export async function tools(
    model: {
      providerID: ProviderID
      modelID: ModelID
    },
    agent?: Agent.Info,
  ): Promise<(Awaited<ReturnType<Tool.Info["init"]>> & { id: string })[]> {
    return runPromise((svc) => svc.tools(model, agent))
  }
}
