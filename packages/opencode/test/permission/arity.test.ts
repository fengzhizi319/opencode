import { test, expect } from "bun:test"
import { BashArity } from "../../src/permission/arity"

/**
 * BashArity 测试套件 - Shell 命令权限前缀提取
 * 
 * 背景：
 * 在权限控制系统中，需要识别 shell 命令的"关键前缀"来判断是否需要用户授权。
 * 不同的命令有不同的 arity（元数/参数数量），即需要多少个 token 才能唯一标识一个命令。
 * 
 * 示例：
 * - `touch file.txt` → 前缀 ["touch"] (arity 1)
 * - `git checkout main` → 前缀 ["git", "checkout"] (arity 2)
 * - `aws s3 ls bucket` → 前缀 ["aws", "s3", "ls"] (arity 3)
 * 
 * 技术原理：
 * BashArity.prefix() 分析命令 tokens，返回能唯一标识该命令的最短前缀。
 * 这用于权限规则匹配，例如规则可以配置为允许 "git checkout" 但禁止 "git push"。
 */

/**
 * 测试用例：Arity 1 - 未知命令默认为第一个 token
 * 
 * 测试目的：
 * - 验证不在已知命令列表中的命令默认使用 arity 1
 * - 确保简单命令（如 touch、cp、mv）只取第一个 token 作为前缀
 * - 这是最保守的策略，避免误判
 * 
 * 验证点：
 * - 完全未知的命令序列取第一个 token
 * - 常见的单 token 命令（touch）也取第一个 token
 * - 后续的参数（如文件名）被忽略
 */
test("arity 1 - unknown commands default to first token", () => {
  // 未知命令：只取第一个 token "unknown"
  expect(BashArity.prefix(["unknown", "command", "subcommand"])).toEqual(["unknown"])
  // 常见命令 touch：只取 "touch"，忽略文件名 "foo.txt"
  expect(BashArity.prefix(["touch", "foo.txt"])).toEqual(["touch"])
})

/**
 * 测试用例：Arity 2 - 双 token 命令
 * 
 * 测试目的：
 * - 验证需要两个 token 才能唯一标识的命令
 * - 确保子命令被正确包含在前缀中
 * 
 * 使用场景：
 * - Git 的各种子命令（checkout、commit、push 等）需要区分
 * - Docker 的子命令（run、build、ps 等）有不同的权限要求
 * 
 * 验证点：
 * - git checkout main → 前缀是 ["git", "checkout"]，不包括分支名 "main"
 * - docker run nginx → 前缀是 ["docker", "run"]，不包括镜像名 "nginx"
 * - 第三个及以后的 token 被视为参数，不包含在前缀中
 */
test("arity 2 - two token commands", () => {
  expect(BashArity.prefix(["git", "checkout", "main"])).toEqual(["git", "checkout"])
  expect(BashArity.prefix(["docker", "run", "nginx"])).toEqual(["docker", "run"])
})

/**
 * 测试用例：Arity 3 - 三 token 命令
 * 
 * 测试目的：
 * - 验证需要三个 token 才能唯一标识的深层嵌套命令
 * - 确保多级子命令结构能被正确解析
 * 
 * 使用场景：
 * - AWS CLI 的三层结构：aws <service> <operation>
 * - NPM scripts：npm run <script-name>
 * - Kubernetes：kubectl get <resource-type>
 * 
 * 验证点：
 * - aws s3 ls my-bucket → 前缀是 ["aws", "s3", "ls"]，不包括桶名
 * - npm run dev script → 前缀是 ["npm", "run", "dev"]，不包括额外参数
 * - 第四个及以后的 token 被视为参数
 */
test("arity 3 - three token commands", () => {
  expect(BashArity.prefix(["aws", "s3", "ls", "my-bucket"])).toEqual(["aws", "s3", "ls"])
  expect(BashArity.prefix(["npm", "run", "dev", "script"])).toEqual(["npm", "run", "dev"])
})

/**
 * 测试用例：最长匹配优先 - 嵌套前缀处理
 * 
 * 测试目的：
 * - 验证当存在多个可能的前缀时，选择最长的匹配
 * - 确保更具体的命令优先于通用命令
 * 
 * 技术原理：
 * 某些命令可能有不同深度的子命令结构。算法应该选择能最精确标识命令的前缀。
 * 例如：docker compose up 比 docker compose 更具体，应该优先匹配。
 * 
 * 验证点：
 * - docker compose up service → 前缀是 ["docker", "compose", "up"] (arity 3)
 *   而不是 ["docker", "compose"] (arity 2)，因为 "up" 是更完整的命令标识
 * - consul kv get config → 前缀是 ["consul", "kv", "get"] (arity 3)
 *   Consul 的 KV 存储操作需要三层结构
 * 
 * 重要性：
 * 这确保了权限规则可以精细控制，例如允许 "docker compose up" 但禁止 "docker compose down"
 */
test("longest match wins - nested prefixes", () => {
  expect(BashArity.prefix(["docker", "compose", "up", "service"])).toEqual(["docker", "compose", "up"])
  expect(BashArity.prefix(["consul", "kv", "get", "config"])).toEqual(["consul", "kv", "get"])
})

/**
 * 测试用例：精确长度匹配
 * 
 * 测试目的：
 * - 验证当命令 tokens 数量正好等于 arity 时的行为
 * - 确保没有多余参数时也能正确返回完整前缀
 * 
 * 验证点：
 * - git checkout（没有分支名）→ 前缀仍然是 ["git", "checkout"]
 * - npm run dev（没有额外参数）→ 前缀仍然是 ["npm", "run", "dev"]
 * - 即使没有参数，前缀也应该完整保留
 * 
 * 边界情况：
 * 这测试了命令刚好达到其 arity 但没有额外参数的场景，
 * 确保算法不会因为缺少参数而截断前缀。
 */
test("exact length matches", () => {
  expect(BashArity.prefix(["git", "checkout"])).toEqual(["git", "checkout"])
  expect(BashArity.prefix(["npm", "run", "dev"])).toEqual(["npm", "run", "dev"])
})

/**
 * 测试用例：边界情况处理
 * 
 * 测试目的：
 * - 验证空输入、单元素等极端情况的健壮性
 * - 确保不会因异常输入导致崩溃或错误结果
 * 
 * 验证点：
 * - 空数组 [] → 返回空数组 []
 * - 单个 token ["single"] → 返回 ["single"]
 * - 单个命令 ["git"] → 返回 ["git"]，即使 git 通常是 arity 2
 * 
 * 重要性：
 * 这些边界情况在实际使用中可能出现，例如：
 * - 用户输入不完整的命令
 * - 命令解析过程中的中间状态
 * - 测试或调试时的特殊情况
 * 
 * 容错性：
 * 算法应该优雅地处理这些情况，而不是抛出异常或返回 undefined。
 */
test("edge cases", () => {
  expect(BashArity.prefix([])).toEqual([])
  expect(BashArity.prefix(["single"])).toEqual(["single"])
  expect(BashArity.prefix(["git"])).toEqual(["git"])
})
