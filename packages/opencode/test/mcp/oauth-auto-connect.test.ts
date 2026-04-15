import { test, expect, mock, beforeEach } from "bun:test"

// Mock UnauthorizedError，模拟 MCP SDK 中的认证错误类
class MockUnauthorizedError extends Error {
  constructor(message?: string) {
    super(message ?? "Unauthorized")
    this.name = "UnauthorizedError"
  }
}

// 记录每次传输层构造函数被调用时传入的参数
const transportCalls: Array<{
  type: "streamable" | "sse"
  url: string
  options: { authProvider?: unknown }
}> = []

// 控制模拟传输层是否触发完整的 SDK 认证流程
// true: 模拟 401 响应，触发 SDK 的 auth 流程（会调用 provider.state()）
// false: 仅抛出简单的 UnauthorizedError
let simulateAuthFlow = true

// Mock StreamableHTTPClientTransport 构造函数，模拟 OAuth 自动认证流程
mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTP {
    authProvider:
      | {
          state?: () => Promise<string>
          redirectToAuthorization?: (url: URL) => Promise<void>
          saveCodeVerifier?: (v: string) => Promise<void>
        }
      | undefined
    constructor(url: URL, options?: { authProvider?: unknown }) {
      this.authProvider = options?.authProvider as typeof this.authProvider
      transportCalls.push({
        type: "streamable",
        url: url.toString(),
        options: options ?? {},
      })
    }
    async start() {
      // 模拟真实 SDK 传输层在收到 401 响应时的行为：
      // 1. 调用 auth() 方法
      // 2. 最终调用 provider.state() 获取 OAuth 状态参数
      // 3. 调用 provider.redirectToAuthorization() 重定向用户到授权页面
      // 4. 抛出 UnauthorizedError 异常
      if (simulateAuthFlow && this.authProvider) {
        // SDK 会调用 provider.state() 获取 OAuth 状态参数
        if (this.authProvider.state) {
          await this.authProvider.state()
        }
        // SDK 在重定向前会保存 code verifier（PKCE 流程的一部分）
        if (this.authProvider.saveCodeVerifier) {
          await this.authProvider.saveCodeVerifier("test-verifier")
        }
        // SDK 调用 redirectToAuthorization 将用户重定向到授权服务器
        if (this.authProvider.redirectToAuthorization) {
          await this.authProvider.redirectToAuthorization(new URL("https://auth.example.com/authorize?state=test"))
        }
        throw new MockUnauthorizedError()
      }
      throw new MockUnauthorizedError()
    }
    async finishAuth(_code: string) {}
  },
}))

// Mock SSEClientTransport 构造函数
mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class MockSSE {
    constructor(url: URL, options?: { authProvider?: unknown }) {
      transportCalls.push({
        type: "sse",
        url: url.toString(),
        options: options ?? {},
      })
    }
    async start() {
      throw new Error("Mock SSE transport cannot connect")
    }
  },
}))

// Mock MCP SDK Client，用于建立与传输层的连接
mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    async connect(transport: { start: () => Promise<void> }) {
      await transport.start()
    }
  },
}))

// Mock auth 模块中的 UnauthorizedError，确保 instanceof 类型检查能够正常工作
mock.module("@modelcontextprotocol/sdk/client/auth.js", () => ({
  UnauthorizedError: MockUnauthorizedError,
}))

// 每个测试执行前重置状态
beforeEach(() => {
  transportCalls.length = 0
  simulateAuthFlow = true
})

// 在 Mock 设置完成后导入实际模块
const { MCP } = await import("../../src/mcp/index")
const { Instance } = await import("../../src/project/instance")
const { tmpdir } = await import("../fixture/fixture")

/**
 * 测试用例：验证首次连接到需要 OAuth 认证的服务器时，状态显示为 needs_auth 而非 failed
 * 
 * 测试目的：
 * - 确保当服务器返回 401 未授权错误时，系统能正确识别为需要认证的状态
 * - 验证修复前的 bug：provider.state() 抛出普通 Error 而非 UnauthorizedError 会导致状态误判为 failed
 * - 确认 OAuth 流程能正确触发并更新服务器状态
 * 
 * 背景：
 * 在修复之前，当没有保存 OAuth 状态时，provider.state() 会抛出普通 Error
 * （"No OAuth state saved for MCP server: xxx"），该错误不会被捕获为 UnauthorizedError，
 * 导致服务器状态被错误地标记为 "failed" 而不是 "needs_auth"
 */
test("first connect to OAuth server shows needs_auth instead of failed", async () => {
  // 创建临时目录并初始化配置文件
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        `${dir}/opencode.json`,
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          mcp: {
            "test-oauth": {
              type: "remote",
              url: "https://example.com/mcp",
            },
          },
        }),
      )
    },
  })

  // 在临时目录的上下文中执行测试
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // 添加一个远程 MCP 服务器，这将触发连接尝试和 OAuth 流程
      const result = await MCP.add("test-oauth", {
        type: "remote",
        url: "https://example.com/mcp",
      })

      // 提取服务器状态信息
      const serverStatus = result.status as Record<string, { status: string; error?: string }>

      // 验证断言：
      // 1. 服务器状态应该被定义
      // 2. 状态应该是 "needs_auth"（需要认证），而不是 "failed"（失败）
      expect(serverStatus["test-oauth"]).toBeDefined()
      expect(serverStatus["test-oauth"].status).toBe("needs_auth")
    },
  })
})

/**
 * 测试用例：验证当没有保存的 state 时，state() 方法能生成新的 state
 * 
 * 测试目的：
 * - 确保 OAuth 流程中，当不存在已保存的 state 参数时，能自动生成新的随机 state
 * - 验证生成的 state 格式正确（64 字符的十六进制字符串，对应 32 字节）
 * - 确认生成的 state 被正确持久化存储，以便后续回调验证时使用
 * 
 * 技术细节：
 * - OAuth 2.0 PKCE 流程需要使用 state 参数防止 CSRF 攻击
 * - state 应该是加密安全的随机值
 * - state 需要在授权请求和回调之间保持一致
 */
test("state() generates a new state when none is saved", async () => {
  // 导入必要的模块
  const { McpOAuthProvider } = await import("../../src/mcp/oauth-provider")
  const { McpAuth } = await import("../../src/mcp/auth")

  // 创建临时目录
  await using tmp = await tmpdir()

  // 在临时目录的上下文中执行测试
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // 创建 OAuth Provider 实例
      const provider = new McpOAuthProvider(
        "test-state-gen",
        "https://example.com/mcp",
        {},
        { onRedirect: async () => {} },
      )

      // 验证前置条件：确保当前没有任何已保存的 state
      const entryBefore = await McpAuth.get("test-state-gen")
      expect(entryBefore?.oauthState).toBeUndefined()

      // 调用 state() 方法，应该生成并返回一个新的 state，而不是抛出异常
      const state = await provider.state()
      expect(typeof state).toBe("string")
      expect(state.length).toBe(64) // 32 字节的十六进制表示

      // 验证生成的 state 已被持久化存储
      const entryAfter = await McpAuth.get("test-state-gen")
      expect(entryAfter?.oauthState).toBe(state)
    },
  })
})

/**
 * 测试用例：验证当存在已保存的 state 时，state() 方法返回现有的 state
 * 
 * 测试目的：
 * - 确保 OAuth 流程中，如果已有保存的 state 参数，则直接复用而不是重新生成
 * - 验证 state 的一致性：在授权请求发起后、回调处理前，state 必须保持不变
 * - 确认幂等性：多次调用 state() 应返回相同的值
 * 
 * 使用场景：
 * - 用户发起授权请求后，浏览器打开授权页面但尚未完成回调
 * - 此时再次调用 state() 应返回同一个 state，确保授权流程的连续性
 */
test("state() returns existing state when one is saved", async () => {
  // 导入必要的模块
  const { McpOAuthProvider } = await import("../../src/mcp/oauth-provider")
  const { McpAuth } = await import("../../src/mcp/auth")

  // 创建临时目录
  await using tmp = await tmpdir()

  // 在临时目录的上下文中执行测试
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // 创建 OAuth Provider 实例
      const provider = new McpOAuthProvider(
        "test-state-existing",
        "https://example.com/mcp",
        {},
        { onRedirect: async () => {} },
      )

      // 预先保存一个 state 值，模拟授权流程进行中的状态
      const existingState = "pre-saved-state-value"
      await McpAuth.updateOAuthState("test-state-existing", existingState)

      // 调用 state() 方法，应该返回已存在的 state 而不是生成新的
      const state = await provider.state()
      expect(state).toBe(existingState)
    },
  })
})
