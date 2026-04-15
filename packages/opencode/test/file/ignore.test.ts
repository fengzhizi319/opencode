import { test, expect } from "bun:test"
import { FileIgnore } from "@/file/ignore.ts"

/**
 * 测试：FileIgnore.match() 方法能够正确匹配嵌套和非嵌套路径
 *
 * 目的：验证文件忽略规则匹配逻辑能够正确处理各种形式的 node_modules 路径，
 * 包括文件、目录、带斜杠和不带斜杠的情况，确保忽略规则的一致性和完整性。
 */
test("match nested and non-nested", () => {
  // 匹配 node_modules 目录下的文件
  expect(FileIgnore.match("node_modules/index.js")).toBe(true)
  
  // 匹配 node_modules 目录本身（不带斜杠）
  expect(FileIgnore.match("node_modules")).toBe(true)
  
  // 匹配 node_modules 目录（带尾部斜杠，表示目录）
  expect(FileIgnore.match("node_modules/")).toBe(true)
  
  // 匹配 node_modules 目录下的子目录
  expect(FileIgnore.match("node_modules/bar")).toBe(true)
  
  // 匹配 node_modules 目录下的子目录（带尾部斜杠）
  expect(FileIgnore.match("node_modules/bar/")).toBe(true)
})
