import { $ } from "bun"
import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { ConfigProvider, Deferred, Effect, Layer, ManagedRuntime, Option } from "effect"
import { tmpdir } from "../fixture/fixture"
// import { Bus } from "../../src/bus"
// import { Config } from "../../src/config/config"
// import { FileWatcher } from "../../src/file/watcher"
// import { Instance } from "../../src/project/instance"
import { Bus } from "@/bus"
import { Config } from "@/config/config.ts"
import { FileWatcher } from "@/file/watcher.ts"
import { Instance } from "@/project/instance.ts"

/**
 * 条件性启用监听器测试
 *
 * 由于 @parcel/watcher 的原生绑定在 CI 环境中不可靠（Linux 缺失，Windows 不稳定），
 * 仅在本地环境且有原生绑定时运行测试。
 */
const describeWatcher = FileWatcher.hasNativeBinding() && !process.env.CI ? describe : describe.skip

// ---------------------------------------------------------------------------
// 辅助函数和工具
// ---------------------------------------------------------------------------

/**
 * 创建监听器配置层
 *
 * 通过环境变量启用实验性文件监听功能：
 * - OPENCODE_EXPERIMENTAL_FILEWATCHER: 启用文件监听器
 * - OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: 不禁用文件监听器
 */
const watcherConfigLayer = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    OPENCODE_EXPERIMENTAL_FILEWATCHER: "true",
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "false",
  }),
)

/**
 * 监听器事件类型
 *
 * 表示文件系统变更事件的标准化格式
 */
type WatcherEvent = { file: string; event: "add" | "change" | "unlink" }

/**
 * 在活动的 FileWatcher 服务上下文中执行测试逻辑
 *
 * 完整生命周期管理：
 * 1. 提供 Instance 上下文（设置工作目录）
 * 2. 构建并初始化 FileWatcher 服务层
 * 3. 启动监听器并等待就绪
 * 4. 执行测试主体逻辑
 * 5. 清理并释放资源
 *
 * @param directory - 要监听的工作目录
 * @param body - 要执行的测试逻辑（Effect）
 */
function withWatcher<E>(directory: string, body: Effect.Effect<void, E>) {
  return Instance.provide({
    directory,
    fn: async () => {
      // 构建服务层：FileWatcher + 默认配置 + 监听器特定配置
      const layer: Layer.Layer<FileWatcher.Service, never, never> = FileWatcher.layer.pipe(
        Layer.provide(Config.defaultLayer),
        Layer.provide(watcherConfigLayer),
      )
      // 创建托管运行时，自动管理服务生命周期
      const rt = ManagedRuntime.make(layer)
      try {
        // 初始化监听器服务
        await rt.runPromise(FileWatcher.Service.use((s) => s.init()))
        // 等待监听器就绪（确保可以接收事件）
        await Effect.runPromise(ready(directory))
        // 执行测试主体逻辑
        await Effect.runPromise(body)
      } finally {
        // 无论成功或失败，都要清理资源
        await rt.dispose()
      }
    },
  })
}

/**
 * 订阅监听器事件并在匹配时执行回调
 *
 * 用于同步风格的测试场景，手动管理订阅生命周期
 *
 * @param directory - 工作目录（当前未使用，保留用于未来扩展）
 * @param check - 事件过滤函数，返回 true 表示该事件需要处理
 * @param hit - 事件匹配时的回调函数
 * @returns 取消订阅的清理函数
 */
function listen(directory: string, check: (evt: WatcherEvent) => boolean, hit: (evt: WatcherEvent) => void) {
  let done = false

  // 订阅 FileWatcher 的更新事件
  const unsub = Bus.subscribe(FileWatcher.Event.Updated, (evt) => {
    if (done) return // 防止重复触发
    if (!check(evt.properties)) return // 过滤不匹配的事件
    hit(evt.properties) // 处理匹配的事件
  })

  // 返回清理函数，确保只触发一次
  return () => {
    if (done) return
    done = true
    unsub() // 取消订阅
  }
}

/**
 * 等待匹配的监听器事件（Effect 风格）
 *
 * 创建一个 Deferred Promise，当匹配的事件到达时解析
 * 返回清理函数和 deferred 对象，供调用者管理生命周期
 *
 * @param directory - 工作目录
 * @param check - 事件过滤函数
 * @returns 包含 cleanup 和 deferred 的对象
 */
function wait(directory: string, check: (evt: WatcherEvent) => boolean) {
  return Effect.gen(function* () {
    // 创建可手动完成的 Deferred
    const deferred = yield* Deferred.make<WatcherEvent>()
    // 注册事件监听器，匹配时完成 deferred
    const cleanup = yield* Effect.sync(() => {
      let off = () => {}
      off = listen(directory, check, (evt) => {
        off() // 立即取消订阅，确保只触发一次
        Deferred.doneUnsafe(deferred, Effect.succeed(evt)) // 完成 deferred
      })
      return off
    })
    return { cleanup, deferred }
  })
}

/**
 * 等待下一个匹配的更新事件
 *
 * 使用 acquireUseRelease 模式确保资源正确清理：
 * 1. Acquire: 注册事件监听器
 * 2. Use: 执行触发操作并等待事件（最多 5 秒超时）
 * 3. Release: 清理监听器
 *
 * @param directory - 工作目录
 * @param check - 事件过滤函数
 * @param trigger - 触发文件系统变更的操作
 * @returns 匹配的事件对象
 */
function nextUpdate<E>(directory: string, check: (evt: WatcherEvent) => boolean, trigger: Effect.Effect<void, E>) {
  return Effect.acquireUseRelease(
    wait(directory, check), // 获取：注册监听器
    ({ deferred }) =>
      Effect.gen(function* () {
        yield* trigger // 执行触发操作
        return yield* Deferred.await(deferred).pipe(Effect.timeout("5 seconds")) // 等待事件，5秒超时
      }),
    ({ cleanup }) => Effect.sync(cleanup), // 释放：清理监听器
  )
}

/**
 * 断言在指定时间内没有匹配的事件发生
 *
 * 用于验证某些操作不会触发监听器事件（如忽略的文件、已停止的监听器等）
 *
 * @param directory - 工作目录
 * @param check - 事件过滤函数
 * @param trigger - 触发操作
 * @param ms - 等待时间（毫秒），默认 500ms
 */
function noUpdate<E>(
  directory: string,
  check: (evt: WatcherEvent) => boolean,
  trigger: Effect.Effect<void, E>,
  ms = 500,
) {
  return Effect.acquireUseRelease(
    wait(directory, check), // 获取：注册监听器
    ({ deferred }) =>
      Effect.gen(function* () {
        yield* trigger // 执行触发操作
        // 等待事件，但期望超时（即没有事件发生）
        expect(yield* Deferred.await(deferred).pipe(Effect.timeoutOption(`${ms} millis`))).toEqual(Option.none())
      }),
    ({ cleanup }) => Effect.sync(cleanup), // 释放：清理监听器
  )
}

/**
 * 等待监听器完全就绪
 *
 * 通过以下步骤确保监听器已准备好接收事件：
 * 1. 创建临时文件并等待 "add" 事件，确认基本监听功能正常
 * 2. 如果是 git 仓库，切换分支并等待 .git/HEAD 变更事件，确认 git 文件也能被监听
 *
 * 这是必要的，因为 @parcel/watcher 可能有启动延迟
 *
 * @param directory - 工作目录
 * @returns 表示就绪的 Effect
 */
function ready(directory: string) {
  // 创建唯一的临时文件名，避免冲突
  const file = path.join(directory, `.watcher-${Math.random().toString(36).slice(2)}`)
  const head = path.join(directory, ".git", "HEAD")

  return Effect.gen(function* () {
    // 第一步：写入临时文件并等待 "add" 事件
    yield* nextUpdate(
      directory,
      (evt) => evt.file === file && evt.event === "add",
      Effect.promise(() => fs.writeFile(file, "ready")),
    ).pipe(
      // 无论成功与否，都删除临时文件
      Effect.ensuring(Effect.promise(() => fs.rm(file, { force: true }).catch(() => undefined))),
      Effect.asVoid,
    )

    // 第二步：检查是否是 git 仓库
    const git = yield* Effect.promise(() =>
      fs
        .stat(head)
        .then(() => true)
        .catch(() => false),
    )
    if (!git) return // 非 git 仓库，无需进一步检查

    // 第三步：创建新分支并切换，触发 .git/HEAD 变更
    const branch = `watch-${Math.random().toString(36).slice(2)}`
    const hash = yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(directory).quiet().text())
    yield* nextUpdate(
      directory,
      (evt) => evt.file === head && evt.event !== "unlink",
      Effect.promise(async () => {
        // 创建分支引用
        await fs.writeFile(path.join(directory, ".git", "refs", "heads", branch), hash.trim() + "\n")
        // 更新 HEAD 指向新分支
        await fs.writeFile(head, `ref: refs/heads/${branch}\n`)
      }),
    ).pipe(Effect.asVoid)
  })
}

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------

describeWatcher("FileWatcher", () => {
  /**
   * 每个测试后清理所有实例
   *
   * 确保测试之间不会相互影响，避免资源泄漏
   */
  afterEach(async () => {
    await Instance.disposeAll()
  })

  /**
   * 测试：监听器能正确发布根目录下的创建、修改和删除事件
   *
   * 验证三种基本文件系统操作都能被正确检测和报告：
   * 1. add: 新建文件
   * 2. change: 修改现有文件
   * 3. unlink: 删除文件
   */
  test("publishes root create, update, and delete events", async () => {
    await using tmp = await tmpdir({ git: true })
    const file = path.join(tmp.path, "watch.txt")
    const dir = tmp.path

    // 定义三个测试场景：创建、修改、删除
    const cases = [
      { event: "add" as const, trigger: Effect.promise(() => fs.writeFile(file, "a")) },
      { event: "change" as const, trigger: Effect.promise(() => fs.writeFile(file, "b")) },
      { event: "unlink" as const, trigger: Effect.promise(() => fs.unlink(file)) },
    ]

    await withWatcher(
      dir,
      // 对每个场景执行测试：触发操作 -> 等待事件 -> 验证事件内容
      Effect.forEach(cases, ({ event, trigger }) =>
        nextUpdate(dir, (evt) => evt.file === file && evt.event === event, trigger).pipe(
          Effect.tap((evt) => Effect.sync(() => expect(evt).toEqual({ file, event }))),
        ),
      ),
    )
  })

  /**
   * 测试：监听器能在非 git 仓库中正常工作
   *
   * 验证监听器不依赖 git，可以在普通目录中使用
   */
  test("watches non-git roots", async () => {
    await using tmp = await tmpdir() // 不初始化 git
    const file = path.join(tmp.path, "plain.txt")
    const dir = tmp.path

    await withWatcher(
      dir,
      nextUpdate(
        dir,
        (e) => e.file === file && e.event === "add",
        Effect.promise(() => fs.writeFile(file, "plain")),
      ).pipe(Effect.tap((evt) => Effect.sync(() => expect(evt).toEqual({ file, event: "add" })))),
    )
  })

  /**
   * 测试：清理后监听器停止发布事件
   *
   * 验证监听器生命周期管理正确：
   * 1. 启动监听器
   * 2. 立即停止（withWatcher 退出时自动 dispose）
   * 3. 写入文件，验证没有事件产生
   */
  test("cleanup stops publishing events", async () => {
    await using tmp = await tmpdir({ git: true })
    const file = path.join(tmp.path, "after-dispose.txt")

    // 启动并立即停止监听器（withWatcher 在退出时会 dispose）
    await withWatcher(tmp.path, Effect.void)

    // 现在写入文件 —— 应该没有监听器在运行
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        Effect.runPromise(
          noUpdate(
            tmp.path,
            (e) => e.file === file,
            Effect.promise(() => fs.writeFile(file, "gone")),
          ),
        ),
    })
  })

  /**
   * 测试：忽略 .git/index 文件的变更
   *
   * 验证监听器会过滤掉 .git/index 的频繁变更，避免产生大量无关事件
   * .git/index 在每次 git add 时都会更新，但这对应用层通常不重要
   */
  test("ignores .git/index changes", async () => {
    await using tmp = await tmpdir({ git: true })
    const gitIndex = path.join(tmp.path, ".git", "index")
    const edit = path.join(tmp.path, "tracked.txt")

    await withWatcher(
      tmp.path,
      // 执行 git add（会修改 .git/index），但期望没有相关事件
      noUpdate(
        tmp.path,
        (e) => e.file === gitIndex,
        Effect.promise(async () => {
          await fs.writeFile(edit, "a")
          await $`git add .`.cwd(tmp.path).quiet().nothrow()
        }),
      ),
    )
  })

  /**
   * 测试：发布 .git/HEAD 文件的变更事件
   *
   * 验证监听器能够检测到重要的 git 元数据文件变更
   * .git/HEAD 在切换分支时会更新，这对了解项目状态很重要
   */
  test("publishes .git/HEAD events", async () => {
    await using tmp = await tmpdir({ git: true })
    const head = path.join(tmp.path, ".git", "HEAD")
    const branch = `watch-${Math.random().toString(36).slice(2)}`
    await $`git branch ${branch}`.cwd(tmp.path).quiet()

    await withWatcher(
      tmp.path,
      nextUpdate(
        tmp.path,
        (evt) => evt.file === head && evt.event !== "unlink",
        Effect.promise(() => fs.writeFile(head, `ref: refs/heads/${branch}\n`)),
      ).pipe(
        Effect.tap((evt) =>
          Effect.sync(() => {
            // 验证事件针对正确的文件
            expect(evt.file).toBe(head)
            // 事件类型应该是 add 或 change（取决于初始状态）
            expect(["add", "change"]).toContain(evt.event)
          }),
        ),
      ),
    )
  })
})
