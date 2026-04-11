// 导入 Effect 框架和 Node.js 相关模块
import { NodeFileSystem, NodePath } from "@effect/platform-node"  // Effect 平台的文件系统和路径模块
import { describe, expect } from "bun:test"  // Bun 测试框架
import fs from "node:fs/promises"  // Node.js 文件系统模块（Promise API）
import path from "node:path"  // Node.js 路径模块
import { Effect, Exit, Layer, Stream } from "effect"  // Effect 核心模块
import type * as PlatformError from "effect/PlatformError"  // 平台错误类型
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"  // Effect 的子进程模块
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"  // cross-spawn 包装器实现
import { tmpdir } from "../fixture/fixture"  // 临时目录工具函数
import { testEffect } from "../lib/effect"  // Effect 测试辅助函数

/**
 * 初始化测试环境
 * 
 * live: CrossSpawnSpawner 的默认 Layer，包含所有依赖（FileSystem、Path）
 * fx: testEffect 辅助函数，用于简化 Effect 测试的编写
 */
const live = CrossSpawnSpawner.defaultLayer
const fx = testEffect(live)

/**
 * 辅助函数：创建一个执行 JavaScript 代码的子进程命令
 * 
 * @param code - 要执行的 JavaScript 代码字符串
 * @param opts - 可选的子进程配置选项
 * @returns ChildProcess 命令对象
 * 
 * 示例：
 * ```ts
 * const cmd = js('console.log("hello")')
 * // 等价于：ChildProcess.make("node", ["-e", 'console.log("hello")'])
 * ```
 */
function js(code: string, opts?: ChildProcess.CommandOptions) {
  return ChildProcess.make("node", ["-e", code], opts)
}

/**
 * 辅助函数：将字节流解码为 UTF-8 字符串
 * 
 * 作用：
 * - 从 Stream<Uint8Array> 收集所有数据块
 * - 将所有块合并为一个完整的 Uint8Array
 * - 使用 TextDecoder 解码为 UTF-8 字符串
 * - 去除首尾空白字符
 * 
 * @param stream - 字节流
 * @returns Effect，产出解码后的字符串
 * 
 * 工作流程：
 * 1. Stream.runCollect: 收集所有数据块到数组
 * 2. Effect.map: 转换收集的数据
 *    - 计算总长度
 *    - 创建新的 Uint8Array
 *    - 依次复制每个块到新数组
 *    - 解码为字符串并 trim
 */
function decodeByteStream(stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) {
  return Stream.runCollect(stream).pipe(
    Effect.map((chunks) => {
      // 计算所有块的总长度
      const total = chunks.reduce((acc, x) => acc + x.length, 0)
      // 创建足够大的 Uint8Array
      const out = new Uint8Array(total)
      let off = 0
      // 依次复制每个块
      for (const chunk of chunks) {
        out.set(chunk, off)
        off += chunk.length
      }
      // 解码为 UTF-8 字符串并去除空白
      return new TextDecoder("utf-8").decode(out).trim()
    }),
  )
}

/**
 * 辅助函数：检查进程是否仍然存活
 * 
 * @param pid - 进程 ID
 * @returns true 如果进程存在，false 如果进程不存在
 * 
 * 实现原理：
 * - 使用 process.kill(pid, 0) 发送信号 0
 * - 信号 0 不会真正杀死进程，只是检查进程是否存在
 * - 如果抛出异常，说明进程不存在
 */
function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 辅助函数：等待进程结束
 * 
 * @param pid - 进程 ID
 * @param timeout - 超时时间（毫秒），默认 5000ms
 * @returns Promise<boolean>，true 表示进程已结束，false 表示超时
 * 
 * 工作原理：
 * - 轮询检查进程状态，每 50ms 检查一次
 * - 如果在超时时间内进程结束，返回 true
 * - 如果超时后进程仍然存在，返回 false
 * 
 * 应用场景：
 * - 验证进程被正确杀死
 * - 等待子进程自然退出
 */
async function gone(pid: number, timeout = 5_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (!alive(pid)) return true
    await Bun.sleep(50)
  }
  return !alive(pid)
}

/**
 * 测试套件：cross-spawn spawner
 * 
 * CrossSpawnSpawner 的作用：
 * - 基于 cross-spawn 库实现的 Effect 风格的子进程管理器
 * - 提供类型安全、函数式的子进程 API
 * - 支持跨平台（Windows、macOS、Linux）
 * - 集成 Effect 的响应式流（Stream/Sink）处理 stdin/stdout/stderr
 * - 支持进程管道（pipeline）、资源管理、错误处理等高级功能
 * 
 * 核心特性：
 * 1. 命令执行：spawn 子进程并捕获输出
 * 2. 流式处理：通过 Stream/Sink 处理输入输出
 * 3. 进程控制：kill、超时、强制终止
 * 4. 管道支持：将一个进程的输出连接到另一个进程的输入
 * 5. 资源管理：自动清理，防止僵尸进程
 * 6. 跨平台兼容：处理 Windows 和 Unix 系统的差异
 */
describe("cross-spawn spawner", () => {
  /**
   * 测试组 1：基本生成功能
   * 
   * 验证最基本的子进程执行功能：
   * - 捕获标准输出
   * - 处理多行输出
   * - 获取退出码
   */
  describe("basic spawning", () => {
    /**
     * 测试用例 1.1：验证能够捕获标准输出
     * 
     * 场景：执行 `node -e 'process.stdout.write("ok")'`
     * 预期：返回字符串 "ok"
     */
    fx.effect(
      "captures stdout",
      Effect.gen(function* () {
        // 使用 ChildProcessSpawner 服务执行命令并获取字符串输出
        const out = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          svc.string(ChildProcess.make(process.execPath, ["-e", 'process.stdout.write("ok")'])),
        )
        expect(out).toBe("ok")
      }),
    )

    /**
     * 测试用例 1.2：验证能够捕获多行输出
     * 
     * 场景：执行打印三行的 Node.js 脚本
     * 预期：输出为 "line1\nline2\nline3"（保留换行符）
     */
    fx.effect(
      "captures multiple lines",
      Effect.gen(function* () {
        // 创建子进程句柄
        const handle = yield* js('console.log("line1"); console.log("line2"); console.log("line3")')
        // 解码 stdout 流为字符串
        const out = yield* decodeByteStream(handle.stdout)
        expect(out).toBe("line1\nline2\nline3")
      }),
    )

    /**
     * 测试用例 1.3：验证能够获取退出码 0（成功）
     * 
     * 场景：执行 `process.exit(0)`
     * 预期：退出码为 ExitCode(0)
     */
    fx.effect(
      "returns exit code",
      Effect.gen(function* () {
        const handle = yield* js("process.exit(0)")
        const code = yield* handle.exitCode
        expect(code).toBe(ChildProcessSpawner.ExitCode(0))
      }),
    )

    /**
     * 测试用例 1.4：验证能够获取非零退出码（失败）
     * 
     * 场景：执行 `process.exit(42)`
     * 预期：退出码为 ExitCode(42)
     */
    fx.effect(
      "returns non-zero exit code",
      Effect.gen(function* () {
        const handle = yield* js("process.exit(42)")
        const code = yield* handle.exitCode
        expect(code).toBe(ChildProcessSpawner.ExitCode(42))
      }),
    )
  })

  /**
   * 测试组 2：工作目录（cwd）选项
   * 
   * 验证子进程的工作目录设置功能：
   * - 正确设置 cwd
   * - 处理无效的 cwd 路径
   */
  describe("cwd option", () => {
    /**
     * 测试用例 2.1：验证使用 cwd 选项时命令在指定目录执行
     * 
     * 场景：
     * - 创建临时目录
     * - 在该目录下执行 `process.cwd()`
     * 预期：返回临时目录的路径
     */
    fx.effect(
      "uses cwd when spawning commands",
      Effect.gen(function* () {
        // 创建临时目录，并在测试结束后自动清理
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        // 在临时目录下执行命令，获取当前工作目录
        const out = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          svc.string(
            ChildProcess.make(process.execPath, ["-e", "process.stdout.write(process.cwd())"], { cwd: tmp.path }),
          ),
        )
        expect(out).toBe(tmp.path)
      }),
    )

    /**
     * 测试用例 2.2：验证当 cwd 无效时命令执行失败
     * 
     * 场景：尝试在不存在的目录中执行命令
     * 预期：Effect 执行失败（Exit.isFailure 为 true）
     */
    fx.effect(
      "fails for invalid cwd",
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          ChildProcess.make("echo", ["test"], { cwd: "/nonexistent/directory/path" }).asEffect(),
        )
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    )
  })

  /**
   * 测试组 3：环境变量（env）选项
   * 
   * 验证子进程的环境变量传递功能：
   * - 单个环境变量
   * - 多个环境变量
   * - extendEnv 选项（继承父进程环境变量）
   */
  describe("env option", () => {
    /**
     * 测试用例 3.1：验证使用 extendEnv 时传递环境变量
     * 
     * 场景：
     * - 设置 TEST_VAR="test_value"
     * - extendEnv: true（继承父进程环境变量）
     * 预期：子进程能够访问 TEST_VAR
     */
    fx.effect(
      "passes environment variables with extendEnv",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write(process.env.TEST_VAR ?? "")', {
          env: { TEST_VAR: "test_value" },
          extendEnv: true,
        })
        const out = yield* decodeByteStream(handle.stdout)
        expect(out).toBe("test_value")
      }),
    )

    /**
     * 测试用例 3.2：验证能够传递多个环境变量
     * 
     * 场景：设置 VAR1、VAR2、VAR3 三个环境变量
     * 预期：子进程能够访问所有变量，输出 "one-two-three"
     */
    fx.effect(
      "passes multiple environment variables",
      Effect.gen(function* () {
        const handle = yield* js(
          "process.stdout.write(`${process.env.VAR1}-${process.env.VAR2}-${process.env.VAR3}`)",
          {
            env: { VAR1: "one", VAR2: "two", VAR3: "three" },
            extendEnv: true,
          },
        )
        const out = yield* decodeByteStream(handle.stdout)
        expect(out).toBe("one-two-three")
      }),
    )
  })

  /**
   * 测试组 4：标准错误输出（stderr）
   * 
   * 验证 stderr 的捕获功能：
   * - 单独捕获 stderr
   * - 同时捕获 stdout 和 stderr
   */
  describe("stderr", () => {
    /**
     * 测试用例 4.1：验证能够捕获标准错误输出
     * 
     * 场景：执行 `process.stderr.write("error message")`
     * 预期：stderr 包含 "error message"
     */
    fx.effect(
      "captures stderr output",
      Effect.gen(function* () {
        const handle = yield* js('process.stderr.write("error message")')
        const err = yield* decodeByteStream(handle.stderr)
        expect(err).toBe("error message")
      }),
    )

    /**
     * 测试用例 4.2：验证能够同时捕获 stdout 和 stderr
     * 
     * 场景：同时写入 stdout 和 stderr
     * 预期：两个流都能正确捕获各自的内容
     */
    fx.effect(
      "captures both stdout and stderr",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write("stdout\\n"); process.stderr.write("stderr\\n")')
        // 并行解码两个流
        const [stdout, stderr] = yield* Effect.all([decodeByteStream(handle.stdout), decodeByteStream(handle.stderr)])
        expect(stdout).toBe("stdout")
        expect(stderr).toBe("stderr")
      }),
    )
  })

  /**
   * 测试组 5：合并输出（combined output - all）
   * 
   * 验证 .all 流的功能：
   * - .all 是 stdout 和 stderr 的合并流
   * - 当只有 stdout 时，.all 包含 stdout
   * - 当只有 stderr 时，.all 包含 stderr
   */
  describe("combined output (all)", () => {
    /**
     * 测试用例 5.1：验证当没有 stderr 时，.all 捕获 stdout
     * 
     * 场景：只写入 stdout
     * 预期：.all 流包含 stdout 的内容
     */
    fx.effect(
      "captures stdout via .all when no stderr",
      Effect.gen(function* () {
        const handle = yield* ChildProcess.make("echo", ["hello from stdout"])
        const all = yield* decodeByteStream(handle.all)
        expect(all).toBe("hello from stdout")
      }),
    )

    /**
     * 测试用例 5.2：验证当没有 stdout 时，.all 捕获 stderr
     * 
     * 场景：只写入 stderr
     * 预期：.all 流包含 stderr 的内容
     */
    fx.effect(
      "captures stderr via .all when no stdout",
      Effect.gen(function* () {
        const handle = yield* js('process.stderr.write("hello from stderr")')
        const all = yield* decodeByteStream(handle.all)
        expect(all).toBe("hello from stderr")
      }),
    )
  })

  describe("stdin", () => {
    fx.effect(
      "allows providing standard input to a command",
      Effect.gen(function* () {
        const input = "a b c"
        const stdin = Stream.make(Buffer.from(input, "utf-8"))
        const handle = yield* js(
          'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out))',
          { stdin },
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toBe("a b c")
      }),
    )
  })

  describe("process control", () => {
    fx.effect(
      "kills a running process",
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            const handle = yield* js("setTimeout(() => {}, 10_000)")
            yield* handle.kill()
            return yield* handle.exitCode
          }),
        )
        expect(Exit.isFailure(exit) ? true : exit.value !== ChildProcessSpawner.ExitCode(0)).toBe(true)
      }),
    )

    fx.effect(
      "kills a child when scope exits",
      Effect.gen(function* () {
        const pid = yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* js("setInterval(() => {}, 10_000)")
            return Number(handle.pid)
          }),
        )
        const done = yield* Effect.promise(() => gone(pid))
        expect(done).toBe(true)
      }),
    )

    fx.effect(
      "forceKillAfter escalates for stubborn processes",
      Effect.gen(function* () {
        if (process.platform === "win32") return

        const started = Date.now()
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            const handle = yield* js('process.on("SIGTERM", () => {}); setInterval(() => {}, 10_000)')
            yield* handle.kill({ forceKillAfter: 100 })
            return yield* handle.exitCode
          }),
        )

        expect(Date.now() - started).toBeLessThan(1_000)
        expect(Exit.isFailure(exit) ? true : exit.value !== ChildProcessSpawner.ExitCode(0)).toBe(true)
      }),
    )

    fx.effect(
      "isRunning reflects process state",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write("done")')
        yield* handle.exitCode
        const running = yield* handle.isRunning
        expect(running).toBe(false)
      }),
    )
  })

  describe("error handling", () => {
    fx.effect(
      "fails for invalid command",
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            const handle = yield* ChildProcess.make("nonexistent-command-12345")
            return yield* handle.exitCode
          }),
        )
        expect(Exit.isFailure(exit) ? true : exit.value !== ChildProcessSpawner.ExitCode(0)).toBe(true)
      }),
    )
  })

  describe("pipeline", () => {
    fx.effect(
      "pipes stdout of one command to stdin of another",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write("hello world")').pipe(
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out.toUpperCase()))',
            ),
          ),
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toBe("HELLO WORLD")
      }),
    )

    fx.effect(
      "three-stage pipeline",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write("hello world")').pipe(
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out.toUpperCase()))',
            ),
          ),
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out.replaceAll(" ", "-")))',
            ),
          ),
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toBe("HELLO-WORLD")
      }),
    )

    fx.effect(
      "pipes stderr with { from: 'stderr' }",
      Effect.gen(function* () {
        const handle = yield* js('process.stderr.write("error")').pipe(
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out))',
            ),
            { from: "stderr" },
          ),
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toBe("error")
      }),
    )

    fx.effect(
      "pipes combined output with { from: 'all' }",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write("stdout\\n"); process.stderr.write("stderr\\n")').pipe(
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out))',
            ),
            { from: "all" },
          ),
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toContain("stdout")
        expect(out).toContain("stderr")
      }),
    )
  })

  describe("Windows-specific", () => {
    fx.effect(
      "uses shell routing on Windows",
      Effect.gen(function* () {
        if (process.platform !== "win32") return

        const out = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          svc.string(
            ChildProcess.make("set", ["OPENCODE_TEST_SHELL"], {
              shell: true,
              extendEnv: true,
              env: { OPENCODE_TEST_SHELL: "ok" },
            }),
          ),
        )
        expect(out).toContain("OPENCODE_TEST_SHELL=ok")
      }),
    )

    fx.effect(
      "runs cmd scripts with spaces on Windows without shell",
      Effect.gen(function* () {
        if (process.platform !== "win32") return

        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const dir = path.join(tmp.path, "with space")
        const file = path.join(dir, "echo cmd.cmd")

        yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
        yield* Effect.promise(() => Bun.write(file, "@echo off\r\nif %~1==--stdio exit /b 0\r\nexit /b 7\r\n"))

        const code = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          svc.exitCode(
            ChildProcess.make(file, ["--stdio"], {
              stdin: "pipe",
              stdout: "pipe",
              stderr: "pipe",
            }),
          ),
        )
        expect(code).toBe(ChildProcessSpawner.ExitCode(0))
      }),
    )
  })
})
