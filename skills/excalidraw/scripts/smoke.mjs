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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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

function findCli() {
  for (const cmd of [["excalidraw"], ["npx", "-y", "@excalidraw/cli"]]) {
    const r = spawnSync(cmd[0], [...cmd.slice(1), "--version"], { encoding: "utf8", timeout: 180000 })
    if (r.status === 0) return cmd
  }
  return null
}

const scene = join(SKILL, "references/minimal-scene.excalidraw")
check("lint: bundled minimal scene is clean", () => assert(/clean/.test(lint(scene)), "linter reported problems"))

const cli = findCli()
const run = (args, opts = {}) =>
  spawnSync(cli[0], [...cli.slice(1), ...args], { encoding: "utf8", timeout: 120000, ...opts })

if (!cli) {
  const msg = "official CLI not runnable (needs Node 22+ and npm or a global install)"
  if (process.env.EXCALIDRAW_REQUIRE_CLI) failed.push(msg)
  else console.log(`skip  cli: ${msg}`)
} else {
  const png = join(tmp, "min.png")
  const probe = run(["render", scene, "--out", png])
  if (probe.status !== 0 && !process.env.EXCALIDRAW_REQUIRE_CLI) {
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
      const r = run(["render", "-", "--out", join(tmp, "bad.png")], { input: "{bad" })
      assert(r.status !== 0, "broken scene rendered without error")
    })
  }
}

rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed.length} failed`)
if (failed.length) process.exit(1)
