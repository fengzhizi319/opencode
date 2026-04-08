import { Schema } from "effect"
import z from "zod"

import { Identifier } from "@/id/id"
import { withStatics } from "@/util/schema"

/**
 * SessionID 类型与生成器
 * 基于 Effect Schema 定义的一个带前缀(`session_`)的安全强类型字符串。
 * 它能够避免我们在内部业务代码中，意外地把 messageID 当做 sessionID 传递给函数。
 */
export const SessionID = Schema.String.pipe(
  Schema.brand("SessionID"),
  withStatics((s) => ({
    make: (id: string) => s.makeUnsafe(id),
    // descending 生产带递减时间戳前缀的唯一ID，适用于要求倒排最新数据的场景（如最近活跃会话）。
    descending: (id?: string) => s.makeUnsafe(Identifier.descending("session", id)),
    zod: Identifier.schema("session").pipe(z.custom<Schema.Schema.Type<typeof s>>()),
  })),
)

// 导出纯基础类型，供 interface 消费。
export type SessionID = Schema.Schema.Type<typeof SessionID>

/**
 * MessageID 类型与生成器
 * 定义表示单个消息或提示的强类型标识符，同样挂载了创建和 Zod 验证静态方法。
 * 由于它是对话流记录，我们按正序时间来生成(ascending)，以确保其在数据库能保持时序顺序插入。
 */
export const MessageID = Schema.String.pipe(
  Schema.brand("MessageID"),
  withStatics((s) => ({
    make: (id: string) => s.makeUnsafe(id),
    ascending: (id?: string) => s.makeUnsafe(Identifier.ascending("message", id)),
    zod: Identifier.schema("message").pipe(z.custom<Schema.Schema.Type<typeof s>>()),
  })),
)

export type MessageID = Schema.Schema.Type<typeof MessageID>

/**
 * PartID 类型与生成器
 * 针对 Message 中更细的 Content Parts 颗粒，比如一个消息中包含了 `text_part` 和 `tool_call_part`，
 * PartID 就对应这更小一层切片的唯一时序标识。
 */
export const PartID = Schema.String.pipe(
  Schema.brand("PartID"),
  withStatics((s) => ({
    make: (id: string) => s.makeUnsafe(id),
    ascending: (id?: string) => s.makeUnsafe(Identifier.ascending("part", id)),
    zod: Identifier.schema("part").pipe(z.custom<Schema.Schema.Type<typeof s>>()),
  })),
)

export type PartID = Schema.Schema.Type<typeof PartID>
