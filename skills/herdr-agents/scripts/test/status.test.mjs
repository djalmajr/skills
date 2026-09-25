// The `status` command: the provider-error / capacity JSON
// line with the cause, rc 14 ranked below 11 and above 0 (and below 4,
// per the global wait rank), the quota winning over the provider on the
// same screen, the not-received marker reported read-only (rc 15, no key,
// untouched while the agent is working or blocked), and the old TSV /
// rc 0 behavior untouched. One probe only:
// the command must not leave the wait double-confirm state behind. The
// status runs through the real entry (child process) so stdout and the
// exit code are observable; a fake `herdr` (writeFakeCli) is the only
// herdr the code sees.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeFakeCli } from './fakes.mjs';
import { nodeBin } from './parity.mjs';
import { loadConfig } from '../lib/config.mjs';

const SCRIPTS = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const JS_ENTRY = path.join(SCRIPTS, 'herdr-agents.mjs');

// ---------- fake herdr (Node) ----------

// `agent get` per target (mode-<t> file) else the global mode file
// (denied → an unqueryable error, missing → agent_not_found, else the mode
// as agent_status; the state_change_seq is read from the FAKE_SEQ file
// when it exists); `agent read` prints screen-<t> (or the global screen
// file). Every call is logged as one "$*" line (FAKE_LOG).
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
  let seqVal = '';
  try { seqVal = fs.readFileSync(process.env.FAKE_SEQ, 'utf8').trim(); } catch {}
  const seqJson = seqVal !== '' ? ', "state_change_seq": ' + seqVal + '' : '';
  process.stdout.write('{"result":{"agent":{"name":"' + t + '","agent_status":"' + m + '"' + seqJson + '}}}\\n');
} else if (cmd === 'agent read') {
  process.stdout.write(screenOf(t));
} else if (cmd === 'agent list') {
  try { process.stdout.write(fs.readFileSync(process.env.HA_LIST, 'utf8')); }
  catch { process.stdout.write('{"result":{"agents":[]}}\\n'); }
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
    FAKE_MODE: path.join(root, 'mode'),
    FAKE_MODE_DIR: modeDir,
    FAKE_SCREEN: path.join(root, 'screen'),
    FAKE_SCREEN_DIR: screenDir,
    FAKE_LOG: path.join(root, 'herdr.log'),
    FAKE_SEQ: path.join(root, 'seq'),
    HA_LIST: path.join(root, 'list.json'),
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  };
  fs.writeFileSync(env.FAKE_MODE, 'working\n');
  fs.writeFileSync(env.FAKE_SCREEN, '');
  const H12 = '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\tmodel\tapprovals\troles\tlane\n';
  const fix = {
    root, repo, state, ws, env, ctx: loadConfig(env, repo),
    mode(m) { fs.writeFileSync(env.FAKE_MODE, `${m}\n`); },
    modeOf(agent, m) { fs.writeFileSync(path.join(modeDir, `mode-${agent}`), `${m}\n`); },
    liveList(agents) { fs.writeFileSync(env.HA_LIST, JSON.stringify({ result: { agents } }) + '\n'); },
    screen(s) { fs.writeFileSync(env.FAKE_SCREEN, s); },
    screenOf(agent, s) { fs.writeFileSync(path.join(screenDir, `screen-${agent}`), s); },
    writeRoster(...rows) { fs.writeFileSync(path.join(ws, 'agents.tsv'), H12 + rows.join('\n') + '\n'); },
    waitExists(agent, name) { return fs.existsSync(path.join(ws, 'wait', `${agent}.${name}`)); },
    logLines() {
      try { return fs.readFileSync(env.FAKE_LOG, 'utf8').split('\n').filter((l) => l !== ''); } catch { return []; }
    },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
  fix.writeRoster();
  return fix;
}

// Row with every 12-column field (pane p-<name>, created 1).
const ROW = (name, role, kind = 'grok', model = '', lane = '') =>
  `${name}\tp-${name}\t${kind}\t${role}\txai\t1\t/tmp/work\tnow\t${model}\tfull\t${role}\t${lane}`;

function cmd(fix, args) {
  return spawnSync(nodeBin(), [JS_ENTRY, ...args], { cwd: fix.repo, env: fix.env, encoding: 'utf8', timeout: 60_000 });
}

// ---------- the provider stop in the status ----------

test('status: a capacity worker prints the JSON line with the cause, rc 14', { timeout: 30000 }, () => {
  const fix = makeFix('ha-status-capacity-');
  try {
    fix.writeRoster(ROW('w', 'implementer', 'grok', 'grok-4.7', 'build'));
    fix.mode('idle');
    fix.screenOf('w', 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n');
    // Mutation captured: a missing provider branch (or a wrong status in
    // the JSON) leaves the TSV line and rc 0.
    const r = cmd(fix, ['status', 'w']);
    assert.equal(r.status, 14, r.stderr);
    const line = JSON.parse(r.stdout.trim());
    assert.deepEqual(Object.keys(line), ['agent', 'status', 'report', 'cause']);
    assert.equal(line.agent, 'w');
    assert.equal(line.status, 'capacity');
    assert.equal(line.report, '');
    assert.match(line.cause, /529.*Overloaded/);
    // One probe only: no wait double-confirm state is left behind.
    assert.equal(fix.waitExists('w', 'provider'), false);
    assert.equal(fix.waitExists('w', 'provider-cause'), false);
    assert.equal(fix.waitExists('w', 'capacity-retries'), false);
  } finally { fix.cleanup(); }
});

test('status: a provider-error worker prints the JSON line, rc 14', { timeout: 30000 }, () => {
  const fix = makeFix('ha-status-provider-');
  try {
    fix.writeRoster(ROW('w', 'implementer', 'grok', 'grok-4.7', 'build'));
    fix.mode('idle');
    fix.screenOf('w', 'Error: Retry failed after 3 attempts: Request timed out.\n');
    const r = cmd(fix, ['status', 'w']);
    assert.equal(r.status, 14, r.stderr);
    const line = JSON.parse(r.stdout.trim());
    assert.equal(line.status, 'provider-error');
    assert.equal(line.cause, 'Error: Retry failed after 3 attempts: Request timed out.');
  } finally { fix.cleanup(); }
});

test('status: the quota wins over the provider stop on the same screen, rc 11', { timeout: 30000 }, () => {
  const fix = makeFix('ha-status-quota-over-provider-');
  try {
    fix.writeRoster(ROW('w', 'implementer', 'grok', 'grok-4.7', 'build'));
    fix.mode('idle');
    fix.screenOf('w', 'Individual quota reached\nError: Connection error.\n');
    // Mutation captured: swapping the quota/provider order reports the
    // provider stop (rc 14) instead of the quota (rc 11).
    const r = cmd(fix, ['status', 'w']);
    assert.equal(r.status, 11, r.stderr);
    const line = JSON.parse(r.stdout.trim());
    assert.equal(line.status, 'quota');
    assert.match(line.match, /Individual quota reached/);
    assert.ok(!('cause' in line), 'no provider keys on a quota line');
  } finally { fix.cleanup(); }
});

test('status: the rc rank 11 > 4 > 14 > 0 across agents', { timeout: 30000 }, () => {
  const fix = makeFix('ha-status-rank-');
  try {
    fix.writeRoster(
      ROW('prov', 'implementer', 'grok', 'grok-4.7', 'build'),
      ROW('quota1', 'researcher', 'grok', 'grok-4.7', 'build'),
      ROW('stuck', 'reviewer', 'codex', 'gpt-5', 'review'),
      ROW('plain', 'scouter', 'grok', '', 'explore'),
    );
    fix.modeOf('prov', 'idle');
    fix.screenOf('prov', 'Error: Connection error.\n');
    fix.modeOf('quota1', 'idle');
    fix.screenOf('quota1', 'hit your usage limit\n');
    fix.modeOf('stuck', 'denied');
    fix.modeOf('plain', 'idle');
    // Mutation captured: a 14 ranked at or above 4 (or at or above 11)
    // changes the combined rc below.
    const r4 = cmd(fix, ['status', 'stuck', 'prov']);
    assert.equal(r4.status, 4, r4.stderr);
    const r11 = cmd(fix, ['status', 'quota1', 'prov']);
    assert.equal(r11.status, 11, r11.stderr);
    const r14 = cmd(fix, ['status', 'prov', 'plain']);
    assert.equal(r14.status, 14, r14.stderr);
    const lines = r14.stdout.trim().split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
    assert.equal(lines.length, 1, 'only the provider stop is JSON');
    assert.equal(lines[0].agent, 'prov');
    assert.equal(lines[0].status, 'provider-error');
    // The plain agent keeps the old TSV line (behavior untouched).
    assert.match(r14.stdout, /plain\tno-report-yet\t/m);
    const r0 = cmd(fix, ['status', 'plain']);
    assert.equal(r0.status, 0, r0.stderr);
    assert.equal(r0.stdout, 'plain\tno-report-yet\t\n', 'the exact TSV line, trailing report field empty');
  } finally { fix.cleanup(); }
});

// ---------- S5 item 2: a blocked worker on a question screen ----------

// A blocked worker whose visible screen is a decision question is reported
// as `question` with the text (JSON line, rc 7) instead of the blocked TSV
// line.
test('status: a blocked worker on a question screen reports question, rc 7', { timeout: 30000 }, () => {
  const fix = makeFix('ha-status-question-');
  try {
    fix.writeRoster(ROW('w', 'implementer', 'codex'));
    fix.mode('blocked');
    fix.screenOf('w', '  1. Use the local cache\n  2. Fetch from remote\n\nEnter to submit answer, esc to cancel\n');
    // Mutation captured: reporting this worker as `blocked` (the old TSV
    // line, rc 0) fails the JSON/rc asserts below.
    const r = cmd(fix, ['status', 'w']);
    assert.equal(r.status, 7, r.stderr);
    const line = JSON.parse(r.stdout.trim());
    assert.deepEqual(Object.keys(line), ['agent', 'status', 'report', 'question']);
    assert.equal(line.agent, 'w');
    assert.equal(line.status, 'question');
    assert.equal(line.report, '');
    assert.equal(line.question, '  1. Use the local cache\n  2. Fetch from remote\nEnter to submit answer, esc to cancel');
  } finally { fix.cleanup(); }
});

// The old behavior for a blocked worker on an approval screen (the codex
// "allow command?" counterexample): the TSV line and rc 0 are untouched.
test('status: a blocked worker on an approval screen keeps the old TSV line', { timeout: 30000 }, () => {
  const fix = makeFix('ha-status-blocked-approval-');
  try {
    fix.writeRoster(ROW('w', 'implementer', 'codex'));
    fix.mode('blocked');
    fix.screenOf('w', 'Allow command? rm -rf build\n\nPress enter to confirm or esc to cancel\n');
    const r = cmd(fix, ['status', 'w']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'w\tblocked\t\n', 'the exact old TSV line');
  } finally { fix.cleanup(); }
});

// ---------- a not-received marker: read-only, rc 15, no key ----------

// A dispatch that ended not-received recorded the moment, and the agent is
// not working or blocked: the status is not-received (rc 15, through the
// wait rank) and the command sends nothing — it only reads the marker (the
// wait is the one that retries the Enter).
test('status: a not-received marker reports not-received, rc 15, no key sent', { timeout: 30000 }, () => {
  const fix = makeFix('ha-status-notreceived-');
  try {
    fix.writeRoster(ROW('w', 'implementer', 'grok', 'grok-4.7', 'build'));
    fix.modeOf('w', 'idle');
    fix.screenOf('w', 'Welcome to the worker\n');
    fs.writeFileSync(path.join(fix.ws, 'wait', 'w.not-received'), `${Math.floor(Date.now() / 1000) - 120}\n`);
    // Mutation captured: the marker branch missing (the old no-report-yet
    // TSV line, rc 0) or a keypress inside the status fails the stdout/rc
    // /log asserts below (this command's fake herdr refuses send-keys).
    const r = cmd(fix, ['status', 'w']);
    assert.equal(r.status, 15, r.stderr);
    assert.equal(r.stdout, 'w\tnot-received\t\n', 'the TSV line with the new state');
    // The same seq as the marker (the agent did nothing in the meantime)
    // keeps not-received.
    fs.writeFileSync(path.join(fix.ws, 'wait', 'w.not-received'), `${Math.floor(Date.now() / 1000) - 120} 7\n`);
    // Mutation captured: treating "a seq is present" as "it changed" drops
    // the not-received report here.
    fs.writeFileSync(fix.env.FAKE_SEQ, '7\n');
    const r2 = cmd(fix, ['status', 'w']);
    assert.equal(r2.status, 15, r2.stderr);
    assert.equal(r2.stdout, 'w\tnot-received\t\n', 'the same seq keeps not-received');
    assert.deepEqual(fix.logLines().filter((l) => l.startsWith('agent send-keys')), [], 'read-only: no key');
  } finally { fix.cleanup(); }
});

// The marker changes nothing while the agent is working or blocked: the
// old TSV lines and rc 0 hold, and no key is sent.
test('status: the marker changes nothing while the agent is working or blocked', { timeout: 30000 }, () => {
  const fix = makeFix('ha-status-nr-working-');
  try {
    fix.writeRoster(ROW('w', 'implementer', 'grok', 'grok-4.7', 'build'));
    fs.writeFileSync(path.join(fix.ws, 'wait', 'w.not-received'), `${Math.floor(Date.now() / 1000) - 120}\n`);
    // Mutation captured: the marker overriding a working or a blocked
    // agent reports not-received (rc 15) on either line below.
    fix.modeOf('w', 'working');
    const rw = cmd(fix, ['status', 'w']);
    assert.equal(rw.status, 0, rw.stderr);
    assert.equal(rw.stdout, 'w\tworking\t\n', 'working is untouched');
    fix.modeOf('w', 'blocked');
    fix.screenOf('w', 'Allow command? git push\n\nPress enter to confirm or esc to cancel\n');
    const rb = cmd(fix, ['status', 'w']);
    assert.equal(rb.status, 0, rb.stderr);
    assert.equal(rb.stdout, 'w\tblocked\t\n', 'blocked is untouched');
    assert.deepEqual(fix.logLines().filter((l) => l.startsWith('agent send-keys')), [], 'read-only across both');
  } finally { fix.cleanup(); }
});

// A state change since the marker (the state_change_seq moved) makes the
// marker stale: the normal status holds (no-report-yet here) and the
// command keeps the marker — it only reads it, the wait is the one that
// drops it.
test('status: a state change since the marker is the normal status, marker kept', { timeout: 30000 }, () => {
  const fix = makeFix('ha-status-seqchanged-');
  try {
    fix.writeRoster(ROW('w', 'implementer', 'grok', 'grok-4.7', 'build'));
    fix.modeOf('w', 'idle');
    fix.screenOf('w', 'Welcome to the worker\n');
    const now = Math.floor(Date.now() / 1000);
    fs.writeFileSync(path.join(fix.ws, 'wait', 'w.not-received'), `${now - 120} 5\n`);
    // Mutation captured: reporting not-received on a moved seq (or deleting
    // the marker here) fails the TSV/rc/marker asserts below.
    fs.writeFileSync(fix.env.FAKE_SEQ, '7\n');
    const r = cmd(fix, ['status', 'w']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'w\tno-report-yet\t\n', 'the normal status holds');
    assert.equal(fs.readFileSync(path.join(fix.ws, 'wait', 'w.not-received'), 'utf8'),
      `${now - 120} 5\n`, 'the marker is kept');
    assert.deepEqual(fix.logLines().filter((l) => l.startsWith('agent send-keys')), [], 'read-only: no key');
  } finally { fix.cleanup(); }
});

// The rc rank with 15 in the order: 11 (quota) beats 15 (not-received),
// which beats 7 (question).
test('status: the rc rank 11 > 15 > 7 across agents', { timeout: 30000 }, () => {
  const fix = makeFix('ha-status-rank-15-');
  try {
    fix.writeRoster(
      ROW('quota1', 'researcher', 'grok', 'grok-4.7', 'build'),
      ROW('lost', 'tasker', 'grok', '', 'build'),
      ROW('quest1', 'tasker', 'claude', '', 'build'),
    );
    fix.modeOf('quota1', 'idle');
    fix.screenOf('quota1', 'hit your usage limit\n');
    fix.modeOf('lost', 'idle');
    fix.screenOf('lost', 'Welcome to the worker\n');
    fs.writeFileSync(path.join(fix.ws, 'wait', 'lost.not-received'), `${Math.floor(Date.now() / 1000) - 120}\n`);
    fix.modeOf('quest1', 'blocked');
    fix.screenOf('quest1', 'What would you like to do next?\n1. keep the marker\n2. drop it\nUse arrows to navigate, enter to select\n');
    // Mutation captured: a 15 ranked at or above 11 (or at or below 7 —
    // the question rc) changes the combined rc below.
    const r11 = cmd(fix, ['status', 'lost', 'quota1']);
    assert.equal(r11.status, 11, r11.stderr);
    const r15 = cmd(fix, ['status', 'lost', 'quest1']);
    assert.equal(r15.status, 15, r15.stderr);
    assert.match(r15.stdout, /lost\tnot-received\t/);
    // The question agent is reported as `question` with the text and wins
    // the rc when alone: 15 > 7 holds only in the combined rc above.
    const q = r15.stdout.trim().split('\n').map((l) => (l.startsWith('{') ? JSON.parse(l) : l)).find((l) => l !== null && typeof l === 'object' && l.agent === 'quest1');
    assert.equal(q.status, 'question');
    assert.match(q.question, /enter to select/);
    const r7 = cmd(fix, ['status', 'quest1']);
    assert.equal(r7.status, 7, r7.stderr);
  } finally { fix.cleanup(); }
});

// A roster line whose name is alive in ANOTHER pane: the line's own agent
// (the pane it recorded) exited; the name query answers with the other
// agent's state. Status and roster report the line as gone, not with the
// other agent's state.
const ROW_PANE = (name, pane, role = 'implementer') =>
  `${name}\t${pane}\tgrok\t${role}\txai\t1\t/tmp/work\tnow\t\tfull\t${role}\t`;

test('status: a line whose name is alive in another pane reports gone (and roster shows gone)', { timeout: 30000 }, () => {
  const fix = makeFix('ha-status-stalepane-');
  try {
    // The line recorded pane p-old; the live agent 'w' is in p-new (the
    // name query of `agent get w` answers with its idle state).
    fix.writeRoster(ROW_PANE('w', 'p-old'));
    fix.modeOf('w', 'idle');
    fix.liveList([{ name: 'w', pane_id: 'p-new', agent_status: 'idle' }]);
    const r = cmd(fix, ['status', 'w']);
    assert.equal(r.status, 0, r.stderr);
    // The plain state is the TSV line name<TAB>state<TAB>report.
    const cols = r.stdout.trim().split('\t');
    assert.equal(cols[0], 'w');
    assert.equal(cols[1], 'gone', 'the stale line is gone, not the other agent\'s idle (no-report-yet)');
    assert.equal(cols[2] ?? '', '', 'no report on the stale line');
    // The roster table shows gone for the line's own pane.
    const rt = cmd(fix, ['roster']);
    assert.equal(rt.status, 0, rt.stderr);
    const rowLine = rt.stdout.trim().split('\n').find((l) => l.startsWith('w '));
    assert.ok(rowLine.includes('gone'), 'the roster line shows gone: ' + rowLine);
    // Mutation captured: reporting the other agent's state (no-report-yet
    // / idle) for the stale line, in the status or in the roster table.
  } finally { fix.cleanup(); }
});

// The TASK column (last): the content of <state>/task-<agent> — the same
// text as the panel title, written by dispatch — without the trailing
// newline, '-' when the file does not exist, cut to 40 characters with
// an ellipsis. The other columns and the status output do not change.
test('roster: a TASK column shows the task file (no newline, dash, 40-char cut)', { timeout: 60000 }, () => {
  const fix = makeFix('ha-status-task-col-');
  try {
    fix.writeRoster(
      ROW('a', 'implementer', 'grok', 'grok-4.7', 'build'),
      ROW('b', 'implementer', 'grok', '', 'build'),
      ROW('c', 'implementer', 'grok', '', 'build'),
    );
    fix.modeOf('a', 'working');
    fix.modeOf('b', 'idle');
    fix.modeOf('c', 'working');
    fix.liveList([
      { name: 'a', pane_id: 'p-a', agent_status: 'working' },
      { name: 'b', pane_id: 'p-b', agent_status: 'idle' },
      { name: 'c', pane_id: 'p-c', agent_status: 'working' },
    ]);
    // a: a task exactly as dispatch writes it (trailing newline).
    fs.writeFileSync(path.join(fix.ws, 'task-a'), 'Refactor the billing tree\n');
    // c: a task longer than 40 characters.
    fs.writeFileSync(path.join(fix.ws, 'task-c'), 'x'.repeat(45) + '\n');
    // b: no task file.
    const r = cmd(fix, ['roster']);
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split('\n');
    const row = (n) => lines.find((l) => l.startsWith(`${n} `));
    // The header gains a TASK column at the end, after CWD.
    assert.ok(lines[0].endsWith('CWD TASK'), 'header: ' + lines[0]);
    // The task shows without the trailing newline.
    assert.ok(row('a').trimEnd().endsWith('/tmp/work Refactor the billing tree'), 'task without the newline: ' + row('a'));
    // No task file: a dash, the other columns untouched.
    assert.ok(row('b').trimEnd().endsWith('/tmp/work -'), 'no task file is a dash: ' + row('b'));
    // A long task is cut to 40 characters, the last one being the ellipsis.
    const taskC = row('c').trimEnd().split(' ').pop();
    assert.equal(taskC, 'x'.repeat(39) + '…', 'cut at 40 with an ellipsis: ' + taskC);
    // A 40-character task is shown whole (no cut).
    fs.writeFileSync(path.join(fix.ws, 'task-b'), 'y'.repeat(40) + '\n');
    const r2 = cmd(fix, ['roster']);
    assert.equal(r2.status, 0, r2.stderr);
    assert.ok(r2.stdout.split('\n').find((l) => l.startsWith('b ')).trimEnd().endsWith('y'.repeat(40)),
      'a 40-character task is whole: ' + r2.stdout);
    // The status is unchanged: the TSV keeps its own columns.
    const s = cmd(fix, ['status', 'a']);
    assert.equal(s.status, 0, s.stderr);
    assert.equal(s.stdout, 'a\tworking\t\n', 'the status line has no task: ' + JSON.stringify(s.stdout));
    // Mutation captured: the task shown with its newline (a stray blank
    // line in the table), a task over 40 left whole, the dash missing
    // when the file does not exist, or the status TSV gaining the column.
  } finally { fix.cleanup(); }
});

test('status: a line without a pane keeps the name query (any pane)', { timeout: 30000 }, () => {
  const fix = makeFix('ha-status-nopane-');
  try {
    // The line has no recorded pane: the name query holds (the live agent
    // is idle, no report) — not a stale override.
    fix.writeRoster(ROW_PANE('w', ''));
    fix.modeOf('w', 'idle');
    fix.liveList([{ name: 'w', pane_id: 'p-new', agent_status: 'idle' }]);
    const r = cmd(fix, ['status', 'w']);
    assert.equal(r.status, 0, r.stderr);
    const cols = r.stdout.trim().split('\t');
    assert.equal(cols[0], 'w');
    assert.equal(cols[1], 'no-report-yet', 'no pane on the line: the name state holds');
    // Mutation captured: forcing gone for a pane-less line (the override
    // requires a known line pane).
  } finally { fix.cleanup(); }
});

// `status` without names: the usage now points at the roster (which
// lists all the names), same exit 2. The check happens before any herdr
// query, so no fake live list is needed.
test('status: no names points at the roster (exit 2)', { timeout: 60000 }, () => {
  const fix = makeFix('ha-status-noname-');
  try {
    const r = cmd(fix, ['status']);
    assert.equal(r.status, 2, r.stderr);
    assert.ok(r.stderr.includes('status: give at least one agent name (herdr-agents roster lists them all)'), r.stderr);
    // Mutation captured: the roster hint removed from the message (the
    // old text) — the exact string above no longer matches.
  } finally { fix.cleanup(); }
});
