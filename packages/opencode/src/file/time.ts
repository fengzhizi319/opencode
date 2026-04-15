import { DateTime, Effect, Layer, Semaphore, ServiceMap } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { Flag } from "@/flag/flag"
import type { SessionID } from "@/session/schema"
import { Filesystem } from "../util/filesystem"
import { Log } from "../util/log"

/**
 * 文件时间戳追踪命名空间
 *
 * 提供文件读取时间追踪和并发控制功能，主要用于：
 * 1. 记录每个会话（Session）中文件的读取时间戳
 * 2. 在写入前验证文件是否被外部修改（防止覆盖未读取的变更）
 * 3. 提供基于文件路径的互斥锁，确保并发写入安全
 *
 * 核心设计思想：AI 助手在修改文件前必须先读取，通过对比读取时的时间戳和当前时间戳，
 * 检测文件是否在读取后被外部修改，从而避免意外覆盖用户的更改。
 */
export namespace FileTime {
  const log = Log.create({ service: "file.time" })

  /**
   * 文件时间戳快照类型
   *
   * 记录文件在某个时间点的状态信息，用于后续的变更检测
   */
  export type Stamp = {
    /** 读取操作发生的时间 */
    readonly read: Date
    /** 文件最后修改时间（毫秒时间戳） */
    readonly mtime: number | undefined
    /** 文件状态最后改变时间（毫秒时间戳），包括权限、所有者等元数据变更 */
    readonly ctime: number | undefined
    /** 文件大小（字节） */
    readonly size: number | undefined
  }

  /**
   * 创建文件时间戳快照
   *
   * 获取文件的 stat 信息并转换为标准化的 Stamp 对象
   * 使用 Effect.fnUntraced 避免在错误堆栈中显示此内部函数
   *
   * @param file - 文件路径
   * @returns 包含读取时间和文件状态的 Stamp 对象
   */
  const stamp = Effect.fnUntraced(function* (file: string) {
    // 获取文件系统 stat 信息
    const stat = Filesystem.stat(file)
    // 处理 bigint 类型的 size（Node.js 在某些平台返回 bigint）
    const size = typeof stat?.size === "bigint" ? Number(stat.size) : stat?.size
    return {
      read: yield* DateTime.nowAsDate,
      mtime: stat?.mtime?.getTime(),
      ctime: stat?.ctime?.getTime(),
      size,
    }
  })

  /**
   * 获取或创建会话的文件读取记录 Map
   *
   * 采用懒加载策略：首次访问某个 sessionID 时创建对应的 Map
   *
   * @param reads - 所有会话的读取记录集合
   * @param sessionID - 会话 ID
   * @returns 该会话的文件读取记录 Map
   */
  const session = (reads: Map<SessionID, Map<string, Stamp>>, sessionID: SessionID) => {
    const value = reads.get(sessionID)
    if (value) return value

    const next = new Map<string, Stamp>()
    reads.set(sessionID, next)
    return next
  }

  /**
   * 服务内部状态类型
   *
   * 存储所有会话的文件读取记录和文件级别的互斥锁
   */
  interface State {
    /** 嵌套 Map：SessionID -> (文件路径 -> 时间戳快照) */
    reads: Map<SessionID, Map<string, Stamp>>
    /** 文件路径到信号量的映射，用于实现文件级互斥锁 */
    locks: Map<string, Semaphore.Semaphore>
  }

  /**
   * FileTime 服务接口定义
   *
   * 提供文件时间戳追踪和并发控制的核心功能
   */
  export interface Interface {
    /**
     * 记录文件读取事件
     *
     * 在 AI 助手读取文件时调用，保存当前时间戳和文件状态
     *
     * @param sessionID - 会话 ID
     * @param file - 被读取的文件路径
     */
    readonly read: (sessionID: SessionID, file: string) => Effect.Effect<void>

    /**
     * 获取文件上次读取的时间
     *
     * @param sessionID - 会话 ID
     * @param file - 文件路径
     * @returns 读取时间，如果未读取过则返回 undefined
     */
    readonly get: (sessionID: SessionID, file: string) => Effect.Effect<Date | undefined>

    /**
     * 断言文件自上次读取后未被修改
     *
     * 在 AI 助手写入文件前调用，验证文件是否被外部修改。
     * 如果文件已被修改或未先读取就尝试写入，将抛出错误。
     *
     * @param sessionID - 会话 ID
     * @param filepath - 待写入的文件路径
     * @throws Error 如果文件未先读取或已被修改
     */
    readonly assert: (sessionID: SessionID, filepath: string) => Effect.Effect<void>

    /**
     * 在文件级互斥锁保护下执行异步操作
     *
     * 确保同一时刻只有一个操作可以修改指定文件，防止并发写入冲突
     *
     * @param filepath - 需要加锁的文件路径
     * @param fn - 要执行的异步函数
     * @returns 函数的返回值
     */
    readonly withLock: <T>(filepath: string, fn: () => Promise<T>) => Effect.Effect<T>
  }

  /**
   * Effect ServiceMap 服务类
   *
   * 使用 Effect 框架的服务依赖注入机制
   */
  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/FileTime") {}

  /**
   * 创建 FileTime 服务的 Effect Layer
   *
   * 初始化服务状态、实现各个方法，并处理服务生命周期
   * 使用 Layer.orDie 确保任何初始化错误都会导致程序终止（不应静默失败）
   */
  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      // 检查是否禁用了文件时间戳检查（通过功能标志控制）
      const disableCheck = yield* Flag.OPENCODE_DISABLE_FILETIME_CHECK
      // 创建实例级别的状态管理，每个实例有独立的 reads 和 locks
      const state = yield* InstanceState.make<State>(
        Effect.fn("FileTime.state")(() =>
          Effect.succeed({
            reads: new Map<SessionID, Map<string, Stamp>>(),
            locks: new Map<string, Semaphore.Semaphore>(),
          }),
        ),
      )

      /**
       * 获取或创建文件级别的互斥锁
       *
       * 使用懒加载策略：首次请求某个文件的锁时创建信号量
       * 信号量容量为 1，实现互斥锁语义
       *
       * @param filepath - 文件路径
       * @returns 该文件的信号量（互斥锁）
       */
      const getLock = Effect.fn("FileTime.lock")(function* (filepath: string) {
        const locks = (yield* InstanceState.get(state)).locks
        const lock = locks.get(filepath)
        if (lock) return lock

        // 创建容量为 1 的信号量，实现互斥锁
        const next = Semaphore.makeUnsafe(1)
        locks.set(filepath, next)
        return next
      })

      /**
       * 记录文件读取事件
       *
       * 当 AI 助手读取文件时调用，保存当前时间戳和文件状态快照
       *
       * @param sessionID - 会话 ID
       * @param file - 被读取的文件路径
       */
      const read = Effect.fn("FileTime.read")(function* (sessionID: SessionID, file: string) {
        const reads = (yield* InstanceState.get(state)).reads
        log.info("read", { sessionID, file })
        // 为该会话记录文件的当前状态快照
        session(reads, sessionID).set(file, yield* stamp(file))
      })

      /**
       * 获取文件上次读取的时间
       *
       * @param sessionID - 会话 ID
       * @param file - 文件路径
       * @returns 读取时间的 Date 对象，如果从未读取则返回 undefined
       */
      const get = Effect.fn("FileTime.get")(function* (sessionID: SessionID, file: string) {
        const reads = (yield* InstanceState.get(state)).reads
        return reads.get(sessionID)?.get(file)?.read
      })

      /**
       * 断言文件自上次读取后未被外部修改
       *
       * 核心逻辑：
       * 1. 如果禁用了检查，直接返回
       * 2. 检查文件是否曾被读取过，未读取则抛出错误
       * 3. 获取文件当前状态，与上次读取时的快照对比
       * 4. 如果 mtime、ctime 或 size 任一发生变化，说明文件被修改，抛出错误
       *
       * @param sessionID - 会话 ID
       * @param filepath - 待验证的文件路径
       * @throws Error 如果文件未先读取或已被外部修改
       */
      const assert = Effect.fn("FileTime.assert")(function* (sessionID: SessionID, filepath: string) {
        // 如果通过功能标志禁用了检查，直接跳过
        if (disableCheck) return

        const reads = (yield* InstanceState.get(state)).reads
        // 获取上次读取时的快照
        const time = reads.get(sessionID)?.get(filepath)
        if (!time) throw new Error(`You must read file ${filepath} before overwriting it. Use the Read tool first`)

        // 获取文件当前状态
        const next = yield* stamp(filepath)
        // 对比三个关键指标：修改时间、状态改变时间、文件大小
        const changed = next.mtime !== time.mtime || next.ctime !== time.ctime || next.size !== time.size
        if (!changed) return

        // 文件已被修改，抛出详细错误信息
        throw new Error(
          `File ${filepath} has been modified since it was last read.\nLast modification: ${new Date(next.mtime ?? next.read.getTime()).toISOString()}\nLast read: ${time.read.toISOString()}\n\nPlease read the file again before modifying it.`,
        )
      })

      /**
       * 在文件级互斥锁保护下执行异步操作
       *
       * 使用信号量的 withPermits 方法获取锁，执行完操作后自动释放
       * 确保同一时刻只有一个操作可以修改指定文件
       *
       * @param filepath - 需要加锁的文件路径
       * @param fn - 要执行的异步函数
       * @returns 函数的返回值
       */
      const withLock = Effect.fn("FileTime.withLock")(function* <T>(filepath: string, fn: () => Promise<T>) {
        // 将 Promise 转换为 Effect，并在信号量保护下执行
        return yield* Effect.promise(fn).pipe((yield* getLock(filepath)).withPermits(1))
      })

      // 构造并返回服务实例
      return Service.of({ read, get, assert, withLock })
    }),
  ).pipe(Layer.orDie)

  /**
   * 创建服务运行时
   *
   * 将 Effect 服务层转换为可直接调用的 Promise-based API
   */
  const { runPromise } = makeRuntime(Service, layer)

  /**
   * 记录文件读取事件（外部 API）
   *
   * @param sessionID - 会话 ID
   * @param file - 被读取的文件路径
   */
  export function read(sessionID: SessionID, file: string) {
    return runPromise((s) => s.read(sessionID, file))
  }

  /**
   * 获取文件上次读取的时间（外部 API）
   *
   * @param sessionID - 会话 ID
   * @param file - 文件路径
   * @returns 读取时间的 Promise
   */
  export function get(sessionID: SessionID, file: string) {
    return runPromise((s) => s.get(sessionID, file))
  }

  /**
   * 断言文件未被外部修改（外部 API）
   *
   * 应在写入文件前调用，确保不会覆盖未读取的变更
   *
   * @param sessionID - 会话 ID
   * @param filepath - 待写入的文件路径
   * @throws Error 如果文件未先读取或已被修改
   */
  export async function assert(sessionID: SessionID, filepath: string) {
    return runPromise((s) => s.assert(sessionID, filepath))
  }

  /**
   * 在文件锁保护下执行异步操作（外部 API）
   *
   * 用于确保并发写入的安全性
   *
   * @param filepath - 需要加锁的文件路径
   * @param fn - 要执行的异步函数
   * @returns 函数的返回值
   */
  export async function withLock<T>(filepath: string, fn: () => Promise<T>): Promise<T> {
    return runPromise((s) => s.withLock(filepath, fn))
  }
}
