import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { SessionID } from "./schema"
import z from "zod"
import { Database, eq, asc } from "../storage/db"
import { TodoTable } from "./session.sql"

/**
 * Todo 模块
 * 负责管理会话(Session)过程中的待办事项(Tasks)，它与底层 SQLite 数据库(Drizzle)交互，
 * 并通过事件总线(Bus)给整个 App(如 UI 端)派发任务进度状态变更的通知。
 */
export namespace Todo {
  /**
   * Todo.Info: 单个待办事项的 Schema 定义
   * 必须包含描述内容、当前状态(pending/in_progress/completed/cancelled)以及优先级(high/medium/low)。
   */
  export const Info = z
    .object({
      content: z.string().describe("Brief description of the task"),
      status: z.string().describe("Current status of the task: pending, in_progress, completed, cancelled"),
      priority: z.string().describe("Priority level of the task: high, medium, low"),
    })
    .meta({ ref: "Todo" })
  
  // 导出类型推导，以供内部函数签名使用
  export type Info = z.infer<typeof Info>

  /**
   * Event 命名空间:
   * 内部定义了会话更新的全局事件。当某个操作（如大模型调用 tool）改变了待办事项时，
   * 会通过 Bus 触发该事件，订阅者（桌面端或 Terminal UI）即可实时刷新画面。
   */
  export const Event = {
    Updated: BusEvent.define(
      "todo.updated",
      z.object({
        sessionID: SessionID.zod,
        todos: z.array(Info),
      }),
    ),
  }

  /**
   * update 函数：
   * 在 SQLite 中开启一个全量写入事务：
   * 1. 强制清理、删除当前 sessionID 下旧的所有待办（通过 delete）。
   * 2. 如果新集合不为空，则批量重新插入新的带 position 排序的 Todo，确保严格有序。
   * 3. 在底层存储更换完后，触发 Event.Updated 广播事件给订阅侧。
   * @param input 包含 sessionID 及其全量替换的 todos 列表内容
   */
  export function update(input: { sessionID: SessionID; todos: Info[] }) {
    Database.transaction((db) => {
      db.delete(TodoTable).where(eq(TodoTable.session_id, input.sessionID)).run()
      if (input.todos.length === 0) return
      db.insert(TodoTable)
        .values(
          input.todos.map((todo, position) => ({
            session_id: input.sessionID,
            content: todo.content,
            status: todo.status,
            priority: todo.priority,
            position,
          })),
        )
        .run()
    })
    Bus.publish(Event.Updated, input)
  }

  /**
   * get 函数：
   * 从数据库查询并返回某个 Session 当前所拥有的待办事项列表。
   * 会基于位置 (position) 正序排列，确保渲染和逻辑处理有序。
   * @param sessionID - 需要查询信息的的会话 ID
   * @returns 匹配的 Todo.Info[] 数据结构
   */
  export function get(sessionID: SessionID) {
    const rows = Database.use((db) =>
      db.select().from(TodoTable).where(eq(TodoTable.session_id, sessionID)).orderBy(asc(TodoTable.position)).all(),
    )
    return rows.map((row) => ({
      content: row.content,
      status: row.status,
      priority: row.priority,
    }))
  }
}
