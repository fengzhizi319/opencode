/**
 * ACP Agent 接口合规性测试文件
 *
 * 测试目标：验证 ACP.Agent 类是否正确实现了 ACP SDK 定义的接口
 *
 * 背景说明：
 * - ACP (Agent Client Protocol) 是智能体客户端协议
 * - SDK 在运行时会检查某些方法是否存在，即使它们在 TypeScript 接口中是可选的
 * - 如果方法缺失，SDK 的路由器会抛出 "Method not found" 错误
 * - 因此需要同时通过编译时类型检查和运行时方法来确保完全兼容
 */
import { describe, expect, test } from "bun:test"
import { ACP } from "../../src/acp/agent"
import type { Agent as ACPAgent } from "@agentclientprotocol/sdk"

/**
 * ============================================================================
 * 第一部分：编译时类型检查（Type-level Test）
 * ============================================================================
 *
 * 这是一个类型级别的测试，用于在编译时验证 ACP.Agent 是否实现了 ACPAgent 接口
 *
 * 工作原理：
 * 1. 使用条件类型：如果 ACP.Agent 可以赋值给 ACPAgent，则类型为 true，否则为 never
 * 2. 将 true 赋值给 _typeCheck 常量
 * 3. 如果 ACP.Agent 不满足接口要求，编译会失败（因为无法将 true 赋值给 never 类型）
 *
 * 为什么需要这个检查？
 * - TypeScript 允许类省略接口中的可选方法
 * - 但 ACP SDK 在运行时会检查这些"可选"方法是否存在
 * - 如果缺少，SDK 会抛出运行时错误
 * - 这个类型检查确保编译时就能发现接口不匹配的问题
 *
 * @see https://github.com/agentclientprotocol/typescript-sdk/commit/7072d3f
 */
type _AssertAgentImplementsACPAgent = ACP.Agent extends ACPAgent ? true : never
const _typeCheck: _AssertAgentImplementsACPAgent = true

/**
 * ============================================================================
 * 第二部分：运行时方法存在性检查（Runtime Verification）
 * ============================================================================
 *
 * 即使通过了编译时类型检查，仍需要验证方法在运行时确实存在
 *
 * 原因：
 * - TypeScript 的类型系统只在编译时有效
 * - 某些情况下（如动态加载、原型链问题），方法可能在运行时不存在
 * - SDK 的路由器通过 `if (!agent.methodName)` 检查方法存在性
 * - 如果方法缺失，会抛出 MethodNotFound 错误
 */
describe("acp.agent interface compliance", () => {
  /**
   * 从 ACPAgent 接口类型中提取所有方法名
   * 这是一个类型别名，用于后续的类型安全声明
   */
  type ACPAgentMethods = keyof ACPAgent

  /**
   * SDK 路由器在运行时会显式检查的方法列表
   *
   * 分类说明：
   * 1. Required（必需方法）：ACP 协议的核心方法，必须实现
   * 2. Optional but checked（可选但被检查）：虽然接口中标记为可选，但 SDK 仍会检查
   * 3. Unstable（不稳定方法）：带有 unstable_ 前缀的实验性功能
   */
  const sdkCheckedMethods: ACPAgentMethods[] = [
    // ==================== 必需方法（Required）====================
    /**
     * initialize - 初始化代理
     * 用途：建立连接时的握手方法，交换能力信息和配置
     */
    "initialize",

    /**
     * newSession - 创建新会话
     * 用途：启动一个新的对话会话，返回会话 ID
     */
    "newSession",

    /**
     * prompt - 发送提示词
     * 用途：向代理发送用户输入或指令，获取 AI 响应
     */
    "prompt",

    /**
     * cancel - 取消操作
     * 用途：取消正在进行的请求或任务
     */
    "cancel",

    // ==================== 可选但被 SDK 检查的方法 ====================
    /**
     * loadSession - 加载已有会话
     * 用途：恢复之前保存的会话状态和历史记录
     */
    "loadSession",

    /**
     * setSessionMode - 设置会话模式
     * 用途：切换会话的工作模式（如：聊天模式、代码编辑模式等）
     */
    "setSessionMode",

    /**
     * authenticate - 身份验证
     * 用途：处理用户认证流程，获取访问令牌
     */
    "authenticate",

    // ==================== 不稳定方法（Unstable APIs）====================
    /**
     * unstable_listSessions - 列出所有会话（实验性）
     * 用途：获取用户的所有历史会话列表
     * 注意：API 可能在未来版本中变更
     */
    "unstable_listSessions",

    /**
     * unstable_forkSession - 分叉会话（实验性）
     * 用途：从某个会话的特定时间点创建分支，用于探索不同的对话路径
     */
    "unstable_forkSession",

    /**
     * unstable_resumeSession - 恢复会话（实验性）
     * 用途：继续之前的会话，可能包含额外的恢复逻辑
     */
    "unstable_resumeSession",

    /**
     * unstable_setSessionModel - 设置会话模型（实验性）
     * 用途：为特定会话指定使用的 LLM 模型（如：gpt-4、claude-3 等）
     */
    "unstable_setSessionModel",
  ]

  /**
   * 测试用例：验证 Agent 实现了所有 SDK 检查的方法
   *
   * 测试目的：
   * - 确保 ACP.Agent.prototype 上存在所有必需的方法
   * - 防止因重构、删除或拼写错误导致方法缺失
   * - 保证与 ACP SDK 的兼容性
   *
   * 测试逻辑：
   * 1. 遍历 sdkCheckedMethods 数组中的每个方法名
   * 2. 检查 ACP.Agent.prototype 上是否存在该方法
   * 3. 验证方法的类型是否为 "function"
   * 4. 如果任何方法缺失或不是函数，测试失败并显示具体缺失的方法名
   */
  test("Agent implements all SDK-checked methods", () => {
    for (const method of sdkCheckedMethods) {
      // 检查方法是否存在且类型为 function
      // typeof 运算符返回字符串："function"、"undefined" 等
      expect(
        typeof ACP.Agent.prototype[method as keyof typeof ACP.Agent.prototype],
        `Missing method: ${method}` // 自定义错误消息，明确指出缺失的方法
      ).toBe("function")
    }
  })
})
