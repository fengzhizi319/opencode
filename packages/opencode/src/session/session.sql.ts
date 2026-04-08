// 导入 Drizzle ORM 的 SQLite 表定义工具和数据类型
import { sqliteTable, text, integer, index, primaryKey } from "drizzle-orm/sqlite-core"
// 导入项目表定义，用于建立外键关系
import { ProjectTable } from "../project/project.sql"
// 导入消息 V2 类型定义
import type { MessageV2 } from "./message-v2"
// 导入快照类型定义
import type { Snapshot } from "../snapshot"
// 导入权限类型定义
import type { Permission } from "../permission"
// 导入项目 ID 类型
import type { ProjectID } from "../project/schema"
// 导入会话、消息、部分 ID 类型
import type { SessionID, MessageID, PartID } from "./schema"
// 导入工作区 ID 类型
import type { WorkspaceID } from "../control-plane/schema"
// 导入时间戳字段定义（created_at, updated_at 等）
import { Timestamps } from "../storage/schema.sql"

/**
 * PartData 类型：消息部分数据
 * 从 MessageV2.Part 中排除 id、sessionID、messageID 字段
 * 这些字段由数据库自动生成和管理
 */
type PartData = Omit<MessageV2.Part, "id" | "sessionID" | "messageID">

/**
 * InfoData 类型：消息信息数据
 * 从 MessageV2.Info 中排除 id、sessionID 字段
 * 这些字段由数据库自动生成和管理
 */
type InfoData = Omit<MessageV2.Info, "id" | "sessionID">

/**
 * SessionTable - 会话表
 *
 * 存储用户与 AI 助手的对话会话信息。
 * 每个会话属于一个项目，可以包含多个消息。
 * 支持会话嵌套（parent_id）和工作区关联。
 */
export const SessionTable = sqliteTable(
  "session",
  {
    // id: 会话唯一标识符（主键）
    id: text().$type<SessionID>().primaryKey(),

    // project_id: 所属项目的 ID（外键，级联删除）
    project_id: text()
      .$type<ProjectID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),

    // workspace_id: 关联的工作区 ID（可选，用于云端同步）
    workspace_id: text().$type<WorkspaceID>(),

    // parent_id: 父会话 ID（用于会话嵌套，如子智能体会话）
    parent_id: text().$type<SessionID>(),

    // slug: 会话的 URL 友好标识符（用于分享链接等）
    slug: text().notNull(),

    // directory: 会话关联的项目目录路径
    directory: text().notNull(),

    // title: 会话标题（由 AI 自动生成或用户设置）
    title: text().notNull(),

    // version: 会话数据格式版本号（用于兼容性管理）
    version: text().notNull(),

    // share_url: 分享链接 URL（如果会话已公开分享）
    share_url: text(),

    // summary_additions: 摘要中的代码新增行数统计
    summary_additions: integer(),

    // summary_deletions: 摘要中的代码删除行数统计
    summary_deletions: integer(),

    // summary_files: 摘要中涉及的文件数量统计
    summary_files: integer(),

    // summary_diffs: 摘要中的文件差异详情（JSON 格式数组）
    summary_diffs: text({ mode: "json" }).$type<Snapshot.FileDiff[]>(),

    // revert: 回滚信息（包含回滚到的消息 ID、部分 ID、快照和差异）
    revert: text({ mode: "json" }).$type<{ messageID: MessageID; partID?: PartID; snapshot?: string; diff?: string }>(),

    // permission: 会话级别的权限规则集（JSON 格式）
    permission: text({ mode: "json" }).$type<Permission.Ruleset>(),

    // 混入时间戳字段（time_created, time_updated）
    ...Timestamps,

    // time_compacting: 压缩操作耗时（毫秒），用于性能监控
    time_compacting: integer(),

    // time_archived: 归档时间戳（Unix 时间戳，秒）
    time_archived: integer(),
  },

  // 索引定义：优化查询性能
  (table) => [
    // 按项目 ID 查询会话的索引
    index("session_project_idx").on(table.project_id),

    // 按工作区 ID 查询会话的索引
    index("session_workspace_idx").on(table.workspace_id),

    // 按父会话 ID 查询子会话的索引
    index("session_parent_idx").on(table.parent_id),
  ],
)

/**
 * MessageTable - 消息表
 *
 * 存储会话中的每条消息（用户消息或 AI 助手消息）。
 * 每条消息属于一个会话，可以包含多个部分（Part）。
 */
export const MessageTable = sqliteTable(
  "message",
  {
    // id: 消息唯一标识符（主键）
    id: text().$type<MessageID>().primaryKey(),

    // session_id: 所属会话的 ID（外键，级联删除）
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),

    // 混入时间戳字段（time_created, time_updated）
    ...Timestamps,

    // data: 消息的完整信息数据（JSON 格式）
    // 包含角色（user/assistant）、模型信息、工具调用等元数据
    data: text({ mode: "json" }).notNull().$type<InfoData>(),
  },

  // 索引定义：优化按会话和时间排序的查询
  (table) => [
    // 复合索引：按会话 ID、创建时间、消息 ID 排序
    // 用于高效获取会话中的消息列表（按时间顺序）
    index("message_session_time_created_id_idx").on(table.session_id, table.time_created, table.id),
  ],
)

/**
 * PartTable - 消息部分表
 *
 * 存储消息的各个组成部分（文本、工具调用、工具结果等）。
 * 一条消息可以包含多个部分，按顺序组合形成完整的消息内容。
 */
export const PartTable = sqliteTable(
  "part",
  {
    // id: 部分唯一标识符（主键）
    id: text().$type<PartID>().primaryKey(),

    // message_id: 所属消息的 ID（外键，级联删除）
    message_id: text()
      .$type<MessageID>()
      .notNull()
      .references(() => MessageTable.id, { onDelete: "cascade" }),

    // session_id: 所属会话的 ID（冗余字段，便于按会话查询）
    session_id: text().$type<SessionID>().notNull(),

    // 混入时间戳字段（time_created, time_updated）
    ...Timestamps,

    // data: 部分的完整数据（JSON 格式）
    // 根据类型不同，包含文本内容、工具调用参数、工具执行结果等
    data: text({ mode: "json" }).notNull().$type<PartData>(),
  },

  // 索引定义：优化查询性能
  (table) => [
    // 复合索引：按消息 ID 和部分 ID 排序
    // 用于高效获取消息中的所有部分（按顺序）
    index("part_message_id_id_idx").on(table.message_id, table.id),

    // 按会话 ID 查询所有部分的索引
    // 用于跨消息的会话级别查询
    index("part_session_idx").on(table.session_id),
  ],
)

/**
 * TodoTable - 待办事项表
 *
 * 存储会话中的待办事项列表。
 * 使用复合主键（session_id + position）确保每个会话中的位置唯一。
 */
export const TodoTable = sqliteTable(
  "todo",
  {
    // session_id: 所属会话的 ID（外键，级联删除）
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),

    // content: 待办事项的内容描述
    content: text().notNull(),

    // status: 待办事项的状态（pending、in_progress、completed 等）
    status: text().notNull(),

    // priority: 待办事项的优先级（high、medium、low 等）
    priority: text().notNull(),

    // position: 待办事项在列表中的位置（用于排序）
    position: integer().notNull(),

    // 混入时间戳字段（time_created, time_updated）
    ...Timestamps,
  },

  // 约束和索引定义
  (table) => [
    // 复合主键：确保每个会话中的位置唯一
    // 防止同一会话中出现重复的位置编号
    primaryKey({ columns: [table.session_id, table.position] }),

    // 按会话 ID 查询待办事项的索引
    index("todo_session_idx").on(table.session_id),
  ],
)

/**
 * PermissionTable - 权限表
 *
 * 存储项目级别的默认权限规则集。
 * 每个项目只能有一条权限记录，作为该项目的默认权限配置。
 */
export const PermissionTable = sqliteTable("permission", {
  // project_id: 项目 ID（主键，同时也是外键）
  // 每个项目只能有一条权限记录
  project_id: text()
    .primaryKey()
    .references(() => ProjectTable.id, { onDelete: "cascade" }),

  // 混入时间戳字段（time_created, time_updated）
  ...Timestamps,

  // data: 权限规则集（JSON 格式）
  // 包含允许/拒绝的工具、文件访问模式等规则
  data: text({ mode: "json" }).notNull().$type<Permission.Ruleset>(),
})

