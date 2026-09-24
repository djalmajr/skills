// The `status` command: the provider-error / capacity JSON
// line with the cause, rc 14 ranked below 11 and above 0 (and below 4,
// per the global wait rank), the quota winning over the provider on the
// same screen, and the old TSV / rc 0 behavior untouched. One probe only:
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
// as agent_status); `agent read` prints screen-<t> (or the global screen
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
  process.stdout.write('{"result":{"agent":{"name":"' + t + '","agent_status":"' + m + '"}}}\\n');
} else if (cmd === 'agent read') {
  process.stdout.write(screenOf(t));
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
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  };
  fs.writeFileSync(env.FAKE_MODE, 'working\n');
  fs.writeFileSync(env.FAKE_SCREEN, '');
  const H12 = '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\tmodel\tapprovals\troles\tlane\n';
  const fix = {
    root, repo, state, ws, env, ctx: loadConfig(env, repo),
    mode(m) { fs.writeFileSync(env.FAKE_MODE, `${m}\n`); },
    modeOf(agent, m) { fs.writeFileSync(path.join(modeDir, `mode-${agent}`), `${m}\n`); },
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
