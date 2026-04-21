import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { SessionPrompt } from "../../src/session/prompt"

afterEach(async () => {
  await Instance.disposeAll()
})

describe("session.loop smoke", () => {
  test("loop is exported and callable (smoke)", async () => {
    expect(typeof SessionPrompt.loop).toBe("function")
  })
})

