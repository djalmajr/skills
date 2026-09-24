// State (slice 3): the roster lock and concurrent writers, stale-lock
// recovery, the 200-try exhaustion (rc 4 with the decision-2 message),
// lock release on throw, atomic rewrite metadata (mode kept, no temp
// file), the roster operations, sanitizeCause, quota detection and the
// lane fallback. The lock exhaustion test spins ~10 s (200 x 50 ms), so
// the file carries generous timeouts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { nodeBin } from './parity.mjs';
import { atomicWrite } from '../lib/platform.mjs';
import {
  stateDir, rosterRows, rosterLine, withRosterLock, rosterAppend,
  rosterRemove, rosterSetRole, rosterReplacePane, lastReport, lastReportPath,
  sanitizeCause, quotaDetect, redactSecrets, laneOfRole, warn, setFrictionLog,
  nowStamp, nowIso,
} from '../lib/state.mjs';

const STATE_MJS = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'lib', 'state.mjs');
const STATE_URL = pathToFileURL(STATE_MJS).href;

function tmp(prefix) {
  let root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return fs.realpathSync(root);
}

function makeState(root) {
  const sd = path.join(root, 'state', 'ws');
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, 'agents.tsv'), '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\tmodel\tapprovals\troles\tlane\n');
  return sd;
}

const ROW = (name, pane = 'p1', extra = []) =>
  [name, pane, 'grok', 'implementer', 'xai', '1', '/tmp/work', '20260101T000000', ...extra].slice(0, 12);

test('stateDir: creates briefs/reports/wait and the 12-column header, idempotent', () => {
  const root = tmp('ha-state-dir-');
  try {
    const env = { ...process.env, HERDR_AGENTS_DIR: path.join(root, 'st'), HERDR_WORKSPACE_ID: 'ws' };
    const ctx = { entries: new Map(), sources: [] };
    const sd = stateDir(ctx, env, root);
    assert.equal(sd, path.join(root, 'st', 'ws'));
    for (const d of ['briefs', 'reports', 'wait']) assert.ok(fs.statSync(path.join(sd, d)).isDirectory());
    assert.equal(fs.readFileSync(path.join(sd, 'agents.tsv'), 'utf8'),
      '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\tmodel\tapprovals\troles\tlane\n');
    // Existing roster is kept (the bash `[ -f ]` guard).
    const tsv = path.join(sd, 'agents.tsv');
    fs.writeFileSync(tsv, '# header\nkeep\tme\n');
    stateDir(ctx, env, root);
    assert.equal(fs.readFileSync(tsv, 'utf8'), '# header\nkeep\tme\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('roster: two children appending 50 lines concurrently lose nothing', { timeout: 60000 }, async () => {
  const root = tmp('ha-state-race-');
  let sd;
  try {
    sd = makeState(root);
    const code = [
      `import { rosterAppend, nowStamp } from '${STATE_URL}';`,
      'const sd = process.env.SD;',
      'const who = process.env.WHO;',
      'for (let i = 1; i <= 50; i++) {',
      "  rosterAppend(sd, [`${who}-` + i, `p-${who}-` + i, 'grok', 'implementer', 'xai', '0', '/tmp/w', nowStamp(), '', 'ask', 'implementer', '']);",
      '}',
    ].join('\n');
    const run = (who) => new Promise((resolve) => {
      const child = spawn(nodeBin(), ['--input-type=module', '-e', code], {
        env: { ...process.env, SD: sd, WHO: who },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let err = '';
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', (e) => resolve({ ok: false, err: String(e) }));
      child.on('close', (rc) => resolve({ ok: rc === 0, rc, err }));
    });
    const [r1, r2] = await Promise.all([run('w1'), run('w2')]);
    assert.ok(r1.ok, `child w1: ${r1.err}`);
    assert.ok(r2.ok, `child w2: ${r2.err}`);
    const lines = fs.readFileSync(path.join(sd, 'agents.tsv'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
    assert.equal(lines.length, 100, '100 rows, none lost');
    const names = new Set();
    for (const l of lines) {
      const f = l.split('\t');
      assert.equal(f.length, 12, `row has 12 columns: ${l}`);
      names.add(f[0]);
    }
    assert.equal(names.size, 100, 'no duplicated or interleaved rows');
    for (let i = 1; i <= 50; i++) {
      assert.ok(names.has(`w1-${i}`), `missing w1-${i}`);
      assert.ok(names.has(`w2-${i}`), `missing w2-${i}`);
    }
    assert.ok(!fs.existsSync(path.join(sd, 'agents.lock')), 'lock released');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('roster lock: a stale lock (mtime 2 minutes old) is dropped and taken', () => {
  const root = tmp('ha-state-stale-');
  let sd;
  try {
    sd = makeState(root);
    const lock = path.join(sd, 'agents.lock');
    fs.mkdirSync(lock);
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lock, old, old);
    const out = withRosterLock(sd, () => 'ran');
    assert.equal(out, 'ran');
    assert.ok(!fs.existsSync(lock), 'lock released after fn');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('roster lock: a fresh lock held beyond 200 tries exits 4 with the message', { timeout: 90000 }, () => {
  const root = tmp('ha-state-held-');
  let sd;
  try {
    sd = makeState(root);
    const lock = path.join(sd, 'agents.lock');
    fs.mkdirSync(lock); // fresh mtime: never stale
    const code = `import { withRosterLock } from '${STATE_URL}'; withRosterLock(process.env.SD, () => 'ok'); console.log('acquired');`;
    const r = spawnSync(nodeBin(), ['--input-type=module', '-e', code], {
      env: { ...process.env, SD: sd },
      encoding: 'utf8',
      timeout: 80_000,
    });
    assert.equal(r.status, 4, `rc=${r.status} stderr=${r.stderr}`);
    assert.equal(r.stderr, `herdr-agents: roster lock ${lock} held for too long; remove it if no herdr-agents command is running\n`);
    assert.ok(!r.stdout.includes('acquired'));
    assert.ok(fs.existsSync(lock), 'the foreign lock is untouched');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('roster lock: a stale lock that cannot be removed counts as a try and exits 4', { timeout: 90000 }, () => {
  const root = tmp('ha-state-stuck-');
  let sd;
  try {
    sd = makeState(root);
    const lock = path.join(sd, 'agents.lock');
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'keep'), ''); // rmdir fails: not empty
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lock, old, old);
    const code = `import { withRosterLock } from '${STATE_URL}'; withRosterLock(process.env.SD, () => 'ok'); console.log('acquired');`;
    const r = spawnSync(nodeBin(), ['--input-type=module', '-e', code], {
      env: { ...process.env, SD: sd },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(r.status, 4, `rc=${r.status} signal=${r.signal} stderr=${r.stderr}`);
    assert.ok(!r.stdout.includes('acquired'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('roster lock: a throwing fn still releases the lock', () => {
  const root = tmp('ha-state-throw-');
  let sd;
  try {
    sd = makeState(root);
    assert.throws(() => withRosterLock(sd, () => { throw new Error('boom'); }), /boom/);
    assert.ok(!fs.existsSync(path.join(sd, 'agents.lock')), 'unlock ran in finally');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('roster rewrites: keep the 0640 mode of the existing file and leave no temp', () => {
  const root = tmp('ha-state-mode-');
  let sd;
  try {
    sd = makeState(root);
    const f = path.join(sd, 'agents.tsv');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8') + ROW('worker').join('\t') + '\n');
    fs.chmodSync(f, 0o640);
    rosterSetRole(sd, 'worker', 'reviewer');
    assert.equal(fs.statSync(f).mode & 0o777, 0o640, 'mode kept by set_role rewrite');
    rosterRemove(sd, 'worker');
    assert.equal(fs.statSync(f).mode & 0o777, 0o640, 'mode kept by remove rewrite');
    assert.deepEqual(fs.readdirSync(sd).filter((n) => n.includes('.tmp')), [], 'no temp file left');
    assert.ok(!fs.existsSync(path.join(sd, 'agents.lock')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('atomicWrite (platform): 0600 for a new file, existing mode kept, no temp', () => {
  const root = tmp('ha-atomic-');
  try {
    const fresh = path.join(root, 'fresh');
    atomicWrite(fresh, 'x\n');
    assert.equal(fs.statSync(fresh).mode & 0o777, 0o600);
    const kept = path.join(root, 'kept');
    fs.writeFileSync(kept, 'old\n', { mode: 0o644 });
    fs.chmodSync(kept, 0o644);
    atomicWrite(kept, 'new\n');
    assert.equal(fs.readFileSync(kept, 'utf8'), 'new\n');
    assert.equal(fs.statSync(kept).mode & 0o777, 0o644);
    assert.deepEqual(fs.readdirSync(root).filter((n) => n.includes('.tmp')), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('rosterSetRole: column 4 changes, history grows, 8-column rows grow to 11', () => {
  const root = tmp('ha-setrole-');
  let sd;
  try {
    sd = makeState(root);
    const f = path.join(sd, 'agents.tsv');
    // Legacy 8-column row: hist starts from the previous role.
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8') + ['worker', 'p1', 'grok', 'implementer', 'xai', '1', '/tmp', 'now'].join('\t') + '\n');
    rosterSetRole(sd, 'worker', 'reviewer');
    let lines = rosterRows(sd);
    assert.equal(lines.length, 1);
    let col = lines[0].split('\t');
    assert.equal(col.length, 11, '8-column row grew to 11');
    assert.equal(col[3], 'reviewer');
    assert.equal(col[10], 'implementer,reviewer');
    // Same role again: no duplicate history token.
    rosterSetRole(sd, 'worker', 'reviewer');
    col = rosterRows(sd)[0].split('\t');
    assert.equal(col[10], 'implementer,reviewer');
    // 12-column row: lane (column 12) survives the rewrite.
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8') + ['a2', 'p2', 'grok', 'designer', 'xai', '1', '/tmp', 'now', 'm', 'full', 'designer', 'build'].join('\t') + '\n');
    rosterSetRole(sd, 'a2', 'scouter');
    const rest = rosterRows(sd).filter((l) => l.split('\t')[0] === 'a2');
    col = rest[0].split('\t');
    assert.equal(col[3], 'scouter');
    assert.equal(col[10], 'designer,scouter');
    assert.equal(col[11], 'build', 'lane column kept');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('roster: remove keeps the header, last line wins, replace_pane swaps column 2', () => {
  const root = tmp('ha-roster-ops-');
  let sd;
  try {
    sd = makeState(root);
    const f = path.join(sd, 'agents.tsv');
    const h = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, h + ROW('dup', 'pa').join('\t') + '\n' + ROW('dup', 'pb').join('\t') + '\n' + ROW('solo', 'pc').join('\t') + '\n');
    assert.equal(rosterLine(sd, 'dup').split('\t')[1], 'pb', 'rosterLine: last matching row');
    rosterRemove(sd, 'dup');
    const after = rosterRows(sd);
    assert.equal(after.length, 1, 'both dup rows removed');
    assert.equal(after[0].split('\t')[0], 'solo');
    assert.ok(fs.readFileSync(f, 'utf8').startsWith('# name\t'), 'header kept');
    rosterReplacePane(sd, 'pc', 'pd');
    assert.equal(rosterLine(sd, 'solo').split('\t')[1], 'pd');
    rosterReplacePane(sd, 'pd', 'pd'); // no-op
    rosterReplacePane(sd, 'pd', ''); // no-op
    assert.equal(rosterLine(sd, 'solo').split('\t')[1], 'pd');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('roster rows: CRLF files are normalized on read (decision 3)', () => {
  const root = tmp('ha-crlf-');
  let sd;
  try {
    sd = makeState(root);
    const f = path.join(sd, 'agents.tsv');
    fs.writeFileSync(f, '# name\tpane\r\nworker\tp1\r\n');
    assert.deepEqual(rosterRows(sd), ['worker\tp1']);
    assert.equal(rosterLine(sd, 'worker'), 'worker\tp1');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('lastReport: trailing newlines stripped, empty when the file is absent', () => {
  const root = tmp('ha-lastreport-');
  let sd;
  try {
    sd = makeState(root);
    assert.equal(lastReport(sd, 'worker'), '');
    const p = lastReportPath(sd, 'worker');
    fs.writeFileSync(p, '/tmp/report.md\n\n');
    assert.equal(lastReport(sd, 'worker'), '/tmp/report.md');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('sanitizeCause: one line, printable only, spaces collapsed, at most 200 chars', () => {
  assert.equal(sanitizeCause('a\nb\tc'), 'a b c');
  assert.equal(sanitizeCause('x\u001b[31my\r\n z'), 'x[31my z');
  assert.equal(sanitizeCause('a  b   c '), 'a b c');
  assert.equal(sanitizeCause('a'.repeat(300)).length, 200);
  assert.equal(sanitizeCause(''), '');
});

test('quotaDetect: the test-quota.sh hit/miss matrix', () => {
  const hit = (state, text, label) => {
    const out = quotaDetect(state, text);
    assert.ok(out, `${label}: expected a match`);
    assert.ok(out[0], `${label}: non-empty match line`);
  };
  const miss = (state, text, label) => {
    assert.equal(quotaDetect(state, text), null, `${label}: expected no match`);
  };
  hit('idle', 'You have hit your usage limit for grok', 'usage limit');
  hit('idle', 'Individual quota reached', 'individual');
  hit('idle', 'Error: quota exceeded', 'quota exceeded');
  hit('idle', 'RESOURCE_EXHAUSTED: project', 'resource');
  hit('idle', '429 Too Many Requests', '429');
  hit('idle', 'rate limit exceeded, retry later', 'rate limit exceeded');
  hit("idle", "You've hit your limit for today", 'you have hit');
  hit('idle', 'You exceeded your current quota, please check your plan and billing details.', 'openai quota');
  hit('idle', 'You have reached your API usage limits: monthly threshold', 'anthropic reached');
  hit("idle", "You've reached your API usage limits", 'anthropic contraction');
  hit('done', 'INDIVIDUAL QUOTA REACHED', 'case-insensitive');
  miss('idle', 'implement a rate limit for the API client', 'prose rate limit');
  miss('idle', 'return "rate limit"', 'code rate limit');
  miss('idle', 'return "rate limit exceeded"', 'return phrase');
  miss('idle', '// 429 Too Many Requests', 'slash comment');
  miss('idle', '# quota exceeded', 'hash comment');
  miss('idle', '/* RESOURCE_EXHAUSTED */', 'block comment');
  miss('idle', 'func Limit() { quota exceeded }', 'func keyword');
  miss('idle', 'function check() { quota exceeded }', 'function keyword');
  miss('idle', 'msg = "quota exceeded"', 'assignment');
  miss('idle', '"rate limit exceeded"', 'quoted phrase');
  miss("idle", "You've hit your stride", 'stride');
  miss('working', '429 Too Many Requests', 'working 429');
  miss('working', 'hit your usage limit', 'working usage');
  miss('idle', '', 'empty screen');
});

test('quotaDetect: renewal line kept, secrets redacted', () => {
  const out = quotaDetect('idle', 'Individual quota reached token=sk_live_abcdefghij\nResets at 5:00pm');
  assert.ok(out, 'matched');
  assert.match(out[0], /Individual quota reached/);
  assert.match(out[1], /Resets at 5:00pm/);
  assert.ok(!out[0].includes('sk_live_'), 'no secret leak');
  assert.match(out[0], /\[redacted\]/);
  assert.equal(redactSecrets('Bearer abc123.~+/'), 'Bearer [redacted]');
  assert.equal(redactSecrets('pk-proj-abcdefgh12'), '[redacted]');
});

test('laneOfRole: presets (panes 3 and 4) and custom lanes', () => {
  const empty = { entries: new Map(), sources: [] };
  const env = {};
  assert.equal(laneOfRole(empty, 'implementer', env), 'build');
  assert.equal(laneOfRole(empty, 'tasker', env), 'build');
  assert.equal(laneOfRole(empty, 'scouter', env), 'explore');
  assert.equal(laneOfRole(empty, 'reviewer', env), 'review');
  assert.equal(laneOfRole(empty, 'inspector', env), 'review');
  assert.equal(laneOfRole(empty, 'nosuchrole', env), '');
  const p3 = { entries: new Map([['panes', { value: '3', source: 'project' }]]), sources: ['project'] };
  assert.equal(laneOfRole(p3, 'implementer', env), 'build');
  assert.equal(laneOfRole(p3, 'scouter', env), 'read');
  assert.equal(laneOfRole(p3, 'reviewer', env), 'read');
  const custom = { entries: new Map([['lane_foo_roles', { value: 'implementer,scouter', source: 'project' }]]), sources: ['project'] };
  assert.equal(laneOfRole(custom, 'implementer', env), 'foo');
  assert.equal(laneOfRole(custom, 'reviewer', env), '', 'custom lanes replace the presets entirely');
  const envCustom = { ...custom, HERDR_AGENTS_LANE_BAR_ROLES: 'tasker' };
  assert.equal(laneOfRole(custom, 'tasker', envCustom), 'bar');
});

test('friction: warn() appends a TSV line with the command name', () => {
  const root = tmp('ha-friction-');
  try {
    const log = path.join(root, 'friction.log');
    setFrictionLog(log, 'status');
    warn('agent \'a\': herdr agent get failed: x');
    const line = fs.readFileSync(log, 'utf8').trim();
    const f = line.split('\t');
    assert.equal(f.length, 4);
    assert.match(f[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    assert.equal(f[1], 'warning');
    assert.equal(f[2], 'status');
    assert.equal(f[3], "agent 'a': herdr agent get failed: x");
    // No log configured: warn only writes stderr, never throws.
    setFrictionLog('', '');
    assert.doesNotThrow(() => warn('quiet'));
  } finally {
    setFrictionLog('', '');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('nowStamp/nowIso: the exact bash date formats', () => {
  const d = new Date(2026, 8, 23, 5, 4, 3); // local 2026-09-23 05:04:03
  assert.equal(nowStamp(d), '20260923T050403');
  assert.equal(nowIso(d), '2026-09-23T05:04:03');
});
