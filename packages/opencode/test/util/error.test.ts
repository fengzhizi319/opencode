import { describe, expect, test } from "bun:test"
import { errorData, errorFormat, errorMessage } from "../../src/util/error"

/**
 * 测试错误处理工具函数
 * 
 * 验证三个核心函数的行为:
 * - errorMessage(): 从各种错误对象中提取消息字符串
 * - errorFormat(): 格式化错误为可读字符串(包含堆栈等信息)
 * - errorData(): 提取错误的结构化数据(type, message, code, formatted等)
 * 
 * 覆盖场景:
 * - 原生 Error 实例
 * - 类似对象的错误 (有message属性的普通对象)
 * - 自定义toString的异常对象
 */
describe("util.error", () => {
  /**
   * 测试: 格式化原生Error实例
   * 场景: 创建标准的Error对象 new Error("boom")
   * 预期:
   *   1. errorMessage()返回错误消息"boom"
   *   2. errorFormat()返回的字符串包含"boom"
   *   3. errorData()返回结构化数据,包含type="Error", message="boom"
   *   4. data.formatted转换为字符串后包含"boom"
   * 目的: 验证标准Error对象能被正确处理,这是最常见的错误类型
   */
  test("formats native Error instances", () => {
    // 创建一个标准的Error实例
    const err = new Error("boom")
    
    // 验证errorMessage能提取错误消息
    expect(errorMessage(err)).toBe("boom")
    
    // 验证errorFormat能格式化错误(通常包含堆栈跟踪)
    expect(errorFormat(err)).toContain("boom")

    // 验证errorData能提取完整的结构化错误信息
    const data = errorData(err)
    expect(data.type).toBe("Error")      // 错误类型
    expect(data.message).toBe("boom")    // 错误消息
    expect(String(data.formatted)).toContain("boom") // 格式化后的内容
  })

  /**
   * 测试: 从类似记录的对象中提取错误信息
   * 场景: 普通JavaScript对象 { message: "bad input", code: "E_BAD" }
   * 预期:
   *   1. errorMessage()能提取message字段的值
   *   2. errorData()能同时提取message和code字段
   * 目的: 验证非Error对象(如API响应、自定义错误对象)也能被正确处理
   * 说明: 很多库抛出的是普通对象而非Error实例,需要兼容这种情况
   */
  test("extracts message from record-like values", () => {
    // 模拟一个带有message和code字段的错误对象
    const err = { message: "bad input", code: "E_BAD" }
    
    // 验证能提取message字段
    expect(errorMessage(err)).toBe("bad input")

    // 验证能提取完整的错误数据结构
    const data = errorData(err)
    expect(data.message).toBe("bad input")
    expect(data.code).toBe("E_BAD")  // code字段也被保留
  })

  /**
   * 测试: 处理具有自定义toString方法的异常对象
   * 场景: 对象没有message属性,但实现了toString()方法返回错误描述
   *   例如Bun的模块解析错误: "ResolveMessage: Cannot resolve module"
   * 预期:
   *   1. errorMessage()调用toString()获取错误描述
   *   2. errorData().message也通过toString()获取
   *   3. data.formatted包含toString()返回的内容
   * 目的: 验证能处理特殊的异常对象,如Bun/V8内部错误、第三方库的自定义错误
   * 说明: 某些运行时或库抛出的对象不符合标准Error结构,但有意义的toString输出
   */
  test("handles opaque throwables with custom toString", () => {
    // 模拟一个只有toString方法的异常对象(如Bun的模块解析错误)
    const err = {
      toString() {
        return "ResolveMessage: Cannot resolve module"
      },
    }

    // 验证能通过toString()提取错误消息
    expect(errorMessage(err)).toBe("ResolveMessage: Cannot resolve module")

    // 验证errorData也能正确处理这种对象
    const data = errorData(err)
    expect(data.message).toBe("ResolveMessage: Cannot resolve module")
    expect(String(data.formatted)).toContain("ResolveMessage")
  })
})
