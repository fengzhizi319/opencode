/**
 * ACP Agent 事件订阅测试文件
 *
 * 测试目标：验证 ACP.Agent 的事件订阅、路由和隔离机制
 *
 * 核心功能：
 * 1. 事件订阅管理 - 确保只创建一个全局事件订阅
 * 2. 会话隔离 - 不同会话的事件不会相互污染
 * 3. 并发处理 - 多个会话的事件可以并发处理而不阻塞
 * 4. 工具调用状态同步 - bash 输出的去重和快照管理
 * 5. 权限请求处理 - 异步权限请求不阻塞其他会话
 */
import { describe, expect, test } from "bun:test"
import { ACP } from "@/acp/agent.ts"
import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import type { Event, EventMessagePartUpdated, ToolStatePending, ToolStateRunning } from "@opencode-ai/sdk/v2"
import { Instance } from "@/project/instance.ts"
import { tmpdir } from "../fixture/fixture"

/**
 * 类型定义：从 AgentSideConnection 的方法签名中提取参数和返回类型
 * 用于在测试中模拟 SDK 的行为
 */
type SessionUpdateParams = Parameters<AgentSideConnection["sessionUpdate"]>[0]
type RequestPermissionParams = Parameters<AgentSideConnection["requestPermission"]>[0]
type RequestPermissionResult = Awaited<ReturnType<AgentSideConnection["requestPermission"]>>

/**
 * 全局事件信封类型
 * 包装 OpenCode 内部事件，包含目录上下文和事件负载
 */
type GlobalEventEnvelope = {
  directory?: string  // 工作目录，用于路由到正确的会话
  payload?: Event     // 实际的事件负载
}

/**
 * 事件控制器接口
 * 用于在测试中手动推送事件到 Agent 的事件流
 */
type EventController = {
  push: (event: GlobalEventEnvelope) => void  // 推送一个事件
  close: () => void                           // 关闭事件流
}

/**
 * 辅助函数：从 tool_call_update 中提取进行中的文本内容
 * 用于验证 bash 命令的输出是否正确同步
 *
 * @param update - 会话更新对象
 * @returns 如果是在进行中的工具调用且包含文本内容，返回文本；否则返回 undefined
 */
function inProgressText(update: SessionUpdateParams["update"]) {
  if (update.sessionUpdate !== "tool_call_update") return undefined
  if (update.status !== "in_progress") return undefined
  if (!update.content || !Array.isArray(update.content)) return undefined
  const first = update.content[0]
  if (!first || first.type !== "content") return undefined
  if (first.content.type !== "text") return undefined
  return first.content.text
}

/**
 * 类型守卫：判断更新是否为 tool_call_update 类型
 * 用于 TypeScript 类型收窄
 */
function isToolCallUpdate(
  update: SessionUpdateParams["update"],
): update is Extract<SessionUpdateParams["update"], { sessionUpdate: "tool_call_update" }> {
  return update.sessionUpdate === "tool_call_update"
}

/**
 * 辅助函数：创建工具事件
 * 将工具调用状态转换为 OpenCode 内部事件格式
 *
 * @param sessionId - 会话 ID
 * @param cwd - 工作目录
 * @param opts - 工具调用选项
 * @returns 封装好的事件信封
 */
function toolEvent(
  sessionId: string,
  cwd: string,
  opts: {
    callID: string
    tool: string
    input: Record<string, unknown>
  } & ({ status: "running"; metadata?: Record<string, unknown> } | { status: "pending"; raw: string }),
): GlobalEventEnvelope {
  // 根据状态构建不同的工具状态对象
  const state: ToolStatePending | ToolStateRunning =
    opts.status === "running"
      ? {
          status: "running",
          input: opts.input,
          ...(opts.metadata && { metadata: opts.metadata }),
          time: { start: Date.now() },
        }
      : {
          status: "pending",
          input: opts.input,
          raw: opts.raw,
        }

  // 构建 message.part.updated 事件
  const payload: EventMessagePartUpdated = {
    type: "message.part.updated",
    properties: {
      sessionID: sessionId,
      time: Date.now(),
      part: {
        id: `part_${opts.callID}`,
        sessionID: sessionId,
        messageID: `msg_${opts.callID}`,
        type: "tool",
        callID: opts.callID,
        tool: opts.tool,
        state,
      },
    },
  }
  return { directory: cwd, payload }
}

/**
 * 创建模拟事件流
 *
 * 实现了一个基于队列的异步迭代器，支持：
 * - 背压（backpressure）：如果消费者还没读取，事件会排队
 * - 等待机制：如果队列为空，消费者会等待新事件
 * - 优雅关闭：关闭时会唤醒所有等待的消费者
 *
 * @returns 包含控制器和流函数的对象
 */
function createEventStream() {
  const queue: GlobalEventEnvelope[] = []  // 事件队列
  const waiters: Array<(value: GlobalEventEnvelope | undefined) => void> = []  // 等待者队列
  const state = { closed: false }  // 关闭状态标记

  /**
   * 推送事件到流中
   * 如果有等待的消费者，直接交付；否则加入队列
   */
  const push = (event: GlobalEventEnvelope) => {
    const waiter = waiters.shift()
    if (waiter) {
      waiter(event)
      return
    }
    queue.push(event)
  }

  /**
   * 关闭事件流
   * 唤醒所有等待的消费者并传递 undefined 表示结束
   */
  const close = () => {
    state.closed = true
    for (const waiter of waiters.splice(0)) {
      waiter(undefined)
    }
  }

  /**
   * 异步生成器函数：消费事件流
   * 支持 AbortSignal 用于取消订阅
   */
  const stream = async function* (signal?: AbortSignal) {
    while (true) {
      if (signal?.aborted) return  // 检查是否被取消

      // 先检查队列中是否有事件
      const next = queue.shift()
      if (next) {
        yield next
        continue
      }

      // 队列为空，检查是否已关闭
      if (state.closed) return

      // 等待新事件到来
      const value = await new Promise<GlobalEventEnvelope | undefined>((resolve) => {
        waiters.push(resolve)
        if (!signal) return
        signal.addEventListener("abort", () => resolve(undefined), { once: true })
      })
      if (!value) return  // 收到 undefined 表示流已结束
      yield value
    }
  }

  return { controller: { push, close } satisfies EventController, stream }
}

/**
 * 创建模拟的 Agent 实例
 *
 * 这是测试的核心基础设施，它：
 * 1. 模拟 ACP SDK 的连接层（connection）
 * 2. 模拟 OpenCode SDK 的所有 API
 * 3. 记录所有会话更新和消息块
 * 4. 提供事件注入控制器
 *
 * @returns 包含 agent 实例、控制器、记录器等在内的完整测试环境
 */
function createFakeAgent() {
  // 记录每个会话收到的更新类型序列
  const updates = new Map<string, string[]>()
  // 记录每个会话累积的文本消息块
  const chunks = new Map<string, string>()
  // 记录所有会话更新参数的完整列表
  const sessionUpdates: SessionUpdateParams[] = []

  /**
   * 记录会话更新类型
   * @param sessionId - 会话 ID
   * @param type - 更新类型（如 "agent_message_chunk"）
   */
  const record = (sessionId: string, type: string) => {
    const list = updates.get(sessionId) ?? []
    list.push(type)
    updates.set(sessionId, list)
  }

  /**
   * 模拟 ACP 连接层
   * 实现 sessionUpdate 和 requestPermission 方法
   */
  const connection = {
    /**
     * 记录会话更新
     * 区分文本消息块和其他类型的更新
     */
    async sessionUpdate(params: SessionUpdateParams) {
      sessionUpdates.push(params)
      const update = params.update
      const type = update?.sessionUpdate ?? "unknown"
      record(params.sessionId, type)

      // 如果是文本消息块，累积到 chunks 中
      if (update?.sessionUpdate === "agent_message_chunk") {
        const content = update.content
        if (content?.type !== "text") return
        if (typeof content.text !== "string") return
        chunks.set(params.sessionId, (chunks.get(params.sessionId) ?? "") + content.text)
      }
    },

    /**
     * 模拟权限请求
     * 默认自动批准（选择 "once" 选项）
     */
    async requestPermission(_params: RequestPermissionParams): Promise<RequestPermissionResult> {
      return { outcome: { outcome: "selected", optionId: "once" } } as RequestPermissionResult
    },
  } as unknown as AgentSideConnection

  // 创建事件流和控制器
  const { controller, stream } = createEventStream()

  // 记录 SDK 调用次数
  const calls = {
    eventSubscribe: 0,   // 事件订阅次数
    sessionCreate: 0,    // 会话创建次数
  }

  /**
   * 模拟 OpenCode SDK
   * 提供所有必要的 API 端点
   */
  const sdk = {
    global: {
      /**
       * 全局事件订阅
       * 每次调用都会增加计数器，用于验证只订阅一次
       */
      event: async (opts?: { signal?: AbortSignal }) => {
        calls.eventSubscribe++
        return { stream: stream(opts?.signal) }
      },
    },
    session: {
      /**
       * 创建新会话
       * 返回递增的会话 ID
       */
      create: async (_params?: any) => {
        calls.sessionCreate++
        return {
          data: {
            id: `ses_${calls.sessionCreate}`,
            time: { created: new Date().toISOString() },
          },
        }
      },
      get: async (_params?: any) => {
        return {
          data: {
            id: "ses_1",
            time: { created: new Date().toISOString() },
          },
        }
      },
      messages: async () => {
        return { data: [] }
      },
      /**
       * 获取单个消息
       * 返回带有 parts 的消息结构，用于 delta 事件处理
       */
      message: async (params?: any) => {
        return {
          data: {
            info: {
              role: "assistant",
            },
            parts: [
              {
                id: params?.messageID ? `${params.messageID}_part` : "part_1",
                type: "text",
                text: "",
              },
            ],
          },
        }
      },
    },
    permission: {
      respond: async () => {
        return { data: true }
      },
    },
    config: {
      providers: async () => {
        return {
          data: {
            providers: [
              {
                id: "opencode",
                name: "opencode",
                models: {
                  "big-pickle": { id: "big-pickle", name: "big-pickle" },
                },
              },
            ],
          },
        }
      },
    },
    app: {
      agents: async () => {
        return {
          data: [
            {
              name: "build",
              description: "build",
              mode: "agent",
            },
          ],
        }
      },
    },
    command: {
      list: async () => {
        return { data: [] }
      },
    },
    mcp: {
      add: async () => {
        return { data: true }
      },
    },
  } as any

  // 创建真实的 ACP Agent 实例（使用模拟的依赖）
  const agent = new ACP.Agent(connection, {
    sdk,
    defaultModel: { providerID: "opencode", modelID: "big-pickle" },
  } as any)

  /**
   * 停止函数：清理资源
   * 关闭事件流并中止事件订阅
   */
  const stop = () => {
    controller.close()
    ;(agent as any).eventAbort.abort()
  }

  return { agent, controller, calls, updates, chunks, sessionUpdates, stop, sdk, connection }
}

/**
 * ============================================================================
 * 测试套件：ACP Agent 事件订阅
 * ============================================================================
 */
describe("acp.agent event subscription", () => {

  /**
   * 测试用例 1：事件路由基于 sessionID，不会跨会话污染
   *
   * 测试目的：
   * - 验证 message.part.delta 事件能正确路由到对应的会话
   * - 确保 sessionA 的事件不会错误地发送给 sessionB
   *
   * 场景：
   * 1. 创建两个会话 sessionA 和 sessionB
   * 2. 向 sessionB 发送文本增量事件
   * 3. 验证只有 sessionB 收到了 agent_message_chunk 更新
   */
  test("routes message.part.delta by the event sessionID (no cross-session pollution)", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { agent, controller, updates, stop } = createFakeAgent()
        const cwd = "/tmp/opencode-acp-test"

        // 创建两个独立的会话
        const sessionA = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)
        const sessionB = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)

        // 向 sessionB 发送文本增量事件
        controller.push({
          directory: cwd,
          payload: {
            type: "message.part.delta",
            properties: {
              sessionID: sessionB,
              messageID: "msg_1",
              partID: "msg_1_part",
              field: "text",
              delta: "hello",
            },
          },
        } as any)

        // 等待事件处理完成
        await new Promise((r) => setTimeout(r, 10))

        // 验证 sessionA 没有收到任何消息块
        expect((updates.get(sessionA) ?? []).includes("agent_message_chunk")).toBe(false)
        // 验证 sessionB 收到了消息块
        expect((updates.get(sessionB) ?? []).includes("agent_message_chunk")).toBe(true)

        stop()
      },
    })
  })

  /**
   * 测试用例 2：并发会话的消息增量保持隔离
   *
   * 测试目的：
   * - 验证当多个会话的消息增量事件交错到达时，每个会话的消息内容保持完整
   * - 确保不会出现消息片段混合的情况
   *
   * 场景：
   * 1. 创建 sessionA 和 sessionB
   * 2. 交替向两个会话发送消息片段
   *    sessionA: ALPHA_111_X
   *    sessionB: BETA_222_Y
   * 3. 验证每个会话最终收到的消息是完整的，没有混杂对方的内容
   */
  test("keeps concurrent sessions isolated when message.part.delta events are interleaved", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { agent, controller, chunks, stop } = createFakeAgent()
        const cwd = "/tmp/opencode-acp-test"

        const sessionA = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)
        const sessionB = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)

        // 定义两个会话的消息片段
        const tokenA = ["ALPHA_", "111", "_X"]
        const tokenB = ["BETA_", "222", "_Y"]

        /**
         * 辅助函数：推送消息增量事件
         */
        const push = (sessionId: string, messageID: string, delta: string) => {
          controller.push({
            directory: cwd,
            payload: {
              type: "message.part.delta",
              properties: {
                sessionID: sessionId,
                messageID,
                partID: `${messageID}_part`,
                field: "text",
                delta,
              },
            },
          } as any)
        }

        // 交替推送两个会话的消息片段（模拟并发场景）
        push(sessionA, "msg_a", tokenA[0])
        push(sessionB, "msg_b", tokenB[0])
        push(sessionA, "msg_a", tokenA[1])
        push(sessionB, "msg_b", tokenB[1])
        push(sessionA, "msg_a", tokenA[2])
        push(sessionB, "msg_b", tokenB[2])

        // 等待所有事件处理完成
        await new Promise((r) => setTimeout(r, 20))

        // 获取两个会话累积的消息内容
        const a = chunks.get(sessionA) ?? ""
        const b = chunks.get(sessionB) ?? ""

        // 验证每个会话都收到了完整的消息
        expect(a).toContain(tokenA.join(""))
        expect(b).toContain(tokenB.join(""))

        // 验证没有交叉污染
        for (const part of tokenB) expect(a).not.toContain(part)
        for (const part of tokenA) expect(b).not.toContain(part)

        stop()
      },
    })
  })

  /**
   * 测试用例 3：重复调用 loadSession 不会创建额外的事件订阅
   *
   * 测试目的：
   * - 验证事件订阅只在 Agent 初始化时创建一次
   * - 防止内存泄漏和重复事件处理
   *
   * 场景：
   * 1. 创建一个会话
   * 2. 多次调用 loadSession（4次）
   * 3. 验证 eventSubscribe 只被调用了 1 次
   */
  test("does not create additional event subscriptions on repeated loadSession()", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { agent, calls, stop } = createFakeAgent()
        const cwd = "/tmp/opencode-acp-test"

        const sessionId = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)

        // 多次加载同一个会话
        await agent.loadSession({ sessionId, cwd, mcpServers: [] } as any)
        await agent.loadSession({ sessionId, cwd, mcpServers: [] } as any)
        await agent.loadSession({ sessionId, cwd, mcpServers: [] } as any)
        await agent.loadSession({ sessionId, cwd, mcpServers: [] } as any)

        // 验证只订阅了一次事件
        expect(calls.eventSubscribe).toBe(1)

        stop()
      },
    })
  })

  /**
   * 测试用例 4：permission.asked 事件能被正确处理并回复
   *
   * 测试目的：
   * - 验证权限请求事件的处理流程
   * - 确保 Agent 会调用 SDK 的 permission.reply 方法
   *
   * 场景：
   * 1. 创建会话
   * 2. 推送 permission.asked 事件（请求 bash 权限）
   * 3. 验证 SDK 的 permission.reply 被调用
   */
  test("permission.asked events are handled and replied", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const permissionReplies: string[] = []  // 记录权限回复的请求 ID
        const { agent, controller, stop, sdk } = createFakeAgent()

        // 重写 permission.reply 方法以记录调用
        sdk.permission.reply = async (params: any) => {
          permissionReplies.push(params.requestID)
          return { data: true }
        }

        const cwd = "/tmp/opencode-acp-test"

        const sessionA = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)

        // 推送权限请求事件
        controller.push({
          directory: cwd,
          payload: {
            type: "permission.asked",
            properties: {
              id: "perm_1",
              sessionID: sessionA,
              permission: "bash",
              patterns: ["*"],
              metadata: {},
              always: [],
            },
          },
        } as any)

        // 等待事件处理
        await new Promise((r) => setTimeout(r, 20))

        // 验证权限请求已被回复
        expect(permissionReplies).toContain("perm_1")

        stop()
      },
    })
  })

  /**
   * 测试用例 5：会话 A 的权限请求不会阻塞会话 B 的消息更新
   *
   * 测试目的：
   * - 验证权限请求是异步处理的，不会阻塞事件循环
   * - 确保不同会话的事件处理是并发的
   *
   * 场景：
   * 1. 创建 sessionA 和 sessionB
   * 2. 向 sessionA 发送权限请求（人为延迟处理）
   * 3. 在 sessionA 权限等待期间，向 sessionB 发送消息
   * 4. 验证 sessionB 的消息能立即处理，不受 sessionA 影响
   * 5. 释放 sessionA 的权限阻塞，验证最终也能处理
   */
  test("permission prompt on session A does not block message updates for session B", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const permissionReplies: string[] = []
        let resolvePermissionA: (() => void) | undefined

        // 创建一个 Promise，用于控制 sessionA 权限请求的释放时机
        const permissionABlocking = new Promise<void>((r) => {
          resolvePermissionA = r
        })

        const { agent, controller, chunks, stop, sdk, connection } = createFakeAgent()

        // 重写 requestPermission 方法，让 sessionA 的请求阻塞
        const originalRequestPermission = connection.requestPermission.bind(connection)
        let permissionCalls = 0
        connection.requestPermission = async (params: RequestPermissionParams) => {
          permissionCalls++
          // 如果是以 "1" 结尾的会话 ID（sessionA），则等待释放
          if (params.sessionId.endsWith("1")) {
            await permissionABlocking
          }
          return originalRequestPermission(params)
        }

        sdk.permission.reply = async (params: any) => {
          permissionReplies.push(params.requestID)
          return { data: true }
        }

        const cwd = "/tmp/opencode-acp-test"

        const sessionA = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)
        const sessionB = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)

        // 推送 sessionA 的权限请求（会阻塞）
        controller.push({
          directory: cwd,
          payload: {
            type: "permission.asked",
            properties: {
              id: "perm_a",
              sessionID: sessionA,
              permission: "bash",
              patterns: ["*"],
              metadata: {},
              always: [],
            },
          },
        } as any)

        // 等待权限处理开始
        await new Promise((r) => setTimeout(r, 10))

        // 在 sessionA 权限等待期间，推送 sessionB 的消息
        controller.push({
          directory: cwd,
          payload: {
            type: "message.part.delta",
            properties: {
              sessionID: sessionB,
              messageID: "msg_b",
              partID: "msg_b_part",
              field: "text",
              delta: "session_b_message",
            },
          },
        } as any)

        // 等待 sessionB 的消息处理完成
        await new Promise((r) => setTimeout(r, 20))

        // 验证 sessionB 收到了消息，尽管 sessionA 的权限还在等待
        expect(chunks.get(sessionB) ?? "").toContain("session_b_message")
        // 验证 sessionA 的权限尚未回复（因为还在阻塞）
        expect(permissionReplies).not.toContain("perm_a")

        // 释放 sessionA 的权限阻塞
        resolvePermissionA!()
        await new Promise((r) => setTimeout(r, 20))

        // 现在 sessionA 的权限应该已回复
        expect(permissionReplies).toContain("perm_a")

        stop()
      },
    })
  })

  /**
   * 测试用例 6：流式传输 bash 输出快照并进行去重
   *
   * 测试目的：
   * - 验证 bash 命令的实时输出能正确同步到客户端
   * - 验证相同的输出不会被重复发送（去重机制）
   *
   * 场景：
   * 1. 创建会话并启动 bash 工具
   * 2. 推送三次 running 状态，输出分别为："a", "a", "ab"
   * 3. 验证第二次 "a" 被去重（发送 undefined），第三次 "ab" 正常发送
   */
  test("streams running bash output snapshots and de-dupes identical snapshots", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { agent, controller, sessionUpdates, stop } = createFakeAgent()
        const cwd = "/tmp/opencode-acp-test"
        const sessionId = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)
        const input = { command: "echo hello", description: "run command" }

        // 推送三次 bash 运行状态
        for (const output of ["a", "a", "ab"]) {
          controller.push(
            toolEvent(sessionId, cwd, {
              callID: "call_1",
              tool: "bash",
              status: "running",
              input,
              metadata: { output },
            }),
          )
        }
        await new Promise((r) => setTimeout(r, 20))

        // 提取所有进行中的文本快照
        const snapshots = sessionUpdates
          .filter((u) => u.sessionId === sessionId)
          .filter((u) => isToolCallUpdate(u.update))
          .map((u) => inProgressText(u.update))

        // 验证：第一次 "a" 发送，第二次 "a" 去重（undefined），第三次 "ab" 发送
        expect(snapshots).toEqual(["a", undefined, "ab"])
        stop()
      },
    })
  })

  /**
   * 测试用例 7：为任何工具的第一个 running 更新前自动生成 synthetic pending 事件
   *
   * 测试目的：
   * - 验证当收到工具的 running 状态时，如果之前没有 pending 状态，会自动生成一个
   * - 确保客户端能看到完整的工具生命周期（pending → running → completed）
   *
   * 场景：
   * 1. 直接推送 bash 和 read 工具的 running 状态（跳过 pending）
   * 2. 验证系统自动生成了 pending 事件
   * 3. 验证事件顺序：tool_call(pending) → tool_call_update(running)
   */
  test("emits synthetic pending before first running update for any tool", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { agent, controller, sessionUpdates, stop } = createFakeAgent()
        const cwd = "/tmp/opencode-acp-test"
        const sessionId = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)

        // 直接推送 running 状态（没有先推送 pending）
        controller.push(
          toolEvent(sessionId, cwd, {
            callID: "call_bash",
            tool: "bash",
            status: "running",
            input: { command: "echo hi", description: "run command" },
            metadata: { output: "hi\n" },
          }),
        )
        controller.push(
          toolEvent(sessionId, cwd, {
            callID: "call_read",
            tool: "read",
            status: "running",
            input: { filePath: "/tmp/example.txt" },
          }),
        )
        await new Promise((r) => setTimeout(r, 20))

        // 提取所有工具相关的事件类型
        const types = sessionUpdates
          .filter((u) => u.sessionId === sessionId)
          .map((u) => u.update.sessionUpdate)
          .filter((u) => u === "tool_call" || u === "tool_call_update")

        // 验证：每个工具都有 pending + running 两个事件
        expect(types).toEqual(["tool_call", "tool_call_update", "tool_call", "tool_call_update"])

        // 验证所有 tool_call 事件都是 pending 状态
        const pendings = sessionUpdates.filter(
          (u) => u.sessionId === sessionId && u.update.sessionUpdate === "tool_call",
        )
        expect(pendings.every((p) => p.update.sessionUpdate === "tool_call" && p.update.status === "pending")).toBe(
          true,
        )
        stop()
      },
    })
  })

  /**
   * 测试用例 8：重放的 running 工具不会产生重复的 synthetic pending
   *
   * 测试目的：
   * - 验证在加载历史会话时，如果工具已经是 running 状态，不会再次生成 pending
   * - 确保会话恢复时的事件序列是正确的
   *
   * 场景：
   * 1. 模拟历史会话中有一个 running 状态的 bash 工具
   * 2. 加载该会话（会重放历史消息）
   * 3. 推送新的 running 更新
   * 4. 验证只生成了一个 pending（在重放时），后续更新不会再生成
   */
  test("does not emit duplicate synthetic pending after replayed running tool", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { agent, controller, sessionUpdates, stop, sdk } = createFakeAgent()
        const cwd = "/tmp/opencode-acp-test"
        const sessionId = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)
        const input = { command: "echo hi", description: "run command" }

        // 模拟历史消息中有一个 running 状态的工具
        sdk.session.messages = async () => ({
          data: [
            {
              info: {
                role: "assistant",
                sessionID: sessionId,
              },
              parts: [
                {
                  type: "tool",
                  callID: "call_1",
                  tool: "bash",
                  state: {
                    status: "running",
                    input,
                    metadata: { output: "hi\n" },
                    time: { start: Date.now() },
                  },
                },
              ],
            },
          ],
        })

        // 加载会话（会重放历史消息，生成第一个 pending）
        await agent.loadSession({ sessionId, cwd, mcpServers: [] } as any)

        // 推送新的 running 更新
        controller.push(
          toolEvent(sessionId, cwd, {
            callID: "call_1",
            tool: "bash",
            status: "running",
            input,
            metadata: { output: "hi\nthere\n" },
          }),
        )
        await new Promise((r) => setTimeout(r, 20))

        // 提取该工具的所有事件类型
        const types = sessionUpdates
          .filter((u) => u.sessionId === sessionId)
          .map((u) => u.update)
          .filter((u) => "toolCallId" in u && u.toolCallId === "call_1")
          .map((u) => u.sessionUpdate)
          .filter((u) => u === "tool_call" || u === "tool_call_update")

        // 验证：只有一个 pending（重放时生成），后续是两个 running 更新
        expect(types).toEqual(["tool_call", "tool_call_update", "tool_call_update"])
        stop()
      },
    })
  })

  /**
   * 测试用例 9：pending 状态会清除 bash 快照标记
   *
   * 测试目的：
   * - 验证当工具从 running 回到 pending 状态时，之前的快照会被清除
   * - 确保下次 running 时即使输出相同也会重新发送
   *
   * 场景：
   * 1. 推送 running 状态，输出 "a"
   * 2. 推送 pending 状态（重置）
   * 3. 再次推送 running 状态，输出仍然是 "a"
   * 4. 验证两次 "a" 都被发送了（因为 pending 清除了快照）
   */
  test("clears bash snapshot marker on pending state", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { agent, controller, sessionUpdates, stop } = createFakeAgent()
        const cwd = "/tmp/opencode-acp-test"
        const sessionId = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)
        const input = { command: "echo hello", description: "run command" }

        // 第一次 running，输出 "a"
        controller.push(
          toolEvent(sessionId, cwd, {
            callID: "call_1",
            tool: "bash",
            status: "running",
            input,
            metadata: { output: "a" },
          }),
        )

        // 回到 pending 状态（应该清除快照）
        controller.push(
          toolEvent(sessionId, cwd, {
            callID: "call_1",
            tool: "bash",
            status: "pending",
            input,
            raw: '{"command":"echo hello"}',
          }),
        )

        // 再次 running，输出仍然是 "a"
        controller.push(
          toolEvent(sessionId, cwd, {
            callID: "call_1",
            tool: "bash",
            status: "running",
            input,
            metadata: { output: "a" },
          }),
        )
        await new Promise((r) => setTimeout(r, 20))

        // 提取所有快照
        const snapshots = sessionUpdates
          .filter((u) => u.sessionId === sessionId)
          .filter((u) => isToolCallUpdate(u.update))
          .map((u) => inProgressText(u.update))

        // 验证：两次 "a" 都被发送了（pending 清除了去重标记）
        expect(snapshots).toEqual(["a", "a"])
        stop()
      },
    })
  })
})
