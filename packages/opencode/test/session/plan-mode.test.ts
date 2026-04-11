import path from "path"
import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "@/flag/flag.ts"
import { Instance } from "@/project/instance.ts"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt.ts"
import { tmpdir } from "../fixture/fixture"

function cfg(url: string) {
  return {
    $schema: "https://opencode.ai/config.json",
    provider: {
      ollama: {
        npm: "@ai-sdk/openai-compatible",
        name: "Ollama (local)",
        options: {
          apiKey: "not-needed",
          baseURL: `${url}/v1`,
        },
        models: {
          "qwen3.5:0.8b": {
            name: "Qwen 3.5 0.8B",
          },
        },
      },
    },
    agent: {
      plan: {
        model: "ollama/qwen3.5:0.8b",
        steps: 1,
      },
      build: {
        model: "ollama/qwen3.5:0.8b",
        steps: 1,
      },
    },
  }
}

afterEach(async () => {
  await Instance.disposeAll()
})

describe("plan mode flow", () => {
  test("computes the plan file path under .opencode/plans", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const plan = Session.plan(session)

        expect(plan.startsWith(path.join(tmp.path, ".opencode", "plans"))).toBe(true)
        expect(plan.endsWith(".md")).toBe(true)

        await Session.remove(session.id)
      },
    })
  })

  test(
    "injects reminders into real ollama requests",
    async () => {
      const seen: unknown[] = []
      const proxy = Bun.serve({
        port: 0,
        async fetch(req) {
          const url = new URL(req.url)
          if (!url.pathname.startsWith("/v1/")) return new Response("not found", { status: 404 })
          const body = await req.text()
          if (body) seen.push(JSON.parse(body) as unknown)
          return fetch(`http://localhost:11434${url.pathname}${url.search}`, {
            method: req.method,
            headers: req.headers,
            body: body || undefined,
          })
        },
      })

      try {
        await using tmp = await tmpdir({
          git: true,
          init: async (dir) => {
            await Bun.write(path.join(dir, "opencode.json"), JSON.stringify(cfg(proxy.url.origin)))
          },
        })

        await Instance.provide({
          directory: tmp.path,
          fn: async () => {
            const session = await Session.create({})
            await SessionPrompt.prompt({
              sessionID: session.id,
              agent: "plan",
              parts: [{ type: "text", text: "write a plan" }],
            })
            if (Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE) {
              await Bun.write(Session.plan(session), "# plan\n")
            }
            await SessionPrompt.prompt({
              sessionID: session.id,
              agent: "build",
              parts: [{ type: "text", text: "continue" }],
            })

            const body = (text: string) => seen.find((item) => JSON.stringify(item).includes(text))

            expect(
              Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE
                ? body("Plan mode is active. The user indicated that they do not want you to execute yet")
                : body("# Plan Mode - System Reminder"),
            ).toBeDefined()
            expect(body("Your operational mode has changed from plan to build")).toBeDefined()
            expect(body("You are no longer in read-only mode")).toBeDefined()

            await Session.remove(session.id)
          },
        })
      } finally {
        proxy.stop(true)
      }
    },
    { timeout: 120000 },
  )
})
