import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Patch } from "../../src/patch"
import * as fs from "fs/promises"
import * as path from "path"
import { tmpdir } from "os"

/**
 * Patch 模块测试套件
 * 
 * 测试目标：
 * - 验证 Patch.parsePatch() 能正确解析各种格式的 patch 文本
 * - 验证 Patch.maybeParseApplyPatch() 能识别不同类型的 apply_patch 命令
 * - 验证 Patch.applyPatch() 能正确执行文件增删改操作
 * - 确保边界情况和错误处理的健壮性
 * 
 * Patch 格式说明：
 * ```
 * *** Begin Patch
 * *** Add File: filepath.txt      # 添加新文件
 * +content line                   # 以 + 开头的行是新增内容
 * *** Update File: filepath.txt   # 更新现有文件
 * @@                             # 差异块开始标记
 *  context line                   # 上下文行（不变）
 * -old line                       # 删除的行
 * +new line                       # 新增的行
 * *** Move to: newpath.txt        # 移动文件（配合 Update 使用）
 * *** Delete File: filepath.txt   # 删除文件
 * *** End Patch
 * ```
 */
describe("Patch namespace", () => {
  let tempDir: string

  // 每个测试前创建临时目录
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(tmpdir(), "patch-test-"))
  })

  // 每个测试后清理临时目录
  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  /**
   * 测试组：parsePatch - Patch 文本解析
   * 
   * 测试目的：
   * - 验证能将 patch 文本正确解析为结构化的 hunks 数组
   * - 支持多种操作类型：add、update、delete、move
   * - 能识别并拒绝无效的 patch 格式
   */
  describe("parsePatch", () => {
    /**
     * 测试用例：解析简单的添加文件 patch
     * 
     * 验证点：
     * - 能识别 "*** Add File:" 指令
     * - 正确提取文件路径和内容
     * - 生成的 hunk 类型为 "add"
     */
    test("should parse simple add file patch", () => {
      const patchText = `*** Begin Patch
*** Add File: test.txt
+Hello World
*** End Patch`

      const result = Patch.parsePatch(patchText)
      expect(result.hunks).toHaveLength(1)
      expect(result.hunks[0]).toEqual({
        type: "add",
        path: "test.txt",
        contents: "Hello World",
      })
    })

    /**
     * 测试用例：解析删除文件 patch
     * 
     * 验证点：
     * - 能识别 "*** Delete File:" 指令
     * - 正确提取文件路径
     * - 生成的 hunk 类型为 "delete"
     */
    test("should parse delete file patch", () => {
      const patchText = `*** Begin Patch
*** Delete File: old.txt
*** End Patch`

      const result = Patch.parsePatch(patchText)
      expect(result.hunks).toHaveLength(1)
      const hunk = result.hunks[0]
      expect(hunk.type).toBe("delete")
      expect(hunk.path).toBe("old.txt")
    })

    /**
     * 测试用例：解析包含多个 hunks 的 patch
     * 
     * 验证点：
     * - 能在一个 patch 中处理多个操作
     * - 正确区分 add 和 update 类型
     * - 保持 hunks 的顺序
     */
    test("should parse patch with multiple hunks", () => {
      const patchText = `*** Begin Patch
*** Add File: new.txt
+This is a new file
*** Update File: existing.txt
@@
 old line
-new line
+updated line
*** End Patch`

      const result = Patch.parsePatch(patchText)
      expect(result.hunks).toHaveLength(2)
      expect(result.hunks[0].type).toBe("add")
      expect(result.hunks[1].type).toBe("update")
    })

    /**
     * 测试用例：解析文件移动操作
     * 
     * 验证点：
     * - 能识别 "*** Move to:" 指令
     * - move_path 字段正确设置
     * - 原路径和新路径都能正确提取
     * 
     * 使用场景：
     * - 文件重命名
     * - 文件移动到不同目录
     */
    test("should parse file move operation", () => {
      const patchText = `*** Begin Patch
*** Update File: old-name.txt
*** Move to: new-name.txt
@@
-Old content
+New content
*** End Patch`

      const result = Patch.parsePatch(patchText)
      expect(result.hunks).toHaveLength(1)
      const hunk = result.hunks[0]
      expect(hunk.type).toBe("update")
      expect(hunk.path).toBe("old-name.txt")
      if (hunk.type === "update") {
        expect(hunk.move_path).toBe("new-name.txt")
      }
    })

    /**
     * 测试用例：无效 patch 格式的错误处理
     * 
     * 验证点：
     * - 缺少 "*** Begin Patch" 标记应抛出错误
     * - 错误消息清晰明确
     */
    test("should throw error for invalid patch format", () => {
      const invalidPatch = `This is not a valid patch`

      expect(() => Patch.parsePatch(invalidPatch)).toThrow("Invalid patch format")
    })
  })

  /**
   * 测试组：maybeParseApplyPatch - 命令识别与解析
   * 
   * 测试目的：
   * - 验证能从不同类型的命令中提取 patch 内容
   * - 支持直接调用、bash 脚本等多种格式
   * - 能正确识别非 patch 命令并返回 NotApplyPatch
   * 
   * 支持的命令格式：
   * 1. ["apply_patch", patchText] - 直接调用
   * 2. ["applypatch", patchText] - 简写形式
   * 3. ["bash", "-lc", script] - bash heredoc 格式
   */
  describe("maybeParseApplyPatch", () => {
    /**
     * 测试用例：解析直接的 apply_patch 命令
     * 
     * 验证点：
     * - 识别 "apply_patch" 命令
     * - 正确提取 patch 文本参数
     * - 返回类型为 Body 并包含解析后的 hunks
     */
    test("should parse direct apply_patch command", () => {
      const patchText = `*** Begin Patch
*** Add File: test.txt
+Content
*** End Patch`

      const result = Patch.maybeParseApplyPatch(["apply_patch", patchText])
      expect(result.type).toBe(Patch.MaybeApplyPatch.Body)
      if (result.type === Patch.MaybeApplyPatch.Body) {
        expect(result.args.patch).toBe(patchText)
        expect(result.args.hunks).toHaveLength(1)
      }
    })

    /**
     * 测试用例：解析 applypatch 简写命令
     * 
     * 验证点：
     * - 支持不带下划线的简写形式
     * - 行为与 apply_patch 一致
     */
    test("should parse applypatch command", () => {
      const patchText = `*** Begin Patch
*** Add File: test.txt
+Content
*** End Patch`

      const result = Patch.maybeParseApplyPatch(["applypatch", patchText])
      expect(result.type).toBe(Patch.MaybeApplyPatch.Body)
    })

    /**
     * 测试用例：处理 bash heredoc 格式
     * 
     * 验证点：
     * - 能从 bash 脚本中提取 heredoc 内容
     * - 正确解析嵌入的 patch 文本
     * 
     * 使用场景：
     * - AI Agent 通过 shell 命令应用 patch
     * - 多行 patch 内容的传递
     */
    test("should handle bash heredoc format", () => {
      const script = `apply_patch <<'PATCH'
*** Begin Patch
*** Add File: test.txt
+Content
*** End Patch
PATCH`

      const result = Patch.maybeParseApplyPatch(["bash", "-lc", script])
      expect(result.type).toBe(Patch.MaybeApplyPatch.Body)
      if (result.type === Patch.MaybeApplyPatch.Body) {
        expect(result.args.hunks).toHaveLength(1)
      }
    })

    /**
     * 测试用例：识别非 patch 命令
     * 
     * 验证点：
     * - 普通命令应返回 NotApplyPatch
     * - 不会误判为 patch 命令
     */
    test("should return NotApplyPatch for non-patch commands", () => {
      const result = Patch.maybeParseApplyPatch(["echo", "hello"])
      expect(result.type).toBe(Patch.MaybeApplyPatch.NotApplyPatch)
    })
  })

  /**
   * 测试组：applyPatch - Patch 应用执行
   * 
   * 测试目的：
   * - 验证能正确执行文件系统的增删改操作
   * - 确认返回结果准确反映实际变更
   * - 测试复杂场景如移动文件、多层目录创建等
   */
  describe("applyPatch", () => {
    /**
     * 测试用例：添加新文件
     * 
     * 验证点：
     * - 创建不存在的文件
     * - 文件内容完全匹配 patch 中的定义
     * - 返回结果中 added 数组包含新文件路径
     * - modified 和 deleted 数组为空
     */
    test("should add a new file", async () => {
      const patchText = `*** Begin Patch
*** Add File: ${tempDir}/new-file.txt
+Hello World
+This is a new file
*** End Patch`

      const result = await Patch.applyPatch(patchText)
      expect(result.added).toHaveLength(1)
      expect(result.modified).toHaveLength(0)
      expect(result.deleted).toHaveLength(0)

      const content = await fs.readFile(result.added[0], "utf-8")
      expect(content).toBe("Hello World\nThis is a new file")
    })

    /**
     * 测试用例：删除现有文件
     * 
     * 验证点：
     * - 成功删除已存在的文件
     * - 返回结果中 deleted 数组包含被删文件路径
     * - 文件确实从文件系统中移除
     */
    test("should delete an existing file", async () => {
      const filePath = path.join(tempDir, "to-delete.txt")
      await fs.writeFile(filePath, "This file will be deleted")

      const patchText = `*** Begin Patch
*** Delete File: ${filePath}
*** End Patch`

      const result = await Patch.applyPatch(patchText)
      expect(result.deleted).toHaveLength(1)
      expect(result.deleted[0]).toBe(filePath)

      // 验证文件已被删除
      const exists = await fs
        .access(filePath)
        .then(() => true)
        .catch(() => false)
      expect(exists).toBe(false)
    })

    /**
     * 测试用例：更新现有文件
     * 
     * 验证点：
     * - 根据差异块正确修改文件内容
     * - 上下文行保持不变
     * - 删除的行被替换为新增的行
     * - 返回结果中 modified 数组包含修改的文件路径
     * 
     * 技术细节：
     * - @@ 标记差异块开始
     * - 空格开头的行是上下文（不变）
     * - - 开头的行是要删除的
     * - + 开头的行是要添加的
     */
    test("should update an existing file", async () => {
      const filePath = path.join(tempDir, "to-update.txt")
      await fs.writeFile(filePath, "line 1\nline 2\nline 3\n")

      const patchText = `*** Begin Patch
*** Update File: ${filePath}
@@
 line 1
-line 2
+line 2 updated
 line 3
*** End Patch`

      const result = await Patch.applyPatch(patchText)
      expect(result.modified).toHaveLength(1)
      expect(result.modified[0]).toBe(filePath)

      const content = await fs.readFile(filePath, "utf-8")
      expect(content).toBe("line 1\nline 2 updated\nline 3\n")
    })

    /**
     * 测试用例：移动并更新文件
     * 
     * 验证点：
     * - 文件从旧路径移动到新路径
     * - 同时应用内容更新
     * - 旧路径的文件被删除
     * - 新路径的文件存在且内容正确
     * 
     * 使用场景：
     * - 重构代码时重命名文件
     * - 调整项目目录结构
     */
    test("should move and update a file", async () => {
      const oldPath = path.join(tempDir, "old-name.txt")
      const newPath = path.join(tempDir, "new-name.txt")
      await fs.writeFile(oldPath, "old content\n")

      const patchText = `*** Begin Patch
*** Update File: ${oldPath}
*** Move to: ${newPath}
@@
-old content
+new content
*** End Patch`

      const result = await Patch.applyPatch(patchText)
      expect(result.modified).toHaveLength(1)
      expect(result.modified[0]).toBe(newPath)

      // 验证旧文件已不存在
      const oldExists = await fs
        .access(oldPath)
        .then(() => true)
        .catch(() => false)
      expect(oldExists).toBe(false)

      // 验证新文件内容正确
      const newContent = await fs.readFile(newPath, "utf-8")
      expect(newContent).toBe("new content\n")
    })

    /**
     * 测试用例：在一个 patch 中执行多个操作
     * 
     * 验证点：
     * - 同时处理 add、update、delete 三种操作
     * - 所有操作都成功执行
     * - 返回结果准确反映每种操作的文件列表
     * 
     * 使用场景：
     * - 批量文件重构
     * - 复杂的项目结构调整
     */
    test("should handle multiple operations in one patch", async () => {
      const file1 = path.join(tempDir, "file1.txt")
      const file2 = path.join(tempDir, "file2.txt")
      const file3 = path.join(tempDir, "file3.txt")

      await fs.writeFile(file1, "content 1")
      await fs.writeFile(file2, "content 2")

      const patchText = `*** Begin Patch
*** Add File: ${file3}
+new file content
*** Update File: ${file1}
@@
-content 1
+updated content 1
*** Delete File: ${file2}
*** End Patch`

      const result = await Patch.applyPatch(patchText)
      expect(result.added).toHaveLength(1)
      expect(result.modified).toHaveLength(1)
      expect(result.deleted).toHaveLength(1)
    })

    /**
     * 测试用例：添加文件时自动创建父目录
     * 
     * 验证点：
     * - 当目标文件的父目录不存在时，自动创建
     * - 支持多层嵌套目录的创建
     * - 文件成功写入深层目录
     * 
     * 技术细节：
     * - 相当于执行 mkdir -p deep/nested/
     * - 避免因目录不存在而失败
     */
    test("should create parent directories when adding files", async () => {
      const nestedPath = path.join(tempDir, "deep", "nested", "file.txt")

      const patchText = `*** Begin Patch
*** Add File: ${nestedPath}
+Deep nested content
*** End Patch`

      const result = await Patch.applyPatch(patchText)
      expect(result.added).toHaveLength(1)
      expect(result.added[0]).toBe(nestedPath)

      const exists = await fs
        .access(nestedPath)
        .then(() => true)
        .catch(() => false)
      expect(exists).toBe(true)
    })
  })

  /**
   * 测试组：错误处理
   * 
   * 测试目的：
   * - 验证在无效操作时能正确抛出错误
   * - 确保不会静默失败或产生意外行为
   * - 保护文件系统免受破坏性操作
   */
  describe("error handling", () => {
    /**
     * 测试用例：更新不存在的文件时应抛出错误
     * 
     * 验证点：
     * - Update File 操作要求文件必须存在
     * - 对不存在的文件执行更新应拒绝
     * - 防止误操作创建新文件（应该用 Add File）
     */
    test("should throw error when updating non-existent file", async () => {
      const nonExistent = path.join(tempDir, "does-not-exist.txt")

      const patchText = `*** Begin Patch
*** Update File: ${nonExistent}
@@
-old line
+new line
*** End Patch`

      await expect(Patch.applyPatch(patchText)).rejects.toThrow()
    })

    /**
     * 测试用例：删除不存在的文件时应抛出错误
     * 
     * 验证点：
     * - Delete File 操作要求文件必须存在
     * - 对不存在的文件执行删除应拒绝
     * - 避免因拼写错误导致误删其他文件
     */
    test("should throw error when deleting non-existent file", async () => {
      const nonExistent = path.join(tempDir, "does-not-exist.txt")

      const patchText = `*** Begin Patch
*** Delete File: ${nonExistent}
*** End Patch`

      await expect(Patch.applyPatch(patchText)).rejects.toThrow()
    })
  })

  /**
   * 测试组：边界情况
   * 
   * 测试目的：
   * - 验证在各种边缘场景下的健壮性
   * - 确保特殊文件格式能正确处理
   * - 测试复杂的多块差异应用
   */
  describe("edge cases", () => {
    /**
     * 测试用例：处理空文件
     * 
     * 验证点：
     * - 能对空文件执行更新操作
     * - 向空文件添加内容正常工作
     * - 没有上下文行时也能正确应用差异
     */
    test("should handle empty files", async () => {
      const emptyFile = path.join(tempDir, "empty.txt")
      await fs.writeFile(emptyFile, "")

      const patchText = `*** Begin Patch
*** Update File: ${emptyFile}
@@
+First line
*** End Patch`

      const result = await Patch.applyPatch(patchText)
      expect(result.modified).toHaveLength(1)

      const content = await fs.readFile(emptyFile, "utf-8")
      expect(content).toBe("First line\n")
    })

    /**
     * 测试用例：处理没有尾随换行符的文件
     * 
     * 验证点：
     * - 能正确处理不以换行符结尾的文件
     * - 替换后自动添加换行符
     * - 符合 POSIX 文本文件规范
     * 
     * 技术细节：
     * - Unix/Linux 要求文本文件以换行符结尾
     * - 许多工具（如 git diff）会警告缺少尾随换行
     */
    test("should handle files with no trailing newline", async () => {
      const filePath = path.join(tempDir, "no-newline.txt")
      await fs.writeFile(filePath, "no newline")

      const patchText = `*** Begin Patch
*** Update File: ${filePath}
@@
-no newline
+has newline now
*** End Patch`

      const result = await Patch.applyPatch(patchText)
      expect(result.modified).toHaveLength(1)

      const content = await fs.readFile(filePath, "utf-8")
      expect(content).toBe("has newline now\n")
    })

    /**
     * 测试用例：处理单个文件中的多个更新块
     * 
     * 验证点：
     * - 能在一个文件中应用多个 @@ 差异块
     * - 每个差异块独立应用，互不影响
     * - 最终结果是所有块的累积效果
     * 
     * 使用场景：
     * - 修改函数中多处代码
     * - 在不同位置添加注释或日志
     * - 重构时分散的改动
     * 
     * 技术细节：
     * - 第一个 @@ 块修改 line 2 -> LINE 2
     * - 第二个 @@ 块修改 line 4 -> LINE 4
     * - 两个块之间有未修改的行作为分隔
     */
    test("should handle multiple update chunks in single file", async () => {
      const filePath = path.join(tempDir, "multi-chunk.txt")
      await fs.writeFile(filePath, "line 1\nline 2\nline 3\nline 4\n")

      const patchText = `*** Begin Patch
*** Update File: ${filePath}
@@
 line 1
-line 2
+LINE 2
@@
 line 3
-line 4
+LINE 4
*** End Patch`

      const result = await Patch.applyPatch(patchText)
      expect(result.modified).toHaveLength(1)

      const content = await fs.readFile(filePath, "utf-8")
      expect(content).toBe("line 1\nLINE 2\nline 3\nLINE 4\n")
    })
  })
})
