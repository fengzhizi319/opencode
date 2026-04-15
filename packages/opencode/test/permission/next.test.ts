import { afterEach, test, expect } from "bun:test"
import os from "os"
import { Bus } from "../../src/bus"
import { Permission } from "../../src/permission"
import { PermissionID } from "../../src/permission/schema"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { MessageID, SessionID } from "../../src/session/schema"

/**
 * 权限系统测试套件 - Permission Module
 * 
 * 测试目标：
 * - 验证权限规则的解析、合并和评估逻辑
 * - 测试权限请求的生命周期（ask → pending → reply）
 * - 确认多会话、多目录的隔离性
 * - 验证边界情况和错误处理
 * 
 * 核心概念：
 * - Ruleset（规则集）：一组权限规则的集合
 * - Rule（规则）：{ permission, pattern, action } 三元组
 * - Action（动作）：allow（允许）、deny（拒绝）、ask（询问）
 * - Pattern（模式）：支持通配符 * 和 glob 模式
 */

// 每个测试后清理所有 Instance，确保状态隔离
afterEach(async () => {
  await Instance.disposeAll()
})

/**
 * 辅助函数：拒绝所有待处理的权限请求
 * @param message 可选的拒绝消息
 */
async function rejectAll(message?: string) {
  for (const req of await Permission.list()) {
    await Permission.reply({
      requestID: req.id,
      reply: "reject",
      message,
    })
  }
}

/**
 * 辅助函数：等待待处理请求数量达到预期值
 * @param count 期望的待处理请求数量
 * @returns 待处理请求列表
 * 
 * 技术细节：
 * - 最多重试 20 次，每次等待一个事件循环
 * - 用于异步操作的同步等待
 */
async function waitForPending(count: number) {
  for (let i = 0; i < 20; i++) {
    const list = await Permission.list()
    if (list.length === count) return list
    await Bun.sleep(0)
  }
  return Permission.list()
}

// ========================================================================
// fromConfig 测试 - 配置文件解析
// ========================================================================

/**
 * 测试用例：字符串值转换为通配符规则
 * 
 * 测试目的：
 * - 验证简写配置格式能被正确解析
 * - 字符串 "allow" 应该展开为 { permission: "bash", pattern: "*", action: "allow" }
 * 
 * 使用场景：
 * 用户配置：{ bash: "allow" }
 * 解析结果：允许所有 bash 命令
 */
test("fromConfig - string value becomes wildcard rule", () => {
  const result = Permission.fromConfig({ bash: "allow" })
  expect(result).toEqual([{ permission: "bash", pattern: "*", action: "allow" }])
})

/**
 * 测试用例：对象值转换为规则数组
 * 
 * 测试目的：
 * - 验证详细配置格式能被正确解析
 * - 对象的每个键值对都应该生成一条规则
 * 
 * 使用场景：
 * 用户配置：{ bash: { "*": "allow", rm: "deny" } }
 * 解析结果：允许所有 bash 命令，但禁止 rm
 */
test("fromConfig - object value converts to rules array", () => {
  const result = Permission.fromConfig({ bash: { "*": "allow", rm: "deny" } })
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm", action: "deny" },
  ])
})

/**
 * 测试用例：混合字符串和对象值
 * 
 * 测试目的：
 * - 验证能同时处理简写和详细两种格式
 * - 不同类型的权限可以混用不同的配置方式
 * 
 * 使用场景：
 * - bash 使用详细配置（细粒度控制）
 * - edit 使用简写配置（全局允许）
 * - webfetch 使用简写配置（全局询问）
 */
test("fromConfig - mixed string and object values", () => {
  const result = Permission.fromConfig({
    bash: { "*": "allow", rm: "deny" },
    edit: "allow",
    webfetch: "ask",
  })
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm", action: "deny" },
    { permission: "edit", pattern: "*", action: "allow" },
    { permission: "webfetch", pattern: "*", action: "ask" },
  ])
})

/**
 * 测试用例：空对象
 * 
 * 测试目的：
 * - 验证空配置返回空规则集
 * - 确保不会因空输入而崩溃
 */
test("fromConfig - empty object", () => {
  const result = Permission.fromConfig({})
  expect(result).toEqual([])
})

/**
 * 测试用例：展开波浪号 ~ 为家目录
 * 
 * 测试目的：
 * - 验证 ~/ 路径前缀能被正确展开为用户家目录
 * - 支持 Unix/Linux/macOS 的标准路径表示法
 * 
 * 技术细节：
 * - os.homedir() 返回当前用户的家目录路径
 * - 只展开开头的 ~，中间的 ~ 保持不变
 * 
 * 使用场景：
 * 用户配置：{ external_directory: { "~/projects/*": "allow" } }
 * 实际匹配：/home/user/projects/* 或 /Users/user/projects/*
 */
test("fromConfig - expands tilde to home directory", () => {
  const result = Permission.fromConfig({ external_directory: { "~/projects/*": "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: `${os.homedir()}/projects/*`, action: "allow" }])
})

/**
 * 测试用例：展开 $HOME 环境变量为家目录
 * 
 * 测试目的：
 * - 验证 $HOME 环境变量能被正确展开
 * - 提供另一种指定家目录的方式
 * 
 * 使用场景：
 * 跨平台兼容，Windows 也支持 %HOME% 或 $HOME
 */
test("fromConfig - expands $HOME to home directory", () => {
  const result = Permission.fromConfig({ external_directory: { "$HOME/projects/*": "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: `${os.homedir()}/projects/*`, action: "allow" }])
})

/**
 * 测试用例：展开不带斜杠的 $HOME
 * 
 * 测试目的：
 * - 验证单独的 $HOME 也能正确展开
 * - 确保不会因为缺少尾部斜杠而出错
 */
test("fromConfig - expands $HOME without trailing slash", () => {
  const result = Permission.fromConfig({ external_directory: { $HOME: "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: os.homedir(), action: "allow" }])
})

/**
 * 测试用例：不展开路径中间的波浪号
 * 
 * 测试目的：
 * - 验证只有开头的 ~ 才会被展开
 * - 路径中间或结尾的 ~ 应保持原样（可能是合法的文件名）
 * 
 * 边界情况：
 * 某些文件系统可能允许文件名包含 ~ 字符
 */
test("fromConfig - does not expand tilde in middle of path", () => {
  const result = Permission.fromConfig({ external_directory: { "/some/~/path": "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: "/some/~/path", action: "allow" }])
})

/**
 * 测试用例：展开单独的波浪号为家目录
 * 
 * 测试目的：
 * - 验证单独的 ~ 能被正确展开为完整的家目录路径
 * 
 * 使用场景：
 * 允许访问整个家目录：{ external_directory: { "~": "allow" } }
 */
test("fromConfig - expands exact tilde to home directory", () => {
  const result = Permission.fromConfig({ external_directory: { "~": "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: os.homedir(), action: "allow" }])
})

/**
 * 测试用例：评估时匹配展开后的波浪号模式
 * 
 * 测试目的：
 * - 验证 evaluate() 能正确匹配已展开的路径
 * - 确保 fromConfig 的展开和 evaluate 的匹配是一致的
 * 
 * 流程：
 * 1. fromConfig 将 ~/projects/* 展开为 /home/user/projects/*
 * 2. evaluate 检查 /home/user/projects/file.txt 是否匹配
 * 3. 应该返回 allow
 */
test("evaluate - matches expanded tilde pattern", () => {
  const ruleset = Permission.fromConfig({ external_directory: { "~/projects/*": "allow" } })
  const result = Permission.evaluate("external_directory", `${os.homedir()}/projects/file.txt`, ruleset)
  expect(result.action).toBe("allow")
})

/**
 * 测试用例：评估时匹配展开后的 $HOME 模式
 * 
 * 测试目的：
 * - 验证 $HOME 展开后的路径也能正确匹配
 */
test("evaluate - matches expanded $HOME pattern", () => {
  const ruleset = Permission.fromConfig({ external_directory: { "$HOME/projects/*": "allow" } })
  const result = Permission.evaluate("external_directory", `${os.homedir()}/projects/file.txt`, ruleset)
  expect(result.action).toBe("allow")
})

// ========================================================================
// merge 测试 - 规则集合并
// ========================================================================

/**
 * 测试用例：简单连接
 * 
 * 测试目的：
 * - 验证两个规则集能正确合并
 * - 合并后的规则集包含所有规则，保持原有顺序
 */
test("merge - simple concatenation", () => {
  const result = Permission.merge(
    [{ permission: "bash", pattern: "*", action: "allow" }],
    [{ permission: "bash", pattern: "*", action: "deny" }],
  )
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "*", action: "deny" },
  ])
})

/**
 * 测试用例：添加新权限
 * 
 * 测试目的：
 * - 验证不同权限类型的规则能正确合并
 */
test("merge - adds new permission", () => {
  const result = Permission.merge(
    [{ permission: "bash", pattern: "*", action: "allow" }],
    [{ permission: "edit", pattern: "*", action: "deny" }],
  )
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "edit", pattern: "*", action: "deny" },
  ])
})

/**
 * 测试用例：同一权限的规则连接
 * 
 * 测试目的：
 * - 验证相同权限的多条规则能正确累加
 */
test("merge - concatenates rules for same permission", () => {
  const result = Permission.merge(
    [{ permission: "bash", pattern: "foo", action: "ask" }],
    [{ permission: "bash", pattern: "*", action: "deny" }],
  )
  expect(result).toEqual([
    { permission: "bash", pattern: "foo", action: "ask" },
    { permission: "bash", pattern: "*", action: "deny" },
  ])
})

/**
 * 测试用例：多个规则集合并
 * 
 * 测试目的：
 * - 验证能同时合并三个或更多规则集
 */
test("merge - multiple rulesets", () => {
  const result = Permission.merge(
    [{ permission: "bash", pattern: "*", action: "allow" }],
    [{ permission: "bash", pattern: "rm", action: "ask" }],
    [{ permission: "edit", pattern: "*", action: "allow" }],
  )
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm", action: "ask" },
    { permission: "edit", pattern: "*", action: "allow" },
  ])
})

/**
 * 测试用例：空规则集不影响结果
 * 
 * 测试目的：
 * - 验证与空规则集合并不改变原规则集
 */
test("merge - empty ruleset does nothing", () => {
  const result = Permission.merge([{ permission: "bash", pattern: "*", action: "allow" }], [])
  expect(result).toEqual([{ permission: "bash", pattern: "*", action: "allow" }])
})

/**
 * 测试用例：保持规则顺序
 * 
 * 测试目的：
 * - 验证规则的顺序在合并后保持不变
 * - 顺序对权限评估至关重要（最后匹配的规则获胜）
 * 
 * 使用场景：
 * 先允许 src/*，再拒绝 src/secret/*，最后允许 src/secret/ok.ts
 * 这样的顺序可以实现精细的访问控制
 */
test("merge - preserves rule order", () => {
  const result = Permission.merge(
    [
      { permission: "edit", pattern: "src/*", action: "allow" },
      { permission: "edit", pattern: "src/secret/*", action: "deny" },
    ],
    [{ permission: "edit", pattern: "src/secret/ok.ts", action: "allow" }],
  )
  expect(result).toEqual([
    { permission: "edit", pattern: "src/*", action: "allow" },
    { permission: "edit", pattern: "src/secret/*", action: "deny" },
    { permission: "edit", pattern: "src/secret/ok.ts", action: "allow" },
  ])
})

/**
 * 测试用例：配置权限覆盖默认询问
 * 
 * 测试目的：
 * - 验证用户配置能覆盖系统默认值
 * - 模拟场景：默认所有权限都是 ask，但用户配置 bash 为 allow
 * 
 * 技术原理：
 * 合并时，后面的规则集会追加到前面，evaluate 时最后匹配的规则获胜
 */
test("merge - config permission overrides default ask", () => {
  // 模拟：默认值为 "*": "ask"，配置设置 bash: "allow"
  const defaults: Permission.Ruleset = [{ permission: "*", pattern: "*", action: "ask" }]
  const config: Permission.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
  const merged = Permission.merge(defaults, config)

  // 配置的 bash allow 应该覆盖默认的 ask
  expect(Permission.evaluate("bash", "ls", merged).action).toBe("allow")
  // 其他权限仍应该是 ask（来自默认值）
  expect(Permission.evaluate("edit", "foo.ts", merged).action).toBe("ask")
})

/**
 * 测试用例：配置询问覆盖默认允许
 * 
 * 测试目的：
 * - 验证用户可以通过配置将默认的 allow 降级为 ask
 * - 提供更严格的权限控制
 */
test("merge - config ask overrides default allow", () => {
  // 模拟：默认值为 bash: "allow"，配置设置 bash: "ask"
  const defaults: Permission.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
  const config: Permission.Ruleset = [{ permission: "bash", pattern: "*", action: "ask" }]
  const merged = Permission.merge(defaults, config)

  // 配置的 ask 应该覆盖默认的 allow
  expect(Permission.evaluate("bash", "ls", merged).action).toBe("ask")
})

// ========================================================================
// evaluate 测试 - 权限评估
// ========================================================================

/**
 * 测试用例：精确模式匹配
 * 
 * 测试目的：
 * - 验证完全相同的 pattern 能正确匹配
 */
test("evaluate - exact pattern match", () => {
  const result = Permission.evaluate("bash", "rm", [{ permission: "bash", pattern: "rm", action: "deny" }])
  expect(result.action).toBe("deny")
})

/**
 * 测试用例：通配符模式匹配
 * 
 * 测试目的：
 * - 验证 * 能匹配任何值
 */
test("evaluate - wildcard pattern match", () => {
  const result = Permission.evaluate("bash", "rm", [{ permission: "bash", pattern: "*", action: "allow" }])
  expect(result.action).toBe("allow")
})

/**
 * 测试用例：最后匹配的规则获胜
 * 
 * 测试目的：
 * - 验证当多条规则匹配时，最后一条生效
 * - 这是权限系统的核心设计原则
 * 
 * 技术原理：
 * 遍历所有规则，记录最后一个匹配的规则的 action
 */
test("evaluate - last matching rule wins", () => {
  const result = Permission.evaluate("bash", "rm", [
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

/**
 * 测试用例：通配符在具体规则之后
 * 
 * 测试目的：
 * - 验证即使具体规则在前，后面的通配符也能覆盖它
 */
test("evaluate - last matching rule wins (wildcard after specific)", () => {
  const result = Permission.evaluate("bash", "rm", [
    { permission: "bash", pattern: "rm", action: "deny" },
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

/**
 * 测试用例：glob 模式匹配
 * 
 * 测试目的：
 * - 验证 src/* 能匹配 src/foo.ts
 * - 支持目录级别的权限控制
 */
test("evaluate - glob pattern match", () => {
  const result = Permission.evaluate("edit", "src/foo.ts", [{ permission: "edit", pattern: "src/*", action: "allow" }])
  expect(result.action).toBe("allow")
})

/**
 * 测试用例：最后匹配的 glob 获胜
 * 
 * 测试目的：
 * - 验证更具体的 glob 模式可以覆盖通用模式
 * - src/components/* 比 src/* 更具体
 */
test("evaluate - last matching glob wins", () => {
  const result = Permission.evaluate("edit", "src/components/Button.tsx", [
    { permission: "edit", pattern: "src/*", action: "deny" },
    { permission: "edit", pattern: "src/components/*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

/**
 * 测试用例：顺序影响特异性
 * 
 * 测试目的：
 * - 验证如果更具体的规则在前，后面的通配符会覆盖它
 * - 强调规则顺序的重要性
 * 
 * 注意：
 * 这与上一个测试相反，展示了顺序如何影响结果
 */
test("evaluate - order matters for specificity", () => {
  // 如果更具体的规则在前，后面的通配符会覆盖它
  const result = Permission.evaluate("edit", "src/components/Button.tsx", [
    { permission: "edit", pattern: "src/components/*", action: "allow" },
    { permission: "edit", pattern: "src/*", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

/**
 * 测试用例：未知权限返回 ask
 * 
 * 测试目的：
 * - 验证没有匹配规则时默认行为是询问用户
 * - 这是安全优先的设计（fail-safe）
 */
test("evaluate - unknown permission returns ask", () => {
  const result = Permission.evaluate("unknown_tool", "anything", [
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("ask")
})

/**
 * 测试用例：空规则集返回 ask
 * 
 * 测试目的：
 * - 验证没有任何规则时默认询问
 */
test("evaluate - empty ruleset returns ask", () => {
  const result = Permission.evaluate("bash", "rm", [])
  expect(result.action).toBe("ask")
})

/**
 * 测试用例：没有匹配的模式返回 ask
 * 
 * 测试目的：
 * - 验证有规则但不匹配时也返回 ask
 */
test("evaluate - no matching pattern returns ask", () => {
  const result = Permission.evaluate("edit", "etc/passwd", [{ permission: "edit", pattern: "src/*", action: "allow" }])
  expect(result.action).toBe("ask")
})

/**
 * 测试用例：空规则数组返回 ask
 * 
 * 测试目的：
 * - 与上面的测试重复，确保边界情况被覆盖
 */
test("evaluate - empty rules array returns ask", () => {
  const result = Permission.evaluate("bash", "rm", [])
  expect(result.action).toBe("ask")
})

/**
 * 测试用例：多个匹配模式，最后获胜
 * 
 * 测试目的：
 * - 验证三条规则都匹配时，最后一条生效
 * - 展示从通用到具体的规则链
 */
test("evaluate - multiple matching patterns, last wins", () => {
  const result = Permission.evaluate("edit", "src/secret.ts", [
    { permission: "edit", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "src/*", action: "allow" },
    { permission: "edit", pattern: "src/secret.ts", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

/**
 * 测试用例：跳过不匹配的模式
 * 
 * 测试目的：
 * - 验证只有匹配的规则才会被考虑
 */
test("evaluate - non-matching patterns are skipped", () => {
  const result = Permission.evaluate("edit", "src/foo.ts", [
    { permission: "edit", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "test/*", action: "deny" },
    { permission: "edit", pattern: "src/*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

/**
 * 测试用例：末尾的精确匹配覆盖前面的通配符
 * 
 * 测试目的：
 * - 验证精确路径可以覆盖通配符
 */
test("evaluate - exact match at end wins over earlier wildcard", () => {
  const result = Permission.evaluate("bash", "/bin/rm", [
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "/bin/rm", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

/**
 * 测试用例：末尾的通配符覆盖前面的精确匹配
 * 
 * 测试目的：
 * - 验证通配符可以覆盖精确匹配
 */
test("evaluate - wildcard at end overrides earlier exact match", () => {
  const result = Permission.evaluate("bash", "/bin/rm", [
    { permission: "bash", pattern: "/bin/rm", action: "deny" },
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

// wildcard permission tests

test("evaluate - wildcard permission matches any permission", () => {
  const result = Permission.evaluate("bash", "rm", [{ permission: "*", pattern: "*", action: "deny" }])
  expect(result.action).toBe("deny")
})

test("evaluate - wildcard permission with specific pattern", () => {
  const result = Permission.evaluate("bash", "rm", [{ permission: "*", pattern: "rm", action: "deny" }])
  expect(result.action).toBe("deny")
})

test("evaluate - glob permission pattern", () => {
  const result = Permission.evaluate("mcp_server_tool", "anything", [
    { permission: "mcp_*", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - specific permission and wildcard permission combined", () => {
  const result = Permission.evaluate("bash", "rm", [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - wildcard permission does not match when specific exists", () => {
  const result = Permission.evaluate("edit", "src/foo.ts", [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "edit", pattern: "src/*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - multiple matching permission patterns combine rules", () => {
  const result = Permission.evaluate("mcp_dangerous", "anything", [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "mcp_*", pattern: "*", action: "allow" },
    { permission: "mcp_dangerous", pattern: "*", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - wildcard permission fallback for unknown tool", () => {
  const result = Permission.evaluate("unknown_tool", "anything", [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("ask")
})

test("evaluate - permission patterns sorted by length regardless of object order", () => {
  // specific permission listed before wildcard, but specific should still win
  const result = Permission.evaluate("bash", "rm", [
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "*", pattern: "*", action: "deny" },
  ])
  // With flat list, last matching rule wins - so "*" matches bash and wins
  expect(result.action).toBe("deny")
})

test("evaluate - merges multiple rulesets", () => {
  const config: Permission.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
  const approved: Permission.Ruleset = [{ permission: "bash", pattern: "rm", action: "deny" }]
  // approved comes after config, so rm should be denied
  const result = Permission.evaluate("bash", "rm", config, approved)
  expect(result.action).toBe("deny")
})

// disabled tests

test("disabled - returns empty set when all tools allowed", () => {
  const result = Permission.disabled(["bash", "edit", "read"], [{ permission: "*", pattern: "*", action: "allow" }])
  expect(result.size).toBe(0)
})

test("disabled - disables tool when denied", () => {
  const result = Permission.disabled(
    ["bash", "edit", "read"],
    [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "deny" },
    ],
  )
  expect(result.has("bash")).toBe(true)
  expect(result.has("edit")).toBe(false)
  expect(result.has("read")).toBe(false)
})

test("disabled - disables edit/write/apply_patch/multiedit when edit denied", () => {
  const result = Permission.disabled(
    ["edit", "write", "apply_patch", "multiedit", "bash"],
    [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "edit", pattern: "*", action: "deny" },
    ],
  )
  expect(result.has("edit")).toBe(true)
  expect(result.has("write")).toBe(true)
  expect(result.has("apply_patch")).toBe(true)
  expect(result.has("multiedit")).toBe(true)
  expect(result.has("bash")).toBe(false)
})

test("disabled - does not disable when partially denied", () => {
  const result = Permission.disabled(
    ["bash"],
    [
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "rm *", action: "deny" },
    ],
  )
  expect(result.has("bash")).toBe(false)
})

test("disabled - does not disable when action is ask", () => {
  const result = Permission.disabled(["bash", "edit"], [{ permission: "*", pattern: "*", action: "ask" }])
  expect(result.size).toBe(0)
})

test("disabled - does not disable when specific allow after wildcard deny", () => {
  // Tool is NOT disabled because a specific allow after wildcard deny means
  // there's at least some usage allowed
  const result = Permission.disabled(
    ["bash"],
    [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "echo *", action: "allow" },
    ],
  )
  expect(result.has("bash")).toBe(false)
})

test("disabled - does not disable when wildcard allow after deny", () => {
  const result = Permission.disabled(
    ["bash"],
    [
      { permission: "bash", pattern: "rm *", action: "deny" },
      { permission: "bash", pattern: "*", action: "allow" },
    ],
  )
  expect(result.has("bash")).toBe(false)
})

test("disabled - disables multiple tools", () => {
  const result = Permission.disabled(
    ["bash", "edit", "webfetch"],
    [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "webfetch", pattern: "*", action: "deny" },
    ],
  )
  expect(result.has("bash")).toBe(true)
  expect(result.has("edit")).toBe(true)
  expect(result.has("webfetch")).toBe(true)
})

test("disabled - wildcard permission denies all tools", () => {
  const result = Permission.disabled(["bash", "edit", "read"], [{ permission: "*", pattern: "*", action: "deny" }])
  expect(result.has("bash")).toBe(true)
  expect(result.has("edit")).toBe(true)
  expect(result.has("read")).toBe(true)
})

test("disabled - specific allow overrides wildcard deny", () => {
  const result = Permission.disabled(
    ["bash", "edit", "read"],
    [
      { permission: "*", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "allow" },
    ],
  )
  expect(result.has("bash")).toBe(false)
  expect(result.has("edit")).toBe(true)
  expect(result.has("read")).toBe(true)
})

// ask tests

test("ask - resolves immediately when action is allow", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await Permission.ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
      })
      expect(result).toBeUndefined()
    },
  })
})

test("ask - throws RejectedError when action is deny", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(
        Permission.ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["rm -rf /"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "deny" }],
        }),
      ).rejects.toBeInstanceOf(Permission.DeniedError)
    },
  })
})

test("ask - returns pending promise when action is ask", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const promise = Permission.ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      })
      // Promise should be pending, not resolved
      expect(promise).toBeInstanceOf(Promise)
      // Don't await - just verify it returns a promise
      await rejectAll()
      await promise.catch(() => {})
    },
  })
})

test("ask - adds request to pending list", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ask = Permission.ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: { cmd: "ls" },
        always: ["ls"],
        tool: {
          messageID: MessageID.make("msg_test"),
          callID: "call_test",
        },
        ruleset: [],
      })

      const list = await Permission.list()
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: { cmd: "ls" },
        always: ["ls"],
        tool: {
          messageID: MessageID.make("msg_test"),
          callID: "call_test",
        },
      })

      await rejectAll()
      await ask.catch(() => {})
    },
  })
})

test("ask - publishes asked event", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      let seen: Permission.Request | undefined
      const unsub = Bus.subscribe(Permission.Event.Asked, (event) => {
        seen = event.properties
      })

      const ask = Permission.ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: { cmd: "ls" },
        always: ["ls"],
        tool: {
          messageID: MessageID.make("msg_test"),
          callID: "call_test",
        },
        ruleset: [],
      })

      expect(await Permission.list()).toHaveLength(1)
      expect(seen).toBeDefined()
      expect(seen).toMatchObject({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
      })

      unsub()
      await rejectAll()
      await ask.catch(() => {})
    },
  })
})

// reply tests

test("reply - once resolves the pending ask", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const askPromise = Permission.ask({
        id: PermissionID.make("per_test1"),
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      })

      await waitForPending(1)

      await Permission.reply({
        requestID: PermissionID.make("per_test1"),
        reply: "once",
      })

      await expect(askPromise).resolves.toBeUndefined()
    },
  })
})

test("reply - reject throws RejectedError", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const askPromise = Permission.ask({
        id: PermissionID.make("per_test2"),
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      })

      await waitForPending(1)

      await Permission.reply({
        requestID: PermissionID.make("per_test2"),
        reply: "reject",
      })

      await expect(askPromise).rejects.toBeInstanceOf(Permission.RejectedError)
    },
  })
})

test("reply - reject with message throws CorrectedError", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ask = Permission.ask({
        id: PermissionID.make("per_test2b"),
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      })

      await waitForPending(1)

      await Permission.reply({
        requestID: PermissionID.make("per_test2b"),
        reply: "reject",
        message: "Use a safer command",
      })

      const err = await ask.catch((err) => err)
      expect(err).toBeInstanceOf(Permission.CorrectedError)
      expect(err.message).toContain("Use a safer command")
    },
  })
})

test("reply - always persists approval and resolves", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const askPromise = Permission.ask({
        id: PermissionID.make("per_test3"),
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: ["ls"],
        ruleset: [],
      })

      await waitForPending(1)

      await Permission.reply({
        requestID: PermissionID.make("per_test3"),
        reply: "always",
      })

      await expect(askPromise).resolves.toBeUndefined()
    },
  })
  // Re-provide to reload state with stored permissions
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Stored approval should allow without asking
      const result = await Permission.ask({
        sessionID: SessionID.make("session_test2"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      })
      expect(result).toBeUndefined()
    },
  })
})

test("reply - reject cancels all pending for same session", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const askPromise1 = Permission.ask({
        id: PermissionID.make("per_test4a"),
        sessionID: SessionID.make("session_same"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      })

      const askPromise2 = Permission.ask({
        id: PermissionID.make("per_test4b"),
        sessionID: SessionID.make("session_same"),
        permission: "edit",
        patterns: ["foo.ts"],
        metadata: {},
        always: [],
        ruleset: [],
      })

      await waitForPending(2)

      // Catch rejections before they become unhandled
      const result1 = askPromise1.catch((e) => e)
      const result2 = askPromise2.catch((e) => e)

      // Reject the first one
      await Permission.reply({
        requestID: PermissionID.make("per_test4a"),
        reply: "reject",
      })

      // Both should be rejected
      expect(await result1).toBeInstanceOf(Permission.RejectedError)
      expect(await result2).toBeInstanceOf(Permission.RejectedError)
    },
  })
})

test("reply - always resolves matching pending requests in same session", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const a = Permission.ask({
        id: PermissionID.make("per_test5a"),
        sessionID: SessionID.make("session_same"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: ["ls"],
        ruleset: [],
      })

      const b = Permission.ask({
        id: PermissionID.make("per_test5b"),
        sessionID: SessionID.make("session_same"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      })

      await waitForPending(2)

      await Permission.reply({
        requestID: PermissionID.make("per_test5a"),
        reply: "always",
      })

      await expect(a).resolves.toBeUndefined()
      await expect(b).resolves.toBeUndefined()
      expect(await Permission.list()).toHaveLength(0)
    },
  })
})

test("reply - always keeps other session pending", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const a = Permission.ask({
        id: PermissionID.make("per_test6a"),
        sessionID: SessionID.make("session_a"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: ["ls"],
        ruleset: [],
      })

      const b = Permission.ask({
        id: PermissionID.make("per_test6b"),
        sessionID: SessionID.make("session_b"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      })

      await waitForPending(2)

      await Permission.reply({
        requestID: PermissionID.make("per_test6a"),
        reply: "always",
      })

      await expect(a).resolves.toBeUndefined()
      expect((await Permission.list()).map((x) => x.id)).toEqual([PermissionID.make("per_test6b")])

      await rejectAll()
      await b.catch(() => {})
    },
  })
})

test("reply - publishes replied event", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ask = Permission.ask({
        id: PermissionID.make("per_test7"),
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      })

      await waitForPending(1)

      let seen:
        | {
            sessionID: SessionID
            requestID: PermissionID
            reply: Permission.Reply
          }
        | undefined
      const unsub = Bus.subscribe(Permission.Event.Replied, (event) => {
        seen = event.properties
      })

      await Permission.reply({
        requestID: PermissionID.make("per_test7"),
        reply: "once",
      })

      await expect(ask).resolves.toBeUndefined()
      expect(seen).toEqual({
        sessionID: SessionID.make("session_test"),
        requestID: PermissionID.make("per_test7"),
        reply: "once",
      })
      unsub()
    },
  })
})

test("permission requests stay isolated by directory", async () => {
  await using one = await tmpdir({ git: true })
  await using two = await tmpdir({ git: true })

  const a = Instance.provide({
    directory: one.path,
    fn: () =>
      Permission.ask({
        id: PermissionID.make("per_dir_a"),
        sessionID: SessionID.make("session_dir_a"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }),
  })

  const b = Instance.provide({
    directory: two.path,
    fn: () =>
      Permission.ask({
        id: PermissionID.make("per_dir_b"),
        sessionID: SessionID.make("session_dir_b"),
        permission: "bash",
        patterns: ["pwd"],
        metadata: {},
        always: [],
        ruleset: [],
      }),
  })

  const onePending = await Instance.provide({
    directory: one.path,
    fn: () => waitForPending(1),
  })
  const twoPending = await Instance.provide({
    directory: two.path,
    fn: () => waitForPending(1),
  })

  expect(onePending).toHaveLength(1)
  expect(twoPending).toHaveLength(1)
  expect(onePending[0].id).toBe(PermissionID.make("per_dir_a"))
  expect(twoPending[0].id).toBe(PermissionID.make("per_dir_b"))

  await Instance.provide({
    directory: one.path,
    fn: () => Permission.reply({ requestID: onePending[0].id, reply: "reject" }),
  })
  await Instance.provide({
    directory: two.path,
    fn: () => Permission.reply({ requestID: twoPending[0].id, reply: "reject" }),
  })

  await a.catch(() => {})
  await b.catch(() => {})
})

test("pending permission rejects on instance dispose", async () => {
  await using tmp = await tmpdir({ git: true })

  const ask = Instance.provide({
    directory: tmp.path,
    fn: () =>
      Permission.ask({
        id: PermissionID.make("per_dispose"),
        sessionID: SessionID.make("session_dispose"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }),
  })
  const result = ask.then(
    () => "resolved" as const,
    (err) => err,
  )

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const pending = await waitForPending(1)
      expect(pending).toHaveLength(1)
      await Instance.dispose()
    },
  })

  expect(await result).toBeInstanceOf(Permission.RejectedError)
})

test("pending permission rejects on instance reload", async () => {
  await using tmp = await tmpdir({ git: true })

  const ask = Instance.provide({
    directory: tmp.path,
    fn: () =>
      Permission.ask({
        id: PermissionID.make("per_reload"),
        sessionID: SessionID.make("session_reload"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }),
  })
  const result = ask.then(
    () => "resolved" as const,
    (err) => err,
  )

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const pending = await waitForPending(1)
      expect(pending).toHaveLength(1)
      await Instance.reload({ directory: tmp.path })
    },
  })

  expect(await result).toBeInstanceOf(Permission.RejectedError)
})

test("reply - does nothing for unknown requestID", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Permission.reply({
        requestID: PermissionID.make("per_unknown"),
        reply: "once",
      })
      expect(await Permission.list()).toHaveLength(0)
    },
  })
})

test("ask - checks all patterns and stops on first deny", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(
        Permission.ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["echo hello", "rm -rf /"],
          metadata: {},
          always: [],
          ruleset: [
            { permission: "bash", pattern: "*", action: "allow" },
            { permission: "bash", pattern: "rm *", action: "deny" },
          ],
        }),
      ).rejects.toBeInstanceOf(Permission.DeniedError)
    },
  })
})

test("ask - allows all patterns when all match allow rules", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await Permission.ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["echo hello", "ls -la", "pwd"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
      })
      expect(result).toBeUndefined()
    },
  })
})

test("ask - should deny even when an earlier pattern is ask", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const err = await Permission.ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["echo hello", "rm -rf /"],
        metadata: {},
        always: [],
        ruleset: [
          { permission: "bash", pattern: "echo *", action: "ask" },
          { permission: "bash", pattern: "rm *", action: "deny" },
        ],
      }).then(
        () => undefined,
        (err) => err,
      )

      expect(err).toBeInstanceOf(Permission.DeniedError)
      expect(await Permission.list()).toHaveLength(0)
    },
  })
})

test("ask - abort should clear pending request", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ctl = new AbortController()
      const ask = Permission.runPromise(
        (svc) =>
          svc.ask({
            sessionID: SessionID.make("session_test"),
            permission: "bash",
            patterns: ["ls"],
            metadata: {},
            always: [],
            ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
          }),
        { signal: ctl.signal },
      )

      await waitForPending(1)
      ctl.abort()
      await ask.catch(() => {})

      try {
        expect(await Permission.list()).toHaveLength(0)
      } finally {
        await rejectAll()
      }
    },
  })
})
