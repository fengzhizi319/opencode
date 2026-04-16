#!/usr/bin/env bun
/**
 * Kimi For Coding 真实执行测试 - 使用 kimi-for-coding provider
 *
 * 用法:
 *   bun test-kimi-execution.ts
 *
 * 本脚本包含两个子测试：
 * 1. 代码中动态写入 opencode.json 来配置 Kimi For Coding（内联配置）。
 * 2. 从预先写好的配置文件读取并加载 Kimi For Coding（外部配置）。
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
// Agent 模块，用于获取 build agent 的元信息，便于学习其权限与行为
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
// 注意：虽然 models.dev 中该 provider 下注册了 "k2p5"，但实际的 /v1/models 和
// /v1/chat/completions 接口要求传入的 model ID 是 "kimi-for-coding"
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
// 4. UT 预检：验证 Kimi For Coding 服务与 API Key 是否可用
// ============================================================

/**
 * 在正式进入 OpenCode 会话前，先直接调用 Kimi For Coding API 做最小化验证：
 * 1. 检查 KIMI_API_KEY 环境变量是否存在。
 * 2. 调用 /v1/models 确认鉴权通过且服务端点可达。
 * 3. 发送一条极简的 chat completion，验证目标模型确实能返回结果。
 *
 * 关键修复点：
 * Kimi For Coding 要求请求必须携带特定的 User-Agent 头（如 claude-code/1.0），
 * 否则会返回 403 "only available for Coding Agents"。
 */
async function testKimiConnection() {
  DEBUG.stage(0, "UT - Kimi For Coding 连接与模型可用性预检")

  // 4.1 检查环境变量
  const key = process.env.KIMI_API_KEY
  if (!key) {
    throw new Error("未找到环境变量 KIMI_API_KEY，请先设置后再运行本脚本")
  }
  DEBUG.log("API Key 已找到", `${key.slice(0, 6)}...${key.slice(-4)}`)

  // 4.2 检查服务端点可用性
  // 使用 /v1/models 是一个轻量 GET 请求，不需要消耗模型 token
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
  // 必须带上 User-Agent: claude-code/1.0，否则会被 403 拦截
  const chatRes = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      "User-Agent": "claude-code/1.0",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: "你好" }],
      max_tokens: 10,
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
// 5. Build Agent 调试函数
// ============================================================

/**
 * 这是一个专门用于学习 build agent 内部结构的调试函数。
 * 在已进入 Instance.provide 上下文后调用，它会：
 * 1. 获取 build agent 的完整 Info 对象（权限、模式、提示词等）。
 * 2. 枚举该 agent 在当前 model 下被允许使用的所有 tool。
 * 3. 打印 system prompt 的 skills 片段和 environment 片段。
 */
async function debugBuildAgent(model: Provider.Model) {
  console.log(`\n${"#".repeat(60)}\n# Build Agent 深度调试信息\n${"#".repeat(60)}`)

  // 5.1 获取 Agent 元信息
  // Agent.get 会合并内置默认值 + opencode.json 中用户的覆盖配置
  const info = await Agent.get("build")
  console.log("\n[Agent Info]")
  console.log(JSON.stringify(info, null, 2))

  // 5.2 获取当前 agent + model 下可用的工具列表
  // ToolRegistry.tools 会过滤掉被 permission deny 的 tool，并做 model 级别的 schema 转换
  const tools = await ToolRegistry.tools(
    { modelID: ModelID.make(model.api.id), providerID: model.providerID },
    info,
  )
  console.log(`\n[可用工具数量] ${tools.length}`)
  tools.forEach((t, i) => {
    console.log(`  ${i + 1}. ${t.id}: ${t.description.substring(0, 100).replace(/\n/g, " ")}...`)
  })

  // 5.3 获取 System Prompt 片段
  // environment 包含工作目录、git 状态、平台、日期等上下文信息
  const env = await SystemPrompt.environment(model)
  console.log("\n[SystemPrompt.environment]")
  env.forEach((line, i) => {
    console.log(`  [${i}] ${line.substring(0, 200)}${line.length > 200 ? "..." : ""}`)
  })

  // skills 包含当前 agent 可用的 Skill 列表及其描述
  const skills = await SystemPrompt.skills(info)
  console.log("\n[SystemPrompt.skills]")
  if (skills) {
    console.log(`${skills.substring(0, 500)}${skills.length > 500 ? "..." : ""}`)
  } else {
    console.log("  (无 skills 或已被权限禁用)")
  }

  console.log(`\n${"#".repeat(60)}\n`)
}

// ============================================================
// 6. 通用执行逻辑：创建目录 -> 加载配置 -> 会话 -> 检查
// ============================================================

/**
 * 通用的 Kimi For Coding 测试执行逻辑。
 *
 * @param name  本次测试场景的名称，用于日志区分
 * @param cfg   opencode.json 的完整配置对象（已包含 $schema）
 *
 * 执行流程：
 * 1. 创建临时目录，把 cfg 写入为 opencode.json。
 * 2. Instance.provide 进入项目上下文。
 * 3. 加载 Provider，验证 kimi-for-coding provider 和模型已注册。
 * 4. 调用 debugBuildAgent 打印学习信息。
 * 5. 创建 Session，构造用户提示词，调用 SessionPrompt.prompt 进入 LLM 循环。
 * 6. 检查输出文件是否生成，并打印 assistant 回复和工具调用。
 * 7. 保留临时目录供手动检查。
 */
async function runScenario(name: string, cfg: object) {
  DEBUG.stage(1, `${name} - 准备工作目录与配置`)

  // 6.1 创建临时项目目录
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-kimi-test-"))
  DEBUG.log("临时目录", dir)

  // 6.2 将配置写入 opencode.json
  // 这是 OpenCode 识别 provider / model / agent 等设置的核心入口
  const cfgPath = path.join(dir, "opencode.json")
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
      DEBUG.divider()

      // 6.6 调试 Build Agent
      DEBUG.stage(4, `${name} - Build Agent 调试`)
      await debugBuildAgent(model)
      DEBUG.divider()

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
      const promptText = "请帮我写一个 Python 的快速排序算法，保存到 quick_sort.py 文件中"
      DEBUG.log("用户提示词", promptText)
      // resolvePromptParts 会解析 @文件引用和 @agent 引用，这里纯文本只会得到 1 个 text part
      const parts = await SessionPrompt.resolvePromptParts(promptText)
      DEBUG.log("解析后的消息部分", `${parts.length} 个部分`)
      DEBUG.divider()

      // 6.9 调用 LLM
      DEBUG.stage(7, `${name} - 发送提示到 LLM`)
      DEBUG.log("开始会话执行，请稍候...")
      console.log("\n⏳ 正在处理，请稍候...\n")

      const t0 = Date.now()
      // prompt 会写入 user message，然后启动 loop() 驱动 agent-tool-llm 多轮交互
      // 当模型给出最终回复后，返回最后一条 assistant message
      const result = await SessionPrompt.prompt({
        sessionID: session.id,
        agent: "build", // 使用默认的 primary agent
        parts,
        model: {
          providerID: model.providerID,
          modelID: model.id,
        },
      })
      const t1 = Date.now()
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
      const outFile = path.join(dir, "quick_sort.py")
      const exists = await fs.access(outFile).then(() => true).catch(() => false)
      if (exists) {
        DEBUG.log("文件创建成功", outFile)
        const content = await fs.readFile(outFile, "utf-8")
        console.log("\n" + "─".repeat(60))
        console.log("生成的 Python 代码:")
        console.log("─".repeat(60))
        console.log(content)
        console.log("─".repeat(60) + "\n")
      } else {
        DEBUG.log("文件未创建", outFile)
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
            console.log(part.text.substring(0, 300) + (part.text.length > 300 ? "..." : ""))
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
// 7. 两种配置方式的测试函数
// ============================================================

/**
 * 测试场景 A：完全在代码中构造 opencode.json 配置对象并写入临时目录。
 * 这种方式适合 CI、自动化测试或需要动态拼接配置参数的场景。
 *
 * 关键修复：在 provider options 中显式注入 User-Agent 头，
 * 否则 Kimi For Coding 会在 chat completions 时返回 403。
 */
async function testInlineConfig() {
  const cfg = {
    $schema: "https://opencode.ai/config.json",
    enabled_providers: [PROVIDER],
    provider: {
      [PROVIDER]: {
        // models.dev 中注册 kimi-for-coding 使用的 SDK 为 @ai-sdk/anthropic
        npm: "@ai-sdk/anthropic",
        name: "Kimi For Coding",
        env: [],
        options: {
          baseURL: BASE_URL,
          apiKey: process.env.KIMI_API_KEY,
          // 必须携带此头，否则 API 返回 403
          headers: {
            "User-Agent": "claude-code/1.0",
          },
        },
        models: {
          [MODEL]: {
            name: "Kimi For Coding",
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
  await runScenario("内联配置", cfg)
}

/**
 * 测试场景 B：模拟从外部配置文件读取后加载。
 */
async function testExistingConfig() {
  const raw = JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    enabled_providers: [PROVIDER],
    provider: {
      [PROVIDER]: {
        npm: "@ai-sdk/anthropic",
        name: "Kimi For Coding (from existing file)",
        env: [],
        options: {
          baseURL: BASE_URL,
          apiKey: process.env.KIMI_API_KEY,
          headers: {
            "User-Agent": "claude-code/1.0",
          },
        },
        models: {
          [MODEL]: {
            name: "Kimi For Coding",
            tool_call: true,
            limit: {
              context: 262144,
              output: 32768,
            },
          },
        },
      },
    },
  })

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-kimi-cfg-"))
  const filePath = path.join(dir, "preset-config.json")
  await Bun.write(filePath, raw)
  DEBUG.log("预置配置文件已生成", filePath)

  const cfg = JSON.parse(await fs.readFile(filePath, "utf-8"))
  await runScenario("外部配置", cfg)
}

// ============================================================
// 8. 主入口
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

    // 依次执行两种配置方式的测试
    await testInlineConfig()
    await testExistingConfig()

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
