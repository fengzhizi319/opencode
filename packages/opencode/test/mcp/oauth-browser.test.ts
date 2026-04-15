import { test, expect, mock, beforeEach } from "bun:test"
import { EventEmitter } from "events"

// 跟踪 open() 调用状态和控制失败行为
let openShouldFail = false
let openCalledWith: string | undefined

// Mock open 模块，用于模拟打开浏览器URL的行为
mock.module("open", () => ({
  default: async (url: string) => {
    openCalledWith = url

    // 返回一个模拟的子进程对象，当 openShouldFail 为 true 时会触发错误事件
    const subprocess = new EventEmitter()
    if (openShouldFail) {
      // 异步触发错误事件，模拟真实的子进程错误行为
      setTimeout(() => {
        subprocess.emit("error", new Error("spawn xdg-open ENOENT"))
      }, 10)
    }
    return subprocess
  },
}))

// Mock UnauthorizedError，模拟认证失败的错误类型
class MockUnauthorizedError extends Error {
  constructor() {
    super("Unauthorized")
    this.name = "UnauthorizedError"
  }
}

// 记录每次传输层构造函数被调用时传入的参数
const transportCalls: Array<{
  type: "streamable" | "sse"
  url: string
  options: { authProvider?: unknown }
}> = []

// Mock StreamableHTTPClientTransport 构造函数
mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTP {
    url: string
    authProvider: { redirectToAuthorization?: (url: URL) => Promise<void> } | undefined
    constructor(url: URL, options?: { authProvider?: { redirectToAuthorization?: (url: URL) => Promise<void> } }) {
      this.url = url.toString()
      this.authProvider = options?.authProvider
      transportCalls.push({
        type: "streamable",
        url: url.toString(),
        options: options ?? {},
      })
    }
    async start() {
      // 通过调用 authProvider 的 redirectToAuthorization 方法模拟 OAuth 重定向流程
      if (this.authProvider?.redirectToAuthorization) {
        await this.authProvider.redirectToAuthorization(new URL("https://auth.example.com/authorize?client_id=test"))
      }
      throw new MockUnauthorizedError()
    }
    async finishAuth(_code: string) {
      // 模拟认证成功完成
    }
  },
}))

// Mock SSEClientTransport 构造函数
mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class MockSSE {
    constructor(url: URL) {
      transportCalls.push({
        type: "sse",
        url: url.toString(),
        options: {},
      })
    }
    async start() {
      throw new Error("Mock SSE transport cannot connect")
    }
  },
}))

// Mock MCP SDK Client，用于触发 OAuth 流程
mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    async connect(transport: { start: () => Promise<void> }) {
      await transport.start()
    }
  },
}))

// Mock auth 模块中的 UnauthorizedError
mock.module("@modelcontextprotocol/sdk/client/auth.js", () => ({
  UnauthorizedError: MockUnauthorizedError,
}))

// 每个测试执行前重置状态
beforeEach(() => {
  openShouldFail = false
  openCalledWith = undefined
  transportCalls.length = 0
})

// 在 Mock 设置完成后导入实际模块
const { MCP } = await import("../../src/mcp/index")
const { Bus } = await import("../../src/bus")
const { McpOAuthCallback } = await import("../../src/mcp/oauth-callback")
const { Instance } = await import("../../src/project/instance")
const { tmpdir } = await import("../fixture/fixture")

/**
 * 测试用例：验证当 open() 函数抛出错误时，会正确发布 BrowserOpenFailed 事件
 *
 * 测试目的：
 * - 确保当系统无法打开浏览器（例如缺少 xdg-open 命令）时，能够正确捕获错误并发布事件
 * - 验证事件中包含正确的 MCP 服务器名称和授权URL信息
 */
test("BrowserOpenFailed event is published when open() throws", async () => {
  // 创建临时目录并初始化配置文件
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        `${dir}/opencode.json`,
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          mcp: {
            "test-oauth-server": {
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
      // 配置 open() 模拟函数使其失败
      openShouldFail = true

      // 收集发布的 BrowserOpenFailed 事件
      const events: Array<{ mcpName: string; url: string }> = []
      const unsubscribe = Bus.subscribe(MCP.BrowserOpenFailed, (evt) => {
        events.push(evt.properties)
      })

      // 执行认证操作，捕获可能的错误避免测试中断
      // 立即附加错误处理器，防止回调关闭时的拒绝成为未处理的异常
      const authPromise = MCP.authenticate("test-oauth-server").catch(() => undefined)

      // Config.get() 在测试中可能较慢，给予充足的等待时间
      // 同时覆盖约500ms的 open() 错误检测窗口
      await new Promise((resolve) => setTimeout(resolve, 2_000))

      // 停止回调服务器并取消任何待处理的认证
      await McpOAuthCallback.stop()

      await authPromise

      // 取消事件订阅
      unsubscribe()

      // 验证断言：确认发布了且仅发布了一个 BrowserOpenFailed 事件
      expect(events.length).toBe(1)
      expect(events[0].mcpName).toBe("test-oauth-server")
      expect(events[0].url).toContain("https://")
    },
  })
})

/**
 * 测试用例：验证当 open() 函数成功时，不会发布 BrowserOpenFailed 事件
 *
 * 测试目的：
 * - 确保正常情况下（浏览器能成功打开）不会产生错误事件
 * - 验证 open() 确实被调用了
 */
test("BrowserOpenFailed event is NOT published when open() succeeds", async () => {
  // 创建临时目录并初始化配置文件
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        `${dir}/opencode.json`,
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          mcp: {
            "test-oauth-server-2": {
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
      // 配置 open() 模拟函数使其成功
      openShouldFail = false

      // 收集发布的 BrowserOpenFailed 事件
      const events: Array<{ mcpName: string; url: string }> = []
      const unsubscribe = Bus.subscribe(MCP.BrowserOpenFailed, (evt) => {
        events.push(evt.properties)
      })

      // 执行认证操作，捕获可能的错误避免测试中断
      const authPromise = MCP.authenticate("test-oauth-server-2").catch(() => undefined)

      // Config.get() 在测试中可能较慢；同时覆盖约500ms的 open() 错误检测窗口
      await new Promise((resolve) => setTimeout(resolve, 2_000))

      // 停止回调服务器并取消任何待处理的认证
      await McpOAuthCallback.stop()

      await authPromise

      // 取消事件订阅
      unsubscribe()

      // 验证断言：确认没有发布 BrowserOpenFailed 事件
      expect(events.length).toBe(0)
      // 验证 open() 确实被调用了
      expect(openCalledWith).toBeDefined()
    },
  })
})

/**
 * 测试用例：验证 open() 函数被调用时传入了正确的授权URL
 *
 * 测试目的：
 * - 确保 OAuth 流程中，系统会尝试使用正确的授权URL打开浏览器
 * - 验证URL格式正确且包含 https 协议
 */
test("open() is called with the authorization URL", async () => {
  // 创建临时目录并初始化配置文件
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        `${dir}/opencode.json`,
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          mcp: {
            "test-oauth-server-3": {
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
      // 重置状态，确保 open() 会成功执行
      openShouldFail = false
      openCalledWith = undefined

      // 执行认证操作，捕获可能的错误避免测试中断
      const authPromise = MCP.authenticate("test-oauth-server-3").catch(() => undefined)

      // Config.get() 在测试中可能较慢；同时覆盖约500ms的 open() 错误检测窗口
      await new Promise((resolve) => setTimeout(resolve, 2_000))

      // 停止回调服务器并取消任何待处理的认证
      await McpOAuthCallback.stop()

      await authPromise

      // 验证断言：确认 open() 被调用且传入了有效的URL
      expect(openCalledWith).toBeDefined()
      expect(typeof openCalledWith).toBe("string")
      expect(openCalledWith!).toContain("https://")
    },
  })
})
