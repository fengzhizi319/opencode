import { describe, expect, test } from "bun:test"
import { decodeDataUrl } from "../../src/util/data-url"

/**
 * 测试 decodeDataUrl 工具函数
 * 
 * 验证data URL的解码功能:
 * - 支持base64编码的data URL
 * - 支持普通URL编码的data URL
 * - 正确提取并解码数据部分
 */
describe("decodeDataUrl", () => {
  /**
   * 测试: 解码base64编码的data URL
   * 场景: data:text/plain;base64,<base64编码的JSON字符串>
   * 预期: 返回解码后的原始字符串内容
   * 目的: 验证base64编码的data URL能被正确解码,常用于传输二进制数据或复杂文本
   */
  test("decodes base64 data URLs", () => {
    // 准备测试数据: 一个格式化的JSON字符串
    const body = '{\n  "ok": true\n}\n'
    // 将字符串转换为base64编码,构造完整的data URL
    const url = `data:text/plain;base64,${Buffer.from(body).toString("base64")}`
    // 验证解码结果与原始字符串一致
    expect(decodeDataUrl(url)).toBe(body)
  })

  /**
   * 测试: 解码普通URL编码的data URL (非base64)
   * 场景: data:text/plain,hello%20world (%20是空格的URL编码)
   * 预期: 返回解码后的"hello world"
   * 目的: 验证简单文本的URL编码data URL能被正确解码,适用于短文本传输
   */
  test("decodes plain data URLs", () => {
    expect(decodeDataUrl("data:text/plain,hello%20world")).toBe("hello world")
  })
})
