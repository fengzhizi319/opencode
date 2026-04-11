import z from "zod"
import type { ZodType } from "zod"

/**
 * BusEvent 命名空间：定义和管理事件总线中的事件类型
 * 
 * PubSub（发布-订阅）事件流的核心机制：
 * - 不是共享内存：不依赖进程间共享的数据结构
 * - 不是跨进程通信（IPC）：不涉及系统级的进程间消息传递
 * - 而是基于 Effect 框架的响应式事件流：
 *   1. 发布者（Publisher）发出事件到事件总线
 *   2. 订阅者（Subscriber）监听感兴趣的事件类型
 *   3. 事件通过 Effect 的响应式流（Stream/Sink）异步传递
 *   4. 所有操作在同一个 JavaScript 运行时内完成，轻量且高效
 * 
 * 优势：
 * - 类型安全：使用 Zod schema 验证事件结构
 * - 解耦：发布者和订阅者互不知晓对方存在
 * - 可扩展：轻松添加新的事件类型和订阅者
 * - 响应式：基于 Effect 的函数式响应式编程模型
 */
export namespace BusEvent {
  // 事件定义类型：由 define 函数返回的对象结构
  export type Definition = ReturnType<typeof define>

  // 事件注册表：存储所有已定义的事件类型及其 schema
  // Key: 事件类型名称（字符串）
  // Value: 事件定义对象（包含 type 和 properties）
  const registry = new Map<string, Definition>()

  /**
   * 定义一个新的事件类型并注册到全局注册表
   * 
   * @param type - 事件的唯一标识符（如 "session.created"、"file.modified"）
   * @param properties - 使用 Zod schema 定义的事件数据结构
   * @returns 事件定义对象，包含 type 和 properties
   * 
   * 工作原理：
   * 1. 创建事件定义对象
   * 2. 将定义存入 registry Map，建立类型名称到 schema 的映射
   * 3. 返回定义对象供后续使用
   * 
   * 示例：
   * ```ts
   * const SessionCreated = BusEvent.define("session.created", z.object({
   *   sessionId: z.string(),
   *   timestamp: z.number()
   * }))
   * ```
   */
  export function define<Type extends string, Properties extends ZodType>(type: Type, properties: Properties) {
    const result = {
      type,        // 事件类型标识符
      properties,  // 事件数据的 Zod schema
    }
    // 注册到全局注册表，使该事件类型可被识别和验证
    registry.set(type, result)
    return result
  }

  /**
   * 生成所有已注册事件的联合 Zod schema
   * 
   * 作用：
   * - 创建一个 discriminated union（区分联合类型），用于验证和解析任意事件
   * - 根据事件的 "type" 字段自动推断具体的事件结构和属性类型
   * - 提供完整的类型信息和运行时验证
   * 
   * 返回值结构示例：
   * ```ts
   * z.discriminatedUnion("type", [
   *   z.object({
   *     type: z.literal("session.created"),
   *     properties: z.object({ sessionId: z.string(), ... })
   *   }),
   *   z.object({
   *     type: z.literal("file.modified"),
   *     properties: z.object({ path: z.string(), ... })
   *   }),
   *   // ... 更多事件类型
   * ])
   * ```
   * 
   * 工作流程：
   * 1. 遍历 registry 中的所有事件定义
   * 2. 为每个事件创建一个 object schema，包含：
   *    - type: 字面量类型（精确匹配事件名称）
   *    - properties: 该事件的数据 schema
   * 3. 使用 discriminatedUnion 将所有事件 schema 合并为一个联合类型
   * 4. 添加元数据引用（ref），用于 OpenAPI 文档生成
   * 
   * 应用场景：
   * - API 端点验证：确保接收到的事件数据符合定义
   * - 类型推断：TypeScript 自动推导具体事件的属性类型
   * - 文档生成：自动生成事件类型的 API 文档
   * 
   * @returns Zod discriminated union schema，包含所有注册的事件类型
   */
  export function payloads() {
    return z
      .discriminatedUnion(
        "type",  // 区分字段：根据 type 字段的值确定具体事件类型
        registry
          .entries()  // 获取注册表中所有事件定义的迭代器
          .map(([type, def]) => {
            // 为每个事件类型创建一个 object schema
            return z
              .object({
                type: z.literal(type),       // 精确匹配事件类型名称
                properties: def.properties,  // 事件数据的 schema
              })
              .meta({
                ref: "Event" + "." + def.type,  // 元数据引用，用于文档生成
              })
          })
          .toArray() as any,  // 转换为数组（TypeScript 类型断言）
      )
      .meta({
        ref: "Event",  // 顶层事件类型的引用标识
      })
  }
}
