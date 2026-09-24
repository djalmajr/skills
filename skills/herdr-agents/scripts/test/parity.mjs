// Harness (test-only). Runs the parity scenarios through
// `node scripts/herdr-agents.mjs` in an identical fixture (temporary git
// repo, temporary HOME / XDG_CONFIG_HOME / HERDR_AGENTS_DIR / TMPDIR,
// HERDR_WORKSPACE_ID=ws, the caller's Herdr state removed from the
// environment) and compares stdout, exit code and stderr with the program
// prefix normalized (`herdr-agents` and `herdr-agents.mjs`, including a
// `…: line N:` line-number suffix, all become `PROG:`). The resulting files
// are compared too.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findExecutable } from '../lib/platform.mjs';
import { golden, normalizeRoots } from './golden.mjs';

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const JS_ENTRY = path.join(SCRIPTS_DIR, 'herdr-agents.mjs');
// The launcher paths the entry prints in its messages (where $0 would go);
// they normalize to PROG like the entries.
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
// session that runs the tests reaches an output or the stored value.
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
    // Reset the mutable state so each run starts from the same seed.
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

// Run the JS entry with `args`. The timeout turns a hung child into a failed
// test instead of a hung run.
export function runImpl(args, { env, cwd }) {
  const r = spawnSync(nodeBin(), [JS_ENTRY, ...args], { cwd, env, encoding: 'utf8', timeout: 60000 });
  return { rc: r.status === null ? -1 : r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

// Normalize the program prefix on stderr: `herdr-agents:`, `herdr-agents.mjs:`
// and the `$0: line N:` line-number prefix all become `PROG:`.
export function normalizeErr(text) {
  return text.split('\n')
    .map((l) => l.replace(/^[\S]*herdr-agents(\.mjs)?(: line \d+)?:/, 'PROG:'))
    .join('\n');
}

function readRel(root, rel) {
  try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; }
}

// goldenScenario(suite, name, opts): run the steps through the JS entry in
// a fixture and compare the golden value (test/golden.mjs) — per step the
// exit code, stdout, prefix-normalized stderr, plus the final content of
// opts.files (paths relative to the fixture root; `null` means "must not
// exist"). The fixture root becomes <ROOT> in every string of the value.
export function goldenScenario(suite, name, opts) {
  const fix = makeFixture();
  try {
    fix.reset();
    if (opts.seed) opts.seed(fix);
    const steps = [];
    for (const step of opts.steps) {
      const stepEnv = step.env ? { ...fix.env, ...step.env } : fix.env;
      const r = runImpl(step.args, { env: stepEnv, cwd: fix.repo });
      steps.push({ args: step.args, rc: r.rc, out: r.out, err: normalizeErr(r.err) });
    }
    const files = (opts.files ?? []).map((rel) => ({ rel, content: readRel(fix.root, rel) }));
    const value = normalizeRoots({ steps, files }, { '<ROOT>': fix.root });
    golden(suite, name, () => value);
  } finally {
    fix.cleanup();
  }
}
