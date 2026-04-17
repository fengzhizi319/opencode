import z from "zod"
import { SessionID, MessageID, PartID } from "./schema"
import { Snapshot } from "../snapshot"
import { MessageV2 } from "./message-v2"
import { Session } from "."
import { Log } from "../util/log"
import { SyncEvent } from "../sync"
import { Storage } from "@/storage/storage"
import { Bus } from "../bus"
import { SessionPrompt } from "./prompt"
import { SessionSummary } from "./summary"

/**
 * 会话回滚模块
 * 提供撤销会话中消息或部分内容的能力，支持快照恢复和差异计算
 */
export namespace SessionRevert {
  const log = Log.create({ service: "session.revert" })

  /**
   * 回滚输入参数定义
   * @property sessionID - 会话ID
   * @property messageID - 要回滚的消息ID
   * @property partID - 可选的部分ID，用于回滚消息中的特定部分而非整个消息
   */
  export const RevertInput = z.object({
    sessionID: SessionID.zod,
    messageID: MessageID.zod,
    partID: PartID.zod.optional(),
  })
  export type RevertInput = z.infer<typeof RevertInput>

  /**
   * 执行会话回滚操作
   * 从指定的消息或部分开始，回滚之后的所有内容，并恢复文件快照
   * 
   * @param input - 回滚参数，包含会话ID、消息ID和可选的部分ID
   * @returns 更新后的会话信息
   */
  export async function revert(input: RevertInput) {
    // 确保会话当前不处于繁忙状态（没有正在进行的提示处理）
    SessionPrompt.assertNotBusy(input.sessionID)
    
    // 获取会话中的所有消息
    const all = await Session.messages({ sessionID: input.sessionID })
    let lastUser: MessageV2.User | undefined
    const session = await Session.get(input.sessionID)

    let revert: Session.Info["revert"]
    // 收集需要回滚的补丁列表
    const patches: Snapshot.Patch[] = []
    
    // 遍历所有消息，确定回滚点并收集后续的文件补丁
    for (const msg of all) {
      // 记录最后一个用户消息，用于确定回滚边界
      if (msg.info.role === "user") lastUser = msg.info
      const remaining = []
      
      // 遍历消息中的每个部分
      for (const part of msg.parts) {
        // 如果已经找到回滚点，则收集后续的补丁用于回滚
        if (revert) {
          if (part.type === "patch") {
            patches.push(part)
          }
          continue
        }

        // 检查是否到达回滚目标位置
        if (!revert) {
          // 判断条件：消息ID匹配且未指定部分ID，或者部分ID精确匹配
          if ((msg.info.id === input.messageID && !input.partID) || part.id === input.partID) {
            // 如果剩余部分中没有文本或工具类型的内容，则回滚整个消息
            // 否则只回滚从指定部分开始的内容
            const partID = remaining.some((item) => ["text", "tool"].includes(item.type)) ? input.partID : undefined
            revert = {
              // 确定回滚的消息ID：如果有有效部分则使用当前消息ID，否则回滚到上一个用户消息
              messageID: !partID && lastUser ? lastUser.id : msg.info.id,
              partID,
            }
          }
          remaining.push(part)
        }
      }
    }

    // 如果找到了回滚点，执行回滚操作
    if (revert) {
      const session = await Session.get(input.sessionID)
      // 使用现有快照或创建新快照作为回滚基准点
      revert.snapshot = session.revert?.snapshot ?? (await Snapshot.track())
      
      // 应用补丁回滚，恢复文件到回滚点的状态
      await Snapshot.revert(patches)
      
      // 计算回滚前后的文件差异
      if (revert.snapshot) revert.diff = await Snapshot.diff(revert.snapshot)
      
      // 获取回滚点之后的所有消息，用于计算差异摘要
      const rangeMessages = all.filter((msg) => msg.info.id >= revert!.messageID)
      const diffs = await SessionSummary.computeDiff({ messages: rangeMessages })
      
      // 存储差异信息到持久化存储
      await Storage.write(["session_diff", input.sessionID], diffs)
      
      // 发布差异事件，通知订阅者
      Bus.publish(Session.Event.Diff, {
        sessionID: input.sessionID,
        diff: diffs,
      })
      
      // 设置会话的回滚状态，包含回滚信息和差异摘要
      return Session.setRevert({
        sessionID: input.sessionID,
        revert,
        summary: {
          additions: diffs.reduce((sum, x) => sum + x.additions, 0),
          deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
          files: diffs.length,
        },
      })
    }
    
    // 如果没有找到回滚点，返回原始会话信息
    return session
  }

  /**
   * 取消回滚操作，恢复到回滚前的状态
   * 如果存在回滚快照，则恢复文件系统到快照状态
   * 
   * @param input - 包含会话ID的参数对象
   * @returns 更新后的会话信息
   */
  export async function unrevert(input: { sessionID: SessionID }) {
    log.info("unreverting", input)
    // 确保会话当前不处于繁忙状态
    SessionPrompt.assertNotBusy(input.sessionID)
    
    const session = await Session.get(input.sessionID)
    // 如果没有回滚状态，直接返回
    if (!session.revert) return session
    
    // 如果存在快照，恢复文件系统到快照状态
    if (session.revert.snapshot) await Snapshot.restore(session.revert.snapshot)
    
    // 清除会话的回滚状态
    return Session.clearRevert(input.sessionID)
  }

  /**
   * 清理回滚状态，永久删除回滚点之后的消息或部分
   * 在确认回滚后调用此方法，将临时回滚状态转为永久性更改
   * 
   * @param session - 当前会话信息
   */
  export async function cleanup(session: Session.Info) {
    // 如果没有回滚状态，无需清理
    if (!session.revert) return
    
    const sessionID = session.id
    const msgs = await Session.messages({ sessionID })
    const messageID = session.revert.messageID
    
    // 分类消息：保留的消息和需要删除的消息
    const preserve = [] as MessageV2.WithParts[]
    const remove = [] as MessageV2.WithParts[]
    let target: MessageV2.WithParts | undefined
    
    // 遍历所有消息，根据回滚点进行分组
    for (const msg of msgs) {
      if (msg.info.id < messageID) {
        // 回滚点之前的消息保持不变
        preserve.push(msg)
        continue
      }
      if (msg.info.id > messageID) {
        // 回滚点之后的消息需要删除
        remove.push(msg)
        continue
      }
      // 处理回滚点所在的消息
      if (session.revert.partID) {
        // 如果指定了部分ID，保留该消息（但会删除指定部分之后的内容）
        preserve.push(msg)
        target = msg
        continue
      }
      // 未指定部分ID，删除整个消息
      remove.push(msg)
    }
    
    // 触发已删除消息的事件通知
    for (const msg of remove) {
      SyncEvent.run(MessageV2.Event.Removed, {
        sessionID: sessionID,
        messageID: msg.info.id,
      })
    }
    
    // 处理部分回滚的情况：删除指定部分及其之后的所有内容
    if (session.revert.partID && target) {
      const partID = session.revert.partID
      // 找到要删除部分的起始索引
      const removeStart = target.parts.findIndex((part) => part.id === partID)
      if (removeStart >= 0) {
        // 分割部分列表：保留前面的部分，删除后面的部分
        const preserveParts = target.parts.slice(0, removeStart)
        const removeParts = target.parts.slice(removeStart)
        target.parts = preserveParts
        
        // 触发已删除部分的事件通知
        for (const part of removeParts) {
          SyncEvent.run(MessageV2.Event.PartRemoved, {
            sessionID: sessionID,
            messageID: target.info.id,
            partID: part.id,
          })
        }
      }
    }
    
    // 清除会话的回滚状态，完成清理
    await Session.clearRevert(sessionID)
  }
}
