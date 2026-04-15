import { describe, expect, test } from "bun:test"
import { formatDuration } from "../../src/util/format"

// 测试 formatDuration 工具函数，该函数将秒数转换为人类可读的时长格式
describe("util.format", () => {
  describe("formatDuration", () => {
    // 测试边界情况：零值和负值应返回空字符串
    test("returns empty string for zero or negative values", () => {
      // 验证零值返回空字符串
      expect(formatDuration(0)).toBe("")
      // 验证小的负值返回空字符串
      expect(formatDuration(-1)).toBe("")
      // 验证大的负值返回空字符串
      expect(formatDuration(-100)).toBe("")
    })

    // 测试纯秒数格式化（小于1分钟的情况）
    test("formats seconds under a minute", () => {
      // 验证1秒的正确格式化
      expect(formatDuration(1)).toBe("1s")
      // 验证30秒的正确格式化
      expect(formatDuration(30)).toBe("30s")
      // 验证59秒（分钟边界前）的正确格式化
      expect(formatDuration(59)).toBe("59s")
    })

    // 测试分钟和秒的组合格式化（小于1小时的情况）
    test("formats minutes under an hour", () => {
      // 验证恰好60秒（1分钟）的格式化
      expect(formatDuration(60)).toBe("1m")
      // 验证61秒（1分1秒）的格式化
      expect(formatDuration(61)).toBe("1m 1s")
      // 验证90秒（1分30秒）的格式化
      expect(formatDuration(90)).toBe("1m 30s")
      // 验证120秒（2分钟）的格式化
      expect(formatDuration(120)).toBe("2m")
      // 验证330秒（5分30秒）的格式化
      expect(formatDuration(330)).toBe("5m 30s")
      // 验证3599秒（59分59秒，小时边界前）的格式化
      expect(formatDuration(3599)).toBe("59m 59s")
    })

    // 测试小时和分钟的组合格式化（小于1天的情况）
    test("formats hours under a day", () => {
      // 验证恰好3600秒（1小时）的格式化
      expect(formatDuration(3600)).toBe("1h")
      // 验证3660秒（1小时1分钟）的格式化
      expect(formatDuration(3660)).toBe("1h 1m")
      // 验证7200秒（2小时）的格式化
      expect(formatDuration(7200)).toBe("2h")
      // 验证8100秒（2小时15分钟）的格式化
      expect(formatDuration(8100)).toBe("2h 15m")
      // 验证86399秒（23小时59分钟，天边界前）的格式化
      expect(formatDuration(86399)).toBe("23h 59m")
    })

    // 测试天数格式化（小于1周的情况），使用波浪号表示近似值
    test("formats days under a week", () => {
      // 验证恰好86400秒（1天）的格式化
      expect(formatDuration(86400)).toBe("~1 day")
      // 验证172800秒（2天）的格式化
      expect(formatDuration(172800)).toBe("~2 days")
      // 验证259200秒（3天）的格式化
      expect(formatDuration(259200)).toBe("~3 days")
      // 验证604799秒（约6天，周边界前）的格式化
      expect(formatDuration(604799)).toBe("~6 days")
    })

    // 测试周数格式化，使用波浪号表示近似值
    test("formats weeks", () => {
      // 验证恰好604800秒（1周）的格式化
      expect(formatDuration(604800)).toBe("~1 week")
      // 验证1209600秒（2周）的格式化
      expect(formatDuration(1209600)).toBe("~2 weeks")
      // 验证1609200秒（约2.66周，应显示为2周）的格式化
      expect(formatDuration(1609200)).toBe("~2 weeks")
    })

    // 测试所有关键边界值的正确性，确保单位转换时没有错误
    test("handles boundary values correctly", () => {
      // 秒到分钟的边界：59秒应保持秒格式
      expect(formatDuration(59)).toBe("59s")
      // 秒到分钟的边界：60秒应转换为分钟
      expect(formatDuration(60)).toBe("1m")
      // 分钟到小时的边界：3599秒应保持分钟和秒格式
      expect(formatDuration(3599)).toBe("59m 59s")
      // 分钟到小时的边界：3600秒应转换为小时
      expect(formatDuration(3600)).toBe("1h")
      // 小时到天的边界：86399秒应保持小时和分钟格式
      expect(formatDuration(86399)).toBe("23h 59m")
      // 小时到天的边界：86400秒应转换为天
      expect(formatDuration(86400)).toBe("~1 day")
      // 天到周的边界：604799秒应保持天格式
      expect(formatDuration(604799)).toBe("~6 days")
      // 天到周的边界：604800秒应转换为周
      expect(formatDuration(604800)).toBe("~1 week")
    })
  })
})
