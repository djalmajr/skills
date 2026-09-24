// Harness (test-only). Runs the same scenario through Bash on the POSIX
// launcher and through `node scripts/herdr-agents.mjs` in an
// identical fixture (temporary git repo, temporary HOME / XDG_CONFIG_HOME /
// HERDR_AGENTS_DIR / TMPDIR, HERDR_WORKSPACE_ID=ws, the caller's Herdr state
// removed from the environment) and compares stdout, exit code and stderr
// with the program prefix normalized (`herdr-agents`, `herdr-agents.mjs` and
// bash's `…: line N:` all become `PROG:`). The fixture is reset between the
// two runs so both implementations start from the same seed; the resulting
// files are compared too.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findExecutable } from '../lib/platform.mjs';
import { golden, goldenMode, normalizeRoots } from './golden.mjs';

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BASH_ENTRY = path.join(SCRIPTS_DIR, 'herdr-agents');
export const JS_ENTRY = path.join(SCRIPTS_DIR, 'herdr-agents.mjs');
// The launchers the JS prints where the bash printed $0 (switch-to-JS
// decision 4); they normalize to PROG like the entries.
export const LAUNCHER_ENTRIES = [
  path.join(SCRIPTS_DIR, 'herdr-agents'),
  path.join(SCRIPTS_DIR, 'herdr-agents.cmd'),
];

export function nodeBin() {
  return findExecutable('node') || process.execPath;
}

// Child-process base env: drops the caller's Herdr/session state so the
// fixture is hermetic (mirrors run-tests.sh unsetting HERDR_AGENTS_*): every
// HERDR_* variable goes (pane, tab, workspace, env flag), so nothing of the
// session that runs the tests reaches an output or a golden record.
export function fixtureEnv(over = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('HERDR_')) delete env[k];
  }
  return { ...env, ...over };
}

export function makeFixture() {
  // realpath the root: on macOS /var is a symlink to /private/var and
  // `git rev-parse --show-toplevel` reports the resolved path, so fixture
  // paths must match it for file comparisons.
  let root = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-parity-'));
  root = fs.realpathSync(root);
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const conf = path.join(root, 'conf');
  const state = path.join(root, 'state');
  const tmp = path.join(root, 'tmp');
  for (const d of [repo, home, conf, state, tmp]) fs.mkdirSync(d, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
  const env = fixtureEnv({
    HOME: home,
    XDG_CONFIG_HOME: conf,
    HERDR_AGENTS_DIR: state,
    HERDR_WORKSPACE_ID: 'ws',
    TMPDIR: tmp,
  });
  return {
    root, repo, home, conf, state, tmp, env,
    // Reset the mutable state so the bash and node runs start from the same seed.
    reset() {
      fs.rmSync(path.join(repo, '.agents'), { recursive: true, force: true });
      fs.rmSync(path.join(repo, '.gitignore'), { force: true });
      fs.rmSync(path.join(repo, '.herdr-agents'), { recursive: true, force: true });
      fs.rmSync(state, { recursive: true, force: true });
      fs.mkdirSync(state, { recursive: true });
      fs.rmSync(path.join(conf, 'herdr-agents'), { recursive: true, force: true });
    },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

export function runImpl(impl, args, { env, cwd }) {
  const [bin, ...binArgs] = impl === 'bash' ? ['bash', BASH_ENTRY] : [nodeBin(), JS_ENTRY];
  // The timeout turns a hung child into a failed test instead of a hung run.
  const r = spawnSync(bin, [...binArgs, ...args], { cwd, env, encoding: 'utf8', timeout: 60000 });
  return { rc: r.status === null ? -1 : r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

// Normalize the program prefix on stderr: `herdr-agents:`, `herdr-agents.mjs:`
// and bash's `$0: line N:` all become `PROG:`.
export function normalizeErr(text) {
  return text.split('\n')
    .map((l) => l.replace(/^[\S]*herdr-agents(\.mjs)?(: line \d+)?:/, 'PROG:'))
    .join('\n');
}

function readRel(root, rel) {
  try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; }
}

// Run every step against bash, reset, run the same steps against node, then
// compare rc/stdout/stderr per step and the final content of `opts.files`
// (paths relative to the fixture root; `null` means "must not exist").
export function parityScenario(t, name, opts) {
  void t; // the scenario names the test for context; assertions use assert/strict
  // (node:test TestContext does not expose t.equal, Bun's does).
  const fix = makeFixture();
  let bashRes, bashFiles, nodeRes, nodeFiles;
  try {
    for (const impl of ['bash', 'node']) {
      fix.reset();
      if (opts.seed) opts.seed(fix);
      const results = [];
      for (const step of opts.steps) {
        const stepEnv = step.env ? { ...fix.env, ...step.env } : fix.env;
        results.push(runImpl(impl, step.args, { env: stepEnv, cwd: fix.repo }));
      }
      const files = (opts.files ?? []).map((rel) => ({ rel, content: readRel(fix.root, rel) }));
      if (impl === 'bash') { bashRes = results; bashFiles = files; } else { nodeRes = results; nodeFiles = files; }
    }
  } finally {
    fix.cleanup();
  }
  assert.equal(nodeRes.length, bashRes.length, `${name}: step count`);
  for (let i = 0; i < bashRes.length; i++) {
    const where = `${name}: step ${i + 1} (${opts.steps[i].args.join(' ')})`;
    assert.equal(nodeRes[i].rc, bashRes[i].rc, `${where}: exit code (bash=${bashRes[i].rc} node=${nodeRes[i].rc})`);
    assert.equal(nodeRes[i].out, bashRes[i].out, `${where}: stdout (node output first)`);
    assert.equal(normalizeErr(nodeRes[i].err), normalizeErr(bashRes[i].err), `${where}: stderr normalized`);
  }
  for (let i = 0; i < (opts.files ?? []).length; i++) {
    assert.equal(nodeFiles[i].content, bashFiles[i].content, `${name}: file ${opts.files[i]} after the run (node content first)`);
  }
}

// goldenScenario(suite, name, opts): parityScenario against a recorded
// reference (test/golden.mjs). The same fixture, seed, steps and files; only
// one implementation runs: the bash script to record, the JS to check or
// update. The fixture root becomes <ROOT> in every string of the value.
export function goldenScenario(suite, name, opts) {
  const run = (impl) => {
    const fix = makeFixture();
    try {
      fix.reset();
      if (opts.seed) opts.seed(fix);
      const steps = [];
      for (const step of opts.steps) {
        const stepEnv = step.env ? { ...fix.env, ...step.env } : fix.env;
        const r = runImpl(impl, step.args, { env: stepEnv, cwd: fix.repo });
        steps.push({ args: step.args, rc: r.rc, out: r.out, err: normalizeErr(r.err) });
      }
      const files = (opts.files ?? []).map((rel) => ({ rel, content: readRel(fix.root, rel) }));
      return normalizeRoots({ steps, files }, { '<ROOT>': fix.root });
    } finally {
      fix.cleanup();
    }
  };
  golden(suite, name, () => run('node'), () => run('bash'));
}

export { golden, goldenMode, normalizeRoots };
