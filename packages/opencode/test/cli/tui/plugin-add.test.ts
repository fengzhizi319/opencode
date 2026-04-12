// 导入测试框架和必要的模块
import { expect, spyOn, test } from "bun:test"  // Bun 测试框架
import fs from "fs/promises"  // Node.js 文件系统模块（Promise 版本）
import path from "path"  // Node.js 路径处理模块
import { pathToFileURL } from "url"  // URL 转换工具
import { tmpdir } from "../../fixture/fixture"  // 临时目录工具函数
import { createTuiPluginApi } from "../../fixture/tui-plugin"  // TUI 插件 API 创建工具
import { TuiConfig } from "../../../src/config/tui"  // TUI 配置管理模块

/**
 * 动态导入 TuiPluginRuntime 模块
 * 
 * 注意：使用动态导入是因为该模块可能在测试环境中需要特殊处理
 */
const { TuiPluginRuntime } = await import("../../../src/cli/cmd/tui/plugin/runtime")

/**
 * 测试用例：验证从 spec 运行时添加 TUI 插件
 * 
 * TuiPluginRuntime.addPlugin() 的作用：
 * - 在运行时动态加载并激活 TUI 插件
 * - 支持从文件路径、URL 或 npm 包名加载插件
 * - 自动解析插件依赖并注册到运行时
 * - 激活插件使其功能可用（命令、路由、钩子等）
 * 
 * 工作流程：
 * 1. 解析 spec（插件标识符，如文件路径或 npm 包名）
 * 2. 检查插件是否已加载，避免重复
 * 3. 使用 resolveExternalPlugins 解析插件
 * 4. 调用 addExternalPluginEntries 添加到运行时
 * 5. 调用 activatePluginEntry 激活插件
 * 6. 返回是否成功添加
 * 
 * 测试场景：
 * - 创建一个临时的 TypeScript 插件文件
 * - 插件导出一个带有 tui() 方法的对象
 * - tui() 方法会在被调用时写入标记文件
 * - 调用 TuiPluginRuntime.addPlugin() 加载插件
 * - 验证插件被正确加载和激活
 * 
 * 预期结果：
 * - addPlugin() 返回 true
 * - 标记文件被创建（证明 tui() 被调用）
 * - list() 中包含新添加的插件，状态正确
 */
test("adds tui plugin at runtime from spec", async () => {
  /**
   * 创建临时目录和测试文件
   * 
   * init 函数在 tmpdir 创建时执行：
   * - 创建插件文件 add-plugin.ts
   * - 生成 file:// URL 作为 spec
   * - 创建标记文件路径（用于验证插件执行）
   */
  await using tmp = await tmpdir({
    init: async (dir) => {
      const file = path.join(dir, "add-plugin.ts")  // 插件文件路径
      const spec = pathToFileURL(file).href  // 转换为 file:// URL
      const marker = path.join(dir, "add.txt")  // 标记文件路径

      // 写入插件代码
      // 插件导出一个对象，包含 id 和 tui 方法
      // tui 方法被调用时会写入标记文件
      await Bun.write(
        file,
        `export default {
  id: "demo.add",
  tui: async () => {
    await Bun.write(${JSON.stringify(marker)}, "called")
  },
}
`,
      )

      return { spec, marker }  // 返回 spec 和标记文件路径
    },
  })

  /**
   * 设置测试环境
   * 
   * 1. 设置插件元数据文件路径
   * 2. Mock TuiConfig.get() - 返回空插件列表
   * 3. Mock TuiConfig.waitForDependencies() - 模拟依赖就绪
   * 4. Mock process.cwd() - 返回临时目录路径
   */
  process.env.OPENCODE_PLUGIN_META_FILE = path.join(tmp.path, "plugin-meta.json")  // 设置元数据文件路径
  const get = spyOn(TuiConfig, "get").mockResolvedValue({
    plugin: [],  // 没有预配置的插件
    plugin_meta: undefined,  // 没有元数据
  })
  const wait = spyOn(TuiConfig, "waitForDependencies").mockResolvedValue()  // 模拟依赖就绪
  const cwd = spyOn(process, "cwd").mockImplementation(() => tmp.path)  // Mock 当前工作目录

  try {
    /**
     * 初始化 TUI 插件运行时
     * 
     * createTuiPluginApi() 创建插件 API，包含：
     * - 视图注册
     * - 命令注册
     * - 路由注册
     * - 钩子注册等
     */
    await TuiPluginRuntime.init(createTuiPluginApi())

    /**
     * 步骤 1：添加插件
     * 
     * addPlugin(spec) 会：
     * - 解析 file:// URL
     * - 加载插件模块
     * - 注册插件到运行时
     * - 激活插件（调用 tui() 方法）
     * 
     * 预期：返回 true 表示成功
     */
    await expect(TuiPluginRuntime.addPlugin(tmp.extra.spec)).resolves.toBe(true)
    
    /**
     * 步骤 2：验证插件执行
     * 
     * 读取标记文件，确认 tui() 方法被调用
     * 如果文件内容为 "called"，证明插件正确执行
     */
    await expect(fs.readFile(tmp.extra.marker, "utf8")).resolves.toBe("called")
    
    /**
     * 步骤 3：验证插件状态
     * 
     * list() 应该返回包含新插件的列表
     * 验证插件的各个属性：
     * - id: 插件标识符
     * - source: 来源类型（file 表示本地文件）
     * - spec: 原始 spec（file:// URL）
     * - target: 目标路径（与 spec 相同）
     * - enabled: 是否启用
     * - active: 是否激活
     */
    expect(TuiPluginRuntime.list().find((item) => item.id === "demo.add")).toEqual({
      id: "demo.add",  // 插件 ID
      source: "file",  // 来源：本地文件
      spec: tmp.extra.spec,  // 原始 spec
      target: tmp.extra.spec,  // 目标路径
      enabled: true,  // 已启用
      active: true,  // 已激活
    })
  } finally {
    /**
     * 清理测试环境
     * 
     * 1. 销毁 TUI 插件运行时（停用所有插件）
     * 2. 恢复所有 mock
     * 3. 删除环境变量
     */
    await TuiPluginRuntime.dispose()  // 销毁运行时，清理资源
    cwd.mockRestore()  // 恢复 process.cwd
    get.mockRestore()  // 恢复 TuiConfig.get
    wait.mockRestore()  // 恢复 TuiConfig.waitForDependencies
    delete process.env.OPENCODE_PLUGIN_META_FILE  // 删除环境变量
  }
})
