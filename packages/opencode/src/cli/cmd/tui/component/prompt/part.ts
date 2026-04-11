// 导入 PartID 类型，用于生成唯一的部件标识符
import { PartID } from "@/session/schema"
// 导入 PromptInfo 类型，定义提示历史的数据结构
import type { PromptInfo } from "./history"

/**
 * Item 类型别名
 *
 * 从 PromptInfo 的 parts 数组中提取单个元素的类型。
 * 表示 TUI 提示输入框中的一个部件（如文本、文件、图片等）。
 */
type Item = PromptInfo["parts"][number]

/**
 * strip 函数：移除部件的持久化 ID 信息
 *
 * 当用户从历史记录中重用某个部件时，需要清除其与旧会话关联的 ID，
 * 以便在新会话中重新分配新的运行时 ID。
 *
 * @param part - 包含旧 ID 信息的部件对象
 * @returns 移除了 id、messageID、sessionID 的纯净部件对象
 *
 * @example
 * // 输入：{ id: "prt_123", sessionID: "ses_456", messageID: "msg_789", type: "file", ... }
 * // 输出：{ type: "file", mime: "image/png", filename: "test.png", url: "..." }
 */
export function strip(part: Item & { id: string; messageID: string; sessionID: string }): Item {
  // 使用解构赋值提取并丢弃三个 ID 字段
  const { id: _id, messageID: _messageID, sessionID: _sessionID, ...rest } = part

  // 返回只包含内容相关字段的对象
  return rest
}

/**
 * assign 函数：为部件分配新的运行时 ID
 *
 * 当部件被添加到当前会话时，为其生成一个唯一的、递增的 PartID。
 * 确保每个部件在当前会话中有唯一标识，便于追踪和管理。
 *
 * @param part - 需要分配 ID 的部件对象（可能没有 id 或 id 已过期）
 * @returns 带有新生成 PartID 的部件对象
 *
 * @example
 * // 输入：{ type: "text", text: "Hello" }
 * // 输出：{ id: "prt_001", type: "text", text: "Hello" }
 */
export function assign(part: Item): Item & { id: PartID } {
  return {
    // 保留原有部件的所有属性
    ...part,
    // 生成新的唯一 ID（基于时间戳递增，保证全局唯一且有序）
    id: PartID.ascending(),
  }
}
