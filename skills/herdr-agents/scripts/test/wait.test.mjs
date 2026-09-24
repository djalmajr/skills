// wait (slice 6a): the units the acceptance criterion lists — waitRank and
// the 4 > 11 > 7 > 6 order in any argument order; a report only `done` on
// the second probe with the same size; two blocked probes before blocked;
// settled with a still screen; gone; unavailable with a cause; quota with
// its fields and the friction entry; timeout 9; --any; tryAutoApprove
// (key per kind, the cap, the counter, the log); briefTask (H1, the Brief
// prefixes, contract sections, no H1, CRLF); markTaskDone once. waitFor is
// exercised through the real entry (child process) so its stdout and exit
// code are observable; probeAgent / tryAutoApprove / briefTask /
// markTaskDone are exercised in-process. A fake `herdr` (writeFakeCli) is
// the only herdr the code sees.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeFakeCli } from './fakes.mjs';
import { nodeBin } from './parity.mjs';
import { loadConfig } from '../lib/config.mjs';
import {
  waitRank, tryAutoApprove, probeAgent, waitFor, kindApproveKeys, cksumField, pollIntervalMs,
} from '../lib/wait.mjs';
import { briefTask, markTaskDone } from '../lib/tasks.mjs';

const SCRIPTS = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const JS_ENTRY = path.join(SCRIPTS, 'herdr-agents.mjs');

// ---------- fake herdr (Node) ----------

// `agent get` per target (mode-<t> file) else the global mode file
// (denied → an unqueryable error, missing → agent_not_found, else the mode
// as agent_status); `agent read` prints screen-<t> (or the global screen
// file); `agent list` from FAKE_LIVE; `agent send-keys` fails when
// FAKE_SENDKEYS_FAIL. Every call is logged as one "$*" line (FAKE_LOG).
const HERDR_FAKE = `
import fs from 'node:fs';
const argv = process.argv.slice(2);
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, argv.join(' ') + '\\n');
const t = argv[2] ?? '';
const cmd = (argv[0] ?? '') + ' ' + (argv[1] ?? '');
const modeOf = (t) => {
  let per = '';
  if (process.env.FAKE_MODE_DIR) {
    try { per = fs.readFileSync(process.env.FAKE_MODE_DIR + '/mode-' + t, 'utf8').trim(); } catch {}
  }
  if (per) return per;
  try { return fs.readFileSync(process.env.FAKE_MODE, 'utf8').trim(); } catch { return 'working'; }
};
const screenOf = (t) => {
  try { return fs.readFileSync(process.env.FAKE_SCREEN_DIR + '/screen-' + t, 'utf8'); }
  catch { try { return fs.readFileSync(process.env.FAKE_SCREEN, 'utf8'); } catch { return ''; } }
};
if (cmd === 'agent get') {
  const m = modeOf(t);
  if (m === 'denied') {
    process.stderr.write('Error: Os { code: 13, kind: PermissionDenied, message: "Permission denied" }\\n');
    process.exit(1);
  }
  if (m === 'missing') {
    process.stderr.write('{"error":{"code":"agent_not_found","message":"agent target ' + t + ' not found"}}\\n');
    process.exit(1);
  }
  process.stdout.write('{"result":{"agent":{"name":"' + t + '","agent_status":"' + m + '"}}}\\n');
} else if (cmd === 'agent read') {
  process.stdout.write(screenOf(t));
} else if (cmd === 'agent list') {
  let agents = [];
  try { agents = (JSON.parse(fs.readFileSync(process.env.FAKE_LIVE, 'utf8')).agents) ?? []; } catch {}
  process.stdout.write(JSON.stringify({ result: { agents } }) + '\\n');
} else if (cmd === 'agent send-keys') {
  if (process.env.FAKE_SENDKEYS_FAIL) { process.stderr.write('send-keys failed\\n'); process.exit(1); }
  process.stdout.write('{"result":{}}\\n');
} else if (cmd === 'notification show') {
  process.stdout.write('{"result":{}}\\n');
} else {
  process.stderr.write('unexpected: ' + argv.join(' ') + '\\n');
  process.exit(1);
}
`;

// ---------- fixture plumbing ----------

function makeFix(prefix) {
  let root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  root = fs.realpathSync(root);
  const bin = path.join(root, 'bin');
  const repo = path.join(root, 'repo');
  const state = path.join(root, 'state');
  const ws = path.join(state, 'ws');
  const modeDir = path.join(root, 'modes');
  const screenDir = path.join(root, 'screens');
  for (const d of [bin, repo, ws, path.join(ws, 'briefs'), path.join(ws, 'reports'), path.join(ws, 'wait'),
    modeDir, screenDir, path.join(root, 'home'), path.join(root, 'conf'), path.join(root, 'tmp')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  writeFakeCli(bin, 'herdr', HERDR_FAKE);
  const env = {
    HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'conf'),
    TMPDIR: path.join(root, 'tmp'),
    HERDR_AGENTS_DIR: state,
    HERDR_WORKSPACE_ID: 'ws',
    HERDR_ENV: '1',
    HERDR_AGENTS_REGRID: 'off',
    HERDR_AGENTS_WAIT_POLL_MS: '20',
    FAKE_MODE: path.join(root, 'mode'),
    FAKE_MODE_DIR: modeDir,
    FAKE_SCREEN: path.join(root, 'screen'),
    FAKE_SCREEN_DIR: screenDir,
    FAKE_LIVE: path.join(root, 'live.json'),
    FAKE_LOG: path.join(root, 'herdr.log'),
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  };
  fs.writeFileSync(env.FAKE_MODE, 'working\n');
  fs.writeFileSync(env.FAKE_SCREEN, '');
  fs.writeFileSync(env.FAKE_LIVE, JSON.stringify({ agents: [] }));
  const H12 = '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\tmodel\tapprovals\troles\tlane\n';
  const fix = {
    root, repo, state, ws, env, ctx: loadConfig(env, repo),
    mode(m) { fs.writeFileSync(env.FAKE_MODE, `${m}\n`); },
    modeOf(agent, m) { fs.writeFileSync(path.join(modeDir, `mode-${agent}`), `${m}\n`); },
    screen(s) { fs.writeFileSync(env.FAKE_SCREEN, s); },
    screenOf(agent, s) { fs.writeFileSync(path.join(screenDir, `screen-${agent}`), s); },
    live(agents) { fs.writeFileSync(env.FAKE_LIVE, JSON.stringify({ agents })); },
    writeRoster(...rows) { fs.writeFileSync(path.join(ws, 'agents.tsv'), H12 + rows.join('\n') + '\n'); },
    waitFile(agent, name, content) { fs.writeFileSync(path.join(ws, 'wait', `${agent}.${name}`), content); },
    waitRead(agent, name) {
      try { return fs.readFileSync(path.join(ws, 'wait', `${agent}.${name}`), 'utf8'); } catch { return null; }
    },
    report(agent, content) {
      const p = path.join(ws, 'reports', `${agent}.md`);
      fs.writeFileSync(p, content);
      fs.writeFileSync(path.join(ws, `last-report-${agent}`), p + '\n');
      return p;
    },
    logLines() {
      try { return fs.readFileSync(env.FAKE_LOG, 'utf8').split('\n').filter((l) => l !== ''); } catch { return []; }
    },
    clearLog() { fs.writeFileSync(env.FAKE_LOG, ''); },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
  fix.writeRoster();
  return fix;
}

// Row with every 12-column field (pane p-<name>, created 1).
const ROW = (name, role, kind = 'grok', model = '', lane = '') =>
  `${name}\tp-${name}\t${kind}\t${role}\txai\t1\t/tmp/work\tnow\t${model}\tfull\t${role}\t${lane}`;

// `herdr-agents.mjs wait …` as a child process (the waitFor stdout and
// exit code are only observable outside the process).
function waitCmd(fix, args) {
  return spawnSync(nodeBin(), [JS_ENTRY, 'wait', ...args], { cwd: fix.repo, env: fix.env, encoding: 'utf8', timeout: 60_000 });
}
function cmd(fix, args, extraEnv = {}) {
  return spawnSync(nodeBin(), [JS_ENTRY, ...args], { cwd: fix.repo, env: { ...fix.env, ...extraEnv }, encoding: 'utf8', timeout: 60_000 });
}
function jsonLines(out) {
  return out.trim().split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
}

// ---------- waitRank / wait_raise ----------

test('waitRank: 4 > 11 > 7 > 6, everything else 0', () => {
  assert.equal(waitRank(4), 4);
  assert.equal(waitRank(11), 3);
  assert.equal(waitRank(7), 2);
  assert.equal(waitRank(6), 1);
  assert.equal(waitRank(0), 0);
  assert.equal(waitRank(9), 0);
  assert.equal(waitRank('nope'), 0);
});

// ---------- waitFor through the entry ----------

// One agent per failure class; the rank order must hold in either argument
// order: 4 (unavailable) > 11 (quota) > 7 (blocked) > 6 (gone/settled).
test('wait: the rank order 4 > 11 > 7 > 6 in any argument order', { timeout: 30000 }, () => {
  const fix = makeFix('ha-wait-rank-');
  try {
    fix.writeRoster(
      ROW('stuck', 'implementer', 'grok', 'grok-4.7', 'build'),
      ROW('dead', 'reviewer', 'codex', 'gpt-5', 'review'),
      ROW('blocked1', 'tasker', 'grok', '', 'build'),
      ROW('quota1', 'researcher', 'grok', 'grok-4.7', 'build'),
    );
    fix.mode('denied');
    fix.modeOf('stuck', 'denied');
    fix.modeOf('dead', 'missing');
    fix.modeOf('blocked1', 'blocked');
    fix.modeOf('quota1', 'idle');
    fix.waitFile('blocked1', 'blocked', ''); // second blocked probe is due
    fix.screenOf('quota1', 'hit your usage limit\ntry again in 2 hours\n');
    for (const args of [['stuck', 'dead', 'blocked1', 'quota1'], ['quota1', 'blocked1', 'dead', 'stuck']]) {
      const r = waitCmd(fix, [...args, '--timeout', '10000']);
      assert.equal(r.status, 4, `rc for ${args.join(' ')}: ${r.stderr}`);
      const lines = jsonLines(r.stdout);
      assert.deepEqual(
        lines.map((l) => [l.agent, l.status]),
        args.map((a) => [a, { stuck: 'unavailable', dead: 'gone', blocked1: 'blocked', quota1: 'quota' }[a]]),
      );
      const un = lines.find((l) => l.agent === 'stuck');
      assert.match(un.error, /PermissionDenied/);
      const q = lines.find((l) => l.agent === 'quota1');
      assert.equal(q.lane, 'build');
      assert.equal(q.kind, 'grok');
      assert.equal(q.model, 'grok-4.7');
      assert.match(q.match, /hit your usage limit/);
      assert.match(q.renewal, /try again in 2 hours/);
    }
    // 11 > 7 and 7 > 6, both orders.
    const r11a = waitCmd(fix, ['blocked1', 'quota1', '--timeout', '10000']);
    const r11b = waitCmd(fix, ['quota1', 'blocked1', '--timeout', '10000']);
    assert.equal(r11a.status, 11);
    assert.equal(r11b.status, 11);
    const r7a = waitCmd(fix, ['blocked1', 'dead', '--timeout', '10000']);
    const r7b = waitCmd(fix, ['dead', 'blocked1', '--timeout', '10000']);
    assert.equal(r7a.status, 7);
    assert.equal(r7b.status, 7);
  } finally { fix.cleanup(); }
});

// The report file is only `done` when its size stops changing: a fresh
// report is `pending` on the first probe (wait clears .size) and `done` on
// the second; a size change reopens the pending.
test('wait: report ready only on the second probe with the same size', { timeout: 30000 }, () => {
  const fix = makeFix('ha-wait-report-');
  try {
    fix.writeRoster(ROW('w', 'implementer'));
    const p = fix.report('w', 'done\n');
    const sd = fix.ws;
    assert.equal(probeAgent(sd, 'w', p, fix.ctx, fix.env), 'pending', 'fresh report: first probe');
    assert.equal(fix.waitRead('w', 'size'), '       5\n', 'the wc -c padding is kept');
    assert.equal(probeAgent(sd, 'w', p, fix.ctx, fix.env), 'done', 'same size: second probe');
    fs.appendFileSync(p, 'x\n');
    fs.rmSync(path.join(sd, 'wait', 'w.size'), { force: true });
    assert.equal(probeAgent(sd, 'w', p, fix.ctx, fix.env), 'pending', 'size changed: pending again');
    assert.equal(fix.waitRead('w', 'size'), '       7\n');
    assert.equal(probeAgent(sd, 'w', p, fix.ctx, fix.env), 'done');
    // End-to-end: a fresh report needs one extra poll round and then rc 0.
    fix.mode('working');
    fs.rmSync(path.join(sd, 'wait', 'w.size'), { force: true });
    const r = waitCmd(fix, ['w', '--timeout', '1000']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(jsonLines(r.stdout), [{ agent: 'w', status: 'done', report: p }]);
  } finally { fix.cleanup(); }
});

// Two consecutive blocked probes before `blocked` is reported; the first
// probe only records the flag and keeps working.
test('wait: two blocked probes before reporting blocked', { timeout: 30000 }, () => {
  const fix = makeFix('ha-wait-blocked-');
  try {
    fix.writeRoster(ROW('b', 'implementer'));
    fix.mode('blocked');
    const sd = fix.ws;
    assert.equal(probeAgent(sd, 'b', '', fix.ctx, fix.env), 'working', 'first blocked probe');
    assert.equal(fix.waitRead('b', 'blocked'), '', '.blocked flag recorded');
    const r = waitCmd(fix, ['b', '--timeout', '1000']);
    assert.equal(r.status, 7, r.stderr);
    assert.deepEqual(jsonLines(r.stdout), [{ agent: 'b', status: 'blocked', report: '' }]);
    assert.ok(fs.existsSync(path.join(sd, 'wait', 'b.blocked')), 'flag stays for the next wait');
  } finally { fix.cleanup(); }
});

// Settled: a still screen older than settled_grace (the screen hash is
// compared, never shown); a changed screen or a working state resets it.
test('wait: settled with a still screen, reset by movement', { timeout: 30000 }, () => {
  const fix = makeFix('ha-wait-settled-');
  try {
    fix.writeRoster(ROW('s', 'implementer'));
    fix.mode('idle');
    fix.screen('still\n');
    const sd = fix.ws;
    assert.equal(probeAgent(sd, 's', '', fix.ctx, fix.env), 'working', 'first probe records the screen');
    assert.equal(probeAgent(sd, 's', '', fix.ctx, fix.env), 'working', 'still screen inside the grace');
    fs.writeFileSync(path.join(sd, 'wait', 's.since'), `${Math.floor(Date.now() / 1000) - 46}\n`);
    assert.equal(probeAgent(sd, 's', '', fix.ctx, fix.env), 'settled', 'still screen older than the grace');
    // A changed screen resets the bookkeeping (new hash, new since).
    fix.screen('moved\n');
    assert.equal(probeAgent(sd, 's', '', fix.ctx, fix.env), 'working', 'a new screen moves the agent');
    assert.equal(probeAgent(sd, 's', '', fix.ctx, fix.env), 'working', 'inside the grace again');
  } finally { fix.cleanup(); }
  // End-to-end with grace 0: the second probe settles (rc 6).
  const fix2 = makeFix('ha-wait-settled0-');
  try {
    fix2.writeRoster(ROW('s', 'implementer'));
    fix2.mode('idle');
    fix2.screen('still\n');
    const r2 = spawnSync(nodeBin(), [JS_ENTRY, 'wait', 's', '--timeout', '10000'], {
      cwd: fix2.repo, env: { ...fix2.env, HERDR_AGENTS_SETTLED_GRACE: '0' }, encoding: 'utf8', timeout: 60_000,
    });
    assert.equal(r2.status, 6, r2.stderr);
    assert.deepEqual(jsonLines(r2.stdout), [{ agent: 's', status: 'settled-no-report', report: '' }]);
  } finally { fix2.cleanup(); }
});

// gone and unavailable: only agent_not_found is `gone`; every other
// `agent get` failure is `unavailable` with the sanitized cause.
test('wait: gone and unavailable with a cause', { timeout: 30000 }, () => {
  const fix = makeFix('ha-wait-states-');
  try {
    fix.writeRoster(ROW('dead', 'implementer'), ROW('stuck', 'implementer'));
    fix.modeOf('dead', 'missing');
    fix.modeOf('stuck', 'denied');
    const sd = fix.ws;
    assert.equal(probeAgent(sd, 'dead', '', fix.ctx, fix.env), 'gone');
    const un = probeAgent(sd, 'stuck', '', fix.ctx, fix.env);
    assert.ok(un.startsWith('unavailable\t'), un);
    assert.match(un.split('\t')[1], /PermissionDenied/);
    const r = waitCmd(fix, ['dead', '--timeout', '1000']);
    assert.equal(r.status, 6, r.stderr);
    assert.deepEqual(jsonLines(r.stdout), [{ agent: 'dead', status: 'gone', report: '' }]);
    const r2 = waitCmd(fix, ['stuck', '--timeout', '1000']);
    assert.equal(r2.status, 4, r2.stderr);
    const lines = jsonLines(r2.stdout);
    assert.equal(lines[0].status, 'unavailable');
    assert.match(lines[0].error, /PermissionDenied/);
    assert.ok(!r2.stdout.includes('"status":"gone"'), 'never degraded to gone');
  } finally { fix.cleanup(); }
});

// Quota: the JSON line carries lane/kind/model/match/renewal and the warn
// lands in the friction log as command `wait`.
test('wait: quota fields and the friction entry', { timeout: 30000 }, () => {
  const fix = makeFix('ha-wait-quota-');
  try {
    fix.writeRoster(ROW('q1', 'researcher', 'grok', 'grok-4.7', 'build'));
    fix.mode('idle');
    fix.screen('Individual quota reached token=sk_live_abcdefghij\nResets at 5:00pm\n');
    const r = waitCmd(fix, ['q1', '--timeout', '1000']);
    assert.equal(r.status, 11, r.stderr);
    const q = jsonLines(r.stdout)[0];
    assert.deepEqual(Object.keys(q), ['agent', 'status', 'report', 'lane', 'kind', 'model', 'match', 'renewal']);
    assert.equal(q.agent, 'q1');
    assert.equal(q.status, 'quota');
    assert.equal(q.report, '');
    assert.equal(q.lane, 'build');
    assert.equal(q.kind, 'grok');
    assert.equal(q.model, 'grok-4.7');
    assert.match(q.match, /Individual quota reached/);
    assert.ok(!q.match.includes('sk_live_'), 'the secret is redacted');
    assert.match(q.renewal, /Resets at 5:00pm/);
    const friction = fs.readFileSync(path.join(fix.ws, 'friction.log'), 'utf8');
    assert.match(friction, /warning\twait\tquota: agent 'q1' lane=build kind=grok model=grok-4.7/);
    // The .quota file holds the two lines the next read consumes.
    assert.equal(fix.waitRead('q1', 'quota'), 'Individual quota reached token=[redacted]\nResets at 5:00pm\n');
  } finally { fix.cleanup(); }
});

// Timeout: a working agent never settles before the deadline → a
// `timeout` line and rc 9.
test('wait: timeout 9 for a working agent', { timeout: 30000 }, () => {
  const fix = makeFix('ha-wait-timeout-');
  try {
    fix.writeRoster(ROW('w', 'implementer'));
    fix.mode('working');
    fix.screen('typing…\n');
    const r = waitCmd(fix, ['w', '--timeout', '1000']);
    assert.equal(r.status, 9, r.stderr);
    assert.deepEqual(jsonLines(r.stdout), [{ agent: 'w', status: 'timeout' }]);
  } finally { fix.cleanup(); }
});

// --any returns 0 on the first done, even while other agents keep working;
// with notify=on the done agent triggers the notification.
test('wait: --any returns on the first done; notify=on notifies', { timeout: 30000 }, () => {
  const fix = makeFix('ha-wait-any-');
  try {
    fix.writeRoster(ROW('a1', 'implementer'), ROW('a2', 'reviewer'));
    fix.mode('working');
    fix.screen('busy\n');
    const p1 = fix.report('a1', 'done\n');
    fix.clearLog();
    const r = waitCmd(fix, ['a1', 'a2', '--any', '--timeout', '10000'], );
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(jsonLines(r.stdout), [{ agent: 'a1', status: 'done', report: p1 }], 'only the done line');
    const r2 = waitCmd(fix, ['a2', 'a1', '--any', '--timeout', '10000']);
    assert.equal(r2.status, 0, r2.stderr);
    assert.deepEqual(jsonLines(r2.stdout), [{ agent: 'a1', status: 'done', report: p1 }], 'argument order does not matter');
    // notify=on: the done path calls the notification.
    fix.clearLog();
    const r3 = cmd(fix, ['wait', 'a1', '--timeout', '10000'], { HERDR_AGENTS_NOTIFY: 'on' });
    assert.equal(r3.status, 0, r3.stderr);
    const logged = fix.logLines();
    assert.ok(logged.includes(`notification show herdr-agents: a1 finished --body ${p1} --sound done`), logged.join('\n'));
  } finally { fix.cleanup(); }
});

// ---------- tryAutoApprove ----------

test('tryAutoApprove: off by default, no keypress', () => {
  const fix = makeFix('ha-approve-off-');
  try {
    fix.writeRoster(ROW('a', 'implementer'));
    fix.waitFile('a', 'blocked', '');
    assert.equal(tryAutoApprove(fix.ws, 'a', fix.ctx, fix.env), false);
    assert.deepEqual(fix.logLines(), [], 'no send-keys');
    assert.equal(fix.waitRead('a', 'approvals'), null);
  } finally { fix.cleanup(); }
});

test('tryAutoApprove: key per kind, counter and log, the cap, send failure', { timeout: 30000 }, () => {
  const fix = makeFix('ha-approve-on-');
  try {
    fix.writeRoster(ROW('a', 'implementer'), ROW('c', 'reviewer', 'codex'));
    const env = { ...fix.env, HERDR_AGENTS_AUTO_APPROVE: 'on' };
    fix.waitFile('a', 'blocked', '');
    assert.equal(tryAutoApprove(fix.ws, 'a', fix.ctx, env), true);
    assert.ok(fix.logLines().includes('agent send-keys a enter'), 'grok answers with enter');
    assert.equal(fix.waitRead('a', 'approvals'), '1\n');
    assert.match(fix.waitRead('a', 'approvals.log'), /^\d{8}T\d{6} auto-approved dialog #1\n$/);
    assert.equal(fix.waitRead('a', 'blocked'), null, 'the blocked flag is cleared');
    assert.equal(tryAutoApprove(fix.ws, 'a', fix.ctx, env), true);
    assert.equal(fix.waitRead('a', 'approvals'), '2\n');
    assert.match(fix.waitRead('a', 'approvals.log'), /auto-approved dialog #2/);
    // codex answers with y.
    fix.waitFile('c', 'blocked', '');
    assert.equal(tryAutoApprove(fix.ws, 'c', fix.ctx, env), true);
    assert.ok(fix.logLines().includes('agent send-keys c y'), 'codex answers with y');
    assert.equal(kindApproveKeys('pi'), 'enter', 'unknown kinds fall back to enter');
    // The cap: max_auto_approvals=1 refuses a second approval for c.
    const envCap = { ...env, HERDR_AGENTS_MAX_AUTO_APPROVALS: '1' };
    assert.equal(tryAutoApprove(fix.ws, 'c', fix.ctx, envCap), false, 'at the cap');
    assert.equal(fix.waitRead('c', 'approvals'), '1\n', 'counter untouched');
    // A failed keypress leaves the counter behind (no write after failure).
    const envFail = { ...env, FAKE_SENDKEYS_FAIL: '1' };
    fix.writeRoster(ROW('f', 'implementer'));
    assert.equal(tryAutoApprove(fix.ws, 'f', fix.ctx, envFail), false);
    assert.equal(fix.waitRead('f', 'approvals'), null);
  } finally { fix.cleanup(); }
});

// ---------- briefTask ----------

test('briefTask: H1, the Brief prefixes, contract sections, no H1, CRLF', () => {
  const fix = makeFix('ha-brieftask-');
  try {
    const dir = path.join(fix.root, 'briefs');
    fs.mkdirSync(dir, { recursive: true });
    const w = (name, content) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, content);
      return p;
    };
    assert.equal(briefTask(w('t1.md', '# My task\n\n# Goal\n\ndo it\n')), 'My task');
    assert.equal(briefTask(w('t2.md', '# Brief — porte da config\n\n# Goal\n')), 'porte da config');
    assert.equal(briefTask(w('t3.md', '# Brief: rename the thing\n')), 'rename the thing');
    assert.equal(briefTask(w('t4.md', '# Brief - fix the flake\n')), 'fix the flake');
    assert.equal(briefTask(w('t5.md', '# Brief  —  extra spaces\n')), 'extra spaces');
    assert.equal(briefTask(w('t6.md', '# Goal\n\nstuff\n')), 't6', 'contract section H1 falls back to the file name');
    assert.equal(briefTask(w('t7.md', '# EXPECTED RESULT\n')), 't7', 'section match is case-insensitive');
    assert.equal(briefTask(w('t8.md', '# Owned files\n')), 't8');
    assert.equal(briefTask(w('t9.md', '# Context\n')), 't9');
    assert.equal(briefTask(w('t10.md', 'plain first line\n# not an H1 position\n')), 't10', 'no H1: the file name');
    assert.equal(briefTask(w('t11.md', '\n\n# T\n')), 'T', 'leading blank lines skipped');
    assert.equal(briefTask(w('t12.md', '# T\r\nbody\r\n')), 'T', 'CRLF is stripped');
    assert.equal(briefTask(w('t13.md', '# Brief:\n')), 't13', 'a bare "Brief:" prefix names nothing');
    assert.equal(briefTask(w('t14.md', '   # Indented is not an H1\n')), 't14');
    assert.equal(briefTask(w('noext', '# T\n')), 'T', 'only .md is stripped from the name');
    assert.equal(briefTask(path.join(dir, 'missing.md')), 'missing', 'a missing file reads as the name');
  } finally { fix.cleanup(); }
});

// ---------- markTaskDone ----------

test('markTaskDone: adds the check mark once, via paneTitle', () => {
  const fix = makeFix('ha-markdone-');
  try {
    fix.writeRoster(ROW('a', 'implementer'));
    const task = path.join(fix.ws, 'task-a');
    // No task file: nothing to mark, no herdr call.
    markTaskDone(fix.ws, 'a', fix.env);
    assert.deepEqual(fix.logLines(), []);
    assert.equal(fs.existsSync(task), false);
    // A dispatch title: the file gains ✓ once and the pane is retitled.
    fs.writeFileSync(task, 'implementer: porte da config\n');
    markTaskDone(fix.ws, 'a', fix.env);
    assert.equal(fs.readFileSync(task, 'utf8'), 'implementer: porte da config ✓\n');
    assert.deepEqual(fix.logLines(), ['pane report-metadata p-a --source herdr-agents --title implementer: porte da config ✓']);
    // Second call: the file and the pane are untouched.
    markTaskDone(fix.ws, 'a', fix.env);
    assert.equal(fs.readFileSync(task, 'utf8'), 'implementer: porte da config ✓\n');
    assert.equal(fix.logLines().length, 1, 'no second retitle');
    // An already-marked title: a fresh dispatch file that already ends ✓.
    fs.writeFileSync(task, 'implementer: old task ✓\n');
    markTaskDone(fix.ws, 'a', fix.env);
    assert.equal(fs.readFileSync(task, 'utf8'), 'implementer: old task ✓\n');
    assert.equal(fix.logLines().length, 1);
    // A roster row without a pane id: no herdr call.
    fix.writeRoster(`b\t\tgrok\timplementer\txai\t1\t/tmp/work\tnow\t\t\timplementer\t`);
    fs.writeFileSync(path.join(fix.ws, 'task-b'), 'T\n');
    markTaskDone(fix.ws, 'b', fix.env);
    assert.equal(fix.logLines().length, 1, 'no pane, no title call');
  } finally { fix.cleanup(); }
});

// ---------- cksumField ----------

test('cksumField: the first field of the local `cksum` (algorithm 3)', () => {
  // Verified against the BSD/macOS `cksum` binary (poly 0x04C11DB7 over
  // the bytes + least-significant-first length octets, complemented).
  assert.equal(cksumField('a'), 1220704766);
  assert.equal(cksumField('hello'), 3287646509);
  assert.equal(cksumField(''), 4294967295);
  assert.equal(cksumField('x\ry\n'), 118399186);
});

// ---------- entry error paths ----------

test('entry: wait/collect/release/clean usage and friction errors', { timeout: 60000 }, () => {
  const fix = makeFix('ha-entry-usage-');
  try {
    fix.writeRoster(ROW('a', 'implementer'));
    let r = cmd(fix, ['wait']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /wait: give at least one agent name/);
    r = cmd(fix, ['wait', 'nosuch']);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /agent 'nosuch' is not in the roster/);
    r = cmd(fix, ['wait', 'a', '--bogus']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /wait: unknown option --bogus/);
    r = cmd(fix, ['wait', 'a', '--timeout']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /wait: --timeout expects a value/);
    r = cmd(fix, ['collect']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /agent: Parameter not set/);
    r = cmd(fix, ['collect', 'a', '--bogus']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /collect: unknown option --bogus/);
    r = cmd(fix, ['release']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /agent: Parameter not set/);
    r = cmd(fix, ['release', 'a', '--bogus']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /release: unknown option --bogus/);
    r = cmd(fix, ['clean', '--bogus']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /clean: unknown option --bogus/);
    r = cmd(fix, ['clean', '--older-than']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /clean: --older-than expects a value/);
    // An unavailable agent inside `wait`: the warn lands in the friction
    // log as command `wait` and the exit code is 4.
    fix.modeOf('a', 'denied');
    r = cmd(fix, ['wait', 'a', '--timeout', '2000']);
    assert.equal(r.status, 4, r.stderr);
    const friction = fs.readFileSync(path.join(fix.ws, 'friction.log'), 'utf8');
    assert.match(friction, /warning\twait\tagent 'a': herdr agent get failed: .*PermissionDenied/);
  } finally { fix.cleanup(); }
});

// ---------- review fixes (slice 6a) ----------

test('pollIntervalMs: only an integer from 1 to 3000 shortens the 3 s poll', () => {
  const at = (v) => pollIntervalMs(v === undefined ? {} : { HERDR_AGENTS_WAIT_POLL_MS: v });
  assert.equal(at(undefined), 3000);
  assert.equal(at('20'), 20);
  assert.equal(at('3000'), 3000);
  assert.equal(at('1'), 1);
  for (const bad of ['0.5', '0', '5000', '-1', 'abc', '', '20ms']) assert.equal(at(bad), 3000, `'${bad}'`);
});

test('tryAutoApprove: a counter that exists but is not a number fails closed', () => {
  const fix = makeFix('ha-approve-badcount-');
  try {
    fix.writeRoster(ROW('a', 'implementer'));
    const env = { ...fix.env, HERDR_AGENTS_AUTO_APPROVE: 'on' };
    for (const bad of ['', '  \n', 'x\n', '1.5\n']) {
      fix.waitFile('a', 'approvals', bad);
      fix.clearLog();
      assert.equal(tryAutoApprove(fix.ws, 'a', fix.ctx, env), false, JSON.stringify(bad));
      assert.deepEqual(fix.logLines().filter((l) => l.startsWith('agent send-keys')), [], 'no keypress');
      assert.equal(fix.waitRead('a', 'approvals'), bad, 'counter untouched');
    }
  } finally { fix.cleanup(); }
});

test('wait: a --timeout that is not a number of milliseconds exits 2', { timeout: 30000 }, () => {
  const fix = makeFix('ha-wait-badtimeout-');
  try {
    fix.writeRoster(ROW('a', 'implementer'));
    const r = waitCmd(fix, ['a', '--timeout', 'abc']);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.stderr, "herdr-agents: wait: --timeout expects milliseconds, got 'abc'\n");
  } finally { fix.cleanup(); }
});

test('clean: an empty or invalid --older-than deletes nothing', { timeout: 30000 }, () => {
  const fix = makeFix('ha-clean-baddays-');
  try {
    const old = path.join(fix.ws, 'reports', 'old.md');
    fs.writeFileSync(old, 'x');
    const t = new Date(Date.now() - 3 * 86400000);
    fs.utimesSync(old, t, t);
    for (const bad of ['', 'abc', '-1', '1.5']) {
      const r = cmd(fix, ['clean', '--older-than', bad]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^removed 0 files older than /m, `'${bad}'`);
      assert.ok(fs.existsSync(old), `'${bad}' kept the old report`);
    }
  } finally { fix.cleanup(); }
});

test('clean: a herdr agent list without an agent list exits 4 and keeps the roster', { timeout: 30000 }, () => {
  const fix = makeFix('ha-clean-badlist-');
  try {
    fix.writeRoster(ROW('a', 'implementer'), ROW('b', 'reviewer'));
    const before = fs.readFileSync(path.join(fix.ws, 'agents.tsv'), 'utf8');
    for (const answer of ['not json', '{"result":{}}', '{"result":{"agents":"x"}}']) {
      writeFakeCli(path.join(fix.root, 'bin'), 'herdr', `process.stdout.write(${JSON.stringify(answer)} + '\\n');\n`);
      const r = cmd(fix, ['clean']);
      assert.equal(r.status, 4, `${answer}: ${r.stderr}`);
      assert.equal(r.stderr, 'herdr-agents: herdr agent list returned no agent list\n');
      assert.equal(fs.readFileSync(path.join(fix.ws, 'agents.tsv'), 'utf8'), before, `${answer}: roster kept`);
    }
  } finally { fix.cleanup(); }
});
