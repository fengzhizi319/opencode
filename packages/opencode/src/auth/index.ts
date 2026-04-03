import path from "path"
import { Effect, Layer, Record, Result, Schema, ServiceMap } from "effect"
import { makeRuntime } from "@/effect/run-service"
import { zod } from "@/util/effect-zod"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"

/**
 * OAuth 虚拟密钥，用于不需要真实密钥的场景
 */
export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

/**
 * 认证数据文件路径，存储在全局数据目录下的 auth.json 文件
 */
const file = path.join(Global.Path.data, "auth.json")

/**
 * 错误处理工厂函数
 * 用于创建统一的 AuthError 实例
 * @param message - 错误消息
 * @param cause - 原始错误原因
 * @returns 返回错误创建函数
 */
const fail = (message: string) => (cause: unknown) => new Auth.AuthError({ message, cause })

export namespace Auth {
  /**
   * OAuth 认证信息类
   * 用于存储和管理 OAuth 类型的认证凭据
   */
  export class Oauth extends Schema.Class<Oauth>("OAuth")({
    /**
     * 认证类型标识符，固定为 "oauth"
     */
    type: Schema.Literal("oauth"),
    /**
     * 刷新令牌，用于获取新的访问令牌
     */
    refresh: Schema.String,
    /**
     * 访问令牌，用于 API 请求认证
     */
    access: Schema.String,
    /**
     * 令牌过期时间戳（毫秒）
     */
    expires: Schema.Number,
    /**
     * 可选的账户 ID
     */
    accountId: Schema.optional(Schema.String),
    /**
     * 可选的企业版服务器 URL
     */
    enterpriseUrl: Schema.optional(Schema.String),
  }) {}

  /**
   * API 密钥认证类
   * 用于存储简单的 API Key 认证信息
   */
  export class Api extends Schema.Class<Api>("ApiAuth")({
    /**
     * 认证类型标识符，固定为 "api"
     */
    type: Schema.Literal("api"),
    /**
     * API 密钥字符串
     */
    key: Schema.String,
  }) {}

  /**
   * WellKnown 认证类
   * 用于存储基于密钥和令牌的认证信息
   */
  export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
    /**
     * 认证类型标识符，固定为 "wellknown"
     */
    type: Schema.Literal("wellknown"),
    /**
     * 认证密钥
     */
    key: Schema.String,
    /**
     * 认证令牌
     */
    token: Schema.String,
  }) {}

  /**
   * 联合类型定义，包含所有支持的认证类型
   * 使用判别式 "type" 字段来区分不同的认证类型
   */
  const _Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })

  /**
   * 认证信息类型，附带 Zod 验证器
   * 可用于运行时数据验证
   */
  export const Info = Object.assign(_Info, { zod: zod(_Info) })

  /**
   * 认证信息的 TypeScript 类型推导
   */
  export type Info = Schema.Schema.Type<typeof _Info>

  /**
   * 认证错误类
   * 继承自 Schema.TaggedErrorClass，支持序列化和反序列化
   */
  export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
    /**
     * 错误描述消息
     */
    message: Schema.String,
    /**
     * 可选的原始错误原因
     */
    cause: Schema.optional(Schema.Defect),
  }) {}

  /**
   * 认证服务接口定义
   * 定义了认证服务必须实现的方法
   */
  export interface Interface {
    /**
     * 根据提供商 ID 获取认证信息
     * @param providerID - 服务提供商的唯一标识符
     * @returns 返回认证信息或 undefined，可能抛出 AuthError
     */
    readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>

    /**
     * 获取所有已保存的认证信息
     * @returns 返回以 providerID 为键的认证信息记录，可能抛出 AuthError
     */
    readonly all: () => Effect.Effect<Record<string, Info>, AuthError>

    /**
     * 保存认证信息
     * @param key - 认证信息的键（通常是 providerID）
     * @param info - 要保存的认证信息
     * @returns 成功时返回 void，可能抛出 AuthError
     */
    readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>

    /**
     * 删除指定的认证信息
     * @param key - 要删除的认证信息的键
     * @returns 成功时返回 void，可能抛出 AuthError
     */
    readonly remove: (key: string) => Effect.Effect<void, AuthError>
  }

  /**
   * 认证服务类
   * 使用 Effect 的 ServiceMap 模式定义依赖注入服务
   */
  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Auth") {}

  /**
   * 认证服务的 Layer 实现
   * 提供服务的完整实现逻辑，包括文件系统操作和数据持久化
   */
  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      /**
       * 解码未知数据为 Info 类型的辅助函数
       * 如果解码失败返回 None（Option 类型）
       */
      const decode = Schema.decodeUnknownOption(Info)

      /**
       * 读取所有认证信息的内部实现
       * 从文件系统读取 JSON 并解析为 Info 记录
       */
      const all = Effect.fn("Auth.all")(() =>
        Effect.tryPromise({
          try: async () => {
            // 从文件读取 JSON 数据，失败时返回空对象
            const data = await Filesystem.readJson<Record<string, unknown>>(file).catch(() => ({}))
            // 过滤并转换数据，只保留能成功解码为 Info 的条目
            return Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))
          },
          catch: fail("Failed to read auth data"),
        }),
      )

      /**
       * 获取单个认证信息的实现
       * 复用 all() 方法，然后按 providerID 索引
       */
      const get = Effect.fn("Auth.get")(function* (providerID: string) {
        return (yield* all())[providerID]
      })

      /**
       * 保存认证信息的实现
       * 支持键名规范化（移除末尾斜杠），并清理相关变体
       */
      const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
        // 规范化键名：移除末尾的斜杠
        const norm = key.replace(/\/+$/, "")
        // 获取当前所有认证数据
        const data = yield* all()
        // 如果原始键名与规范化后不同，删除旧键
        if (norm !== key) delete data[key]
        // 删除带斜杠的变体（例如 "provider/"）
        delete data[norm + "/"]
        // 将新数据写入文件，权限设置为 0o600（仅所有者可读写）
        yield* Effect.tryPromise({
          try: () => Filesystem.writeJson(file, { ...data, [norm]: info }, 0o600),
          catch: fail("Failed to write auth data"),
        })
      })

      /**
       * 删除认证信息的实现
       * 同时删除原始键名和规范化后的键名
       */
      const remove = Effect.fn("Auth.remove")(function* (key: string) {
        // 规范化键名
        const norm = key.replace(/\/+$/, "")
        // 获取当前所有认证数据
        const data = yield* all()
        // 删除原始键名和规范化键名的条目
        delete data[key]
        delete data[norm]
        // 将更新后的数据写入文件
        yield* Effect.tryPromise({
          try: () => Filesystem.writeJson(file, data, 0o600),
          catch: fail("Failed to write auth data"),
        })
      })

      // 构造并返回服务实例
      return Service.of({ get, all, set, remove })
    }),
  )

  /**
   * 创建运行时环境，用于执行 Effect 程序
   * 配置了必要的服务依赖
   */
  const { runPromise } = makeRuntime(Service, layer)

  /**
   * 异步获取指定提供商的认证信息
   * @param providerID - 服务提供商 ID
   * @returns 返回认证信息或 undefined
   */
  export async function get(providerID: string) {
    return runPromise((service) => service.get(providerID))
  }

  /**
   * 异步获取所有认证信息
   * @returns 返回包含所有认证信息的记录对象
   */
  export async function all(): Promise<Record<string, Info>> {
    return runPromise((service) => service.all())
  }

  /**
   * 异步保存认证信息
   * @param key - 认证信息的键
   * @param info - 要保存的认证信息
   */
  export async function set(key: string, info: Info) {
    return runPromise((service) => service.set(key, info))
  }

  /**
   * 异步删除认证信息
   * @param key - 要删除的认证信息的键
   */
  export async function remove(key: string) {
    return runPromise((service) => service.remove(key))
  }
}
