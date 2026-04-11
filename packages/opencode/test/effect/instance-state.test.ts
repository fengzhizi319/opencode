// 导入测试框架和 Effect 核心模块
import { afterEach, expect, test } from "bun:test"
import { Duration, Effect, Layer, ManagedRuntime, ServiceMap } from "effect"  // Effect 框架模块
import { InstanceState } from "../../src/effect/instance-state"  // 实例状态管理模块
import { Instance } from "../../src/project/instance"  // 项目实例管理模块
import { tmpdir } from "../fixture/fixture"  // 临时目录工具函数

/**
 * 辅助函数：在指定目录下访问 InstanceState
 * 
 * @param state - InstanceState 实例
 * @param dir - 项目目录路径
 * @returns Promise，产出状态值
 * 
 * 工作流程：
 * 1. 使用 Instance.provide 设置当前目录上下文
 * 2. 调用 InstanceState.get 获取该目录的状态
 * 3. 运行 Effect 并返回结果
 */
async function access<A, E>(state: InstanceState<A, E>, dir: string) {
  return Instance.provide({
    directory: dir,
    fn: () => Effect.runPromise(InstanceState.get(state)),
  })
}

/**
 * 清理钩子：每个测试用例执行后销毁所有实例
 * 
 * 目的：确保测试之间互不干扰，每个测试都从干净的状态开始
 */
afterEach(async () => {
  await Instance.disposeAll()
})

/**
 * 测试用例 1：验证 InstanceState 按目录缓存值
 * 
 * InstanceState 的作用：
 * - 为每个项目目录维护独立的状态
 * - 自动缓存状态值，避免重复初始化
 * - 支持资源清理（通过 Scope）
 * - 线程安全，支持并发访问
 * 
 * 场景说明：
 * - 创建 InstanceState，初始化函数每次调用时递增计数器 n
 * - 第一次访问 tmp.path 目录，n 应该变为 1
 * - 第二次访问同一个目录，应该返回缓存的值，n 不应该增加
 * 
 * 预期结果：
 * - a 和 b 是同一个对象引用（toBe）
 * - n 等于 1（只初始化了一次）
 */
test("InstanceState caches values per directory", async () => {
  await using tmp = await tmpdir()
  let n = 0

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        // 创建 InstanceState，每次初始化时递增 n
        const state = yield* InstanceState.make(() => Effect.sync(() => ({ n: ++n })))

        // 第一次访问：应该触发初始化，n = 1
        const a = yield* Effect.promise(() => access(state, tmp.path))
        // 第二次访问：应该返回缓存的值，n 不变
        const b = yield* Effect.promise(() => access(state, tmp.path))

        // 验证：两次访问返回同一个对象引用
        expect(a).toBe(b)
        // 验证：只初始化了一次
        expect(n).toBe(1)
      }),
    ),
  )
})

/**
 * 测试用例 2：验证 InstanceState 隔离不同目录的状态
 * 
 * 场景说明：
 * - 创建两个临时目录 one 和 two
 * - InstanceState 的初始化函数记录目录路径并递增计数器 n
 * - 访问 one.path → 应该初始化，n = 1
 * - 访问 two.path → 应该初始化，n = 2（不同目录）
 * - 再次访问 one.path → 应该返回缓存的值，n 不变
 * 
 * 预期结果：
 * - a 和 c 是同一个对象引用（one.path 的缓存）
 * - a 和 b 不是同一个对象（不同目录）
 * - n 等于 2（只初始化了两次）
 */
test("InstanceState isolates directories", async () => {
  await using one = await tmpdir()
  await using two = await tmpdir()
  let n = 0

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        // 创建 InstanceState，初始化时记录目录路径并递增 n
        const state = yield* InstanceState.make((dir) => Effect.sync(() => ({ dir, n: ++n })))

        // 访问第一个目录：n = 1
        const a = yield* Effect.promise(() => access(state, one.path))
        // 访问第二个目录：n = 2（不同目录，独立状态）
        const b = yield* Effect.promise(() => access(state, two.path))
        // 再次访问第一个目录：应该返回缓存，n 不变
        const c = yield* Effect.promise(() => access(state, one.path))

        // 验证：a 和 c 是同一个对象（one.path 的缓存）
        expect(a).toBe(c)
        // 验证：a 和 b 不是同一个对象（不同目录）
        expect(a).not.toBe(b)
        // 验证：只初始化了两次
        expect(n).toBe(2)
      }),
    ),
  )
})

/**
 * 测试用例 3：验证 InstanceState 在 reload 时失效
 * 
 * 场景说明：
 * - 使用 acquireRelease 管理资源，清理时将值添加到 seen 数组
 * - 第一次访问 tmp.path：初始化，n = 1
 * - 调用 Instance.reload：应该触发清理，将 "1" 添加到 seen
 * - 第二次访问 tmp.path：重新初始化，n = 2
 * 
 * 预期结果：
 * - a 和 b 不是同一个对象（reload 后重新初始化）
 * - seen 包含 ["1"]（旧值被清理）
 */
test("InstanceState invalidates on reload", async () => {
  await using tmp = await tmpdir()
  const seen: string[] = []
  let n = 0

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        // 创建 InstanceState，使用 acquireRelease 管理资源生命周期
        const state = yield* InstanceState.make(() =>
          Effect.acquireRelease(
            Effect.sync(() => ({ n: ++n })),  // 获取资源
            (value) =>
              Effect.sync(() => {
                seen.push(String(value.n))  // 释放资源时记录
              }),
          ),
        )

        // 第一次访问：n = 1
        const a = yield* Effect.promise(() => access(state, tmp.path))
        // 重载实例：应该触发清理
        yield* Effect.promise(() => Instance.reload({ directory: tmp.path }))
        // 第二次访问：重新初始化，n = 2
        const b = yield* Effect.promise(() => access(state, tmp.path))

        // 验证：a 和 b 不是同一个对象
        expect(a).not.toBe(b)
        // 验证：旧值被清理
        expect(seen).toEqual(["1"])
      }),
    ),
  )
})

/**
 * 测试用例 4：验证 InstanceState 在 disposeAll 时失效
 * 
 * 场景说明：
 * - 创建两个临时目录 one 和 two
 * - InstanceState 使用 acquireRelease，清理时记录目录路径
 * - 访问两个目录，初始化状态
 * - 调用 Instance.disposeAll()：应该清理所有目录的状态
 * 
 * 预期结果：
 * - seen 数组包含两个目录的路径（顺序可能不同）
 */
test("InstanceState invalidates on disposeAll", async () => {
  await using one = await tmpdir()
  await using two = await tmpdir()
  const seen: string[] = []

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        // 创建 InstanceState，清理时记录目录路径
        const state = yield* InstanceState.make((ctx) =>
          Effect.acquireRelease(
            Effect.sync(() => ({ dir: ctx.directory })),  // 获取资源
            (value) =>
              Effect.sync(() => {
                seen.push(value.dir)  // 释放资源时记录
              }),
          ),
        )

        // 访问两个目录
        yield* Effect.promise(() => access(state, one.path))
        yield* Effect.promise(() => access(state, two.path))
        // 销毁所有实例：应该触发两个目录的清理
        yield* Effect.promise(() => Instance.disposeAll())

        // 验证：两个目录都被清理（排序后比较）
        expect(seen.sort()).toEqual([one.path, two.path].sort())
      }),
    ),
  )
})

/**
 * 测试用例 5：验证 InstanceState.get 懒读取当前目录
 * 
 * 场景说明：
 * - 创建 Service 和 Layer，在 Layer 中创建 InstanceState
 * - InstanceState 的初始化函数返回当前目录路径
 * - 使用 ManagedRuntime 管理服务的生命周期
 * - 在不同的 Instance.provide 上下文中调用 get()
 * 
 * 关键点：
 * - InstanceState.get 是懒执行的，只在被调用时读取 Instance.directory
 * - 即使 State 在 Layer 中创建，它也能正确获取调用时的目录上下文
 * 
 * 预期结果：
 * - a 等于 one.path
 * - b 等于 two.path
 */
test("InstanceState.get reads the current directory lazily", async () => {
  await using one = await tmpdir()
  await using two = await tmpdir()

  // 定义服务接口
  interface Api {
    readonly get: () => Effect.Effect<string>
  }

  // 创建测试服务
  class Test extends ServiceMap.Service<Test, Api>()("@test/InstanceStateLazy") {
    static readonly layer = Layer.effect(
      Test,
      Effect.gen(function* () {
        // 创建 InstanceState，初始化时返回当前目录
        const state = yield* InstanceState.make((ctx) => Effect.sync(() => ctx.directory))
        // 获取状态的 Effect
        const get = InstanceState.get(state)

        return Test.of({
          // 定义 get 方法，执行状态获取
          get: Effect.fn("Test.get")(function* () {
            return yield* get
          }),
        })
      }),
    )
  }

  // 创建 ManagedRuntime
  const rt = ManagedRuntime.make(Test.layer)

  try {
    // 在 one.path 上下文中调用 get()
    const a = await Instance.provide({
      directory: one.path,
      fn: () => rt.runPromise(Test.use((svc) => svc.get())),
    })
    // 在 two.path 上下文中调用 get()
    const b = await Instance.provide({
      directory: two.path,
      fn: () => rt.runPromise(Test.use((svc) => svc.get())),
    })

    // 验证：get() 懒读取当前目录
    expect(a).toBe(one.path)
    expect(b).toBe(two.path)
  } finally {
    await rt.dispose()
  }
})

/**
 * 测试用例 6：验证 InstanceState 在异步边界中保持目录上下文
 * 
 * 场景说明：
 * - 创建三个临时目录
 * - Service 的 get 方法包含大量异步操作（sleep、yieldNow、Promise）
 * - 这些异步操作可能会破坏 ALS（Async Local Storage）上下文
 * - 并行执行三个目录的 get 调用
 * 
 * 关键点：
 * - InstanceState 必须能够在复杂的异步操作中保持正确的目录上下文
 * - 即使经过多次 async/await 和 Effect.yieldNow，上下文也不能丢失
 * 
 * 预期结果：
 * - 每个目录返回正确的 directory、worktree、project
 * - 三个目录的 project ID 互不相同
 */
test("InstanceState preserves directory across async boundaries", async () => {
  await using one = await tmpdir({ git: true })
  await using two = await tmpdir({ git: true })
  await using three = await tmpdir({ git: true })

  // 定义服务接口
  interface Api {
    readonly get: () => Effect.Effect<{ directory: string; worktree: string; project: string }>
  }

  // 创建测试服务
  class Test extends ServiceMap.Service<Test, Api>()("@test/InstanceStateAsync") {
    static readonly layer = Layer.effect(
      Test,
      Effect.gen(function* () {
        // 创建 InstanceState，初始化时返回完整的实例上下文
        const state = yield* InstanceState.make((ctx) =>
          Effect.sync(() => ({
            directory: ctx.directory,
            worktree: ctx.worktree,
            project: ctx.project.id,
          })),
        )

        return Test.of({
          // get 方法包含大量异步操作，测试上下文保持能力
          get: Effect.fn("Test.get")(function* () {
            // 模拟各种异步操作
            yield* Effect.promise(() => Bun.sleep(1))
            yield* Effect.sleep(Duration.millis(1))
            for (let i = 0; i < 100; i++) {
              yield* Effect.yieldNow  // 让出执行权
            }
            for (let i = 0; i < 100; i++) {
              yield* Effect.promise(() => Promise.resolve())  // Promise 转换
            }
            yield* Effect.sleep(Duration.millis(2))
            yield* Effect.promise(() => Bun.sleep(1))
            // 在所有异步操作后获取状态
            return yield* InstanceState.get(state)
          }),
        })
      }),
    )
  }

  // 创建 ManagedRuntime
  const rt = ManagedRuntime.make(Test.layer)

  try {
    // 并行执行三个目录的 get 调用
    const [a, b, c] = await Promise.all([
      Instance.provide({
        directory: one.path,
        fn: () => rt.runPromise(Test.use((svc) => svc.get())),
      }),
      Instance.provide({
        directory: two.path,
        fn: () => rt.runPromise(Test.use((svc) => svc.get())),
      }),
      Instance.provide({
        directory: three.path,
        fn: () => rt.runPromise(Test.use((svc) => svc.get())),
      }),
    ])

    // 验证：每个目录返回正确的信息
    expect(a).toEqual({ directory: one.path, worktree: one.path, project: a.project })
    expect(b).toEqual({ directory: two.path, worktree: two.path, project: b.project })
    expect(c).toEqual({ directory: three.path, worktree: three.path, project: c.project })
    // 验证：三个目录的 project ID 互不相同
    expect(a.project).not.toBe(b.project)
    expect(a.project).not.toBe(c.project)
    expect(b.project).not.toBe(c.project)
  } finally {
    await rt.dispose()
  }
})

/**
 * 测试用例 7：验证 InstanceState 在高并发访问下的稳定性
 * 
 * 场景说明：
 * - 创建 20 个临时目录
 * - Service 的 get 方法包含大量随机 sleep 和 yieldNow
 * - 这些操作最大化 ALS 上下文损坏的可能性
 * - 并行执行所有 20 个目录的 get 调用
 * 
 * 关键点：
 * - 测试高并发情况下的线程安全性
 * - 确保即使有大量异步切换，每个请求也能获取正确的目录状态
 * 
 * 预期结果：
 * - 所有 20 个结果都正确对应各自的目录路径
 */
test("InstanceState survives high-contention concurrent access", async () => {
  const N = 20
  // 创建 20 个临时目录
  const dirs = await Promise.all(Array.from({ length: N }, () => tmpdir()))

  // 定义服务接口
  interface Api {
    readonly get: () => Effect.Effect<string>
  }

  // 创建测试服务
  class Test extends ServiceMap.Service<Test, Api>()("@test/HighContention") {
    static readonly layer = Layer.effect(
      Test,
      Effect.gen(function* () {
        // 创建 InstanceState，初始化时返回当前目录
        const state = yield* InstanceState.make((ctx) => Effect.sync(() => ctx.directory))

        return Test.of({
          // get 方法包含大量异步操作，最大化 ALS 损坏风险
          get: Effect.fn("Test.get")(function* () {
            // 交错执行多个异步暂停，增加上下文切换
            for (let i = 0; i < 10; i++) {
              yield* Effect.promise(() => Bun.sleep(Math.random() * 3))  // 随机 sleep
              yield* Effect.yieldNow  // 让出执行权
              yield* Effect.promise(() => Promise.resolve())  // Promise 转换
            }
            return yield* InstanceState.get(state)
          }),
        })
      }),
    )
  }

  // 创建 ManagedRuntime
  const rt = ManagedRuntime.make(Test.layer)

  try {
    // 并行执行所有 20 个目录的 get 调用
    const results = await Promise.all(
      dirs.map((d) =>
        Instance.provide({
          directory: d.path,
          fn: () => rt.runPromise(Test.use((svc) => svc.get())),
        }),
      ),
    )

    // 验证：每个结果都正确对应各自的目录
    for (let i = 0; i < N; i++) {
      expect(results[i]).toBe(dirs[i].path)
    }
  } finally {
    await rt.dispose()
    // 清理所有临时目录
    for (const d of dirs) await d[Symbol.asyncDispose]()
  }
})

/**
 * 测试用例 8：验证 InstanceState 在交错初始化和销毁后仍然正确
 * 
 * 场景说明：
 * - 创建两个临时目录 one 和 two
 * - InstanceState 的初始化是异步的（sleep 5ms）
 * - 执行以下操作序列：
 *   1. 初始化 one.path
 *   2. 同时 reload one.path 和访问 two.path
 *   3. 重新访问 one.path（应该获取新的状态）
 * 
 * 关键点：
 * - 测试并发 reload 和访问的正确性
 * - 确保慢速初始化不会导致状态混乱
 * 
 * 预期结果：
 * - a = one.path
 * - b = two.path
 * - c = one.path（重新初始化后的新状态）
 */
test("InstanceState correct after interleaved init and dispose", async () => {
  await using one = await tmpdir()
  await using two = await tmpdir()

  // 定义服务接口
  interface Api {
    readonly get: () => Effect.Effect<string>
  }

  // 创建测试服务
  class Test extends ServiceMap.Service<Test, Api>()("@test/InterleavedDispose") {
    static readonly layer = Layer.effect(
      Test,
      Effect.gen(function* () {
        // 创建 InstanceState，初始化是异步且慢速的（5ms）
        const state = yield* InstanceState.make((ctx) =>
          Effect.promise(async () => {
            await Bun.sleep(5)  // 模拟慢速初始化
            return ctx.directory
          }),
        )

        return Test.of({
          get: Effect.fn("Test.get")(function* () {
            return yield* InstanceState.get(state)
          }),
        })
      }),
    )
  }

  // 创建 ManagedRuntime
  const rt = ManagedRuntime.make(Test.layer)

  try {
    // 步骤 1：初始化 one.path
    const a = await Instance.provide({
      directory: one.path,
      fn: () => rt.runPromise(Test.use((svc) => svc.get())),
    })
    expect(a).toBe(one.path)

    // 步骤 2：同时 reload one 和访问 two
    const [, b] = await Promise.all([
      Instance.reload({ directory: one.path }),  // 销毁 one 的状态
      Instance.provide({
        directory: two.path,
        fn: () => rt.runPromise(Test.use((svc) => svc.get())),
      }),
    ])
    expect(b).toBe(two.path)

    // 步骤 3：重新访问已销毁的 one.path，应该获取新状态
    const c = await Instance.provide({
      directory: one.path,
      fn: () => rt.runPromise(Test.use((svc) => svc.get())),
    })
    expect(c).toBe(one.path)
  } finally {
    await rt.dispose()
  }
})

/**
 * 测试用例 9：验证一个目录的状态突变不会泄漏到另一个目录
 * 
 * 场景说明：
 * - 创建两个临时目录 one 和 two
 * - InstanceState 存储可变对象 { count: 0 }
 * - 修改 directory one 的状态（count = 42）
 * - 访问 directory two，应该不受影响
 * - 再次访问 directory one，应该保持修改
 * 
 * 关键点：
 * - 验证不同目录的状态是完全隔离的
 * - 确保没有共享引用导致的状态泄漏
 * 
 * 预期结果：
 * - s2.count = 0（two 的状态未受影响）
 * - s1again.count = 42（one 的状态保持修改）
 * - s1again 和 s1 是同一个引用
 */
test("InstanceState mutation in one directory does not leak to another", async () => {
  await using one = await tmpdir()
  await using two = await tmpdir()

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        // 创建 InstanceState，存储可变对象
        const state = yield* InstanceState.make(() => Effect.sync(() => ({ count: 0 })))

        // 访问 directory one 并修改状态
        const s1 = yield* Effect.promise(() => access(state, one.path))
        s1.count = 42  // 突变状态

        // 访问 directory two，应该独立
        const s2 = yield* Effect.promise(() => access(state, two.path))
        expect(s2.count).toBe(0)  // two 的状态未受影响

        // 再次访问 directory one，确认修改仍然存在
        const s1again = yield* Effect.promise(() => access(state, one.path))
        expect(s1again.count).toBe(42)  // one 的状态保持修改
        expect(s1again).toBe(s1)  // 同一个引用
      }),
    ),
  )
})

/**
 * 测试用例 10：验证 InstanceState 去重并发查找
 * 
 * 场景说明：
 * - InstanceState 的初始化是异步且慢速的（sleep 10ms）
 * - 使用 Promise.all 并发两次访问同一个目录
 * - 两个并发请求应该共享同一个初始化过程
 * 
 * 关键点：
 * - 测试并发去重机制（deduplication）
 * - 确保同时发起的多个请求不会触发多次初始化
 * - 这对于性能优化非常重要
 * 
 * 预期结果：
 * - a 和 b 是同一个对象引用
 * - n 等于 1（只初始化了一次）
 */
test("InstanceState dedupes concurrent lookups", async () => {
  await using tmp = await tmpdir()
  let n = 0

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        // 创建 InstanceState，初始化是异步且慢速的
        const state = yield* InstanceState.make(() =>
          Effect.promise(async () => {
            n += 1  // 记录初始化次数
            await Bun.sleep(10)  // 模拟慢速初始化
            return { n }
          }),
        )

        // 并发两次访问同一个目录
        const [a, b] = yield* Effect.promise(() => Promise.all([access(state, tmp.path), access(state, tmp.path)]))
        
        // 验证：两次访问返回同一个对象引用
        expect(a).toBe(b)
        // 验证：只初始化了一次（去重成功）
        expect(n).toBe(1)
      }),
    ),
  )
})
