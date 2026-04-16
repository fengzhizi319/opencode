#!/usr/bin/env bun
import assert from "assert"
import z from "zod"
import { Tool } from "@/tool/tool"

/**
 * 简单 UT：验证 Tool.define 返回的工具 init/execute 包装行为。
 *
 * 目的：让开发者通过运行本脚本学习 tool lifecycle 中的包装/校验/执行流程。
 */
async function main() {
  console.log("[UT] tool-lifecycle - start")

  // 定义一个简单的 echo 工具，用于验证参数校验与执行包装
  const EchoTool = Tool.define(
    "echo",
    async () => ({
      description: "Echo tool for tests",
      parameters: z.object({ msg: z.string() }),
      async execute(args: { msg: string }, ctx) {
        // 检查我们能拿到的 ctx 字段（部分示例）
        // ctx.ask / ctx.metadata 在真实调用中会被使用；这里用作示例
        if (ctx && typeof ctx.sessionID === "string") {
          // no-op
        }
        return {
          title: "Echo",
          metadata: {},
          output: `echo:${args.msg}`,
        }
      },
    }),
  )

  // 初始化工具（Tool.define 的 init 会返回带有参数校验包装的 execute）
  const info = await EchoTool.init()

  // 构造一个最小化的 Tool.Context 给 execute 使用
  const ctx = {
    sessionID: "ut-session",
    messageID: "ut-message",
    agent: "ut-agent",
    abort: new AbortController().signal,
    // optional fields used by wrapper but not needed here
    callID: undefined,
    extra: {},
    messages: [],
    async metadata() {},
    async ask() {},
  }

  // 正常调用：应返回包装后的结果（并且 output 被工具实现返回）
  const result = await info.execute({ msg: "hello" } as any, ctx as any)
  console.log("[UT] execute result:", result.output)
  assert(result.output === "echo:hello")

  // 参数校验：传入错误类型应抛出（Tool.define 包装会在执行前验证参数）
  let threw = false
  try {
    // intentionally pass wrong args to trigger validation error
    await info.execute({ wrong: true } as any, ctx as any)
  } catch (e) {
    threw = true
    console.log("[UT] expected validation error:", (e as Error).message)
  }
  assert(threw, "Expected parameter validation to throw")

  console.log("[UT] tool-lifecycle - PASS")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

