import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { File } from "@/file"
import { Instance } from "@/project/instance.ts"
import { tmpdir } from "../fixture/fixture"

// 仅在 Windows 平台运行测试，其他平台跳过
const wintest = process.platform === "win32" ? test : test.skip

describe("file fsmonitor", () => {
  /**
   * 测试：执行只读 git 状态检查时不应启动 fsmonitor 守护进程
   *
   * 目的：验证 File.status() 方法在执行 git 状态查询时，不会意外触发 git fsmonitor 守护进程的启动。
   * fsmonitor 是 git 的文件系统监控功能，在某些场景下可能会带来性能开销或副作用，
   * 因此需要确保只读操作不会激活它。
   */
  wintest("status does not start fsmonitor for readonly git checks", async () => {
    // 创建临时目录并初始化为 git 仓库
    await using tmp = await tmpdir({ git: true })
    const target = path.join(tmp.path, "tracked.txt")

    // 创建被追踪的文件并提交到 git
    await fs.writeFile(target, "base\n")
    await $`git add tracked.txt`.cwd(tmp.path).quiet()
    await $`git commit -m init`.cwd(tmp.path).quiet()

    // 启用 git fsmonitor 配置，但显式停止守护进程
    await $`git config core.fsmonitor true`.cwd(tmp.path).quiet()
    await $`git fsmonitor--daemon stop`.cwd(tmp.path).quiet().nothrow()

    // 修改已追踪文件并创建新文件（模拟工作区变更）
    await fs.writeFile(target, "next\n")
    await fs.writeFile(path.join(tmp.path, "new.txt"), "new\n")

    // 验证测试前 fsmonitor 守护进程未运行（退出码非 0 表示未运行）
    const before = await $`git fsmonitor--daemon status`.cwd(tmp.path).quiet().nothrow()
    expect(before.exitCode).not.toBe(0)

    // 在 Instance 上下文中执行 File.status()，该方法会查询 git 状态
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await File.status()
      },
    })

    // 验证执行 File.status() 后 fsmonitor 守护进程仍未启动
    const after = await $`git fsmonitor--daemon status`.cwd(tmp.path).quiet().nothrow()
    expect(after.exitCode).not.toBe(0)
  })

  /**
   * 测试：读取文件内容时不应启动 fsmonitor 守护进程
   *
   * 目的：验证 File.read() 方法在获取文件差异信息时，不会触发 git fsmonitor 守护进程的启动。
   * 即使文件有未提交的变更，只读操作也应该保持轻量级，不激活后台监控服务。
   */
  wintest("read does not start fsmonitor for git diffs", async () => {
    // 创建临时目录并初始化为 git 仓库
    await using tmp = await tmpdir({ git: true })
    const target = path.join(tmp.path, "tracked.txt")

    // 创建被追踪的文件并提交到 git
    await fs.writeFile(target, "base\n")
    await $`git add tracked.txt`.cwd(tmp.path).quiet()
    await $`git commit -m init`.cwd(tmp.path).quiet()

    // 启用 git fsmonitor 配置，但显式停止守护进程
    await $`git config core.fsmonitor true`.cwd(tmp.path).quiet()
    await $`git fsmonitor--daemon stop`.cwd(tmp.path).quiet().nothrow()

    // 修改已追踪文件（制造工作区与 HEAD 的差异）
    await fs.writeFile(target, "next\n")

    // 验证测试前 fsmonitor 守护进程未运行
    const before = await $`git fsmonitor--daemon status`.cwd(tmp.path).quiet().nothrow()
    expect(before.exitCode).not.toBe(0)

    // 在 Instance 上下文中执行 File.read()，该方法可能需要获取 git diff 信息
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await File.read("tracked.txt")
      },
    })

    // 验证执行 File.read() 后 fsmonitor 守护进程仍未启动
    const after = await $`git fsmonitor--daemon status`.cwd(tmp.path).quiet().nothrow()
    expect(after.exitCode).not.toBe(0)
  })
})
