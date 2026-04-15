#!/usr/bin/env bun
/**
 * 调试执行脚本 - 冒泡排序任务
 * 
 * 用法:
 *   bun debug-execution.ts
 * 
 * 这个脚本会模拟执行 "写冒泡排序算法" 任务，并在关键位置输出调试信息。
 * 
 * 目的：
 * - 展示 OpenCode 从接收用户请求到生成代码的完整执行流程
 * - 帮助开发者理解系统内部的工作机制
 * - 用于调试和问题排查
 * 
 * 注意：
 * - 这是 TypeScript 版本，需要完整的 Effect.ts 运行时环境
 * - 如需快速查看流程，可使用 debug-execution-node.mjs（纯 JavaScript 版本）
 */

// 导入核心模块
import { Effect } from "effect"  // Effect.ts 函数式编程库
import { Session } from "@/session"  // 会话管理
import { SessionPrompt } from "@/session/prompt.ts"  // 会话提示处理
import { Agent } from "@/agent/agent.ts"  // AI Agent 管理
import { Skill } from "@/skill"  // 专业技能系统
import { ToolRegistry } from "@/tool/registry.ts"  // 工具注册表
import { Provider } from "@/provider/provider.ts"  // LLM 提供商管理
import { Instance } from "@/project/instance.ts"  // 项目实例管理
import { Log } from "@/util/log.ts"  // 日志系统

// 启用详细日志（print: true 表示输出到控制台，level: "DEBUG" 表示最详细级别）
await Log.init({ print: true, level: "DEBUG" })

// 调试工具对象，提供统一的日志输出格式
const DEBUG = {
  // 输出阶段标题，使用分隔线突出显示
  stage: (num: number, name: string) => console.log(`\n${"=".repeat(60)}\n[阶段 ${num}] ${name}\n${"=".repeat(60)}`),
  // 输出调试信息，支持对象自动格式化
  log: (label: string, data?: any) => {
    if (data !== undefined) {
      console.log(`[DEBUG] ${label}:`, typeof data === "object" ? JSON.stringify(data, null, 2) : data)
    } else {
      console.log(`[DEBUG] ${label}`)
    }
  },
  // 输出分隔线，用于区分不同的输出块
  divider: () => console.log("-".repeat(60)),
}

// 主函数：模拟完整的任务执行流程
async function main() {
  // 输出欢迎横幅
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║           OpenCode 执行调试 - Python 冒泡排序任务              ║
╚══════════════════════════════════════════════════════════════╝
`)

  try {
    // ========== 阶段 1: 初始化 ==========
    // 目的：初始化项目实例，设置工作目录和环境配置
    DEBUG.stage(1, "项目初始化")
    
    DEBUG.log("正在初始化项目实例...")
    // 注意:实际执行时需要真实的 Instance 初始化
    // 这里为了演示,我们跳过实际初始化
    // 实际代码:await Instance.initialize()
    const mockDirectory = "/home/user/myproject"
    DEBUG.log("工作目录", mockDirectory)
    DEBUG.divider()

    // ========== 阶段 2: 创建会话 ==========
    // 目的：为当前任务创建一个新的会话，用于跟踪对话历史和状态
    DEBUG.stage(2, "创建会话")
    
    DEBUG.log("创建新会话...")
    // 实际代码：const session = await Session.create({})
    // 模拟会话数据
    const mockSession = {
      id: "01HQ8V8X1Y2Z3W4V5U6T7S8R9Q",  // 会话唯一标识符（ULID 格式）
      title: "New session - 2026-03-30T10:30:00.000Z",  // 会话标题（自动生成）
      directory: "/home/user/myproject",  // 会话关联的项目目录
    }
    DEBUG.log("会话创建成功", mockSession)
    DEBUG.divider()

    // ========== 阶段 3: Agent 选择 ==========
    // 目的：选择合适的 AI Agent 来处理任务（不同 Agent 有不同的能力和权限）
    DEBUG.stage(3, "Agent 选择")
    
    DEBUG.log("获取默认 Agent...")
    // 实际代码：
    // const agentName = await Agent.defaultAgent()
    // const agent = await Agent.get(agentName)
    // 模拟 build Agent（默认的代码构建 Agent）
    const mockAgent = {
      name: "build",  // Agent 名称
      mode: "primary",  // 运行模式：primary（主要）或 secondary（辅助）
      description: "The default agent. Executes tools based on configured permissions.",
      // 权限配置：定义 Agent 可以执行的操作
      permission: [
        { permission: "*", pattern: "*", action: "allow" },  // 允许所有操作（通配符）
        { permission: "doom_loop", pattern: "*", action: "ask" },  // 无限循环检测需要询问用户
        { permission: "edit", pattern: "*", action: "allow" },  // 允许编辑文件
        { permission: "bash", pattern: "*", action: "ask" },  // 执行 shell 命令需要询问
      ],
      model: undefined, // 使用默认模型（由 Provider 决定）
    }
    DEBUG.log("使用 Agent", mockAgent)
    DEBUG.divider()

    // ========== 阶段 4: Skill 加载 ==========
    // 目的：加载可用的 Skills（专业技能），增强 Agent 在特定领域的能力
    DEBUG.stage(4, "Skill 加载")
    
    DEBUG.log("获取可用 Skills...")
    // 实际代码：const skills = await Skill.available(mockAgent as any)
    // 模拟可用的 Skills
    const mockSkills = [
      { name: "python-best-practices", description: "Python coding best practices" },  // Python 最佳实践
      { name: "algorithm-templates", description: "Common algorithm templates" },  // 算法模板库
    ]
    DEBUG.log(`找到 ${mockSkills.length} 个可用 Skills`, mockSkills.map(s => s.name))
    DEBUG.divider()

    // ========== 阶段 5: 工具初始化 ==========
    // 目的：初始化工具注册表，获取 Agent 可以使用的工具列表
    DEBUG.stage(5, "工具初始化")
    
    DEBUG.log("从 ToolRegistry 获取工具...")
    // 实际代码：
    // const model = await Provider.defaultModel()
    // const tools = await ToolRegistry.tools({ modelID: model.id, providerID: model.providerID }, mockAgent as any)
    // 模拟可用工具
    const mockTools = [
      { id: "bash", description: "Execute shell commands" },  // 执行 shell 命令
      { id: "read", description: "Read files or directories" },  // 读取文件或目录
      { id: "edit", description: "Edit files by string replacement" },  // 编辑文件（字符串替换）
      { id: "write", description: "Create or overwrite files" },  // 创建或覆盖文件
      { id: "skill", description: "Load specialized skills" },  // 加载专业技能
      { id: "glob", description: "Find files by glob pattern" },  // 按模式查找文件
      { id: "grep", description: "Search code by regex" },  // 按正则表达式搜索代码
    ]
    DEBUG.log(`可用工具 (${mockTools.length} 个)`, mockTools.map(t => t.id))
    DEBUG.divider()

    // ========== 阶段 6: System Prompt 组装 ==========
    // 目的：构建发送给 LLM 的系统提示词，包含上下文信息和指令
    DEBUG.stage(6, "System Prompt 组装")
    
    // 组装多段系统提示词
    const systemPrompts = [
      "You are an expert software engineer...",  // 角色定义
      `## Available Skills\n${mockSkills.map(s => `- ${s.name}: ${s.description}`).join("\n")}`,  // 可用技能列表
      "Current time: 2026-03-30 10:30:00",  // 当前时间
      "Current directory: /home/user/myproject",  // 当前工作目录
    ]
    DEBUG.log(`组装了 ${systemPrompts.length} 段 System Prompt`)
    // 逐段输出系统提示词（截断过长内容以便阅读）
    systemPrompts.forEach((prompt, i) => {
      console.log(`\n[${i + 1}] ${prompt.substring(0, 80)}${prompt.length > 80 ? "..." : ""}`)
    })
    DEBUG.divider()

    // ========== 阶段 7: 用户消息 ==========
    // 目的：创建用户输入消息，作为任务的起点
    DEBUG.stage(7, "用户消息创建")
    
    // 模拟用户消息结构（实际会通过 SessionPrompt.prompt() 创建）
    const userMessage = {
      id: "msg_01HQ8V9A2B3C4D5E6F7G8H9I0J",  // 消息唯一标识符
      role: "user",  // 消息角色：user（用户）或 assistant（助手）
      sessionID: mockSession.id,  // 关联的会话 ID
      time: { created: Date.now() },  // 消息创建时间戳
      agent: "build",  // 处理该消息的 Agent
      model: { providerID: "openai", modelID: "gpt-4" },  // 使用的 LLM 模型
      parts: [
        { type: "text", text: "请帮我写一个Python的冒泡排序算法" }  // 消息内容部分（可以是文本、图片等）
      ],
    }
    DEBUG.log("User Message", userMessage)
    DEBUG.divider()

    // ========== 阶段 8: LLM 调用模拟 ==========
    // 目的：模拟 LLM 流式响应过程，展示事件序列和工具调用
    DEBUG.stage(8, "LLM 流处理 (第一轮)")
    
    console.log("\n[事件序列]")
    // 模拟 LLM 流式输出的事件序列
    const events = [
      { type: "start", desc: "LLM 流开始" },  // 流开始事件
      { type: "text-start", desc: "文本开始生成" },  // 文本块开始
      { type: "text-delta", desc: "我来帮你写一个 Python 的冒泡排序算法。", isContent: true },  // 文本增量（实际输出内容）
      { type: "text-end", desc: "文本生成结束" },  // 文本块结束
      { type: "tool-input-start", desc: "工具输入开始: write" },  // 工具输入开始
      {  // 工具调用事件
        type: "tool-call", 
        desc: "工具调用: write", 
        detail: {
          toolName: "write",  // 调用的工具名称
          input: {
            filePath: "/home/user/myproject/bubble_sort.py",  // 目标文件路径
            content: "def bubble_sort(arr):\n    n = len(arr)\n    for i in range(n):\n        for j in range(0, n - i - 1):\n            if arr[j] > arr[j + 1]:\n                arr[j], arr[j + 1] = arr[j + 1], arr[j]\n    return arr\n",  // 文件内容
          }
        }
      },
      { type: "tool-result", desc: "工具执行成功", detail: { output: "File created" } },  // 工具执行结果
      { type: "finish-step", desc: "步骤完成", detail: { tokens: { total: 245, input: 180, output: 65 } } },  // 步骤完成（包含 Token 统计）
    ]
    
    // 遍历并输出每个事件的详细信息
    events.forEach((e, i) => {
      console.log(`${i + 1}. [${e.type}] ${e.desc}`)
      if (e.isContent) {
        console.log(`   内容: "${e.desc}"`)
      }
      if (e.detail) {
        console.log(`   详情:`, JSON.stringify(e.detail, null, 2).split("\n").map((l: string) => "   " + l).join("\n"))
      }
    })
    DEBUG.divider()

    // ========== 阶段 9: WriteTool 执行 ==========
    // 目的：展示文件写入工具的详细执行过程，包括权限检查和文件操作
    DEBUG.stage(9, "WriteTool 执行详情")
    
    // 输出工具调用参数
    DEBUG.log("工具参数", {
      filePath: "/home/user/myproject/bubble_sort.py",
      content: `def bubble_sort(arr):
    n = len(arr)
    for i in range(n):
        for j in range(0, n - i - 1):
            if arr[j] > arr[j + 1]:
                arr[j], arr[j + 1] = arr[j + 1], arr[j]
    return arr`,
    })
    
    // 展示权限检查流程（ask -> allow 表示先询问用户，用户确认后执行）
    DEBUG.log("权限检查", {
      permission: "edit",  // 权限类型：编辑
      pattern: "bubble_sort.py",  // 匹配的文件模式
      action: "ask -> allow (用户确认)",  // 动作：询问后允许
    })
    
    // 展示文件操作详情
    DEBUG.log("文件操作", {
      operation: "write",  // 操作类型：写入
      path: "/home/user/myproject/bubble_sort.py",  // 文件路径
      size: "156 bytes",  // 文件大小
      status: "success",  // 操作状态
    })
    
    // 发布文件系统事件（通知其他组件文件已更改）
    DEBUG.log("发布事件", ["File.Event.Edited", "FileWatcher.Event.Updated"])
    DEBUG.divider()

    // ========== 阶段 10: 第二轮迭代 ==========
    // 目的：模拟 LLM 的第二轮响应，确认任务完成并给出最终回复
    DEBUG.stage(10, "LLM 流处理 (第二轮)")
    
    console.log("\n[事件序列]")
    // 第二轮的事件序列（通常更简单，因为主要工作是总结）
    const events2 = [
      { type: "start", desc: "LLM 流开始" },
      { type: "text-start", desc: "文本开始生成" },
      { type: "text-delta", desc: "已经完成！我在 /home/user/myproject/bubble_sort.py 创建了冒泡排序算法。", isContent: true },
      { type: "text-end", desc: "文本生成结束" },
      { type: "finish-step", desc: "步骤完成", detail: { tokens: { total: 180, input: 120, output: 60 }, finishReason: "stop" } },  // finishReason: "stop" 表示正常结束
    ]
    
    events2.forEach((e, i) => {
      console.log(`${i + 1}. [${e.type}] ${e.desc}`)
      if (e.isContent) {
        console.log(`   内容: "${e.desc.substring(0, 60)}..."`)  // 截断长文本以便显示
      }
      if (e.detail) {
        console.log(`   详情:`, JSON.stringify(e.detail, null, 2))
      }
    })
    DEBUG.divider()

    // ========== 阶段 11: 会话摘要 ==========
    // 目的：生成会话变更摘要，统计文件修改情况
    DEBUG.stage(11, "会话摘要")
    
    // 会话摘要数据结构（用于展示给用户）
    const summary = {
      additions: 15,  // 新增行数
      deletions: 0,  // 删除行数
      files: 1,  // 修改文件数
      diffs: [  // 详细的差异列表
        {
          file: "/home/user/myproject/bubble_sort.py",
          before: "",  // 修改前内容（空表示新文件）
          after: "def bubble_sort(arr):...",  // 修改后内容（截断显示）
          additions: 15,
          deletions: 0,
        }
      ]
    }
    DEBUG.log("变更统计", summary)
    DEBUG.divider()

    // ========== 阶段 12: 最终结果 ==========
    // 目的：向用户展示最终生成的代码和使用说明
    DEBUG.stage(12, "最终输出")
    
    // 构建最终输出消息（包含代码预览和使用说明）
    const finalOutput = `我已经在 \`/home/user/myproject/bubble_sort.py\` 创建了冒泡排序算法。

文件内容预览:
\`\`\`python
def bubble_sort(arr):
    n = len(arr)
    for i in range(n):
        for j in range(0, n - i - 1):
            if arr[j] > arr[j + 1]:
                arr[j], arr[j + 1] = arr[j + 1], arr[j]
    return arr
\`\`\`

你可以运行测试:
\`\`\`bash
python bubble_sort.py
\`\`\``

    console.log(finalOutput)
    DEBUG.divider()

    // ========== 执行统计 ==========
    // 目的：输出本次执行的统计数据，用于性能分析和成本计算
    DEBUG.stage(13, "执行统计")
    
    // 执行统计数据
    const stats = {
      "会话 ID": "01HQ8V8X1Y2Z3W4V5U6T7S8R9Q",
      "迭代次数": 2,  // LLM 调用次数
      "Token 使用": "425 (input: 320, output: 105)",  // Token 消耗（影响成本）
      "生成文件": 1,  // 生成的文件数量
      "文件路径": "/home/user/myproject/bubble_sort.py",
      "代码行数": 15,
    }
    
    // 格式化输出统计数据（key 左对齐，宽度 15 字符）
    Object.entries(stats).forEach(([key, value]) => {
      console.log(`${key.padEnd(15)}: ${value}`)
    })

    // 输出完成横幅
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                      调试执行完成                              ║
╚══════════════════════════════════════════════════════════════╝
`)

  } catch (error) {
    console.error("执行错误:", error)
    process.exit(1)
  }
}

main()
