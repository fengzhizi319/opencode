// 导入 Zod 库用于运行时类型验证和 schema 定义
import z from "zod"
// 导入 Node.js OS 模块，用于获取系统信息（如家目录）
import os from "os"
// 导入子进程模块，用于生成 shell 进程
import { spawn } from "child_process"
// 导入 Tool 基类，用于定义工具的标准接口和行为
import { Tool } from "./tool"
// 导入 Node.js 路径模块，用于处理文件路径
import path from "path"
// 导入 bash 工具的描述文本（从外部文件加载）
import DESCRIPTION from "./bash.txt"
// 导入日志模块，用于记录工具执行信息
import { Log } from "../util/log"
// 导入实例模块，提供项目工作目录和路径管理
import { Instance } from "../project/instance"
// 导入懒加载工具，用于延迟初始化重型资源
import { lazy } from "@/util/lazy"
// 导入 Tree-sitter 解析器类型，用于命令语法分析
import { Language, type Node } from "web-tree-sitter"

// 导入文件系统工具模块
import { Filesystem } from "@/util/filesystem"
// 导入进程管理工具模块
import { Process } from "@/util/process"
// 导入 URL 转换工具，将 file:// URL 转换为本地路径
import { fileURLToPath } from "url"
// 导入功能标志模块，用于读取实验性配置
import { Flag } from "@/flag/flag"
// 导入 Shell 模块，提供 shell 检测和管理功能
import { Shell } from "@/shell/shell"

// 导入 Bash 参数数量（arity）处理模块，用于权限评估
import { BashArity } from "@/permission/arity"
// 导入截断工具，用于限制输出长度
import { Truncate } from "./truncate"
// 导入插件模块，支持扩展点触发
import { Plugin } from "@/plugin"

/** 元数据的最大长度限制（30,000 字符） */
const MAX_METADATA_LENGTH = 30_000

/**
 * Bash 命令的默认超时时间（毫秒）
 * 优先使用环境变量 OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS，否则默认为 2 分钟
 */
const DEFAULT_TIMEOUT = Flag.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS || 2 * 60 * 1000

/** PowerShell 相关命令名称集合 */
const PS = new Set(["powershell", "pwsh"])

/** 目录切换命令集合（包括 POSIX 和 PowerShell 命令） */
const CWD = new Set(["cd", "push-location", "set-location"])

/**
 * 文件系统操作命令集合
 * 包含常见的文件和目录操作命令（POSIX 和 PowerShell）
 */
const FILES = new Set([
  ...CWD,  // 包含目录切换命令
  "rm",    // 删除文件/目录
  "cp",    // 复制文件/目录
  "mv",    // 移动/重命名文件/目录
  "mkdir", // 创建目录
  "touch", // 创建空文件或更新时间戳
  "chmod", // 修改文件权限
  "chown", // 修改文件所有者
  "cat",   // 查看文件内容
  // PowerShell 别名已包含在上述命令中，以下为其完整命令名
  "get-content",   // PowerShell: 读取文件内容
  "set-content",   // PowerShell: 写入文件内容
  "add-content",   // PowerShell: 追加文件内容
  "copy-item",     // PowerShell: 复制项
  "move-item",     // PowerShell: 移动项
  "remove-item",   // PowerShell: 删除项
  "new-item",      // PowerShell: 创建新项
  "rename-item",   // PowerShell: 重命名项
])

/** PowerShell 路径相关参数标志 */
const FLAGS = new Set(["-destination", "-literalpath", "-path"])

/** PowerShell 开关参数集合（布尔型参数） */
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])

/**
 * Part 类型：表示命令解析后的单个部分
 */
type Part = {
  type: string  // 部分类型（如 command_name, word, string 等）
  text: string  // 部分的文本内容
}

/**
 * Scan 类型：表示命令扫描结果
 * 用于收集需要权限检查的路径和模式
 */
type Scan = {
  dirs: Set<string>      // 需要访问的目录集合
  patterns: Set<string>  // 命令模式集合（用于权限检查）
  always: Set<string>    // 始终允许的命令模式集合
}

/** 创建 bash-tool 服务的日志记录器 */
export const log = Log.create({ service: "bash-tool" })

/**
 * 解析 WASM 文件路径
 * 支持 file:// URL、绝对路径和相对路径
 *
 * @param asset - WASM 资源标识符
 * @returns 本地文件系统路径
 */
const resolveWasm = (asset: string) => {
  // 如果是 file:// URL，转换为本地路径
  if (asset.startsWith("file://")) return fileURLToPath(asset)

  // 如果是绝对路径（Unix 或 Windows），直接返回
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset

  // 否则作为相对路径，基于当前模块 URL 解析
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

/**
 * 提取命令节点的各个部分
 * 遍历 Tree-sitter 解析树的子节点，收集命令元素
 *
 * @param node - Tree-sitter 命令节点
 * @returns 命令部分数组
 */
function parts(node: Node) {
  const out: Part[] = []

  // 遍历所有子节点
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue

    // 处理 command_elements 类型（命令元素集合）
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        // 跳过分隔符和重定向符号
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }

    // 只收集特定类型的节点（命令名、单词、字符串等）
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }

    out.push({ type: child.type, text: child.text })
  }

  return out
}

/**
 * 获取命令的源代码文本
 * 如果节点是重定向语句的一部分，则返回父节点文本
 *
 * @param node - Tree-sitter 节点
 * @returns 修剪后的命令文本
 */
function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

/**
 * 提取所有命令节点
 * 从根节点中递归查找所有类型为 "command" 的后代节点
 *
 * @param node - Tree-sitter 根节点
 * @returns 命令节点数组
 */
function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

/**
 * 去除字符串的引号
 * 如果字符串被成对的单引号或双引号包裹，则移除它们
 *
 * @param text - 待处理的文本
 * @returns 去引号后的文本
 */
function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

/**
 * 展开波浪号（~）为家目录路径
 * 支持 ~、~/ 和 ~\ 格式
 *
 * @param text - 待处理的路径文本
 * @returns 展开后的路径
 */
function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

/**
 * 获取环境变量值（跨平台兼容）
 * 在 Windows 上进行大小写不敏感的查找
 *
 * @param key - 环境变量名
 * @returns 环境变量值，未找到则返回 undefined
 */
function envValue(key: string) {
  // 非 Windows 系统直接查找
  if (process.platform !== "win32") return process.env[key]

  // Windows 系统进行大小写不敏感查找
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

/**
 * 自动解析特殊环境变量
 * 处理 HOME、PWD、PSHOME 等常见变量
 *
 * @param key - 环境变量名
 * @param cwd - 当前工作目录
 * @param shell - Shell 路径
 * @returns 变量值
 */
function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

/**
 * 展开 PowerShell 环境变量和特殊变量
 * 支持 $env:VAR、${env:VAR}、$HOME、$PWD、$PSHOME 等格式
 *
 * @param text - 待展开的文本
 * @param cwd - 当前工作目录
 * @param shell - Shell 路径
 * @returns 展开后的文本
 */
function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    // 替换 ${env:VAR} 格式
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    // 替换 $env:VAR 格式
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    // 替换 $HOME、$PWD、$PSHOME（仅在路径分隔符前）
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")

  return home(out)
}

/**
 * 处理 PowerShell 提供者路径（Provider Path）
 * 识别并提取 FileSystem 提供者的路径（如 FileSystem::C:\path）
 *
 * @param text - 待处理的路径文本
 * @returns 提取的文件系统路径，如果不是 FileSystem 提供者则返回 undefined
 */
function provider(text: string) {
  // 匹配 Provider::Path 格式
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    // 只处理 FileSystem 提供者
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }

  // 检查是否为单字母驱动器盘符（如 C:）
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text  // 单字母是 Windows 盘符，保留原样

  // 其他多字母前缀不是有效路径，返回 undefined
  return
}

/**
 * 检测文本是否包含动态内容
 * 动态内容包括：子命令、变量插值、反引号等
 *
 * @param text - 待检测的文本
 * @param ps - 是否为 PowerShell
 * @returns 是否包含动态内容
 */
function dynamic(text: string, ps: boolean) {
  // 检测子命令语法
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true

  // PowerShell 中检测非环境变量以外的变量
  if (ps) return /\$(?!env:)/i.test(text)

  // 其他 shell 中检测任何 $ 符号
  return text.includes("$")
}

/**
 * 提取通配符前的前缀路径
 * 用于确定 glob 模式的基准目录
 *
 * @param text - 包含通配符的路径文本
 * @returns 通配符前的前缀，如果没有通配符则返回原文本
 */
function prefix(text: string) {
  const match = /[?*\[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return  // 通配符在开头，无前缀
  return text.slice(0, match.index)
}

/**
 * 使用 cygpath 转换 POSIX 路径为 Windows 路径
 * 仅在 Cygwin/MSYS 环境中使用
 *
 * @param shell - Shell 路径
 * @param text - POSIX 格式路径
 * @returns Windows 格式路径，失败则返回 undefined
 */
async function cygpath(shell: string, text: string) {
  const out = await Process.text([shell, "-lc", 'cygpath -w -- "$1"', "_", text], { nothrow: true })
  if (out.code !== 0) return
  const file = out.text.trim()
  if (!file) return
  return Filesystem.normalizePath(file)
}

/**
 * 解析路径为绝对路径
 * 处理 Windows 平台的特殊路径格式（如 Cygwin 路径）
 *
 * @param text - 待解析的路径文本
 * @param root - 根目录（用于相对路径解析）
 * @param shell - Shell 路径
 * @returns 绝对路径
 */
async function resolvePath(text: string, root: string, shell: string) {
  if (process.platform === "win32") {
    // 在 Windows 上，如果是 POSIX shell 且路径以 / 开头，尝试使用 cygpath 转换
    if (Shell.posix(shell) && text.startsWith("/") && Filesystem.windowsPath(text) === text) {
      const file = await cygpath(shell, text)
      if (file) return file
    }

    // 标准化 Windows 路径并解析为绝对路径
    return Filesystem.normalizePath(path.resolve(root, Filesystem.windowsPath(text)))
  }

  // 非 Windows 平台直接解析
  return path.resolve(root, text)
}

/**
 * 解析命令行参数为文件路径
 * 处理引号、环境变量展开、通配符等
 *
 * @param arg - 命令行参数
 * @param cwd - 当前工作目录
 * @param ps - 是否为 PowerShell
 * @param shell - Shell 路径
 * @returns 解析后的绝对路径，失败则返回 undefined
 */
async function argPath(arg: string, cwd: string, ps: boolean, shell: string) {
  // 根据 shell 类型展开变量和路径
  const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))

  // 提取通配符前的前缀
  const file = text && prefix(text)

  // 如果存在动态内容，无法静态解析
  if (!file || dynamic(file, ps)) return

  // 处理 PowerShell 提供者路径
  const next = ps ? provider(file) : file
  if (!next) return

  // 解析为绝对路径
  return resolvePath(next, cwd, shell)
}

/**
 * 提取命令中的路径参数
 * 过滤掉标志（flags）和开关（switches），只保留路径参数
 *
 * @param list - 命令部分数组
 * @param ps - 是否为 PowerShell
 * @returns 路径参数数组
 */
function pathArgs(list: Part[], ps: boolean) {
  // 非 PowerShell：简单过滤以 - 开头的参数（chmod 的 + 模式除外）
  if (!ps) {
    return list
      .slice(1)  // 跳过命令名
      .filter((item) => !item.text.startsWith("-") && !(list[0]?.text === "chmod" && item.text.startsWith("+")))
      .map((item) => item.text)
  }

  // PowerShell：复杂解析，考虑参数类型
  const out: string[] = []
  let want = false  // 标记是否需要下一个参数（如 -Path 后的值）

  for (const item of list.slice(1)) {
    if (want) {
      // 这是参数值，添加到结果中
      out.push(item.text)
      want = false
      continue
    }

    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()

      // 跳过布尔开关（如 -Force、-Recurse）
      if (SWITCHES.has(flag)) continue

      // 标记下一个参数是需要捕获的值（如 -Path 后的路径）
      want = FLAGS.has(flag)
      continue
    }

    // 普通参数，直接添加
    out.push(item.text)
  }

  return out
}

/**
 * 收集命令中的文件系统操作信息
 * 解析命令树，提取需要权限检查的目录和命令模式
 *
 * @param root - Tree-sitter 解析树根节点
 * @param cwd - 当前工作目录
 * @param ps - 是否为 PowerShell
 * @param shell - Shell 路径
 * @returns 扫描结果（dirs、patterns、always）
 */
async function collect(root: Node, cwd: string, ps: boolean, shell: string): Promise<Scan> {
  const scan: Scan = {
    dirs: new Set<string>(),
    patterns: new Set<string>(),
    always: new Set<string>(),
  }

  // 遍历所有命令节点
  for (const node of commands(root)) {
    const command = parts(node)
    const tokens = command.map((item) => item.text)
    const cmd = ps ? tokens[0]?.toLowerCase() : tokens[0]

    // 如果是文件系统操作命令，收集涉及的目录
    if (cmd && FILES.has(cmd)) {
      for (const arg of pathArgs(command, ps)) {
        // 解析参数为绝对路径
        const resolved = await argPath(arg, cwd, ps, shell)
        log.info("resolved path", { arg, resolved })

        // 跳过空路径或项目内部路径（无需额外权限）
        if (!resolved || Instance.containsPath(resolved)) continue

        // 确定目录：如果是目录则直接使用，否则取其父目录
        const dir = (await Filesystem.isDir(resolved)) ? resolved : path.dirname(resolved)
        scan.dirs.add(dir)
      }
    }

    // 如果不是纯目录切换命令，记录命令模式用于权限检查
    if (tokens.length && (!cmd || !CWD.has(cmd))) {
      scan.patterns.add(source(node))
      scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
    }
  }

  return scan
}

/**
 * 预览文本：截断过长的文本
 * 用于元数据显示，避免过大
 *
 * @param text - 待截断的文本
 * @returns 截断后的文本
 */
function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return text.slice(0, MAX_METADATA_LENGTH) + "\n\n..."
}

/**
 * 解析命令字符串为 Tree-sitter 语法树
 * 根据 shell 类型选择 Bash 或 PowerShell 解析器
 *
 * @param command - 命令字符串
 * @param ps - 是否为 PowerShell
 * @returns 语法树根节点
 */
async function parse(command: string, ps: boolean) {
  const tree = await parser().then((p) => (ps ? p.ps : p.bash).parse(command))
  if (!tree) throw new Error("Failed to parse command")
  return tree.rootNode
}

/**
 * 请求用户权限
 * 根据扫描结果，分别请求外部目录访问和命令执行权限
 *
 * @param ctx - 工具执行上下文
 * @param scan - 扫描结果
 */
async function ask(ctx: Tool.Context, scan: Scan) {
  // 如果涉及外部目录，请求 external_directory 权限
  if (scan.dirs.size > 0) {
    const globs = Array.from(scan.dirs).map((dir) => {
      // Windows 平台标准化路径模式
      if (process.platform === "win32") return Filesystem.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })

    await ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      metadata: {},
    })
  }

  // 如果有命令模式，请求 bash 权限
  if (scan.patterns.size === 0) return
  await ctx.ask({
    permission: "bash",
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    metadata: {},
  })
}

/**
 * 获取 Shell 环境变量
 * 合并系统环境变量和插件注入的环境变量
 *
 * @param ctx - 工具执行上下文
 * @param cwd - 当前工作目录
 * @returns 合并后的环境变量对象
 */
async function shellEnv(ctx: Tool.Context, cwd: string) {
  // 触发插件扩展点，允许插件注入环境变量
  const extra = await Plugin.trigger("shell.env", { cwd, sessionID: ctx.sessionID, callID: ctx.callID }, { env: {} })

  return {
    ...process.env,
    ...extra.env,
  }
}

/**
 * 启动 Shell 进程
 * 根据平台和 shell 类型选择合适的启动方式
 *
 * @param shell - Shell 可执行文件路径
 * @param name - Shell 名称
 * @param command - 要执行的命令
 * @param cwd - 工作目录
 * @param env - 环境变量
 * @returns 生成的子进程对象
 */
function launch(shell: string, name: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  // Windows PowerShell 特殊处理
  if (process.platform === "win32" && PS.has(name)) {
    return spawn(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],  // 忽略 stdin，捕获 stdout/stderr
      detached: false,
      windowsHide: true,  // 隐藏 Windows 控制台窗口
    })
  }

  // 其他 shell（Bash、Zsh 等）
  return spawn(command, {
    shell,  // 使用指定的 shell 执行命令
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",  // Unix 系统分离进程
    windowsHide: process.platform === "win32",
  })
}

/**
 * 运行 Shell 命令并捕获输出
 * 处理超时、中止、错误等情况
 *
 * @param input - 运行参数对象
 * @param ctx - 工具执行上下文
 * @returns 执行结果（标题、元数据、输出）
 */
async function run(
  input: {
    shell: string
    name: string
    command: string
    cwd: string
    env: NodeJS.ProcessEnv
    timeout: number
    description: string
  },
  ctx: Tool.Context,
) {
  // 启动进程
  const proc = launch(input.shell, input.name, input.command, input.cwd, input.env)
  let output = ""

  // 初始化元数据
  ctx.metadata({
    metadata: {
      output: "",
      description: input.description,
    },
  })

  /**
   * 追加输出块到累积输出
   * 同时更新元数据（带长度限制）
   */
  const append = (chunk: Buffer) => {
    output += chunk.toString()
    ctx.metadata({
      metadata: {
        output: preview(output),
        description: input.description,
      },
    })
  }

  // 监听标准输出和标准错误
  proc.stdout?.on("data", append)
  proc.stderr?.on("data", append)

  // 状态标志
  let expired = false   // 是否超时
  let aborted = false   // 是否被用户中止
  let exited = false    // 是否已退出

  /**
   * 终止进程及其子进程树
   */
  const kill = () => Shell.killTree(proc, { exited: () => exited })

  // 如果上下文已中止，立即终止进程
  if (ctx.abort.aborted) {
    aborted = true
    await kill()
  }

  /**
   * 中止处理函数
   */
  const abort = () => {
    aborted = true
    void kill()
  }

  // 注册中止事件监听器（仅触发一次）
  ctx.abort.addEventListener("abort", abort, { once: true })

  // 设置超时定时器（额外增加 100ms 缓冲）
  const timer = setTimeout(() => {
    expired = true
    void kill()
  }, input.timeout + 100)

  // 等待进程结束
  await new Promise<void>((resolve, reject) => {
    /**
     * 清理资源：清除定时器、移除事件监听器
     */
    const cleanup = () => {
      clearTimeout(timer)
      ctx.abort.removeEventListener("abort", abort)
    }

    // 监听 exit 事件（进程退出）
    proc.once("exit", () => {
      exited = true
    })

    // 监听 close 事件（所有流关闭，正常结束）
    proc.once("close", () => {
      exited = true
      cleanup()
      resolve()
    })

    // 监听 error 事件（进程启动失败等错误）
    proc.once("error", (error) => {
      exited = true
      cleanup()
      reject(error)
    })
  })

  // 构建元数据消息
  const metadata: string[] = []
  if (expired) metadata.push(`bash tool terminated command after exceeding timeout ${input.timeout} ms`)
  if (aborted) metadata.push("User aborted the command")

  // 如果有元数据消息，附加到输出末尾
  if (metadata.length > 0) {
    output += "\n\n<bash_metadata>\n" + metadata.join("\n") + "\n</bash_metadata>"
  }

  // 返回执行结果
  return {
    title: input.description,
    metadata: {
      output: preview(output),
      exit: proc.exitCode,
      description: input.description,
    },
    output,
  }
}

/**
 * 懒加载 Tree-sitter 解析器
 * 延迟初始化 Bash 和 PowerShell 解析器，避免启动时加载大型 WASM 文件
 *
 * @returns 包含 bash 和 ps 解析器的对象
 */
const parser = lazy(async () => {
  // 动态导入 Tree-sitter 核心库
  const { Parser } = await import("web-tree-sitter")

  // 导入 Tree-sitter 核心 WASM 文件
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)

  // 初始化 Parser 并指定 WASM 文件位置
  await Parser.init({
    locateFile() {
      return treePath
    },
  })

  // 导入 Bash 语法 WASM 文件
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })

  // 导入 PowerShell 语法 WASM 文件
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })

  // 解析 WASM 文件路径
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)

  // 并行加载两种语言的语法
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])

  // 创建并配置 Bash 解析器
  const bash = new Parser()
  bash.setLanguage(bashLanguage)

  // 创建并配置 PowerShell 解析器
  const ps = new Parser()
  ps.setLanguage(psLanguage)

  return { bash, ps }
})

/**
 * BashTool - Shell 命令执行工具
 *
 * 该工具执行 shell 命令，并在执行前进行安全性扫描和权限检查。
 *
 * 在执行前，使用 Tree-sitter 解析命令以检测文件系统操作。
 * 外部目录访问和命令本身都需要通过权限系统获得用户批准。
 *
 * 主要特性：
 * - 跨平台支持（Bash、Zsh、PowerShell）
 * - 智能路径解析和变量展开
 * - 文件系统操作检测和权限控制
 * - 超时和中止支持
 * - 实时输出捕获和元数据更新
 */
// TODO: 可能需要重命名此工具以更好地支持其他 shell
export const BashTool = Tool.define("bash", async () => {
  // 获取可用的 shell
  const shell = Shell.acceptable()
  const name = Shell.name(shell)

  // 根据 shell 类型生成命令链式执行的说明
  const chain =
    name === "powershell"
      ? "If the commands depend on each other and must run sequentially, avoid '&&' in this shell because Windows PowerShell 5.1 does not support it. Use PowerShell conditionals such as `cmd1; if ($?) { cmd2 }` when later commands must depend on earlier success."
      : "If the commands depend on each other and must run sequentially, use a single Bash call with '&&' to chain them together (e.g., `git add . && git commit -m \"message\" && git push`). For instance, if one operation must complete before another starts (like mkdir before cp, Write before Bash for git operations, or git add before git commit), run these operations sequentially instead."

  log.info("bash tool using shell", { shell })

  return {
    // 动态生成工具描述，替换占位符
    description: DESCRIPTION.replaceAll("${directory}", Instance.directory)
      .replaceAll("${os}", process.platform)
      .replaceAll("${shell}", name)
      .replaceAll("${chaining}", chain)
      .replaceAll("${maxLines}", String(Truncate.MAX_LINES))
      .replaceAll("${maxBytes}", String(Truncate.MAX_BYTES)),

    // 参数定义
    parameters: z.object({
      // command: 要执行的 shell 命令
      command: z.string().describe("The command to execute"),

      // timeout: 可选的超时时间（毫秒）
      timeout: z.number().describe("Optional timeout in milliseconds").optional(),

      // workdir: 工作目录，默认为项目目录
      workdir: z
        .string()
        .describe(
          `The working directory to run the command in. Defaults to ${Instance.directory}. Use this instead of 'cd' commands.`,
        )
        .optional(),

      // description: 命令功能的简短描述（5-10 个词）
      description: z
        .string()
        .describe(
          "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'",
        ),
    }),

    /**
     * 执行函数：解析命令、请求权限、生成 shell 进程
     *
     * @param params - 命令参数对象
     * @param ctx - 工具执行上下文
     * @returns 执行结果
     */
    async execute(params, ctx) {
      // 解析工作目录（如果指定）
      const cwd = params.workdir ? await resolvePath(params.workdir, Instance.directory, shell) : Instance.directory

      // 验证超时值
      if (params.timeout !== undefined && params.timeout < 0) {
        throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
      }

      // 确定超时时间
      const timeout = params.timeout ?? DEFAULT_TIMEOUT

      // 判断是否为 PowerShell
      const ps = PS.has(name)

      // 解析命令为语法树
      const root = await parse(params.command, ps)

      // 扫描命令中的文件系统操作
      const scan = await collect(root, cwd, ps, shell)

      // 如果工作目录在项目外，添加到扫描结果
      if (!Instance.containsPath(cwd)) scan.dirs.add(cwd)

      // 请求用户权限
      await ask(ctx, scan)

      // 执行命令
      return run(
        {
          shell,
          name,
          command: params.command,
          cwd,
          env: await shellEnv(ctx, cwd),
          timeout,
          description: params.description,
        },
        ctx,
      )
    },
  }
})

