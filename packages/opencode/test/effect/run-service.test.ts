// 导入测试框架和 Effect 核心模块
import { expect, test } from "bun:test"
import { Effect, Layer, ServiceMap } from "effect"  // Effect 框架模块
import { makeRuntime } from "@/effect/run-service.ts"  // 运行时创建工具

/**
 * 定义共享服务 Shared
 * 
 * 作用：
 * - 提供一个全局共享的服务实例
 * - 包含一个 id 字段，用于验证是否被重复初始化
 * - 多个 Runtime 可以共享这个服务的同一个实例
 */
class Shared extends ServiceMap.Service<Shared, { readonly id: number }>()("@test/Shared") {}

/**
 * 测试用例：验证 makeRuntime 通过共享的 memo map 共享依赖层
 * 
 * makeRuntime() 的作用：
 * - 为指定的服务和 Layer 创建 ManagedRuntime
 * - 使用全局共享的 memoMap 来缓存依赖层
 * - 确保多个 Runtime 之间共享相同的依赖实例
 * - 提供 runSync、runPromise、runFork 等便捷方法
 * 
 * 关键概念：
 * - MemoMap：Effect 的依赖缓存机制，确保同一 Layer 只初始化一次
 * - 共享 MemoMap：多个 Runtime 使用同一个 memoMap，实现跨 Runtime 的依赖共享
 * 
 * 场景说明：
 * - 创建 Shared 服务，每次初始化时递增计数器 n
 * - 创建 One 服务，依赖 Shared，提供 get() 方法返回 Shared.id
 * - 创建 Two 服务，同样依赖 Shared，提供 get() 方法返回 Shared.id
 * - 分别为 One 和 Two 创建独立的 Runtime
 * - 调用两个 Runtime 的 get() 方法
 * 
 * 预期结果：
 * - runOne 返回 1（Shared 第一次初始化）
 * - runTwo 也返回 1（共享同一个 Shared 实例）
 * - n 等于 1（Shared 只初始化了一次）
 * 
 * 这证明了：
 * - 两个独立的 Runtime 通过共享 memoMap 实现了依赖共享
 * - Shared 服务没有被重复初始化
 * - 这对于减少资源消耗和保持状态一致性非常重要
 */
test("makeRuntime shares dependent layers through the shared memo map", async () => {
  // 计数器，记录 Shared 服务的初始化次数
  let n = 0

  // 创建 Shared 服务的 Layer
  // 每次初始化时递增 n，并返回带有 id 的服务实例
  /**
   * Layer.effect<A, E, R>(
   *   tag: Context.Tag<A, any>,           // 第1参数：服务标识（Key），第一参数：Shared（Context.Tag）， 作用：类型安全的服务标识符（Key）。
   *   effect: Effect.Effect<A, E, R>      // 第2参数：构建逻辑（如何造出 A）
   * ): Layer<A, E, R>
   */
  const shared = Layer.effect(
    Shared,
    Effect.sync(() => {
      n += 1 // 记录初始化次数
      return Shared.of({ id: n }) // 创建服务实例
    }),
  )

  /**
   * 定义 One 服务
   *
   * 作用：
   * - 依赖 Shared 服务
   * - 提供 get() 方法，返回 Shared.id
   */
  class One extends ServiceMap.Service<One, { readonly get: () => Effect.Effect<number> }>()("@test/One") {}

  // 创建 One 服务的 Layer，注入 Shared 依赖
  const one = Layer.effect(
    One,
    Effect.gen(function* () {
      // 获取 Shared 服务实例
      /**
       * yield * ：在 Effect-TS 中被重载为"执行 Effect 并获取其结果"：
       * // 写法 1：语法糖（简洁）
       * const s = yield* Shared;
       *
       * // 写法 2：显式调用（等价）
       * const s = yield* Effect.service(Shared);
       */

      const svc = yield * Shared
      return One.of({
        // 定义 get 方法，返回 Shared 的 id
        get: Effect.fn("One.get")(() => Effect.succeed(svc.id)),
      })
    }),
  ).pipe(Layer.provide(shared)) // 注入 Shared 依赖

  /**
   * 定义 Two 服务
   *
   * 作用：
   * - 同样依赖 Shared 服务
   * - 提供 get() 方法，返回 Shared.id
   */
  class Two extends ServiceMap.Service<Two, { readonly get: () => Effect.Effect<number> }>()("@test/Two") {}

  // 创建 Two 服务的 Layer，注入 Shared 依赖
  const two = Layer.effect(
    Two,
    Effect.gen(function* () {
      // 获取 Shared 服务实例
      const svc = yield* Shared
      return Two.of({
        // 定义 get 方法，返回 Shared 的 id
        get: Effect.fn("Two.get")(() => Effect.succeed(svc.id)),
      })
    }),
  ).pipe(Layer.provide(shared)) // 注入 Shared 依赖

  // 为 One 服务创建 Runtime
  const { runPromise: runOne } = makeRuntime(One, one)
  // 为 Two 服务创建 Runtime
  const { runPromise: runTwo } = makeRuntime(Two, two)

  // 调用 One 的 get() 方法，应该返回 1
  expect(await runOne((svc) => svc.get())).toBe(1)
  // 调用 Two 的 get() 方法，也应该返回 1（共享同一个 Shared 实例）
  expect(await runTwo((svc) => svc.get())).toBe(1)
  // 验证：Shared 只初始化了一次
  expect(n).toBe(1)
})
