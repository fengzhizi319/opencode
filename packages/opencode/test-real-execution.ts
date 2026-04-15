#!/usr/bin/env bun
/**
 * 真实执行测试 - 使用 Ollama Qwen3.5:0.8b 生成冒泡排序程序
 * 
 * 用法:
 *   bun test-real-execution.ts
 * 
 * 这个脚本会真实调用 LLM 并执行完整的会话流程。
 * 
 * 前置条件:
 * - 确保 Ollama 正在运行: ollama serve
 * - 确保已拉取模型: ollama pull qwen2.5:0.5b (或 qwen2.5:1.5b)
 * - 注意: Qwen3.5:0.8b 可能不存在，建议使用 qwen2.5:0.5b 或 qwen2.5:1.5b
 */

import { Brand, Effect } from "effect"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt.ts"
import { Provider } from "@/provider/provider.ts"
import { Instance } from "@/project/instance.ts"
import { Log } from "@/util/log.ts"
import path from "path"
import fs from "fs/promises"
import os from "os"
import type { ModelID, ProviderID } from "@/provider/schema.ts"

// 启用详细日志
await Log.init({ print: true, level: "DEBUG" })

const DEBUG = {
  stage: (num: number, name: string) => console.log(`\n${"=".repeat(60)}\n[阶段 ${num}] ${name}\n${"=".repeat(60)}`),
  log: (label: string, data?: any, p0?: string) => {
    if (data !== undefined) {
      console.log(`[DEBUG] ${label}:`, typeof data === "object" ? JSON.stringify(data, null, 2) : data)
    } else {
      console.log(`[DEBUG] ${label}`)
    }
  },
  divider: () => console.log("-".repeat(60)),
}

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║        OpenCode 真实执行测试 - Ollama Qwen2.5 模型            ║
╚══════════════════════════════════════════════════════════════╝
`)

  try {
    // ========== 阶段 1: 创建临时工作目录 ==========
    DEBUG.stage(1, "准备工作目录")
    
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-test-"))
    DEBUG.log("临时工作目录", tempDir)
    
    // 初始化项目实例
    await Instance.provide({
      directory: tempDir,
      init: async () => {
        DEBUG.log("项目实例初始化完成")
      },
      fn: async () => {
        // ========== 阶段 2: 配置 Ollama Provider ==========
        DEBUG.stage(2, "配置 Ollama Provider")
        
        // 检查 Ollama 是否可用
        DEBUG.log("检查 Ollama 连接...")
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
        
        // 设置 Ollama provider（如果尚未配置）
        const ollamaProvider = {
          id: "ollama",
          name: "Ollama",
          baseURL: "http://localhost:11434/v1",
          models: {
            "qwen2.5:0.5b": {
              id: "qwen2.5:0.5b",
              name: "Qwen 2.5 0.5B",
            },
          },
        }
        
        DEBUG.log("Ollama Provider 配置", ollamaProvider)
        DEBUG.divider()

        // ========== 阶段 3: 创建会话 ==========
        DEBUG.stage(3, "创建会话")
        
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
        
        const userPrompt = "请帮我写一个Python的冒泡排序算法，保存到 bubble_sort.py 文件中"
        DEBUG.log("用户提示词", userPrompt)
        
        // 解析提示词为 parts
        const parts = await SessionPrompt.resolvePromptParts(userPrompt)
        DEBUG.log("解析后的消息部分", parts.length, "个部分")
        DEBUG.divider()

        // ========== 阶段 5: 获取默认模型 ==========
        DEBUG.stage(5, "选择 LLM 模型")
        
        // 尝试获取 Ollama 模型
        let modelInfo
        try {
          // 首先尝试获取 qwen2.5:0.5b
          modelInfo = await Provider.getModel(<ProviderID>"ollama", <ModelID>"qwen2.5:0.5b")
          DEBUG.log("使用模型", {
            id: modelInfo.id,
            providerID: modelInfo.providerID,
            name: modelInfo.name,
          })
        } catch (error) {
          // 如果失败，尝试其他 Qwen 模型
          DEBUG.log("qwen2.5:0.5b 不可用，尝试其他模型...")
          try {
            modelInfo = await Provider.getModel(<string & Brand<"ProviderID">>"ollama", <string & Brand<"ModelID">>"qwen2.5:1.5b")
            DEBUG.log("使用备用模型", {
              id: modelInfo.id,
              providerID: modelInfo.providerID,
              name: modelInfo.name,
            })
          } catch (error2) {
            console.error("❌ 无法找到可用的 Qwen 模型")
            console.error("请运行: ollama pull qwen2.5:0.5b 或 ollama pull qwen2.5:1.5b")
            throw error2
          }
        }
        DEBUG.divider()

        // ========== 阶段 6: 发送提示并开始执行 ==========
        DEBUG.stage(6, "发送提示到 LLM")
        
        DEBUG.log("开始会话执行...")
        DEBUG.log("这将调用 LLM 并等待响应，可能需要一些时间")
        console.log("\n⏳ 正在处理，请稍候...\n")
        
        const startTime = Date.now()
        
        // 创建用户消息并启动会话循环
        const result = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",  // 使用默认的 build agent
          parts: parts,
          model: {
            providerID: modelInfo.providerID,
            modelID: modelInfo.id,
          },
        })
        
        const endTime = Date.now()
        const duration = ((endTime - startTime) / 1000).toFixed(2)
        
        // @ts-ignore
        DEBUG.log("执行完成", {
          duration: `${duration} 秒`,
          messageID: result.info.id,
          role: result.info.role,
          finish: result.info.finish,
          tokens: result.info.tokens,
          cost: result.info.cost,
        })
        DEBUG.divider()

        // ========== 阶段 7: 检查结果 ==========
        DEBUG.stage(7, "验证执行结果")
        
        // 检查文件是否创建
        const outputFile = path.join(tempDir, "bubble_sort.py")
        try {
          const fileExists = await fs.access(outputFile).then(() => true).catch(() => false)
          
          if (fileExists) {
            DEBUG.log("✅ 文件创建成功", outputFile)
            
            // 读取文件内容
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
        
        // 获取会话消息历史
        const messages = await Session.messages({ sessionID: session.id })
        DEBUG.log("会话消息数量", messages.length)
        
        // 显示助手回复
        const assistantMsg = messages.find(m => m.info.role === "assistant")
        if (assistantMsg) {
          DEBUG.log("助手回复", {
            messageID: assistantMsg.info.id,
            parts: assistantMsg.parts.length,
          })
          
          // 显示文本部分
          const textParts = assistantMsg.parts.filter(p => p.type === "text")
          textParts.forEach((part, i) => {
            if (part.type === "text" && part.text) {
              console.log(`\n[回复片段 ${i + 1}]:`)
              console.log(part.text.substring(0, 300) + (part.text.length > 300 ? "..." : ""))
            }
          })
        }
        
        // 显示工具调用
        const toolParts = assistantMsg?.parts.filter(p => p.type === "tool") || []
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

        // ========== 阶段 8: 清理 ==========
        DEBUG.stage(8, "清理资源")
        
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
    console.error("\n❌ 执行错误:")
    console.error(error)
    console.error("\n堆栈跟踪:")
    console.error(error.stack)
    process.exit(1)
  }
}

main()
