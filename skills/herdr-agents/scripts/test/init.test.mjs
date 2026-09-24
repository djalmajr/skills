// init (slice 8b): unit tests for lib/commands/init.mjs — the `doctor`
// report goes to stderr only while the JSON context on stdout is
// {orchestrator,pane_id,tab_id,workspace_id,layout,state_dir,first_run};
// the caller rename via a fake `herdr` (agent get/rename/list) and its
// idempotence (already named orchestrator or orchestrator-N: no rename),
// the unique-name suffix when `orchestrator` is live, and first_run true
// (a fresh project) vs false (a project config with a team choice, or an
// existing roster row). Each test file builds its own temp root (mkdtemp)
// used as HOME, XDG_CONFIG_HOME, TMPDIR and HERDR_AGENTS_DIR, with a
// temporary git repo (brief decision 7); the fake `herdr` (writeFakeCli)
// is the only herdr the code sees — no real herdr, no agent CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { JS_ENTRY, nodeBin, fixtureEnv } from './parity.mjs';
import { writeFakeCli } from './fakes.mjs';
import { findExecutable } from '../lib/platform.mjs';

let ROOT;
let REPO;
let HOME;
let CONF;
let STATE;
let TMP;
let BIN;
let ENV;
let NAME_FILE;
let LIVE_FILE;
let LOG_FILE;

// Fake herdr: logs every call (LOG_FILE); `agent get <pane>` answers with
// the caller's current name (NAME_FILE, one agent_not_found when the file
// is absent); `agent rename <pane> <name>` records the new name;
// `agent list` answers with the live names (LIVE_FILE, one per line);
// doctor's version/skill checks answer like test-friendly.sh's fake.
const HERDR_FAKE = [
  "import fs from 'node:fs';",
  'const a = process.argv.slice(2);',
  "fs.appendFileSync(process.env.HERDR_LOG, a.join(' ') + '\\n');",
  "if (a[0] === '--version') { process.stdout.write('herdr 9.9.9\\n'); process.exit(0); }",
  "if (a[0] === 'status') { process.stdout.write('server 9.9.9\\n'); process.exit(0); }",
  "if (a[0] === '--skill') { process.exit(0); }",
  'if (a[0] === \'agent\') {',
  '  if (a[1] === \'get\') {',
  "    let name = null;",
  "    try { name = fs.readFileSync(process.env.HERDR_NAME, 'utf8').trim(); } catch {}",
  "    if (name === null) { process.stderr.write('{\"error\":{\"code\":\"agent_not_found\",\"message\":\"no\"}}\\n'); process.exit(1); }",
  "    process.stdout.write(JSON.stringify({ result: { agent: { name, agent_status: 'idle' } } }) + '\\n');",
  '    process.exit(0);',
  '  }',
  '  if (a[1] === \'rename\') {',
  "    fs.writeFileSync(process.env.HERDR_NAME, a[3] + '\\n');",
  "    process.stdout.write('{\"result\":{}}\\n');",
  '    process.exit(0);',
  '  }',
  '  if (a[1] === \'list\') {',
  "    let live = '';",
  "    try { live = fs.readFileSync(process.env.HERDR_LIVE, 'utf8'); } catch {}",
  '    const agents = live.trim().split(\'\\n\').filter((l) => l !== \'\').map((n) => ({ name: n, pane_id: `p-${n}`, agent_status: \'working\', agent: \'grok\' }));',
  "    process.stdout.write(JSON.stringify({ result: { agents } }) + '\\n');",
  '    process.exit(0);',
  '  }',
  '}',
  "if (a[0] === 'pane') { process.stdout.write('{\"result\":{\"pane\":{\"workspace_id\":\"ws\"}}}\\n'); process.exit(0); }",
  "process.stdout.write('{\"result\":{}}\\n');",
].join('\n') + '\n';

test.before(() => {
  ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ha-init-unit-')));
  REPO = path.join(ROOT, 'repo');
  HOME = path.join(ROOT, 'home');
  CONF = path.join(ROOT, 'conf');
  STATE = path.join(ROOT, 'state');
  TMP = path.join(ROOT, 'tmp');
  BIN = path.join(ROOT, 'bin');
  for (const d of [REPO, HOME, CONF, STATE, TMP, BIN]) fs.mkdirSync(d, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: REPO, stdio: 'ignore', timeout: 20000 });
  const git = findExecutable('git');
  if (git) fs.symlinkSync(git, path.join(BIN, 'git'));
  writeFakeCli(BIN, 'herdr', HERDR_FAKE);
  NAME_FILE = path.join(ROOT, 'caller-name');
  LIVE_FILE = path.join(ROOT, 'live-names');
  LOG_FILE = path.join(ROOT, 'herdr.log');
  fs.writeFileSync(LIVE_FILE, 'build\n');
  ENV = fixtureEnv({
    HOME, XDG_CONFIG_HOME: CONF, HERDR_AGENTS_DIR: STATE, HERDR_WORKSPACE_ID: 'ws', TMPDIR: TMP,
    HERDR_ENV: '1', HERDR_PANE_ID: 'p1', HERDR_TAB_ID: 't1',
    HERDR_LOG: LOG_FILE, HERDR_NAME: NAME_FILE, HERDR_LIVE: LIVE_FILE,
    PATH: `${BIN}${path.delimiter}/usr/bin${path.delimiter}/bin`,
  });
});
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

// Run `init` as a child process from a clean slate (state, project conf,
// herdr log); `caller` is the name the fake herdr reports for the pane.
function e2e({ caller = '', live = 'build\n', conf = null, roster = null, env = {} } = {}) {
  fs.rmSync(STATE, { recursive: true, force: true });
  fs.mkdirSync(STATE, { recursive: true });
  fs.rmSync(path.join(REPO, '.agents'), { recursive: true, force: true });
  fs.writeFileSync(LOG_FILE, '');
  if (caller !== '') fs.writeFileSync(NAME_FILE, `${caller}\n`); else fs.rmSync(NAME_FILE, { force: true });
  fs.writeFileSync(LIVE_FILE, live);
  if (conf !== null) {
    fs.mkdirSync(path.join(REPO, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(REPO, '.agents', 'herdr-agents.conf'), conf);
  }
  if (roster !== null) {
    const ws = path.join(STATE, 'ws');
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'agents.tsv'), roster);
  }
  const r = spawnSync(nodeBin(), [JS_ENTRY, 'init'], {
    cwd: REPO, env: { ...ENV, ...env }, encoding: 'utf8', timeout: 20000,
  });
  return {
    rc: r.status === null ? -1 : r.status,
    out: r.stdout ?? '',
    err: r.stderr ?? '',
    log: () => fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter((l) => l !== ''),
  };
}

const H12 = '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\tmodel\tapprovals\troles\tlane\n';

test('init: first_run true — doctor on stderr only, the JSON context on stdout, no rename', { timeout: 30000 }, () => {
  const r = e2e({ caller: 'orchestrator' });
  assert.equal(r.rc, 0, `rc ${r.rc}: ${r.err}`);
  const doc = JSON.parse(r.out); // the whole stdout is the JSON
  assert.deepEqual(Object.keys(doc), ['orchestrator', 'pane_id', 'tab_id', 'workspace_id', 'layout', 'state_dir', 'first_run']);
  assert.equal(doc.first_run, true);
  assert.equal(doc.orchestrator, 'orchestrator');
  assert.equal(doc.pane_id, 'p1');
  assert.equal(doc.tab_id, 't1');
  assert.equal(doc.workspace_id, 'ws');
  assert.equal(doc.layout, 'split');
  assert.equal(doc.state_dir, path.join(STATE, 'ws'));
  // doctor: the report is on stderr, not on stdout.
  assert.ok(r.err.includes('first_run: true'), `stderr: ${r.err}`);
  assert.ok(/warning\(s\)/.test(r.err), 'the doctor summary line');
  assert.ok(!r.out.includes('warning(s)') && !r.out.includes('inside Herdr'), 'no doctor text on stdout');
  // The caller is already named orchestrator: herdr was queried, never renamed.
  const log = r.log();
  assert.ok(log.includes('agent get p1'), `herdr log: ${JSON.stringify(log)}`);
  assert.ok(!log.some((l) => l.startsWith('agent rename')), `no rename expected: ${JSON.stringify(log)}`);
  // The state dir was created with the header roster.
  assert.equal(fs.readFileSync(path.join(STATE, 'ws', 'agents.tsv'), 'utf8'), H12);
});

test('init: renames the caller to orchestrator, and the second run is idempotent', { timeout: 30000 }, () => {
  const r1 = e2e({ caller: 'worker-old' });
  assert.equal(r1.rc, 0, `rc ${r1.rc}: ${r1.err}`);
  assert.equal(JSON.parse(r1.out).orchestrator, 'orchestrator');
  let log = r1.log();
  assert.deepEqual(log.filter((l) => l.startsWith('agent rename')), ['agent rename p1 orchestrator'], JSON.stringify(log));
  assert.equal(fs.readFileSync(NAME_FILE, 'utf8').trim(), 'orchestrator');
  // A second run sees the new name: no further rename.
  const r2 = e2e({ caller: fs.readFileSync(NAME_FILE, 'utf8').trim() });
  assert.equal(r2.rc, 0, `rc ${r2.rc}: ${r2.err}`);
  assert.equal(JSON.parse(r2.out).orchestrator, 'orchestrator');
  log = r2.log();
  assert.ok(!log.some((l) => l.startsWith('agent rename')), `idempotent: ${JSON.stringify(log)}`);
});

test('init: an orchestrator-N prefix is left alone (no rename)', { timeout: 30000 }, () => {
  const r = e2e({ caller: 'orchestrator-2' });
  assert.equal(r.rc, 0, `rc ${r.rc}: ${r.err}`);
  assert.equal(JSON.parse(r.out).orchestrator, 'orchestrator-2');
  assert.ok(!r.log().some((l) => l.startsWith('agent rename')), 'no rename for the prefix match');
});

test('init: when orchestrator is live the rename takes the unique suffix', { timeout: 30000 }, () => {
  const r = e2e({ caller: 'worker-old', live: 'build\norchestrator\n' });
  assert.equal(r.rc, 0, `rc ${r.rc}: ${r.err}`);
  assert.equal(JSON.parse(r.out).orchestrator, 'orchestrator-2');
  assert.deepEqual(r.log().filter((l) => l.startsWith('agent rename')), ['agent rename p1 orchestrator-2'], JSON.stringify(r.log()));
});

test('init: first_run false with a project config that makes the team choice', { timeout: 30000 }, () => {
  const r = e2e({ caller: 'orchestrator', conf: 'lane.build.kind=grok\n' });
  assert.equal(r.rc, 0, `rc ${r.rc}: ${r.err}`);
  assert.equal(JSON.parse(r.out).first_run, false);
  assert.ok(r.err.includes('first_run: false'), r.err);
});

test('init: first_run false with a roster row and no config (comments and max_workers do not count)', { timeout: 30000 }, () => {
  const r = e2e({
    caller: 'orchestrator',
    conf: '# note\nmax_workers=3\n',
    roster: `${H12}build\tp1\tgrok\timplementer\txai\t1\t/tmp/work\tnow\tgrok-4.7\task\timplementer\tbuild\n`,
  });
  assert.equal(r.rc, 0, `rc ${r.rc}: ${r.err}`);
  assert.equal(JSON.parse(r.out).first_run, false);
  // A header-only roster plus comments/max_workers stays a first run.
  const r2 = e2e({
    caller: 'orchestrator',
    conf: '# note\nmax_workers=3\n',
    roster: H12,
  });
  assert.equal(JSON.parse(r2.out).first_run, true);
});

test('init: a living command — without HERDR_ENV it refuses with the bash message (rc 2)', { timeout: 30000 }, () => {
  const r = e2e({ caller: 'orchestrator', env: { HERDR_ENV: '' } });
  assert.equal(r.rc, 2, `rc ${r.rc}`);
  assert.ok(r.err.includes('not running inside Herdr (HERDR_ENV != 1); refusing to control a session from outside'), r.err);
  assert.equal(r.out, '', 'nothing on stdout');
});
