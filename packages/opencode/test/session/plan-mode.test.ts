// 导入必要的依赖和模块
import path from "path"
import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "@/flag/flag.ts"  // 功能标志模块，用于控制实验性功能
import { Instance } from "@/project/instance.ts"  // 项目实例管理模块
import { Session } from "@/session"  // 会话管理模块
import { SessionPrompt } from "@/session/prompt.ts"  // 会话提示词处理模块
import { tmpdir } from "../fixture/fixture"  // 临时目录工具函数

/**
 * 生成 Ollama 本地模型的配置对象
 * 该配置用于测试环境中连接本地 Ollama 服务，使用 Qwen 3.5 小模型进行快速测试
 * @param url - Ollama 服务的基础 URL（通常是代理服务器地址）
 * @returns 包含 schema、provider、agent 等完整配置的 JSON 对象
 */
function cfg(url: string) {
  return {
    // JSON Schema 验证地址，用于 IDE 提供配置自动补全和验证
    $schema: "https://opencode.ai/config.json",
    
    // 提供商配置：定义如何连接到 LLM 服务
    provider: {
      ollama: {
        // 指定使用的 NPM 包，这里使用 OpenAI 兼容的 SDK 来连接 Ollama
        npm: "@ai-sdk/openai-compatible",
        // 提供商在 UI 中显示的名称
        name: "Ollama (local)",
        // 连接选项配置
        options: {
          // API 密钥：Ollama 本地运行不需要认证，设置为占位符即可
          apiKey: "not-needed",
          // API 基础路径：指向 Ollama 服务的 v1 端点（OpenAI 兼容接口）
          baseURL: `${url}/v1`,
        },
        // 模型配置：定义可用的模型及其属性
        models: {
          // 模型 ID：qwen3.5:0.8b 是通义千问 3.5 的轻量级版本（仅 0.8B 参数）
          // 选择小模型可以加快测试速度，减少资源消耗
          "qwen3.5:0.8b": {
            // 模型显示名称
            name: "Qwen 3.5 0.8B",
          },
        },
      },
    },
    
    // Agent 配置：定义不同工作模式下使用的模型和执行参数
    agent: {
      // Plan 模式配置：用于生成计划和架构设计
      plan: {
        // 指定 plan 模式使用的模型（格式：提供商/模型ID）
        model: "ollama/qwen3.5:0.8b",
        // 最大执行步数：限制为 1 步以加快测试速度
        // 生产环境通常会设置更大的值以允许更复杂的推理
        steps: 1,
      },
      // Build 模式配置：用于实际执行代码生成和文件操作
      build: {
        // 指定 build 模式使用的模型
        model: "ollama/qwen3.5:0.8b",
        // 最大执行步数：同样限制为 1 步以加快测试
        steps: 1,
      },
    },
  }
}

// 每个测试用例执行后清理所有实例，避免状态污染
afterEach(async () => {
  await Instance.disposeAll()
})

// 测试套件：验证计划模式（plan mode）的完整流程
describe("plan mode flow", () => {
  // 测试用例 1：验证计划文件路径是否正确生成在 .opencode/plans 目录下
  test("computes the plan file path under .opencode/plans", async () => {
    // 创建带有 git 初始化的临时目录
    await using tmp = await tmpdir({ git: true })

    // 在临时目录上下文中提供项目实例
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // 创建一个新会话
        const session = await Session.create({})
        // 获取该会话的计划文件路径
        const plan = Session.plan(session)

        // 断言：计划文件路径必须以 .opencode/plans 开头
        expect(plan.startsWith(path.join(tmp.path, ".opencode", "plans"))).toBe(true)
        // 断言：计划文件路径必须以 .md 结尾（Markdown 格式）
        expect(plan.endsWith(".md")).toBe(true)

        // 清理：删除测试会话
        await Session.remove(session.id)
      },
    })
  })

  // 测试用例 2：验证在向真实 Ollama 服务发送请求时，正确注入了计划模式的提醒信息
  // 此测试通过代理服务器拦截请求，检查发送给 LLM 的消息内容
  test(
    "injects reminders into real ollama requests",
    async () => {
      // 存储所有捕获的请求体，用于后续验证
      const seen: unknown[] = []
      
      // 启动一个本地代理服务器，拦截并记录所有发往 Ollama 的请求
      const proxy = Bun.serve({
        port: 0,  // 自动分配可用端口
        async fetch(req) {
          const url = new URL(req.url)
          // 只处理 /v1/ 路径下的请求（OpenAI 兼容 API）
          if (!url.pathname.startsWith("/v1/")) return new Response("not found", { status: 404 })
          
          // 读取并解析请求体，保存到 seen 数组中
          const body = await req.text()
          if (body) seen.push(JSON.parse(body) as unknown)
          
          // 将请求转发到真实的 Ollama 服务（localhost:11434）
          return fetch(`http://localhost:11434${url.pathname}${url.search}`, {
            method: req.method,
            headers: req.headers,
            body: body || undefined,
          })
        },
      })

      try {
        // 创建临时目录，并初始化 opencode.json 配置文件
        await using tmp = await tmpdir({
          git: true,
          init: async (dir) => {
            // 写入配置，指向代理服务器而非直接连接 Ollama
            await Bun.write(path.join(dir, "opencode.json"), JSON.stringify(cfg(proxy.url.origin)))
          },
        })

        // 在临时目录上下文中执行测试逻辑
        await Instance.provide({
          directory: tmp.path,
          fn: async () => {
            // 步骤 1：创建新会话
            const session = await Session.create({})
            
            // 步骤 2：以 plan 模式发送提示词，触发计划生成
            await SessionPrompt.prompt({
              sessionID: session.id,
              agent: "plan",  // 指定使用 plan agent
              parts: [{ type: "text", text: "write a plan" }],  // 简单的文本提示
            })
            
            // 如果启用了实验性计划模式标志，则手动写入计划文件
            if (Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE) {
              await Bun.write(Session.plan(session), "# plan\n")
            }
            
            // 步骤 3：切换到 build 模式继续执行
            await SessionPrompt.prompt({
              sessionID: session.id,
              agent: "build",  // 切换到 build agent
              parts: [{ type: "text", text: "continue" }],
            })

            // 辅助函数：在捕获的请求中查找包含特定文本的请求体
            const body = (text: string) => seen.find((item) => JSON.stringify(item).includes(text))

            // 验证 1：根据功能标志检查不同的提醒文本是否被注入
            expect(
              Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE
                ? body("Plan mode is active. The user indicated that they do not want you to execute yet")  // 新模式提醒
                : body("# Plan Mode - System Reminder"),  // 旧模式提醒
            ).toBeDefined()
            
            // 验证 2：确认模式切换提醒已注入（从 plan 切换到 build）
            expect(body("Your operational mode has changed from plan to build")).toBeDefined()
            
            // 验证 3：确认退出只读模式的提醒已注入
            expect(body("You are no longer in read-only mode")).toBeDefined()

            // 清理：删除测试会话
            await Session.remove(session.id)
          },
        })
      } finally {
        // 确保无论测试成功或失败都关闭代理服务器
        proxy.stop(true)
      }
    },
    { timeout: 120000 },  // 设置 2 分钟超时，因为涉及真实 LLM 调用
  )
})
