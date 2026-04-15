/**
 * 解析 Server-Sent Events (SSE) 数据流
 * 
 * SSE 是一种服务器向客户端推送实时数据的 HTTP 技术：
 * - 单向通信：服务器 → 客户端
 * - 基于 HTTP 长连接
 * - 自动重连机制
 * - 文本格式，易于调试
 * 
 * SSE 消息格式示例：
 * ```
 * id: 123
 * retry: 3000
 * data: {"type": "message", "content": "Hello"}
 * 
 * data: First line
 * data: Second line
 * 
 * ```
 * 
 * @param body - ReadableStream，包含 SSE 数据流（通常是 fetch 响应的 body）
 * @param signal - AbortSignal，用于取消订阅和清理资源
 * @param onEvent - 回调函数，每次解析到一个完整事件时调用
 *                  - 如果 data 是有效的 JSON，传入解析后的对象
 *                  - 如果 data 不是 JSON，传入包装对象 { type, properties }
 * 
 * 工作流程：
 * 1. 创建流读取器和文本解码器
 * 2. 监听 abort 信号，支持优雅取消
 * 3. 循环读取数据块，累积到缓冲区
 * 4. 规范化换行符（\r\n → \n, \r → \n）
 * 5. 按双换行符（\n\n）分割事件
 * 6. 保留最后一个不完整的事件在缓冲区
 * 7. 解析每个事件的字段（data、id、retry）
 * 8. 尝试将 data 解析为 JSON，失败则作为纯文本处理
 * 9. 调用 onEvent 回调传递解析结果
 * 10. finally 块确保资源清理（移除监听器、释放锁）
 * 
 * 关键字段说明：
 * - data: 事件数据，可以有多行，用 \n 连接
 * - id: 事件 ID，用于断点续传（最后收到的 id 会保存）
 * - retry: 重连时间间隔（毫秒），默认 1000ms
 * 
 * 错误处理：
 * - 读取错误：捕获并视为流结束（done: true）
 * - JSON 解析错误：捕获并返回原始文本数据
 * - 资源清理：finally 块确保无论成功或失败都清理资源
 * 
 * 使用示例：
 * ```typescript
 * const response = await fetch('/api/events')
 * await parseSSE(
 *   response.body!,
 *   controller.signal,
 *   (event) => {
 *     console.log('Received event:', event)
 *   }
 * )
 * ```
 */
export async function parseSSE(
  body: ReadableStream<Uint8Array>,  // SSE 数据流
  signal: AbortSignal,                // 取消信号
  onEvent: (event: unknown) => void,  // 事件回调
) {
  // 获取流读取器，用于逐块读取数据
  const reader = body.getReader()
  // 创建文本解码器，将 Uint8Array 转换为字符串
  const decoder = new TextDecoder()
  // 缓冲区，存储未完整的事件数据
  let buf = ""
  // 记录最后一个事件 ID，用于断点续传
  let last = ""
  // 重连时间间隔（毫秒），默认 1000ms
  let retry = 1000

  /**
   * 中止处理函数：取消流读取
   * 
   * 当 AbortSignal 触发时调用，确保及时释放资源
   * 忽略 cancel() 可能的错误（流可能已经关闭）
   */
  const abort = () => {
    void reader.cancel().catch(() => undefined)
  }

  // 注册 abort 事件监听器，支持外部取消
  signal.addEventListener("abort", abort)

  try {
    // 主循环：持续读取数据直到流结束或被取消
    while (!signal.aborted) {
      // 读取下一个数据块
      // 如果读取失败（如网络错误），视为流结束
      const chunk = await reader.read().catch(() => ({ done: true, value: undefined as Uint8Array | undefined }))
      
      // 流已结束，退出循环
      if (chunk.done) break

      // 将二进制数据解码为文本，并追加到缓冲区
      // { stream: true } 表示这是流式数据，保留未完成的 UTF-8 序列
      buf += decoder.decode(chunk.value, { stream: true })
      
      // 规范化换行符：统一使用 \n
      // 处理不同平台的换行符差异（Windows: \r\n, Mac: \r, Unix: \n）
      buf = buf.replace(/\r\n/g, "\n").replace(/\r/g, "\n")

      // 按双换行符分割事件（SSE 规范：事件之间用空行分隔）
      const chunks = buf.split("\n\n")
      // 保留最后一个元素（可能是不完整的事件）在缓冲区
      buf = chunks.pop() ?? ""

      // 处理每个完整的事件
      chunks.forEach((chunk) => {
        // 存储多行 data 字段
        const data: string[] = []
        
        // 逐行解析事件字段
        chunk.split("\n").forEach((line) => {
          // 解析 data 字段：提取 "data: " 后的内容
          if (line.startsWith("data:")) {
            data.push(line.replace(/^data:\s*/, ""))  // 去除 "data:" 和前导空格
            return
          }
          
          // 解析 id 字段：更新最后的事件 ID
          if (line.startsWith("id:")) {
            last = line.replace(/^id:\s*/, "")  // 去除 "id:" 和前导空格
            return
          }
          
          // 解析 retry 字段：更新重连时间间隔
          if (line.startsWith("retry:")) {
            const parsed = Number.parseInt(line.replace(/^retry:\s*/, ""), 10)
            // 只接受有效的数字
            if (!Number.isNaN(parsed)) retry = parsed
          }
        })

        // 如果没有 data 字段，跳过该事件（SSE 规范要求必须有 data）
        if (!data.length) return
        
        // 将多行 data 合并为一个字符串（用 \n 连接）
        const raw = data.join("\n")
        
        // 尝试将 data 解析为 JSON
        try {
          // 成功：传递解析后的 JSON 对象
          onEvent(JSON.parse(raw))
        } catch {
          // 失败：传递包装对象，保留原始文本
          onEvent({
            type: "sse.message",  // 标记为非 JSON 消息
            properties: {
              data: raw,           // 原始文本数据
              id: last || undefined,  // 事件 ID（如果有）
              retry,               // 重连时间间隔
            },
          })
        }
      })
    }
  } finally {
    // 无论成功或失败，都要清理资源
    
    // 移除 abort 事件监听器，防止内存泄漏
    signal.removeEventListener("abort", abort)
    
    // 释放流读取器的锁，允许其他操作使用该流
    reader.releaseLock()
  }
}
