#!/usr/bin/env bun
/**
 * 真实执行测试 - 使用 Ollama qwen3.5:0.8b 生成冒泡排序程序
 *
 * 用法:
 *   bun test-real-execution.ts
 *
 * 这个脚本会真实调用 LLM 并执行完整的会话流程。
 *
 * 前置条件:
 * - 确保 Ollama 正在运行: ollama serve
 * - 确保已拉取模型: ollama pull qwen2.5:0.5b (或自行创建 qwen3.5:0.8b 的 Modelfile)
 */

// 引入项目内部的 Session、Provider、Instance 等核心模块
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt.ts"
import { Provider } from "@/provider/provider.ts"
import { Instance } from "@/project/instance.ts"
import { Log } from "@/util/log.ts"
import path from "path"
import fs from "fs/promises"
import os from "os"
import { ModelID, ProviderID } from "@/provider/schema.ts"

// 模型名称常量，避免在代码中硬编码多次
const MODEL_NAME = "qwen3.5:0.8b"

// 初始化日志系统，开启 DEBUG 级别输出以便追踪完整执行链路
await Log.init({ print: true, level: "DEBUG" })

// 调试辅助对象，用于分阶段打印彩色分隔线和调试信息
const DEBUG = {
  // 打印大标题分隔线，标识当前进入第几个阶段
  stage: (num: number, name: string) => console.log(`\n${"=".repeat(60)}\n[阶段 ${num}] ${name}\n${"=".repeat(60)}`),
  // 打印标签化的调试信息，支持对象自动 JSON 序列化
  log: (label: string, data?: any, p0?: string) => {
    if (data !== undefined) {
      console.log(`[DEBUG] ${label}:`, typeof data === "object" ? JSON.stringify(data, null, 2) : data)
    } else {
      console.log(`[DEBUG] ${label}`)
    }
  },
  // 打印短分隔线，用于阶段内部子步骤区分
  divider: () => console.log("-".repeat(60)),
}

/**
 * UT（预检）函数：在启动完整会话前，先向 Ollama 发一条简单的 generate 请求，
 * 验证 qwen3.5:0.8b 模型确实可以正常加载并返回结果。
 * 如果这里失败，说明模型未下载或服务未启动，无需进入后续复杂流程。
 */
async function testModel() {
  DEBUG.stage(0, "UT - 模型可用性预检")
  DEBUG.log("向 Ollama 发送简单问题,验证模型可正常响应...")

  // 构造 Ollama 原生 generate API 请求体
  const body = JSON.stringify({
    model: MODEL_NAME,
    prompt: "1+1=",
    stream: false,
  })

  DEBUG.log("请求 URL", "http://localhost:11434/api/generate")
  DEBUG.log("请求体", body)

  const res = await fetch("http://localhost:11434/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  })

  // HTTP 状态码异常时直接抛出,中断整个脚本
  if (!res.ok) {
    const errorText = await res.text()
    throw new Error(`Ollama generate API 返回错误: ${res.status} ${res.statusText}\n响应体: ${errorText}`)
  }

  // 解析 JSON 响应,检查是否包含有效文本回复
  const data = await res.json()
  // DEBUG.log("完整响应", JSON.stringify(data, null, 2))
  
  const answer = data.response
  if (!answer || typeof answer !== "string") {
    throw new Error("Ollama 返回了空响应或格式异常,模型可能未正确加载\n响应数据: " + JSON.stringify(data))
  }

  DEBUG.log("✅ UT 通过", `模型 ${MODEL_NAME} 响应正常: "${answer.trim()}"`)
  DEBUG.divider()
}

/**
 * 主执行函数：按阶段完成目录准备、配置写入、Provider 加载、会话创建、
 * 提示词构建、LLM 调用、结果检查与资源清理。
 */
async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║        OpenCode 真实执行测试 - Ollama ${MODEL_NAME.padEnd(19)} ║
╚══════════════════════════════════════════════════════════════╝
`)

  try {
    // ========== 阶段 0: UT 预检 ==========
    // 先确认 Ollama 服务在线且目标模型可推理，避免后续进入复杂失败排查
    await testModel()

    // ========== 阶段 1: 创建临时工作目录并写入配置 ==========
    DEBUG.stage(1, "准备工作目录")

    // 在系统临时目录下创建一个带随机后缀的目录，作为本次测试的项目根目录
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-test-"))
    DEBUG.log("临时工作目录", tempDir)

    // 检查 Ollama tags API，列出当前本地已拉取的所有模型（仅用于信息展示）
    DEBUG.log("检查 Ollama 本地模型列表...")
    try {
      const response = await fetch("http://localhost:11434/api/tags")
      if (!response.ok) {
        throw new Error(`Ollama API 返回错误: ${response.status}`)
      }
      const data = await response.json()
      DEBUG.log("可用模型", data.models?.map((m: any) => m.name) || [])
    } catch (error) {
      console.error("❌ Ollama 未运行或无法连接")
      console.error("请先运行: ollama serve")
      console.error("然后拉取模型: ollama pull qwen2.5:0.5b")
      throw error
    }

    // OpenCode 通过项目根目录下的 opencode.json 来注册和启用 Provider。
    // 这里显式配置一个本地 Ollama provider，指定使用 @ai-sdk/openai-compatible
    // 来与 Ollama 的 OpenAI 兼容 API 通信，并注册 qwen3.5:0.8b 模型参数。
    const configPath = path.join(tempDir, "opencode.json")
    const config = {
      $schema: "https://opencode.ai/config.json",
      enabled_providers: ["ollama"],
      provider: {
        ollama: {
          npm: "@ai-sdk/openai-compatible",
          name: "Ollama (local)",
          env: [],
          options: {
            baseURL: "http://localhost:11434/v1",
          },
          models: {
            [MODEL_NAME]: {
              name: "Qwen 3.5 0.8B",
              tool_call: true,
              limit: {
                context: 16384,
                output: 4096,
              },
            },
          },
        },
      },
    }
    await Bun.write(configPath, JSON.stringify(config, null, 2))
    DEBUG.log("已写入 opencode.json", configPath)
    DEBUG.divider()

    // 使用 Instance.provide 创建项目上下文，所有后续操作都在这个目录的作用域内执行
    await Instance.provide({
      directory: tempDir,
      init: async () => {
        DEBUG.log("项目实例初始化完成")
      },
      fn: async () => {
        // ========== 阶段 2: 加载并校验 Ollama Provider ==========
        DEBUG.stage(2, "配置 Ollama Provider")

        // Provider.list() 会读取 opencode.json 并加载所有已启用的 provider
        const providers = await Provider.list()
        const ollama = providers[ProviderID.make("ollama")]
        if (!ollama) {
          throw new Error("Ollama provider 未加载，请检查 opencode.json 配置")
        }
        DEBUG.log("Ollama Provider 已加载", {
          id: ollama.id,
          name: ollama.name,
          models: Object.keys(ollama.models),
        })
        DEBUG.divider()

        // ========== 阶段 3: 创建会话 ==========
        DEBUG.stage(3, "创建会话")

        // Session.create 在数据库中创建一条新会话记录，并返回会话元信息
        DEBUG.log("创建新会话...")
        const session = await Session.create({})
        DEBUG.log("会话创建成功", {
          id: session.id,
          title: session.title,
          directory: session.directory,
        })
        DEBUG.divider()

        // ========== 阶段 4: 准备用户消息 ==========
        DEBUG.stage(4, "构建用户消息")

        // 用户原始提示词：要求生成冒泡排序并保存到文件
        const userPrompt = "请帮我写一个Python的冒泡排序算法，保存到 bubble_sort.py 文件中"
        DEBUG.log("用户提示词", userPrompt)

        // resolvePromptParts 会解析提示词中的 @文件引用和 agent 引用，
        // 返回一个 parts 数组（这里只有一条 text part）
        const parts = await SessionPrompt.resolvePromptParts(userPrompt)
        DEBUG.log("解析后的消息部分", `${parts.length} 个部分`)
        DEBUG.divider()

        // ========== 阶段 5: 解析目标模型 ==========
        DEBUG.stage(5, "选择 LLM 模型")

        // Provider.getModel 根据 providerID + modelID 从已加载的 provider 中解析出完整的模型配置
        const modelInfo = await Provider.getModel(ProviderID.make("ollama"), ModelID.make(MODEL_NAME))
        DEBUG.log("使用模型", {
          id: modelInfo.id,
          providerID: modelInfo.providerID,
          name: modelInfo.name,
        })
        DEBUG.divider()

        // ========== 阶段 6: 发送提示并启动会话循环 ==========
        DEBUG.stage(6, "发送提示到 LLM")

        DEBUG.log("开始会话执行...")
        DEBUG.log("这将调用 LLM 并等待响应，可能需要一些时间")
        console.log("\n⏳ 正在处理，请稍候...\n")

        const startTime = Date.now()

        // SessionPrompt.prompt 会：
        // 1. 创建 user message 并存入数据库
        // 2. 启动 loop() 进入多轮 agent-tool-llm 交互
        // 3. 当模型给出最终 assistant 回复后返回该消息对象
        const result = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build", // 使用默认的 build agent
          parts: parts,
          model: {
            providerID: modelInfo.providerID,
            modelID: modelInfo.id,
          },
        })

        const endTime = Date.now()
        const duration = ((endTime - startTime) / 1000).toFixed(2)

        // result 是最后一条 assistant 消息，包含 info 和 parts
        DEBUG.log("执行完成", {
          duration: `${duration} 秒`,
          messageID: result.info.id,
          role: result.info.role,
          finish: (result.info as any).finish,
          tokens: (result.info as any).tokens,
          cost: (result.info as any).cost,
        })
        DEBUG.divider()

        // ========== 阶段 7: 验证执行结果 ==========
        DEBUG.stage(7, "验证执行结果")

        // 检查 LLM 是否通过 Write 工具创建了 bubble_sort.py 文件
        const outputFile = path.join(tempDir, "bubble_sort.py")
        try {
          const fileExists = await fs.access(outputFile).then(() => true).catch(() => false)

          if (fileExists) {
            DEBUG.log("✅ 文件创建成功", outputFile)

            // 读取并打印生成的 Python 代码内容
            const content = await fs.readFile(outputFile, "utf-8")
            DEBUG.log("文件内容预览", content.substring(0, 200) + (content.length > 200 ? "..." : ""))

            console.log("\n" + "─".repeat(60))
            console.log("生成的 Python 代码:")
            console.log("─".repeat(60))
            console.log(content)
            console.log("─".repeat(60) + "\n")
          } else {
            DEBUG.log("⚠️  文件未创建", outputFile)
            DEBUG.log("LLM 可能选择了其他方式响应")
          }
        } catch (error) {
          DEBUG.log("❌ 检查文件时出错", error)
        }

        // 从数据库拉取完整会话消息历史，用于展示 assistant 回复和工具调用详情
        const messages = await Session.messages({ sessionID: session.id })
        DEBUG.log("会话消息数量", messages.length)

        // 找出 assistant 回复消息
        const assistantMsg = messages.find((m) => m.info.role === "assistant")
        if (assistantMsg) {
          DEBUG.log("助手回复", {
            messageID: assistantMsg.info.id,
            parts: assistantMsg.parts.length,
          })

          // 打印 assistant 消息中的文本片段
          const textParts = assistantMsg.parts.filter((p) => p.type === "text")
          textParts.forEach((part, i) => {
            if (part.type === "text" && part.text) {
              console.log(`\n[回复片段 ${i + 1}]:`)
              console.log(part.text.substring(0, 300) + (part.text.length > 300 ? "..." : ""))
            }
          })
        }

        // 打印 assistant 消息中的工具调用记录（如 Write、Read、Bash 等）
        const toolParts = assistantMsg?.parts.filter((p) => p.type === "tool") || []
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

        // ========== 阶段 8: 资源清理 ==========
        DEBUG.stage(8, "清理资源")

        // 临时目录保留供用户手动检查，脚本结束后不会自动删除
        DEBUG.log("保留临时目录供检查", tempDir)
        DEBUG.log("你可以手动删除它: rm -rf", tempDir)

        console.log(`
╔══════════════════════════════════════════════════════════════╗
║                    测试执行完成                                ║
╚══════════════════════════════════════════════════════════════╝
`)
      },
    })
  } catch (error) {
    // 捕获顶层异常，打印错误信息和堆栈后退出进程
    console.error("\n❌ 执行错误:")
    console.error(error)
    console.error("\n堆栈跟踪:")
    console.error((error as Error).stack)
    process.exit(1)
  }
}

// 启动脚本
main()
