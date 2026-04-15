import { sep } from "node:path"
import { Glob } from "../util/glob"

/**
 * 文件忽略规则命名空间
 *
 * 提供统一的文件/目录忽略逻辑，用于过滤不需要处理的文件（如依赖包、构建产物、版本控制元数据等）。
 * 支持基于文件夹名称的精确匹配和基于 glob 模式的文件匹配。
 */
export namespace FileIgnore {
  /**
   * 需要忽略的文件夹名称集合
   *
   * 包含以下类型的目录：
   * - 依赖管理目录：node_modules, bower_components, .pnpm-store, vendor, .npm
   * - 构建输出目录：dist, build, out, .next, target, bin, obj, .output
   * - 版本控制系统：.git, .svn, .hg
   * - IDE 配置目录：.vscode, .idea
   * - 缓存和临时目录：.turbo, .cache, .webkit-cache, __pycache__, .pytest_cache, mypy_cache
   * - 其他工具目录：.history, .gradle, .sst, desktop
   */
  const FOLDERS = new Set([
    "node_modules",
    "bower_components",
    ".pnpm-store",
    "vendor",
    ".npm",
    "dist",
    "build",
    "out",
    ".next",
    "target",
    "bin",
    "obj",
    ".git",
    ".svn",
    ".hg",
    ".vscode",
    ".idea",
    ".turbo",
    ".output",
    "desktop",
    ".sst",
    ".cache",
    ".webkit-cache",
    "__pycache__",
    ".pytest_cache",
    "mypy_cache",
    ".history",
    ".gradle",
  ])

  /**
   * 需要忽略的文件 glob 模式列表
   *
   * 包含以下类型的文件：
   * - 编辑器临时文件：*.swp, *.swo (Vim)
   * - Python 编译文件：*.pyc
   * - 操作系统元数据：.DS_Store (macOS), Thumbs.db (Windows)
   * - 日志和临时文件：logs/**, tmp/**, temp/**, *.log
   * - 测试覆盖率报告：coverage/**, .nyc_output/**
   */
  const FILES = [
    "**/*.swp",
    "**/*.swo",

    "**/*.pyc",

    // OS
    "**/.DS_Store",
    "**/Thumbs.db",

    // Logs & temp
    "**/logs/**",
    "**/tmp/**",
    "**/temp/**",
    "**/*.log",

    // Coverage/test outputs
    "**/coverage/**",
    "**/.nyc_output/**",
  ]

  /**
   * 所有忽略模式的合并数组（文件模式 + 文件夹名称）
   *
   * 用于外部访问完整的忽略规则列表
   */
  export const PATTERNS = [...FILES, ...FOLDERS]

  /**
   * 判断给定文件路径是否应该被忽略
   *
   * 匹配逻辑按以下优先级执行：
   * 1. 白名单检查：如果路径匹配白名单中的任一模式，直接返回 false（不忽略）
   * 2. 文件夹名称匹配：将路径按分隔符拆分，检查任意部分是否在 FOLDERS 集合中
   * 3. 文件模式匹配：使用 glob 模式匹配 FILES 列表和额外的自定义模式
   *
   * @param filepath - 待检查的文件路径（支持 / 或 \ 分隔符）
   * @param opts - 可选配置
   * @param opts.extra - 额外的 glob 忽略模式数组
   * @param opts.whitelist - 白名单 glob 模式数组，匹配的路径不会被忽略
   * @returns true 表示应该忽略该文件，false 表示不应该忽略
   *
   * @example
   * // 忽略 node_modules 下的文件
   * FileIgnore.match("node_modules/lodash/index.js") // true
   *
   *
   * // 匹配临时文件
   * FileIgnore.match("src/temp.log") // true
   */
  export function match(
    filepath: string,
    opts?: {
      extra?: string[]
      whitelist?: string[]
    },
  ) {
    // 第一步：检查白名单，如果匹配则直接返回 false（不忽略）
    for (const pattern of opts?.whitelist || []) {
      if (Glob.match(pattern, filepath)) return false
    }

    // 第二步：将路径按分隔符拆分为多个部分，检查是否有部分匹配忽略的文件夹名称
    // 这样可以匹配嵌套路径，如 "src/node_modules/foo" 也会被忽略
    const parts = filepath.split(/[/\\]/)
    for (let i = 0; i < parts.length; i++) {
      if (FOLDERS.has(parts[i])) return true
    }

    // 第三步：使用 glob 模式匹配文件（包括默认模式和额外模式）
    const extra = opts?.extra || []
    for (const pattern of [...FILES, ...extra]) {
      if (Glob.match(pattern, filepath)) return true
    }

    // 如果以上规则都不匹配，则不忽略该文件
    return false
  }
}
