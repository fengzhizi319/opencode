import { test, expect, mock, beforeEach } from "bun:test"

// ========================================================================
// Mock 基础设施 - 模拟 MCP SDK 客户端和传输层行为
// ========================================================================

// 每个客户端的状态配置接口，用于控制 Mock 行为
interface MockClientState {
  tools: Array<{ name: string; description?: string; inputSchema: object }>
  listToolsCalls: number
  listToolsShouldFail: boolean
  listToolsError: string
  listPromptsShouldFail: boolean
  listResourcesShouldFail: boolean
  prompts: Array<{ name: string; description?: string }>
  resources: Array<{ name: string; uri: string; description?: string }>
  closed: boolean
  notificationHandlers: Map<unknown, (...args: any[]) => any>
}

// 存储所有客户端状态的映射表，键为客户端名称
const clientStates = new Map<string, MockClientState>()
// 记录最后创建的客户端名称
let lastCreatedClientName: string | undefined
// 控制连接是否应该失败
let connectShouldFail = false
// 控制连接是否应该挂起（永不返回）
let connectShouldHang = false
// 连接失败时的错误消息
let connectError = "Mock transport cannot connect"
// 追踪创建了多少个 Client 实例（用于检测内存泄漏）
let clientCreateCount = 0
// 追踪所有 Mock 传输层调用 close() 的次数（用于检测资源泄漏）
let transportCloseCount = 0

/**
 * 获取或创建指定名称的客户端状态对象
 * @param name 客户端名称，默认为 "default"
 * @returns 客户端状态对象
 */
function getOrCreateClientState(name?: string): MockClientState {
  const key = name ?? "default"
  let state = clientStates.get(key)
  if (!state) {
    state = {
      tools: [{ name: "test_tool", description: "A test tool", inputSchema: { type: "object", properties: {} } }],
      listToolsCalls: 0,
      listToolsShouldFail: false,
      listToolsError: "listTools failed",
      listPromptsShouldFail: false,
      listResourcesShouldFail: false,
      prompts: [],
      resources: [],
      closed: false,
      notificationHandlers: new Map(),
    }
    clientStates.set(key, state)
  }
  return state
}

// Mock StdioClientTransport（本地进程传输层），根据配置决定成功、失败或挂起
class MockStdioTransport {
  stderr: null = null
  pid = 12345
  constructor(_opts: any) {}
  async start() {
    if (connectShouldHang) return new Promise<void>(() => {}) // 永不返回，模拟挂起
    if (connectShouldFail) throw new Error(connectError)
  }
  async close() {
    transportCloseCount++
  }
}

// Mock StreamableHTTPClientTransport（远程 HTTP 传输层）
class MockStreamableHTTP {
  constructor(_url: URL, _opts?: any) {}
  async start() {
    if (connectShouldHang) return new Promise<void>(() => {}) // 永不返回，模拟挂起
    if (connectShouldFail) throw new Error(connectError)
  }
  async close() {
    transportCloseCount++
  }
  async finishAuth() {}
}

// Mock SSEClientTransport（SSE 传输层）
class MockSSE {
  constructor(_url: URL, _opts?: any) {}
  async start() {
    if (connectShouldHang) return new Promise<void>(() => {}) // 永不返回，模拟挂起
    if (connectShouldFail) throw new Error(connectError)
  }
  async close() {
    transportCloseCount++
  }
}

// Mock 三个传输层模块
mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: MockStdioTransport,
}))

mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: MockStreamableHTTP,
}))

mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: MockSSE,
}))

// Mock UnauthorizedError，模拟认证失败错误
mock.module("@modelcontextprotocol/sdk/client/auth.js", () => ({
  UnauthorizedError: class extends Error {
    constructor() {
      super("Unauthorized")
    }
  },
}))

/**
 * Mock MCP Client，代理到每个名称对应的 MockClientState
 * 模拟真实的 MCP 客户端行为，包括连接、工具列表、通知处理等
 */
mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    _state!: MockClientState
    transport: any

    constructor(_opts: any) {
      clientCreateCount++ // 每次创建都计数，用于检测泄漏
    }

    async connect(transport: { start: () => Promise<void> }) {
      this.transport = transport
      await transport.start()
      // 连接成功后，绑定到最后创建的客户端名称对应的状态
      this._state = getOrCreateClientState(lastCreatedClientName)
    }

    setNotificationHandler(schema: unknown, handler: (...args: any[]) => any) {
      this._state?.notificationHandlers.set(schema, handler)
    }

    async listTools() {
      if (this._state) this._state.listToolsCalls++
      if (this._state?.listToolsShouldFail) {
        throw new Error(this._state.listToolsError)
      }
      return { tools: this._state?.tools ?? [] }
    }

    async listPrompts() {
      if (this._state?.listPromptsShouldFail) {
        throw new Error("listPrompts failed")
      }
      return { prompts: this._state?.prompts ?? [] }
    }

    async listResources() {
      if (this._state?.listResourcesShouldFail) {
        throw new Error("listResources failed")
      }
      return { resources: this._state?.resources ?? [] }
    }

    async close() {
      if (this._state) this._state.closed = true
    }
  },
}))

// 每个测试执行前重置所有状态
beforeEach(() => {
  clientStates.clear()
  lastCreatedClientName = undefined
  connectShouldFail = false
  connectShouldHang = false
  connectError = "Mock transport cannot connect"
  clientCreateCount = 0
  transportCloseCount = 0
})

// 在 Mock 设置完成后导入实际模块
const { MCP } = await import("../../src/mcp/index")
const { Instance } = await import("../../src/project/instance")
const { tmpdir } = await import("../fixture/fixture")

// ========================================================================
// 辅助函数：创建临时目录和 Instance 上下文
// ========================================================================

/**
 * 创建一个带有指定 MCP 配置的临时目录，并在 Instance 上下文中执行测试函数
 * @param config MCP 服务器配置对象
 * @param fn 测试函数
 * @returns 包装后的测试函数
 */
function withInstance(config: Record<string, any>, fn: () => Promise<void>) {
  return async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          `${dir}/opencode.json`,
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            mcp: config,
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await fn()
        // 释放 Instance 以清理测试之间的状态
        await Instance.dispose()
      },
    })
  }
}

// ========================================================================
// 测试用例：工具列表缓存机制
// ========================================================================

/**
 * 测试用例：验证 tools() 在连接后重用缓存的工具定义
 * 
 * 测试目的：
 * - 确保首次连接时调用 listTools() 获取工具列表
 * - 验证后续调用 tools() 直接返回缓存结果，不再次调用 listTools()
 * - 确认缓存机制能减少不必要的网络请求和服务器负载
 * 
 * 技术细节：
 * - MCP 客户端在连接成功后会调用 listTools() 获取可用工具
 * - 工具列表会被缓存，避免重复查询
 * - 通过检查 listToolsCalls 计数验证缓存生效
 */
test(
  "tools() reuses cached tool definitions after connect",
  withInstance({}, async () => {
    lastCreatedClientName = "my-server"
    const serverState = getOrCreateClientState("my-server")
    serverState.tools = [
      { name: "do_thing", description: "does a thing", inputSchema: { type: "object", properties: {} } },
    ]

    // 第一步：添加服务器并成功连接
    const addResult = await MCP.add("my-server", {
      type: "local",
      command: ["echo", "test"],
    })
    expect((addResult.status as any)["my-server"]?.status ?? (addResult.status as any).status).toBe("connected")

    // 验证：连接过程中调用了 1 次 listTools()
    expect(serverState.listToolsCalls).toBe(1)

    // 第二步：两次调用 tools() 获取工具列表
    const toolsA = await MCP.tools()
    const toolsB = await MCP.tools()
    expect(Object.keys(toolsA).length).toBeGreaterThan(0)
    expect(Object.keys(toolsB).length).toBeGreaterThan(0)
    // 关键验证：listToolsCalls 仍然是 1，说明第二次调用使用了缓存
    expect(serverState.listToolsCalls).toBe(1)
  }),
)

// ========================================================================
// 测试用例：工具变更通知机制
// ========================================================================

/**
 * 测试用例：验证工具变更通知能刷新缓存的工具定义
 * 
 * 测试目的：
 * - 确保当服务器发送工具变更通知时，客户端能清除旧缓存
 * - 验证收到通知后会重新调用 listTools() 获取最新工具列表
 * - 确认动态工具更新机制正常工作
 * 
 * 使用场景：
 * - 服务器运行时动态添加或删除工具
 * - 插件系统的热加载功能
 * - 实时更新的工具集合
 */
test(
  "tool change notifications refresh cached tool definitions",
  withInstance({}, async () => {
    lastCreatedClientName = "status-server"
    const serverState = getOrCreateClientState("status-server")

    // 第一步：添加服务器并获取初始工具列表
    await MCP.add("status-server", {
      type: "local",
      command: ["echo", "test"],
    })

    const before = await MCP.tools()
    expect(Object.keys(before).some((key) => key.includes("test_tool"))).toBe(true)
    expect(serverState.listToolsCalls).toBe(1)

    // 第二步：修改服务器的工具列表（模拟服务器端变更）
    serverState.tools = [{ name: "next_tool", description: "next", inputSchema: { type: "object", properties: {} } }]

    // 第三步：触发工具变更通知处理器（模拟服务器发送 notification）
    const handler = Array.from(serverState.notificationHandlers.values())[0]
    expect(handler).toBeDefined()
    await handler?.()

    // 第四步：再次获取工具列表，应该包含新工具
    const after = await MCP.tools()
    expect(Object.keys(after).some((key) => key.includes("next_tool"))).toBe(true)
    expect(Object.keys(after).some((key) => key.includes("test_tool"))).toBe(false)
    // 关键验证：listToolsCalls 增加到 2，说明通知触发了重新查询
    expect(serverState.listToolsCalls).toBe(2)
  }),
)

// ========================================================================
// 测试用例：连接/断开生命周期管理
// ========================================================================

/**
 * 测试用例：验证 disconnect() 将状态设置为 disabled 并移除客户端
 * 
 * 测试目的：
 * - 确保断开连接后，服务器状态变为 "disabled"
 * - 验证断开后该服务器的工具不再出现在工具列表中
 * - 确认客户端资源被正确清理
 * 
 * 使用场景：
 * - 用户手动禁用某个 MCP 服务器
 * - 临时关闭不需要的服务以节省资源
 */
test(
  "disconnect sets status to disabled and removes client",
  withInstance(
    {
      "disc-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    async () => {
      lastCreatedClientName = "disc-server"
      getOrCreateClientState("disc-server")

      // 第一步：添加并连接服务器
      await MCP.add("disc-server", {
        type: "local",
        command: ["echo", "test"],
      })

      const statusBefore = await MCP.status()
      expect(statusBefore["disc-server"]?.status).toBe("connected")

      // 第二步：断开连接
      await MCP.disconnect("disc-server")

      const statusAfter = await MCP.status()
      expect(statusAfter["disc-server"]?.status).toBe("disabled")

      // 第三步：验证工具列表已清空
      const tools = await MCP.tools()
      const serverTools = Object.keys(tools).filter((k) => k.startsWith("disc-server"))
      expect(serverTools.length).toBe(0)
    },
  ),
)

test(
  "connect() after disconnect() re-establishes the server",
  withInstance(
    {
      "reconn-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    async () => {
      lastCreatedClientName = "reconn-server"
      const serverState = getOrCreateClientState("reconn-server")
      serverState.tools = [{ name: "my_tool", description: "a tool", inputSchema: { type: "object", properties: {} } }]

      await MCP.add("reconn-server", {
        type: "local",
        command: ["echo", "test"],
      })

      await MCP.disconnect("reconn-server")
      expect((await MCP.status())["reconn-server"]?.status).toBe("disabled")

      // Reconnect
      await MCP.connect("reconn-server")
      expect((await MCP.status())["reconn-server"]?.status).toBe("connected")

      const tools = await MCP.tools()
      expect(Object.keys(tools).some((k) => k.includes("my_tool"))).toBe(true)
    },
  ),
)

// ========================================================================
// Test: add() closes existing client before replacing
// ========================================================================

test(
  "add() closes the old client when replacing a server",
  // Don't put the server in config — add it dynamically so we control
  // exactly which client instance is "first" vs "second".
  withInstance({}, async () => {
    lastCreatedClientName = "replace-server"
    const firstState = getOrCreateClientState("replace-server")

    await MCP.add("replace-server", {
      type: "local",
      command: ["echo", "test"],
    })

    expect(firstState.closed).toBe(false)

    // Create new state for second client
    clientStates.delete("replace-server")
    const secondState = getOrCreateClientState("replace-server")

    // Re-add should close the first client
    await MCP.add("replace-server", {
      type: "local",
      command: ["echo", "test"],
    })

    expect(firstState.closed).toBe(true)
    expect(secondState.closed).toBe(false)
  }),
)

// ========================================================================
// Test: state init with mixed success/failure
// ========================================================================

test(
  "init connects available servers even when one fails",
  withInstance(
    {
      "good-server": {
        type: "local",
        command: ["echo", "good"],
      },
      "bad-server": {
        type: "local",
        command: ["echo", "bad"],
      },
    },
    async () => {
      // Set up good server
      const goodState = getOrCreateClientState("good-server")
      goodState.tools = [{ name: "good_tool", description: "works", inputSchema: { type: "object", properties: {} } }]

      // Set up bad server - will fail on listTools during create()
      const badState = getOrCreateClientState("bad-server")
      badState.listToolsShouldFail = true

      // Add good server first
      lastCreatedClientName = "good-server"
      await MCP.add("good-server", {
        type: "local",
        command: ["echo", "good"],
      })

      // Add bad server - should fail but not affect good server
      lastCreatedClientName = "bad-server"
      await MCP.add("bad-server", {
        type: "local",
        command: ["echo", "bad"],
      })

      const status = await MCP.status()
      expect(status["good-server"]?.status).toBe("connected")
      expect(status["bad-server"]?.status).toBe("failed")

      // Good server's tools should still be available
      const tools = await MCP.tools()
      expect(Object.keys(tools).some((k) => k.includes("good_tool"))).toBe(true)
    },
  ),
)

// ========================================================================
// Test: disabled server via config
// ========================================================================

test(
  "disabled server is marked as disabled without attempting connection",
  withInstance(
    {
      "disabled-server": {
        type: "local",
        command: ["echo", "test"],
        enabled: false,
      },
    },
    async () => {
      const countBefore = clientCreateCount

      await MCP.add("disabled-server", {
        type: "local",
        command: ["echo", "test"],
        enabled: false,
      } as any)

      // No client should have been created
      expect(clientCreateCount).toBe(countBefore)

      const status = await MCP.status()
      expect(status["disabled-server"]?.status).toBe("disabled")
    },
  ),
)

// ========================================================================
// Test: prompts() and resources()
// ========================================================================

test(
  "prompts() returns prompts from connected servers",
  withInstance(
    {
      "prompt-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    async () => {
      lastCreatedClientName = "prompt-server"
      const serverState = getOrCreateClientState("prompt-server")
      serverState.prompts = [{ name: "my-prompt", description: "A test prompt" }]

      await MCP.add("prompt-server", {
        type: "local",
        command: ["echo", "test"],
      })

      const prompts = await MCP.prompts()
      expect(Object.keys(prompts).length).toBe(1)
      const key = Object.keys(prompts)[0]
      expect(key).toContain("prompt-server")
      expect(key).toContain("my-prompt")
    },
  ),
)

test(
  "resources() returns resources from connected servers",
  withInstance(
    {
      "resource-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    async () => {
      lastCreatedClientName = "resource-server"
      const serverState = getOrCreateClientState("resource-server")
      serverState.resources = [{ name: "my-resource", uri: "file:///test.txt", description: "A test resource" }]

      await MCP.add("resource-server", {
        type: "local",
        command: ["echo", "test"],
      })

      const resources = await MCP.resources()
      expect(Object.keys(resources).length).toBe(1)
      const key = Object.keys(resources)[0]
      expect(key).toContain("resource-server")
      expect(key).toContain("my-resource")
    },
  ),
)

test(
  "prompts() skips disconnected servers",
  withInstance(
    {
      "prompt-disc-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    async () => {
      lastCreatedClientName = "prompt-disc-server"
      const serverState = getOrCreateClientState("prompt-disc-server")
      serverState.prompts = [{ name: "hidden-prompt", description: "Should not appear" }]

      await MCP.add("prompt-disc-server", {
        type: "local",
        command: ["echo", "test"],
      })

      await MCP.disconnect("prompt-disc-server")

      const prompts = await MCP.prompts()
      expect(Object.keys(prompts).length).toBe(0)
    },
  ),
)

// ========================================================================
// Test: connect() on nonexistent server
// ========================================================================

test(
  "connect() on nonexistent server does not throw",
  withInstance({}, async () => {
    // Should not throw
    await MCP.connect("nonexistent")
    const status = await MCP.status()
    expect(status["nonexistent"]).toBeUndefined()
  }),
)

// ========================================================================
// Test: disconnect() on nonexistent server
// ========================================================================

test(
  "disconnect() on nonexistent server does not throw",
  withInstance({}, async () => {
    await MCP.disconnect("nonexistent")
    // Should complete without error
  }),
)

// ========================================================================
// Test: tools() with no MCP servers configured
// ========================================================================

test(
  "tools() returns empty when no MCP servers are configured",
  withInstance({}, async () => {
    const tools = await MCP.tools()
    expect(Object.keys(tools).length).toBe(0)
  }),
)

// ========================================================================
// Test: connect failure during create()
// ========================================================================

test(
  "server that fails to connect is marked as failed",
  withInstance(
    {
      "fail-connect": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    async () => {
      lastCreatedClientName = "fail-connect"
      getOrCreateClientState("fail-connect")
      connectShouldFail = true
      connectError = "Connection refused"

      await MCP.add("fail-connect", {
        type: "local",
        command: ["echo", "test"],
      })

      const status = await MCP.status()
      expect(status["fail-connect"]?.status).toBe("failed")
      if (status["fail-connect"]?.status === "failed") {
        expect(status["fail-connect"].error).toContain("Connection refused")
      }

      // No tools should be available
      const tools = await MCP.tools()
      expect(Object.keys(tools).length).toBe(0)
    },
  ),
)

// ========================================================================
// Bug #5: McpOAuthCallback.cancelPending uses wrong key
// ========================================================================

test("McpOAuthCallback.cancelPending is keyed by mcpName but pendingAuths uses oauthState", async () => {
  const { McpOAuthCallback } = await import("../../src/mcp/oauth-callback")

  // Register a pending auth with an oauthState key, associated to an mcpName
  const oauthState = "abc123hexstate"
  const callbackPromise = McpOAuthCallback.waitForCallback(oauthState, "my-mcp-server")

  // cancelPending is called with mcpName — should find the entry via reverse index
  McpOAuthCallback.cancelPending("my-mcp-server")

  // The callback should still be pending because cancelPending looked up
  // "my-mcp-server" in a map keyed by "abc123hexstate"
  let resolved = false
  let rejected = false
  callbackPromise.then(() => (resolved = true)).catch(() => (rejected = true))

  // Give it a tick
  await new Promise((r) => setTimeout(r, 50))

  // cancelPending("my-mcp-server") should have rejected the pending callback
  expect(rejected).toBe(true)

  await McpOAuthCallback.stop()
})

// ========================================================================
// Test: multiple tools from same server get correct name prefixes
// ========================================================================

test(
  "tools() prefixes tool names with sanitized server name",
  withInstance(
    {
      "my.special-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    async () => {
      lastCreatedClientName = "my.special-server"
      const serverState = getOrCreateClientState("my.special-server")
      serverState.tools = [
        { name: "tool-a", description: "Tool A", inputSchema: { type: "object", properties: {} } },
        { name: "tool.b", description: "Tool B", inputSchema: { type: "object", properties: {} } },
      ]

      await MCP.add("my.special-server", {
        type: "local",
        command: ["echo", "test"],
      })

      const tools = await MCP.tools()
      const keys = Object.keys(tools)

      // Server name dots should be replaced with underscores
      expect(keys.some((k) => k.startsWith("my_special-server_"))).toBe(true)
      // Tool name dots should be replaced with underscores
      expect(keys.some((k) => k.endsWith("tool_b"))).toBe(true)
      expect(keys.length).toBe(2)
    },
  ),
)

// ========================================================================
// Test: transport leak — local stdio timeout (#19168)
// ========================================================================

test(
  "local stdio transport is closed when connect times out (no process leak)",
  withInstance({}, async () => {
    lastCreatedClientName = "hanging-server"
    getOrCreateClientState("hanging-server")
    connectShouldHang = true

    const addResult = await MCP.add("hanging-server", {
      type: "local",
      command: ["node", "fake.js"],
      timeout: 100,
    })

    const serverStatus = (addResult.status as any)["hanging-server"] ?? addResult.status
    expect(serverStatus.status).toBe("failed")
    expect(serverStatus.error).toContain("timed out")
    // Transport must be closed to avoid orphaned child process
    expect(transportCloseCount).toBeGreaterThanOrEqual(1)
  }),
)

// ========================================================================
// Test: transport leak — remote timeout (#19168)
// ========================================================================

test(
  "remote transport is closed when connect times out",
  withInstance({}, async () => {
    lastCreatedClientName = "hanging-remote"
    getOrCreateClientState("hanging-remote")
    connectShouldHang = true

    const addResult = await MCP.add("hanging-remote", {
      type: "remote",
      url: "http://localhost:9999/mcp",
      timeout: 100,
      oauth: false,
    })

    const serverStatus = (addResult.status as any)["hanging-remote"] ?? addResult.status
    expect(serverStatus.status).toBe("failed")
    // Transport must be closed to avoid leaked HTTP connections
    expect(transportCloseCount).toBeGreaterThanOrEqual(1)
  }),
)

// ========================================================================
// Test: transport leak — failed remote transports not closed (#19168)
// ========================================================================

test(
  "failed remote transport is closed before trying next transport",
  withInstance({}, async () => {
    lastCreatedClientName = "fail-remote"
    getOrCreateClientState("fail-remote")
    connectShouldFail = true
    connectError = "Connection refused"

    const addResult = await MCP.add("fail-remote", {
      type: "remote",
      url: "http://localhost:9999/mcp",
      timeout: 5000,
      oauth: false,
    })

    const serverStatus = (addResult.status as any)["fail-remote"] ?? addResult.status
    expect(serverStatus.status).toBe("failed")
    // Both StreamableHTTP and SSE transports should be closed
    expect(transportCloseCount).toBeGreaterThanOrEqual(2)
  }),
)
