// 导入 Zod 库用于运行时类型验证和 schema 定义
import z from "zod"
// 导入 Tool 基类，用于定义工具的标准接口和行为
import { Tool } from "./tool"
// 导入 todowrite 工具的描述文本（从外部文件加载）
import DESCRIPTION_WRITE from "./todowrite.txt"
// 导入 Todo 模块，提供待办事项的数据结构和操作方法
import { Todo } from "../session/todo"

/**
 * TodoWriteTool - 待办事项写入工具
 *
 * 该工具允许 AI 助手更新和管理会话中的待办事项列表。
 * 主要用于跟踪任务进度、记录工作步骤和维护任务状态。
 */
export const TodoWriteTool = Tool.define("todowrite", {
  // 工具描述：说明工具的用途和使用场景
  description: DESCRIPTION_WRITE,

  // 参数定义：使用 Zod schema 验证输入参数的结构
  parameters: z.object({
    // todos: 待办事项数组，每个事项需符合 Todo.Info 的形状定义
    todos: z.array(z.object(Todo.Info.shape)).describe("The updated todo list"),
  }),

  /**
   * 执行函数：处理待办事项的更新操作
   * @param params - 包含待办事项列表的参数对象
   * @param ctx - 执行上下文，包含会话信息和权限控制方法
   * @returns 包含更新后待办事项统计和详细信息的对象
   */
  async execute(params, ctx) {
    // 请求用户权限确认
    // permission: 权限类型为 "todowrite"
    // patterns: 匹配所有模式的待办事项
    // always: 始终允许的操作模式
    // metadata: 额外的元数据（当前为空对象）
    await ctx.ask({
      permission: "todowrite",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    // 调用 Todo 模块的 update 方法更新会话中的待办事项
    // 传入当前会话 ID 和新的待办事项列表
    Todo.update({
      sessionID: ctx.sessionID,
      todos: params.todos,
    })

    // 返回执行结果
    return {
      // 标题：显示未完成的待办事项数量
      title: `${params.todos.filter((x) => x.status !== "completed").length} todos`,

      // 输出：格式化的 JSON 字符串，包含完整的待办事项列表（缩进 2 空格）
      output: JSON.stringify(params.todos, null, 2),

      // 元数据：携带原始的待办事项数据供后续处理使用
      metadata: {
        todos: params.todos,
      },
    }
  },
})

