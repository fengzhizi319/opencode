// 导入测试框架和必要的模块
import { afterEach, describe, expect, test } from "bun:test"
import { parseSSE } from "@/control-plane/sse.ts"  // SSE（Server-Sent Events）解析器
import { resetDatabase } from "../fixture/db"  // 数据库重置工具

/**
 * 清理钩子：每个测试用例执行后重置数据库
 * 
 * 目的：确保测试之间互不干扰，每个测试都从干净的数据库状态开始
 */
afterEach(async () => {
  await resetDatabase()
})

/**
 * 辅助函数：将字符串数组转换为 ReadableStream
 * 
 * 作用：
 * - 模拟服务器发送的 SSE 数据流
 * - 将每个字符串块编码为 Uint8Array 并依次推送到流中
 * - 所有块推送完成后关闭流
 * 
 * @param chunks - 要发送到流中的字符串数组（SSE 格式的数据块）
 * @returns 可读流，可用于测试 parseSSE 函数
 * 
 * 示例：
 * ```ts
 * const stream = stream([
 *   'data: {"type":"test"}\r\n\r\n',
 *   'data: {"type":"another"}\r\n\r\n'
 * ])
 * ```
 */
function stream(chunks: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // 创建文本编码器，将字符串转换为 Uint8Array
      const encoder = new TextEncoder()
      // 将每个字符串块编码并推送到流中
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)))
      // 所有块推送完成后关闭流
      controller.close()
    },
  })
}

/**
 * 测试套件：验证 control-plane/sse 模块的 SSE 解析功能
 * 
 * parseSSE() 函数的作用：
 * - 解析 Server-Sent Events (SSE) 格式的数据流
 * - SSE 是一种服务器向客户端推送实时数据的技术
 * - 支持标准的 SSE 字段：data、id、retry
 * - 自动处理 JSON 和非 JSON 格式的数据
 * 
 * SSE 格式示例：
 * ```
 * data: {"type":"event1","properties":{"key":"value"}}
 * 
 * id: 123
 * retry: 5000
 * data: plain text message
 * 
 * ```
 * 
 * 工作流程：
 * 1. 从 ReadableStream 读取数据块
 * 2. 将二进制数据解码为文本
 * 3. 规范化换行符（\r\n → \n, \r → \n）
 * 4. 按双换行符（\n\n）分割事件
 * 5. 解析每个事件的字段（data、id、retry）
 * 6. 尝试将 data 解析为 JSON，失败则作为纯文本处理
 * 7. 通过回调函数返回解析后的事件对象
 * 
 * 应用场景：
 * - 接收控制平面（control-plane）的实时事件推送
 * - 处理 AI Agent 的状态更新、进度通知等
 * - 实现实时的双向通信
 */
describe("control-plane/sse", () => {
  /**
   * 测试用例 1：验证能够正确解析带有 CRLF 换行符和多行数据块的 JSON 事件
   * 
   * 场景说明：
   * - 第一个事件：单行 JSON 数据，使用 CRLF（\r\n）换行符
   * - 第二个事件：多行 data 字段，JSON 被分割成两行
   *   - 第一行：'data: {"type":"two",\r\n'
   *   - 第二行：'data: "properties":{"n":2}}\r\n\r\n'
   *   - 合并后：'{"type":"two",\n"properties":{"n":2}}'
   * 
   * 预期结果：
   * - 两个事件都被正确解析为 JavaScript 对象
   * - 多行 data 字段被正确合并（用 \n 连接）
   * - CRLF 换行符被正确处理
   */
  test("parses JSON events with CRLF and multiline data blocks", async () => {
    // 存储解析后的事件
    const events: unknown[] = []
    // 创建中止控制器，用于在需要时停止解析
    const stop = new AbortController()

    // 调用 parseSSE 解析模拟的 SSE 流
    await parseSSE(
      stream([
        // 第一个事件：简单的单行 JSON
        'data: {"type":"one","properties":{"ok":true}}\r\n\r\n',
        // 第二个事件：多行 JSON 数据
        'data: {"type":"two",\r\ndata: "properties":{"n":2}}\r\n\r\n',
      ]),
      stop.signal,  // 传递中止信号
      (event) => events.push(event),  // 回调函数：收集解析后的事件
    )

    // 验证：两个事件都被正确解析
    expect(events).toEqual([
      { type: "one", properties: { ok: true } },
      { type: "two", properties: { n: 2 } },
    ])
  })

  /**
   * 测试用例 2：验证当数据不是有效 JSON 时，回退到 sse.message 格式
   * 
   * 场景说明：
   * - SSE 事件包含非 JSON 的纯文本数据："hello world"
   * - 同时包含 id 和 retry 字段
   * - 完整事件：
   *   ```
   *   id: abc
   *   retry: 1500
   *   data: hello world
   *   ```
   * 
   * 预期行为：
   * - JSON.parse 失败，触发 catch 分支
   * - 将事件包装为标准格式：{ type: "sse.message", properties: {...} }
   * - properties 包含：
   *   - data: 原始文本数据
   *   - id: 事件 ID（如果存在）
   *   - retry: 重试间隔（默认 1000ms，这里设置为 1500）
   * 
   * 设计目的：
   * - 确保即使收到非 JSON 格式的消息也不会丢失数据
   * - 提供统一的 event 结构，便于上层处理
   * - 保留所有 SSE 元数据（id、retry）
   */
  test("falls back to sse.message for non-json payload", async () => {
    // 存储解析后的事件
    const events: unknown[] = []
    // 创建中止控制器
    const stop = new AbortController()

    // 调用 parseSSE 解析包含纯文本数据的 SSE 流
    await parseSSE(
      stream(["id: abc\nretry: 1500\ndata: hello world\n\n"]),
      stop.signal,
      (event) => events.push(event),  // 回调函数：收集解析后的事件
    )

    // 验证：事件被正确包装为 sse.message 格式
    expect(events).toEqual([
      {
        type: "sse.message",  // 固定类型标识
        properties: {
          data: "hello world",  // 原始文本数据
          id: "abc",            // 事件 ID
          retry: 1500,          // 重试间隔（毫秒）
        },
      },
    ])
  })
})
