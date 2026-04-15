import { describe, test, expect } from "bun:test"
import path from "path"
// import { Instance } from "../../src/project/instance"
// import { WebFetchTool } from "../../src/tool/webfetch"
// import { SessionID, MessageID } from "../../src/session/schema"
import { Instance } from "@/project/instance.ts"
import { WebFetchTool } from "@/tool/webfetch.ts"
import { SessionID, MessageID } from "@/session/schema.ts"

const projectRoot = path.join(__dirname, "../..")

// 构造测试上下文对象，模拟工具执行时的环境
const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

const MB = 1024 * 1024 // 定义 1MB 的字节数
const ITERATIONS = 50 // 测试迭代次数

/**
 * 获取当前堆内存使用量（单位：MB）
 * @returns 堆内存使用量（MB）
 */
const getHeapMB = () => {
  Bun.gc(true) // 强制触发垃圾回收
  return process.memoryUsage().heapUsed / MB
}

/**
 * 测试套件：AbortController 内存泄漏检测
 * 
 * 背景：
 * 在 webfetch 工具的实现中，如果使用闭包方式创建超时处理器，会导致每次请求都捕获
 * 响应内容到闭包作用域中，造成内存泄漏。本测试验证修复后的实现不会泄漏内存。
 * 
 * 技术细节：
 * - 旧的实现：使用箭头函数闭包 `() => controller.abort()`，会捕获外部变量
 * - 新的实现：使用 `controller.abort.bind(controller)`，不捕获外部作用域
 * - 关键差异：闭包会保留对捕获变量的引用，阻止垃圾回收
 */
describe("memory: abort controller leak", () => {
  /**
   * 测试用例：验证 webfetch 工具在多次调用后不会泄漏内存
   * 
   * 测试目的：
   * - 确保 webfetch 工具在重复使用时不会产生持续的内存增长
   * - 验证 AbortController 和超时处理器的正确清理机制
   * - 确认修复后的实现比旧实现有显著的内存改进
   * 
   * 测试方法：
   * 1. 执行一次预热请求，初始化所有必要的资源
   * 2. 记录基准内存使用量
   * 3. 执行 50 次连续的 fetch 请求
   * 4. 测量内存增长量
   * 5. 验证增长量在可接受范围内（每 10 次请求小于 1MB）
   * 
   * 预期结果：
   * - 旧实现：每次请求约增长 0.5MB（闭包捕获大响应体）
   * - 新实现：内存增长应该微乎其微
   */
  test("webfetch does not leak memory over many invocations", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        // 初始化 webfetch 工具
        const tool = await WebFetchTool.init()

        // 预热阶段：执行一次请求以初始化所有资源
        await tool.execute({ url: "https://example.com", format: "text" }, ctx).catch(() => {})

        // 记录基准内存使用量
        Bun.gc(true)
        const baseline = getHeapMB()

        // 执行多次 fetch 请求
        for (let i = 0; i < ITERATIONS; i++) {
          await tool.execute({ url: "https://example.com", format: "text" }, ctx).catch(() => {})
        }

        // 测量最终内存使用量
        Bun.gc(true)
        const after = getHeapMB()
        const growth = after - baseline

        console.log(`Baseline: ${baseline.toFixed(2)} MB`)
        console.log(`After ${ITERATIONS} fetches: ${after.toFixed(2)} MB`)
        console.log(`Growth: ${growth.toFixed(2)} MB`)

        // 验证断言：内存增长应该非常小
        // 标准：每 10 次请求增长小于 1MB
        // 旧实现会增长约 0.5MB/次，新实现应该远低于此
        expect(growth).toBeLessThan(ITERATIONS / 10)
      },
    })
  }, 60000)

  /**
   * 测试用例：直接对比闭包模式与 bind 模式的内存占用
   * 
   * 测试目的：
   * - 量化展示两种实现模式的内存差异
   * - 验证 bind 模式确实能避免闭包捕获导致的内存泄漏
   * - 提供具体的性能改进数据
   * 
   * 技术原理：
   * 
   * 【旧模式 - 闭包】
   * ```typescript
   * const handler = () => {
   *   if (content.length > threshold) controller.abort()
   * }
   * setTimeout(handler, 30000)
   * ```
   * 问题：handler 闭包捕获了 content 变量，即使 content 不再需要，
   * 只要定时器未触发，content 就无法被垃圾回收。
   * 
   * 【新模式 - bind】
   * ```typescript
   * const handler = controller.abort.bind(controller)
   * setTimeout(handler, 30000)
   * ```
   * 优势：bind 只绑定 this 上下文，不捕获外部作用域的变量，
   * content 可以立即被垃圾回收。
   * 
   * 测试步骤：
   * 1. 测试旧模式（闭包）：创建 500 个带大字符串的闭包
   * 2. 测量内存增长
   * 3. 清理资源
   * 4. 测试新模式（bind）：创建 500 个 bind 处理器
   * 5. 测量内存增长
   * 6. 对比两种模式的差异
   */
  test("compare closure vs bind pattern directly", async () => {
    const ITERATIONS = 500 // 增加迭代次数以获得更明显的对比效果

    // ====================================================================
    // 第一部分：测试旧模式（闭包）
    // ====================================================================
    
    // 使用 Map 存储闭包，键为内容本身，强制保持闭包的引用
    const closureMap = new Map<string, () => void>()
    const timers: Timer[] = []
    const controllers: AbortController[] = []

    // 记录初始内存状态
    Bun.gc(true)
    Bun.sleepSync(100) // 等待 GC 完成
    const baseline = getHeapMB()

    // 创建大量闭包，每个都捕获一个大字符串
    for (let i = 0; i < ITERATIONS; i++) {
      // 模拟 webfetch 的大响应体（50KB），每个迭代生成唯一内容
      const content = `${i}:${"x".repeat(50 * 1024)}` // 50KB 唯一内容
      const controller = new AbortController()
      controllers.push(controller)

      // 旧模式 - 闭包捕获 `content` 变量
      const handler = () => {
        // 实际使用 content，防止编译器优化掉
        if (content.length > 1000000000) controller.abort()
      }
      closureMap.set(content, handler) // 存储闭包以保持引用
      const timeoutId = setTimeout(handler, 30000) // 30秒后触发
      timers.push(timeoutId)
    }

    // 测量旧模式的内存增长
    Bun.gc(true)
    Bun.sleepSync(100)
    const after = getHeapMB()
    const oldGrowth = after - baseline

    console.log(`OLD pattern (closure): ${oldGrowth.toFixed(2)} MB growth (${closureMap.size} closures)`)

    // 清理旧模式的资源
    timers.forEach(clearTimeout)
    controllers.forEach((c) => c.abort())
    closureMap.clear()

    // ====================================================================
    // 第二部分：测试新模式（bind）
    // ====================================================================
    
    Bun.gc(true)
    Bun.sleepSync(100)
    const baseline2 = getHeapMB()
    const handlers2: (() => void)[] = []
    const timers2: Timer[] = []
    const controllers2: AbortController[] = []

    for (let i = 0; i < ITERATIONS; i++) {
      // 同样创建 50KB 的内容，但不会被捕获
      const _content = `${i}:${"x".repeat(50 * 1024)}` // 50KB - 不会被捕获
      const controller = new AbortController()
      controllers2.push(controller)

      // 新模式 - bind 不捕获周围作用域
      const handler = controller.abort.bind(controller)
      handlers2.push(handler)
      const timeoutId = setTimeout(handler, 30000)
      timers2.push(timeoutId)
    }

    // 测量新模式的内存增长
    Bun.gc(true)
    Bun.sleepSync(100)
    const after2 = getHeapMB()
    const newGrowth = after2 - baseline2

    // 清理新模式的资源
    timers2.forEach(clearTimeout)
    controllers2.forEach((c) => c.abort())
    handlers2.length = 0

    console.log(`NEW pattern (bind): ${newGrowth.toFixed(2)} MB growth`)
    console.log(`Improvement: ${(oldGrowth - newGrowth).toFixed(2)} MB saved`)

    // 验证断言：新模式的内存增长应该小于或等于旧模式
    expect(newGrowth).toBeLessThanOrEqual(oldGrowth)
  })
})
