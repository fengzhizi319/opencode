import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Flock } from "../../src/util/flock"
import { Hash } from "../../src/util/hash"
import { Process } from "../../src/util/process"
import { Filesystem } from "../../src/util/filesystem"
import { tmpdir } from "../fixture/fixture"

const root = path.join(import.meta.dir, "../..")
const worker = path.join(import.meta.dir, "../fixture/flock-worker.ts")

/**
 * 工作进程消息类型定义
 * 用于在父进程和子进程间传递锁配置
 */
type Msg = {
  key: string          // 锁的唯一标识
  dir: string          // 锁文件存放目录
  staleMs?: number     // 锁过期时间(毫秒)
  timeoutMs?: number   // 获取锁的超时时间
  baseDelayMs?: number // 退避延迟基数
  maxDelayMs?: number  // 最大退避延迟
  holdMs?: number      // 持有锁的时长
  ready?: string       // 就绪信号文件路径
  active?: string      // 活跃状态标记文件
  done?: string        // 完成日志文件
}

/**
 * 根据锁key计算锁文件路径
 * 使用Hash确保文件名安全且唯一
 */
function lock(dir: string, key: string) {
  return path.join(dir, Hash.fast(key) + ".lock")
}

/**
 * 异步睡眠工具函数
 */
function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * 检查文件是否存在
 * 存在返回true,不存在或错误返回false
 */
async function exists(file: string) {
  return fs
    .stat(file)
    .then(() => true)
    .catch(() => false)
}

/**
 * 等待文件出现(轮询检查)
 * @param file - 要等待的文件路径
 * @param timeout - 超时时间(默认3秒)
 * @throws 超时后抛出错误
 */
async function wait(file: string, timeout = 3_000) {
  const stop = Date.now() + timeout
  while (Date.now() < stop) {
    if (await exists(file)) return
    await sleep(20)  // 每20ms检查一次
  }

  throw new Error(`Timed out waiting for file: ${file}`)
}

/**
 * 运行工作进程并等待完成
 * 用于需要获取退出码和输出的场景
 */
function run(msg: Msg) {
  return Process.run([process.execPath, worker, JSON.stringify(msg)], {
    cwd: root,
    nothrow: true,  // 不抛出非零退出码错误
  })
}

/**
 * 生成工作进程(不等待完成)
 * 用于需要并行执行或手动控制的场景
 */
function spawn(msg: Msg) {
  return Process.spawn([process.execPath, worker, JSON.stringify(msg)], {
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
}

/**
 * 测试 Flock 文件锁工具
 * 
 * Flock是一个基于文件系统的分布式锁实现,支持:
 * - 多进程互斥访问
 * - 超时控制
 * - 崩溃恢复(通过心跳检测)
 * - 令牌验证防止误释放
 * 
 * 测试覆盖:
 * - 并发压力测试(16个进程竞争)
 * - 超时处理
 * - 崩溃恢复
 * - 过期锁清理
 * - 令牌安全
 * - 权限错误处理
 */
describe("util.flock", () => {
  /**
   * 测试: 多进程并发下的互斥性
   * 场景: 16个进程同时尝试获取同一个锁
   * 预期:
   *   1. 所有进程都成功执行(退出码为0)
   *   2. 没有stderr错误输出
   *   3. 完成日志有16条记录,证明每个进程都获得了锁
   * 目的: 验证锁的互斥性,确保同一时间只有一个进程持有锁
   * 说明: 这是最核心的功能测试,模拟高并发场景
   */
  test("enforces mutual exclusion under process contention", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const done = path.join(tmp.path, "done.log")  // 记录完成的进程
    const active = path.join(tmp.path, "active")  // 标记当前活跃进程
    const key = "flock:stress"
    const n = 16  // 并发进程数

    // 并行启动16个工作进程,每个都尝试获取同一个锁
    const out = await Promise.all(
      Array.from({ length: n }, () =>
        run({
          key,
          dir,
          done,
          active,
          holdMs: 30,       // 持有锁30ms
          staleMs: 1_000,   // 1秒后视为过期
          timeoutMs: 15_000, // 最多等待15秒
        }),
      ),
    )

    // 验证所有进程都成功完成
    expect(out.map((x) => x.code)).toEqual(Array.from({ length: n }, () => 0))
    // 验证没有错误输出
    expect(out.map((x) => x.stderr.toString()).filter(Boolean)).toEqual([])

    // 验证完成日志有16条,证明互斥性(每个进程都获得了锁)
    const lines = (await fs.readFile(done, "utf8"))
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean)
    expect(lines.length).toBe(n)
  }, 20_000)

  /**
   * 测试: 锁健康时的超时处理
   * 场景: 
   *   1. 启动一个工作进程持有锁20秒(远长于超时时间)
   *   2. 主进程尝试获取同一个锁,但设置1秒超时
   * 预期:
   *   1. 主进程在1秒后超时并抛出错误
   *   2. 错误消息包含"Timed out waiting for lock"
   *   3. onWait回调被多次调用,记录等待过程
   * 目的: 验证当锁仍然有效时,等待方会正确超时而非无限等待
   */
  test("times out while waiting when lock is still healthy", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:timeout"
    const ready = path.join(tmp.path, "ready")  // 工作进程就绪信号
    
    // 启动工作进程,持有锁20秒
    const proc = spawn({
      key,
      dir,
      ready,
      holdMs: 20_000,     // 持有20秒
      staleMs: 10_000,    // 10秒后视为过期
      timeoutMs: 30_000,  // 工作进程自身超时30秒
    })

    try {
      // 等待工作进程就绪(已获取锁)
      await wait(ready, 5_000)
      const seen: string[] = []  // 记录onWait回调
      
      // 主进程尝试获取锁,但只等待1秒
      const err = await Flock.withLock(key, async () => {}, {
        dir,
        staleMs: 10_000,
        timeoutMs: 1_000,  // 仅等待1秒
        onWait: (tick) => {
          seen.push(tick.key)  // 记录每次等待
        },
      }).catch((err) => err)

      // 验证超时错误
      expect(err).toBeInstanceOf(Error)
      if (!(err instanceof Error)) throw err
      expect(err.message).toContain("Timed out waiting for lock")
      // 验证onWait被调用了多次(说明在轮询等待)
      expect(seen.length).toBeGreaterThan(0)
      expect(seen.every((x) => x === key)).toBe(true)
    } finally {
      // 清理工作进程
      await Process.stop(proc).catch(() => undefined)
      await proc.exited.catch(() => undefined)
    }
  }, 15_000)

  /**
   * 测试: 崩溃后的锁恢复
   * 场景:
   *   1. 启动工作进程获取锁并持有很长时间
   *   2. 强制终止工作进程(模拟崩溃)
   *   3. 主进程尝试获取同一个锁
   * 预期:
   *   1. 主进程能成功获取锁(检测到原持有者已崩溃)
   *   2. 回调函数被执行(hit=true)
   * 目的: 验证崩溃恢复机制,通过心跳检测判断锁是否过期
   * 说明: staleMs=500ms,工作进程停止后0.5秒锁被视为过期
   */
  test("recovers after a crashed lock owner", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:crash"
    const ready = path.join(tmp.path, "ready")
    
    // 启动工作进程,持有锁20秒
    const proc = spawn({
      key,
      dir,
      ready,
      holdMs: 20_000,
      staleMs: 500,       // 0.5秒后视为过期(快速检测崩溃)
      timeoutMs: 30_000,
    })

    // 等待工作进程就绪
    await wait(ready, 5_000)
    // 强制终止进程(模拟崩溃)
    await Process.stop(proc)
    await proc.exited.catch(() => undefined)

    let hit = false
    // 主进程尝试获取锁,应该能成功(因为原持有者已崩溃)
    await Flock.withLock(
      key,
      async () => {
        hit = true
      },
      {
        dir,
        staleMs: 500,       // 与 worker 一致
        timeoutMs: 8_000,   // 最多等待8秒
      },
    )

    expect(hit).toBe(true)
  }, 20_000)

  /**
   * 测试: 心跳缺失时的过期锁清理
   * 场景: 手动创建一个过期的锁目录(修改时间为2秒前)
   * 预期: Flock能检测到锁已过期并获取锁
   * 目的: 验证基于文件修改时间的心跳检测机制
   * 说明: 没有心跳文件时,通过目录的mtime判断是否过期
   */
  test("breaks stale lock dirs when heartbeat is missing", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:missing-heartbeat"
    const lockDir = lock(dir, key)

    // 手动创建锁目录
    await fs.mkdir(lockDir, { recursive: true })
    // 将目录时间设置为2秒前(模拟过期)
    const old = new Date(Date.now() - 2_000)
    await fs.utimes(lockDir, old, old)

    let hit = false
    await Flock.withLock(
      key,
      async () => {
        hit = true
      },
      {
        dir,
        staleMs: 200,       // 200ms后视为过期
        timeoutMs: 3_000,
      },
    )

    expect(hit).toBe(true)
  })

  /**
   * 测试: 清理遗留的breaker标记
   * 场景: 
   *   1. 创建锁目录和.breaker子目录
   *   2. 将两者时间都设置为2秒前(模拟崩溃后遗留)
   * 预期:
   *   1. Flock能成功获取锁
   *   2. .breaker目录被清理删除
   * 目的: 验证breaker机制的完整性,breaker用于防止多个进程同时尝试破锁
   */
  test("recovers when a stale breaker claim was left behind", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:stale-breaker"
    const lockDir = lock(dir, key)
    const breaker = lockDir + ".breaker"  // breaker标记目录

    // 创建锁目录和breaker
    await fs.mkdir(lockDir, { recursive: true })
    await fs.mkdir(breaker)

    // 设置为过期
    const old = new Date(Date.now() - 2_000)
    await fs.utimes(lockDir, old, old)
    await fs.utimes(breaker, old, old)

    let hit = false
    await Flock.withLock(
      key,
      async () => {
        hit = true
      },
      {
        dir,
        staleMs: 200,
        timeoutMs: 3_000,
      },
    )

    expect(hit).toBe(true)
    // 验证breaker被清理
    expect(await exists(breaker)).toBe(false)
  })

  /**
   * 测试: 锁目录被删除时的错误处理
   * 场景: 获取锁后,在回调中手动删除锁目录(模拟外部破坏)
   * 预期:
   *   1. 抛出包含"compromised"的错误
   *   2. 之后其他进程能重新获取锁
   * 目的: 验证锁完整性检测,防止静默失效
   */
  test("fails clearly if lock dir is removed while held", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:compromised"
    const lockDir = lock(dir, key)

    // 获取锁并在回调中删除锁目录
    const err = await Flock.withLock(
      key,
      async () => {
        await fs.rm(lockDir, {
          recursive: true,
          force: true,
        })
      },
      {
        dir,
        staleMs: 1_000,
        timeoutMs: 3_000,
      },
    ).catch((err) => err)

    expect(err).toBeInstanceOf(Error)
    if (!(err instanceof Error)) throw err
    expect(err.message).toContain("compromised")

    // 验证之后能重新获取锁
    let hit = false
    await Flock.withLock(
      key,
      async () => {
        hit = true
      },
      {
        dir,
        staleMs: 200,
        timeoutMs: 3_000,
      },
    )
    expect(hit).toBe(true)
  })

  /**
   * 测试: 锁持有期间写入元数据
   * 场景: 获取锁后读取meta.json文件
   * 预期: meta.json包含token、pid、hostname、createdAt字段
   * 目的: 验证锁的元数据记录功能,用于调试和监控
   */
  test("writes owner metadata while lock is held", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:meta"
    const file = path.join(lock(dir, key), "meta.json")

    await Flock.withLock(
      key,
      async () => {
        const json = await Filesystem.readJson<{
          token?: unknown
          pid?: unknown
          hostname?: unknown
          createdAt?: unknown
        }>(file)

        expect(typeof json.token).toBe("string")
        expect(typeof json.pid).toBe("number")
        expect(typeof json.hostname).toBe("string")
        expect(typeof json.createdAt).toBe("string")
      },
      {
        dir,
        staleMs: 1_000,
        timeoutMs: 3_000,
      },
    )
  })

  /**
   * 测试: 使用await using语法获取和释放锁
   * 场景: 使用Bun的Resource Management特性
   * 预期:
   *   1. 块内锁目录存在
   *   2. 块外锁目录被自动清理
   * 目的: 验证现代化的资源管理API,自动释放锁
   */
  test("supports acquire with await using", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:acquire"
    const lockDir = lock(dir, key)

    {
      // 获取锁,离开作用域时自动释放
      await using _ = await Flock.acquire(key, {
        dir,
        staleMs: 1_000,
        timeoutMs: 3_000,
      })
      expect(await exists(lockDir)).toBe(true)  // 锁存在
    }

    expect(await exists(lockDir)).toBe(false)  // 锁已释放
  })

  /**
   * 测试: Token不匹配时的拒绝释放和恢复
   * 场景:
   *   1. 获取锁后篡改meta.json中的token
   *   2. 尝试释放锁(会检测到token不匹配)
   *   3. 等待锁过期后重新获取
   * 预期:
   *   1. 抛出包含"token mismatch"的错误
   *   2. 锁目录仍然存在(未被错误释放)
   *   3. 过期后能重新获取锁
   * 目的: 验证token机制防止误释放,确保只有锁的持有者能释放
   */
  test("refuses token mismatch release and recovers from stale", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:token"
    const lockDir = lock(dir, key)
    const meta = path.join(lockDir, "meta.json")

    // 获取锁并篡改token
    const err = await Flock.withLock(
      key,
      async () => {
        const json = await Filesystem.readJson<{ token?: string }>(meta)
        json.token = "tampered"  // 篡改token
        await fs.writeFile(meta, JSON.stringify(json, null, 2))
      },
      {
        dir,
        staleMs: 500,
        timeoutMs: 3_000,
      },
    ).catch((err) => err)

    expect(err).toBeInstanceOf(Error)
    if (!(err instanceof Error)) throw err
    expect(err.message).toContain("token mismatch")
    expect(await exists(lockDir)).toBe(true)  // 锁仍存在

    // 等待过期后重新获取
    let hit = false
    await Flock.withLock(
      key,
      async () => {
        hit = true
      },
      {
        dir,
        staleMs: 500,
        timeoutMs: 6_000,
      },
    )
    expect(hit).toBe(true)
  })

  /**
   * 测试: 不可写的锁目录错误处理
   * 场景: 将锁目录权限设置为只读(0o500)
   * 预期: 抛出EACCES或EPERM错误
   * 目的: 验证权限错误的清晰报告
   * 说明: Windows上chmod是no-op,所以跳过此测试
   */
  test("fails clearly on unwritable lock roots", async () => {
    if (process.platform === "win32") return

    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:perm"

    await fs.mkdir(dir, { recursive: true })
    await fs.chmod(dir, 0o500)  // 只读权限

    try {
      const err = await Flock.withLock(key, async () => {}, {
        dir,
        staleMs: 100,
        timeoutMs: 500,
      }).catch((err) => err)

      expect(err).toBeInstanceOf(Error)
      if (!(err instanceof Error)) throw err
      const text = err.message
      // 验证是权限错误
      expect(text.includes("EACCES") || text.includes("EPERM")).toBe(true)
    } finally {
      // 恢复权限以便清理
      await fs.chmod(dir, 0o700)
    }
  })
})
