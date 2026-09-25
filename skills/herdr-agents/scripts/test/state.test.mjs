// State (slice 3): the roster lock and concurrent writers, stale-lock
// recovery, the 200-try exhaustion (rc 4 with the decision-2 message),
// lock release on throw, atomic rewrite metadata (mode kept, no temp
// file), the roster operations, sanitizeCause (now lib/text.mjs) and the
// friction log. The lock exhaustion test spins ~10 s (200 x 50 ms), so
// the file carries generous timeouts. The quota and lane tests moved to
// quota.test.mjs / lanes.test.mjs in slice 4.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { nodeBin } from './parity.mjs';
import { atomicWrite } from '../lib/platform.mjs';
import { sanitizeCause } from '../lib/text.mjs';
import {
  stateDir, rosterRows, rosterLine, withRosterLock, rosterAppend,
  rosterRemove, rosterSetRole, rosterReplacePane, lastReport, lastReportPath,
  warn, setFrictionLog, nowStamp, nowIso, frictionSafe,
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

// A message (or command) with a newline, carriage return or tab must not
// open lines missing the four TSV columns: \r, \n and \t are sanitized to
// a single space before writing, so every line keeps date, level,
// command and message.
test('friction: warn() sanitizes \\r, \\n and \\t out of the message (four TSV columns)', () => {
  const root = tmp('ha-friction-san-');
  try {
    const log = path.join(root, 'friction.log');
    setFrictionLog(log, 'wait');
    // Mutation captured: a message whose newline (or carriage return) is
    // NOT sanitized before writing opens a second line without the date,
    // level and command columns — the line count and the four-column
    // asserts below break.
    warn('agent \'a\': screen says\nthe dialog is stuck');
    warn('tab\there and cr\rthere');
    setFrictionLog('', '');
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2, 'each warn is exactly one physical line');
    for (const l of lines) {
      const f = l.split('\t');
      assert.equal(f.length, 4, `four TSV columns: ${l}`);
      assert.match(f[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, 'the date column survives');
      assert.equal(f[1], 'warning');
      assert.equal(f[2], 'wait');
    }
    assert.equal(lines[0].split('\t')[3], 'agent \'a\': screen says the dialog is stuck');
    assert.equal(lines[1].split('\t')[3], 'tab here and cr there');
    assert.equal(frictionSafe('a\tb\r\nc'), 'a b c', 'frictionSafe replaces each of the three with a space');
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

// ---------- workspaceId (decision 6: DieError instead of process.exit) ----------

import { workspaceId } from '../lib/state.mjs';
import { DieError } from '../lib/config.mjs';
import { writeFakeCli } from './fakes.mjs';

const CONFIG_TEST_URL = pathToFileURL(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'lib', 'config.mjs')).href;

function wsFakeEnv(root, source) {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  writeFakeCli(bin, 'herdr', source);
  return { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, HERDR_WORKSPACE_ID: '' };
}

test('workspaceId: env var wins; herdr query; null id; herdr failure throws DieError', { timeout: 60000 }, () => {
  const root = tmp('ha-state-wsid-');
  const ctx = { entries: new Map(), sources: [] };
  try {
    // $HERDR_WORKSPACE_ID wins, no herdr call.
    assert.equal(workspaceId(ctx, { HERDR_WORKSPACE_ID: 'ws-1' }, root), 'ws-1');
    // herdr pane current --current → .result.pane.workspace_id.
    assert.equal(
      workspaceId(ctx, wsFakeEnv(root, `if (process.argv[2] === 'pane') process.stdout.write('{"result":{"pane":{"workspace_id":"ws-9"}}}\\n');`), root),
      'ws-9',
    );
    // a null workspace id prints as `null`, exactly like jq -r.
    assert.equal(
      workspaceId(ctx, wsFakeEnv(root, `if (process.argv[2] === 'pane') process.stdout.write('{"result":{"pane":{"workspace_id":null}}}\\n');`), root),
      'null',
    );
    // herdr absent on PATH → DieError 2 with the die message.
    let e = null;
    try { workspaceId(ctx, { PATH: '/nonexistent', HERDR_WORKSPACE_ID: '' }, root); } catch (x) { e = x; }
    assert.ok(e instanceof DieError && e.code === 2, String(e));
    assert.equal(e.message, 'herdr CLI not found in PATH');
    // a failing herdr passes its output through and throws DieError('', rc);
    // an unparseable answer throws DieError('', 2).
    const code = `import { workspaceId } from '${STATE_URL}';
import { DieError } from '${CONFIG_TEST_URL}';
const ctx = { entries: new Map(), sources: [] };
try { const w = workspaceId(ctx, process.env, process.cwd()); console.log('wid=' + w); }
catch (x) { if (x instanceof DieError) { process.stderr.write('die ' + x.code + '|' + x.message); process.exit(x.code); } throw x; }`;
    let r = spawnSync(nodeBin(), ['--input-type=module', '-e', code], {
      env: wsFakeEnv(root, `if (process.argv[2] === 'pane') { process.stdout.write('so far\\n'); process.stderr.write('ws boom\\n'); process.exit(5); }`),
      encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(r.status, 5, r.stderr);
    assert.equal(r.stdout, 'so far\n');
    assert.ok(r.stderr.startsWith('ws boom') && r.stderr.endsWith('die 5|'), r.stderr);
    assert.ok(!r.stderr.includes('herdr-agents:'), 'passthrough exits with the code only');
    r = spawnSync(nodeBin(), ['--input-type=module', '-e', code], {
      env: wsFakeEnv(root, `if (process.argv[2] === 'pane') process.stdout.write('not json');`),
      encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(r.status, 2, r.stderr);
    assert.ok(r.stderr.endsWith('die 2|'), r.stderr);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
