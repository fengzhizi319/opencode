import { describe, expect, test } from "bun:test"
import { lazy } from "../../src/util/lazy"

// 测试 lazy 工具函数，实现延迟求值和结果缓存（记忆化）
describe("util.lazy", () => {
  // 测试 lazy 的核心功能：函数只被调用一次，后续调用返回缓存的结果
  test("should call function only once", () => {
    let callCount = 0
    // 定义一个模拟昂贵计算的函数，每次调用会增加计数器
    const getValue = () => {
      callCount++
      return "expensive value"
    }

    // 创建惰性求值包装器，此时函数尚未执行
    const lazyValue = lazy(getValue)

    // 验证在首次调用前，原始函数未被执行
    expect(callCount).toBe(0)

    // 首次调用 lazyValue，应执行原始函数并缓存结果
    const result1 = lazyValue()
    expect(result1).toBe("expensive value")
    // 验证函数被调用了 1 次
    expect(callCount).toBe(1)

    // 第二次调用 lazyValue，应直接返回缓存的结果，不再执行原始函数
    const result2 = lazyValue()
    expect(result2).toBe("expensive value")
    // 验证函数仍然只被调用了 1 次（没有增加）
    expect(callCount).toBe(1)
  })

  // 测试 lazy 保持对象引用的一致性（返回相同的对象实例）
  test("should preserve the same reference", () => {
    // 创建一个对象作为返回值
    const obj = { value: 42 }
    // 创建惰性求值包装器
    const lazyObj = lazy(() => obj)

    // 两次调用惰性函数
    const result1 = lazyObj()
    const result2 = lazyObj()

    // 验证两次返回的都是同一个对象引用
    expect(result1).toBe(obj)
    expect(result2).toBe(obj)
    // 验证两次调用返回的是完全相同的引用（使用 === 比较）
    expect(result1).toBe(result2)
  })

  // 测试 lazy 支持各种返回类型（基本类型和特殊值）
  test("should work with different return types", () => {
    // 创建不同类型的惰性求值包装器
    const lazyString = lazy(() => "string")
    const lazyNumber = lazy(() => 123)
    const lazyBoolean = lazy(() => true)
    const lazyNull = lazy(() => null)
    const lazyUndefined = lazy(() => undefined)

    // 验证字符串类型的正确返回
    expect(lazyString()).toBe("string")
    // 验证数字类型的正确返回
    expect(lazyNumber()).toBe(123)
    // 验证布尔类型的正确返回
    expect(lazyBoolean()).toBe(true)
    // 验证 null 值的正确返回
    expect(lazyNull()).toBe(null)
    // 验证 undefined 值的正确返回
    expect(lazyUndefined()).toBe(undefined)
  })
})
