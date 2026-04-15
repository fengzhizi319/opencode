import { describe, expect, test } from "bun:test"
import { Schema } from "effect"

import { zod } from "../../src/util/effect-zod"

/**
 * 测试 Effect Schema 到 Zod Schema 的转换工具
 * 
 * 验证zod()函数能将Effect Schema正确转换为Zod Schema:
 * - 支持Class类型的schema (用于路由DTO)
 * - 支持Struct类型,包括optional字段、数组和记录
 * - 对不支持的schema类型(如Tuple)抛出错误
 */
describe("util.effect-zod", () => {
  /**
   * 测试: 转换Class类型的schema为Zod schema
   * 场景: ProviderAuthMethod类包含type(union类型)和label(string)字段
   * 预期: 
   *   1. 保留原始schema的meta信息(ref名称)
   *   2. 能正确解析符合schema的数据
   * 目的: 验证Class schema可用于API路由的DTO形状定义,保持类型安全和元数据
   */
  test("converts class schemas for route dto shapes", () => {
    // 定义一个Provider认证方法的Class schema
    // type字段只能是"oauth"或"api"中的一个,lable是字符串
    class Method extends Schema.Class<Method>("ProviderAuthMethod")({
      type: Schema.Union([Schema.Literal("oauth"), Schema.Literal("api")]),
      label: Schema.String,
    }) {}

    // 将Effect Class schema转换为Zod schema
    const out = zod(Method)

    // 验证元数据被正确保留,ref名称用于标识schema类型
    expect(out.meta()?.ref).toBe("ProviderAuthMethod")
    
    // 验证能正确解析合法数据: type为"oauth", label为"OAuth"
    expect(
      out.parse({
        type: "oauth",
        label: "OAuth",
      }),
    ).toEqual({
      type: "oauth",
      label: "OAuth",
    })
  })

  /**
   * 测试: 转换包含可选字段、数组和记录的Struct schema
   * 场景: Struct包含三个字段:
   *   - foo: 可选字符串 (optional)
   *   - bar: 数字数组 (Array)
   *   - baz: 键为字符串、值为布尔值的记录 (Record)
   * 预期: 
   *   1. 可选字段可以缺失,不影响解析
   *   2. 可选字段存在时能正确解析
   *   3. 数组和记录类型能正确处理
   * 目的: 验证复杂Struct schema的转换能力,覆盖常见的数据结构
   */
  test("converts structs with optional fields, arrays, and records", () => {
    // 创建包含多种字段类型的Struct schema并转换为Zod
    const out = zod(
      Schema.Struct({
        foo: Schema.optional(Schema.String),     // 可选字符串
        bar: Schema.Array(Schema.Number),         // 数字数组
        baz: Schema.Record(Schema.String, Schema.Boolean), // 字符串->布尔的记录
      }),
    )

    // 测试用例1: 省略可选字段foo,只提供bar和baz
    // 预期: 解析成功,返回的对象不包含foo字段
    expect(
      out.parse({
        bar: [1, 2],
        baz: { ok: true },
      }),
    ).toEqual({
      bar: [1, 2],
      baz: { ok: true },
    })
    
    // 测试用例2: 提供所有字段,包括可选的foo
    // 预期: 解析成功,返回完整对象
    expect(
      out.parse({
        foo: "hi",
        bar: [1],
        baz: { ok: false },
      }),
    ).toEqual({
      foo: "hi",
      bar: [1],
      baz: { ok: false },
    })
  })

  /**
   * 测试: 对不支持的Tuple schema应抛出错误
   * 场景: 尝试转换Tuple([String, Number]) schema
   * 预期: 抛出错误,消息包含"unsupported effect schema"
   * 目的: 验证转换器能正确识别并拒绝不支持的schema类型,避免静默失败
   * 说明: Tuple在Zod中语义复杂,当前实现选择不支持,调用方需使用其他结构
   */
  test("throws for unsupported tuple schemas", () => {
    // 验证转换Tuple schema时会抛出明确的错误
    expect(() => zod(Schema.Tuple([Schema.String, Schema.Number]))).toThrow("unsupported effect schema")
  })
})
