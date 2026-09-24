// Spawn (slice 5b): the `find_reusable` / `emit_reuse` units of
// test-multi-role.sh (cross-role reuse, approvals, edit history, old
// 8-column lines, `unavailable` blocking only the same role, report
// pending, cwd/kind mismatch, retarget + history), plus `uniqueName`,
// `ensureOrchestratorName`, the resolution chains (kind/effort) and
// `cmdSpawn` end-to-end in a child process (planner 12, usage 2, the
// entry's top-level catch: DieError with a message → die 8; empty
// message → the passthrough code only). A fake `herdr` (writeFakeCli)
// answers per target; the real CLI is never used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { nodeBin } from './parity.mjs';
import { writeFakeCli } from './fakes.mjs';
import { loadConfig, DieError } from '../lib/config.mjs';
import { enforceWorkerCap } from '../lib/lanes.mjs';
import {
  agentNameTaken, approvalsRank, cmdSpawn, emitReuse, ensureOrchestratorName,
  findReusable, resolvedRoleKind, resolveSpawnEffort, uniqueName,
} from '../lib/spawn.mjs';

const SCRIPTS = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SPAWN_URL = pathToFileURL(path.join(SCRIPTS, 'lib', 'spawn.mjs')).href;
const CONFIG_URL = pathToFileURL(path.join(SCRIPTS, 'lib', 'config.mjs')).href;
const JS_ENTRY = path.join(SCRIPTS, 'herdr-agents.mjs');

// ---------- fixture plumbing ----------

// Fake herdr (Node): `agent get` per target (stuck → an unqueryable error,
// working1/finished1 by name, else idle — the name comes from the live
// file when the target is live there); `agent list` from $FAKE_LIVE (or
// fails when FAKE_LIVE_FAIL); `agent start` honors $FAKE_START_MODE
// (busy2: the first two calls fail with agent_pane_busy; notready:
// agent_not_ready); `agent read` prints a fixed screen.
const HERDR_FAKE = `
import fs from 'node:fs';
const argv = process.argv.slice(2);
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, argv.join(' ') + '\\n');
const live = () => {
  try { return (JSON.parse(fs.readFileSync(process.env.FAKE_LIVE, 'utf8')).agents) ?? []; } catch { return []; }
};
const cmd = (argv[0] ?? '') + ' ' + (argv[1] ?? '');
if (cmd === 'agent get') {
  const t = argv[2] ?? '';
  if (t === 'stuck') {
    process.stderr.write('Error: Os { code: 13, kind: PermissionDenied, message: "Permission denied" }\\n');
    process.exit(1);
  }
  if (t === 'gone' || t === 'dead') {
    process.stderr.write('{"error":{"code":"agent_not_found","message":"gone"}}\\n');
    process.exit(1);
  }
  const a = live().find((x) => x && ((x.name ?? '') === t || x.pane_id === t));
  const out = a
    ? { name: a.name, agent_status: a.agent_status ?? 'idle' }
    : { name: t, agent_status: 'idle' };
  process.stdout.write(JSON.stringify({ result: { agent: out } }) + '\\n');
} else if (cmd === 'agent list') {
  if (process.env.FAKE_LIVE_FAIL) { process.stderr.write('herdr says no\\n'); process.exit(3); }
  process.stdout.write(JSON.stringify({ result: { agents: live() } }) + '\\n');
} else if (cmd === 'agent start') {
  const m = process.env.FAKE_START_MODE;
  if (m === 'busy2' && process.env.FAKE_START_COUNT) {
    let n = 0;
    try { n = parseInt(fs.readFileSync(process.env.FAKE_START_COUNT, 'utf8'), 10); } catch { n = 0; }
    n += 1;
    fs.writeFileSync(process.env.FAKE_START_COUNT, String(n));
    if (n <= 2) {
      process.stderr.write('{"error":{"code":"agent_pane_busy","message":"shell not ready"}}\\n');
      process.exit(1);
    }
  }
  if (m === 'notready') { process.stderr.write('agent_not_ready: login prompt\\n'); process.exit(1); }
  process.stdout.write('{"result":{"started":true}}\\n');
} else if (cmd === 'agent read') {
  process.stdout.write('screen line 1\\nscreen line 2\\n');
} else if (cmd === 'agent rename') {
  if (process.env.FAKE_RENAME_FAIL) { process.stderr.write('rename failed\\n'); process.exit(1); }
  process.stdout.write('{"result":{}}\\n');
} else if (cmd === 'pane list') {
  process.stdout.write('{"result":{"panes":[]}}\\n');
} else if (cmd === 'tab create') {
  process.stdout.write('{"result":{"tab":{"tab_id":"t-herd","label":"herd"},"root_pane":{"pane_id":"p-new"}}}\\n');
} else if (cmd === 'tab get') {
  process.stdout.write('{"result":{"tab":{"tab_id":"t-herd","label":"herd"},"root_pane":{"pane_id":"p-root"}}}\\n');
} else if (cmd === 'tab rename') {
  process.stdout.write('{"result":{}}\\n');
} else {
  process.stderr.write('unexpected: ' + argv.join(' ') + '\\n');
  process.exit(1);
}
`;

function makeFix(prefix) {
  let root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  root = fs.realpathSync(root);
  const bin = path.join(root, 'bin');
  const repo = path.join(root, 'repo');
  const state = path.join(root, 'state');
  const ws = path.join(state, 'ws');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(path.join(ws, 'briefs'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'reports'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'wait'), { recursive: true });
  writeFakeCli(bin, 'herdr', HERDR_FAKE);
  writeFakeCli(bin, 'grok', `if (process.argv[2] === 'models') process.stdout.write('grok-4.7\\n');\n`);
  const env = {
    HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'conf'),
    TMPDIR: path.join(root, 'tmp'),
    HERDR_AGENTS_DIR: state,
    HERDR_WORKSPACE_ID: 'ws',
    HERDR_ENV: '1',
    HERDR_AGENTS_LAYOUT: 'tab',
    HERDR_AGENTS_REGRID: 'off',
    FAKE_LIVE: path.join(root, 'live.json'),
    FAKE_LOG: path.join(root, 'herdr.log'),
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  };
  fs.mkdirSync(path.join(root, 'home'), { recursive: true });
  fs.mkdirSync(path.join(root, 'conf'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  fs.writeFileSync(env.FAKE_LIVE, JSON.stringify({ agents: [] }));
  const ROW = (name, role, model = '', approvals = '', roles = '', lane = '') =>
    `${name}\tp-${name}\tgrok\t${role}\txai\t1\t/tmp/work\tnow\t${model}\t${approvals}\t${roles}\t${lane}`;
  const add8 = (name, role) =>
    `${name}\tp-${name}\tgrok\t${role}\txai\t1\t/tmp/work\tnow`;
  const fix = {
    root, repo, state, ws, env,
    ctx: loadConfig(env, repo),
    // The 11-column roster of test-multi-role.sh (no lane column).
    writeRoster(...rows) {
      fs.writeFileSync(path.join(ws, 'agents.tsv'),
        '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\tmodel\tapprovals\troles\n' + rows.join('\n') + '\n');
    },
    add: (...rows) => {
      const f = path.join(ws, 'agents.tsv');
      if (!fs.existsSync(f)) fix.writeRoster();
      for (const r of rows) fs.appendFileSync(f, r + '\n');
    },
    row: (name) => {
      const lines = fs.readFileSync(path.join(ws, 'agents.tsv'), 'utf8').trim().split('\n');
      return lines.filter((l) => l.split('\t')[0] === name).at(-1) ?? '';
    },
    roster() { return fs.readFileSync(path.join(ws, 'agents.tsv'), 'utf8'); },
    live(agents) { fs.writeFileSync(env.FAKE_LIVE, JSON.stringify({ agents })); },
    logLines() { try { return fs.readFileSync(env.FAKE_LOG, 'utf8').trim().split('\n'); } catch { return []; } },
    clearLog() { fs.writeFileSync(env.FAKE_LOG, ''); },
    report(agent, content) {
      const p = path.join(ws, 'reports', `${agent}.md`);
      fs.writeFileSync(p, content);
      fs.writeFileSync(path.join(ws, `last-report-${agent}`), p + '\n');
      return p;
    },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
  fix.writeRoster();
  return fix;
}

// ---------- findReusable (test-multi-role.sh :100-255) ----------

function reuse(fix, role, kind, name, wantModel, wantApprovals, env = fix.env) {
  return findReusable(role, kind, '/tmp/work', name, wantModel, wantApprovals, fix.ctx, env, fix.repo);
}

test('findReusable: same model + approvals is reused across roles', () => {
  const fix = makeFix('ha-spawn-reuse-1-');
  try {
    fix.add(`scout\tp-scout\tgrok\tscouter\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\tscouter`);
    assert.deepEqual(reuse(fix, 'implementer', 'grok', '', 'grok-4.7', 'full'), { name: 'scout' });
  } finally { fix.cleanup(); }
});

test('findReusable: the same role wins over an earlier other role', () => {
  const fix = makeFix('ha-spawn-reuse-2-');
  try {
    fix.add(
      'scout\tp-scout\tgrok\tscouter\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\tscouter',
      'impl\tp-impl\tgrok\timplementer\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\timplementer',
    );
    assert.deepEqual(reuse(fix, 'implementer', 'grok', '', 'grok-4.7', 'full'), { name: 'impl' });
  } finally { fix.cleanup(); }
});

test('findReusable: a different resolved model is not reused', () => {
  const fix = makeFix('ha-spawn-reuse-3-');
  try {
    fix.add('scout\tp-scout\tgrok\tscouter\txai\t1\t/tmp/work\tnow\tgrok-4\tfull\tscouter');
    assert.equal(reuse(fix, 'implementer', 'grok', '', 'grok-4.7', 'full'), null);
  } finally { fix.cleanup(); }
});

test('findReusable: approvals — below never, equal and above yes, unknown request never', () => {
  const fix = makeFix('ha-spawn-reuse-4-');
  try {
    fix.add('scout\tp-scout\tgrok\tscouter\txai\t1\t/tmp/work\tnow\tgrok-4.7\task\tscouter');
    assert.equal(reuse(fix, 'implementer', 'grok', '', 'grok-4.7', 'full'), null, 'below');
    fix.writeRoster('scout\tp-scout\tgrok\tscouter\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\tscouter');
    assert.deepEqual(reuse(fix, 'implementer', 'grok', '', 'grok-4.7', 'ask'), { name: 'scout' }, 'above');
    fix.writeRoster('scout\tp-scout\tgrok\tscouter\txai\t1\t/tmp/work\tnow\tgrok-4.7\task\tscouter');
    assert.equal(reuse(fix, 'implementer', 'grok', '', 'grok-4.7', 'FULL'), null, 'unknown request');
    fix.writeRoster('scout\tp-scout\tgrok\tscouter\txai\t1\t/tmp/work\tnow\tgrok-4.7\tedits\tscouter');
    assert.deepEqual(reuse(fix, 'implementer', 'grok', '', 'grok-4.7', 'edits'), { name: 'scout' }, 'equal');
    assert.equal(approvalsRank('ask'), 1);
    assert.equal(approvalsRank('edits'), 2);
    assert.equal(approvalsRank('full'), 3);
    assert.equal(approvalsRank('FULL'), 0);
  } finally { fix.cleanup(); }
});

test('findReusable: edited workers never become a review role', () => {
  const fix = makeFix('ha-spawn-reuse-5-');
  try {
    fix.add('impl\tp-impl\tgrok\timplementer\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\timplementer');
    assert.equal(reuse(fix, 'reviewer', 'grok', '', 'grok-4.7', 'ask'), null, 'edit role → reviewer');
    fix.writeRoster('ex\tp-ex\tgrok\tscouter\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\timplementer,scouter');
    assert.equal(reuse(fix, 'security-reviewer', 'grok', '', 'grok-4.7', 'ask'), null, 'edit history → security-reviewer');
    assert.deepEqual(reuse(fix, 'researcher', 'grok', '', 'grok-4.7', 'ask'), { name: 'ex' }, 'edit history → non-review ok');
    fix.writeRoster('scout\tp-scout\tgrok\tscouter\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\tscouter');
    assert.deepEqual(reuse(fix, 'reviewer', 'grok', '', 'grok-4.7', 'ask'), { name: 'scout' }, 'never edited → reviewer');
  } finally { fix.cleanup(); }
});

test('findReusable: a frontmatter mode: edit role cannot become inspector', () => {
  const fix = makeFix('ha-spawn-reuse-6-');
  try {
    const rolesDir = path.join(fix.root, 'roles');
    fs.mkdirSync(rolesDir, { recursive: true });
    fs.writeFileSync(path.join(rolesDir, 'migrator.md'),
      '---\nname: migrator\nkind: grok\nmode: edit\n---\n\nMigrate.\n');
    fix.add('mig\tp-mig\tgrok\tmigrator\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\tmigrator');
    const env = { ...fix.env, HERDR_AGENTS_ROLES: rolesDir };
    assert.equal(reuse(fix, 'inspector', 'grok', '', 'grok-4.7', 'ask', env), null);
  } finally { fix.cleanup(); }
});

test('findReusable: old 8-column lines are only reused for the same role', () => {
  const fix = makeFix('ha-spawn-reuse-7-');
  try {
    fix.add('old\tp-old\tgrok\tscouter\txai\t1\t/tmp/work\tnow');
    assert.equal(reuse(fix, 'implementer', 'grok', '', 'grok-4.7', 'full'), null, '8-column cross-role');
    fix.writeRoster('impl\tp-impl\tgrok\timplementer\txai\t1\t/tmp/work\tnow');
    assert.deepEqual(reuse(fix, 'implementer', 'grok', '', 'grok-4.7', 'full'), { name: 'impl' }, '8-column same role');
  } finally { fix.cleanup(); }
});

test('findReusable: multi_role=off refuses another role, still reuses the same role', () => {
  const fix = makeFix('ha-spawn-reuse-8-');
  try {
    const off = { ...fix.env, HERDR_AGENTS_MULTI_ROLE: 'off' };
    fix.add('scout\tp-scout\tgrok\tscouter\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\tscouter');
    assert.equal(reuse(fix, 'implementer', 'grok', '', 'grok-4.7', 'full', off), null);
    fix.writeRoster('impl\tp-impl\tgrok\timplementer\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\timplementer');
    assert.deepEqual(reuse(fix, 'implementer', 'grok', '', 'grok-4.7', 'full', off), { name: 'impl' });
  } finally { fix.cleanup(); }
});

// Cross-role reuse needs both models recorded and equal (bash :3318): a
// missing model on either side never borrows a session started with
// another model.
test('findReusable: cross-role reuse requires the same recorded and requested model', () => {
  const fix = makeFix('ha-spawn-reuse-model-');
  try {
    fix.add('scout\tp-scout\tgrok\tscouter\txai\t1\t/tmp/work\tnow\tprovider/old-model\tfull\tscouter');
    assert.equal(reuse(fix, 'tasker', 'grok', '', '', 'full'), null, 'no requested model');
    assert.equal(reuse(fix, 'tasker', 'grok', '', 'grok-4.7', 'full'), null, 'another model');
    assert.deepEqual(reuse(fix, 'tasker', 'grok', '', 'provider/old-model', 'full'), { name: 'scout' }, 'same model');
    fix.writeRoster('scout\tp-scout\tgrok\tscouter\txai\t1\t/tmp/work\tnow\t\tfull\tscouter');
    assert.equal(reuse(fix, 'tasker', 'grok', '', 'grok-4.7', 'full'), null, 'no recorded model');
    assert.equal(reuse(fix, 'tasker', 'grok', '', '', 'full'), null, 'neither side has a model');
  } finally { fix.cleanup(); }
});

test('findReusable: a busy same-role worker does not block another role', () => {
  const fix = makeFix('ha-spawn-reuse-9-');
  try {
    fix.add(
      'working1\tp-working1\tgrok\timplementer\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\timplementer',
      'scout\tp-scout\tgrok\tscouter\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\tscouter',
    );
    fix.live([
      { name: 'working1', agent_status: 'working', pane_id: 'p-working1' },
      { name: 'scout', agent_status: 'idle', pane_id: 'p-scout' },
    ]);
    assert.deepEqual(reuse(fix, 'implementer', 'grok', '', 'grok-4.7', 'full'), { name: 'scout' });
  } finally { fix.cleanup(); }
});

test('findReusable: an unqueryable same-role match blocks (unavailable)', () => {
  const fix = makeFix('ha-spawn-reuse-10-');
  try {
    fix.add(
      'stuck\tp-stuck\tgrok\timplementer\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\timplementer',
      'scout\tp-scout\tgrok\tscouter\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\tscouter',
    );
    const out = reuse(fix, 'implementer', 'grok', '', 'grok-4.7', 'full');
    assert.ok(out.unavailable, JSON.stringify(out));
    assert.equal(out.unavailable.name, 'stuck');
    assert.match(out.unavailable.cause, /PermissionDenied/);
  } finally { fix.cleanup(); }
});

// scripts/test-status.sh: the unqueryable same-role worker does not block
// while a queryable idle one of the same role exists (the idle one wins),
// and a dead worker is real absence — no match at all (rc 1, no name).
test('findReusable: idle same-role sibling wins over unqueryable; dead is absence (test-status.sh)', () => {
  const fix = makeFix('ha-spawn-reuse-status-');
  try {
    fix.writeRoster(
      'stuck\tp-stuck\tgrok\timplementer\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\timplementer',
      'idle1\tp-idle1\tgrok\timplementer\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\timplementer',
    );
    assert.deepEqual(reuse(fix, 'implementer', 'grok', '', 'grok-4.7', 'full'), { name: 'idle1' });
    fix.writeRoster('dead\tp-dead\tgrok\timplementer\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\timplementer');
    assert.equal(reuse(fix, 'implementer', 'grok', '', 'grok-4.7', 'full'), null, 'dead agent: no match');
  } finally { fix.cleanup(); }
});

test('findReusable: done is reusable; an empty last report is not', () => {
  const fix = makeFix('ha-spawn-reuse-11-');
  try {
    fix.add('finished1\tp-finished1\tgrok\tscouter\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\tscouter');
    fix.live([{ name: 'finished1', agent_status: 'done', pane_id: 'p-finished1' }]);
    assert.deepEqual(reuse(fix, 'implementer', 'grok', '', 'grok-4.7', 'full'), { name: 'finished1' });
    fix.writeRoster('scout\tp-scout\tgrok\tscouter\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\tscouter');
    const p = fix.report('scout', '');
    assert.equal(reuse(fix, 'implementer', 'grok', '', 'grok-4.7', 'full'), null, 'empty report → pending');
    fs.writeFileSync(p, 'ok\n');
    assert.deepEqual(reuse(fix, 'implementer', 'grok', '', 'grok-4.7', 'full'), { name: 'scout' }, 'non-empty report → reusable');
    fs.rmSync(path.join(fix.ws, 'last-report-scout'), { force: true });
    assert.deepEqual(reuse(fix, 'implementer', 'grok', '', 'grok-4.7', 'full'), { name: 'scout' },
      'no report file at all → reusable (the file is optional)');
  } finally { fix.cleanup(); }
});

test('findReusable: a different cwd or kind is not reused', () => {
  const fix = makeFix('ha-spawn-reuse-12-');
  try {
    fix.add('other\tp-other\tgrok\tscouter\txai\t1\t/other\tnow\tgrok-4.7\tfull\tscouter');
    assert.equal(reuse(fix, 'implementer', 'grok', '', 'grok-4.7', 'full'), null, 'different cwd');
    fix.writeRoster('ck\tp-ck\tcodex\tscouter\topenai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\tscouter');
    assert.equal(reuse(fix, 'implementer', 'grok', '', 'grok-4.7', 'full'), null, 'different kind');
  } finally { fix.cleanup(); }
});

// ---------- emitReuse / roster retarget ----------

function runEmitReuse(fix, name, role, kind) {
  const code = `
import { emitReuse } from '${SPAWN_URL}';
import { loadConfig } from '${CONFIG_URL}';
const ctx = loadConfig(process.env, process.cwd());
emitReuse(${JSON.stringify(name)}, ${JSON.stringify(role)}, ${JSON.stringify(kind)}, ctx, process.env, process.cwd());
`;
  return spawnSync(nodeBin(), ['--input-type=module', '-e', code], { env: fix.env, cwd: fix.repo, encoding: 'utf8' });
}

test('emitReuse: retargets column 4, grows the history, keeps model/approvals', () => {
  const fix = makeFix('ha-spawn-emit-');
  try {
    fix.add('scout\tp-scout\tgrok\tscouter\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\tscouter');
    let r = runEmitReuse(fix, 'scout', 'implementer', 'grok');
    assert.equal(r.status, 0, r.stderr);
    let j = JSON.parse(r.stdout);
    assert.deepEqual(j, {
      name: 'scout', pane_id: 'p-scout', kind: 'grok', role: 'implementer', family: 'xai',
      reused: true, previous_role: 'scouter', status: 'ready',
    });
    let f = fix.row('scout').split('\t');
    assert.equal(f[3], 'implementer');
    assert.equal(f[10], 'scouter,implementer');
    assert.equal(f[8], 'grok-4.7');
    assert.equal(f[9], 'full');
    r = runEmitReuse(fix, 'scout', 'researcher', 'grok');
    assert.equal(r.status, 0, r.stderr);
    j = JSON.parse(r.stdout);
    assert.equal(j.previous_role, 'implementer');
    assert.equal(j.role, 'researcher');
    f = fix.row('scout').split('\t');
    assert.equal(f[10], 'scouter,implementer,researcher');
    assert.equal(fix.roster().split('\n')[0], '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\tmodel\tapprovals\troles');
  } finally { fix.cleanup(); }
});

test('emitReuse: same-role reuse leaves an 8-column line untouched', () => {
  const fix = makeFix('ha-spawn-emit8-');
  try {
    fix.add('impl\tp-impl\tgrok\timplementer\txai\t1\t/tmp/work\tnow');
    const before = fix.roster();
    const r = runEmitReuse(fix, 'impl', 'implementer', 'grok');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).previous_role, 'implementer');
    assert.equal(fix.roster(), before);
  } finally { fix.cleanup(); }
});

test('emitReuse: a name without a roster row returns no JSON (rc stays 0, no output)', () => {
  const fix = makeFix('ha-spawn-emit-none-');
  try {
    const r = runEmitReuse(fix, 'ghost', 'implementer', 'grok');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
  } finally { fix.cleanup(); }
});

// ---------- names ----------

test('uniqueName: base, base-2, base-3… skipping the live names', () => {
  const fix = makeFix('ha-spawn-name-');
  try {
    fix.live([]);
    assert.equal(uniqueName('build', fix.env), 'build');
    assert.equal(agentNameTaken('build', fix.env), false);
    fix.live([{ name: 'build', agent_status: 'idle', pane_id: 'p-build' }]);
    assert.equal(agentNameTaken('build', fix.env), true);
    assert.equal(uniqueName('build', fix.env), 'build-2');
    fix.live([{ name: 'build' }, { name: 'build-2' }]);
    assert.equal(uniqueName('build', fix.env), 'build-3');
  } finally { fix.cleanup(); }
});

test('ensureOrchestratorName: renames the caller, idempotent, silent without an agent', () => {
  const fix = makeFix('ha-spawn-orch-');
  try {
    // No HERDR_PANE_ID → silent, no herdr call.
    assert.equal(ensureOrchestratorName(fix.ctx, fix.env), '');
    assert.deepEqual(fix.logLines(), []);
    // The caller pane hosts no agent (agent get fails) → silent.
    const envNoAgent = { ...fix.env, HERDR_PANE_ID: 'gone' };
    assert.equal(ensureOrchestratorName(fix.ctx, envNoAgent), '');
    // The caller agent is not named after orchestrator_name → renamed.
    fix.clearLog();
    assert.equal(ensureOrchestratorName(fix.ctx, { ...fix.env, HERDR_PANE_ID: 'c' }), 'orchestrator');
    assert.ok(fix.logLines().includes('agent rename c orchestrator'), fix.logLines().join('\n'));
    // Already orchestrator (or orchestrator-N) → kept, no rename.
    fix.live([{ name: 'orchestrator', pane_id: 'c' }]);
    fix.clearLog();
    assert.equal(ensureOrchestratorName(fix.ctx, { ...fix.env, HERDR_PANE_ID: 'c' }), 'orchestrator');
    assert.ok(!fix.logLines().some((l) => l.startsWith('agent rename')), fix.logLines().join('\n'));
    fix.live([{ name: 'orchestrator-2', pane_id: 'c' }]);
    assert.equal(ensureOrchestratorName(fix.ctx, { ...fix.env, HERDR_PANE_ID: 'c' }), 'orchestrator-2');
    // A rename failure warns and returns ''.
    fix.live([]);
    assert.equal(ensureOrchestratorName(fix.ctx, { ...fix.env, HERDR_PANE_ID: 'c', FAKE_RENAME_FAIL: '1' }), '');
  } finally { fix.cleanup(); }
});

// ---------- resolution chains ----------

function confFix(prefix) {
  const fix = makeFix(prefix);
  const proj = (text) => {
    fs.mkdirSync(path.join(fix.repo, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(fix.repo, '.agents', 'herdr-agents.conf'), text);
    fix.ctx = loadConfig(fix.env, fix.repo);
  };
  return { fix, proj };
}

test('resolvedRoleKind: config beats frontmatter, frontmatter is the floor', () => {
  const { fix, proj } = confFix('ha-spawn-kind-');
  try {
    assert.equal(resolvedRoleKind('implementer', fix.ctx, fix.env, fix.repo), 'grok', 'frontmatter only');
    proj('role.implementer.kind=pi\n');
    assert.equal(resolvedRoleKind('implementer', fix.ctx, fix.env, fix.repo), 'pi', 'role config');
    assert.equal(resolvedRoleKind('planner', fix.ctx, fix.env, fix.repo), 'claude', 'another role\'s frontmatter');
  } finally { fix.cleanup(); }
});

test('resolveSpawnEffort: the chain and the kind-layer rule', () => {
  const { fix, proj } = confFix('ha-spawn-effort-');
  try {
    const e = (role, lane, kind, layer, ctx = fix.ctx) =>
      resolveSpawnEffort(role, lane, kind, layer, ctx, fix.env, fix.repo);
    assert.equal(e('planner', '', 'claude', ''), 'high', 'frontmatter is the floor');
    proj('effort.grok=low\n');
    assert.equal(e('scouter', '', 'grok', ''), 'low', 'effort.<kind> before frontmatter');
    proj('role.implementer.effort=low\n');
    assert.equal(e('implementer', '', 'grok', ''), 'low', 'role.<r>.effort before effort.<kind>');
    proj('effort.grok=max\n');
    assert.equal(e('scouter', '', 'grok', ''), 'xhigh', 'clamped to the kind ceiling (max_effort unset)');
    // Lane effort only counts from the kind's layer up (rank 2 = project).
    proj('lane.build.kind=grok\nlane.build.effort=medium\n');
    assert.equal(e('implementer', 'build', 'grok', 2), 'medium', 'same layer as the kind');
    const user = path.join(fix.env.XDG_CONFIG_HOME, 'herdr-agents', 'config');
    fs.mkdirSync(path.dirname(user), { recursive: true });
    fs.writeFileSync(user, 'lane.build.effort=high\n');
    fs.writeFileSync(path.join(fix.repo, '.agents', 'herdr-agents.conf'), 'lane.build.kind=grok\n');
    fix.ctx = loadConfig(fix.env, fix.repo);
    assert.equal(e('implementer', 'build', 'grok', 2), 'xhigh',
      'a user lane effort under a project lane kind is dropped');
    assert.equal(e('implementer', 'build', 'grok', 0), 'high',
      'the same user lane effort applies when the kind sits in the frontmatter (layer 0)');
    // Non-ladder values pass through (validation is cmdSpawn's job).
    proj('effort.grok=huge\n');
    assert.equal(e('scouter', '', 'grok', ''), 'huge', 'not clamped, not validated');
  } finally { fix.cleanup(); }
});

// Codex models advertise their own levels in ~/.codex/models_cache.json.
function seedCodexCache(fix) {
  fs.mkdirSync(path.join(fix.env.HOME, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(fix.env.HOME, '.codex', 'models_cache.json'), JSON.stringify({
    models: [
      { slug: 'big', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'].map((effort) => ({ effort })) },
      { slug: 'small', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'].map((effort) => ({ effort })) },
    ],
  }));
}

test('resolveSpawnEffort: codex takes the ceiling of the session model', () => {
  const { fix, proj } = confFix('ha-spawn-codex-effort-');
  try {
    seedCodexCache(fix);
    proj('effort.codex=max\n');
    const e = (model) => resolveSpawnEffort('implementer', '', 'codex', '', fix.ctx, fix.env, fix.repo, model);
    assert.equal(e('big'), 'max', 'a model that advertises max keeps max');
    assert.equal(e('small'), 'xhigh', 'a model that stops at xhigh');
    assert.equal(e('not-listed'), 'xhigh', 'a model outside the cache keeps the conservative xhigh');
    assert.equal(e(''), 'xhigh', 'no model (the CLI default) keeps the conservative xhigh');
    proj('effort.codex=max\nmax_effort=high\n');
    assert.equal(e('big'), 'high', 'max_effort still applies');
  } finally { fix.cleanup(); }
});

// ---------- cmdSpawn end-to-end (child process) ----------

function runSpawn(fix, args, over = {}) {
  const env = { ...fix.env, ...over };
  delete env.HERDR_PANE_ID;
  delete env.HERDR_TAB_ID;
  return spawnSync(nodeBin(), [JS_ENTRY, 'spawn', ...args], { env, cwd: fix.repo, encoding: 'utf8', timeout: 30000 });
}

test('spawn: codex effort max reaches the CLI when the model advertises it', () => {
  const cases = [
    { model: 'big', effort: 'max', warn: null },
    { model: 'small', effort: 'xhigh', warn: "codex model small supports up to 'xhigh'; effort 'max' clamped" },
    { model: 'not-listed', effort: 'xhigh', warn: "codex model not-listed is not in ~/.codex/models_cache.json; effort 'max' clamped to 'xhigh'" },
  ];
  for (const c of cases) {
    const { fix, proj } = confFix('ha-spawn-codex-max-');
    try {
      seedCodexCache(fix);
      proj(`role.implementer.kind=codex\nrole.implementer.effort=max\nmodel.codex.worker=${c.model}\n`);
      const r = runSpawn(fix, ['implementer']);
      assert.equal(r.status, 0, r.stderr);
      const j = JSON.parse(r.stdout);
      assert.equal(j.kind, 'codex');
      assert.equal(j.effort, c.effort, `${c.model}: effort`);
      assert.ok(j.agent_args.includes(`model_reasoning_effort="${c.effort}"`), j.agent_args);
      if (c.warn) assert.ok(r.stderr.includes(c.warn), r.stderr);
      else assert.ok(!r.stderr.includes('clamped'), r.stderr);
    } finally { fix.cleanup(); }
  }
});

test('spawn: planner is 12, unknown role 3, sub-orchestrator not in a lane 3, usage 2', () => {
  const fix = makeFix('ha-spawn-cmd-1-');
  try {
    let r = runSpawn(fix, ['planner']);
    assert.equal(r.status, 12);
    assert.match(r.stderr, /planner/);
    assert.ok(!fix.logLines().includes('agent start'), 'planner starts no agent');
    r = runSpawn(fix, ['no-such-role']);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /unknown role 'no-such-role'/);
    r = runSpawn(fix, ['sub-orchestrator']);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /not in any lane \(panes=4\)/);
    r = runSpawn(fix, ['implementer', '--bogus']);
    assert.equal(r.status, 2);
    assert.equal(r.stderr, 'herdr-agents: spawn: unknown option --bogus\n');
    r = runSpawn(fix, ['implementer', '--name']);
    assert.equal(r.status, 2);
    assert.equal(r.stderr, 'herdr-agents: spawn: --name expects a value\n');
    r = runSpawn(fix, ['implementer', '--approvals', 'bogus']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /invalid approvals 'bogus'/);
    r = runSpawn(fix, ['implementer', '--effort', 'bogus']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /invalid effort 'bogus'/);
  } finally { fix.cleanup(); }
});

test('spawn: a fresh worker (layout=tab → herd tab), roster row and start args', () => {
  const fix = makeFix('ha-spawn-cmd-2-');
  try {
    fix.clearLog();
    const r = runSpawn(fix, ['implementer']);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.name, 'build');
    assert.equal(j.pane_id, 'p-new');
    assert.equal(j.kind, 'grok');
    assert.equal(j.role, 'implementer');
    assert.equal(j.family, 'xai');
    assert.equal(j.created_pane, true);
    assert.equal(j.layout, 'tab');
    assert.equal(j.placement, 'herd');
    assert.equal(j.effort, 'xhigh');
    assert.equal(j.model, 'grok-4.7');
    assert.equal(j.model_spec, 'grok');
    assert.equal(j.approvals, 'ask');
    assert.equal(j.agent_args, '--model grok-4.7 --reasoning-effort xhigh');
    assert.equal(j.status, 'ready');
    assert.ok(!('reused' in j), 'a fresh spawn has no reused key');
    const f = fix.row('build').split('\t');
    assert.equal(f[0], 'build');
    assert.equal(f[1], 'p-new');
    assert.equal(f[2], 'grok');
    assert.equal(f[3], 'implementer');
    assert.equal(f[4], 'xai');
    assert.equal(f[5], '1');
    assert.equal(f[6], fix.repo);
    assert.match(f[7], /^\d{8}T\d{6}$/);
    assert.equal(f[8], 'grok-4.7');
    assert.equal(f[9], 'ask');
    assert.equal(f[10], 'implementer');
    assert.equal(f[11], 'build');
    assert.ok(fix.logLines().includes('agent start build --kind grok --pane p-new --timeout 60000 -- --model grok-4.7 --reasoning-effort xhigh'),
      fix.logLines().join('\n'));
  } finally { fix.cleanup(); }
});

test('spawn: --pane places the worker in a given pane (placement given)', () => {
  const fix = makeFix('ha-spawn-cmd-3-');
  try {
    fix.clearLog();
    const r = runSpawn(fix, ['implementer', '--pane', 'p-x', '--name', 'solo']);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.name, 'solo');
    assert.equal(j.pane_id, 'p-x');
    assert.equal(j.created_pane, false);
    assert.equal(j.placement, 'given');
    assert.ok(fix.logLines().includes('agent start solo --kind grok --pane p-x --timeout 60000 -- --model grok-4.7 --reasoning-effort xhigh'), fix.logLines().join('\n'));
    // --tab-label is ignored with a warning when --pane is given.
    fix.live([{ name: 'solo', pane_id: 'p-x', agent_status: 'idle' }]);
    const r2 = runSpawn(fix, ['scouter', '--pane', 'p-y', '--tab-label', 'extra', '--name', 'side']);
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(r2.stderr, /--tab-label ignored: --pane places the worker in a given pane/);
    assert.equal(JSON.parse(r2.stdout).placement, 'given');
  } finally { fix.cleanup(); }
});

// scripts/test-tab-labels.sh: spawn parses --tab-label (without --pane) and
// forces the herd placement — the labelled tab is created and pinned manual.
test('spawn: --tab-label forces the herd tab and pins the label (test-tab-labels.sh)', () => {
  const fix = makeFix('ha-spawn-tablabel-');
  try {
    fix.clearLog();
    const r = runSpawn(fix, ['implementer', '--tab-label', 'paridade']);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.pane_id, 'p-new');
    assert.equal(j.layout, 'tab');
    assert.equal(j.placement, 'herd');
    assert.equal(j.created_pane, true);
    assert.ok(fix.logLines().some((l) => l.startsWith('tab create ') && l.includes('--label paridade')),
      `tab create with the label: ${fix.logLines().join('\n')}`);
    assert.equal(fix.row('build').split('\t')[3], 'implementer');
  } finally { fix.cleanup(); }
});

test('spawn: agent_not_ready → registered, JSON blocked_at_startup, screen, exit 7', () => {
  const fix = makeFix('ha-spawn-cmd-4-');
  try {
    const r = runSpawn(fix, ['implementer'], { FAKE_START_MODE: 'notready' });
    assert.equal(r.status, 7, `stderr: ${r.stderr}`);
    const j = JSON.parse(r.stdout.slice(0, r.stdout.indexOf('}') + 1));
    assert.equal(j.status, 'blocked_at_startup');
    assert.equal(j.name, 'build');
    assert.ok(r.stdout.includes('screen line 1'), 'the screen follows the JSON');
    assert.match(r.stderr, /blocked during startup/);
    assert.ok(fix.row('build') !== '', 'the worker is registered despite the block');
  } finally { fix.cleanup(); }
});

test('spawn: agent_pane_busy twice, then success (15×1s retry budget)', { timeout: 60000 }, () => {
  const fix = makeFix('ha-spawn-cmd-5-');
  try {
    const count = path.join(fix.root, 'start-count');
    fix.clearLog();
    const r = runSpawn(fix, ['implementer'], { FAKE_START_MODE: 'busy2', FAKE_START_COUNT: count });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).status, 'ready');
    const starts = fix.logLines().filter((l) => l.startsWith('agent start '));
    assert.equal(starts.length, 3, `three tries: ${fix.logLines().join('\n')}`);
  } finally { fix.cleanup(); }
});

test('entry catch: DieError with a message dies (max_workers → 8)', () => {
  const fix = makeFix('ha-spawn-cmd-6-');
  try {
    fix.writeRoster(
      'explore\tp-explore\tgrok\tscouter\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\tscouter\texplore',
      'review\tp-review\tgrok\treviewer\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\treviewer\treview',
      'extra\tp-extra\tgrok\tresearcher\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\tresearcher\textra',
    );
    fix.live([
      { name: 'explore', pane_id: 'p-explore', agent_status: 'idle' },
      { name: 'review', pane_id: 'p-review', agent_status: 'idle' },
      { name: 'extra', pane_id: 'p-extra', agent_status: 'idle' },
    ]);
    const r = runSpawn(fix, ['implementer']);
    assert.equal(r.status, 8, r.stderr);
    assert.match(r.stderr, /^herdr-agents: max_workers=3 reached \(3 live: explore review extra\)/m);
    assert.ok(!fix.logLines().includes('agent start'));
  } finally { fix.cleanup(); }
});

test('entry catch: empty-message DieError exits with the code only (herdr passthrough)', () => {
  const fix = makeFix('ha-spawn-cmd-7-');
  try {
    const r = runSpawn(fix, ['scouter'], { FAKE_LIVE_FAIL: '1' });
    assert.equal(r.status, 3, `stderr: ${r.stderr}`);
    assert.equal(r.stderr, 'herdr says no\n', 'herdr\'s own output, no die message');
    assert.ok(!r.stderr.includes('herdr-agents:'));
  } finally { fix.cleanup(); }
});

test('spawn: the lane — busy 10, --fresh 10, reuse 0 with the retargeted roster', () => {
  const fix = makeFix('ha-spawn-cmd-8-');
  try {
    // busy: the explore lane worker is working.
    fix.writeRoster('explore\tp-explore\tgrok\tscouter\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\tscouter\texplore');
    fix.live([{ name: 'explore', pane_id: 'p-explore', agent_status: 'working' }]);
    let r = runSpawn(fix, ['researcher']);
    assert.equal(r.status, 10, r.stderr);
    assert.equal(r.stdout, JSON.stringify({ status: 'busy', lane: 'explore', name: 'explore' }) + '\n');
    assert.match(r.stderr, /is busy \(working\). Run 'wait explore'/);
    // reuse with --fresh is refused (10).
    fix.live([{ name: 'explore', pane_id: 'p-explore', agent_status: 'idle' }]);
    r = runSpawn(fix, ['researcher', '--fresh']);
    assert.equal(r.status, 10, r.stderr);
    assert.equal(r.stdout, JSON.stringify({ status: 'busy', lane: 'explore', name: 'explore' }) + '\n');
    assert.match(r.stderr, /already has idle worker 'explore'. Release it before --fresh/);
    // reuse: idle worker retargeted to researcher (same kind/model/effort).
    fix.clearLog();
    r = runSpawn(fix, ['researcher']);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.name, 'explore');
    assert.equal(j.reused, true);
    assert.equal(j.role, 'researcher');
    assert.equal(j.previous_role, 'scouter');
    assert.equal(j.status, 'ready');
    assert.match(r.stderr, /reusing idle lane 'explore' worker 'explore' as researcher/);
    assert.ok(!fix.logLines().some((l) => l.startsWith('agent start')), 'reuse starts no pane');
    const f = fix.row('explore').split('\t');
    assert.equal(f[3], 'researcher');
    assert.equal(f[10], 'scouter,researcher');
  } finally { fix.cleanup(); }
});

test('spawn: kind mismatch (no lane kind) is 13 with the full hint', () => {
  const fix = makeFix('ha-spawn-cmd-9-');
  try {
    // The build lane holds a designer session on agy; implementer wants grok.
    fix.writeRoster(`build\tp-build\tagy\tdesigner\tgoogle\t1\t${fix.repo}\tnow\tgemini-2.5\tfull\tdesigner\tbuild`);
    fix.live([{ name: 'build', pane_id: 'p-build', agent_status: 'idle' }]);
    const r = runSpawn(fix, ['implementer']);
    assert.equal(r.status, 13, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.status, 'kind-mismatch');
    assert.equal(j.lane, 'build');
    assert.equal(j.name, 'build');
    assert.equal(j.session_kind, 'agy');
    assert.equal(j.requested_kind, 'grok');
    assert.equal(j.session_model, 'gemini-2.5');
    assert.equal(j.requested_model, 'grok-4.7');
    assert.equal(j.session_effort, 'high');
    assert.equal(j.requested_effort, 'xhigh');
    assert.match(r.stderr, /lane\.build\.kind.*release/s);
    assert.ok(!fix.logLines().some((l) => l.startsWith('agent start')));
    assert.equal(fix.row('build').split('\t')[3], 'designer', 'the role is not retargeted on a mismatch');
  } finally { fix.cleanup(); }
});

test('spawn: an explicit lane kind that matches the session is reused; a different CLI is 13', () => {
  const fix = makeFix('ha-spawn-cmd-10-');
  try {
    fs.mkdirSync(path.join(fix.repo, '.agents'), { recursive: true });
    const conf = path.join(fix.repo, '.agents', 'herdr-agents.conf');
    fs.writeFileSync(conf, 'lane.build.kind=grok\n');
    // live session on agy vs lane kind grok → 13 (no retarget of a live CLI).
    fix.writeRoster('build\tp-build\tagy\tdesigner\tgoogle\t1\t/tmp/work\tnow\tgemini-2.5\tfull\tdesigner\tbuild');
    fix.live([{ name: 'build', pane_id: 'p-build', agent_status: 'idle' }]);
    let r = runSpawn(fix, ['implementer']);
    assert.equal(r.status, 13, r.stderr);
    let j = JSON.parse(r.stdout);
    assert.equal(j.status, 'kind-mismatch');
    assert.equal(j.session_kind, 'agy');
    assert.equal(j.requested_kind, 'grok');
    assert.ok(!('session_model' in j), 'the lane-kind mismatch JSON has 5 keys');
    assert.match(r.stderr, /but lane\.build\.kind is grok/);
    // the live session matches the lane kind → reused.
    fix.writeRoster('build\tp-build\tgrok\tdesigner\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\tdesigner\tbuild');
    r = runSpawn(fix, ['implementer']);
    assert.equal(r.status, 0, r.stderr);
    j = JSON.parse(r.stdout);
    assert.equal(j.reused, true);
    assert.equal(j.role, 'implementer');
    assert.equal(j.kind, 'grok');
  } finally { fix.cleanup(); }
});

test('spawn: lanes=off reuses an idle worker of the same role (8-column row, --name given)', () => {
  const fix = makeFix('ha-spawn-cmd-11-');
  try {
    // 8-column row, cwd = the process cwd (like test-lanes.sh $REPO).
    fix.writeRoster(`implementer\tp-impl\tgrok\timplementer\txai\t1\t${fix.repo}\tnow`);
    fix.live([{ name: 'implementer', pane_id: 'p-impl', agent_status: 'idle' }]);
    const r = runSpawn(fix, ['implementer', '--name', 'implementer'], { HERDR_AGENTS_LANES: 'off' });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.name, 'implementer');
    assert.equal(j.reused, true);
    assert.match(r.stderr, /reusing idle worker 'implementer' \(grok, implementer\)/);
    assert.ok(!fix.logLines().some((l) => l.startsWith('agent start')));
    // a live name is refused (die 3) when a new worker would be needed.
    fix.writeRoster();
    const r2 = runSpawn(fix, ['implementer', '--name', 'implementer'], { HERDR_AGENTS_LANES: 'off' });
    assert.equal(r2.status, 3, r2.stderr);
    assert.match(r2.stderr, /agent name 'implementer' is already live/);
  } finally { fix.cleanup(); }
});

// A dead worker on the last roster line is simply not counted (bash used to
// exit 1 with no message there: live_worker_names returned the status of its
// last check under set -e; fixed in the bash, never ported).
test('enforceWorkerCap: a dead last roster worker is not counted and does not stop spawn', () => {
  const fix = makeFix('ha-spawn-capdead-');
  try {
    fix.writeRoster('solo\tp-x\tgrok\timplementer\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\timplementer');
    fix.live([]);
    assert.doesNotThrow(() => enforceWorkerCap(fix.ctx, fix.env, fix.repo));
    fix.live([{ name: 'solo', pane_id: 'p-x' }]);
    assert.doesNotThrow(() => enforceWorkerCap(fix.ctx, fix.env, fix.repo));
    fix.writeRoster();
    assert.doesNotThrow(() => enforceWorkerCap(fix.ctx, fix.env, fix.repo));
  } finally { fix.cleanup(); }
});
