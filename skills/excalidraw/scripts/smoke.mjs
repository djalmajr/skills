/**
 * Smoke for the excalidraw skill.
 *
 *   node skills/excalidraw/scripts/smoke.mjs
 *
 * Always: lints the bundled scene. With the official CLI and a browser: renders
 * it, converts Mermaid to a native scene, and checks a broken scene fails.
 * Set EXCALIDRAW_REQUIRE_CLI=1 to fail instead of skipping when the CLI can't run.
 */
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const SKILL = join(dirname(fileURLToPath(import.meta.url)), "..")
const tmp = mkdtempSync(join(tmpdir(), "excalidraw-smoke-"))
const failed = []
let passed = 0

function check(name, fn) {
  try {
    fn()
    passed++
    console.log(`ok  ${name}`)
  } catch (e) {
    failed.push(name)
    console.log(`FAIL ${name}: ${e.message}`)
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const lint = (file) => execFileSync("node", [join(SKILL, "scripts/lint-scene.mjs"), file], { encoding: "utf8" })
const lintStatus = (file) => spawnSync("node", [join(SKILL, "scripts/lint-scene.mjs"), file], { encoding: "utf8" })
const requireCli = ["1", "true", "yes"].includes(String(process.env.EXCALIDRAW_REQUIRE_CLI ?? "").toLowerCase())

// The skill documents the 1.x CLI: a global install of another major is skipped
// (its version is reported) and the pinned npx package is used instead.
const CLI_MAJOR = 1
const isSupportedVersion = (out) => new RegExp(`^v?${CLI_MAJOR}\\.`).test(String(out).trim().split("\n").pop() ?? "")

function findCli() {
  for (const cmd of [["excalidraw"], ["npx", "-y", `@excalidraw/cli@${CLI_MAJOR}`]]) {
    const r = spawnSync(cmd[0], [...cmd.slice(1), "--version"], { encoding: "utf8", timeout: 180000 })
    if (r.status !== 0) continue
    if (isSupportedVersion(r.stdout)) return cmd
    console.log(`skip  ${cmd.join(" ")}: version ${r.stdout.trim()} is not ${CLI_MAJOR}.x`)
  }
  return null
}

const scene = join(SKILL, "references/minimal-scene.excalidraw")
check("lint: bundled minimal scene is clean", () => assert(/clean/.test(lint(scene)), "linter reported problems"))

// Mutation guarded: a linter that never reports (e.g. `return []`) must fail here.
check("lint: an unbound arrow is reported with a non-zero exit", () => {
  const broken = JSON.parse(readFileSync(scene, "utf8"))
  for (const el of broken.elements) {
    if (el.type === "arrow") { el.startBinding = null; el.endBinding = null }
    if (el.boundElements) el.boundElements = el.boundElements.filter((b) => b.type !== "arrow")
  }
  const file = join(tmp, "unbound.excalidraw")
  writeFileSync(file, JSON.stringify(broken))
  const r = lintStatus(file)
  assert(r.status !== 0, "linter accepted an unbound arrow")
})

const cli = findCli()
const run = (args, opts = {}) =>
  spawnSync(cli[0], [...cli.slice(1), ...args], { encoding: "utf8", timeout: 120000, ...opts })

if (!cli) {
  const msg = "official CLI not runnable (needs Node 22+ and npm or a global install)"
  if (requireCli) {
    failed.push("cli")
    console.log(`FAIL cli: ${msg}`)
  } else console.log(`skip  cli: ${msg}`)
} else {
  const png = join(tmp, "min.png")
  const probe = run(["render", scene, "--out", png])
  if (probe.status !== 0 && !requireCli) {
    console.log(`skip  cli: render failed, likely no browser (${probe.stderr.trim().split("\n").pop()})`)
  } else {
    check("cli render: minimal scene -> PNG", () => {
      assert(probe.status === 0, probe.stderr)
      const head = readFileSync(png).subarray(0, 8).toString("hex")
      assert(head === "89504e470d0a1a0a", "output is not a PNG")
    })

    check("cli mermaid: flowchart -> bound native scene that lints clean", () => {
      const mmd = join(tmp, "flow.mmd")
      const out = join(tmp, "flow.excalidraw")
      writeFileSync(mmd, "graph LR\n  A[Client] --> B[API]\n  B --> C[(DB)]\n")
      const r = run(["mermaid", mmd, "--out", out, "--elbow"])
      assert(r.status === 0, r.stderr)
      const { elements } = JSON.parse(readFileSync(out, "utf8"))
      const arrows = elements.filter((e) => e.type === "arrow")
      assert(arrows.length === 2, `expected 2 arrows, got ${arrows.length}`)
      assert(arrows.every((a) => a.startBinding && a.endBinding), "arrows are not bound to both shapes")
      assert(/clean/.test(lint(out)), "linter reported problems")
    })

    check("cli render: invalid JSON fails with non-zero exit", () => {
      // Render already worked above, so the browser is fine; the failure must come
      // from the input. Check that no output was written and the error is about JSON,
      // without depending on the exact wording.
      const out = join(tmp, "bad.png")
      const r = run(["render", "-", "--out", out], { input: "{bad" })
      assert(r.status !== 0, "broken scene rendered without error")
      assert(!existsSync(out), "a PNG was written for a broken scene")
      assert(/json/i.test(r.stderr), `failed for another reason: ${r.stderr.trim()}`)
    })
  }
}

rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed.length} failed`)
if (failed.length) process.exit(1)
