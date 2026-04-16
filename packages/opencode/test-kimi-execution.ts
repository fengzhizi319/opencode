#!/usr/bin/env bun
/**
 * Kimi For Coding 真实执行测试 - 使用 kimi-for-coding provider
 *
 * 用法:
 *   bun test-kimi-execution.ts
 *
 * 本脚本包含多个子测试，覆盖不同 agent 和配置方式：
 * 1. 代码中动态写入 opencode.json 来配置 Kimi For Coding（内联配置 + build agent）。
 * 2. 从预先写好的配置文件读取并加载 Kimi For Coding（外部配置 + build agent）。
 * 3. 单独测试 plan agent，观察其权限约束和响应行为。
 * 4. 先 plan 后 build 的完整工作流：同一个会话先用 plan agent 制定计划，再切换 build agent 执行代码生成。
 *
 * 前置条件:
 * - 已设置环境变量 KIMI_API_KEY
 */

// ============================================================
// 1. 核心模块导入
// ============================================================

// Session 是会话管理的入口：创建、查询、删除会话等
import { Session } from "@/session"
// SessionPrompt 负责把用户输入解析成 parts，并驱动 LLM 交互循环
import { SessionPrompt } from "@/session/prompt.ts"
// Provider 负责解析和加载 opencode.json 中的 provider / model 配置
import { Provider } from "@/provider/provider.ts"
// Instance 提供项目级别的 ALS（Async Local Storage）上下文
import { Instance } from "@/project/instance.ts"
// 日志系统，开启 DEBUG 后可看到 provider 初始化、tool 调用等详细日志
import { Log } from "@/util/log.ts"
// Agent 模块，用于获取 agent 的元信息，便于学习其权限与行为
import { Agent } from "@/agent/agent.ts"
// ToolRegistry 用于枚举某个 agent 在当前 model 下可用的所有 tool
import { ToolRegistry } from "@/tool/registry"
// SystemPrompt 用于生成 system prompt 片段（environment / skills）
import { SystemPrompt } from "@/session/system"
import path from "path"
import fs from "fs/promises"
import os from "os"
// ProviderID / ModelID 是 branded string，必须用 .make() 构造才安全
import { ModelID, ProviderID } from "@/provider/schema.ts"

// ============================================================
// 2. 常量定义
// ============================================================

// Kimi For Coding 在 API 中的模型标识为 "kimi-for-coding"
const MODEL = "kimi-for-coding"
// Kimi For Coding 的 provider ID
const PROVIDER = "kimi-for-coding"
// Kimi For Coding API 的 baseURL
const BASE_URL = "https://api.kimi.com/coding/v1"

// 初始化日志，print=true 表示输出到控制台，level=DEBUG 打印所有细节
await Log.init({ print: true, level: "DEBUG" })

// ============================================================
// 3. 调试辅助对象
// ============================================================

const DEBUG = {
  // 打印带阶段编号的大标题，方便在大量日志中快速定位
  stage: (num: number, name: string) => console.log(`\n${"=".repeat(60)}\n[阶段 ${num}] ${name}\n${"=".repeat(60)}`),
  // 标签化打印，data 为对象时自动 JSON 序列化
  log: (label: string, data?: any, _p0?: string) => {
    if (data !== undefined) {
      console.log(`[DEBUG] ${label}:`, typeof data === "object" ? JSON.stringify(data, null, 2) : data)
    } else {
      console.log(`[DEBUG] ${label}`)
    }
  },
  // 短分隔线，用于子步骤区分
  divider: () => console.log("-".repeat(60)),
}

// ============================================================
// 4. API Key 读取辅助函数
// ============================================================

/**
 * 获取 Kimi API Key 的优先级策略：
 * 1. 优先读取环境变量 KIMI_API_KEY。
 * 2. 若环境变量不存在，则读取默认文件 /Users/charles/Documents/AI/kimi_api。
 *    该文件支持 `export KIMI_API_KEY="..."` 的 shell 格式，也支持直接存放纯 key。
 */
async function getDefaultApiKey(): Promise<string | undefined> {
  const envKey = process.env.KIMI_API_KEY
  if (envKey) return envKey

  const defaultPath = "/Users/charles/Documents/AI/kimi_api"
  try {
    const content = await fs.readFile(defaultPath, "utf-8")
    // 尝试解析 export KIMI_API_KEY="..." 或 export KIMI_API_KEY='...' 格式
    const match = content.match(/KIMI_API_KEY=["'](.+?)["']/)
    if (match) return match[1]
    //  fallback：直接返回 trimmed 的纯文本内容
    const trimmed = content.trim()
    return trimmed || undefined
  } catch {
    return undefined
  }
}

// ============================================================
// 5. UT 预检：验证 Kimi For Coding 服务与 API Key 是否可用
// ============================================================

/**
 * 在正式进入 OpenCode 会话前，先直接调用 Kimi For Coding API 做最小化验证：
 * 1. 检查 KIMI_API_KEY 环境变量或默认文件是否存在。
 * 2. 调用 /v1/models 确认鉴权通过且服务端点可达。
 * 3. 发送一条极简的 chat completion，验证目标模型确实能返回结果。
 *
 * 关键修复点：
 * Kimi For Coding 要求请求必须携带特定的 User-Agent 头（如 claude-code/1.0），
 * 否则会返回 403 "only available for Coding Agents"。
 */
async function testKimiConnection() {
  DEBUG.stage(0, "UT - Kimi For Coding 连接与模型可用性预检")

  // 5.1 获取 API Key（优先环境变量，否则从默认文件读取）
  const key = await getDefaultApiKey()
  if (!key) {
    throw new Error("未找到环境变量 KIMI_API_KEY，且无法从默认文件读取 API Key")
  }
  DEBUG.log("API Key 已找到", `${key.slice(0, 6)}...${key.slice(-4)}`)

  // 5.2 检查服务端点可用性
  const health = await fetch(`${BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${key}` },
  })
  if (!health.ok) {
    throw new Error(`Kimi API /models 返回错误: ${health.status}`)
  }
  const modelsData = await health.json()
  const hasModel = modelsData.data?.some((m: any) => m.id === MODEL)
  DEBUG.log("Kimi API 健康检查通过", `端点列表中包含 ${MODEL}: ${hasModel}`)

  // 4.3 发送一条最小化 chat completion，验证模型真实可推理
  const chatRes = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST", // HTTP 请求方法，使用 POST 向 API 发送数据
    headers: {
      "Content-Type": "application/json", // 指定请求体内容格式为 JSON
      Authorization: `Bearer ${key}`, // Kimi API 身份认证令牌，用于验证请求合法性
      "User-Agent": "claude-code/1.0", // 客户端标识，模拟 claude-code 工具的用户代理字符串
    },
    body: JSON.stringify({
      model: MODEL, // 指定使用的模型名称（如 moonshot-v1-8k），告诉 API 使用哪个模型进行推理
      messages: [{ role: "user", content: "你好" }], // 消息数组，包含用户输入的角色和内容，这里发送简单的问候语测试模型响应
      max_tokens: 10, // 限制模型生成的最大 token 数量，设置为较小值以快速验证模型可用性并节省成本
    }),
  })
  if (!chatRes.ok) {
    throw new Error(`Kimi API /chat/completions 返回错误: ${chatRes.status}`)
  }
  const chatData = await chatRes.json()
  const msg = chatData.choices?.[0]?.message
  // content 可能为空字符串（reasoning 模型常把最终内容放在 reasoning_content 中），
  // 因此要用 || 而不是 ??，确保空字符串会 fallback 到 reasoning_content
  const answer = msg?.content || msg?.reasoning_content
  if (!answer) {
    throw new Error("Kimi 模型返回了空内容，可能模型未正确加载或受限")
  }
  DEBUG.log("UT 通过", `模型 ${MODEL} 可正常推理，示例回复: "${answer.trim().replace(/\n/g, " ")}"`)
  DEBUG.divider()
}

// ============================================================
// 5. Agent 调试函数（build / plan）
// ============================================================

/**
 * 通用 agent 调试函数。
 * 打印指定 agent 的 Info、可用工具、SystemPrompt 片段。
 * 这是学习不同 agent 行为差异的核心函数。
 */
async function debugAgent(agentName: string, model: Provider.Model) {
  console.log(`\n${"#".repeat(60)}\n# ${agentName.toUpperCase()} Agent 深度调试信息\n${"#".repeat(60)}`)

  // 5.1 获取 Agent 元信息
  // Agent.get 会合并内置默认值 + opencode.json 中用户的覆盖配置
  const info = await Agent.get(agentName)
  console.log(`\n[Agent Info - ${agentName}]`)
  console.log(JSON.stringify(info, null, 2))

  // 5.2 获取当前 agent + model 下可用的工具列表
  // ToolRegistry.tools 会过滤掉被 permission deny 的 tool，并做 model 级别的 schema 转换
  const tools = await ToolRegistry.tools({ modelID: ModelID.make(model.api.id), providerID: model.providerID }, info)
  console.log(`\n[可用工具数量 - ${agentName}] ${tools.length}`)
  tools.forEach((t, i) => {
    console.log(`  ${i + 1}. ${t.id}: ${t.description.substring(0, 100).replace(/\n/g, " ")}...`)
  })
  /**
   * [可用工具数量 - plan] 12
   *   1. invalid: Do not use...
   *   2. question: Use this tool when you need to ask the user questions during execution. This allows you to: 1. Gathe...
   *   3. bash: Executes a given bash command in a persistent shell session with optional timeout, ensuring proper h...
   *   4. read: Read a file or directory from the local filesystem. If the path does not exist, an error is returned...
   *   5. glob: - Fast file pattern matching tool that works with any codebase size - Supports glob patterns like "*...
   *   6. grep: - Fast content search tool that works with any codebase size - Searches file contents using regular ...
   *   7. edit: Performs exact string replacements in files.   Usage: - You must use your `Read` tool at least once ...
   *   8. write: Writes a file to the local filesystem.  Usage: - This tool will overwrite the existing file if there...
   *   9. task: Launch a new agent to handle complex, multistep tasks autonomously.  Available agent types and the t...
   *   10. webfetch: - Fetches content from a specified URL - Takes a URL and optional format as input - Fetches the URL ...
   *   11. todowrite: Use this tool to create and manage a structured task list for your current coding session. This help...
   *   12. skill: Load a specialized skill that provides domain-specific instructions and workflows. No skills are cur...
   */

  // 5.3 获取 System Prompt 片段
  const env = await SystemPrompt.environment(model)
  console.log(`\n[SystemPrompt.environment - ${agentName}]`)
  env.forEach((line, i) => {
    console.log(`  [${i}] ${line.substring(0, 200)}${line.length > 200 ? "..." : ""}`)
  })

  const skills = await SystemPrompt.skills(info)
  console.log(`\n[SystemPrompt.skills - ${agentName}]`)
  if (skills) {
    console.log(`${skills.substring(0, 500)}${skills.length > 500 ? "..." : ""}`)
  } else {
    console.log("  (无 skills 或已被权限禁用)")
  }

  console.log(`\n${"#".repeat(60)}\n`)
}

// 便捷封装：调试用 build agent
debugAgent.bind(null, "build")

// 便捷封装：调试用 plan agent
debugAgent.bind(null, "plan")

// ============================================================
// 7. 通用执行逻辑
// ============================================================

type ScenarioOpts = {
  name: string
  cfg: object
  agent: string
  promptText: string
  outFile?: string
  debugAgentName?: string
}

/**
 * 通用的 Kimi For Coding 测试执行逻辑。
 *
 * @param opts  场景配置，包含名称、opencode.json 配置、使用的 agent、提示词等
 *
 * 执行流程：
 * 1. 创建临时目录，把 cfg 写入为 opencode.json。
 * 2. Instance.provide 进入项目上下文。
 * 3. 加载 Provider，验证 kimi-for-coding provider 和模型已注册。
 * 4. 调用 debugAgent 打印学习信息（如果指定了 debugAgentName）。
 * 5. 创建 Session，构造用户提示词，调用 SessionPrompt.prompt 进入 LLM 循环。
 * 6. 检查输出文件是否生成，并打印 assistant 回复和工具调用。
 * 7. 保留临时目录供手动检查。
 */
async function runScenario(opts: ScenarioOpts) {
  const { name, cfg, agent, promptText, outFile, debugAgentName } = opts

  DEBUG.stage(1, `${name} - 准备工作目录与配置`)

  // 6.1 创建临时项目目录
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-kimi-test-"))
  DEBUG.log("临时目录", dir)
  //如临时目录: /var/folders/x4/33mx_11j04lg72467q8fc2w80000gn/T/opencode-kimi-test-wHYFyV

  // 6.2 将配置写入 opencode.json
  const cfgPath = path.join(dir, "opencode.json")
  //如：var/folders/x4/33mx_11j04lg72467q8fc2w80000gn/T/opencode-kimi-test-wHYFyV/opencode.json
  await Bun.write(cfgPath, JSON.stringify(cfg, null, 2))
  DEBUG.log("已写入 opencode.json", cfgPath)
  DEBUG.divider()

  // 6.3 进入项目实例上下文
  await Instance.provide({
    directory: dir,
    init: async () => DEBUG.log("项目实例初始化完成"),
    fn: async () => {
      // 6.4 加载 Provider
      DEBUG.stage(2, `${name} - 加载 Provider`)
      const providers = await Provider.list()
      //
      //
      const kimi = providers[ProviderID.make(PROVIDER)]
      if (!kimi) {
        throw new Error(`${PROVIDER} provider 未加载，请检查 opencode.json 配置`)
      }
      DEBUG.log("Provider 已加载", {
        id: kimi.id,
        name: kimi.name,
        models: Object.keys(kimi.models),
      })
      DEBUG.divider()

      // 6.5 解析目标模型
      DEBUG.stage(3, `${name} - 解析模型`)
      const model = await Provider.getModel(ProviderID.make(PROVIDER), ModelID.make(MODEL))
      DEBUG.log("模型解析成功", {
        id: model.id,
        providerID: model.providerID,
        name: model.name,
        npm: model.api.npm,
      })
      /**
       *
       *  "id": "kimi-for-coding",
       *   "providerID": "kimi-for-coding",
       *   "name": "Kimi For Coding",
       *   "npm": "@ai-sdk/anthropic"
       */
      DEBUG.divider()

      // 6.6 调试 Agent（如果指定了要调试的 agent 名称）
      if (debugAgentName) {
        DEBUG.stage(4, `${name} - ${debugAgentName} Agent 调试`)
        await debugAgent(debugAgentName, model)
        DEBUG.divider()
      }

      // 6.7 创建会话
      DEBUG.stage(5, `${name} - 创建会话`)
      const session = await Session.create({})
      DEBUG.log("会话创建成功", {
        id: session.id,
        title: session.title,
        directory: session.directory,
      })
      DEBUG.divider()

      // 6.8 准备用户提示词
      DEBUG.stage(6, `${name} - 构建用户消息`)
      DEBUG.log("用户提示词", promptText)
      // resolvePromptParts 会解析 @文件引用和 @agent 引用，这里纯文本只会得到 1 个 text part
      const parts = await SessionPrompt.resolvePromptParts(promptText)
      DEBUG.log("解析后的消息部分", `${parts.length} 个部分`)
      DEBUG.divider()

      // 6.9 调用 LLM
      DEBUG.stage(7, `${name} - 发送提示到 LLM (agent=${agent})`)
      DEBUG.log("开始会话执行，请稍候...")
      console.log("\n⏳ 正在处理，请稍候...\n")

      const t0 = Date.now()
      // prompt 会写入 user message，然后启动 loop() 驱动 agent-tool-llm 多轮交互
      // 当模型给出最终回复后，返回最后一条 assistant message
      const result = await SessionPrompt.prompt({
        sessionID: session.id,
        agent,
        parts,
        model: {
          providerID: model.providerID,
          modelID: model.id,
        },
      })
      const t1 = Date.now()
      DEBUG.log("SessionPrompt.prompt.result:", result)
      DEBUG.log("执行完成", {
        duration: `${((t1 - t0) / 1000).toFixed(2)} 秒`,
        messageID: result.info.id,
        role: result.info.role,
        finish: (result.info as any).finish,
        tokens: (result.info as any).tokens,
        cost: (result.info as any).cost,
      })
      DEBUG.divider()

      // 6.10 检查结果
      DEBUG.stage(8, `${name} - 验证执行结果`)
      if (outFile) {
        const target = path.join(dir, outFile)
        const exists = await fs
          .access(target)
          .then(() => true)
          .catch(() => false)
        if (exists) {
          DEBUG.log("文件创建成功", target)
          const content = await fs.readFile(target, "utf-8")
          console.log("\n" + "─".repeat(60))
          console.log("生成的文件内容:")
          console.log("─".repeat(60))
          console.log(content)
          console.log("─".repeat(60) + "\n")
        } else {
          DEBUG.log("文件未创建", target)
        }
      }

      // 拉取完整消息历史，用于展示 assistant 文本回复和 tool 调用记录
      const history = await Session.messages({ sessionID: session.id })
      DEBUG.log("会话消息数量", history.length)

      const assistant = history.find((m) => m.info.role === "assistant")
      if (assistant) {
        DEBUG.log("助手回复", {
          messageID: assistant.info.id,
          parts: assistant.parts.length,
        })
        const texts = assistant.parts.filter((p) => p.type === "text")
        texts.forEach((part, i) => {
          if (part.type === "text" && part.text) {
            console.log(`\n[回复片段 ${i + 1}]:`)
            console.log(part.text.substring(0, 500) + (part.text.length > 500 ? "..." : ""))
          }
        })
      }

      const toolParts = assistant?.parts.filter((p) => p.type === "tool") || []
      if (toolParts.length > 0) {
        DEBUG.log("工具调用数量", toolParts.length)
        toolParts.forEach((part, i) => {
          if (part.type === "tool") {
            console.log(`\n[工具调用 ${i + 1}]:`)
            console.log(`  工具: ${part.tool}`)
            console.log(`  状态: ${part.state.status}`)
            if (part.state.status === "completed") {
              console.log(`  输出: ${(part.state as any).output?.substring(0, 100) || "N/A"}`)
            }
          }
        })
      }

      DEBUG.divider()

      // 6.11 清理提示
      DEBUG.stage(9, `${name} - 资源清理`)
      DEBUG.log("保留临时目录供检查", dir)
      DEBUG.log("手动删除命令", `rm -rf ${dir}`)
      console.log(`
╔══════════════════════════════════════════════════════════════╗
║              ${name} 执行完成                          ║
╚══════════════════════════════════════════════════════════════╝
`)
    },
  })
}

// ============================================================
// 8. 配置构造辅助函数
// ============================================================

/**
 * 构造 opencode.json 配置对象。
 * 这里封装了 Kimi For Coding 的通用 provider 配置，
 * 方便内联配置和外部配置两种场景复用。
 * API Key 优先从环境变量读取，否则从默认文件读取。
 */
async function makeConfig(overrides?: { providerName?: string; modelName?: string }): Promise<object> {
  const apiKey = await getDefaultApiKey()
  return {
    $schema: "https://opencode.ai/config.json",
    enabled_providers: [PROVIDER],
    provider: {
      [PROVIDER]: {
        npm: "@ai-sdk/anthropic",
        name: overrides?.providerName ?? "Kimi For Coding",
        env: [],
        options: {
          baseURL: BASE_URL,
          apiKey,
          // 必须携带此头，否则 API 返回 403
          headers: {
            "User-Agent": "claude-code/1.0",
          },
        },
        models: {
          [MODEL]: {
            name: overrides?.modelName ?? "Kimi For Coding",
            tool_call: true,
            limit: {
              context: 262144,
              output: 32768,
            },
          },
        },
      },
    },
  }
}

// ============================================================
// 9. 各种测试场景
// ============================================================

/**
 * 测试场景 A：build agent + 内联配置。
 * build 是默认的 primary agent，拥有几乎所有 tool 的 allow 权限，
 * 适合直接执行代码生成、文件编辑等操作。
 */
async function testInlineConfig() {
  await runScenario({
    name: "内联配置",
    cfg: await makeConfig(),
    agent: "build",
    debugAgentName: "build",
    promptText: "请帮我写一个 Python 的快速排序算法，保存到 quick_sort.py 文件中",
    outFile: "quick_sort.py",
  })
}

/**
 * 测试场景 B：build agent + 外部配置。
 * 模拟从预先存在的 JSON 配置文件读取后加载的场景。
 */
async function testExistingConfig() {
  const raw = JSON.stringify(await makeConfig({ providerName: "Kimi For Coding (from existing file)" }))

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-kimi-cfg-"))
  const filePath = path.join(dir, "preset-config.json")
  await Bun.write(filePath, raw)
  DEBUG.log("预置配置文件已生成", filePath)

  const cfg = JSON.parse(await fs.readFile(filePath, "utf-8"))
  await runScenario({
    name: "外部配置",
    cfg,
    agent: "build",
    debugAgentName: "build",
    promptText: "请帮我写一个 Python 的快速排序算法，保存到 quick_sort.py 文件中",
    outFile: "quick_sort.py",
  })
}

/**
 * 测试场景 C：plan agent。
 * plan agent 是一种特殊的 primary agent，其核心约束是：
 * - edit 工具默认被 deny（不允许修改普通代码文件），
 * - 只允许编辑 plan 文件（.opencode/plans/*.md 和全局 plans 目录），
 * - 拥有 plan_exit 权限，可以在完成计划后退出 plan mode。
 *
 * 这个场景会展示 plan agent 如何生成一个文本形式的计划，而不会去修改代码文件。
 */
async function testPlanAgent() {
  await runScenario({
    name: "Plan Agent",
    cfg: await makeConfig(),
    agent: "plan",
    debugAgentName: "plan",
    promptText:
      "我想实现一个 Python 的快速排序算法。请帮我制定一个实现计划，包括：1) 核心函数设计 2) 测试用例 3) 文件结构。不要直接写代码，只输出计划。",
  })
}

/**
 * 测试场景 D：先 plan 后 build（Plan -> Build 工作流）。
 *
 * 这是 OpenCode 的核心工作流之一：
 * 1. 先用 plan agent 分析需求并制定计划（plan agent 不会随意修改代码，专注于思考）。
 * 2. 在同一个会话中，再发送一条消息给 build agent，由 build agent 根据上下文中的计划去实际执行代码生成。
 *
 * 该场景在同一个 Instance.provide 和同一个 Session 内完成，能完整演示
 * "agent 切换" 和 "计划-执行分离" 的协作模式。
 */
async function testPlanThenBuild() {
  const name = "先 Plan 后 Build"
  DEBUG.stage(1, `${name} - 准备工作目录与配置`)

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-kimi-plan-build-"))
  DEBUG.log("临时目录", dir)

  const cfgPath = path.join(dir, "opencode.json")
  await Bun.write(cfgPath, JSON.stringify(await makeConfig(), null, 2))
  DEBUG.log("已写入 opencode.json", cfgPath)
  DEBUG.divider()

  await Instance.provide({
    directory: dir,
    init: async () => DEBUG.log("项目实例初始化完成"),
    fn: async () => {
      // 8.1 加载 Provider 和模型
      DEBUG.stage(2, `${name} - 加载 Provider`)
      const providers = await Provider.list()
      const kimi = providers[ProviderID.make(PROVIDER)]
      if (!kimi) throw new Error(`${PROVIDER} provider 未加载`)
      DEBUG.log("Provider 已加载", { id: kimi.id, name: kimi.name, models: Object.keys(kimi.models) })
      DEBUG.divider()

      const model = await Provider.getModel(ProviderID.make(PROVIDER), ModelID.make(MODEL))
      DEBUG.log("模型解析成功", { id: model.id, providerID: model.providerID, name: model.name })
      DEBUG.divider()

      // 8.2 分别调试 plan 和 build agent，方便对比学习
      DEBUG.stage(3, `${name} - Plan Agent 调试`)
      await debugAgent("plan", model)
      DEBUG.divider()

      DEBUG.stage(4, `${name} - Build Agent 调试`)
      await debugAgent("build", model)
      DEBUG.divider()

      // 8.3 创建共享会话
      DEBUG.stage(5, `${name} - 创建共享会话`)
      const session = await Session.create({})
      DEBUG.log("会话创建成功", { id: session.id, title: session.title })
      DEBUG.divider()

      // ---------- 第一阶段：Plan ----------
      DEBUG.stage(6, `${name} - 第一阶段：Plan Agent 制定计划`)
      const planPrompt =
        "我想实现一个 Python 的快速排序模块，包含核心算法和单元测试。请帮我制定详细的实现计划，输出到 .opencode/plans/quick_sort_plan.md 文件中。不要写代码，只写计划。"
      DEBUG.log("Plan 提示词", planPrompt)

      const planParts = await SessionPrompt.resolvePromptParts(planPrompt)
      const planResult = await SessionPrompt.prompt({
        sessionID: session.id,
        agent: "plan",
        parts: planParts,
        model: { providerID: model.providerID, modelID: model.id },
      })

      DEBUG.log("Plan 阶段完成", {
        messageID: planResult.info.id,
        role: planResult.info.role,
        finish: (planResult.info as any).finish,
      })

      // 读取会话历史，展示 plan agent 的回复和工具调用
      const planHistory = await Session.messages({ sessionID: session.id })
      const planAssistant = planHistory.find((m) => m.info.role === "assistant")
      if (planAssistant) {
        const texts = planAssistant.parts.filter((p) => p.type === "text")
        texts.forEach((part, i) => {
          if (part.type === "text" && part.text) {
            console.log(`\n[Plan 回复片段 ${i + 1}]:`)
            console.log(part.text.substring(0, 500) + (part.text.length > 500 ? "..." : ""))
          }
        })
        const tools = planAssistant.parts.filter((p) => p.type === "tool")
        if (tools.length > 0) {
          DEBUG.log("Plan 阶段工具调用数量", tools.length)
          tools.forEach((part: any, i: number) => {
            console.log(`\n[Plan 工具调用 ${i + 1}]: ${part.tool} / ${part.state.status}`)
          })
        }
      }
      DEBUG.divider()

      // 检查 plan 文件是否被创建
      const planFile = path.join(dir, ".opencode", "plans", "quick_sort_plan.md")
      const planExists = await fs.access(planFile).then(() => true).catch(() => false)
      DEBUG.log("Plan 文件是否存在", planExists ? planFile : "未找到")
      if (planExists) {
        DEBUG.log("Plan 文件内容预览", (await fs.readFile(planFile, "utf-8")).substring(0, 300) + "...")
      }
      DEBUG.divider()

      // ---------- 第二阶段：Build ----------
      DEBUG.stage(7, `${name} - 第二阶段：Build Agent 执行代码生成`)
      const buildPrompt =
        "请根据上面制定的计划，直接生成 Python 快速排序的代码和单元测试，保存到 quick_sort.py 和 test_quick_sort.py 文件中。"
      DEBUG.log("Build 提示词", buildPrompt)

      const buildParts = await SessionPrompt.resolvePromptParts(buildPrompt)
      const t0 = Date.now()
      const buildResult = await SessionPrompt.prompt({
        sessionID: session.id,
        agent: "build",
        parts: buildParts,
        model: { providerID: model.providerID, modelID: model.id },
      })
      const t1 = Date.now()

      DEBUG.log("Build 阶段完成", {
        duration: `${((t1 - t0) / 1000).toFixed(2)} 秒`,
        messageID: buildResult.info.id,
        role: buildResult.info.role,
        finish: (buildResult.info as any).finish,
      })

      // 再次读取完整历史，重点展示 build agent 的最后回复
      const fullHistory = await Session.messages({ sessionID: session.id })
      const buildAssistant = fullHistory.filter((m) => m.info.role === "assistant").pop()
      if (buildAssistant) {
        const texts = buildAssistant.parts.filter((p) => p.type === "text")
        texts.forEach((part, i) => {
          if (part.type === "text" && part.text) {
            console.log(`\n[Build 回复片段 ${i + 1}]:`)
            console.log(part.text.substring(0, 500) + (part.text.length > 500 ? "..." : ""))
          }
        })
        const tools = buildAssistant.parts.filter((p) => p.type === "tool")
        if (tools.length > 0) {
          DEBUG.log("Build 阶段工具调用数量", tools.length)
          tools.forEach((part: any, i: number) => {
            console.log(`\n[Build 工具调用 ${i + 1}]: ${part.tool} / ${part.state.status}`)
            if (part.state.status === "completed" && part.state.output) {
              console.log(`  输出: ${part.state.output.substring(0, 100) || "N/A"}`)
            }
          })
        }
      }
      DEBUG.divider()

      // 检查代码文件是否生成
      for (const file of ["quick_sort.py", "test_quick_sort.py"]) {
        const target = path.join(dir, file)
        const exists = await fs.access(target).then(() => true).catch(() => false)
        if (exists) {
          DEBUG.log("✅ 代码文件已生成", target)
          const content = await fs.readFile(target, "utf-8")
          console.log(`\n--- ${file} ---`)
          console.log(content.substring(0, 300) + (content.length > 300 ? "..." : ""))
        } else {
          DEBUG.log("⚠️ 代码文件未生成", target)
        }
      }

      DEBUG.divider()
      DEBUG.stage(8, `${name} - 资源清理`)
      DEBUG.log("保留临时目录供检查", dir)
      DEBUG.log("手动删除命令", `rm -rf ${dir}`)
      console.log(`
╔══════════════════════════════════════════════════════════════╗
║              ${name} 执行完成                          ║
╚══════════════════════════════════════════════════════════════╝
`)
    },
  })
}

// ============================================================
// 10. 主入口
// ============================================================

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║        OpenCode 真实执行测试 - Kimi For Coding               ║
╚══════════════════════════════════════════════════════════════╝
`)

  try {

    // 先执行 UT 预检，确认 Kimi For Coding 可访问
    await testKimiConnection()
    await testPlanAgent()
    // 依次执行各种测试场景
    // await testInlineConfig()
    // await testExistingConfig()
    //
    // await testPlanThenBuild()

    console.log("\n✅ 所有测试场景执行完毕")
  } catch (err) {
    console.error("\n❌ 执行错误:")
    console.error(err)
    console.error("\n堆栈跟踪:")
    console.error((err as Error).stack)
    process.exit(1)
  }
}

main()
