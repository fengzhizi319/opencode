import { describe, test, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Glob } from "../../src/util/glob"
import { tmpdir } from "../fixture/fixture"

// 测试 Glob 工具类，提供文件模式匹配和扫描功能
describe("Glob", () => {
  // 测试异步文件扫描方法 scan()
  describe("scan()", () => {
    // 测试基本的文件模式匹配功能
    test("finds files matching pattern", async () => {
      await using tmp = await tmpdir()
      // 创建测试文件：两个 .txt 文件和一个 .md 文件
      await fs.writeFile(path.join(tmp.path, "a.txt"), "", "utf-8")
      await fs.writeFile(path.join(tmp.path, "b.txt"), "", "utf-8")
      await fs.writeFile(path.join(tmp.path, "c.md"), "", "utf-8")

      // 使用 *.txt 模式扫描，应只匹配到 .txt 文件
      const results = await Glob.scan("*.txt", { cwd: tmp.path })

      expect(results.sort()).toEqual(["a.txt", "b.txt"])
    })

    // 测试返回绝对路径的功能
    test("returns absolute paths when absolute option is true", async () => {
      await using tmp = await tmpdir()
      await fs.writeFile(path.join(tmp.path, "file.txt"), "", "utf-8")

      // 设置 absolute: true 选项，应返回完整路径而非相对路径
      const results = await Glob.scan("*.txt", { cwd: tmp.path, absolute: true })

      expect(results[0]).toBe(path.join(tmp.path, "file.txt"))
    })

    // 测试默认情况下排除目录的行为
    test("excludes directories by default", async () => {
      await using tmp = await tmpdir()
      // 创建一个子目录和一个文件
      await fs.mkdir(path.join(tmp.path, "subdir"))
      await fs.writeFile(path.join(tmp.path, "file.txt"), "", "utf-8")

      // 使用 * 通配符，默认应只返回文件，不包括目录
      const results = await Glob.scan("*", { cwd: tmp.path })

      expect(results).toEqual(["file.txt"])
    })

    // 测试显式设置 include: 'file' 时排除目录
    test("excludes directories when include is 'file'", async () => {
      await using tmp = await tmpdir()
      await fs.mkdir(path.join(tmp.path, "subdir"))
      await fs.writeFile(path.join(tmp.path, "file.txt"), "", "utf-8")

      // 明确指定 include: 'file'，应只返回文件
      const results = await Glob.scan("*", { cwd: tmp.path, include: "file" })

      expect(results).toEqual(["file.txt"])
    })

    // 测试 include: 'all' 时同时包含文件和目录
    test("includes directories when include is 'all'", async () => {
      await using tmp = await tmpdir()
      await fs.mkdir(path.join(tmp.path, "subdir"))
      await fs.writeFile(path.join(tmp.path, "file.txt"), "", "utf-8")

      // 设置 include: 'all'，应同时返回文件和目录
      const results = await Glob.scan("*", { cwd: tmp.path, include: "all" })

      expect(results.sort()).toEqual(["file.txt", "subdir"])
    })

    // 测试递归嵌套模式匹配（** 通配符）
    test("handles nested patterns", async () => {
      await using tmp = await tmpdir()
      // 创建嵌套目录结构
      await fs.mkdir(path.join(tmp.path, "nested"), { recursive: true })
      await fs.writeFile(path.join(tmp.path, "nested", "deep.txt"), "", "utf-8")

      // 使用 **/*.txt 模式递归匹配所有层级的 .txt 文件
      const results = await Glob.scan("**/*.txt", { cwd: tmp.path })

      expect(results).toEqual([path.join("nested", "deep.txt")])
    })

    // 测试无匹配结果时返回空数组
    test("returns empty array for no matches", async () => {
      await using tmp = await tmpdir()

      // 扫描不存在的文件类型，应返回空数组而非抛出错误
      const results = await Glob.scan("*.nonexistent", { cwd: tmp.path })

      expect(results).toEqual([])
    })

    // 测试默认情况下不跟随符号链接
    test("does not follow symlinks by default", async () => {
      await using tmp = await tmpdir()
      // 创建真实目录和文件
      await fs.mkdir(path.join(tmp.path, "realdir"))
      await fs.writeFile(path.join(tmp.path, "realdir", "file.txt"), "", "utf-8")
      // 创建指向真实目录的符号链接
      await fs.symlink(path.join(tmp.path, "realdir"), path.join(tmp.path, "linkdir"))

      // 默认情况下不应通过符号链接找到文件
      const results = await Glob.scan("**/*.txt", { cwd: tmp.path })

      expect(results).toEqual([path.join("realdir", "file.txt")])
    })

    // 测试启用 symlink 选项时跟随符号链接
    test("follows symlinks when symlink option is true", async () => {
      await using tmp = await tmpdir()
      await fs.mkdir(path.join(tmp.path, "realdir"))
      await fs.writeFile(path.join(tmp.path, "realdir", "file.txt"), "", "utf-8")
      await fs.symlink(path.join(tmp.path, "realdir"), path.join(tmp.path, "linkdir"))

      // 设置 symlink: true，应同时从真实目录和符号链接中找到文件
      const results = await Glob.scan("**/*.txt", { cwd: tmp.path, symlink: true })

      expect(results.sort()).toEqual([path.join("linkdir", "file.txt"), path.join("realdir", "file.txt")])
    })

    // 测试启用 dot 选项时包含隐藏文件（以.开头的文件）
    test("includes dotfiles when dot option is true", async () => {
      await using tmp = await tmpdir()
      // 创建隐藏文件和普通文件
      await fs.writeFile(path.join(tmp.path, ".hidden"), "", "utf-8")
      await fs.writeFile(path.join(tmp.path, "visible"), "", "utf-8")

      // 设置 dot: true，应包含隐藏文件
      const results = await Glob.scan("*", { cwd: tmp.path, dot: true })

      expect(results.sort()).toEqual([".hidden", "visible"])
    })

    // 测试禁用 dot 选项时排除隐藏文件
    test("excludes dotfiles when dot option is false", async () => {
      await using tmp = await tmpdir()
      await fs.writeFile(path.join(tmp.path, ".hidden"), "", "utf-8")
      await fs.writeFile(path.join(tmp.path, "visible"), "", "utf-8")

      // 设置 dot: false（默认行为），应排除隐藏文件
      const results = await Glob.scan("*", { cwd: tmp.path, dot: false })

      expect(results).toEqual(["visible"])
    })
  })

  // 测试同步文件扫描方法 scanSync()
  describe("scanSync()", () => {
    // 测试同步版本的基本模式匹配功能
    test("finds files matching pattern synchronously", async () => {
      await using tmp = await tmpdir()
      await fs.writeFile(path.join(tmp.path, "a.txt"), "", "utf-8")
      await fs.writeFile(path.join(tmp.path, "b.txt"), "", "utf-8")

      // 同步调用 scanSync，无需 await
      const results = Glob.scanSync("*.txt", { cwd: tmp.path })

      expect(results.sort()).toEqual(["a.txt", "b.txt"])
    })

    // 测试同步版本也支持所有配置选项
    test("respects options", async () => {
      await using tmp = await tmpdir()
      await fs.mkdir(path.join(tmp.path, "subdir"))
      await fs.writeFile(path.join(tmp.path, "file.txt"), "", "utf-8")

      // 验证同步版本同样支持 include 等选项
      const results = Glob.scanSync("*", { cwd: tmp.path, include: "all" })

      expect(results.sort()).toEqual(["file.txt", "subdir"])
    })
  })

  // 测试静态模式匹配方法 match()，用于检查单个路径是否匹配模式
  describe("match()", () => {
    // 测试简单的通配符模式匹配
    test("matches simple patterns", () => {
      // 验证 *.txt 能正确匹配 .txt 文件
      expect(Glob.match("*.txt", "file.txt")).toBe(true)
      // 验证 *.txt 不会匹配其他扩展名的文件
      expect(Glob.match("*.txt", "file.js")).toBe(false)
    })

    // 测试目录路径的模式匹配
    test("matches directory patterns", () => {
      // 验证 **/*.js 能匹配嵌套目录中的 .js 文件
      expect(Glob.match("**/*.js", "src/index.js")).toBe(true)
      // 验证 **/*.js 不会匹配其他扩展名
      expect(Glob.match("**/*.js", "src/index.ts")).toBe(false)
    })

    // 测试隐藏文件和隐藏目录的匹配
    test("matches dot files", () => {
      // 验证 .* 能匹配隐藏文件
      expect(Glob.match(".*", ".gitignore")).toBe(true)
      // 验证 **/*.md 能匹配隐藏目录中的文件
      expect(Glob.match("**/*.md", ".github/README.md")).toBe(true)
    })

    // 测试花括号展开（brace expansion）功能
    test("matches brace expansion", () => {
      // 验证 *.{js,ts} 能匹配 .js 文件
      expect(Glob.match("*.{js,ts}", "file.js")).toBe(true)
      // 验证 *.{js,ts} 能匹配 .ts 文件
      expect(Glob.match("*.{js,ts}", "file.ts")).toBe(true)
      // 验证 *.{js,ts} 不会匹配其他扩展名
      expect(Glob.match("*.{js,ts}", "file.py")).toBe(false)
    })
  })
})
