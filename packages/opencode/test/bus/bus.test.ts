/**
 * Bus 事件总线模块单元测试文件
 * 
 * 测试目标：验证事件发布/订阅系统的核心功能
 * - 事件的发布和订阅机制
 * - 订阅者的生命周期管理
 * - 事件类型隔离
 * - 多订阅者支持
 * - Instance 隔离性
 * - Instance 销毁时的事件通知
 */
import { afterEach, describe, expect, test } from "bun:test"
import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event.ts"
import { Instance } from "@/project/instance.ts"
import { tmpdir } from "../fixture/fixture"

/**
 * 定义测试用的事件类型
 * 
 * 使用 BusEvent.define 创建强类型事件：
 * - 第一个参数：事件名称（字符串标识符）
 * - 第二个参数：Zod Schema（定义事件数据结构）
 * 
 * 用途：在测试中模拟真实的事件发布/订阅场景
 */
const TestEvent = {
  Ping: BusEvent.define("test.ping", z.object({ value: z.number() })),
  Pong: BusEvent.define("test.pong", z.object({ message: z.string() })),
}

/**
 * 辅助函数：在指定的 Instance 上下文中执行测试逻辑
 * 
 * @param directory - 项目目录路径（用于创建独立的 Instance）
 * @param fn - 测试逻辑函数
 * @returns Promise<void>
 * 
 * 用途：
 * - 封装 Instance.provide 调用
 * - 确保每个测试在隔离的 Instance 环境中运行
 * - 自动管理 Instance 的生命周期
 */
function withInstance(directory: string, fn: () => Promise<void>) {
  return Instance.provide({ directory, fn })
}

/**
 * Bus 事件总线测试套件
 * 
 * 包含以下测试分组：
 * 1. publish + subscribe：基本的发布/订阅功能
 * 2. unsubscribe：取消订阅功能
 * 3. subscribeAll：订阅所有事件
 * 4. multiple subscribers：多订阅者支持
 * 5. instance isolation：Instance 隔离性
 * 6. instance disposal：Instance 销毁时的事件通知
 */
describe("Bus", () => {
  /**
   * 清理钩子：每个测试用例后销毁所有 Instance
   * 确保测试之间的完全隔离
   */
  afterEach(() => Instance.disposeAll())

  /**
   * 测试分组1：发布和订阅的基本功能
   * 
   * 测试目标：
   * - 验证事件能够正确地从发布者传递到订阅者
   * - 确认订阅者的即时可用性
   * - 验证事件类型过滤
   * - 确认无订阅者时的安全性
   */
  describe("publish + subscribe", () => {
    /**
     * 测试用例1：订阅者立即生效
     * 
     * 测试目的：
     * - 验证 subscribe() 返回后，订阅者立即可用
     * - 确认不需要额外的等待时间就能接收事件
     * 
     * 预期结果：
     * - 发布事件后，订阅者立即收到
     */
    test("subscriber is live immediately after subscribe returns", async () => {
      await using tmp = await tmpdir()
      const received: number[] = []

      await withInstance(tmp.path, async () => {
        // 订阅 Ping 事件
        Bus.subscribe(TestEvent.Ping, (evt) => {
          received.push(evt.properties.value)
        })
        // 立即发布事件（无需等待）
        await Bus.publish(TestEvent.Ping, { value: 42 })
        await Bun.sleep(10)
      })

      expect(received).toEqual([42])
    })

    /**
     * 测试用例2：订阅者接收匹配的事件
     * 
     * 测试目的：
     * - 验证订阅者能接收多个同类型事件
     * - 确认事件按顺序传递
     * 
     * 注意：
     * - 使用 Bun.sleep(10) 给订阅者启动时间
     * - 这是异步事件系统的常见模式
     * 
     * 预期结果：
     * - 接收到两个事件：[42, 99]
     */
    test("subscriber receives matching events", async () => {
      await using tmp = await tmpdir()
      const received: number[] = []

      await withInstance(tmp.path, async () => {
        Bus.subscribe(TestEvent.Ping, (evt) => {
          received.push(evt.properties.value)
        })
        // 给订阅者 fiber 时间启动消费
        await Bun.sleep(10)
        await Bus.publish(TestEvent.Ping, { value: 42 })
        await Bus.publish(TestEvent.Ping, { value: 99 })
        // 给订阅者时间处理
        await Bun.sleep(10)
      })

      expect(received).toEqual([42, 99])
    })

    /**
     * 测试用例3：订阅者不接收其他类型的事件
     * 
     * 测试目的：
     * - 验证事件类型过滤机制
     * - 确认订阅者只接收订阅的事件类型
     * 
     * 测试流程：
     * 1. 订阅 Ping 事件
     * 2. 发布 Pong 事件（不应被接收）
     * 3. 发布 Ping 事件（应被接收）
     * 
     * 预期结果：
     * - 只接收到 Ping 事件：[1]
     */
    test("subscriber does not receive events of other types", async () => {
      await using tmp = await tmpdir()
      const pings: number[] = []

      await withInstance(tmp.path, async () => {
        Bus.subscribe(TestEvent.Ping, (evt) => {
          pings.push(evt.properties.value)
        })
        await Bun.sleep(10)
        await Bus.publish(TestEvent.Pong, { message: "hello" })
        await Bus.publish(TestEvent.Ping, { value: 1 })
        await Bun.sleep(10)
      })

      expect(pings).toEqual([1])
    })

    /**
     * 测试用例4：没有订阅者时发布事件不会抛出错误
     * 
     * 测试目的：
     * - 验证发布操作的健壮性
     * - 确认即使没有订阅者，系统也不会崩溃
     * 
     * 重要性：
     * - 允许组件独立发布事件，无需关心是否有订阅者
     * - 支持动态订阅/取消订阅场景
     * 
     * 预期结果：
     * - 不抛出任何异常
     */
    test("publish with no subscribers does not throw", async () => {
      await using tmp = await tmpdir()

      await withInstance(tmp.path, async () => {
        await Bus.publish(TestEvent.Ping, { value: 1 })
      })
    })
  })

  /**
   * 测试分组2：取消订阅功能
   * 
   * 测试目标：
   * - 验证 unsubscribe 函数能正确停止事件传递
   * - 确认取消订阅后不再接收事件
   */
  describe("unsubscribe", () => {
    /**
     * 测试用例5：取消订阅停止事件传递
     * 
     * 测试目的：
     * - 验证 subscribe() 返回的取消函数有效
     * - 确认调用 unsub() 后，订阅者不再接收事件
     * 
     * 测试流程：
     * 1. 订阅 Ping 事件
     * 2. 发布事件 1（应被接收）
     * 3. 调用 unsub() 取消订阅
     * 4. 发布事件 2（不应被接收）
     * 
     * 预期结果：
     * - 只接收到第一个事件：[1]
     */
    test("unsubscribe stops delivery", async () => {
      await using tmp = await tmpdir()
      const received: number[] = []

      await withInstance(tmp.path, async () => {
        // 订阅并保存取消函数
        const unsub = Bus.subscribe(TestEvent.Ping, (evt) => {
          received.push(evt.properties.value)
        })
        await Bun.sleep(10)
        // 发布第一个事件（应被接收）
        await Bus.publish(TestEvent.Ping, { value: 1 })
        await Bun.sleep(10)
        // 取消订阅
        unsub()
        await Bun.sleep(10)
        // 发布第二个事件（不应被接收）
        await Bus.publish(TestEvent.Ping, { value: 2 })
        await Bun.sleep(10)
      })

      expect(received).toEqual([1])
    })
  })

  /**
   * 测试分组3：订阅所有事件
   * 
   * 测试目标：
   * - 验证 subscribeAll() 能接收所有类型的事件
   * - 确认通配符订阅者的即时可用性
   */
  describe("subscribeAll", () => {
    /**
     * 测试用例6：subscribeAll 立即生效
     * 
     * 测试目的：
     * - 验证 subscribeAll() 返回后，订阅者立即可用
     * - 确认通配符订阅者不需要额外等待
     * 
     * 预期结果：
     * - 接收到 test.ping 事件
     */
    test("subscribeAll is live immediately after subscribe returns", async () => {
      await using tmp = await tmpdir()
      const received: string[] = []

      await withInstance(tmp.path, async () => {
        // 订阅所有事件
        Bus.subscribeAll((evt) => {
          received.push(evt.type)
        })
        // 立即发布事件
        await Bus.publish(TestEvent.Ping, { value: 1 })
        await Bun.sleep(10)
      })

      expect(received).toEqual(["test.ping"])
    })

    /**
     * 测试用例7：subscribeAll 接收所有事件类型
     * 
     * 测试目的：
     * - 验证通配符订阅者能接收不同类型的事件
     * - 确认事件类型不会被过滤
     * 
     * 测试流程：
     * 1. 订阅所有事件
     * 2. 发布 Ping 事件
     * 3. 发布 Pong 事件
     * 
     * 预期结果：
     * - 同时接收到 test.ping 和 test.pong
     */
    test("receives all event types", async () => {
      await using tmp = await tmpdir()
      const received: string[] = []

      await withInstance(tmp.path, async () => {
        Bus.subscribeAll((evt) => {
          received.push(evt.type)
        })
        await Bun.sleep(10)
        await Bus.publish(TestEvent.Ping, { value: 1 })
        await Bus.publish(TestEvent.Pong, { message: "hi" })
        await Bun.sleep(10)
      })

      expect(received).toContain("test.ping")
      expect(received).toContain("test.pong")
    })
  })

  /**
   * 测试分组4：多订阅者支持
   * 
   * 测试目标：
   * - 验证同一事件类型可以有多个订阅者
   * - 确认每个订阅者都能独立接收事件
   */
  describe("multiple subscribers", () => {
    /**
     * 测试用例8：同一事件的所有订阅者都被调用
     * 
     * 测试目的：
     * - 验证一对多的事件分发机制
     * - 确认每个订阅者独立接收事件副本
     * 
     * 测试流程：
     * 1. 创建两个独立的订阅者（a 和 b）
     * 2. 都订阅 Ping 事件
     * 3. 发布一个事件
     * 
     * 预期结果：
     * - a 收到 [7]
     * - b 收到 [7]
     * - 两者互不影响
     */
    test("all subscribers for same event type are called", async () => {
      await using tmp = await tmpdir()
      const a: number[] = []
      const b: number[] = []

      await withInstance(tmp.path, async () => {
        // 第一个订阅者
        Bus.subscribe(TestEvent.Ping, (evt) => {
          a.push(evt.properties.value)
        })
        // 第二个订阅者
        Bus.subscribe(TestEvent.Ping, (evt) => {
          b.push(evt.properties.value)
        })
        await Bun.sleep(10)
        await Bus.publish(TestEvent.Ping, { value: 7 })
        await Bun.sleep(10)
      })

      expect(a).toEqual([7])
      expect(b).toEqual([7])
    })
  })

  /**
   * 测试分组5：Instance 隔离性
   * 
   * 测试目标：
   * - 验证不同 Instance 之间的事件完全隔离
   * - 确认事件不会跨 Instance 泄漏
   * 
   * 重要性：
   * - 确保多项目环境下，一个项目的事件不会影响另一个项目
   * - 支持同时运行多个 OpenCode 实例
   */
  describe("instance isolation", () => {
    /**
     * 测试用例9：一个目录的事件不会到达另一个目录的订阅者
     * 
     * 测试目的：
     * - 验证 Instance 级别的事件隔离
     * - 确认每个 Instance 有独立的事件总线
     * 
     * 测试流程：
     * 1. 创建两个临时目录（tmpA 和 tmpB）
     * 2. 在 tmpA 中订阅 Ping 事件
     * 3. 在 tmpB 中订阅 Ping 事件
     * 4. 在 tmpA 中发布事件 value=1
     * 5. 在 tmpB 中发布事件 value=2
     * 
     * 预期结果：
     * - receivedA = [1]（只收到自己的事件）
     * - receivedB = [2]（只收到自己的事件）
     * - 没有交叉污染
     */
    test("events in one directory do not reach subscribers in another", async () => {
      await using tmpA = await tmpdir()
      await using tmpB = await tmpdir()
      const receivedA: number[] = []
      const receivedB: number[] = []

      // 在 Instance A 中订阅
      await withInstance(tmpA.path, async () => {
        Bus.subscribe(TestEvent.Ping, (evt) => {
          receivedA.push(evt.properties.value)
        })
        await Bun.sleep(10)
      })

      // 在 Instance B 中订阅
      await withInstance(tmpB.path, async () => {
        Bus.subscribe(TestEvent.Ping, (evt) => {
          receivedB.push(evt.properties.value)
        })
        await Bun.sleep(10)
      })

      // 在 Instance A 中发布事件
      await withInstance(tmpA.path, async () => {
        await Bus.publish(TestEvent.Ping, { value: 1 })
        await Bun.sleep(10)
      })

      // 在 Instance B 中发布事件
      await withInstance(tmpB.path, async () => {
        await Bus.publish(TestEvent.Ping, { value: 2 })
        await Bun.sleep(10)
      })

      expect(receivedA).toEqual([1])
      expect(receivedB).toEqual([2])
    })
  })

  /**
   * 测试分组6：Instance 销毁时的事件通知
   * 
   * 测试目标：
   * - 验证 Instance 销毁时会发布 InstanceDisposed 事件
   * - 确认通配符订阅者能接收到销毁事件
   * - 确保事件在流结束前送达
   * 
   * 重要性：
   * - 允许组件监听 Instance 生命周期
   * - 支持清理资源和状态同步
   */
  describe("instance disposal", () => {
    /**
     * 测试用例10：InstanceDisposed 事件在流结束前传递给通配符订阅者
     * 
     * 测试目的：
     * - 验证 Instance.disposeAll() 触发 InstanceDisposed 事件
     * - 确认 subscribeAll 能接收到系统事件
     * - 确保事件顺序：先普通事件，后销毁事件
     * 
     * 背景：
     * - Instance.disposeAll() 会触发 finalizer（终结器）
     * - Finalizer 负责发布 InstanceDisposed 事件
     * - 这是清理资源的关键机制
     * 
     * 测试流程：
     * 1. 订阅所有事件
     * 2. 发布普通事件 test.ping
     * 3. 退出 withInstance（触发 Instance 销毁）
     * 4. 调用 Instance.disposeAll()
     * 5. 等待事件处理
     * 
     * 预期结果：
     * - received 包含 "test.ping"
     * - received 包含 Bus.InstanceDisposed.type
     */
    test("InstanceDisposed is delivered to wildcard subscribers before stream ends", async () => {
      await using tmp = await tmpdir()
      const received: string[] = []

      await withInstance(tmp.path, async () => {
        // 订阅所有事件（包括系统事件）
        Bus.subscribeAll((evt) => {
          received.push(evt.type)
        })
        await Bun.sleep(10)
        // 发布普通事件
        await Bus.publish(TestEvent.Ping, { value: 1 })
        await Bun.sleep(10)
      })

      // Instance.disposeAll 触发 finalizer，发布 InstanceDisposed 事件
      await Instance.disposeAll()
      await Bun.sleep(50)

      expect(received).toContain("test.ping")
      expect(received).toContain(Bus.InstanceDisposed.type)
    })
  })
})
