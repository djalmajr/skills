import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import { MAX_SKILL_LINES, validate } from "./validate-skills.mjs"

let root

function write(rel, text) {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text)
}

function skill(name, body = "", description = `Does ${name}. Use when testing.`) {
  const sections = "\n## Project root\n\n## Prompting\n"
  write(`skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n${sections}${body}\n`)
}

function manifest(names) {
  write("skills.json", JSON.stringify({ skills: [{ source: "x/y", skills: names }] }))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "validate-skills-"))
  skill("agile-story", "See `templates/story.md`.")
  write("skills/agile-story/templates/story.md", "# story\n")
  skill("agile-router", "Use `/agile-story`.")
  skill("plan-goal")
  manifest(["agile-router", "agile-story", "plan-goal"])
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

test("a consistent package passes", () => {
  assert.deepEqual(validate(root), [])
})

test("manifest must match the skill directories", () => {
  manifest(["agile-router", "agile-story", "aim-init"])
  assert.deepEqual(validate(root).sort(), [
    "skills.json: does not list plan-goal",
    "skills.json: lists missing skill aim-init",
  ])
})

test("frontmatter name must match the directory", () => {
  write("skills/plan-goal/SKILL.md", "---\nname: plan\ndescription: x\n---\n## Project root\n## Prompting\n")
  assert.deepEqual(validate(root), ['skills/plan-goal/SKILL.md: frontmatter name "plan" differs from directory'])
})

test("folded multi-line descriptions are read", () => {
  write("skills/plan-goal/SKILL.md", "---\nname: plan-goal\ndescription: >\n  Line one\n  line two.\n---\n## Project root\n## Prompting\n")
  assert.deepEqual(validate(root), [])
})

test("missing bundled file is reported, .tmpl variant accepted", () => {
  skill("plan-goal", "Uses `templates/plan.md` and `scripts/run.sh`.")
  write("skills/plan-goal/scripts/run.sh.tmpl", "")
  assert.deepEqual(validate(root), ["skills/plan-goal/SKILL.md: references missing file templates/plan.md"])
})

test("unknown agile skill mention is reported", () => {
  skill("plan-goal", "Then run agile-pen.")
  assert.deepEqual(validate(root), ["skills/plan-goal/SKILL.md: mentions unknown skill agile-pen"])
})

test("router must cover every agile skill and only agile skills", () => {
  skill("agile-epic")
  manifest(["agile-epic", "agile-router", "agile-story", "plan-goal"])
  skill("agile-router", "Use `/agile-story` or `/plan-goal`.")
  assert.deepEqual(validate(root).sort(), [
    "skills/agile-router/SKILL.md: does not route to /agile-epic",
    "skills/agile-router/SKILL.md: routes to non-agile /plan-goal",
  ])
})

test("SKILL.md over the line budget is reported", () => {
  skill("plan-goal", "x\n".repeat(MAX_SKILL_LINES))
  assert.match(validate(root)[0], /plan-goal\/SKILL.md: \d+ lines/)
})

test("README table and count must match", () => {
  write("README.md", "## Skills (2)\n\n| agile-story | x |\n| agile-router | x |\n")
  assert.deepEqual(validate(root).sort(), [
    "README.md: heading says 2 skills, found 3",
    "README.md: skill table lacks plan-goal",
  ])
})

test("convention sections are required, project root only where artifacts are written", () => {
  write("skills/plan-goal/SKILL.md", "---\nname: plan-goal\ndescription: x\n---\n")
  write("skills/agile-router/SKILL.md", "---\nname: agile-router\ndescription: x\n---\n## Prompting\nUse `/agile-story`.\n")
  assert.deepEqual(validate(root).sort(), [
    "skills/plan-goal/SKILL.md: missing ## Project root section",
    "skills/plan-goal/SKILL.md: missing ## Prompting section",
  ])
})

test("CRLF files parse, the line budget is exact, and plain paths are not commands", () => {
  write("skills/plan-goal/SKILL.md", "---\r\nname: plan-goal\r\ndescription: x\r\n---\r\n## Project root\r\n## Prompting\r\n")
  skill("agile-router", "Use `/agile-story`; scratch files go to `/tmp`.")
  assert.deepEqual(validate(root), [])
  const header = "---\nname: agile-story\ndescription: x\n---\n## Project root\n## Prompting\n"
  const pad = MAX_SKILL_LINES - header.split("\n").length + 1
  write("skills/agile-story/SKILL.md", header + "x\n".repeat(pad))
  assert.deepEqual(validate(root), [])
})

test("router coverage needs the exact skill name", () => {
  skill("agile-pro")
  manifest(["agile-pro", "agile-router", "agile-story", "plan-goal"])
  skill("agile-router", "Use `/agile-story` or `/agile-prototype`.")
  assert.ok(validate(root).includes("skills/agile-router/SKILL.md: does not route to /agile-pro"))
})
