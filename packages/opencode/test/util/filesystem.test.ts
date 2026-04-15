import { describe, test, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Filesystem } from "../../src/util/filesystem"
import { tmpdir } from "../fixture/fixture"

/**
 * 测试 Filesystem 工具类的文件系统操作功能
 * 
 * 覆盖的核心功能:
 * - 文件/目录存在性检查 (exists, isDir)
 * - 文件大小查询 (size)
 * - 文件读取 (readText, readJson, readBytes)
 * - 文件写入 (write, writeJson, writeStream)
 * - MIME类型检测 (mimeType)
 * - Windows路径转换 (windowsPath)
 * - 路径解析和规范化 (resolve, normalizePathPattern)
 * 
 * 使用临时目录确保测试隔离性和清洁性
 */
describe("filesystem", () => {
  /**
   * 测试 exists() 方法 - 检查文件或目录是否存在
   * 
   * 验证能正确识别:
   * - 存在的文件
   * - 不存在的文件
   * - 存在的目录
   */
  describe("exists()", () => {
    /**
     * 测试: 检查存在的文件
     * 场景: 创建文件后检查其存在性
     * 预期: 返回true
     * 目的: 验证基本文件存在性检测功能
     */
    test("returns true for existing file", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "test.txt")
      await fs.writeFile(filepath, "content", "utf-8")

      expect(await Filesystem.exists(filepath)).toBe(true)
    })

    /**
     * 测试: 检查不存在的文件
     * 场景: 检查未创建的文件路径
     * 预期: 返回false
     * 目的: 验证不存在文件的正确处理,不应抛出异常
     */
    test("returns false for non-existent file", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "does-not-exist.txt")

      expect(await Filesystem.exists(filepath)).toBe(false)
    })

    /**
     * 测试: 检查存在的目录
     * 场景: 创建目录后检查其存在性
     * 预期: 返回true
     * 目的: 验证目录也能被正确检测,不仅限于文件
     */
    test("returns true for existing directory", async () => {
      await using tmp = await tmpdir()
      const dirpath = path.join(tmp.path, "subdir")
      await fs.mkdir(dirpath)

      expect(await Filesystem.exists(dirpath)).toBe(true)
    })
  })

  /**
   * 测试 isDir() 方法 - 检查路径是否为目录
   * 
   * 验证能正确区分:
   * - 目录 (返回true)
   * - 文件 (返回false)
   * - 不存在的路径 (返回false)
   */
  describe("isDir()", () => {
    /**
     * 测试: 检查目录路径
     * 场景: 创建目录后检查其类型
     * 预期: 返回true
     * 目的: 验证能正确识别目录类型
     */
    test("returns true for directory", async () => {
      await using tmp = await tmpdir()
      const dirpath = path.join(tmp.path, "testdir")
      await fs.mkdir(dirpath)

      expect(await Filesystem.isDir(dirpath)).toBe(true)
    })

    /**
     * 测试: 检查文件路径
     * 场景: 创建文件后检查其类型
     * 预期: 返回false (因为不是目录)
     * 目的: 验证能正确区分文件和目录
     */
    test("returns false for file", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "test.txt")
      await fs.writeFile(filepath, "content", "utf-8")

      expect(await Filesystem.isDir(filepath)).toBe(false)
    })

    /**
     * 测试: 检查不存在的路径
     * 场景: 检查未创建的路径
     * 预期: 返回false
     * 目的: 验证不存在路径不会抛出异常,而是返回false
     */
    test("returns false for non-existent path", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "does-not-exist")

      expect(await Filesystem.isDir(filepath)).toBe(false)
    })
  })

  /**
   * 测试 size() 方法 - 获取文件或目录大小
   * 
   * 验证:
   * - 能正确返回文件大小(字节)
   * - 不存在的文件返回0
   * - 目录也能查询大小(不同系统行为可能不同)
   */
  describe("size()", () => {
    /**
     * 测试: 获取文件大小
     * 场景: 创建已知大小的文件并查询
     * 预期: 返回文件大小(字节数)
     * 目的: 验证文件大小计算准确
     */
    test("returns file size", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "test.txt")
      const content = "Hello, World!"
      await fs.writeFile(filepath, content, "utf-8")

      expect(await Filesystem.size(filepath)).toBe(content.length)
    })

    /**
     * 测试: 获取不存在文件的大小
     * 场景: 查询未创建的文件
     * 预期: 返回0
     * 目的: 验证不存在文件的优雅处理,不抛出异常
     */
    test("returns 0 for non-existent file", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "does-not-exist.txt")

      expect(await Filesystem.size(filepath)).toBe(0)
    })

    /**
     * 测试: 获取目录大小
     * 场景: 查询空目录的大小
     * 预期: 返回数字类型(不同系统目录大小定义不同)
     * 目的: 验证目录也能被查询,虽然语义上可能有歧义
     */
    test("returns directory size", async () => {
      await using tmp = await tmpdir()
      const dirpath = path.join(tmp.path, "testdir")
      await fs.mkdir(dirpath)

      // Directories have size on some systems
      const size = await Filesystem.size(dirpath)
      expect(typeof size).toBe("number")
    })
  })

  /**
   * 测试 readText() 方法 - 读取文本文件内容
   * 
   * 验证:
   * - 能正确读取UTF-8文本文件
   * - 不存在的文件抛出异常
   * - 正确处理Unicode字符(中文、emoji等)
   */
  describe("readText()", () => {
    /**
     * 测试: 读取普通文本文件
     * 场景: 创建文本文件并读取
     * 预期: 返回与写入时相同的内容
     * 目的: 验证基本文本读取功能
     */
    test("reads file content", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "test.txt")
      const content = "Hello, World!"
      await fs.writeFile(filepath, content, "utf-8")

      expect(await Filesystem.readText(filepath)).toBe(content)
    })

    /**
     * 测试: 读取不存在的文件
     * 场景: 尝试读取未创建的文件
     * 预期: 抛出异常
     * 目的: 验证错误处理,不存在文件应明确报错而非静默失败
     */
    test("throws for non-existent file", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "does-not-exist.txt")

      await expect(Filesystem.readText(filepath)).rejects.toThrow()
    })

    /**
     * 测试: 读取UTF-8编码的Unicode内容
     * 场景: 包含中文和emoji的文本
     * 预期: 正确读取并保持Unicode字符不变
     * 目的: 验证UTF-8编码处理正确,支持国际化内容
     */
    test("reads UTF-8 content correctly", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "unicode.txt")
      const content = "Hello 世界 🌍"
      await fs.writeFile(filepath, content, "utf-8")

      expect(await Filesystem.readText(filepath)).toBe(content)
    })
  })

  /**
   * 测试 readJson() 方法 - 读取并解析JSON文件
   * 
   * 验证:
   * - 能正确解析JSON格式
   * - 无效JSON抛出异常
   * - 支持TypeScript泛型类型推断
   * - 不存在的文件抛出异常
   */
  describe("readJson()", () => {
    /**
     * 测试: 读取并解析JSON文件
     * 场景: 创建包含嵌套对象的JSON文件
     * 预期: 返回解析后的JavaScript对象,结构完全一致
     * 目的: 验证JSON解析功能,包括复杂嵌套结构
     */
    test("reads and parses JSON", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "test.json")
      const data = { key: "value", nested: { array: [1, 2, 3] } }
      await fs.writeFile(filepath, JSON.stringify(data), "utf-8")

      const result: typeof data = await Filesystem.readJson(filepath)
      expect(result).toEqual(data)
    })

    /**
     * 测试: 读取无效JSON文件
     * 场景: 文件格式错误的JSON (缺少闭合括号)
     * 预期: 抛出解析错误
     * 目的: 验证JSON语法错误能被正确捕获和处理
     */
    test("throws for invalid JSON", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "invalid.json")
      await fs.writeFile(filepath, "{ invalid json", "utf-8")

      await expect(Filesystem.readJson(filepath)).rejects.toThrow()
    })

    /**
     * 测试: 读取不存在的JSON文件
     * 场景: 尝试读取未创建的JSON文件
     * 预期: 抛出文件不存在错误
     * 目的: 验证文件存在性检查在JSON解析之前
     */
    test("throws for non-existent file", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "does-not-exist.json")

      await expect(Filesystem.readJson(filepath)).rejects.toThrow()
    })

    /**
     * 测试: 读取JSON时使用TypeScript泛型类型
     * 场景: 定义Config接口,读取后获得类型安全的对象
     * 预期: 返回的对象具有正确的类型,可以访问name和version属性
     * 目的: 验证TypeScript类型推断工作正常,提供编译时类型检查
     */
    test("returns typed data", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "typed.json")
      interface Config {
        name: string
        version: number
      }
      const data: Config = { name: "test", version: 1 }
      await fs.writeFile(filepath, JSON.stringify(data), "utf-8")

      const result = await Filesystem.readJson<Config>(filepath)
      expect(result.name).toBe("test")
      expect(result.version).toBe(1)
    })
  })

  /**
   * 测试 readBytes() 方法 - 读取二进制文件
   * 
   * 验证:
   * - 能正确读取二进制数据为Buffer
   * - 不存在的文件抛出异常
   */
  describe("readBytes()", () => {
    /**
     * 测试: 读取文件为Buffer
     * 场景: 创建文本文件并以二进制方式读取
     * 预期: 返回Buffer实例,转换为字符串后与原文一致
     * 目的: 验证二进制读取功能,适用于图片、音频等非文本文件
     */
    test("reads file as buffer", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "test.txt")
      const content = "Hello, World!"
      await fs.writeFile(filepath, content, "utf-8")

      const buffer = await Filesystem.readBytes(filepath)
      expect(buffer).toBeInstanceOf(Buffer)
      expect(buffer.toString("utf-8")).toBe(content)
    })

    /**
     * 测试: 读取不存在的二进制文件
     * 场景: 尝试读取未创建的文件
     * 预期: 抛出异常
     * 目的: 验证错误处理一致性
     */
    test("throws for non-existent file", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "does-not-exist.bin")

      await expect(Filesystem.readBytes(filepath)).rejects.toThrow()
    })
  })

  describe("write()", () => {
    test("writes text content", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "test.txt")
      const content = "Hello, World!"

      await Filesystem.write(filepath, content)

      expect(await fs.readFile(filepath, "utf-8")).toBe(content)
    })

    test("writes buffer content", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "test.bin")
      const content = Buffer.from([0x00, 0x01, 0x02, 0x03])

      await Filesystem.write(filepath, content)

      const read = await fs.readFile(filepath)
      expect(read).toEqual(content)
    })

    test("writes with permissions", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "protected.txt")
      const content = "secret"

      await Filesystem.write(filepath, content, 0o600)

      const stats = await fs.stat(filepath)
      // Check permissions on Unix
      if (process.platform !== "win32") {
        expect(stats.mode & 0o777).toBe(0o600)
      }
    })

    test("creates parent directories", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "nested", "deep", "file.txt")
      const content = "nested content"

      await Filesystem.write(filepath, content)

      expect(await fs.readFile(filepath, "utf-8")).toBe(content)
    })
  })

  describe("writeJson()", () => {
    test("writes JSON data", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "data.json")
      const data = { key: "value", number: 42 }

      await Filesystem.writeJson(filepath, data)

      const content = await fs.readFile(filepath, "utf-8")
      expect(JSON.parse(content)).toEqual(data)
    })

    test("writes formatted JSON", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "pretty.json")
      const data = { key: "value" }

      await Filesystem.writeJson(filepath, data)

      const content = await fs.readFile(filepath, "utf-8")
      expect(content).toContain("\n")
      expect(content).toContain("  ")
    })

    test("writes with permissions", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "config.json")
      const data = { secret: "data" }

      await Filesystem.writeJson(filepath, data, 0o600)

      const stats = await fs.stat(filepath)
      if (process.platform !== "win32") {
        expect(stats.mode & 0o777).toBe(0o600)
      }
    })
  })

  describe("mimeType()", () => {
    test("returns correct MIME type for JSON", () => {
      expect(Filesystem.mimeType("test.json")).toContain("application/json")
    })

    test("returns correct MIME type for JavaScript", () => {
      expect(Filesystem.mimeType("test.js")).toContain("javascript")
    })

    test("returns MIME type for TypeScript (or video/mp2t due to extension conflict)", () => {
      const mime = Filesystem.mimeType("test.ts")
      // .ts is ambiguous: TypeScript vs MPEG-2 TS video
      expect(mime === "video/mp2t" || mime === "application/typescript" || mime === "text/typescript").toBe(true)
    })

    test("returns correct MIME type for images", () => {
      expect(Filesystem.mimeType("test.png")).toContain("image/png")
      expect(Filesystem.mimeType("test.jpg")).toContain("image/jpeg")
    })

    test("returns default for unknown extension", () => {
      expect(Filesystem.mimeType("test.unknown")).toBe("application/octet-stream")
    })

    test("handles files without extension", () => {
      expect(Filesystem.mimeType("Makefile")).toBe("application/octet-stream")
    })
  })

  describe("windowsPath()", () => {
    test("converts Git Bash paths", () => {
      if (process.platform === "win32") {
        expect(Filesystem.windowsPath("/c/Users/test")).toBe("C:/Users/test")
        expect(Filesystem.windowsPath("/d/dev/project")).toBe("D:/dev/project")
      } else {
        expect(Filesystem.windowsPath("/c/Users/test")).toBe("/c/Users/test")
      }
    })

    test("converts Cygwin paths", () => {
      if (process.platform === "win32") {
        expect(Filesystem.windowsPath("/cygdrive/c/Users/test")).toBe("C:/Users/test")
        expect(Filesystem.windowsPath("/cygdrive/x/dev/project")).toBe("X:/dev/project")
      } else {
        expect(Filesystem.windowsPath("/cygdrive/c/Users/test")).toBe("/cygdrive/c/Users/test")
      }
    })

    test("converts WSL paths", () => {
      if (process.platform === "win32") {
        expect(Filesystem.windowsPath("/mnt/c/Users/test")).toBe("C:/Users/test")
        expect(Filesystem.windowsPath("/mnt/z/dev/project")).toBe("Z:/dev/project")
      } else {
        expect(Filesystem.windowsPath("/mnt/c/Users/test")).toBe("/mnt/c/Users/test")
      }
    })

    test("ignores normal Windows paths", () => {
      expect(Filesystem.windowsPath("C:/Users/test")).toBe("C:/Users/test")
      expect(Filesystem.windowsPath("D:\\dev\\project")).toBe("D:\\dev\\project")
    })
  })

  describe("writeStream()", () => {
    test("writes from Web ReadableStream", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "streamed.txt")
      const content = "Hello from stream!"
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(content))
          controller.close()
        },
      })

      await Filesystem.writeStream(filepath, stream)

      expect(await fs.readFile(filepath, "utf-8")).toBe(content)
    })

    test("writes from Node.js Readable stream", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "node-streamed.txt")
      const content = "Hello from Node stream!"
      const { Readable } = await import("stream")
      const stream = Readable.from([content])

      await Filesystem.writeStream(filepath, stream)

      expect(await fs.readFile(filepath, "utf-8")).toBe(content)
    })

    test("writes binary data from Web ReadableStream", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "binary.dat")
      const binaryData = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xff])
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(binaryData)
          controller.close()
        },
      })

      await Filesystem.writeStream(filepath, stream)

      const read = await fs.readFile(filepath)
      expect(Buffer.from(read)).toEqual(Buffer.from(binaryData))
    })

    test("writes large content in chunks", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "large.txt")
      const chunks = ["chunk1", "chunk2", "chunk3", "chunk4", "chunk5"]
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(new TextEncoder().encode(chunk))
          }
          controller.close()
        },
      })

      await Filesystem.writeStream(filepath, stream)

      expect(await fs.readFile(filepath, "utf-8")).toBe(chunks.join(""))
    })

    test("creates parent directories", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "nested", "deep", "streamed.txt")
      const content = "nested stream content"
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(content))
          controller.close()
        },
      })

      await Filesystem.writeStream(filepath, stream)

      expect(await fs.readFile(filepath, "utf-8")).toBe(content)
    })

    test("writes with permissions", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "protected-stream.txt")
      const content = "secret stream content"
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(content))
          controller.close()
        },
      })

      await Filesystem.writeStream(filepath, stream, 0o600)

      const stats = await fs.stat(filepath)
      if (process.platform !== "win32") {
        expect(stats.mode & 0o777).toBe(0o600)
      }
    })

    test("writes executable with permissions", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "script.sh")
      const content = "#!/bin/bash\necho hello"
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(content))
          controller.close()
        },
      })

      await Filesystem.writeStream(filepath, stream, 0o755)

      const stats = await fs.stat(filepath)
      if (process.platform !== "win32") {
        expect(stats.mode & 0o777).toBe(0o755)
      }
      expect(await fs.readFile(filepath, "utf-8")).toBe(content)
    })
  })

  describe("resolve()", () => {
    test("resolves slash-prefixed drive paths on Windows", async () => {
      if (process.platform !== "win32") return
      await using tmp = await tmpdir()
      const forward = tmp.path.replaceAll("\\", "/")
      expect(Filesystem.resolve(`/${forward}`)).toBe(Filesystem.normalizePath(tmp.path))
    })

    test("resolves slash-prefixed drive roots on Windows", async () => {
      if (process.platform !== "win32") return
      await using tmp = await tmpdir()
      const drive = tmp.path[0].toUpperCase()
      expect(Filesystem.resolve(`/${drive}:`)).toBe(Filesystem.resolve(`${drive}:/`))
    })

    test("resolves Git Bash and MSYS2 paths on Windows", async () => {
      // Git Bash and MSYS2 both use /<drive>/... paths on Windows.
      if (process.platform !== "win32") return
      await using tmp = await tmpdir()
      const drive = tmp.path[0].toLowerCase()
      const rest = tmp.path.slice(2).replaceAll("\\", "/")
      expect(Filesystem.resolve(`/${drive}${rest}`)).toBe(Filesystem.normalizePath(tmp.path))
    })

    test("resolves Git Bash and MSYS2 drive roots on Windows", async () => {
      // Git Bash and MSYS2 both use /<drive> paths on Windows.
      if (process.platform !== "win32") return
      await using tmp = await tmpdir()
      const drive = tmp.path[0].toLowerCase()
      expect(Filesystem.resolve(`/${drive}`)).toBe(Filesystem.resolve(`${drive.toUpperCase()}:/`))
    })

    test("resolves Cygwin paths on Windows", async () => {
      if (process.platform !== "win32") return
      await using tmp = await tmpdir()
      const drive = tmp.path[0].toLowerCase()
      const rest = tmp.path.slice(2).replaceAll("\\", "/")
      expect(Filesystem.resolve(`/cygdrive/${drive}${rest}`)).toBe(Filesystem.normalizePath(tmp.path))
    })

    test("resolves Cygwin drive roots on Windows", async () => {
      if (process.platform !== "win32") return
      await using tmp = await tmpdir()
      const drive = tmp.path[0].toLowerCase()
      expect(Filesystem.resolve(`/cygdrive/${drive}`)).toBe(Filesystem.resolve(`${drive.toUpperCase()}:/`))
    })

    test("resolves WSL mount paths on Windows", async () => {
      if (process.platform !== "win32") return
      await using tmp = await tmpdir()
      const drive = tmp.path[0].toLowerCase()
      const rest = tmp.path.slice(2).replaceAll("\\", "/")
      expect(Filesystem.resolve(`/mnt/${drive}${rest}`)).toBe(Filesystem.normalizePath(tmp.path))
    })

    test("resolves WSL mount roots on Windows", async () => {
      if (process.platform !== "win32") return
      await using tmp = await tmpdir()
      const drive = tmp.path[0].toLowerCase()
      expect(Filesystem.resolve(`/mnt/${drive}`)).toBe(Filesystem.resolve(`${drive.toUpperCase()}:/`))
    })

    test("resolves symlinked directory to canonical path", async () => {
      await using tmp = await tmpdir()
      const target = path.join(tmp.path, "real")
      await fs.mkdir(target)
      const link = path.join(tmp.path, "link")
      await fs.symlink(target, link)
      expect(Filesystem.resolve(link)).toBe(Filesystem.resolve(target))
    })

    test("returns unresolved path when target does not exist", async () => {
      await using tmp = await tmpdir()
      const missing = path.join(tmp.path, "does-not-exist-" + Date.now())
      const result = Filesystem.resolve(missing)
      expect(result).toBe(Filesystem.normalizePath(path.resolve(missing)))
    })

    test("throws ELOOP on symlink cycle", async () => {
      await using tmp = await tmpdir()
      const a = path.join(tmp.path, "a")
      const b = path.join(tmp.path, "b")
      await fs.symlink(b, a)
      await fs.symlink(a, b)
      expect(() => Filesystem.resolve(a)).toThrow()
    })

    // Windows: chmod(0o000) is a no-op, so EACCES cannot be triggered
    test("throws EACCES on permission-denied symlink target", async () => {
      if (process.platform === "win32") return
      if (process.getuid?.() === 0) return // skip when running as root
      await using tmp = await tmpdir()
      const dir = path.join(tmp.path, "restricted")
      await fs.mkdir(dir)
      const link = path.join(tmp.path, "link")
      await fs.symlink(dir, link)
      await fs.chmod(dir, 0o000)
      try {
        expect(() => Filesystem.resolve(path.join(link, "child"))).toThrow()
      } finally {
        await fs.chmod(dir, 0o755)
      }
    })

    // Windows: traversing through a file throws ENOENT (not ENOTDIR),
    // which resolve() catches as a fallback instead of rethrowing
    test("rethrows non-ENOENT errors", async () => {
      if (process.platform === "win32") return
      await using tmp = await tmpdir()
      const file = path.join(tmp.path, "not-a-directory")
      await fs.writeFile(file, "x")
      expect(() => Filesystem.resolve(path.join(file, "child"))).toThrow()
    })
  })

  describe("normalizePathPattern()", () => {
    test("preserves drive root globs on Windows", async () => {
      if (process.platform !== "win32") return
      await using tmp = await tmpdir()
      const root = path.parse(tmp.path).root
      expect(Filesystem.normalizePathPattern(path.join(root, "*"))).toBe(path.join(root, "*"))
    })
  })
})
