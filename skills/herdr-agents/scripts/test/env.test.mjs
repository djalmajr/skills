// Unit tests for the `env` command (scripts/lib/commands/env.mjs): the
// environment block for a feedback issue, port of the bash `cmd_env`
// (:732-745) with the decided `bash: … · jq: …` → `runtime:` line. Fakes
// `git`, `herdr` and two kind CLIs (test/fakes.mjs) on a fully controlled
// PATH — never the operator's real CLIs; temporary roots are used as HOME,
// XDG_CONFIG_HOME and TMPDIR. The entry is run as a child process so the
// PATH, the runtime line and the exit code are the ones a user would see.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFakeCli } from './fakes.mjs';

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS_ENTRY = path.join(SCRIPTS_DIR, 'herdr-agents.mjs');
const SKILL_DIR = path.resolve(SCRIPTS_DIR, '..');

// The fakes append their argv to $HA_LOG (one line per call) and answer
// `--version` from env vars, which keeps every scenario on the same source.
const GIT_FAKE = `
import fs from 'node:fs';
const a = process.argv.slice(2);
if (process.env.HA_LOG) fs.appendFileSync(process.env.HA_LOG, a.join(' ') + '\\n');
if (a[0] === 'rev-parse' && a[1] === '--show-toplevel') {
  if (process.env.HA_TTOP) { process.stdout.write(process.env.HA_TTOP + '\\n'); process.exit(0); }
  process.exit(1);
}
if (a.includes('log')) {
  if (process.env.HA_GIT_LOG) { process.stdout.write(process.env.HA_GIT_LOG + '\\n'); process.exit(0); }
  process.exit(128);
}
process.exit(128);
`;
const HERDR_FAKE = `
import fs from 'node:fs';
const a = process.argv.slice(2);
if (process.env.HA_LOG) fs.appendFileSync(process.env.HA_LOG, a.join(' ') + '\\n');
if (a[0] === '--version') {
  if (process.env.HA_HERDR_VERSION) { process.stdout.write(process.env.HA_HERDR_VERSION + '\\n'); process.exit(0); }
  process.exit(1);
}
process.exit(0);
`;
const KIND_FAKE = `
import fs from 'node:fs';
const a = process.argv.slice(2);
if (process.env.HA_LOG) fs.appendFileSync(process.env.HA_LOG, a.join(' ') + '\\n');
if (a[0] === '--version') {
  if (process.env.HA_KIND_VERSION) process.stdout.write(process.env.HA_KIND_VERSION + '\\n');
  process.exit(Number(process.env.HA_KIND_RC ?? 0));
}
process.exit(0);
`;

function makeRoot(name) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ha-env-${name}-`)));
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const conf = path.join(root, 'conf');
  const tmp = path.join(root, 'tmp');
  const bin = path.join(root, 'bin');
  for (const d of [repo, home, conf, tmp, bin]) fs.mkdirSync(d, { recursive: true });
  return { root, repo, home, conf, tmp, bin };
}

// Run `env` with a fully controlled PATH: only the fake bin dir (no real
// CLIs of the operator). `fakes` maps fake name → fake source; `over` adds
// env vars for the child (fake behavior and config overrides).
function runEnv(fix, fakes, over = {}) {
  for (const [name, source] of Object.entries(fakes)) writeFakeCli(fix.bin, name, source);
  const env = {
    HOME: fix.home,
    XDG_CONFIG_HOME: fix.conf,
    TMPDIR: fix.tmp,
    PATH: fix.bin,
    HA_LOG: path.join(fix.root, 'calls.log'),
    HA_TTOP: fix.repo,
    HA_GIT_LOG: 'abc1234 2026-09-24',
    HA_HERDR_VERSION: 'herdr 9.9.9',
    ...over,
  };
  const r = spawnSync(process.execPath, [JS_ENTRY, 'env'], { cwd: fix.repo, env, encoding: 'utf8', timeout: 30000 });
  return { rc: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

const lines = (out) => out.replace(/\n+$/, '').split('\n');
const runtimeLine = () => (process.versions.bun ? `runtime: bun ${process.versions.bun}` : `runtime: node ${process.versions.node}`);
const CONFIG_DEFAULTS = 'config: layout=split reuse_workers=on approvals=ask auto_approve=off family_check=strict brief_lint=warn';

test('env: lines in the bash order (version, herdr, os, runtime, kinds, config)', { timeout: 60000 }, (t) => {
  const fix = makeRoot('full');
  t.after(() => fix && fs.rmSync(fix.root, { recursive: true, force: true }));
  const r = runEnv(fix, {
    git: GIT_FAKE,
    herdr: HERDR_FAKE,
    grok: KIND_FAKE,
    agy: KIND_FAKE,
  }, { HA_KIND_VERSION: 'grok 8.8.8 (xai)\nbuild 42' });
  assert.equal(r.rc, 0, `rc ${r.rc}: ${r.err}`);
  assert.equal(r.err, '');
  assert.deepEqual(lines(r.out), [
    'herdr-agents: abc1234 2026-09-24',
    'herdr: herdr 9.9.9',
    `os: ${os.type()} ${os.release()} (${os.machine()})`,
    runtimeLine(),
    'kind grok: grok 8.8.8 (xai)', // first line of a multi-line --version, KNOWN_KINDS order
    'kind agy: grok 8.8.8 (xai)',
    CONFIG_DEFAULTS,
  ]);
  // The version lookups: `git -C <skill root> log -1` and `herdr --version`.
  const log = fs.readFileSync(path.join(fix.root, 'calls.log'), 'utf8');
  assert.ok(log.split('\n').includes(`-C ${SKILL_DIR} log -1 --format=%h %cs`), `git argv not found in:\n${log}`);
  assert.ok(log.split('\n').includes('--version'), 'herdr --version not found in the call log');
});

test('env: a kind whose --version fails prints ? (even when it printed first)', { timeout: 60000 }, (t) => {
  const fix = makeRoot('fail');
  t.after(() => fix && fs.rmSync(fix.root, { recursive: true, force: true }));
  // grok: --version succeeds printing nothing -> empty value (bash: head -n1
  // of empty output); agy: --version prints a line then exits 1 -> a single
  // ? (the bash `first line\n?` quirk of pipefail + `||` is not ported).
  const grokEmpty = `process.exit(0);\n`;
  const agyFailPrint = `
if (process.argv[2] === '--version') { process.stdout.write('partial\\n'); process.exit(1); }
process.exit(0);
`;
  const r = runEnv(fix, { git: GIT_FAKE, herdr: HERDR_FAKE, grok: grokEmpty, agy: agyFailPrint });
  assert.equal(r.rc, 0, `rc ${r.rc}: ${r.err}`);
  const l = lines(r.out);
  assert.ok(l.includes('kind grok: '), `grok empty-success line missing in:\n${r.out}`);
  assert.ok(l.includes('kind agy: ?'), `agy failure line missing in:\n${r.out}`);
});

test('env: herdr missing prints unknown', { timeout: 60000 }, (t) => {
  const fix = makeRoot('noherdr');
  t.after(() => fix && fs.rmSync(fix.root, { recursive: true, force: true }));
  const r = runEnv(fix, { git: GIT_FAKE });
  assert.equal(r.rc, 0, `rc ${r.rc}: ${r.err}`);
  assert.ok(lines(r.out).includes('herdr: unknown'), r.out);
});

test('env: git missing prints unversioned', { timeout: 60000 }, (t) => {
  const fix = makeRoot('nogit');
  t.after(() => fix && fs.rmSync(fix.root, { recursive: true, force: true }));
  const r = runEnv(fix, { herdr: HERDR_FAKE });
  assert.equal(r.rc, 0, `rc ${r.rc}: ${r.err}`);
  assert.ok(lines(r.out)[0] === 'herdr-agents: unversioned', r.out);
});

test('env: the runtime line names the executing runtime', { timeout: 60000 }, (t) => {
  const fix = makeRoot('runtime');
  t.after(() => fix && fs.rmSync(fix.root, { recursive: true, force: true }));
  const r = runEnv(fix, { git: GIT_FAKE, herdr: HERDR_FAKE });
  assert.equal(r.rc, 0, `rc ${r.rc}: ${r.err}`);
  assert.ok(lines(r.out).includes(runtimeLine()), r.out);
});

test('env: the config line reflects the effective config (env overrides)', { timeout: 60000 }, (t) => {
  const fix = makeRoot('config');
  t.after(() => fix && fs.rmSync(fix.root, { recursive: true, force: true }));
  const r = runEnv(fix, { git: GIT_FAKE, herdr: HERDR_FAKE }, {
    HERDR_AGENTS_LAYOUT: 'tab',
    HERDR_AGENTS_APPROVALS: 'full',
  });
  assert.equal(r.rc, 0, `rc ${r.rc}: ${r.err}`);
  assert.ok(lines(r.out).includes(
    'config: layout=tab reuse_workers=on approvals=full auto_approve=off family_check=strict brief_lint=warn'),
    r.out);
});
