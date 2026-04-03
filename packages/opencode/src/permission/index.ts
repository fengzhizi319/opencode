import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { ProjectID } from "@/project/schema"
import { Instance } from "@/project/instance"
import { MessageID, SessionID } from "@/session/schema"
import { PermissionTable } from "@/session/session.sql"
import { Database, eq } from "@/storage/db"
import { Log } from "@/util/log"
import { Wildcard } from "@/util/wildcard"
import { Deferred, Effect, Layer, Schema, ServiceMap } from "effect"
import os from "os"
import z from "zod"
import { evaluate as evalRule } from "./evaluate"
import { PermissionID } from "./schema"

/**
 * Permission module: evaluates and enforces tool permission rules.
 *
 * Rulesets are merged from agent defaults, user config, and session overrides.
 * Each rule specifies an action (allow/deny/ask) for a permission name and pattern.
 * When a tool is invoked, `ask()` either grants immediate passage (allow), throws
 * a denial error (deny), or suspends execution pending user confirmation (ask).
 */
export namespace Permission {
  const log = Log.create({ service: "permission" })

  /** Possible actions for a permission rule. */
  export const Action = z.enum(["allow", "deny", "ask"]).meta({
    ref: "PermissionAction",
  })
  export type Action = z.infer<typeof Action>

  /** A single permission rule matching a permission name and pattern to an action. */
  export const Rule = z
    .object({
      permission: z.string(),
      pattern: z.string(),
      action: Action,
    })
    .meta({
      ref: "PermissionRule",
    })
  export type Rule = z.infer<typeof Rule>

  /** Ordered list of rules; later rules override earlier ones. */
  export const Ruleset = Rule.array().meta({
    ref: "PermissionRuleset",
  })
  export type Ruleset = z.infer<typeof Ruleset>

  /** A permission request awaiting user confirmation. */
  export const Request = z
    .object({
      id: PermissionID.zod,
      sessionID: SessionID.zod,
      permission: z.string(),
      patterns: z.string().array(),
      metadata: z.record(z.string(), z.any()),
      always: z.string().array(),
      tool: z
        .object({
          messageID: MessageID.zod,
          callID: z.string(),
        })
        .optional(),
    })
    .meta({
      ref: "PermissionRequest",
    })
  export type Request = z.infer<typeof Request>

  /** User response to a permission request. */
  export const Reply = z.enum(["once", "always", "reject"])
  export type Reply = z.infer<typeof Reply>

  /** Persisted approval record for a project. */
  export const Approval = z.object({
    projectID: ProjectID.zod,
    patterns: z.string().array(),
  })

  /** Domain events emitted by the Permission module. */
  export const Event = {
    Asked: BusEvent.define("permission.asked", Request),
    Replied: BusEvent.define(
      "permission.replied",
      z.object({
        sessionID: SessionID.zod,
        requestID: PermissionID.zod,
        reply: Reply,
      }),
    ),
  }

  /** Error thrown when the user rejects a permission request. */
  export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("PermissionRejectedError", {}) {
    override get message() {
      return "The user rejected permission to use this specific tool call."
    }
  }

  /** Error thrown when the user rejects a permission request with corrective feedback. */
  export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("PermissionCorrectedError", {
    feedback: Schema.String,
  }) {
    override get message() {
      return `The user rejected permission to use this specific tool call with the following feedback: ${this.feedback}`
    }
  }

  /** Error thrown when a permission rule explicitly denies the operation. */
  export class DeniedError extends Schema.TaggedErrorClass<DeniedError>()("PermissionDeniedError", {
    ruleset: Schema.Any,
  }) {
    override get message() {
      return `The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules ${JSON.stringify(this.ruleset)}`
    }
  }

  /** Union of all permission-related errors. */
  export type Error = DeniedError | RejectedError | CorrectedError

  export const AskInput = Request.partial({ id: true }).extend({
    ruleset: Ruleset,
  })

  export const ReplyInput = z.object({
    requestID: PermissionID.zod,
    reply: Reply,
    message: z.string().optional(),
  })

  /** Service interface for permission checking and user interaction. */
  export interface Interface {
    readonly ask: (input: z.infer<typeof AskInput>) => Effect.Effect<void, Error>
    readonly reply: (input: z.infer<typeof ReplyInput>) => Effect.Effect<void>
    readonly list: () => Effect.Effect<Request[]>
  }

  interface PendingEntry {
    info: Request
    deferred: Deferred.Deferred<void, RejectedError | CorrectedError>
  }

  interface State {
    pending: Map<PermissionID, PendingEntry>
    approved: Ruleset
  }

  /**
   * Evaluate permission rules against a permission name and pattern.
   * Returns the last matching rule's action across all provided rulesets.
   */
  export function evaluate(permission: string, pattern: string, ...rulesets: Ruleset[]): Rule {
    log.info("evaluate", { permission, pattern, ruleset: rulesets.flat() })
    return evalRule(permission, pattern, ...rulesets)
  }

  /** Effect-TS service tag for Permission. */
  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Permission") {}

  /** Effect-TS layer providing the Permission service. */
  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const state = yield* InstanceState.make<State>(
        Effect.fn("Permission.state")(function* (ctx) {
          const row = Database.use((db) =>
            db.select().from(PermissionTable).where(eq(PermissionTable.project_id, ctx.project.id)).get(),
          )
          const state = {
            pending: new Map<PermissionID, PendingEntry>(),
            approved: row?.data ?? [],
          }

          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              for (const item of state.pending.values()) {
                yield* Deferred.fail(item.deferred, new RejectedError())
              }
              state.pending.clear()
            }),
          )

          return state
        }),
      )

      const ask = Effect.fn("Permission.ask")(function* (input: z.infer<typeof AskInput>) {
        const { approved, pending } = yield* InstanceState.get(state)
        const { ruleset, ...request } = input
        let needsAsk = false

        for (const pattern of request.patterns) {
          const rule = evaluate(request.permission, pattern, ruleset, approved)
          log.info("evaluated", { permission: request.permission, pattern, action: rule })
          if (rule.action === "deny") {
            return yield* new DeniedError({
              ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
            })
          }
          if (rule.action === "allow") continue
          needsAsk = true
        }

        if (!needsAsk) return

        const id = request.id ?? PermissionID.ascending()
        const info: Request = {
          id,
          ...request,
        }
        log.info("asking", { id, permission: info.permission, patterns: info.patterns })

        const deferred = yield* Deferred.make<void, RejectedError | CorrectedError>()
        pending.set(id, { info, deferred })
        void Bus.publish(Event.Asked, info)
        return yield* Effect.ensuring(
          Deferred.await(deferred),
          Effect.sync(() => {
            pending.delete(id)
          }),
        )
      })

      const reply = Effect.fn("Permission.reply")(function* (input: z.infer<typeof ReplyInput>) {
        const { approved, pending } = yield* InstanceState.get(state)
        const existing = pending.get(input.requestID)
        if (!existing) return

        pending.delete(input.requestID)
        void Bus.publish(Event.Replied, {
          sessionID: existing.info.sessionID,
          requestID: existing.info.id,
          reply: input.reply,
        })

        if (input.reply === "reject") {
          yield* Deferred.fail(
            existing.deferred,
            input.message ? new CorrectedError({ feedback: input.message }) : new RejectedError(),
          )

          for (const [id, item] of pending.entries()) {
            if (item.info.sessionID !== existing.info.sessionID) continue
            pending.delete(id)
            void Bus.publish(Event.Replied, {
              sessionID: item.info.sessionID,
              requestID: item.info.id,
              reply: "reject",
            })
            yield* Deferred.fail(item.deferred, new RejectedError())
          }
          return
        }

        yield* Deferred.succeed(existing.deferred, undefined)
        if (input.reply === "once") return

        for (const pattern of existing.info.always) {
          approved.push({
            permission: existing.info.permission,
            pattern,
            action: "allow",
          })
        }

        for (const [id, item] of pending.entries()) {
          if (item.info.sessionID !== existing.info.sessionID) continue
          const ok = item.info.patterns.every(
            (pattern) => evaluate(item.info.permission, pattern, approved).action === "allow",
          )
          if (!ok) continue
          pending.delete(id)
          void Bus.publish(Event.Replied, {
            sessionID: item.info.sessionID,
            requestID: item.info.id,
            reply: "always",
          })
          yield* Deferred.succeed(item.deferred, undefined)
        }
      })

      const list = Effect.fn("Permission.list")(function* () {
        const pending = (yield* InstanceState.get(state)).pending
        return Array.from(pending.values(), (item) => item.info)
      })

      return Service.of({ ask, reply, list })
    }),
  )

  function expand(pattern: string): string {
    if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
    if (pattern === "~") return os.homedir()
    if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
    if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
    return pattern
  }

  /** Convert a user config permission map into an ordered Ruleset. */
  export function fromConfig(permission: Config.Permission) {
    const ruleset: Ruleset = []
    for (const [key, value] of Object.entries(permission)) {
      if (typeof value === "string") {
        ruleset.push({ permission: key, action: value, pattern: "*" })
        continue
      }
      ruleset.push(
        ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
      )
    }
    return ruleset
  }

  /** Merge multiple rulesets into a single flat list (later rules take precedence). */
  export function merge(...rulesets: Ruleset[]): Ruleset {
    return rulesets.flat()
  }

  const EDIT_TOOLS = ["edit", "write", "apply_patch", "multiedit"]

  /** Determine which tools are globally disabled (denied with pattern "*") in the ruleset. */
  export function disabled(tools: string[], ruleset: Ruleset): Set<string> {
    const result = new Set<string>()
    for (const tool of tools) {
      const permission = EDIT_TOOLS.includes(tool) ? "edit" : tool
      const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
      if (!rule) continue
      if (rule.pattern === "*" && rule.action === "deny") result.add(tool)
    }
    return result
  }

  export const { runPromise } = makeRuntime(Service, layer)

  export async function ask(input: z.infer<typeof AskInput>) {
    return runPromise((s) => s.ask(input))
  }

  export async function reply(input: z.infer<typeof ReplyInput>) {
    return runPromise((s) => s.reply(input))
  }

  export async function list() {
    return runPromise((s) => s.list())
  }
}
