#!/usr/bin/env bun
/**
 * Print recent messages for a session (including parts) to aid debugging.
 * Usage: bun scripts/print-session-messages.ts <SESSION_ID> [limit]
 */
import { Session } from "@/session"

async function main() {
  const id = process.argv[2]
  const limitArg = process.argv[3]
  const limit = limitArg ? parseInt(limitArg, 10) : 50
  if (!id) {
    console.error("Usage: bun scripts/print-session-messages.ts <SESSION_ID> [limit]")
    process.exit(1)
  }

  const msgs = await Session.messages({ sessionID: id, limit })
  for (const m of msgs) {
    console.log("--- MESSAGE ---")
    console.log(`id: ${m.info.id} role: ${m.info.role} agent: ${m.info.agent} model: ${m.info.model?.providerID}/${m.info.model?.modelID}`)
    for (const p of m.parts) {
      console.log(`  part id=${p.id} type=${p.type}`)
      if (p.type === "tool") {
        // @ts-ignore
        console.log(`    tool=${p.tool} status=${(p.state || {}).status}`)
      }
      if (p.type === "text") {
        // @ts-ignore
        console.log(`    text=${String((p as any).text).slice(0, 200).replace(/\n/g, '\\n')}${(p as any).text?.length > 200 ? '...' : ''}`)
      }
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

