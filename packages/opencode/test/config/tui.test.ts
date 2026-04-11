// 导入测试框架和必要的模块
import { afterEach, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"  // 临时目录工具函数
import { Instance } from "../../src/project/instance"  // 项目实例管理
import { TuiConfig } from "../../src/config/tui"  // TUI（终端用户界面）配置管理模块
import { Global } from "../../src/global"  // 全局配置和路径
import { Filesystem } from "../../src/util/filesystem"  // 文件系统工具

// 从环境变量获取托管配置目录路径（用于企业级集中管理配置）
const managedConfigDir = process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR!

/**
 * 清理钩子：每个测试用例执行后清理所有配置文件和环境变量
 * 
 * 清理内容：
 * 1. 删除 OPENCODE_CONFIG 和 OPENCODE_TUI_CONFIG 环境变量
 * 2. 删除全局配置目录中的 tui.json 和 tui.jsonc 文件
 * 3. 删除托管配置目录（如果存在）
 * 
 * 目的：确保测试之间互不干扰，每个测试都从干净的状态开始
 */
afterEach(async () => {
  delete process.env.OPENCODE_CONFIG
  delete process.env.OPENCODE_TUI_CONFIG
  await fs.rm(path.join(Global.Path.config, "tui.json"), { force: true }).catch(() => {})
  await fs.rm(path.join(Global.Path.config, "tui.jsonc"), { force: true }).catch(() => {})
  await fs.rm(managedConfigDir, { force: true, recursive: true }).catch(() => {})
})

/**
 * 测试用例 1：验证 TUI 配置的加载优先级顺序与服务器配置路径相同
 * 
 * TuiConfig.get() 的作用：
 * - 从多个来源加载 TUI（终端用户界面）配置并合并
 * - 支持多种配置文件位置，按优先级从高到低：
 *   1. 托管配置目录（managed config dir）- 最高优先级
 *   2. .opencode/tui.json（本地配置）
 *   3. 项目根目录的 tui.json
 *   4. OPENCODE_TUI_CONFIG 环境变量指定的自定义路径
 *   5. 全局配置目录的 tui.json - 最低优先级
 * - 自动迁移旧版 opencode.json 中的 TUI 配置到 tui.json
 * - 支持环境变量和文件内容的动态替换（如 {env:VAR}、{file:path}）
 * - 处理插件配置的合并和去重
 * 
 * 本测试验证：当存在多个配置文件时，.opencode/tui.json 的优先级最高
 */
test("loads tui config with the same precedence order as server config paths", async () => {
  // 创建临时目录并初始化三个不同优先级的配置文件
  await using tmp = await tmpdir({
    init: async (dir) => {
      // 1. 全局配置（最低优先级）
      await Bun.write(path.join(Global.Path.config, "tui.json"), JSON.stringify({ theme: "global" }, null, 2))
      // 2. 项目根目录配置（中等优先级）
      await Bun.write(path.join(dir, "tui.json"), JSON.stringify({ theme: "project" }, null, 2))
      // 3. .opencode 本地配置（最高优先级）
      await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
      await Bun.write(
        path.join(dir, ".opencode", "tui.json"),
        JSON.stringify({ theme: "local", diff_style: "stacked" }, null, 2),
      )
    },
  })

  // 在项目实例上下文中加载配置并验证优先级
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await TuiConfig.get()
      // 验证：.opencode/tui.json 的配置生效（theme: "local"）
      expect(config.theme).toBe("local")
      // 验证：diff_style 也从 .opencode/tui.json 加载
      expect(config.diff_style).toBe("stacked")
    },
  })
})

/**
 * 测试用例 2：验证当 tui.json 不存在时，从 opencode.json 迁移 TUI 特定配置
 * 
 * 迁移机制说明：
 * - 旧版本将 TUI 配置存储在 opencode.json 中（theme、tui、keybinds 等字段）
 * - 新版本将这些配置分离到独立的 tui.json 文件中
 * - 首次加载时自动检测并迁移，保留原始文件作为备份（.tui-migration.bak）
 * - 迁移后从 opencode.json 中删除已迁移的字段
 */
test("migrates tui-specific keys from opencode.json when tui.json does not exist", async () => {
  // 创建临时目录并初始化包含 TUI 配置的 opencode.json
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify(
          {
            theme: "migrated-theme",     // 顶层 theme 字段（需要迁移）
            tui: { scroll_speed: 5 },    // 嵌套的 tui 对象（需要迁移）
            keybinds: { app_exit: "ctrl+q" },  // 快捷键配置（需要迁移）
          },
          null,
          2,
        ),
      )
    },
  })

  // 加载配置并验证迁移结果
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await TuiConfig.get()
      // 验证：配置已从 opencode.json 迁移并正确加载
      expect(config.theme).toBe("migrated-theme")
      expect(config.scroll_speed).toBe(5)
      expect(config.keybinds?.app_exit).toBe("ctrl+q")
      
      // 验证：已创建 tui.json 文件并包含迁移的配置
      const text = await Filesystem.readText(path.join(tmp.path, "tui.json"))
      expect(JSON.parse(text)).toMatchObject({
        theme: "migrated-theme",
        scroll_speed: 5,
      })
      
      // 验证：opencode.json 中的 TUI 相关字段已被删除
      const server = JSON.parse(await Filesystem.readText(path.join(tmp.path, "opencode.json")))
      expect(server.theme).toBeUndefined()    // theme 已移除
      expect(server.keybinds).toBeUndefined()  // keybinds 已移除
      expect(server.tui).toBeUndefined()       // tui 已移除
      
      // 验证：创建了备份文件
      expect(await Filesystem.exists(path.join(tmp.path, "opencode.json.tui-migration.bak"))).toBe(true)
      // 验证：tui.json 文件存在
      expect(await Filesystem.exists(path.join(tmp.path, "tui.json"))).toBe(true)
    },
  })
})

/**
 * 测试用例 3：验证即使全局 tui.json 已存在，仍会迁移项目级别的旧版 TUI 配置
 * 
 * 场景说明：
 * - 全局配置目录已有 tui.json（theme: "global"）
 * - 项目级别有 opencode.json 包含 TUI 配置（theme: "project-migrated", tui.scroll_speed: 2）
 * - 预期：项目级别的配置会被迁移到项目的 tui.json，并且优先级高于全局配置
 */
test("migrates project legacy tui keys even when global tui.json already exists", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(Global.Path.config, "tui.json"), JSON.stringify({ theme: "global" }, null, 2))
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify(
          {
            theme: "project-migrated",
            tui: { scroll_speed: 2 },
          },
          null,
          2,
        ),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await TuiConfig.get()
      expect(config.theme).toBe("project-migrated")
      expect(config.scroll_speed).toBe(2)
      expect(await Filesystem.exists(path.join(tmp.path, "tui.json"))).toBe(true)

      const server = JSON.parse(await Filesystem.readText(path.join(tmp.path, "opencode.json")))
      expect(server.theme).toBeUndefined()
      expect(server.tui).toBeUndefined()
    },
  })
})

/**
 * 测试用例 4：验证迁移过程中会丢弃未知的旧版 TUI 配置项
 * 
 * 场景说明：
 * - opencode.json 中包含未知的配置项 foo: 1
 * - 迁移时只保留已知的 TUI 配置（theme、scroll_speed）
 * - 未知字段 foo 不会出现在迁移后的 tui.json 中
 */
test("drops unknown legacy tui keys during migration", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify(
          {
            theme: "migrated-theme",
            tui: { scroll_speed: 2, foo: 1 },
          },
          null,
          2,
        ),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await TuiConfig.get()
      expect(config.theme).toBe("migrated-theme")
      expect(config.scroll_speed).toBe(2)

      const text = await Filesystem.readText(path.join(tmp.path, "tui.json"))
      const migrated = JSON.parse(text)
      expect(migrated.scroll_speed).toBe(2)
      expect(migrated.foo).toBeUndefined()
    },
  })
})

/**
 * 测试用例 5：验证当 opencode.jsonc 语法无效时跳过迁移
 * 
 * 场景说明：
 * - opencode.jsonc 文件包含 JSON 语法错误（缺少逗号）
 * - 迁移过程应该安全地跳过，不创建 tui.json 或备份文件
 * - 原始文件保持不变
 */
test("skips migration when opencode.jsonc is syntactically invalid", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.jsonc"),
        `{
  "theme": "broken-theme",
  "tui": { "scroll_speed": 2 }
  "username": "still-broken"
}`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await TuiConfig.get()
      expect(config.theme).toBeUndefined()
      expect(config.scroll_speed).toBeUndefined()
      expect(await Filesystem.exists(path.join(tmp.path, "tui.json"))).toBe(false)
      expect(await Filesystem.exists(path.join(tmp.path, "opencode.jsonc.tui-migration.bak"))).toBe(false)
      const source = await Filesystem.readText(path.join(tmp.path, "opencode.jsonc"))
      expect(source).toContain('"theme": "broken-theme"')
      expect(source).toContain('"tui": { "scroll_speed": 2 }')
    },
  })
})

/**
 * 测试用例 6：验证当 tui.json 已存在时跳过迁移
 * 
 * 场景说明：
 * - 同时存在 opencode.json（包含 theme: "legacy"）和 tui.json（包含 diff_style: "stacked"）
 * - 因为 tui.json 已存在，所以不执行迁移
 * - opencode.json 保持原样，tui.json 的配置生效
 */
test("skips migration when tui.json already exists", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "opencode.json"), JSON.stringify({ theme: "legacy" }, null, 2))
      await Bun.write(path.join(dir, "tui.json"), JSON.stringify({ diff_style: "stacked" }, null, 2))
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await TuiConfig.get()
      expect(config.diff_style).toBe("stacked")
      expect(config.theme).toBeUndefined()

      const server = JSON.parse(await Filesystem.readText(path.join(tmp.path, "opencode.json")))
      expect(server.theme).toBe("legacy")
      expect(await Filesystem.exists(path.join(tmp.path, "opencode.json.tui-migration.bak"))).toBe(false)
    },
  })
})

/**
 * 测试用例 7：验证当无法修改旧配置文件时仍能继续加载 TUI 配置
 * 
 * 场景说明：
 * - opencode.json 设置为只读权限（0o444）
 * - 迁移过程无法从 opencode.json 中删除已迁移的字段
 * - 系统应该优雅地处理这种情况：
 *   1. 仍然创建 tui.json 并加载配置
 *   2. opencode.json 保持原样（因为无法修改）
 *   3. 配置仍然能正确加载
 */
test("continues loading tui config when legacy source cannot be stripped", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "opencode.json"), JSON.stringify({ theme: "readonly-theme" }, null, 2))
    },
  })

  const source = path.join(tmp.path, "opencode.json")
  await fs.chmod(source, 0o444)

  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await TuiConfig.get()
        expect(config.theme).toBe("readonly-theme")
        expect(await Filesystem.exists(path.join(tmp.path, "tui.json"))).toBe(true)

        const server = JSON.parse(await Filesystem.readText(source))
        expect(server.theme).toBe("readonly-theme")
      },
    })
  } finally {
    await fs.chmod(source, 0o644)
  }
})

/**
 * 测试用例 8：验证迁移备份文件保留 JSONC 注释
 * 
 * 场景说明：
 * - opencode.jsonc 包含注释（// top-level comment、// nested comment）
 * - 迁移时创建的备份文件应该保留所有注释
 * - 这对于用户审查迁移内容和恢复原始配置非常重要
 */
test("migration backup preserves JSONC comments", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.jsonc"),
        `{
  // top-level comment
  "theme": "jsonc-theme",
  "tui": {
    // nested comment
    "scroll_speed": 1.5
  }
}`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await TuiConfig.get()
      const backup = await Filesystem.readText(path.join(tmp.path, "opencode.jsonc.tui-migration.bak"))
      expect(backup).toContain("// top-level comment")
      expect(backup).toContain("// nested comment")
      expect(backup).toContain('"theme": "jsonc-theme"')
      expect(backup).toContain('"scroll_speed": 1.5')
    },
  })
})

/**
 * 测试用例 9：验证在多层嵌套的项目结构中迁移旧版 TUI 配置
 * 
 * 场景说明：
 * - 项目结构：root/apps/client
 * - root 级别有 opencode.json（theme: "root-theme"）
 * - client 级别有 opencode.json（theme: "nested-theme"）
 * - 在 client 目录下运行时，应该迁移两个级别的配置
 * - 每个级别都会创建对应的 tui.json
 */
test("migrates legacy tui keys across multiple opencode.json levels", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const nested = path.join(dir, "apps", "client")
      await fs.mkdir(nested, { recursive: true })
      await Bun.write(path.join(dir, "opencode.json"), JSON.stringify({ theme: "root-theme" }, null, 2))
      await Bun.write(path.join(nested, "opencode.json"), JSON.stringify({ theme: "nested-theme" }, null, 2))
    },
  })

  await Instance.provide({
    directory: path.join(tmp.path, "apps", "client"),
    fn: async () => {
      const config = await TuiConfig.get()
      expect(config.theme).toBe("nested-theme")
      expect(await Filesystem.exists(path.join(tmp.path, "tui.json"))).toBe(true)
      expect(await Filesystem.exists(path.join(tmp.path, "apps", "client", "tui.json"))).toBe(true)
    },
  })
})

/**
 * 测试用例 10：验证将 tui.json 中嵌套的 tui 键展平
 * 
 * 场景说明：
 * - 用户可能在 tui.json 中写了嵌套结构：{ theme: "outer", tui: { scroll_speed: 3 } }
 * - 这种写法模仿了旧版 opencode.json 的结构
 * - 系统应该自动展平，将 tui 对象中的属性提升到顶层
 * - 顶层键优先于嵌套 tui 键（theme: "outer" 覆盖任何嵌套的 theme）
 */
test("flattens nested tui key inside tui.json", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "tui.json"),
        JSON.stringify({
          theme: "outer",
          tui: { scroll_speed: 3, diff_style: "stacked" },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await TuiConfig.get()
      expect(config.scroll_speed).toBe(3)
      expect(config.diff_style).toBe("stacked")
      // top-level keys take precedence over nested tui keys
      expect(config.theme).toBe("outer")
    },
  })
})

/**
 * 测试用例 11：验证 tui.json 中的顶层键优先于嵌套的 tui 键
 * 
 * 场景说明：
 * - tui.json 包含：{ diff_style: "auto", tui: { diff_style: "stacked", scroll_speed: 2 } }
 * - 顶层 diff_style: "auto" 应该覆盖嵌套的 diff_style: "stacked"
 * - 但嵌套的 scroll_speed: 2 仍然生效（因为顶层没有定义）
 */
test("top-level keys in tui.json take precedence over nested tui key", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "tui.json"),
        JSON.stringify({
          diff_style: "auto",
          tui: { diff_style: "stacked", scroll_speed: 2 },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await TuiConfig.get()
      expect(config.diff_style).toBe("auto")
      expect(config.scroll_speed).toBe(2)
    },
  })
})

/**
 * 测试用例 12：验证项目配置优先于 OPENCODE_TUI_CONFIG 环境变量（与服务器配置优先级一致）
 * 
 * 场景说明：
 * - 项目目录有 tui.json（theme: "project", diff_style: "auto"）
 * - OPENCODE_TUI_CONFIG 指向自定义文件（theme: "custom", diff_style: "stacked"）
 * - 预期：项目级别的 tui.json 优先级更高，覆盖环境变量指定的配置
 * - 这与 OPENCODE_CONFIG 的行为保持一致
 */
test("project config takes precedence over OPENCODE_TUI_CONFIG (matches OPENCODE_CONFIG)", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "tui.json"), JSON.stringify({ theme: "project", diff_style: "auto" }))
      const custom = path.join(dir, "custom-tui.json")
      await Bun.write(custom, JSON.stringify({ theme: "custom", diff_style: "stacked" }))
      process.env.OPENCODE_TUI_CONFIG = custom
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await TuiConfig.get()
      // project tui.json overrides the custom path, same as server config precedence
      expect(config.theme).toBe("project")
      // project also set diff_style, so that wins
      expect(config.diff_style).toBe("auto")
    },
  })
})

/**
 * 测试用例 13：验证跨优先级层的快捷键配置合并
 * 
 * 场景说明：
 * - 全局 tui.json 定义：keybinds.app_exit = "ctrl+q"
 * - 项目 tui.json 定义：keybinds.theme_list = "ctrl+k"
 * - 预期：两个快捷键配置应该合并，而不是覆盖
 * - 最终结果：app_exit 和 theme_list 都可用
 */
test("merges keybind overrides across precedence layers", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(Global.Path.config, "tui.json"), JSON.stringify({ keybinds: { app_exit: "ctrl+q" } }))
      await Bun.write(path.join(dir, "tui.json"), JSON.stringify({ keybinds: { theme_list: "ctrl+k" } }))
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await TuiConfig.get()
      expect(config.keybinds?.app_exit).toBe("ctrl+q")
      expect(config.keybinds?.theme_list).toBe("ctrl+k")
    },
  })
})

/**
 * 测试用例 14：验证当没有项目配置时，OPENCODE_TUI_CONFIG 提供设置
 * 
 * 场景说明：
 * - 项目中没有 tui.json 文件
 * - OPENCODE_TUI_CONFIG 指向自定义配置文件
 * - 预期：从环境变量指定的文件加载配置
 */
test("OPENCODE_TUI_CONFIG provides settings when no project config exists", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const custom = path.join(dir, "custom-tui.json")
      await Bun.write(custom, JSON.stringify({ theme: "from-env", diff_style: "stacked" }))
      process.env.OPENCODE_TUI_CONFIG = custom
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await TuiConfig.get()
      expect(config.theme).toBe("from-env")
      expect(config.diff_style).toBe("stacked")
    },
  })
})

/**
 * 测试用例 15：验证不会从 OPENCODE_CONFIG 推导出 tui.json 路径
 * 
 * 场景说明：
 * - OPENCODE_CONFIG 指向自定义目录的 opencode.json
 * - 该目录下也有 tui.json（theme: "should-not-load"）
 * - 预期：TUI 配置不会从 OPENCODE_CONFIG 的目录加载
 * - TUI 配置有独立的加载逻辑，不跟随 OPENCODE_CONFIG
 */
test("does not derive tui path from OPENCODE_CONFIG", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const customDir = path.join(dir, "custom")
      await fs.mkdir(customDir, { recursive: true })
      await Bun.write(path.join(customDir, "opencode.json"), JSON.stringify({ model: "test/model" }))
      await Bun.write(path.join(customDir, "tui.json"), JSON.stringify({ theme: "should-not-load" }))
      process.env.OPENCODE_CONFIG = path.join(customDir, "opencode.json")
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await TuiConfig.get()
      expect(config.theme).toBeUndefined()
    },
  })
})

/**
 * 测试用例 16：验证在 tui.json 中应用环境变量和文件内容替换
 * 
 * 功能说明：
 * - 支持 {env:VAR_NAME} 语法：从环境变量读取值
 * - 支持 {file:path/to/file} 语法：从文件读取内容
 * 
 * 场景说明：
 * - 设置环境变量 TUI_THEME_TEST = "env-theme"
 * - 创建 keybind.txt 文件，内容为 "ctrl+q"
 * - tui.json 中使用：theme: "{env:TUI_THEME_TEST}", keybinds.app_exit: "{file:keybind.txt}"
 * - 预期：变量被正确替换为实际值
 */
test("applies env and file substitutions in tui.json", async () => {
  const original = process.env.TUI_THEME_TEST
  process.env.TUI_THEME_TEST = "env-theme"
  try {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "keybind.txt"), "ctrl+q")
        await Bun.write(
          path.join(dir, "tui.json"),
          JSON.stringify({
            theme: "{env:TUI_THEME_TEST}",
            keybinds: { app_exit: "{file:keybind.txt}" },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await TuiConfig.get()
        expect(config.theme).toBe("env-theme")
        expect(config.keybinds?.app_exit).toBe("ctrl+q")
      },
    })
  } finally {
    if (original === undefined) delete process.env.TUI_THEME_TEST
    else process.env.TUI_THEME_TEST = original
  }
})

/**
 * 测试用例 17：验证当第一个相同标记在注释行中时仍应用文件替换
 * 
 * 场景说明：
 * - tui.jsonc 第一行是注释：// "theme": "{file:theme.txt}"
 * - 第二行是实际配置："theme": "{file:theme.txt}"
 * - 预期：系统应该忽略注释行，只处理实际的配置行
 * - 这确保注释不会影响变量替换逻辑
 */
test("applies file substitutions when first identical token is in a commented line", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "theme.txt"), "resolved-theme")
      await Bun.write(
        path.join(dir, "tui.jsonc"),
        `{
  // "theme": "{file:theme.txt}",
  "theme": "{file:theme.txt}"
}`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await TuiConfig.get()
      expect(config.theme).toBe("resolved-theme")
    },
  })
})

/**
 * 测试用例 18：验证加载托管 TUI 配置并给予最高优先级
 * 
 * 托管配置说明：
 * - 托管配置目录（managed config dir）用于企业级集中管理配置
 * - 由管理员统一部署，覆盖所有用户的本地配置
 * - 优先级最高，确保统一的政策和设置
 * 
 * 场景说明：
 * - 项目 tui.json：theme: "project-theme", plugin: ["shared-plugin@1.0.0"]
 * - 托管 tui.json：theme: "managed-theme", plugin: ["shared-plugin@2.0.0"]
 * - 预期：托管配置覆盖项目配置，包括 theme 和 plugin
 * - plugin_meta 应该记录插件的来源和范围
 */
test("loads managed tui config and gives it highest precedence", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "tui.json"),
        JSON.stringify({ theme: "project-theme", plugin: ["shared-plugin@1.0.0"] }, null, 2),
      )
      await fs.mkdir(managedConfigDir, { recursive: true })
      await Bun.write(
        path.join(managedConfigDir, "tui.json"),
        JSON.stringify({ theme: "managed-theme", plugin: ["shared-plugin@2.0.0"] }, null, 2),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await TuiConfig.get()
      expect(config.theme).toBe("managed-theme")
      expect(config.plugin).toEqual(["shared-plugin@2.0.0"])
      expect(config.plugin_meta).toEqual({
        "shared-plugin@2.0.0": {
          scope: "global",
          source: path.join(managedConfigDir, "tui.json"),
        },
      })
    },
  })
})

/**
 * 测试用例 19：验证加载 .opencode/tui.json
 * 
 * 场景说明：
 * - 在项目根目录下创建 .opencode/tui.json
 * - 这是项目级别的本地配置，优先级高于项目根目录的 tui.json
 * - 预期：diff_style: "stacked" 从 .opencode/tui.json 加载
 */
test("loads .opencode/tui.json", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
      await Bun.write(path.join(dir, ".opencode", "tui.json"), JSON.stringify({ diff_style: "stacked" }, null, 2))
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await TuiConfig.get()
      expect(config.diff_style).toBe("stacked")
    },
  })
})

/**
 * 测试用例 20：验证当 tui.json 包含无效 JSON 时优雅地回退
 * 
 * 场景说明：
 * - 项目 tui.json 包含无效 JSON："{ invalid json }"
 * - 托管配置目录有有效的 tui.json（theme: "managed-fallback"）
 * - 预期：
 *   1. 项目配置解析失败，记录警告
 *   2. 继续加载其他来源的配置（托管配置）
 *   3. 最终使用托管配置的 theme
 *   4. keybinds 使用默认值（不会 undefined）
 */
test("gracefully falls back when tui.json has invalid JSON", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "tui.json"), "{ invalid json }")
      await fs.mkdir(managedConfigDir, { recursive: true })
      await Bun.write(path.join(managedConfigDir, "tui.json"), JSON.stringify({ theme: "managed-fallback" }, null, 2))
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await TuiConfig.get()
      expect(config.theme).toBe("managed-fallback")
      expect(config.keybinds).toBeDefined()
    },
  })
})

/**
 * 测试用例 21：验证支持带选项的元组插件规范
 * 
 * 插件规范格式：
 * - 字符串格式："plugin-name@version"
 * - 元组格式：["plugin-name@version", { options }]
 * 
 * 场景说明：
 * - tui.json 中使用元组格式：[["acme-plugin@1.2.3", { enabled: true, label: "demo" }]]
 * - 预期：
 *   1. plugin 数组保留元组格式
 *   2. plugin_meta 记录插件的 scope（local）和 source（文件路径）
 */
test("supports tuple plugin specs with options in tui.json", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "tui.json"),
        JSON.stringify({
          plugin: [["acme-plugin@1.2.3", { enabled: true, label: "demo" }]],
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await TuiConfig.get()
      expect(config.plugin).toEqual([["acme-plugin@1.2.3", { enabled: true, label: "demo" }]])
      expect(config.plugin_meta).toEqual({
        "acme-plugin@1.2.3": {
          scope: "local",
          source: path.join(tmp.path, "tui.json"),
        },
      })
    },
  })
})

/**
 * 测试用例 22：验证按名称去重元组插件规范，高优先级获胜
 * 
 * 去重规则：
 * - 如果多个配置层定义了同一个插件，只保留一个
 * - 高优先级的配置覆盖低优先级
 * - 去重基于插件名称（不包括版本）
 * 
 * 场景说明：
 * - 全局：[["acme-plugin@1.0.0", { source: "global" }]]
 * - 项目：[["acme-plugin@2.0.0", { source: "project" }], ["second-plugin@3.0.0", ...]]
 * - 预期：
 *   1. acme-plugin 使用项目版本（2.0.0），因为项目优先级更高
 *   2. second-plugin 只在项目中定义，直接保留
 *   3. 最终 plugin 数组包含两个插件
 */
test("deduplicates tuple plugin specs by name with higher precedence winning", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(Global.Path.config, "tui.json"),
        JSON.stringify({
          plugin: [["acme-plugin@1.0.0", { source: "global" }]],
        }),
      )
      await Bun.write(
        path.join(dir, "tui.json"),
        JSON.stringify({
          plugin: [
            ["acme-plugin@2.0.0", { source: "project" }],
            ["second-plugin@3.0.0", { source: "project" }],
          ],
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await TuiConfig.get()
      expect(config.plugin).toEqual([
        ["acme-plugin@2.0.0", { source: "project" }],
        ["second-plugin@3.0.0", { source: "project" }],
      ])
      expect(config.plugin_meta).toEqual({
        "acme-plugin@2.0.0": {
          scope: "local",
          source: path.join(tmp.path, "tui.json"),
        },
        "second-plugin@3.0.0": {
          scope: "local",
          source: path.join(tmp.path, "tui.json"),
        },
      })
    },
  })
})

/**
 * 测试用例 23：验证在合并的 TUI 配置中跟踪全局和局部插件元数据
 * 
 * plugin_meta 的作用：
 * - 记录每个插件的来源（scope: "global" | "local"）
 * - 记录定义插件的配置文件路径（source）
 * - 用于调试和插件管理
 * 
 * 场景说明：
 * - 全局 tui.json：plugin: ["global-plugin@1.0.0"]
 * - 项目 tui.json：plugin: ["local-plugin@2.0.0"]
 * - 预期：
 *   1. plugin 数组合并两个插件
 *   2. plugin_meta 分别记录每个插件的 scope 和 source
 */
test("tracks global and local plugin metadata in merged tui config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(Global.Path.config, "tui.json"),
        JSON.stringify({
          plugin: ["global-plugin@1.0.0"],
        }),
      )
      await Bun.write(
        path.join(dir, "tui.json"),
        JSON.stringify({
          plugin: ["local-plugin@2.0.0"],
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await TuiConfig.get()
      expect(config.plugin).toEqual(["global-plugin@1.0.0", "local-plugin@2.0.0"])
      expect(config.plugin_meta).toEqual({
        "global-plugin@1.0.0": {
          scope: "global",
          source: path.join(Global.Path.config, "tui.json"),
        },
        "local-plugin@2.0.0": {
          scope: "local",
          source: path.join(tmp.path, "tui.json"),
        },
      })
    },
  })
})

/**
 * 测试用例 24：验证跨配置层合并 plugin_enabled 标志
 * 
 * plugin_enabled 的作用：
 * - 允许用户启用或禁用特定插件
 * - 支持细粒度的插件控制
 * - 跨配置层合并（而不是覆盖）
 * 
 * 场景说明：
 * - 全局：{ "internal:sidebar-context": false, "demo.plugin": true }
 * - 项目：{ "demo.plugin": false, "local.plugin": true }
 * - 预期：
 *   1. internal:sidebar-context: false（来自全局）
 *   2. demo.plugin: false（项目覆盖全局）
 *   3. local.plugin: true（来自项目）
 * - 所有三个插件的启用状态都被正确合并
 */
test("merges plugin_enabled flags across config layers", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(Global.Path.config, "tui.json"),
        JSON.stringify({
          plugin_enabled: {
            "internal:sidebar-context": false,
            "demo.plugin": true,
          },
        }),
      )
      await Bun.write(
        path.join(dir, "tui.json"),
        JSON.stringify({
          plugin_enabled: {
            "demo.plugin": false,
            "local.plugin": true,
          },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await TuiConfig.get()
      expect(config.plugin_enabled).toEqual({
        "internal:sidebar-context": false,
        "demo.plugin": false,
        "local.plugin": true,
      })
    },
  })
})
