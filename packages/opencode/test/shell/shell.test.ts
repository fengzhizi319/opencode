// 导入 Bun 测试框架的描述、期望和测试函数
import { describe, expect, test } from "bun:test"
// 导入路径处理模块
import path from "path"
// 导入 Shell 模块，用于检测和选择系统 Shell
import { Shell } from "../../src/shell/shell"
// 导入文件系统工具，用于路径转换等操作
import { Filesystem } from "../../src/util/filesystem"
/**
 * Shell 命名空间负责检测和选择合适的系统 Shell，用于在 TUI 中执行命令。它的核心功能包括：
 Shell 模块
 ├── 名称规范化 (name)
 │   └── 从路径提取 shell 名称：/bin/bash → bash
 ├── 类型检测
 │   ├── login() - 是否支持 login 模式
 │   └── posix() - 是否 POSIX 兼容
 ├── Shell 选择
 │   ├── preferred() - 首选 Shell（尊重用户配置）
 │   └── acceptable() - 可接受的 Shell（过滤黑名单）
 └── 平台适配
 ├── Windows: Git Bash, PowerShell, cmd.exe
 ├── macOS: zsh (默认)
 */

/**
 * withShell 辅助函数：临时设置 SHELL 环境变量并执行测试
 *
 * 这是一个测试工具函数，用于在隔离的环境中测试 Shell 检测逻辑。
 * 它会：
 * 1. 保存当前的 SHELL 环境变量
 * 2. 设置新的 SHELL 值（或清除它）
 * 3. 重置 Shell 模块的缓存（acceptable 和 preferred）
 * 4. 执行测试函数
 * 5. 恢复原始的环境变量和缓存状态
 *
 * @param shell - 要设置的 SHELL 环境变量值（undefined 表示清除）
 * @param fn - 要执行的测试函数
 * @returns Promise<void>
 *
 * 为什么需要这个函数？
 * - Shell.preferred 和 Shell.acceptable 使用 lazy 缓存，一旦计算就不会重新计算
 * - 测试不同的 SHELL 配置时需要清除缓存才能看到新结果
 * - 必须确保测试之间不会相互污染环境变量
 */
const withShell = async (shell: string | undefined, fn: () => void | Promise<void>) => {
  // 1. 保存当前的 SHELL 环境变量值
  const prev = process.env.SHELL

  // 2. 设置新的 SHELL 值或清除它
  if (shell === undefined) delete process.env.SHELL
  else process.env.SHELL = shell

  // 3. 重置 Shell 模块的懒加载缓存
  //    这样下次访问时会重新计算，而不是使用旧缓存
  Shell.acceptable.reset()
  Shell.preferred.reset()

  try {
    // 4. 执行测试函数
    await fn()
  } finally {
    // 5. 清理：恢复原始的环境变量
    if (prev === undefined) delete process.env.SHELL
    else process.env.SHELL = prev

    // 6. 再次重置缓存，确保不影响其他测试
    Shell.acceptable.reset()
    Shell.preferred.reset()
  }
}

/**
 * 测试套件：Shell 模块功能测试
 *
 * 验证 Shell 命名空间中的各种工具函数是否正确工作，包括：
 * - Shell 名称规范化
 * - Login shell 检测
 * - POSIX shell 检测
 * - Windows 平台的特殊处理（黑名单、Git Bash、PowerShell 等）
 */
describe("shell", () => {
  /**
   * 测试：规范化 Shell 名称
   *
   * 验证 Shell.name() 能够从完整路径中提取出简洁的 shell 名称。
   * 这对于比较和识别 shell 类型非常重要。
   *
   * 示例：
   * - "/bin/bash" → "bash"
   * - "C:/tools/NU.EXE" → "nu" (Windows)
   */
  test("normalizes shell names", () => {
    // Unix/macOS：从完整路径提取 basename
    expect(Shell.name("/bin/bash")).toBe("bash")

    // Windows 平台特定测试
    if (process.platform === "win32") {
      // 验证大小写不敏感（NU.EXE → nu）
      expect(Shell.name("C:/tools/NU.EXE")).toBe("nu")
      // 验证 PowerShell 核心版（pwsh）
      expect(Shell.name("C:/tools/PWSH.EXE")).toBe("pwsh")
    }
  })

  /**
   * 测试：检测 Login Shell
   *
   * Login shell 是指以 "-" 前缀启动的 shell（如 "-bash"），
   * 它会读取额外的配置文件（如 .bash_profile、.zprofile）。
   *
   * Shell.login() 根据 shell 名称判断是否支持 login 模式。
   *
   * 支持的 login shells：bash, dash, fish, ksh, sh, zsh
   */
  test("detects login shells", () => {
    // bash 是典型的 login shell
    expect(Shell.login("/bin/bash")).toBe(true)

    // PowerShell 不支持传统的 login shell 模式
    expect(Shell.login("C:/tools/pwsh.exe")).toBe(false)
  })

  /**
   * 测试：检测 POSIX Shell
   *
   * POSIX shell 遵循 POSIX 标准的 shell，具有兼容的语法和行为。
   * 这对于确定可以使用哪些 shell 特性很重要。
   *
   * 支持的 POSIX shells：bash, dash, ksh, sh, zsh
   * 不支持：fish, PowerShell, Nushell
   */
  test("detects posix shells", () => {
    // bash 是 POSIX 兼容的
    expect(Shell.posix("/bin/bash")).toBe(true)

    // fish 不是 POSIX 兼容的（有自己的语法）
    expect(Shell.posix("/bin/fish")).toBe(false)

    // PowerShell 不是 POSIX shell
    expect(Shell.posix("C:/tools/pwsh.exe")).toBe(false)
  })

  // Windows 平台特定的测试
  if (process.platform === "win32") {
    /**
     * 测试：拒绝黑名单中的 Shell（大小写不敏感）
     *
     * 某些 shell（如 fish 和 nushell）在 Windows 上可能存在兼容性问题，
     * 因此被加入黑名单。即使 SHELL 环境变量设置为它们，
     * Shell.acceptable() 也应该返回其他可用的 shell。
     *
     * 黑名单：fish, nu (nushell)
     */
    test("rejects blacklisted shells case-insensitively", async () => {
      // 临时设置 SHELL 为 NU.EXE（nushell）
      await withShell("NU.EXE", async () => {
        // 验证 acceptable() 返回的 shell 名称不是 "nu"
        // 说明黑名单生效了
        expect(Shell.name(Shell.acceptable())).not.toBe("nu")
      })
    })

    /**
     * 测试：规范化 Git Bash 路径
     *
     * 在 Windows 上，Git Bash 可能使用 Cygwin 风格的路径
     * （如 /cygdrive/c/...），需要转换为 Windows 原生路径
     * （如 C:\...）。
     *
     * 这确保了 OpenCode 能够正确调用 Git Bash。
     */
    test("normalizes Git Bash shell paths from env", async () => {
      // Cygwin 风格的 Git Bash 路径
      const shell = "/cygdrive/c/Program Files/Git/bin/bash.exe"

      await withShell(shell, async () => {
        // 验证 preferred() 返回的是转换后的 Windows 路径
        expect(Shell.preferred()).toBe(Filesystem.windowsPath(shell))
      })
    })

    /**
     * 测试：将 /usr/bin/bash 解析为 Git Bash
     *
     * 在某些 Windows 环境（如 WSL 或 MSYS2）中，SHELL 可能被设置为
     * Unix 风格的路径 /usr/bin/bash。系统应该能够将其映射到
     * 实际的 Git Bash 可执行文件。
     */
    test("resolves /usr/bin/bash from env to Git Bash", async () => {
      // 获取系统中实际的 Git Bash 路径
      const bash = Shell.gitbash()
      if (!bash) return  // 如果没有安装 Git Bash，跳过测试

      await withShell("/usr/bin/bash", async () => {
        // 验证 acceptable() 返回 Git Bash 路径
        expect(Shell.acceptable()).toBe(bash)
        // 验证 preferred() 也返回 Git Bash 路径
        expect(Shell.preferred()).toBe(bash)
      })
    })

    /**
     * 测试：解析裸 PowerShell 名称
     *
     * 当 SHELL 环境变量只包含文件名（如 "pwsh" 或 "powershell"）
     * 而没有完整路径时，系统应该能够通过 which 命令找到实际的可执行文件。
     */
    test("resolves bare PowerShell shells", async () => {
      // 查找系统中的 PowerShell 可执行文件
      // pwsh = PowerShell Core (跨平台)
      // powershell = Windows PowerShell (传统版)
      const shell = Bun.which("pwsh") || Bun.which("powershell")
      if (!shell) return  // 如果没有安装 PowerShell，跳过测试

      // 只传递文件名（不带路径）
      await withShell(path.win32.basename(shell), async () => {
        // 验证 preferred() 能够解析出完整路径
        expect(Shell.preferred()).toBe(shell)
      })
    })
  }
})
