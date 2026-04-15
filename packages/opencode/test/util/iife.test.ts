import { describe, expect, test } from "bun:test"
import { iife } from "../../src/util/iife"

// 测试 iife (Immediately Invoked Function Expression) 工具函数
// 该函数用于立即执行传入的函数并返回结果
describe("util.iife", () => {
  // 测试 iife 的基本功能：立即执行同步函数并返回结果
  test("should execute function immediately and return result", () => {
    let called = false
    // 调用 iife 并传入一个箭头函数，该函数会设置标志位并返回 42
    const result = iife(() => {
      called = true
      return 42
    })

    // 验证函数确实被立即执行了
    expect(called).toBe(true)
    // 验证返回值正确传递
    expect(result).toBe(42)
  })

  // 测试 iife 对异步函数的支持
  test("should work with async functions", async () => {
    let called = false
    // 传入异步箭头函数，iife 应能正确处理 Promise
    const result = await iife(async () => {
      called = true
      return "async result"
    })

    // 验证异步函数被立即执行
    expect(called).toBe(true)
    // 验证异步返回值被正确解析
    expect(result).toBe("async result")
  })

  // 测试 iife 处理无返回值的函数（返回 undefined）
  test("should handle functions with no return value", () => {
    let called = false
    // 传入没有显式返回值的函数
    const result = iife(() => {
      called = true
    })

    // 验证函数仍然被执行
    expect(called).toBe(true)
    // 验证返回值为 undefined
    expect(result).toBeUndefined()
  })
})
