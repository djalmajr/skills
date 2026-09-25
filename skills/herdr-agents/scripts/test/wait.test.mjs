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
// the only herdr the code sees. S5 items 2 and 11a: a confirmed blocked
// question screen (no key even with auto_approve=on, `question` with the
// text, rc 7, friction entry) and the one-shot stuck-in-one-tool-call
// warning for a still screen (counters aside). A dispatch that ended
// not-received is continued by the wait: the marker is dropped when the
// prompt arrived late, one Enter is retried per window while the prompt
// still sits in the input box (bounded), and the wait ends not-received
// (the rank between 14 and 7).
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
// as agent_status; the state_change_seq is read from the FAKE_SEQ file
// when it exists); `agent read` prints screen-<t> (or the global screen
// file); `agent list` from FAKE_LIVE; `agent send-keys` fails when
// FAKE_SENDKEYS_FAIL and turns the worker to working when the
// FAKE_SENDKEYS_WORK file exists (writing the report too when
// FAKE_REPORT_PATH is set). Every call is logged as one "$*" line (FAKE_LOG).
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
const modeFileOf = (t) => {
  const per = process.env.FAKE_MODE_DIR + '/mode-' + t;
  try { fs.accessSync(per); return per; } catch { return process.env.FAKE_MODE; }
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
  let seqVal = '';
  try { seqVal = fs.readFileSync(process.env.FAKE_SEQ, 'utf8').trim(); } catch {}
  const seqJson = seqVal !== '' ? ', "state_change_seq": ' + seqVal + '' : '';
  process.stdout.write('{"result":{"agent":{"name":"' + t + '","agent_status":"' + m + '"' + seqJson + '}}}\\n');
} else if (cmd === 'agent read') {
  process.stdout.write(screenOf(t));
} else if (cmd === 'agent prompt') {
  // The capacity continue prompt: success by default; when
  // FAKE_REPORT_PATH is set the "worker" writes the report in answer to
  // the continue, and when the FAKE_PROMPT_FAIL file exists the prompt
  // fails like a dead provider.
  if (process.env.FAKE_PROMPT_FAIL && fs.existsSync(process.env.FAKE_PROMPT_FAIL)) {
    process.stderr.write('prompt failed: the fake refused\\n');
    process.exit(1);
  }
  if (process.env.FAKE_REPORT_PATH) fs.writeFileSync(process.env.FAKE_REPORT_PATH, 'done\\n');
  process.stdout.write('{"result":{}}\\n');
} else if (cmd === 'agent list') {
  let agents = [];
  try { agents = (JSON.parse(fs.readFileSync(process.env.FAKE_LIVE, 'utf8')).agents) ?? []; } catch {}
  process.stdout.write(JSON.stringify({ result: { agents } }) + '\\n');
} else if (cmd === 'agent send-keys') {
  if (process.env.FAKE_SENDKEYS_FAIL) { process.stderr.write('send-keys failed\\n'); process.exit(1); }
  if (process.env.FAKE_SENDKEYS_WORK && fs.existsSync(process.env.FAKE_SENDKEYS_WORK)) {
    // The Enter finally starts the worker (a CLI that was still opening)
    // and writes the report in answer, like a real worker would.
    try { fs.writeFileSync(modeFileOf(t), 'working\\n'); } catch {}
    if (process.env.FAKE_REPORT_PATH) fs.writeFileSync(process.env.FAKE_REPORT_PATH, 'done\\n');
  }
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
    FAKE_SEQ: path.join(root, 'seq'),
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

test('waitRank: 4 > 11 > 14 > 15 > 7 > 6, everything else 0', () => {
  // Mutation captured: dropping the '15' case (or ranking it at or above
  // 14, or at or below 7) lets a not-received wait lose to a provider stop
  // or beat a blocked one.
  assert.equal(waitRank(4), 6);
  assert.equal(waitRank(11), 5);
  assert.equal(waitRank(14), 4);
  assert.equal(waitRank(15), 3);
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

// ---------- a not-received dispatch is continued by the wait ----------

// A dispatch that ended not-received recorded the moment in .not-received;
// the worker that starts working afterwards makes the marker stale: the
// probe drops it (and the retry counter) and goes on as usual.
test('wait: a late arrival clears the not-received marker and the retry counter', { timeout: 30000 }, () => {
  const fix = makeFix('ha-wait-latearrival-');
  try {
    fix.writeRoster(ROW('w', 'implementer'));
    const sd = fix.ws;
    const now = Math.floor(Date.now() / 1000);
    fix.waitFile('w', 'not-received', `${now - 120}\n`);
    fix.waitFile('w', 'enter-retry', `2 ${now - 60}\n`);
    fix.modeOf('w', 'working');
    fix.screenOf('w', 'thinking…\n');
    // Mutation captured: the marker (or the retry counter) surviving a
    // working agent would make the next wait retry a stale Enter.
    assert.equal(probeAgent(sd, 'w', '', fix.ctx, fix.env), 'working', 'the normal probe goes on');
    assert.equal(fix.waitRead('w', 'not-received'), null, 'the marker is dropped');
    assert.equal(fix.waitRead('w', 'enter-retry'), null, 'the retry counter is dropped');
  } finally { fix.cleanup(); }
});

// The same clear on a blocked worker: the prompt arrived while the agent
// was in a dialog; the normal blocked logic takes over.
test('wait: a blocked worker clears the not-received marker and keeps the blocked logic', { timeout: 30000 }, () => {
  const fix = makeFix('ha-wait-lateblocked-');
  try {
    fix.writeRoster(ROW('w', 'implementer'));
    const sd = fix.ws;
    fix.waitFile('w', 'not-received', `${Math.floor(Date.now() / 1000) - 120}\n`);
    fix.modeOf('w', 'blocked');
    fix.screenOf('w', 'Allow command? git push\n\nPress enter to confirm or esc to cancel\n');
    // Mutation captured: the marker not cleared on a blocked worker (or
    // the blocked double-probe bypassed) changes the state and the files
    // below.
    assert.equal(probeAgent(sd, 'w', '', fix.ctx, fix.env), 'working', 'the first blocked probe only records');
    assert.equal(fix.waitRead('w', 'not-received'), null, 'the marker is dropped');
    assert.equal(fix.waitRead('w', 'blocked'), '', 'the blocked flag is recorded as usual');
  } finally { fix.cleanup(); }
});

// The wait continues a not-received dispatch: with the window elapsed and
// the prompt still in the input box it sends one Enter and records the
// attempt count and the moment; a second probe inside the window sends
// nothing; a counter that is not two integers fails closed.
test('wait: an Enter retry while the prompt sits in the input box', { timeout: 30000 }, () => {
  const fix = makeFix('ha-wait-retryenter-');
  try {
    fix.writeRoster(ROW('w', 'implementer'));
    const sd = fix.ws;
    // A window far longer than any probe under load, so "inside the
    // window" below never depends on how fast the fake herdr runs.
    const env = { ...fix.env, HERDR_AGENTS_PROMPT_CHECK_SECONDS: '600' };
    const now = Math.floor(Date.now() / 1000);
    fix.waitFile('w', 'not-received', `${now - 1200}\n`); // older than the window
    fix.modeOf('w', 'idle');
    fix.screenOf('w', 'Welcome to the worker\n> Read the file /x/brief.md in full and execute it.\n');
    // Mutation captured: not sending the Enter (or not recording the
    // attempt) leaves the worker stuck in its input box and the wait
    // unable to tell the retries apart.
    const before = Math.floor(Date.now() / 1000);
    assert.equal(probeAgent(sd, 'w', '', fix.ctx, env), 'working', 'the retry keeps the wait going');
    const after = Math.floor(Date.now() / 1000);
    assert.deepEqual(fix.logLines().filter((l) => l.startsWith('agent send-keys')), ['agent send-keys w enter']);
    const retry = fix.waitRead('w', 'enter-retry').trim().split(/\s+/);
    assert.equal(retry[0], '1', 'one attempt recorded');
    assert.ok(Number(retry[1]) >= before && Number(retry[1]) <= after, 'the attempt moment is recorded');
    assert.equal(fix.waitRead('w', 'not-received'), `${now - 1200}\n`, 'the marker itself is kept for the next probe');
    // A second probe inside the window sends nothing.
    assert.equal(probeAgent(sd, 'w', '', fix.ctx, env), 'working', 'inside the window: no key');
    assert.equal(fix.logLines().filter((l) => l.startsWith('agent send-keys')).length, 1, 'still one Enter');
    // A counter that is not two integers fails closed: not-received, no
    // further key.
    fix.waitFile('w', 'enter-retry', 'x y\n');
    assert.equal(probeAgent(sd, 'w', '', fix.ctx, env), 'not-received', 'malformed counter fails closed');
    assert.equal(fix.logLines().filter((l) => l.startsWith('agent send-keys')).length, 1, 'no key after the malformed counter');
  } finally { fix.cleanup(); }
});

// A fresh marker is the last attempt itself: inside the window the probe
// returns working and sends no key, and no counter is created.
test('wait: a fresh not-received marker waits one window before the first retry', { timeout: 30000 }, () => {
  const fix = makeFix('ha-wait-freshnr-');
  try {
    fix.writeRoster(ROW('w', 'implementer'));
    const sd = fix.ws;
    fix.waitFile('w', 'not-received', `${Math.floor(Date.now() / 1000)}\n`);
    fix.modeOf('w', 'idle');
    fix.screenOf('w', 'Welcome to the worker\n> Read the file /x/brief.md in full and execute it.\n');
    // Mutation captured: retrying immediately on the fresh marker (no
    // window) would send the Enter on this probe.
    assert.equal(probeAgent(sd, 'w', '', fix.ctx, fix.env), 'working', 'inside the window: no key yet');
    assert.deepEqual(fix.logLines().filter((l) => l.startsWith('agent send-keys')), [], 'no key inside the window');
    assert.equal(fix.waitRead('w', 'enter-retry'), null, 'no counter before the first retry');
  } finally { fix.cleanup(); }
});

// The three retries are spent: the wait ends not-received even with the
// prompt still in the input box, and sends no further key.
test('wait: three retries spent end the wait not-received', { timeout: 30000 }, () => {
  const fix = makeFix('ha-wait-retryexhausted-');
  try {
    fix.writeRoster(ROW('w', 'implementer'));
    const sd = fix.ws;
    const now = Math.floor(Date.now() / 1000);
    fix.waitFile('w', 'not-received', `${now - 300}\n`);
    fix.waitFile('w', 'enter-retry', `3 ${now - 30}\n`);
    fix.modeOf('w', 'idle');
    fix.screenOf('w', 'Welcome to the worker\n> Read the file /x/brief.md in full and execute it.\n');
    // Mutation captured: a missing retry cap (or a cap of more than three)
    // sends a fourth Enter here instead of ending the wait.
    assert.equal(probeAgent(sd, 'w', '', fix.ctx, fix.env), 'not-received', 'the budget is spent even with the prompt in the input box');
    assert.deepEqual(fix.logLines().filter((l) => l.startsWith('agent send-keys')), [], 'no further Enter');
  } finally { fix.cleanup(); }
});

// A state change since the marker (the state_change_seq moved) makes the
// marker stale even with the agent not working: the probe drops the marker
// and the retry counter, sends no key, and goes on with the normal logic.
test('wait: a state change since the marker drops the marker and sends no Enter', { timeout: 30000 }, () => {
  const fix = makeFix('ha-wait-seqchanged-');
  try {
    fix.writeRoster(ROW('w', 'implementer'));
    const sd = fix.ws;
    const now = Math.floor(Date.now() / 1000);
    // The marker holds seq 5; the agent's current state_change_seq is 7:
    // it changed state since the dispatch gave up, so a prompt echo in the
    // last lines is no proof the input box is stuck.
    fix.waitFile('w', 'not-received', `${now - 120} 5\n`);
    // Mutation captured: ignoring the seq (or not comparing it) retries
    // the Enter and keeps the marker.
    fs.writeFileSync(fix.env.FAKE_SEQ, '7\n');
    fix.modeOf('w', 'idle');
    fix.screenOf('w', 'Welcome to the worker\n> Read the file /x/brief.md in full and execute it.\n');
    assert.equal(probeAgent(sd, 'w', '', fix.ctx, fix.env), 'working', 'the normal probe goes on');
    assert.equal(fix.waitRead('w', 'not-received'), null, 'the marker is dropped');
    assert.equal(fix.waitRead('w', 'enter-retry'), null, 'no retry counter is left');
    assert.deepEqual(fix.logLines().filter((l) => l.startsWith('agent send-keys')), [], 'no Enter is sent');
  } finally { fix.cleanup(); }
});

// The same seq as the marker means the agent did nothing in the meantime:
// the retry goes on as before and the marker stays. An epoch-only marker
// (the older format) has no seq to compare and keeps the retry too.
test('wait: the same seq and an epoch-only marker keep the retry', { timeout: 30000 }, () => {
  const fix = makeFix('ha-wait-seqsame-');
  try {
    fix.writeRoster(ROW('w1', 'implementer'), ROW('w2', 'implementer'));
    const sd = fix.ws;
    const now = Math.floor(Date.now() / 1000);
    fix.waitFile('w1', 'not-received', `${now - 120} 7\n`);
    // Mutation captured: treating "a seq is present" as "it changed" (or
    // skipping the retry on a matching seq) drops the marker here.
    fs.writeFileSync(fix.env.FAKE_SEQ, '7\n');
    fix.modeOf('w1', 'idle');
    fix.screenOf('w1', 'Welcome to the worker\n> Read the file /x/brief.md in full and execute it.\n');
    assert.equal(probeAgent(sd, 'w1', '', fix.ctx, fix.env), 'working', 'the retry keeps the wait going');
    assert.equal(fix.waitRead('w1', 'not-received'), `${now - 120} 7\n`, 'the marker stays');
    assert.deepEqual(fix.logLines().filter((l) => l.startsWith('agent send-keys')), ['agent send-keys w1 enter']);
    // An epoch-only marker (an older one) keeps the retry too.
    fix.waitFile('w2', 'not-received', `${now - 120}\n`);
    fix.modeOf('w2', 'idle');
    fix.screenOf('w2', 'Welcome to the worker\n> Read the file /x/brief.md in full and execute it.\n');
    assert.equal(probeAgent(sd, 'w2', '', fix.ctx, fix.env), 'working', 'an older marker keeps the retry');
    assert.deepEqual(fix.logLines().filter((l) => l.startsWith('agent send-keys')),
      ['agent send-keys w1 enter', 'agent send-keys w2 enter']);
  } finally { fix.cleanup(); }
});

// The whole path: with the seq moved, the wait ends settled-no-report
// (rc 6), the marker is dropped, and no key is sent.
test('wait: a state change since the marker ends settled-no-report, no Enter', { timeout: 30000 }, () => {
  const fix = makeFix('ha-wait-seqchanged-e2e-');
  try {
    fix.writeRoster(ROW('w', 'implementer'));
    const sd = fix.ws;
    const now = Math.floor(Date.now() / 1000);
    fix.waitFile('w', 'not-received', `${now - 120} 5\n`);
    // Mutation captured: not dropping the marker when the seq moved keeps
    // the wait in the not-received path (retrying the Enter or exiting 15)
    // instead of the normal settled path.
    fs.writeFileSync(fix.env.FAKE_SEQ, '7\n');
    fix.modeOf('w', 'idle');
    fix.screenOf('w', 'Welcome to the worker\n> Read the file /x/brief.md in full and execute it.\n');
    const r = cmd(fix, ['wait', 'w', '--timeout', '10000'], { HERDR_AGENTS_SETTLED_GRACE: '0' });
    assert.equal(r.status, 6, r.stdout + '\n' + r.stderr);
    assert.deepEqual(jsonLines(r.stdout), [{ agent: 'w', status: 'settled-no-report', report: '' }]);
    assert.equal(fix.waitRead('w', 'not-received'), null, 'the marker is dropped');
    assert.deepEqual(fix.logLines().filter((l) => l.startsWith('agent send-keys')), [], 'no Enter is sent');
  } finally { fix.cleanup(); }
});

// The window is over and the prompt is no longer in the input box with the
// agent not working: the wait ends not-received, no key.
test('wait: a not-received agent whose screen no longer holds the prompt ends not-received', { timeout: 30000 }, () => {
  const fix = makeFix('ha-wait-noprompt-');
  try {
    fix.writeRoster(ROW('w', 'implementer'));
    const sd = fix.ws;
    fix.waitFile('w', 'not-received', `${Math.floor(Date.now() / 1000) - 120}\n`);
    fix.modeOf('w', 'idle');
    fix.screenOf('w', 'Welcome to the worker\n');
    // Mutation captured: sending the Enter for a screen without the prompt
    // (or settling the agent as working) fails the state and the zero-key
    // log below.
    assert.equal(probeAgent(sd, 'w', '', fix.ctx, fix.env), 'not-received');
    assert.deepEqual(fix.logLines().filter((l) => l.startsWith('agent send-keys')), [], 'no key for a screen without the prompt');
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

// Provider error: the first detection only records the screen hash
// and the detected status (keeping the agent working); the second probe
// with the same screen and status confirms and writes the cause; a
// changed screen re-arms the flag.
test('wait: provider-error only on the second equal probe', { timeout: 30000 }, () => {
  const fix = makeFix('ha-wait-provider-');
  try {
    fix.writeRoster(ROW('w', 'implementer', 'grok', 'grok-4.7', 'build'));
    fix.mode('idle');
    fix.screenOf('w', 'Error: Retry failed after 3 attempts: Request timed out.\n');
    const sd = fix.ws;
    // Mutation captured: removing the double confirm returns
    // 'provider-error' on this first probe (this asserts 'working').
    assert.equal(probeAgent(sd, 'w', '', fix.ctx, fix.env), 'working', 'the first detection only records');
    const rec = fix.waitRead('w', 'provider');
    assert.ok(rec !== null && rec.split('\n')[1] === 'provider-error', 'the detected status is recorded');
    assert.equal(probeAgent(sd, 'w', '', fix.ctx, fix.env), 'provider-error', 'the second equal probe confirms');
    assert.equal(fix.waitRead('w', 'provider-cause'), 'Error: Retry failed after 3 attempts: Request timed out.\n');
    // A changed screen re-arms: record again, keep working, then confirm
    // with the new cause.
    fix.screenOf('w', 'Error: Connection error.\n');
    assert.equal(probeAgent(sd, 'w', '', fix.ctx, fix.env), 'working', 'a changed screen re-arms the flag');
    assert.equal(probeAgent(sd, 'w', '', fix.ctx, fix.env), 'provider-error');
    assert.equal(fix.waitRead('w', 'provider-cause'), 'Error: Connection error.\n');
  } finally { fix.cleanup(); }
});

// Mutation captured: keeping <agent>.provider across a probe without the
// stop lets a later identical screen confirm at once.
test('wait: a probe without the stop clears the provider double-confirm', { timeout: 30000 }, () => {
  const fix = makeFix('ha-wait-provider-clear-');
  try {
    fix.writeRoster(ROW('w', 'implementer', 'grok', 'grok-4.7', 'build'));
    fix.mode('idle');
    const sd = fix.ws;
    const stop = 'Error: Connection error.\n';
    fix.screenOf('w', stop);
    assert.equal(probeAgent(sd, 'w', '', fix.ctx, fix.env), 'working', 'first detection records');
    fix.screenOf('w', '• all good\n');
    assert.equal(probeAgent(sd, 'w', '', fix.ctx, fix.env), 'working', 'no stop on this probe');
    assert.equal(fix.waitRead('w', 'provider'), null, 'the record is gone');
    fix.screenOf('w', stop);
    assert.equal(probeAgent(sd, 'w', '', fix.ctx, fix.env), 'working', 'the same stop again only records');
    assert.equal(probeAgent(sd, 'w', '', fix.ctx, fix.env), 'provider-error', 'and confirms on the next probe');
  } finally { fix.cleanup(); }
});

// Mutation captured: returning on quota before clearing the provider
// marks lets the same provider screen confirm right after the quota probe.
test('wait: a quota probe between two provider probes clears the provider record', { timeout: 30000 }, () => {
  const fix = makeFix('ha-wait-provider-quota-');
  try {
    fix.writeRoster(ROW('w', 'implementer', 'grok', 'grok-4.7', 'build'));
    fix.mode('idle');
    const sd = fix.ws;
    const stop = 'Error: Connection error.\n';
    fix.screenOf('w', stop);
    assert.equal(probeAgent(sd, 'w', '', fix.ctx, fix.env), 'working', 'first detection records');
    fix.screenOf('w', 'You have hit your usage limit\n');
    assert.equal(probeAgent(sd, 'w', '', fix.ctx, fix.env), 'quota');
    assert.equal(fix.waitRead('w', 'provider'), null, 'the quota probe dropped the record');
    fix.screenOf('w', stop);
    assert.equal(probeAgent(sd, 'w', '', fix.ctx, fix.env), 'working', 'the provider screen only records again');
  } finally { fix.cleanup(); }
});

// Provider error end-to-end: exit 14 in two probes — no
// settled_grace — with the lane/kind/model/cause JSON line and the
// friction warn.
test('wait: provider-error exits 14 with the lane, kind, model and cause', { timeout: 30000 }, () => {
  const fix = makeFix('ha-wait-provider-rc-');
  try {
    fix.writeRoster(ROW('w', 'implementer', 'grok', 'grok-4.7', 'build'));
    fix.mode('idle');
    fix.screenOf('w', 'Error: Retry failed after 3 attempts: Request timed out.\n');
    // Mutation captured: a wrong JSON key set or a missing waitRank 14
    // changes the line or the rc (this asserts both).
    const r = waitCmd(fix, ['w', '--timeout', '10000']);
    assert.equal(r.status, 14, r.stderr);
    const line = jsonLines(r.stdout)[0];
    assert.deepEqual(Object.keys(line), ['agent', 'status', 'report', 'lane', 'kind', 'model', 'cause']);
    assert.equal(line.agent, 'w');
    assert.equal(line.status, 'provider-error');
    assert.equal(line.report, '');
    assert.equal(line.lane, 'build');
    assert.equal(line.kind, 'grok');
    assert.equal(line.model, 'grok-4.7');
    assert.equal(line.cause, 'Error: Retry failed after 3 attempts: Request timed out.');
    const friction = fs.readFileSync(path.join(fix.ws, 'friction.log'), 'utf8');
    assert.match(friction, /warning\twait\tprovider error: agent 'w' lane=build kind=grok model=grok-4\.7 : Error: Retry failed after 3 attempts: Request timed out\./);
  } finally { fix.cleanup(); }
});

// Capacity: the confirmed capacity sends the exact continue prompt
// (one per provider_retry_delay); the worker report that lands in answer
// turns the wait into done with rc 0.
test('wait: capacity sends the continue prompt and the report settles done', { timeout: 30000 }, () => {
  const fix = makeFix('ha-wait-capacity-done-');
  try {
    fix.writeRoster(ROW('w', 'implementer', 'grok', 'grok-4.7', 'build'));
    fix.mode('idle');
    fix.screenOf('w', 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n');
    const reportPath = path.join(fix.ws, 'reports', 'w-report.md');
    fs.writeFileSync(path.join(fix.ws, 'last-report-w'), reportPath + '\n');
    // Mutation captured: never sending the prompt (or sending a different
    // text) leaves the screen at capacity and the wait exits 14 instead
    // of 0, and the log line below is absent.
    const env = { ...fix.env, HERDR_AGENTS_PROVIDER_RETRY_DELAY: '0', FAKE_REPORT_PATH: reportPath };
    const r = spawnSync(nodeBin(), [JS_ENTRY, 'wait', 'w', '--timeout', '10000'], { cwd: fix.repo, env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(jsonLines(r.stdout), [{ agent: 'w', status: 'done', report: reportPath }]);
    const tex = `The model provider was at capacity and your last request failed. Continue the task from where you stopped; do not redo finished steps. When finished, write your report to ${reportPath} and reply with only that path.`;
    assert.ok(fix.logLines().includes(`agent prompt w ${tex}`), fix.logLines().join('\n'));
    const friction = fs.readFileSync(path.join(fix.ws, 'friction.log'), 'utf8');
    assert.match(friction, /provider capacity: sent continue #1 of 3 to 'w': API Error: 529/);
  } finally { fix.cleanup(); }
});

// Capacity exhausted: with provider_retries=1 the single continue is
// sent and the still-at-capacity screen settles `capacity` with the
// retries count, rc 14.
test('wait: capacity exhausted at provider_retries=1 exits 14 with the retries', { timeout: 30000 }, () => {
  const fix = makeFix('ha-wait-capacity-exhausted-');
  try {
    fix.writeRoster(ROW('w', 'implementer', 'grok', 'grok-4.7', 'build'));
    fix.mode('idle');
    fix.screenOf('w', 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n');
    fs.writeFileSync(path.join(fix.ws, 'last-report-w'), path.join(fix.ws, 'reports', 'w-report.md') + '\n');
    // Mutation captured: ignoring provider_retries (always the default 3)
    // sends more continues and the wait times out (rc 9) instead of 14.
    const env = { ...fix.env, HERDR_AGENTS_PROVIDER_RETRY_DELAY: '0', HERDR_AGENTS_PROVIDER_RETRIES: '1' };
    const r = spawnSync(nodeBin(), [JS_ENTRY, 'wait', 'w', '--timeout', '10000'], { cwd: fix.repo, env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 14, r.stderr);
    const line = jsonLines(r.stdout)[0];
    assert.deepEqual(Object.keys(line), ['agent', 'status', 'report', 'lane', 'kind', 'model', 'cause', 'retries']);
    assert.equal(line.status, 'capacity');
    assert.equal(line.retries, 1);
    assert.equal(line.lane, 'build');
    assert.equal(line.model, 'grok-4.7');
    assert.match(line.cause, /529/);
    // Exactly one continue was sent.
    assert.equal(fix.logLines().filter((l) => l.startsWith('agent prompt w ')).length, 1);
    const friction = fs.readFileSync(path.join(fix.ws, 'friction.log'), 'utf8');
    assert.match(friction, /provider capacity: sent continue #1 of 1 to 'w'/);
    assert.match(friction, /provider capacity: agent 'w' lane=build kind=grok model=grok-4\.7 : /);
  } finally { fix.cleanup(); }
});

// Quota still wins over a provider stop on the same screen: the
// quota check runs first and the provider stop is never reported.
test('wait: quota wins over a provider stop on the same screen', { timeout: 30000 }, () => {
  const fix = makeFix('ha-wait-quota-over-provider-');
  try {
    fix.writeRoster(ROW('w', 'implementer', 'grok', 'grok-4.7', 'build'));
    fix.mode('idle');
    fix.screenOf('w', 'Individual quota reached\nError: Connection error.\n');
    // Mutation captured: swapping the quota/provider order reports
    // provider-error (rc 14) instead of quota (rc 11).
    const r = waitCmd(fix, ['w', '--timeout', '2000']);
    assert.equal(r.status, 11, r.stderr);
    const line = jsonLines(r.stdout)[0];
    assert.equal(line.status, 'quota');
    assert.match(line.match, /Individual quota reached/);
  } finally { fix.cleanup(); }
});

// The rank order 11 > 14 > 7 in a multi-agent wait: quota beats
// provider-error, provider-error beats blocked, in any argument order.
test('wait: the rank order 11 > 14 > 7 with quota, provider-error and blocked', { timeout: 30000 }, () => {
  const fix = makeFix('ha-wait-rank-14-');
  try {
    fix.writeRoster(
      ROW('blocked1', 'tasker', 'grok', '', 'build'),
      ROW('prov', 'implementer', 'grok', 'grok-4.7', 'build'),
      ROW('quota1', 'researcher', 'grok', 'grok-4.7', 'build'),
    );
    fix.modeOf('blocked1', 'blocked');
    fix.waitFile('blocked1', 'blocked', ''); // the second blocked probe is due
    fix.modeOf('prov', 'idle');
    fix.screenOf('prov', 'Error: Connection error.\n');
    fix.modeOf('quota1', 'idle');
    fix.screenOf('quota1', 'hit your usage limit\n');
    // Mutation captured: a 14 that ranks below 7 returns 7 instead of 14
    // in the prov+blocked1 waits below.
    for (const args of [['quota1', 'prov', 'blocked1'], ['prov', 'blocked1', 'quota1'], ['blocked1', 'prov', 'quota1']]) {
      const r = waitCmd(fix, [...args, '--timeout', '10000']);
      assert.equal(r.status, 11, `rc for ${args.join(' ')}: ${r.stderr}`);
      const byAgent = Object.fromEntries(jsonLines(r.stdout).map((l) => [l.agent, l.status]));
      assert.deepEqual(byAgent, { blocked1: 'blocked', prov: 'provider-error', quota1: 'quota' });
    }
    for (const args of [['prov', 'blocked1'], ['blocked1', 'prov']]) {
      const r = waitCmd(fix, [...args, '--timeout', '10000']);
      assert.equal(r.status, 14, `rc for ${args.join(' ')}: ${r.stderr}`);
      const byAgent = Object.fromEntries(jsonLines(r.stdout).map((l) => [l.agent, l.status]));
      assert.deepEqual(byAgent, { blocked1: 'blocked', prov: 'provider-error' });
      const p = jsonLines(r.stdout).find((l) => l.agent === 'prov');
      assert.equal(p.cause, 'Error: Connection error.');
    }
  } finally { fix.cleanup(); }
});

// A stale not-received marker (window over, no prompt in the input box)
// ends the wait at 15 on the first probe: the exact JSON line, the
// read-the-pane warning and the friction entry.
test('wait: a stale not-received marker exits 15 with the line and the read-the-pane warning', { timeout: 30000 }, () => {
  const fix = makeFix('ha-wait-notreceived-rc-');
  try {
    fix.writeRoster(ROW('w', 'implementer', 'grok', 'grok-4.7', 'build'));
    fix.modeOf('w', 'idle');
    fix.screenOf('w', 'Welcome to the worker\n');
    fix.waitFile('w', 'not-received', `${Math.floor(Date.now() / 1000) - 120}\n`);
    // Mutation captured: a not-received wait settling on settled-no-report
    // (rc 6) or running to the timeout (rc 9) changes the rc and the JSON
    // line below.
    const r = waitCmd(fix, ['w', '--timeout', '10000']);
    assert.equal(r.status, 15, r.stderr);
    const line = jsonLines(r.stdout)[0];
    assert.deepEqual(Object.keys(line), ['agent', 'status', 'report']);
    assert.equal(line.agent, 'w');
    assert.equal(line.status, 'not-received');
    assert.match(r.stderr, /prompt to 'w' never reached it: read the pane \(herdr agent read w --source visible\), then dispatch again/);
    const friction = fs.readFileSync(path.join(fix.ws, 'friction.log'), 'utf8');
    assert.match(friction, /warning\twait\tprompt to 'w' never reached it/);
  } finally { fix.cleanup(); }
});

// The rank order with a not-received agent: 4 (unavailable) >
// 11 (quota) > 14 (provider-error) > 15 (not-received) > 7 (blocked), in
// any argument order.
test('wait: the rank order 4 > 11 > 14 > 15 > 7 with a not-received agent', { timeout: 30000 }, () => {
  const fix = makeFix('ha-wait-rank-15-');
  try {
    fix.writeRoster(
      ROW('stuck', 'implementer', 'grok', 'grok-4.7', 'build'),
      ROW('quota1', 'researcher', 'grok', 'grok-4.7', 'build'),
      ROW('prov', 'implementer', 'grok', 'grok-4.7', 'build'),
      ROW('lost', 'tasker', 'grok', '', 'build'),
      ROW('blocked1', 'tasker', 'grok', '', 'build'),
    );
    fix.modeOf('stuck', 'denied');
    fix.modeOf('quota1', 'idle');
    fix.screenOf('quota1', 'hit your usage limit\n');
    fix.modeOf('prov', 'idle');
    fix.screenOf('prov', 'Error: Connection error.\n');
    fix.modeOf('lost', 'idle');
    fix.screenOf('lost', 'Welcome to the worker\n');
    fix.waitFile('lost', 'not-received', `${Math.floor(Date.now() / 1000) - 120}\n`);
    fix.modeOf('blocked1', 'blocked');
    fix.waitFile('blocked1', 'blocked', ''); // the second blocked probe is due
    // Mutation captured: a 15 ranked at or above 14 (or at or below 7)
    // changes the combined rc in either argument order below.
    for (const args of [['lost', 'blocked1'], ['blocked1', 'lost']]) {
      const r = waitCmd(fix, [...args, '--timeout', '10000']);
      assert.equal(r.status, 15, `rc for ${args.join(' ')}: ${r.stderr}`);
    }
    for (const args of [['prov', 'lost'], ['lost', 'prov']]) {
      const r = waitCmd(fix, [...args, '--timeout', '10000']);
      assert.equal(r.status, 14, `rc for ${args.join(' ')}: ${r.stderr}`);
    }
    for (const args of [['quota1', 'lost'], ['lost', 'quota1']]) {
      const r = waitCmd(fix, [...args, '--timeout', '10000']);
      assert.equal(r.status, 11, `rc for ${args.join(' ')}: ${r.stderr}`);
    }
    for (const args of [['stuck', 'lost'], ['lost', 'stuck']]) {
      const r = waitCmd(fix, [...args, '--timeout', '10000']);
      assert.equal(r.status, 4, `rc for ${args.join(' ')}: ${r.stderr}`);
    }
  } finally { fix.cleanup(); }
});

// The happy path: the retry Enter starts the worker (the CLI that was
// still opening finally accepts it) and the wait settles done like any
// other wait — one Enter, no resend, in a few probes, not a timeout.
test('wait: the retry Enter unblocks the worker and the wait settles done', { timeout: 30000 }, () => {
  const fix = makeFix('ha-wait-retrydone-');
  try {
    fix.writeRoster(ROW('w', 'implementer', 'grok', 'grok-4.7', 'build'));
    fix.modeOf('w', 'idle');
    fix.screenOf('w', 'Welcome to the worker\n> Read the file /x/brief.md in full and execute it.\n');
    const reportPath = path.join(fix.ws, 'reports', 'w-report.md');
    fs.writeFileSync(path.join(fix.ws, 'last-report-w'), reportPath + '\n');
    fix.waitFile('w', 'not-received', `${Math.floor(Date.now() / 1000) - 120}\n`);
    // Mutation captured: never retrying the Enter (or retrying after the
    // worker started) leaves the wait running to the timeout (rc 9) or
    // sends more than one key.
    const env = { ...fix.env, FAKE_SENDKEYS_WORK: path.join(fix.root, 'sendkeys-work'), FAKE_REPORT_PATH: reportPath };
    fs.writeFileSync(env.FAKE_SENDKEYS_WORK, '1\n');
    const r = spawnSync(nodeBin(), [JS_ENTRY, 'wait', 'w', '--timeout', '10000'], { cwd: fix.repo, env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(jsonLines(r.stdout), [{ agent: 'w', status: 'done', report: reportPath }]);
    assert.deepEqual(fix.logLines().filter((l) => l.startsWith('agent send-keys')),
      ['agent send-keys w enter'], 'exactly one retry Enter');
    assert.match(r.stderr, /prompt to 'w' was still in its input box; sent Enter again \(1 of 3\)/);
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

// ---------- S5 item 2: a decision question is never auto-answered ----------

// The question footer turns the confirmed blocked probe into `question`
// with the text, even with auto_approve=on: no key is sent, the .question
// file holds the text, rc 7 and the friction entry say nobody answers it
// automatically.
test('wait: a codex question screen reports question, no key, even with auto_approve=on', { timeout: 30000 }, () => {
  const fix = makeFix('ha-wait-question-');
  try {
    fix.writeRoster(ROW('q', 'implementer', 'codex'));
    fix.mode('blocked');
    fix.screen('  1. Use the local cache\n  2. Fetch from remote\n\nEnter to submit answer, esc to cancel\n');
    const sd = fix.ws;
    const env = { ...fix.env, HERDR_AGENTS_AUTO_APPROVE: 'on' };
    assert.equal(probeAgent(sd, 'q', '', fix.ctx, env), 'working', 'the first blocked probe only records');
    // Mutation captured: answering the question with auto_approve (sending
    // the default key) returns 'working' here and the fake log gains a
    // send-keys line; this asserts 'question' and a zero-key log.
    assert.equal(probeAgent(sd, 'q', '', fix.ctx, env), 'question', 'the confirmed probe detects the question');
    assert.equal(fix.waitRead('q', 'question'),
      '  1. Use the local cache\n  2. Fetch from remote\nEnter to submit answer, esc to cancel\n');
    assert.equal(fix.waitRead('q', 'approvals'), null, 'no auto-approval counter');
    assert.equal(fix.logLines().filter((l) => l.startsWith('agent send-keys')).length, 0, 'zero send-keys');
    // End to end: rc 7, the JSON line carries the text (no other keys),
    // and the friction entry says nobody answers it automatically.
    const r = cmd(fix, ['wait', 'q', '--timeout', '10000'], { HERDR_AGENTS_AUTO_APPROVE: 'on' });
    assert.equal(r.status, 7, r.stderr);
    const line = jsonLines(r.stdout)[0];
    assert.deepEqual(Object.keys(line), ['agent', 'status', 'report', 'question']);
    assert.equal(line.agent, 'q');
    assert.equal(line.status, 'question');
    assert.equal(line.report, '');
    assert.equal(line.question, '  1. Use the local cache\n  2. Fetch from remote\nEnter to submit answer, esc to cancel');
    assert.equal(fix.logLines().filter((l) => l.startsWith('agent send-keys')).length, 0, 'still zero send-keys across the whole wait');
    const friction = fs.readFileSync(path.join(fix.ws, 'friction.log'), 'utf8');
    assert.match(friction, /warning\twait\tagent 'q' asked a question; nobody answers it automatically\. Ask the user, then answer with herdr agent send-keys\/prompt, or release the worker\./);
  } finally { fix.cleanup(); }
});

// The codex approval screens from the decisions ("allow command?" / "press
// enter to confirm") keep today's behavior: the default key is sent and the
// wait continues.
test('wait: a codex approval screen keeps the auto-approve key (behavior untouched)', { timeout: 30000 }, () => {
  const fix = makeFix('ha-wait-question-approval-');
  try {
    fix.writeRoster(ROW('a', 'implementer', 'codex'));
    fix.mode('blocked');
    fix.screen('Allow command? git push\n\n❯ 1. Yes, proceed\n  2. No\n\nPress enter to confirm or esc to cancel\n');
    const sd = fix.ws;
    const env = { ...fix.env, HERDR_AGENTS_AUTO_APPROVE: 'on' };
    assert.equal(probeAgent(sd, 'a', '', fix.ctx, env), 'working', 'the first blocked probe only records');
    // Mutation captured: treating this approval as a question returns
    // 'question' and sends no key; this asserts the key went out.
    assert.equal(probeAgent(sd, 'a', '', fix.ctx, env), 'working', 'the approval is auto-answered as today');
    assert.ok(fix.logLines().includes('agent send-keys a y'), 'the codex default key is sent');
    assert.equal(fix.waitRead('a', 'approvals'), '1\n');
    assert.equal(fix.waitRead('a', 'question'), null, 'no .question file for an approval');
  } finally { fix.cleanup(); }
});

// ---------- S5 item 11a: one friction line for a stuck working agent ----------

// A working agent whose normalized screen (digits → #, progress glyphs →
// *) does not change for stuck_warn_minutes gets exactly one friction line;
// the status stays working, nothing is sent; a changed screen re-arms; 0
// disables the check.
test('wait: a still screen (counters aside) warns once after stuck_warn_minutes', { timeout: 30000 }, () => {
  const fix = makeFix('ha-wait-stuck-');
  try {
    fix.writeRoster(ROW('s', 'implementer'));
    fix.mode('working');
    // The visible counters change between the runs below; the normalized
    // screen (digits → #, progress glyphs → *) does not. Every wait run
    // probes once and then times out (a working agent never settles), so
    // the friction log of the runs shows exactly what the wait warned.
    fix.screen('Running tests 42% ◐ 3.1s\n');
    const sd = fix.ws;
    const env = { ...fix.env, HERDR_AGENTS_STUCK_WARN_MINUTES: '1' };
    const norm = (s) => s.replace(/\r\n/g, '\n').replace(/[0-9]+/g, '#').replace(/[\u2800-\u28ff◐◑◒◓]/g, '*');
    const H_RUN = String(cksumField(norm('Running tests 42% ◐ 3.1s\n')));
    const H_BUILD = String(cksumField(norm('Building app 12% ◒ 0.9s\n')));
    const frictionNow = () => {
      try { return fs.readFileSync(path.join(fix.ws, 'friction.log'), 'utf8'); } catch { return ''; }
    };
    const warnRe = /agent 's' has shown the same screen \(apart from counters\)/g;
    // Seed the bookkeeping as if this screen (counters aside) has been up
    // for 70 s: hash equal, since in the past.
    fix.waitFile('s', 'stuck-hash', `${H_RUN}\n`);
    fix.waitFile('s', 'stuck-since', `${Math.floor(Date.now() / 1000) - 70}\n`);
    // Mutation captured: warning on every probe (instead of once) adds a
    // second friction line on run 2; never warning (or a broken time
    // comparison) leaves the log empty on run 1.
    const r1 = cmd(fix, ['wait', 's', '--timeout', '1000'], env);
    assert.equal(r1.status, 9, 'the working agent times out: nothing was sent');
    assert.match(r1.stderr, /agent 's' has shown the same screen \(apart from counters\) for 1 min while working; it may be stuck in one tool call\. Inspect: herdr agent read s --source recent-unwrapped --lines 60/);
    assert.equal(fix.waitRead('s', 'stuck-warned'), '', '.stuck-warned is set');
    assert.equal((frictionNow().match(warnRe) ?? []).length, 1, 'exactly one warning');
    assert.match(frictionNow(), /warning\twait\tagent 's' has shown the same screen \(apart from counters\)/);
    // A further run with the same normalized screen (new counters) warns
    // nothing new and the status stays working.
    fix.screen('Running tests 57% ◑ 8.4s\n');
    const r2 = cmd(fix, ['wait', 's', '--timeout', '1000'], env);
    assert.equal(r2.status, 9);
    assert.equal((frictionNow().match(warnRe) ?? []).length, 1, 'still one warning');
    // A changed screen (apart from counters) re-arms: hash and since are
    // rewritten and .stuck-warned is cleared.
    fix.screen('Building app 12% ◒ 0.9s\n');
    const r3 = cmd(fix, ['wait', 's', '--timeout', '1000'], env);
    assert.equal(r3.status, 9);
    assert.equal((frictionNow().match(warnRe) ?? []).length, 1, 'movement does not warn');
    assert.equal(fix.waitRead('s', 'stuck-hash'), `${H_BUILD}\n`, 'the new hash is recorded');
    assert.equal(fix.waitRead('s', 'stuck-warned'), null, 'the flag is cleared on movement');
    // Back to the first screen: the run re-records it...
    fix.screen('Running tests 42% ◐ 3.1s\n');
    const r4 = cmd(fix, ['wait', 's', '--timeout', '1000'], env);
    assert.equal(r4.status, 9);
    assert.equal((frictionNow().match(warnRe) ?? []).length, 1);
    // ...and, aged into the past, the same screen warns again.
    fix.waitFile('s', 'stuck-since', `${Math.floor(Date.now() / 1000) - 130}\n`);
    const r5 = cmd(fix, ['wait', 's', '--timeout', '1000'], env);
    assert.equal(r5.status, 9);
    assert.equal((frictionNow().match(warnRe) ?? []).length, 2, 'a re-armed screen warns again');
    assert.match(frictionNow(), /for 2 min while working/);
    // 0 disables the check entirely (no further warning).
    fix.waitFile('s', 'stuck-since', `${Math.floor(Date.now() / 1000) - 3600}\n`);
    const r6 = cmd(fix, ['wait', 's', '--timeout', '1000'], { ...fix.env, HERDR_AGENTS_STUCK_WARN_MINUTES: '0' });
    assert.equal(r6.status, 9);
    assert.equal((frictionNow().match(warnRe) ?? []).length, 2, '0 never warns');
    assert.ok(!r6.stderr.includes('has shown the same screen'));
    assert.equal(fix.logLines().filter((l) => l.startsWith('agent send-keys') || l.startsWith('agent prompt')).length, 0, 'nothing was ever sent');
  } finally { fix.cleanup(); }
});

// Mutation captured: reading the visible screen again for the stuck check
// doubles the herdr calls of every working probe.
test('wait: a working probe reads the screen once', { timeout: 30000 }, () => {
  const fix = makeFix('ha-wait-one-read-');
  try {
    fix.writeRoster(ROW('w', 'implementer', 'grok', 'grok-4.7', 'build'));
    fix.mode('working');
    fix.screenOf('w', '⠋ Working (12s)\n');
    probeAgent(fix.ws, 'w', '', fix.ctx, fix.env);
    const reads = fix.logLines().filter((l) => l.startsWith('agent read w'));
    assert.equal(reads.length, 1, reads.join('\n'));
  } finally { fix.cleanup(); }
});

// ---------- a done report that marks items partial ----------

// The report contract fixes a per-item state marker; a done report that
// still marks `partial` items is not a pass: the JSON line carries
// the count after `report`, one warn tells the orchestrator to read them
// before commit/push/release, and the wait still settles rc 0.
test('wait: a done report with partial items marks the JSON line and warns once', { timeout: 30000 }, () => {
  const fix = makeFix('ha-wait-partial-');
  try {
    fix.writeRoster(ROW('rev', 'reviewer'));
    const body = [
      '# Report', '',
      '| item | state |',
      '| --- | --- |',
      '| read the brief | [done] |',
      '| fact A | [partial] |',
      '| fact B | [partial] |',
      '',
    ].join('\n');
    const p = fix.report('rev', body);
    const warnLine = "report of 'rev' marks 2 item(s) partial: a partial item is not a pass; read them before commit, push or release";
    // Mutation captured: not scanning the done report (or counting
    // occurrences) drops the partial key, the rc-0 line shape below or the
    // warn count.
    const r = waitCmd(fix, ['rev', '--timeout', '10000']);
    assert.equal(r.status, 0, r.stderr);
    const line = jsonLines(r.stdout)[0];
    assert.deepEqual(Object.keys(line), ['agent', 'status', 'report', 'partial'],
      'the partial key sits right after report');
    assert.deepEqual(line, { agent: 'rev', status: 'done', report: p, partial: 2 });
    assert.equal(r.stderr.split(`herdr-agents: warning: ${warnLine}`).length - 1, 1,
      `the exact warn once on stderr: ${r.stderr}`);
    const friction = fs.readFileSync(path.join(fix.ws, 'friction.log'), 'utf8');
    assert.match(friction, /warning\twait\t/);
    assert.ok(friction.includes(`warning\twait\t${warnLine}`), 'the warn lands in the friction log as a wait entry');
  } finally { fix.cleanup(); }
});

// A done report without `partial` settles exactly as before: the JSON line
// is byte-identical to the one of today (no partial key) and nothing about
// partial is printed.
test('wait: a clean done report keeps the exact line of today', { timeout: 30000 }, () => {
  const fix = makeFix('ha-wait-clean-');
  try {
    fix.writeRoster(ROW('w', 'implementer'));
    const p = fix.report('w', '# Report\n\ndone.\n');
    // Mutation captured: the partial key present with 0 (or any reordering
    // of the keys) breaks the byte-identical stdout below.
    const r = waitCmd(fix, ['w', '--timeout', '10000']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `{"agent":"w","status":"done","report":"${p}"}\n`, 'byte-identical to the line of today');
    assert.ok(!r.stderr.includes('partial'), 'no partial warn for a clean report');
  } finally { fix.cleanup(); }
});

// In a multi-agent wait the count is per agent: only the report that marks
// items partial gets the key and the warn; the clean one keeps its exact
// line, and the wait still settles rc 0.
test('wait: partial is per agent in a multi-agent wait', { timeout: 30000 }, () => {
  const fix = makeFix('ha-wait-partial-multi-');
  try {
    fix.writeRoster(ROW('a1', 'implementer'), ROW('a2', 'reviewer'));
    const p1 = fix.report('a1', '# Report\n\n| item | state |\n| --- | --- |\n| fact A | [partial] |\n');
    const p2 = fix.report('a2', '# Report\n\ndone.\n');
    // Mutation captured: a shared (not per-agent) count, or a warn for the
    // clean report, breaks the key sets or the warn asserts below.
    const r = waitCmd(fix, ['a1', 'a2', '--timeout', '10000']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(jsonLines(r.stdout), [
      { agent: 'a1', status: 'done', report: p1, partial: 1 },
      { agent: 'a2', status: 'done', report: p2 },
    ]);
    assert.match(r.stderr, /report of 'a1' marks 1 item\(s\) partial: a partial item is not a pass; read them before commit, push or release/);
    assert.ok(!r.stderr.includes("report of 'a2'"), 'no warn for the clean report');
  } finally { fix.cleanup(); }
});
