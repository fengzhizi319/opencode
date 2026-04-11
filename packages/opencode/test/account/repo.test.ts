/**
 * AccountRepo 单元测试文件
 * 
 * 测试目标：验证账户仓库（AccountRepo）的所有核心功能
 * - 账户的增删改查操作
 * - 活跃账户管理
 * - Token 更新机制
 * - 组织（Org）切换功能
 */
import { expect } from "bun:test"
import { Effect, Layer, Option } from "effect"

import { AccountRepo } from "../../src/account/repo"
import { AccessToken, AccountID, OrgID, RefreshToken } from "../../src/account/schema"
import { Database } from "../../src/storage/db"
import { testEffect } from "../lib/effect"

/**
 * 测试前置清理层：在每次测试执行前清空数据库表
 * 确保每个测试用例都在干净的数据库状态下运行，避免数据污染
 */
const truncate = Layer.effectDiscard(
  Effect.sync(() => {
    const db = Database.Client()
    db.run(/*sql*/ `DELETE FROM account_state`)
    db.run(/*sql*/ `DELETE FROM account`)
  }),
)

/**
 * 创建增强版的测试函数 it
 * 合并 AccountRepo.layer（提供仓库依赖）和 truncate 层（提供数据清理）
 * 所有通过 it.effect 定义的测试都会自动注入这两个层
 */
const it = testEffect(Layer.merge(AccountRepo.layer, truncate))

/**
 * 测试用例1：当数据库中没有任何账户时，list() 应返回空数组
 * 目的：验证 list 方法在无数据情况下的边界行为
 */
it.effect("list returns empty when no accounts exist", () =>
  Effect.gen(function* () {
    // 调用 list 方法获取所有账户列表
    const accounts = yield* AccountRepo.use((r) => r.list())
    // 断言返回空数组
    expect(accounts).toEqual([])
  }),
)

/**
 * 测试用例2：当没有账户时，active() 应返回 None
 * 目的：验证 active 方法在无活跃账户时的正确行为（使用 Option 类型表示可能不存在）
 */
it.effect("active returns none when no accounts exist", () =>
  Effect.gen(function* () {
    // 尝试获取当前活跃账户
    const active = yield* AccountRepo.use((r) => r.active())
    // 断言结果为 None（表示没有活跃账户）
    expect(Option.isNone(active)).toBe(true)
  }),
)

/**
 * 测试用例3：persistAccount 插入新账户后，getRow 能正确检索到该账户
 * 目的：验证账户的基本 CRUD 操作（创建和读取）以及活跃账户的自动设置
 */
it.effect("persistAccount inserts and getRow retrieves", () =>
  Effect.gen(function* () {
    // 创建唯一的账户 ID
    const id = AccountID.make("user-1")
    
    // 持久化一个新账户，包含完整的认证信息
    yield* AccountRepo.use((r) =>
      r.persistAccount({
        id,
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_123"),
        refreshToken: RefreshToken.make("rt_456"),
        expiry: Date.now() + 3600_000, // 1小时后过期
        orgID: Option.some(OrgID.make("org-1")), // 关联到 org-1
      }),
    )

    // 验证可以通过 getRow 检索到刚插入的账户
    const row = yield* AccountRepo.use((r) => r.getRow(id))
    expect(Option.isSome(row)).toBe(true)
    const value = Option.getOrThrow(row)
    expect(value.id).toBe(AccountID.make("user-1"))
    expect(value.email).toBe("test@example.com")

    // 验证新插入的账户自动成为活跃账户，且其关联的组织也被设置为活跃组织
    const active = yield* AccountRepo.use((r) => r.active())
    expect(Option.getOrThrow(active).active_org_id).toBe(OrgID.make("org-1"))
  }),
)

/**
 * 测试用例4：persistAccount 会设置最后插入的账户为活跃账户及其组织
 * 目的：验证多账户场景下，最新操作的账户会成为活跃账户（类似 LRU 策略）
 */
it.effect("persistAccount sets the active account and org", () =>
  Effect.gen(function* () {
    // 创建两个不同的账户 ID
    const id1 = AccountID.make("user-1")
    const id2 = AccountID.make("user-2")

    // 插入第一个账户
    yield* AccountRepo.use((r) =>
      r.persistAccount({
        id: id1,
        email: "first@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_1"),
        refreshToken: RefreshToken.make("rt_1"),
        expiry: Date.now() + 3600_000,
        orgID: Option.some(OrgID.make("org-1")),
      }),
    )

    // 插入第二个账户（后插入的应该成为活跃账户）
    yield* AccountRepo.use((r) =>
      r.persistAccount({
        id: id2,
        email: "second@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_2"),
        refreshToken: RefreshToken.make("rt_2"),
        expiry: Date.now() + 3600_000,
        orgID: Option.some(OrgID.make("org-2")),
      }),
    )

    // 验证最后持久化的账户（user-2）是活跃账户
    const active = yield* AccountRepo.use((r) => r.active())
    expect(Option.isSome(active)).toBe(true)
    expect(Option.getOrThrow(active).id).toBe(AccountID.make("user-2"))
    // 验证活跃组织也是 user-2 关联的组织（org-2）
    expect(Option.getOrThrow(active).active_org_id).toBe(OrgID.make("org-2"))
  }),
)

/**
 * 测试用例5：list 方法返回所有已存在的账户
 * 目的：验证 list 方法能正确获取多个账户，不受组织关联状态影响
 */
it.effect("list returns all accounts", () =>
  Effect.gen(function* () {
    const id1 = AccountID.make("user-1")
    const id2 = AccountID.make("user-2")

    // 插入第一个账户（无组织关联）
    yield* AccountRepo.use((r) =>
      r.persistAccount({
        id: id1,
        email: "a@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_1"),
        refreshToken: RefreshToken.make("rt_1"),
        expiry: Date.now() + 3600_000,
        orgID: Option.none(), // 没有关联组织
      }),
    )

    // 插入第二个账户（有关联组织）
    yield* AccountRepo.use((r) =>
      r.persistAccount({
        id: id2,
        email: "b@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_2"),
        refreshToken: RefreshToken.make("rt_2"),
        expiry: Date.now() + 3600_000,
        orgID: Option.some(OrgID.make("org-1")), // 关联到 org-1
      }),
    )

    // 验证 list 返回所有账户（2个）
    const accounts = yield* AccountRepo.use((r) => r.list())
    expect(accounts.length).toBe(2)
    // 按邮箱排序后验证，确保两个账户都存在
    expect(accounts.map((a) => a.email).sort()).toEqual(["a@example.com", "b@example.com"])
  }),
)

/**
 * 测试用例6：remove 方法能正确删除指定账户
 * 目的：验证账户删除功能及删除后的数据一致性
 */
it.effect("remove deletes an account", () =>
  Effect.gen(function* () {
    const id = AccountID.make("user-1")

    // 先插入一个账户
    yield* AccountRepo.use((r) =>
      r.persistAccount({
        id,
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_1"),
        refreshToken: RefreshToken.make("rt_1"),
        expiry: Date.now() + 3600_000,
        orgID: Option.none(),
      }),
    )

    // 删除该账户
    yield* AccountRepo.use((r) => r.remove(id))

    // 验证删除后无法再检索到该账户（返回 None）
    const row = yield* AccountRepo.use((r) => r.getRow(id))
    expect(Option.isNone(row)).toBe(true)
  }),
)

/**
 * 测试用例7：use 方法能切换活跃账户并设置选定的组织
 * 目的：验证账户切换功能和组织选择功能的正确性
 */
it.effect("use stores the selected org and marks the account active", () =>
  Effect.gen(function* () {
    const id1 = AccountID.make("user-1")
    const id2 = AccountID.make("user-2")

    // 插入两个账户（初始都无组织关联）
    yield* AccountRepo.use((r) =>
      r.persistAccount({
        id: id1,
        email: "first@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_1"),
        refreshToken: RefreshToken.make("rt_1"),
        expiry: Date.now() + 3600_000,
        orgID: Option.none(),
      }),
    )

    yield* AccountRepo.use((r) =>
      r.persistAccount({
        id: id2,
        email: "second@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_2"),
        refreshToken: RefreshToken.make("rt_2"),
        expiry: Date.now() + 3600_000,
        orgID: Option.none(),
      }),
    )

    // 切换到 user-1 并设置其活跃组织为 org-99
    yield* AccountRepo.use((r) => r.use(id1, Option.some(OrgID.make("org-99"))))
    const active1 = yield* AccountRepo.use((r) => r.active())
    // 验证活跃账户已切换为 user-1
    expect(Option.getOrThrow(active1).id).toBe(id1)
    // 验证活跃组织已设置为 org-99
    expect(Option.getOrThrow(active1).active_org_id).toBe(OrgID.make("org-99"))

    // 再次调用 use，但这次不设置组织（清除组织选择）
    yield* AccountRepo.use((r) => r.use(id1, Option.none()))
    const active2 = yield* AccountRepo.use((r) => r.active())
    // 验证活跃组织已被清除（变为 null）
    expect(Option.getOrThrow(active2).active_org_id).toBeNull()
  }),
)

/**
 * 测试用例8：persistToken 方法能正确更新账户的 Token 信息
 * 目的：验证 Token 刷新机制，包括 access token、refresh token 和过期时间的更新
 */
it.effect("persistToken updates token fields", () =>
  Effect.gen(function* () {
    const id = AccountID.make("user-1")

    // 先插入一个带有旧 Token 的账户
    yield* AccountRepo.use((r) =>
      r.persistAccount({
        id,
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("old_token"),
        refreshToken: RefreshToken.make("old_refresh"),
        expiry: 1000, // 旧的过期时间
        orgID: Option.none(),
      }),
    )

    // 计算新的过期时间（2小时后）
    const expiry = Date.now() + 7200_000
    
    // 更新 Token 信息
    yield* AccountRepo.use((r) =>
      r.persistToken({
        accountID: id,
        accessToken: AccessToken.make("new_token"),
        refreshToken: RefreshToken.make("new_refresh"),
        expiry: Option.some(expiry), // 提供新的过期时间
      }),
    )

    // 验证所有 Token 字段都已正确更新
    const row = yield* AccountRepo.use((r) => r.getRow(id))
    const value = Option.getOrThrow(row)
    expect(value.access_token).toBe(AccessToken.make("new_token"))
    expect(value.refresh_token).toBe(RefreshToken.make("new_refresh"))
    expect(value.token_expiry).toBe(expiry)
  }),
)

/**
 * 测试用例9：persistToken 不提供过期时间时，应将 token_expiry 设为 null
 * 目的：验证 Token 更新时可选字段的处理逻辑（支持永久有效的 Token）
 */
it.effect("persistToken with no expiry sets token_expiry to null", () =>
  Effect.gen(function* () {
    const id = AccountID.make("user-1")

    // 插入一个有过期时间的账户
    yield* AccountRepo.use((r) =>
      r.persistAccount({
        id,
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("old_token"),
        refreshToken: RefreshToken.make("old_refresh"),
        expiry: 1000,
        orgID: Option.none(),
      }),
    )

    // 更新 Token 但不提供过期时间（Option.none()）
    yield* AccountRepo.use((r) =>
      r.persistToken({
        accountID: id,
        accessToken: AccessToken.make("new_token"),
        refreshToken: RefreshToken.make("new_refresh"),
        expiry: Option.none(), // 明确表示无过期时间
      }),
    )

    // 验证 token_expiry 已被设置为 null（表示永不过期）
    const row = yield* AccountRepo.use((r) => r.getRow(id))
    expect(Option.getOrThrow(row).token_expiry).toBeNull()
  }),
)

/**
 * 测试用例10：persistAccount 在遇到冲突时会进行 upsert（更新或插入）操作
 * 目的：验证同一账户 ID 重复插入时的更新行为，而非报错或创建重复记录
 */
it.effect("persistAccount upserts on conflict", () =>
  Effect.gen(function* () {
    const id = AccountID.make("user-1")

    // 第一次插入账户（版本1）
    yield* AccountRepo.use((r) =>
      r.persistAccount({
        id,
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_v1"),
        refreshToken: RefreshToken.make("rt_v1"),
        expiry: 1000,
        orgID: Option.some(OrgID.make("org-1")),
      }),
    )

    // 第二次用相同 ID 但不同数据插入（版本2，应该更新而非创建新记录）
    yield* AccountRepo.use((r) =>
      r.persistAccount({
        id,
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_v2"),
        refreshToken: RefreshToken.make("rt_v2"),
        expiry: 2000,
        orgID: Option.some(OrgID.make("org-2")),
      }),
    )

    // 验证数据库中仍然只有1条记录（没有重复）
    const accounts = yield* AccountRepo.use((r) => r.list())
    expect(accounts.length).toBe(1)

    // 验证记录已更新为版本2的数据
    const row = yield* AccountRepo.use((r) => r.getRow(id))
    const value = Option.getOrThrow(row)
    expect(value.access_token).toBe(AccessToken.make("at_v2"))

    // 验证活跃组织也已更新为 org-2
    const active = yield* AccountRepo.use((r) => r.active())
    expect(Option.getOrThrow(active).active_org_id).toBe(OrgID.make("org-2"))
  }),
)

/**
 * 测试用例11：删除活跃账户时，应同时清除活跃状态
 * 目的：验证删除操作不会留下无效的活跃账户引用，保持数据一致性
 */
it.effect("remove clears active state when deleting the active account", () =>
  Effect.gen(function* () {
    const id = AccountID.make("user-1")

    // 插入一个账户（会自动成为活跃账户）
    yield* AccountRepo.use((r) =>
      r.persistAccount({
        id,
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_1"),
        refreshToken: RefreshToken.make("rt_1"),
        expiry: Date.now() + 3600_000,
        orgID: Option.some(OrgID.make("org-1")),
      }),
    )

    // 删除该活跃账户
    yield* AccountRepo.use((r) => r.remove(id))

    // 验证活跃状态已被清除（不再有活跃账户）
    const active = yield* AccountRepo.use((r) => r.active())
    expect(Option.isNone(active)).toBe(true)
  }),
)

/**
 * 测试用例12：查询不存在的账户时，getRow 应返回 None
 * 目的：验证 getRow 方法对无效 ID 的容错处理
 */
it.effect("getRow returns none for nonexistent account", () =>
  Effect.gen(function* () {
    // 尝试查询一个不存在的账户 ID
    const row = yield* AccountRepo.use((r) => r.getRow(AccountID.make("nope")))
    // 验证返回 None 而不是抛出异常
    expect(Option.isNone(row)).toBe(true)
  }),
)
