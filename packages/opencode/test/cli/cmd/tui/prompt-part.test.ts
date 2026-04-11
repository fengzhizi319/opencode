// 导入 Bun 测试框架的描述、期望和测试函数
import { describe, expect, test } from "bun:test"
// 导入 PromptInfo 类型，用于定义提示历史中的部件结构
import type { PromptInfo } from "../../../../src/cli/cmd/tui/component/prompt/history"
// 导入 assign 和 strip 函数，用于处理提示部件的 ID 管理
import { assign, strip } from "../../../../src/cli/cmd/tui/component/prompt/part"

/**
 * 测试套件：Prompt Part（提示部件）处理
 *
 * 验证 TUI（文本用户界面）中提示部件的 ID 管理机制：
 * - strip: 移除持久化的 ID，用于重用部件时清除旧会话信息
 * - assign: 分配新的运行时 ID，确保每个部件在当前会话中有唯一标识
 */
describe("prompt part", () => {
  /**
   * 测试：strip 函数从重用的文件部件中移除持久化 ID
   *
   * 场景：当用户从历史记录中重用某个文件部件（如图片）时，
   * 需要清除旧的 sessionID、messageID 和 part ID，
   * 以便在新会话中重新分配新的 ID。
   */
  test("strip removes persisted ids from reused file parts", () => {
    // 创建一个模拟的文件部件，包含旧的持久化 ID
    const part = {
      id: "prt_old",        // 旧的部件 ID
      sessionID: "ses_old", // 旧的会话 ID
      messageID: "msg_old", // 旧的消息 ID
      type: "file" as const,// 部件类型：文件
      mime: "image/png",    // MIME 类型
      filename: "tiny.png", // 文件名
      url: "data:image/png;base64,abc", // 数据 URL
    }

    // 调用 strip 函数清理持久化 ID
    expect(strip(part)).toEqual({
      // 验证只保留了与内容相关的字段
      type: "file",
      mime: "image/png",
      filename: "tiny.png",
      url: "data:image/png;base64,abc",
      // id、sessionID、messageID 已被移除
    })
  })

  /**
   * 测试：assign 函数覆盖过时的运行时 ID
   *
   * 场景：当部件被添加到新会话时，需要为其分配新的唯一 ID，
   * 确保不会与旧会话中的 ID 冲突。
   */
  test("assign overwrites stale runtime ids", () => {
    // 创建一个带有旧 ID 的文件部件
    const part = {
      id: "prt_old",        // 旧的部件 ID
      sessionID: "ses_old", // 旧的会话 ID
      messageID: "msg_old", // 旧的消息 ID
      type: "file" as const,// 部件类型：文件
      mime: "image/png",    // MIME 类型
      filename: "tiny.png", // 文件名
      url: "data:image/png;base64,abc", // 数据 URL
    } as PromptInfo["parts"][number]

    // 调用 assign 函数分配新的运行时 ID
    const next = assign(part)

    // 验证生成了新的 ID，且不与旧 ID 相同
    expect(next.id).not.toBe("prt_old")
    // 验证新 ID 符合格式规范（以 "prt_" 开头）
    expect(next.id.startsWith("prt_")).toBe(true)

    // 验证内容相关字段保持不变
    expect(next).toMatchObject({
      type: "file",
      mime: "image/png",
      filename: "tiny.png",
      url: "data:image/png;base64,abc",
    })
  })
})
