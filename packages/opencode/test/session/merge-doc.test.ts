import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"

describe("docs: merge-and-conflict-resolution.md exists", () => {
  test("document exists and has header", async () => {
    const p = path.join(process.cwd(), "..", "..", "docs", "merge-and-conflict-resolution.md")
    const txt = await fs.readFile(p, "utf8")
    expect(txt.includes("# 子任务结果合并与冲突解决")).toBe(true)
  })
})

