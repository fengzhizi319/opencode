#!/usr/bin/env bun
/**
 * Demo: list available skills and print content for `plan-skill`.
 * Usage: bun packages/opencode/scripts/demo-load-skill.ts
 */
import { Skill } from "@/skill"

async function main() {
  console.log("Discovering available skills...")
  const list = await Skill.available()
  console.log(`Found ${list.length} skills:`)
  for (const s of list) {
    console.log(`- ${s.name}: ${s.description}`)
  }

  const name = "plan-skill"
  const info = await Skill.get(name)
  if (!info) {
    console.error(`Skill not found: ${name}`)
    process.exit(1)
  }

  console.log('\n--- SKILL CONTENT ---')
  console.log(`name: ${info.name}`)
  console.log(`location: ${info.location}`)
  console.log('\n' + info.content.slice(0, 2000))
}

main().catch((err)=>{
  console.error(err)
  process.exit(1)
})

