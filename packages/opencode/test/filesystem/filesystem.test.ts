// 导入测试框架和 Effect 核心模块
import { describe, test, expect } from "bun:test"
import { Effect, Layer } from "effect"  // Effect 框架模块
import { NodeFileSystem } from "@effect/platform-node"  // Node.js 文件系统实现
import { AppFileSystem } from "../../src/filesystem"  // 应用文件系统服务
import { testEffect } from "../lib/effect"  // Effect 测试辅助函数
import path from "path"  // Node.js 路径处理模块

/**
 * 创建 AppFileSystem 的测试运行时
 * 
 * 工作流程：
 * 1. AppFileSystem.layer - 创建文件系统服务层
 * 2. Layer.provide(NodeFileSystem.layer) - 注入 Node.js 文件系统实现
 * 3. testEffect(live) - 创建 Effect 测试辅助函数
 */
const live = AppFileSystem.layer.pipe(Layer.provide(NodeFileSystem.layer))
const { effect: it } = testEffect(live)

/**
 * 测试套件：AppFileSystem
 * 
 * AppFileSystem 的作用：
 * - 提供统一的文件系统操作接口（基于 Effect 框架）
 * - 扩展基础 FileSystem，添加高级功能
 * - 支持 JSON 读写、目录查找、模式匹配等
 * - 所有操作都是 Effect 风格的，支持错误处理和资源管理
 * 
 * 核心功能：
 * 1. isDir/isFile - 判断路径类型
 * 2. readJson/writeJson - JSON 文件读写
 * 3. ensureDir - 确保目录存在（递归创建）
 * 4. writeWithDirs - 写入文件时自动创建父目录
 * 5. findUp/up - 向上查找文件
 * 6. glob/globUp - 模式匹配搜索文件
 * 7. mimeType - MIME 类型检测（纯函数）
 * 8. contains/overlaps - 路径关系判断（纯函数）
 */
describe("AppFileSystem", () => {
  /**
   * 测试组 1：isDir()
   * 
   * isDir() 的作用：
   * - 判断给定路径是否为目录
   * - 使用 fs.stat() 获取文件信息
   * - 如果路径不存在或不是目录，返回 false
   * - 不会抛出错误（安全版本）
   */
  describe("isDir", () => {
    /**
     * 测试用例 1.1：验证对目录返回 true
     * 
     * 场景：
     * - 创建临时目录
     * - 调用 isDir() 检查
     * 
     * 预期结果：
     * - 返回 true
     */
    it(
      "returns true for directories",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service  // 获取文件系统服务
        const tmp = yield* fs.makeTempDirectoryScoped()  // 创建临时目录（自动清理）
        expect(yield* fs.isDir(tmp)).toBe(true)  // 应该是目录
      }),
    )

    it(
      "returns false for files",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const tmp = yield* fs.makeTempDirectoryScoped()
        const file = path.join(tmp, "test.txt")
        yield* fs.writeFileString(file, "hello")
        expect(yield* fs.isDir(file)).toBe(false)
      }),
    )

    /**
     * 测试用例 1.3：验证对不存在的路径返回 false
     * 
     * 场景：
     * - 调用 isDir() 检查不存在的路径
     * 
     * 预期结果：
     * - 返回 false（不抛出错误）
     * - 这是安全版本的特点
     */
    it(
      "returns false for non-existent paths",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        // 使用随机数确保路径不存在
        expect(yield* fs.isDir("/tmp/nonexistent-" + Math.random())).toBe(false)
      }),
    )
  })

  /**
   * 测试组 2：isFile()
   * 
   * isFile() 的作用：
   * - 判断给定路径是否为文件
   * - 使用 fs.stat() 获取文件信息
   * - 如果路径不存在或不是文件，返回 false
   */
  describe("isFile", () => {
    /**
     * 测试用例 2.1：验证对文件返回 true
     */
    it(
      "returns true for files",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const tmp = yield* fs.makeTempDirectoryScoped()
        const file = path.join(tmp, "test.txt")
        yield* fs.writeFileString(file, "hello")  // 创建文件
        expect(yield* fs.isFile(file)).toBe(true)  // 应该是文件
      }),
    )

    /**
     * 测试用例 2.2：验证对目录返回 false
     */
    it(
      "returns false for directories",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const tmp = yield* fs.makeTempDirectoryScoped()
        expect(yield* fs.isFile(tmp)).toBe(false)  // 目录不是文件
      }),
    )
  })

  /**
   * 测试组 3：readJson / writeJson
   * 
   * readJson/writeJson 的作用：
   * - writeJson: 将 JavaScript 对象序列化为 JSON 并写入文件（格式化，缩进 2 空格）
   * - readJson: 读取文件内容并解析为 JavaScript 对象
   * - 支持嵌套对象和复杂数据类型
   */
  describe("readJson / writeJson", () => {
    /**
     * 测试用例 3.1：验证 JSON 数据往返
     * 
     * 场景：
     * - 创建包含嵌套对象的复杂数据
     * - 使用 writeJson 写入文件
     * - 使用 readJson 读取文件
     * 
     * 预期结果：
     * - 读取的数据与原始数据完全相同
     */
    it(
      "round-trips JSON data",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const tmp = yield* fs.makeTempDirectoryScoped()
        const file = path.join(tmp, "data.json")
        // 创建复杂数据：包含字符串、数字、嵌套对象
        const data = { name: "test", count: 42, nested: { ok: true } }

        yield* fs.writeJson(file, data)  // 写入 JSON
        const result = yield* fs.readJson(file)  // 读取 JSON

        expect(result).toEqual(data)  // 数据应该完全相同
      }),
    )
  })

  /**
   * 测试组 4：ensureDir()
   * 
   * ensureDir() 的作用：
   * - 确保目录存在，如果不存在则递归创建
   * - 使用 fs.makeDirectory(path, { recursive: true })
   * - 幂等操作：如果目录已存在，不会报错
   */
  describe("ensureDir", () => {
    /**
     * 测试用例 4.1：验证创建嵌套目录
     * 
     * 场景：
     * - 指定深层嵌套路径 a/b/c
     * - 调用 ensureDir()
     * 
     * 预期结果：
     * - 所有父目录都被创建
     * - stat().type = "Directory"
     */
    it(
      "creates nested directories",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const tmp = yield* fs.makeTempDirectoryScoped()
        const nested = path.join(tmp, "a", "b", "c")  // 三层嵌套

        yield* fs.ensureDir(nested)  // 递归创建

        const info = yield* fs.stat(nested)
        expect(info.type).toBe("Directory")  // 应该是目录
      }),
    )

    /**
     * 测试用例 4.2：验证幂等性
     * 
     * 场景：
     * - 先手动创建目录
     * - 再次调用 ensureDir()
     * 
     * 预期结果：
     * - 不抛出错误
     * - 目录仍然存在
     */
    it(
      "is idempotent",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const tmp = yield* fs.makeTempDirectoryScoped()
        const dir = path.join(tmp, "existing")
        yield* fs.makeDirectory(dir)  // 先创建目录

        yield* fs.ensureDir(dir)  // 再次确保（应该不报错）

        const info = yield* fs.stat(dir)
        expect(info.type).toBe("Directory")  // 目录仍然存在
      }),
    )
  })

  describe("writeWithDirs", () => {
    it(
      "creates parent directories if missing",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const tmp = yield* fs.makeTempDirectoryScoped()
        const file = path.join(tmp, "deep", "nested", "file.txt")

        yield* fs.writeWithDirs(file, "hello")

        expect(yield* fs.readFileString(file)).toBe("hello")
      }),
    )

    it(
      "writes directly when parent exists",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const tmp = yield* fs.makeTempDirectoryScoped()
        const file = path.join(tmp, "direct.txt")

        yield* fs.writeWithDirs(file, "world")

        expect(yield* fs.readFileString(file)).toBe("world")
      }),
    )

    it(
      "writes Uint8Array content",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const tmp = yield* fs.makeTempDirectoryScoped()
        const file = path.join(tmp, "binary.bin")
        const content = new Uint8Array([0x00, 0x01, 0x02, 0x03])

        yield* fs.writeWithDirs(file, content)

        const result = yield* fs.readFile(file)
        expect(new Uint8Array(result)).toEqual(content)
      }),
    )
  })

  describe("findUp", () => {
    it(
      "finds target in start directory",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const tmp = yield* fs.makeTempDirectoryScoped()
        yield* fs.writeFileString(path.join(tmp, "target.txt"), "found")

        const result = yield* fs.findUp("target.txt", tmp)
        expect(result).toEqual([path.join(tmp, "target.txt")])
      }),
    )

    it(
      "finds target in parent directories",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const tmp = yield* fs.makeTempDirectoryScoped()
        yield* fs.writeFileString(path.join(tmp, "marker"), "root")
        const child = path.join(tmp, "a", "b")
        yield* fs.makeDirectory(child, { recursive: true })

        const result = yield* fs.findUp("marker", child, tmp)
        expect(result).toEqual([path.join(tmp, "marker")])
      }),
    )

    it(
      "returns empty array when not found",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const tmp = yield* fs.makeTempDirectoryScoped()
        const result = yield* fs.findUp("nonexistent", tmp, tmp)
        expect(result).toEqual([])
      }),
    )
  })

  describe("up", () => {
    it(
      "finds multiple targets walking up",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const tmp = yield* fs.makeTempDirectoryScoped()
        yield* fs.writeFileString(path.join(tmp, "a.txt"), "a")
        yield* fs.writeFileString(path.join(tmp, "b.txt"), "b")
        const child = path.join(tmp, "sub")
        yield* fs.makeDirectory(child)
        yield* fs.writeFileString(path.join(child, "a.txt"), "a-child")

        const result = yield* fs.up({ targets: ["a.txt", "b.txt"], start: child, stop: tmp })

        expect(result).toContain(path.join(child, "a.txt"))
        expect(result).toContain(path.join(tmp, "a.txt"))
        expect(result).toContain(path.join(tmp, "b.txt"))
      }),
    )
  })

  describe("glob", () => {
    it(
      "finds files matching pattern",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const tmp = yield* fs.makeTempDirectoryScoped()
        yield* fs.writeFileString(path.join(tmp, "a.ts"), "a")
        yield* fs.writeFileString(path.join(tmp, "b.ts"), "b")
        yield* fs.writeFileString(path.join(tmp, "c.json"), "c")

        const result = yield* fs.glob("*.ts", { cwd: tmp })
        expect(result.sort()).toEqual(["a.ts", "b.ts"])
      }),
    )

    it(
      "supports absolute paths",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const tmp = yield* fs.makeTempDirectoryScoped()
        yield* fs.writeFileString(path.join(tmp, "file.txt"), "hello")

        const result = yield* fs.glob("*.txt", { cwd: tmp, absolute: true })
        expect(result).toEqual([path.join(tmp, "file.txt")])
      }),
    )
  })

  describe("globMatch", () => {
    it(
      "matches patterns",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        expect(fs.globMatch("*.ts", "foo.ts")).toBe(true)
        expect(fs.globMatch("*.ts", "foo.json")).toBe(false)
        expect(fs.globMatch("src/**", "src/a/b.ts")).toBe(true)
      }),
    )
  })

  describe("globUp", () => {
    it(
      "finds files walking up directories",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const tmp = yield* fs.makeTempDirectoryScoped()
        yield* fs.writeFileString(path.join(tmp, "root.md"), "root")
        const child = path.join(tmp, "a", "b")
        yield* fs.makeDirectory(child, { recursive: true })
        yield* fs.writeFileString(path.join(child, "leaf.md"), "leaf")

        const result = yield* fs.globUp("*.md", child, tmp)
        expect(result).toContain(path.join(child, "leaf.md"))
        expect(result).toContain(path.join(tmp, "root.md"))
      }),
    )
  })

  describe("built-in passthrough", () => {
    it(
      "exists works",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const tmp = yield* fs.makeTempDirectoryScoped()
        const file = path.join(tmp, "exists.txt")
        yield* fs.writeFileString(file, "yes")

        expect(yield* fs.exists(file)).toBe(true)
        expect(yield* fs.exists(file + ".nope")).toBe(false)
      }),
    )

    it(
      "remove works",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const tmp = yield* fs.makeTempDirectoryScoped()
        const file = path.join(tmp, "delete-me.txt")
        yield* fs.writeFileString(file, "bye")

        yield* fs.remove(file)

        expect(yield* fs.exists(file)).toBe(false)
      }),
    )
  })

  describe("pure helpers", () => {
    test("mimeType returns correct types", () => {
      expect(AppFileSystem.mimeType("file.json")).toBe("application/json")
      expect(AppFileSystem.mimeType("image.png")).toBe("image/png")
      expect(AppFileSystem.mimeType("unknown.qzx")).toBe("application/octet-stream")
    })

    test("contains checks path containment", () => {
      expect(AppFileSystem.contains("/a/b", "/a/b/c")).toBe(true)
      expect(AppFileSystem.contains("/a/b", "/a/c")).toBe(false)
    })

    test("overlaps detects overlapping paths", () => {
      expect(AppFileSystem.overlaps("/a/b", "/a/b/c")).toBe(true)
      expect(AppFileSystem.overlaps("/a/b/c", "/a/b")).toBe(true)
      expect(AppFileSystem.overlaps("/a", "/b")).toBe(false)
    })
  })
})
