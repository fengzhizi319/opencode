import { test, expect, mock, beforeEach } from "bun:test"

// 记录每次传输层构造函数被调用时传入的参数
const transportCalls: Array<{
  type: "streamable" | "sse"
  url: string
  options: { authProvider?: unknown; requestInit?: RequestInit }
}> = []

// Mock StreamableHTTPClientTransport 构造函数，用于捕获传入的参数
mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTP {
    constructor(url: URL, options?: { authProvider?: unknown; requestInit?: RequestInit }) {
      transportCalls.push({
        type: "streamable",
        url: url.toString(),
        options: options ?? {},
      })
    }
    async start() {
      throw new Error("Mock transport cannot connect")
    }
  },
}))

// Mock SSEClientTransport 构造函数，用于捕获传入的参数
mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class MockSSE {
    constructor(url: URL, options?: { authProvider?: unknown; requestInit?: RequestInit }) {
      transportCalls.push({
        type: "sse",
        url: url.toString(),
        options: options ?? {},
      })
    }
    async start() {
      throw new Error("Mock transport cannot connect")
    }
  },
}))

// 每个测试执行前重置状态
beforeEach(() => {
  transportCalls.length = 0
})

// 在 Mock 设置完成后导入实际模块
const { MCP } = await import("../../src/mcp/index")
const { Instance } = await import("../../src/project/instance")
const { tmpdir } = await import("../fixture/fixture")

/**
 * 测试用例：验证当 OAuth 启用时（默认行为），headers 能正确传递给传输层
 * 
 * 测试目的：
 * - 确保用户配置的自定义 headers（如 Authorization token）能被正确传递到 HTTP 请求中
 * - 验证默认的 OAuth 启用状态下，authProvider 和 headers 同时存在
 * - 确认 StreamableHTTP 和 SSE 两种传输方式都能正确接收 headers
 * 
 * 使用场景：
 * - 用户需要通过自定义 header 进行身份认证（Bearer Token、API Key 等）
 * - 需要传递额外的请求头信息（如租户 ID、追踪 ID 等）
 */
test("headers are passed to transports when oauth is enabled (default)", async () => {
  // 创建临时目录并初始化配置文件
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        `${dir}/opencode.json`,
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          mcp: {
            "test-server": {
              type: "remote",
              url: "https://example.com/mcp",
              headers: {
                Authorization: "Bearer test-token",
                "X-Custom-Header": "custom-value",
              },
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
      // 触发 MCP 初始化 - 连接会失败，但我们可以检查传输层的配置选项
      await MCP.add("test-server", {
        type: "remote",
        url: "https://example.com/mcp",
        headers: {
          Authorization: "Bearer test-token",
          "X-Custom-Header": "custom-value",
        },
      }).catch(() => {})

      // 验证断言：至少有一个传输层被创建
      expect(transportCalls.length).toBeGreaterThanOrEqual(1)

      // 遍历所有传输层调用，验证每个都正确配置了 headers 和 authProvider
      for (const call of transportCalls) {
        // 1. 验证 requestInit 存在（包含 headers 配置）
        expect(call.options.requestInit).toBeDefined()
        // 2. 验证 headers 内容完全匹配
        expect(call.options.requestInit?.headers).toEqual({
          Authorization: "Bearer test-token",
          "X-Custom-Header": "custom-value",
        })
        // 3. OAuth 默认启用，所以 authProvider 应该存在
        expect(call.options.authProvider).toBeDefined()
      }
    },
  })
})

/**
 * 测试用例：验证当 OAuth 显式禁用时，headers 仍能正确传递给传输层
 * 
 * 测试目的：
 * - 确保即使禁用了 OAuth，自定义 headers 依然能被正确传递
 * - 验证当 oauth: false 时，authProvider 不会被创建
 * - 确认 headers 和 OAuth 配置是独立的，互不影响
 * 
 * 使用场景：
 * - 服务器不支持 OAuth，但需要通过 API Key 或 Bearer Token 认证
 * - 内部服务之间的通信，使用简单的 Token 认证即可
 */
test("headers are passed to transports when oauth is explicitly disabled", async () => {
  // 创建临时目录
  await using tmp = await tmpdir()

  // 在临时目录的上下文中执行测试
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // 重置传输层调用记录
      transportCalls.length = 0

      // 添加一个禁用 OAuth 的远程 MCP 服务器
      await MCP.add("test-server-no-oauth", {
        type: "remote",
        url: "https://example.com/mcp",
        oauth: false,
        headers: {
          Authorization: "Bearer test-token",
        },
      }).catch(() => {})

      // 验证断言：至少有一个传输层被创建
      expect(transportCalls.length).toBeGreaterThanOrEqual(1)

      // 遍历所有传输层调用，验证配置正确性
      for (const call of transportCalls) {
        // 1. 验证 requestInit 存在（包含 headers 配置）
        expect(call.options.requestInit).toBeDefined()
        // 2. 验证 headers 内容正确
        expect(call.options.requestInit?.headers).toEqual({
          Authorization: "Bearer test-token",
        })
        // 3. OAuth 已禁用，所以 authProvider 应该是 undefined
        expect(call.options.authProvider).toBeUndefined()
      }
    },
  })
})

/**
 * 测试用例：验证当未提供 headers 时，requestInit 应该是 undefined
 * 
 * 测试目的：
 * - 确保在没有配置 headers 的情况下，不会创建多余的 requestInit 对象
 * - 验证代码的简洁性：只在必要时才传递额外参数
 * - 确认默认行为不会产生空对象或不必要的开销
 * 
 * 技术细节：
 * - requestInit 是 Fetch API 的请求初始化对象，包含 headers、method 等配置
 * - 当没有自定义配置时，应该保持 undefined 而不是空对象
 */
test("no requestInit when headers are not provided", async () => {
  // 创建临时目录
  await using tmp = await tmpdir()

  // 在临时目录的上下文中执行测试
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // 重置传输层调用记录
      transportCalls.length = 0

      // 添加一个没有任何配置的远程 MCP 服务器
      await MCP.add("test-server-no-headers", {
        type: "remote",
        url: "https://example.com/mcp",
      }).catch(() => {})

      // 验证断言：至少有一个传输层被创建
      expect(transportCalls.length).toBeGreaterThanOrEqual(1)

      // 遍历所有传输层调用，验证没有 requestInit
      for (const call of transportCalls) {
        // 没有 headers 配置时，requestInit 应该是 undefined
        expect(call.options.requestInit).toBeUndefined()
      }
    },
  })
})
