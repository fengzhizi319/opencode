// 导入测试框架和必要的模块
import { describe, test, expect, afterEach } from "bun:test"
import path from "path"
import fs from "fs/promises"  // Node.js 文件系统模块
import { FileTime } from "../../src/file/time"  // 文件时间戳追踪模块
import { Instance } from "../../src/project/instance"  // 项目实例管理
import { SessionID } from "../../src/session/schema"  // 会话 ID 类型
import { Filesystem } from "../../src/util/filesystem"  // 文件系统工具
import { tmpdir } from "../fixture/fixture"  // 临时目录工具

/**
 * 清理钩子：每个测试用例执行后销毁所有实例
 * 
 * 目的：确保测试之间互不干扰，每个测试都从干净的状态开始
 */
afterEach(async () => {
  await Instance.disposeAll()
})

/**
 * 辅助函数：设置文件的访问时间和修改时间
 * 
 * @param file - 文件路径
 * @param time - 时间戳（毫秒）
 * 
 * 作用：
 * - 使用 fs.utimes 设置文件的 atime 和 mtime
 * - 用于模拟文件被修改的场景
 * 
 * 示例：
 * ```ts
 * await touch(filepath, 1000)  // 设置时间为 1970-01-01T00:00:01.000Z
 * ```
 */
async function touch(file: string, time: number) {
  const date = new Date(time)
  await fs.utimes(file, date, date)
}

/**
 * 辅助函数：创建门闩（Gate）同步原语
 * 
 * 作用：
 * - 用于控制异步操作的执行顺序
 * - 提供一个 wait Promise，直到 open() 被调用才 resolve
 * 
 * 返回值：
 * - open: 函数，调用后解除等待
 * - wait: Promise，等待被解除
 * 
 * 应用场景：
 * - 测试并发控制的执行顺序
 * - 确保某个操作在另一个操作之后执行
 * 
 * 示例：
 * ```ts
 * const gate = gate()
 * // 异步操作 1
 * gate.open()  // 解除等待
 * // 异步操作 2
 * await gate.wait  // 等待解除
 * ```
 */
function gate() {
  let open!: () => void
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, wait }
}

/**
 * 测试套件：file/time
 * 
 * FileTime 的作用：
 * - 追踪文件的读取时间戳，防止 AI Agent 覆盖未读取的文件
 * - 提供文件锁机制，确保并发安全的文件操作
 * - 按会话（Session）和目录隔离状态
 * 
 * 核心功能：
 * 1. read(sessionID, file) - 记录文件被读取的时间
 * 2. get(sessionID, file) - 获取文件的最后读取时间
 * 3. assert(sessionID, filepath) - 验证文件自读取后未被修改
 * 4. withLock(filepath, fn) - 在文件锁内执行函数
 * 
 * 应用场景：
 * - AI Agent 在修改文件前必须先读取
 * - 检测文件是否被外部修改，避免覆盖用户的更改
 * - 确保并发文件操作的原子性
 */
describe("file/time", () => {
  // 创建测试用的会话 ID
  const sessionID = SessionID.make("ses_00000000000000000000000001")

  /**
   * 测试组 1：read() 和 get() 方法
   * 
   * 验证文件读取时间戳的存储和检索功能：
   * - 记录文件被读取的时间
   * - 按会话隔离时间戳
   * - 更新后续读取的时间戳
   * - 按目录隔离状态
   */
  describe("read() and get()", () => {
    /**
     * 测试用例 1.1：验证存储读取时间戳
     * 
     * 场景：
     * - 创建文件
     * - 调用 FileTime.read() 记录读取时间
     * - 调用 FileTime.get() 获取读取时间
     * 
     * 预期结果：
     * - 读取前 get() 返回 undefined
     * - 读取后 get() 返回 Date 对象
     * - 时间戳大于 0
     */
    test("stores read timestamp", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "file.txt")
      await fs.writeFile(filepath, "content", "utf-8")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // 读取前应该没有记录
          const before = await FileTime.get(sessionID, filepath)
          expect(before).toBeUndefined()

          // 记录读取时间
          await FileTime.read(sessionID, filepath)

          // 读取后应该有记录
          const after = await FileTime.get(sessionID, filepath)
          expect(after).toBeInstanceOf(Date)
          expect(after!.getTime()).toBeGreaterThan(0)
        },
      })
    })

    /**
     * 测试用例 1.2：验证按会话隔离时间戳
     * 
     * 场景：
     * - 两个不同的会话读取同一个文件
     * - 每个会话应该有独立的时间戳记录
     * 
     * 预期结果：
     * - 两个会话都有各自的时间戳
     */
    test("tracks separate timestamps per session", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "file.txt")
      await fs.writeFile(filepath, "content", "utf-8")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // 会话 2 读取文件
          await FileTime.read(SessionID.make("ses_00000000000000000000000002"), filepath)
          // 会话 3 读取文件
          await FileTime.read(SessionID.make("ses_00000000000000000000000003"), filepath)

          // 获取两个会话的时间戳
          const time1 = await FileTime.get(SessionID.make("ses_00000000000000000000000002"), filepath)
          const time2 = await FileTime.get(SessionID.make("ses_00000000000000000000000003"), filepath)

          // 验证：两个会话都有记录
          expect(time1).toBeDefined()
          expect(time2).toBeDefined()
        },
      })
    })

    /**
     * 测试用例 1.3：验证后续读取更新时间戳
     * 
     * 场景：
     * - 第一次读取文件，记录时间戳
     * - 第二次读取文件，应该更新为新的时间戳
     * 
     * 预期结果：
     * - 第二次的时间戳 >= 第一次的时间戳
     */
    test("updates timestamp on subsequent reads", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "file.txt")
      await fs.writeFile(filepath, "content", "utf-8")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // 第一次读取
          await FileTime.read(sessionID, filepath)
          const first = await FileTime.get(sessionID, filepath)

          // 第二次读取
          await FileTime.read(sessionID, filepath)
          const second = await FileTime.get(sessionID, filepath)

          // 验证：第二次的时间戳 >= 第一次
          expect(second!.getTime()).toBeGreaterThanOrEqual(first!.getTime())
        },
      })
    })

    /**
     * 测试用例 1.4：验证按目录隔离读取记录
     * 
     * 场景：
     * - 创建三个临时目录：one、two、shared
     * - 在 shared 目录中创建文件
     * - 在 one 目录上下文中读取文件
     * - 在 two 目录上下文中检查，应该没有记录
     * 
     * 关键点：
     * - FileTime 使用 InstanceState 按目录隔离状态
     * - 即使文件路径相同，不同目录的实例也有独立的状态
     * 
     * 预期结果：
     * - two 目录中 get() 返回 undefined
     */
    test("isolates reads by directory", async () => {
      await using one = await tmpdir()
      await using two = await tmpdir()
      await using shared = await tmpdir()
      const filepath = path.join(shared.path, "file.txt")
      await fs.writeFile(filepath, "content", "utf-8")

      // 在 one 目录上下文中读取文件
      await Instance.provide({
        directory: one.path,
        fn: async () => {
          await FileTime.read(sessionID, filepath)
        },
      })

      // 在 two 目录上下文中检查，应该没有记录
      await Instance.provide({
        directory: two.path,
        fn: async () => {
          expect(await FileTime.get(sessionID, filepath)).toBeUndefined()
        },
      })
    })
  })

  /**
   * 测试组 2：assert() 方法
   * 
   * 验证文件修改检测功能：
   * - 文件未被修改时通过
   * - 未读取就断言时抛出错误
   * - 文件被修改后抛出错误
   * - 错误消息包含时间戳信息
   */
  describe("assert()", () => {
    /**
     * 测试用例 2.1：验证文件未被修改时通过
     * 
     * 场景：
     * - 创建文件并设置修改时间为 1000ms
     * - 读取文件，记录读取时间
     * - 调用 assert()，文件未被修改
     * 
     * 预期结果：
     * - assert() 不抛出错误
     */
    test("passes when file has not been modified", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "file.txt")
      await fs.writeFile(filepath, "content", "utf-8")
      await touch(filepath, 1_000)  // 设置修改时间

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await FileTime.read(sessionID, filepath)  // 读取文件
          await FileTime.assert(sessionID, filepath)  // 应该通过
        },
      })
    })

    /**
     * 测试用例 2.2：验证未读取就断言时抛出错误
     * 
     * 场景：
     * - 创建文件但不读取
     * - 直接调用 assert()
     * 
     * 预期结果：
     * - 抛出错误，消息包含 "You must read file"
     */
    test("throws when file was not read first", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "file.txt")
      await fs.writeFile(filepath, "content", "utf-8")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // 未读取就断言，应该抛出错误
          await expect(FileTime.assert(sessionID, filepath)).rejects.toThrow("You must read file")
        },
      })
    })

    /**
     * 测试用例 2.3：验证文件被修改后抛出错误
     * 
     * 场景：
     * - 创建文件并设置修改时间为 1000ms
     * - 读取文件，记录读取时间
     * - 修改文件内容并设置新的修改时间为 2000ms
     * - 调用 assert()
     * 
     * 预期结果：
     * - 抛出错误，消息包含 "modified since it was last read"
     */
    test("throws when file was modified after read", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "file.txt")
      await fs.writeFile(filepath, "content", "utf-8")
      await touch(filepath, 1_000)  // 设置初始修改时间

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await FileTime.read(sessionID, filepath)  // 读取文件
          await fs.writeFile(filepath, "modified content", "utf-8")  // 修改内容
          await touch(filepath, 2_000)  // 设置新的修改时间
          // 应该检测到修改并抛出错误
          await expect(FileTime.assert(sessionID, filepath)).rejects.toThrow("modified since it was last read")
        },
      })
    })

    test("includes timestamps in error message", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "file.txt")
      await fs.writeFile(filepath, "content", "utf-8")
      await touch(filepath, 1_000)

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await FileTime.read(sessionID, filepath)
          await fs.writeFile(filepath, "modified", "utf-8")
          await touch(filepath, 2_000)

          let error: Error | undefined
          try {
            await FileTime.assert(sessionID, filepath)
          } catch (e) {
            error = e as Error
          }
          expect(error).toBeDefined()
          expect(error!.message).toContain("Last modification:")
          expect(error!.message).toContain("Last read:")
        },
      })
    })
  })

  /**
   * 测试组 3：withLock() 方法
   * 
   * 验证文件锁机制：
   * - 在锁内执行函数
   * - 返回函数结果
   * - 序列化同一文件的并发操作
   * - 允许不同文件的并发操作
   * - 即使函数抛出错误也释放锁
   */
  describe("withLock()", () => {
    /**
     * 测试用例 3.1：验证在锁内执行函数
     * 
     * 场景：
     * - 调用 withLock 执行异步函数
     * - 函数内部设置标志位
     * 
     * 预期结果：
     * - 函数被执行，标志位为 true
     */
    test("executes function within lock", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "file.txt")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          let executed = false
          await FileTime.withLock(filepath, async () => {
            executed = true
            return "result"
          })
          expect(executed).toBe(true)
        },
      })
    })

    /**
     * 测试用例 3.2：验证返回函数结果
     * 
     * 场景：
     * - withLock 执行函数并返回结果
     * 
     * 预期结果：
     * - 返回值为 "success"
     */
    test("returns function result", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "file.txt")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const result = await FileTime.withLock(filepath, async () => {
            return "success"
          })
          expect(result).toBe("success")
        },
      })
    })

    /**
     * 测试用例 3.3：验证同一文件的并发操作被序列化
     * 
     * 场景：
     * - 启动 op1，获取锁后等待 hold gate
     * - op1 记录顺序 [1]，打开 ready gate，然后等待 hold
     * - 等待 ready 后启动 op2，尝试获取同一个文件的锁
     * - op2 应该被阻塞，直到 op1 释放锁
     * - 打开 hold，op1 继续执行并记录 [2]，然后释放锁
     * - op2 获取锁后执行，记录 [3, 4]
     * 
     * 关键点：
     * - 使用 Semaphore 实现互斥锁
     * - 同一时间只有一个操作可以持有锁
     * 
     * 预期结果：
     * - order = [1, 2, 3, 4]（严格串行）
     */
    test("serializes concurrent operations on same file", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "file.txt")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const order: number[] = []  // 记录执行顺序
          const hold = gate()  // 控制 op1 何时完成
          const ready = gate()  // 通知 op1 已启动

          // 操作 1：获取锁，记录 1，通知 ready，等待 hold，记录 2
          const op1 = FileTime.withLock(filepath, async () => {
            order.push(1)
            ready.open()  // 通知 op1 已开始
            await hold.wait  // 等待 hold 被打开
            order.push(2)
          })

          // 等待 op1 启动
          await ready.wait

          // 操作 2：尝试获取同一个文件的锁，应该被阻塞
          const op2 = FileTime.withLock(filepath, async () => {
            order.push(3)
            order.push(4)
          })

          // 打开 hold，让 op1 完成
          hold.open()

          // 等待两个操作都完成
          await Promise.all([op1, op2])
          // 验证：严格的串行执行顺序
          expect(order).toEqual([1, 2, 3, 4])
        },
      })
    })

    /**
     * 测试用例 3.4：验证不同文件的并发操作可以并行
     * 
     * 场景：
     * - 启动 op1，获取 filepath1 的锁
     * - op1 设置 started1 = true，打开 ready gate，等待 hold
     * - 等待 ready 后启动 op2，获取 filepath2 的锁（不同文件）
     * - op2 应该立即执行（不阻塞），设置 started2 = true，打开 hold
     * - op1 收到 hold 信号后检查 started2 是否为 true
     * 
     * 关键点：
     * - 不同文件有不同的锁
     * - 锁之间互不影响，可以并发执行
     * 
     * 预期结果：
     * - started1 和 started2 都为 true
     * - op1 中可以看到 started2 已经为 true（证明并发执行）
     */
    test("allows concurrent operations on different files", async () => {
      await using tmp = await tmpdir()
      const filepath1 = path.join(tmp.path, "file1.txt")
      const filepath2 = path.join(tmp.path, "file2.txt")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          let started1 = false
          let started2 = false
          const hold = gate()
          const ready = gate()

          // 操作 1：获取 filepath1 的锁
          const op1 = FileTime.withLock(filepath1, async () => {
            started1 = true
            ready.open()  // 通知 op1 已开始
            await hold.wait  // 等待 hold
            // 此时 op2 应该已经执行了
            expect(started2).toBe(true)
          })

          // 等待 op1 启动
          await ready.wait

          // 操作 2：获取 filepath2 的锁（不同文件，不应该被阻塞）
          const op2 = FileTime.withLock(filepath2, async () => {
            started2 = true
            hold.open()  // 解除 op1 的等待
          })

          // 等待两个操作都完成
          await Promise.all([op1, op2])
          expect(started1).toBe(true)
          expect(started2).toBe(true)
        },
      })
    })

    /**
     * 测试用例 3.5：验证函数抛出错误时仍然释放锁
     * 
     * 场景：
     * - 调用 withLock，函数内部抛出错误
     * - 捕获错误并验证
     * - 再次调用 withLock，应该能成功获取锁
     * 
     * 关键点：
     * - 使用 try-finally 或 Effect.bracket 确保锁释放
     * - 即使发生异常，锁也必须被释放
     * 
     * 预期结果：
     * - 第一次调用抛出 "Test error"
     * - 第二次调用成功执行
     */
    test("releases lock even if function throws", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "file.txt")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // 第一次调用：函数抛出错误
          await expect(
            FileTime.withLock(filepath, async () => {
              throw new Error("Test error")
            }),
          ).rejects.toThrow("Test error")

          // 第二次调用：应该能成功获取锁
          let executed = false
          await FileTime.withLock(filepath, async () => {
            executed = true
          })
          expect(executed).toBe(true)
        },
      })
    })
  })

  /**
   * 测试组 4：stat() Filesystem.stat 模式
   * 
   * 验证通过 Filesystem.stat() 读取文件修改时间的功能：
   * - 使用 Filesystem.stat() 获取文件的 mtime
   * - 检测文件是否被修改（通过比较 mtime）
   */
  describe("stat() Filesystem.stat pattern", () => {
    /**
     * 测试用例 4.1：验证通过 Filesystem.stat() 读取文件修改时间
     * 
     * 场景：
     * - 创建文件并设置修改时间为 1000ms
     * - 读取文件，记录读取时间
     * - 调用 Filesystem.stat() 获取文件统计信息
     * - 调用 assert() 验证文件未被修改
     * 
     * 关键点：
     * - FileTime.read() 内部使用 Filesystem.stat() 获取 mtime
     * - assert() 会比较当前的 mtime 和记录的 mtime
     * 
     * 预期结果：
     * - stats.mtime 是 Date 对象
     * - assert() 不抛出错误（文件未被修改）
     */
    test("reads file modification time via Filesystem.stat()", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "file.txt")
      await fs.writeFile(filepath, "content", "utf-8")
      await touch(filepath, 1_000)  // 设置修改时间

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await FileTime.read(sessionID, filepath)  // 读取文件

          // 获取文件统计信息
          const stats = Filesystem.stat(filepath)
          expect(stats?.mtime).toBeInstanceOf(Date)
          expect(stats!.mtime.getTime()).toBeGreaterThan(0)

          // 验证文件未被修改
          await FileTime.assert(sessionID, filepath)
        },
      })
    })

    /**
     * 测试用例 4.2：验证通过 stat mtime 检测文件修改
     * 
     * 场景：
     * - 创建文件并设置修改时间为 1000ms
     * - 读取文件，记录初始状态
     * - 获取初始的 stat 信息
     * - 修改文件内容并设置新的修改时间为 2000ms
     * - 获取新的 stat 信息
     * - 调用 assert() 应该检测到修改
     * 
     * 关键点：
     * - FileTime 通过比较 mtime、ctime、size 来检测修改
     * - 任何一项变化都会触发错误
     * 
     * 预期结果：
     * - newStat.mtime > originalStat.mtime
     * - assert() 抛出错误
     */
    test("detects modification via stat mtime", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "file.txt")
      await fs.writeFile(filepath, "original", "utf-8")
      await touch(filepath, 1_000)  // 设置初始修改时间

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await FileTime.read(sessionID, filepath)  // 读取文件

          // 获取初始 stat 信息
          const originalStat = Filesystem.stat(filepath)

          // 修改文件
          await fs.writeFile(filepath, "modified", "utf-8")
          await touch(filepath, 2_000)  // 设置新的修改时间

          // 获取新的 stat 信息
          const newStat = Filesystem.stat(filepath)
          expect(newStat!.mtime.getTime()).toBeGreaterThan(originalStat!.mtime.getTime())

          // 应该检测到修改并抛出错误
          await expect(FileTime.assert(sessionID, filepath)).rejects.toThrow()
        },
      })
    })
  })
})
