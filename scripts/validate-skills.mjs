#!/usr/bin/env node
// Structural lint for the skills package.
//
//   node scripts/validate-skills.mjs [repo-root]
//
// Exits 1 and prints one line per problem when the package is inconsistent.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const MAX_SKILL_LINES = 500
export const MAX_DESCRIPTION = 1024

// Skills that write no artifacts and so declare no project root.
const NO_PROJECT_ROOT = new Set(["agile-onboarding", "agile-router"])

const ASSET_DIRS = ["templates", "references", "scripts", "assets", "agents"]

// Paths a skill tells the agent to create in the consumer project, not files it ships.
const CONSUMER_PATHS = {
  "design-workflow": ["scripts/design/"],
}

export function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/)
  if (!m) return null
  const fields = {}
  const lines = m[1].split("\n")
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_-]+):\s*(.*)$/)
    if (!kv) continue
    let [, key, value] = kv
    if (/^[>|][+-]?$/.test(value)) {
      const block = []
      while (i + 1 < lines.length && /^(\s+|$)/.test(lines[i + 1]) && lines[i + 1] !== "") {
        block.push(lines[++i].trim())
      }
      value = block.join(" ")
    }
    fields[key] = value.replace(/^["']|["']$/g, "").trim()
  }
  return fields
}

function listSkills(root) {
  const dir = join(root, "skills")
  return readdirSync(dir)
    .filter((n) => statSync(join(dir, n)).isDirectory())
    .sort()
}

function shippedPathExists(skillDir, rel) {
  const clean = rel.replace(/[.,;:)]+$/, "")
  return [clean, `${clean}.tmpl`].some((p) => existsSync(join(skillDir, p)))
}

export function validate(root) {
  const errors = []
  const err = (where, msg) => errors.push(`${where}: ${msg}`)
  const skills = listSkills(root)
  const known = new Set(skills)
  const agile = skills.filter((s) => s.startsWith("agile-"))

  for (const name of skills) {
    const dir = join(root, "skills", name)
    const file = join(dir, "SKILL.md")
    const where = `skills/${name}/SKILL.md`
    if (!existsSync(file)) {
      err(`skills/${name}`, "missing SKILL.md")
      continue
    }
    const text = readFileSync(file, "utf8")
    const fm = parseFrontmatter(text)
    if (!fm) {
      err(where, "missing YAML frontmatter")
      continue
    }
    if (fm.name !== name) err(where, `frontmatter name "${fm.name}" differs from directory`)
    if (!fm.description) err(where, "empty description")
    else if (fm.description.length > MAX_DESCRIPTION)
      err(where, `description has ${fm.description.length} chars (max ${MAX_DESCRIPTION})`)

    if (!/^## Prompting$/m.test(text)) err(where, "missing ## Prompting section")
    if (!NO_PROJECT_ROOT.has(name) && !/^## Project root$/m.test(text))
      err(where, "missing ## Project root section")

    const lines = text.split("\n").length
    if (lines > MAX_SKILL_LINES)
      err(where, `${lines} lines (max ${MAX_SKILL_LINES}); move detail to references/`)

    const consumer = CONSUMER_PATHS[name] ?? []
    const pathRe = new RegExp(`(?<![\\w./-])((?:${ASSET_DIRS.join("|")})/[\\w./-]*[\\w/])`, "g")
    for (const [, rel] of text.matchAll(pathRe)) {
      if (consumer.some((c) => rel.startsWith(c))) continue
      if (!shippedPathExists(dir, rel)) err(where, `references missing file ${rel}`)
    }

    for (const [, ref] of text.matchAll(/(?<![\w./-])((?:agile|ux)-[a-z]+(?:-[a-z]+)*)\b/g)) {
      if (!known.has(ref)) err(where, `mentions unknown skill ${ref}`)
    }
  }

  // Manifest
  const manifestPath = join(root, "skills.json")
  if (!existsSync(manifestPath)) err("skills.json", "missing")
  else {
    const listed = JSON.parse(readFileSync(manifestPath, "utf8")).skills.flatMap((g) => g.skills)
    for (const s of skills) if (!listed.includes(s)) err("skills.json", `does not list ${s}`)
    for (const s of listed) if (!known.has(s)) err("skills.json", `lists missing skill ${s}`)
    if (new Set(listed).size !== listed.length) err("skills.json", "has duplicate entries")
  }

  // Router knows every agile skill and nothing else.
  const routerPath = join(root, "skills/agile-router/SKILL.md")
  if (existsSync(routerPath)) {
    const router = readFileSync(routerPath, "utf8")
    for (const s of agile) {
      if (s !== "agile-router" && !router.includes(`/${s}`))
        err("skills/agile-router/SKILL.md", `does not route to /${s}`)
    }
    for (const [, cmd] of router.matchAll(/`\/([a-z][\w-]*)`/g)) {
      if (!cmd.startsWith("agile-")) err("skills/agile-router/SKILL.md", `routes to non-agile /${cmd}`)
    }
  }

  // Human indexes list every skill and keep the total right.
  const readme = join(root, "README.md")
  if (existsSync(readme)) {
    const text = readFileSync(readme, "utf8")
    for (const s of skills)
      if (!new RegExp(`^\\|\\s*${s}\\s*\\|`, "m").test(text)) err("README.md", `skill table lacks ${s}`)
    const total = text.match(/^## Skills \((\d+)\)/m)
    if (total && Number(total[1]) !== skills.length)
      err("README.md", `heading says ${total[1]} skills, found ${skills.length}`)
  }
  const docsIndex = join(root, "docs/skills/README.md")
  if (existsSync(docsIndex)) {
    const text = readFileSync(docsIndex, "utf8")
    for (const s of skills) if (!text.includes(`[${s}]`)) err("docs/skills/README.md", `lacks ${s}`)
  }

  return errors
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."))
  const errors = validate(root)
  if (errors.length) {
    for (const e of errors) console.error(e)
    console.error(`\n${errors.length} problem(s) in ${listSkills(root).length} skills`)
    process.exit(1)
  }
  console.log(`ok  ${listSkills(root).length} skills valid`)
}
