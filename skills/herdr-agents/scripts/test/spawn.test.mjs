// Spawn: the `find_reusable` / `emit_reuse` units of
// test-multi-role.sh (cross-role reuse, approvals, edit history, old
// 8-column lines, `unavailable` blocking only the same role, report
// pending, cwd/kind mismatch, retarget + history), plus `uniqueName`,
// `ensureOrchestratorName`, the resolution chains (kind/effort),
// `resolveRoleSettings` (the shared flag → lane → role.<r>.* → frontmatter
// chain: the settings a flagless spawn records in the roster, flags/
// config-lane layers with their sources, and the cursor effort-suffix
// warning at spawn), and `cmdSpawn` end-to-end in a child process
// (planner 12, usage 2, the
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
import { writeFakeCli, listingFake } from './fakes.mjs';
import { loadConfig, DieError } from '../lib/config.mjs';
import { enforceWorkerCap } from '../lib/lanes.mjs';
import { resolveRoleSettings } from '../lib/resolve.mjs';
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
      // No trim: the last row's trailing empty columns (13/14) are tabs,
      // which trim would eat; the file's own reader (tsvLines) only drops
      // the final newline.
      const lines = fs.readFileSync(path.join(ws, 'agents.tsv'), 'utf8').split('\n');
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
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

// Roster column 14 records the native args the process opened with (a
// line without the column reads as ''); the live session keeps them, so a
// config or session change after the spawn cannot silently swap the
// worker's args — reuse only when the column equals the args this spawn
// would build now (args.<kind> + role.<role>.args).
test('findReusable: the roster column 14 (the args the worker opened with) gates reuse', () => {
  const fix = makeFix('ha-spawn-reuse-col14-');
  try {
    // 14-column line: column 13 (burst) empty, column 14 the args.
    const row = (args) => `scout\tp-scout\tgrok\tscouter\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\tscouter\t\t\t${args}`;
    const withImplArgs = { HERDR_AGENTS_ROLE_IMPLEMENTER_ARGS: '-r x' };
    // Old line without the column reads as '': an empty request reuses, a
    // request with args does not.
    fix.writeRoster('scout\tp-scout\tgrok\tscouter\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\tscouter');
    assert.deepEqual(reuse(fix, 'implementer', 'grok', '', 'grok-4.7', 'full'), { name: 'scout' }, 'old line, empty request');
    fix.writeRoster('scout\tp-scout\tgrok\tscouter\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\tscouter');
    assert.equal(reuse(fix, 'implementer', 'grok', '', 'grok-4.7', 'full', { ...fix.env, ...withImplArgs }), null, 'old line, args requested');
    // Column 14 '' (the worker opened without args): args requested now → no reuse.
    fix.writeRoster(row(''));
    assert.equal(reuse(fix, 'implementer', 'grok', '', 'grok-4.7', 'full', { ...fix.env, ...withImplArgs }), null, 'column empty, args requested');
    // Column 14 with args and an empty request → no reuse.
    fix.writeRoster(row('-r x'));
    assert.equal(reuse(fix, 'implementer', 'grok', '', 'grok-4.7', 'full'), null, 'column has args, empty request');
    // Equal column and request: the role args, and args.<kind> + role args
    // combined (args.<kind> tokens first).
    fix.writeRoster(row('-r x'));
    assert.deepEqual(reuse(fix, 'implementer', 'grok', '', 'grok-4.7', 'full', { ...fix.env, ...withImplArgs }), { name: 'scout' }, 'role args equal');
    fix.writeRoster(row('-k y -r x'));
    assert.deepEqual(reuse(fix, 'implementer', 'grok', '', 'grok-4.7', 'full', { ...fix.env, HERDR_AGENTS_ARGS_GROK: '-k y', HERDR_AGENTS_ROLE_IMPLEMENTER_ARGS: '-r x' }), { name: 'scout' }, 'kind + role args equal');
    // Different column and request → no reuse, the same role included.
    fix.writeRoster(row('-r x'));
    assert.equal(reuse(fix, 'implementer', 'grok', '', 'grok-4.7', 'full', { ...fix.env, HERDR_AGENTS_ROLE_IMPLEMENTER_ARGS: '-r y' }), null, 'role args differ');
    fix.writeRoster('impl\tp-impl\tgrok\timplementer\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\timplementer\t\t\t-r x');
    assert.equal(reuse(fix, 'implementer', 'grok', '', 'grok-4.7', 'full'), null, 'same role, column has args, empty request');
    fix.writeRoster('impl\tp-impl\tgrok\timplementer\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\timplementer\t\t\t-r x');
    assert.deepEqual(reuse(fix, 'implementer', 'grok', '', 'grok-4.7', 'full', { ...fix.env, ...withImplArgs }), { name: 'impl' }, 'same role, equal');
    // Mutation captured: comparing the current configuration instead of
    // the roster column (the "column has args, empty request" and "column
    // empty, args requested" cases would flip).
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

test('findReusable: the same role — the recorded model and approvals must line up', () => {
  const fix = makeFix('ha-spawn-reuse-model-');
  try {
    // Another recorded model: not reused even for the same role.
    fix.add('impl\tp-impl\tgrok\timplementer\txai\t1\t/tmp/work\tnow\tgrok-4\tfull\timplementer');
    assert.equal(reuse(fix, 'implementer', 'grok', '', 'grok-4.7', 'full'), null, 'another model');
    // The same model: reused.
    fix.writeRoster('impl\tp-impl\tgrok\timplementer\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\timplementer');
    assert.deepEqual(reuse(fix, 'implementer', 'grok', '', 'grok-4.7', 'full'), { name: 'impl' }, 'same model');
    // '' only matches '': a blank recorded model never satisfies a model.
    fix.writeRoster('impl\tp-impl\tgrok\timplementer\txai\t1\t/tmp/work\tnow\t\tfull\timplementer');
    assert.equal(reuse(fix, 'implementer', 'grok', '', 'grok-4.7', 'full'), null, 'recorded "" vs requested model');
    assert.deepEqual(reuse(fix, 'implementer', 'grok', '', '', 'ask'), { name: 'impl' }, '"" matches ""');
    // Approvals rank ≥ the request ('ask' when the request is empty).
    fix.writeRoster('impl\tp-impl\tgrok\timplementer\txai\t1\t/tmp/work\tnow\tgrok-4.7\task\timplementer');
    assert.equal(reuse(fix, 'implementer', 'grok', '', 'grok-4.7', 'full'), null, 'below');
    assert.deepEqual(reuse(fix, 'implementer', 'grok', '', 'grok-4.7', 'ask'), { name: 'impl' }, 'equal');
    fix.writeRoster('impl\tp-impl\tgrok\timplementer\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\timplementer');
    assert.deepEqual(reuse(fix, 'implementer', 'grok', '', 'grok-4.7', 'ask'), { name: 'impl' }, 'above');
    // Old 8-column rows: kind and cwd only, as before.
    fix.writeRoster('impl\tp-impl\tgrok\timplementer\txai\t1\t/tmp/work\tnow');
    assert.deepEqual(reuse(fix, 'implementer', 'grok', '', 'grok-4.7', 'full'), { name: 'impl' }, '8-column');
    // Mutation captured: the model ignored for the same role (the first case
    // would reuse), the approvals rank inverted (below would reuse), or the
    // 8-column rows being checked against the model.
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

// resolveRoleSettings vs cmdSpawn: the same role, the same values — the
// function's settings are what a flagless spawn records (kind/model/
// approvals/lane in the roster, kind/model spec/effort in the JSON).
test('resolveRoleSettings: matches what a flagless spawn records in the roster', () => {
  const fix = makeFix('ha-spawn-resolve-');
  try {
    const res = resolveRoleSettings('implementer', fix.ctx, fix.env, fix.repo);
    assert.deepEqual(res, {
      lane: 'build', kind: 'grok', kindFrom: 'role file',
      modelSpec: 'grok', modelFrom: 'model.grok.worker (defaults)',
      effort: 'xhigh', effortFrom: 'effort.grok (defaults)',
      approvals: 'ask', approvalsFrom: 'approvals (defaults)',
      kindLayer: 0,
    });
    const r = runSpawn(fix, ['implementer']);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.kind, res.kind);
    assert.equal(j.model_spec, res.modelSpec);
    assert.equal(j.effort, res.effort);
    assert.equal(j.approvals, res.approvals);
    const f = fix.row('build').split('\t');
    assert.equal(f[2], res.kind, 'roster kind');
    assert.equal(f[8], j.model, 'roster model is the resolved spec');
    assert.equal(f[9], res.approvals, 'roster approvals');
    assert.equal(f[11], res.lane, 'roster lane');
    // Mutation captured: the spawn keeping its own copy of the chain (a
    // divergence from the shared resolution) or a roster column that stops
    // tracking the resolved model.
  } finally { fix.cleanup(); }
});

test('resolveRoleSettings: flags, config layers and lane layers decide, with the source', () => {
  const { fix, proj } = confFix('ha-spawn-resolve-layers-');
  try {
    // Flags beat the config layers.
    const fl = resolveRoleSettings('implementer', fix.ctx, fix.env, fix.repo,
      { kind: 'cursor', model: 'm1', effort: 'low', approvals: 'full' });
    assert.deepEqual([fl.kind, fl.kindFrom], ['cursor', 'flag']);
    assert.deepEqual([fl.modelSpec, fl.modelFrom], ['m1', 'flag']);
    assert.deepEqual([fl.effort, fl.effortFrom], ['low', 'flag']);
    assert.deepEqual([fl.approvals, fl.approvalsFrom], ['full', 'flag']);
    // role.<r>.* in a layer beats the frontmatter; a lane effort under the
    // kind's layer is dropped (the frontmatter effort decides).
    const user = path.join(fix.env.XDG_CONFIG_HOME, 'herdr-agents', 'config');
    fs.mkdirSync(path.dirname(user), { recursive: true });
    fs.writeFileSync(user, 'lane.build.effort=high\n');
    proj('role.implementer.kind=pi\nrole.implementer.model=my-provider/my-model\n');
    const res = resolveRoleSettings('implementer', fix.ctx, fix.env, fix.repo);
    assert.equal(res.kind, 'pi');
    assert.equal(res.kindFrom, 'role config (project)');
    assert.equal(res.modelSpec, 'my-provider/my-model');
    assert.equal(res.modelFrom, 'role config (project)');
    assert.equal(res.kindLayer, 2);
    assert.equal(res.effort, 'xhigh', 'the user lane effort under the project kind is dropped');
    assert.equal(res.effortFrom, 'role file');
    // The same lane effort at the kind's own layer counts.
    proj('role.implementer.kind=pi\nrole.implementer.model=my-provider/my-model\nlane.build.effort=xhigh\n');
    const res2 = resolveRoleSettings('implementer', fix.ctx, fix.env, fix.repo);
    assert.equal(res2.effort, 'xhigh');
    assert.equal(res2.effortFrom, 'lane build (project)');
    // lane.<l>.kind decides the kind (and its layer is the reference rank).
    proj('lane.build.kind=pi\n');
    const res3 = resolveRoleSettings('implementer', fix.ctx, fix.env, fix.repo);
    assert.equal(res3.kind, 'pi');
    assert.equal(res3.kindFrom, 'lane build (project)');
    assert.equal(res3.kindLayer, 2);
    // Nothing set for pi: the model falls through to 'default'.
    assert.equal(res3.modelSpec, '');
    assert.equal(res3.modelFrom, 'default');
    // Mutation captured: a flag losing to a config layer, a lane model/effort
    // below the kind layer being counted, or a *From that names the wrong
    // source/layer.
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

// `session set` in the same fixture (the session layer a spawn reads next).
function runSession(fix, args, over = {}) {
  const env = { ...fix.env, ...over };
  delete env.HERDR_PANE_ID;
  delete env.HERDR_TAB_ID;
  return spawnSync(nodeBin(), [JS_ENTRY, 'session', 'set', ...args], { env, cwd: fix.repo, encoding: 'utf8', timeout: 30000 });
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

test('spawn: a cursor model that already encodes the effort — silent; another effort — warns', () => {
  const fix = makeFix('ha-spawn-cursor-warn-');
  try {
    // A listing with suffixed ids only: `grok-4.7` resolves to the
    // xhigh-suffixed id, which then matches the requested effort.
    writeFakeCli(path.join(fix.root, 'bin'), 'cursor-agent',
      listingFake('--list-models', ['grok-4.7-xhigh - X', 'grok-4.7-high - X']));
    const r = runSpawn(fix, ['implementer', '--kind', 'cursor', '--model', 'grok-4.7', '--effort', 'xhigh']);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.model, 'grok-4.7-xhigh');
    assert.equal(j.agent_args, '--model grok-4.7-xhigh');
    assert.ok(!r.stderr.includes('already encodes'), `matching suffix warns nothing: ${r.stderr}`);
    // A model that already encodes another effort: the new warning names
    // both efforts. --pane skips the lane reuse (the warning is printed at
    // the agent-args build, which reuse never reaches).
    const r2 = runSpawn(fix, ['implementer', '--kind', 'cursor', '--model', 'grok-4.7-high', '--effort', 'xhigh', '--pane', 'p-z', '--name', 'second']);
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(JSON.parse(r2.stdout).model, 'grok-4.7-high');
    assert.ok(r2.stderr.includes("cursor model 'grok-4.7-high' already encodes effort 'high'; --effort xhigh ignored"), r2.stderr);
    // Mutation captured: the redundant warning on a matching suffix
    // or the old message without the encoded effort named.
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

test('spawn: the build lane — capacity 2: open build-2, busy 10 when full, --fresh, reuse', () => {
  const fix = makeFix('ha-spawn-cmd-8-');
  try {
    // (a) panes=4: the build lane holds 2 workers. One occupied worker
    // leaves room: the spawn opens build-2 instead of refusing.
    fix.writeRoster('build\tp-build\tgrok\timplementer\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\timplementer\tbuild');
    fix.live([{ name: 'build', pane_id: 'p-build', agent_status: 'working' }]);
    let r = runSpawn(fix, ['tasker']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).name, 'build-2', 'the second worker of the lane');
    assert.equal(fix.row('build-2').split('\t')[11], 'build', 'column 12 is the lane');
    // Two occupied workers: the third spawn is busy 10 with the full message.
    fix.live([
      { name: 'build', pane_id: 'p-build', agent_status: 'working' },
      { name: 'build-2', pane_id: 'p-build2', agent_status: 'blocked' },
    ]);
    r = runSpawn(fix, ['tasker']);
    assert.equal(r.status, 10, r.stderr);
    assert.equal(r.stdout, JSON.stringify({ status: 'busy', lane: 'build', name: 'build' }) + '\n');
    assert.match(r.stderr, /lane 'build' is full \(2 of 2: build build-2\). Run 'wait build'/);

    // (b) one idle worker → reuse without opening a pane (retargeted roster).
    fix.writeRoster('build\tp-build\tgrok\timplementer\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\timplementer\tbuild');
    fix.live([{ name: 'build', pane_id: 'p-build', agent_status: 'idle' }]);
    fix.clearLog();
    r = runSpawn(fix, ['tasker']);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.name, 'build');
    assert.equal(j.reused, true);
    assert.equal(j.role, 'tasker');
    assert.equal(j.previous_role, 'implementer');
    assert.equal(j.status, 'ready');
    assert.match(r.stderr, /reusing idle lane 'build' worker 'build' as tasker/);
    assert.ok(!fix.logLines().some((l) => l.startsWith('agent start')), 'reuse starts no pane');
    const f = fix.row('build').split('\t');
    assert.equal(f[3], 'tasker');
    assert.equal(f[10], 'implementer,tasker');

    // (d) --fresh with room → a new pane (build-2), not the idle worker.
    fix.writeRoster('build\tp-build\tgrok\timplementer\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\timplementer\tbuild');
    fix.live([{ name: 'build', pane_id: 'p-build', agent_status: 'idle' }]);
    fix.clearLog();
    r = runSpawn(fix, ['tasker', '--fresh']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).name, 'build-2');
    assert.ok(fix.logLines().some((l) => l.startsWith('agent start build-2 ')), fix.logLines().join('\n'));
    // --fresh with a full lane → today's busy (the idle worker named).
    fix.writeRoster(
      'build\tp-build\tgrok\timplementer\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\timplementer\tbuild',
      'build-2\tp-build2\tgrok\ttasker\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\ttasker\tbuild',
    );
    fix.live([
      { name: 'build', pane_id: 'p-build', agent_status: 'idle' },
      { name: 'build-2', pane_id: 'p-build2', agent_status: 'working' },
    ]);
    r = runSpawn(fix, ['tasker', '--fresh']);
    assert.equal(r.status, 10, r.stderr);
    assert.equal(r.stdout, JSON.stringify({ status: 'busy', lane: 'build', name: 'build' }) + '\n');
    assert.match(r.stderr, /already has idle worker 'build'. Release it before --fresh/);
    // Mutation captured: the capacity ignored (the first spawn would be busy
    // instead of opening build-2), or --fresh reusing the idle worker.
  } finally { fix.cleanup(); }
});

test('spawn: a gone lane worker is removed and the lane opens a new pane', () => {
  const fix = makeFix('ha-spawn-cmd-8b-');
  try {
    // The worker named 'gone' (herdr agent get → agent_not_found) holds the
    // lane column: it is removed and never counts against the capacity.
    fix.writeRoster('gone\tp-gone\tgrok\timplementer\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\timplementer\tbuild');
    fix.live([]);
    fix.clearLog();
    const r = runSpawn(fix, ['implementer']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).name, 'build');
    assert.match(r.stderr, /lane 'build' worker 'gone' is gone; opening a new pane/);
    assert.equal(fix.row('gone'), '', 'the gone row was removed');
    assert.equal(fix.row('build').split('\t')[11], 'build');
    assert.ok(fix.logLines().some((l) => l.startsWith('agent start build ')), fix.logLines().join('\n'));
    // Mutation captured: the gone row kept (or counted as live, capping the
    // lane) instead of being removed and bypassed.
  } finally { fix.cleanup(); }
});

test('spawn: the temporary (burst) worker — flex only, flex_roles, capped by flex_extra', () => {
  const fix = makeFix('ha-spawn-burst-');
  try {
    fs.mkdirSync(path.join(fix.repo, '.agents'), { recursive: true });
    const conf = path.join(fix.repo, '.agents', 'herdr-agents.conf');
    // (a) flex, panes=4: the docs lane holds no resident worker (capacity
    // 0). The documenter opens a temporary (burst) worker.
    fs.writeFileSync(conf, 'pane_mode=flex\n');
    fix.writeRoster();
    fix.live([]);
    fix.clearLog();
    let r = runSpawn(fix, ['documenter']);
    assert.equal(r.status, 0, r.stderr);
    let j = JSON.parse(r.stdout);
    assert.equal(j.name, 'docs');
    assert.equal(j.burst, true, 'the JSON marks the temporary worker');
    let f = fix.row('docs').split('\t');
    assert.equal(f[12], 'burst', 'roster column 13 is the burst marker');
    assert.equal(f.length, 14, 'the burst row has 14 columns (13 present even when empty)');
    assert.equal(f[13], '', 'column 14 is the native args (none here)');
    assert.equal(f[11], 'docs', 'the lane column is the docs lane');
    // (b) the strict mode (the default) never opens a burst: the documenter
    // sits in the build lane, and a full build lane is busy 10.
    fs.writeFileSync(conf, '');
    fix.writeRoster(
      'build\tp-build\tgrok\timplementer\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\timplementer\tbuild',
      'build-2\tp-build2\tgrok\ttasker\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\ttasker\tbuild',
    );
    fix.live([
      { name: 'build', pane_id: 'p-build', agent_status: 'working' },
      { name: 'build-2', pane_id: 'p-build2', agent_status: 'working' },
    ]);
    r = runSpawn(fix, ['documenter']);
    assert.equal(r.status, 10, r.stderr);
    assert.equal(r.stdout, JSON.stringify({ status: 'busy', lane: 'build', name: 'build' }) + '\n');
    assert.match(r.stderr, /lane 'build' is full \(2 of 2: build build-2\)/);
    // (c) flex: a full review lane (capacity 1, no idle) opens a temporary
    // reviewer (the reviewer is a default flex role).
    fs.writeFileSync(conf, 'pane_mode=flex\n');
    fix.writeRoster('review\tp-review\tgrok\treviewer\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\treviewer\treview');
    fix.live([{ name: 'review', pane_id: 'p-review', agent_status: 'working' }]);
    fix.clearLog();
    r = runSpawn(fix, ['reviewer']);
    assert.equal(r.status, 0, r.stderr);
    j = JSON.parse(r.stdout);
    assert.equal(j.name, 'review-2');
    assert.equal(j.burst, true);
    f = fix.row('review-2').split('\t');
    assert.equal(f[12], 'burst');
    // (d) the cap: one temporary worker already live, flex_extra=1 (the
    // default) — the burst slot is taken, the lane is busy 10.
    fix.writeRoster('review\tp-review\tgrok\treviewer\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\treviewer\treview',
      'review-2\tp-review2\tgrok\treviewer\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\treviewer\treview\tburst');
    fix.live([
      { name: 'review', pane_id: 'p-review', agent_status: 'working' },
      { name: 'review-2', pane_id: 'p-review2', agent_status: 'working' },
    ]);
    r = runSpawn(fix, ['reviewer']);
    assert.equal(r.status, 10, r.stderr);
    assert.equal(r.stdout, JSON.stringify({ status: 'busy', lane: 'review', name: 'review' }) + '\n');
    assert.match(r.stderr, /lane 'review' is full \(2 of 1: review review-2\)/);
    // flex_extra=2 opens the second temporary worker.
    fs.writeFileSync(conf, 'pane_mode=flex\nflex_extra=2\n');
    fix.clearLog();
    r = runSpawn(fix, ['reviewer']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).burst, true);
    // (e) a role outside flex_roles may not use the temporary panel: the
    // capacity-0 docs lane refuses it with the role message (busy 10).
    fs.writeFileSync(conf, 'pane_mode=flex\nflex_roles=reviewer\n');
    fix.writeRoster();
    fix.live([]);
    r = runSpawn(fix, ['documenter']);
    assert.equal(r.status, 10, r.stderr);
    assert.equal(r.stdout, JSON.stringify({ status: 'busy', lane: 'docs', name: '' }) + '\n');
    assert.match(r.stderr, /role 'documenter' may not use the temporary panel \(flex_roles=reviewer\)/);
    // (f) flex_extra=0: no temporary panel at all (the lane message with
    // no live temporary workers).
    fs.writeFileSync(conf, 'pane_mode=flex\nflex_extra=0\n');
    r = runSpawn(fix, ['documenter']);
    assert.equal(r.status, 10, r.stderr);
    assert.match(r.stderr, /lane 'docs' only takes a temporary worker \(pane_mode=flex\) and none is free: flex_extra=0, live temporary workers: none\. Raise flex_extra\./);
    // (f2) the burst slot is taken by a live temporary worker: the lane
    // message lists them (all lanes) and names the first one for release.
    fs.writeFileSync(conf, 'pane_mode=flex\n');
    fix.writeRoster(
      'docs\tp-docs\tgrok\tdocumenter\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\tdocumenter\tdocs\tburst',
      'review-2\tp-review2\tgrok\treviewer\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\treviewer\treview\tburst',
    );
    fix.live([
      { name: 'docs', pane_id: 'p-docs', agent_status: 'working' },
      { name: 'review-2', pane_id: 'p-review2', agent_status: 'working' },
    ]);
    r = runSpawn(fix, ['documenter']);
    assert.equal(r.status, 10, r.stderr);
    assert.equal(r.stdout, JSON.stringify({ status: 'busy', lane: 'docs', name: 'docs' }) + '\n');
    assert.match(r.stderr, /lane 'docs' only takes a temporary worker \(pane_mode=flex\) and none is free: flex_extra=1, live temporary workers: docs, review-2\. Release one \(release docs\), or raise flex_extra\./);
    // (g) an idle temporary worker is reused, not re-burst: the docs lane
    // with an idle burst documenter reuses it (no new pane, no burst key).
    fs.writeFileSync(conf, 'pane_mode=flex\n');
    fix.writeRoster('docs\tp-docs\tgrok\tdocumenter\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\tdocumenter\tdocs\tburst');
    fix.live([{ name: 'docs', pane_id: 'p-docs', agent_status: 'idle' }]);
    fix.clearLog();
    r = runSpawn(fix, ['documenter', '--kind', 'grok']);
    assert.equal(r.status, 0, r.stderr);
    j = JSON.parse(r.stdout);
    assert.equal(j.name, 'docs');
    assert.equal(j.reused, true);
    assert.ok(!('burst' in j), 'a reuse is not a burst');
    assert.ok(!fix.logLines().some((l) => l.startsWith('agent start')), 'reuse starts no pane');
    // (h) a custom lane whose max_workers was written as the capacity sum
    // (the old lane-file write): the burst hits the global cap (exit 8);
    // with the sum + flex_extra the lane file now writes, it opens.
    fs.writeFileSync(conf, 'pane_mode=flex\nlane.ops.roles=implementer,tasker,documenter\nlane.ops.panes=1\nmax_workers=1\n');
    fix.writeRoster('ops\tp-ops\tgrok\timplementer\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\timplementer\tops');
    fix.live([{ name: 'ops', pane_id: 'p-ops', agent_status: 'working' }]);
    r = runSpawn(fix, ['documenter']);
    assert.equal(r.status, 8, r.stderr);
    assert.match(r.stderr, /max_workers=1 reached \(1 live: ops\)/);
    fs.writeFileSync(conf, 'pane_mode=flex\nlane.ops.roles=implementer,tasker,documenter\nlane.ops.panes=1\nmax_workers=2\n');
    fix.clearLog();
    r = runSpawn(fix, ['documenter']);
    assert.equal(r.status, 0, r.stderr);
    j = JSON.parse(r.stdout);
    assert.equal(j.name, 'ops-2');
    assert.equal(j.burst, true);
    // Mutation captured: a burst in the strict mode, the flex_roles or the
    // live temporary workers ignored by the cap, the burst row missing the
    // 13th column (or a plain row gaining it), the burst dying on the
    // worker cap once the capacity sum fills (the lane file written
    // max_workers without the flex_extra slot), or the idle burst worker
    // opened instead of reused.
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
    // A live --name is not refused anymore: it takes a unique suffix
    // (a taken name gets a suffix) and the warning lands in the friction log; the JSON
    // and the start args carry the real name.
    fix.writeRoster();
    fix.clearLog();
    const r2 = runSpawn(fix, ['implementer', '--name', 'implementer'], { HERDR_AGENTS_LANES: 'off' });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(JSON.parse(r2.stdout).name, 'implementer-2', 'the suffixed name is real');
    assert.match(r2.stderr, /agent name 'implementer' is taken by another pane or workspace; using 'implementer-2'/);
    assert.ok(fix.logLines().some((l) => l.startsWith('agent start implementer-2 ')), fix.logLines().join('\n'));
    // An invalid --name still dies 2.
    const r3 = runSpawn(fix, ['implementer', '--name', 'Bad_Name'], { HERDR_AGENTS_LANES: 'off' });
    assert.equal(r3.status, 2, r3.stderr);
    assert.match(r3.stderr, /invalid agent name 'Bad_Name'/);
    // Mutation captured: the live --name dying 3 instead of being suffixed,
    // or the suffix missing from the JSON / the start args / the warning.
  } finally { fix.cleanup(); }
});

test('spawn: panes=2 — the review roles have no lane (exit 3, the orchestrator reviews)', () => {
  const fix = makeFix('ha-spawn-panes2-');
  try {
    fs.mkdirSync(path.join(fix.repo, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(fix.repo, '.agents', 'herdr-agents.conf'), 'panes=2\n');
    let r = runSpawn(fix, ['reviewer']);
    assert.equal(r.status, 3, r.stderr);
    assert.equal(r.stderr,
      "herdr-agents: spawn: with panes=2 the orchestrator reviews (pick its model family by hand); role 'reviewer' has no lane. Use panes=3 or 4, or pane_mode=flex for a temporary reviewer.\n");
    // The other lane-less roles keep today's message.
    r = runSpawn(fix, ['sub-orchestrator']);
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /not in any lane \(panes=2\)/);
    // The build lane still spawns at panes=2 (scouter lives there now).
    r = runSpawn(fix, ['scouter']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).name, 'build');
    // Mutation captured: the panes=2 message on every lane-less role (the
    // sub-orchestrator would get it too), or the build lane missing at
    // panes=2.
  } finally { fix.cleanup(); }
});

test('spawn: lanes=off — the same role on another recorded model spawns a new worker', () => {
  const fix = makeFix('ha-spawn-cmd-13-');
  try {
    fix.writeRoster(`implementer\tp-impl\tgrok\timplementer\txai\t1\t${fix.repo}\tnow\tgrok-4\tfull\timplementer`);
    fix.live([{ name: 'implementer', pane_id: 'p-impl', agent_status: 'idle' }]);
    const r = runSpawn(fix, ['implementer'], { HERDR_AGENTS_LANES: 'off' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).name, 'implementer-2', 'the other-model worker is not reused');
    // The same recorded model is reused.
    fix.writeRoster(`implementer\tp-impl\tgrok\timplementer\txai\t1\t${fix.repo}\tnow\tgrok-4.7\tfull\timplementer`);
    fix.clearLog();
    const r2 = runSpawn(fix, ['implementer'], { HERDR_AGENTS_LANES: 'off' });
    assert.equal(r2.status, 0, r2.stderr);
    const j = JSON.parse(r2.stdout);
    assert.equal(j.name, 'implementer');
    assert.equal(j.reused, true);
    assert.ok(!fix.logLines().some((l) => l.startsWith('agent start')), 'reuse starts no pane');
    // Mutation captured: the recorded model ignored (the first spawn would
    // reuse the other-model worker).
  } finally { fix.cleanup(); }
});

// The agent_args assembly order: the skill's own args (kind context/
// approvals/model/effort), then args.<kind>, then the lane args when the
// worker opens in a lane or the role args when it opens outside one, and
// finally the args after `--`.
test('spawn: the agent args order — skill args, args.<kind>, role args, then --', () => {
  const { fix, proj } = confFix('ha-spawn-args-order-');
  try {
    proj('lanes=off\nargs.grok=--kind-extra\nrole.implementer.args=-r impl\n');
    fix.clearLog();
    const r = runSpawn(fix, ['implementer', '--', '-n', 'one', '-n', 'two'], { HERDR_AGENTS_LANES: 'off' });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.agent_args, '--model grok-4.7 --reasoning-effort xhigh --kind-extra -r impl -n one -n two', j.agent_args);
    assert.ok(fix.logLines().includes('agent start implementer --kind grok --pane p-new --timeout 60000 -- --model grok-4.7 --reasoning-effort xhigh --kind-extra -r impl -n one -n two'),
      fix.logLines().join('\n'));
    // Mutation captured: the order swapped between args.<kind> and the
    // role/lane args (the agent_args string would carry -r impl before
    // --kind-extra), or the `--` args landing before the config args.
  } finally { fix.cleanup(); }
});

test('spawn: lanes=off — role.<role>.args reaches only that role', () => {
  const { fix, proj } = confFix('ha-spawn-role-args-');
  try {
    proj('lanes=off\nrole.implementer.args=-c sandbox_workspace_write.network_access=true\n');
    fix.clearLog();
    const r = runSpawn(fix, ['implementer'], { HERDR_AGENTS_LANES: 'off' });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.agent_args, '--model grok-4.7 --reasoning-effort xhigh -c sandbox_workspace_write.network_access=true', j.agent_args);
    // The other role gets the same skill args and none of the role args.
    fix.clearLog();
    const r2 = runSpawn(fix, ['scouter', '--fresh'], { HERDR_AGENTS_LANES: 'off' });
    assert.equal(r2.status, 0, r2.stderr);
    const j2 = JSON.parse(r2.stdout);
    assert.equal(j2.agent_args, '--model grok-4.7 --reasoning-effort xhigh', 'the other role gets no role args');
  } finally { fix.cleanup(); }
});

test('spawn: lanes on — lane.<lane>.args reaches every worker of the lane; role args stay ignored', () => {
  const { fix, proj } = confFix('ha-spawn-lane-args-');
  try {
    proj([
      'lane.build.roles=implementer',
      'lane.build.kind=grok',
      'lane.review.roles=reviewer,inspector',
      'lane.review.kind=grok',
      'lane.review.panes=2',
      'lane.review.args=-l review',
      'role.reviewer.args=-r reviewer',
    ].join('\n'));
    fix.clearLog();
    // build lane: no lane args and no role args inside a lane.
    let r = runSpawn(fix, ['implementer']);
    assert.equal(r.status, 0, r.stderr);
    let j = JSON.parse(r.stdout);
    assert.equal(j.name, 'build');
    assert.equal(j.agent_args, '--model grok-4.7 --reasoning-effort xhigh', 'the build lane gets no review args');
    // review lane: the lane args reach every worker of the lane, the
    // per-role key never applies inside one.
    r = runSpawn(fix, ['reviewer']);
    assert.equal(r.status, 0, r.stderr);
    j = JSON.parse(r.stdout);
    assert.equal(j.name, 'review');
    assert.equal(j.agent_args, '--model grok-4.7 --reasoning-effort xhigh -l review', j.agent_args);
    assert.ok(!j.agent_args.includes('-r reviewer'), 'role args are ignored inside a lane');
    fix.live([{ name: 'review', pane_id: 'p-review', agent_status: 'working' }]);
    fix.clearLog();
    r = runSpawn(fix, ['inspector']);
    assert.equal(r.status, 0, r.stderr);
    j = JSON.parse(r.stdout);
    assert.equal(j.name, 'review-2', 'the second worker of the lane');
    assert.equal(j.agent_args, '--model grok-4.7 --reasoning-effort xhigh -l review', 'every worker of the lane gets the lane args');
    // Mutation captured: the role args applied inside a lane (the review
    // agent_args would carry -r reviewer), or the lane args missing from a
    // worker of the lane.
  } finally { fix.cleanup(); }
});

test('spawn: lanes=off — a worker opened with different native args is not reused; equal args are', () => {
  const { fix, proj } = confFix('ha-spawn-reuse-args-');
  try {
    const row = `impl\tp-impl\tgrok\timplementer\txai\t1\t${fix.repo}\tnow\tgrok-4.7\tfull\timplementer`;
    const row14 = (args) => `impl\tp-impl\tgrok\timplementer\txai\t1\t${fix.repo}\tnow\tgrok-4.7\tfull\timplementer\t\t\t${args}`;
    proj('lanes=off\nrole.scouter.args=-r scout\n');
    // The idle implementer opened without native args (no column 14); the
    // scouter wants -r scout: not borrowed, a fresh scouter opens with the
    // role args.
    fix.writeRoster(row);
    fix.live([{ name: 'impl', pane_id: 'p-impl', agent_status: 'idle' }]);
    fix.clearLog();
    let r = runSpawn(fix, ['scouter'], { HERDR_AGENTS_LANES: 'off' });
    assert.equal(r.status, 0, r.stderr);
    let j = JSON.parse(r.stdout);
    assert.equal(j.name, 'scouter', 'a different-args worker is not reused');
    assert.ok(!('reused' in j), 'a fresh spawn has no reused key');
    assert.equal(j.agent_args, '--model grok-4.7 --reasoning-effort xhigh -r scout', j.agent_args);
    assert.ok(fix.logLines().some((l) => l.startsWith('agent start scouter ')), fix.logLines().join('\n'));
    // The idle implementer opened with -r x (column 14) and the scouter
    // wants -r x now: reused — and the rewrite (the role swap) keeps the
    // column.
    proj('lanes=off\nrole.scouter.args=-r x\n');
    fix.writeRoster(row14('-r x'));
    fix.live([{ name: 'impl', pane_id: 'p-impl', agent_status: 'idle' }]);
    fix.clearLog();
    r = runSpawn(fix, ['scouter'], { HERDR_AGENTS_LANES: 'off' });
    assert.equal(r.status, 0, r.stderr);
    j = JSON.parse(r.stdout);
    assert.equal(j.name, 'impl');
    assert.equal(j.reused, true);
    assert.equal(j.previous_role, 'implementer');
    const f = fix.row('impl').split('\t');
    assert.equal(f.length, 14, 'the rewritten row keeps 14 columns');
    assert.equal(f[13], '-r x', 'the rewritten row keeps the args column');
    assert.ok(!fix.logLines().some((l) => l.startsWith('agent start')), 'reuse starts no pane');
    // Mutation captured: the reuse comparing the current configuration
    // (instead of column 14) — the first spawn would reuse the idle
    // implementer — or the role-swap rewrite dropping the column.
  } finally { fix.cleanup(); }
});

test('spawn: the roster records the native args (column 14) the spawn used', () => {
  const { fix, proj } = confFix('ha-spawn-col14-');
  try {
    // lanes=off: role args → column 14; column 13 present even when empty.
    proj('lanes=off\nargs.grok=--kind-extra\nrole.implementer.args=-r impl\n');
    fix.clearLog();
    let r = runSpawn(fix, ['implementer'], { HERDR_AGENTS_LANES: 'off' });
    assert.equal(r.status, 0, r.stderr);
    let f = fix.row(JSON.parse(r.stdout).name).split('\t');
    assert.equal(f.length, 14, 'the row has 14 columns');
    assert.equal(f[12], '', 'column 13 is present (not a burst)');
    assert.equal(f[13], '--kind-extra -r impl', 'column 14 is args.<kind> then role args');
    // No args configured: column 14 is empty.
    proj('lanes=off\n');
    r = runSpawn(fix, ['scouter'], { HERDR_AGENTS_LANES: 'off' });
    assert.equal(r.status, 0, r.stderr);
    f = fix.row(JSON.parse(r.stdout).name).split('\t');
    assert.equal(f.length, 14, 'the row has 14 columns');
    assert.equal(f[13], '', 'no native args → empty column 14');
    // lanes on: lane args → column 14 for every worker of the lane.
    proj('lane.build.roles=implementer\nlane.build.kind=grok\nlane.build.args=-l build\n');
    r = runSpawn(fix, ['implementer']);
    assert.equal(r.status, 0, r.stderr);
    f = fix.row(JSON.parse(r.stdout).name).split('\t');
    assert.equal(f[13], '-l build', 'column 14 is the lane args');
    // Mutation captured: the column not recorded (or column 13 missing
    // when empty) at the spawn.
  } finally { fix.cleanup(); }
});

test('spawn: a session set after the spawn blocks the reuse', (t) => {
  // Same role: the worker opened without args; a session-layer role arg
  // afterwards makes the requested args differ → no reuse.
  t.test('same role', () => {
    const { fix, proj } = confFix('ha-spawn-session-after-1-');
    try {
      proj('lanes=off\n');
      fix.writeRoster();
      fix.live([]);
      let r = runSpawn(fix, ['implementer'], { HERDR_AGENTS_LANES: 'off' });
      assert.equal(r.status, 0, r.stderr);
      const first = JSON.parse(r.stdout).name;
      const f1 = fix.row(first).split('\t');
      assert.equal(f1.length, 14);
      assert.equal(f1[13], '', 'the worker opened without args');
      const s = runSession(fix, ['role.implementer.args', '-r x'], { HERDR_AGENTS_LANES: 'off' });
      assert.equal(s.status, 0, s.stderr);
      fix.live([{ name: first, pane_id: `p-${first}`, agent_status: 'idle' }]);
      fix.clearLog();
      r = runSpawn(fix, ['implementer'], { HERDR_AGENTS_LANES: 'off' });
      assert.equal(r.status, 0, r.stderr);
      const j1 = JSON.parse(r.stdout);
      assert.notEqual(j1.name, first, 'the same-role worker is not reused');
      assert.ok(!('reused' in j1), 'a fresh spawn has no reused key');
      assert.ok(fix.logLines().some((l) => l.startsWith('agent start ')), 'a fresh worker opens');
    } finally { fix.cleanup(); }
  });
  // Cross-role: the idle worker opened without args; a session-layer arg
  // for the requested role → no cross-role reuse.
  t.test('cross-role', () => {
    const { fix, proj } = confFix('ha-spawn-session-after-2-');
    try {
      proj('lanes=off\n');
      fix.writeRoster();
      fix.live([]);
      const r0 = runSpawn(fix, ['implementer'], { HERDR_AGENTS_LANES: 'off' });
      assert.equal(r0.status, 0, r0.stderr);
      const implName = JSON.parse(r0.stdout).name;
      const s = runSession(fix, ['role.scouter.args', '-r x'], { HERDR_AGENTS_LANES: 'off' });
      assert.equal(s.status, 0, s.stderr);
      fix.live([{ name: implName, pane_id: `p-${implName}`, agent_status: 'idle' }]);
      fix.clearLog();
      const r = runSpawn(fix, ['scouter'], { HERDR_AGENTS_LANES: 'off' });
      assert.equal(r.status, 0, r.stderr);
      const j2 = JSON.parse(r.stdout);
      assert.notEqual(j2.name, implName, 'the idle implementer is not borrowed');
      assert.ok(!('reused' in j2), 'no cross-role reuse after the session set');
      assert.ok(fix.logLines().some((l) => l.startsWith('agent start ')), 'a fresh worker opens');
    } finally { fix.cleanup(); }
  });
  // Lane: the idle lane worker opened without args; a session-layer lane
  // arg afterwards → kind-mismatch 13 on the next spawn of the lane.
  t.test('lane', () => {
    const { fix, proj } = confFix('ha-spawn-session-after-3-');
    try {
      proj('lane.build.roles=implementer\nlane.build.kind=grok\n');
      fix.writeRoster();
      fix.live([]);
      const r0 = runSpawn(fix, ['implementer']);
      assert.equal(r0.status, 0, r0.stderr);
      const laneWorker = JSON.parse(r0.stdout).name;
      const s = runSession(fix, ['lane.build.args', '-l net']);
      assert.equal(s.status, 0, s.stderr);
      fix.live([{ name: laneWorker, pane_id: `p-${laneWorker}`, agent_status: 'idle' }]);
      fix.clearLog();
      const r = runSpawn(fix, ['implementer']);
      assert.equal(r.status, 13, r.stderr);
      const jm = JSON.parse(r.stdout);
      assert.equal(jm.status, 'kind-mismatch');
      assert.equal(jm.lane, 'build');
      assert.equal(jm.name, laneWorker);
      assert.equal(jm.session_args, '');
      assert.equal(jm.requested_args, '-l net');
      assert.ok(r.stderr.includes(`lane 'build' worker '${laneWorker}' was started with other native args (''); this spawn wants '-l net'. Release the lane, then spawn again.`), r.stderr);
      assert.ok(!fix.logLines().some((l) => l.startsWith('agent start')), 'the mismatch starts no pane');
    } finally { fix.cleanup(); }
  });
  // Mutation captured: the reuse comparing the current configuration
  // (session or file) instead of the roster column 14 (all three spawns
  // above would reuse the worker).
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

// Mutation captured: accepting `--kind ''` lets the shared resolution treat
// it as absent while spawn still ranks it as a flag (lane model/effort
// filtered differently for the same call).
test('spawn: an empty --kind is a usage error', () => {
  const fix = makeFix('ha-spawn-empty-kind-');
  try {
    const r = runSpawn(fix, ['implementer', '--kind', '']);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /spawn: --kind expects a kind/);
    assert.ok(!fix.logLines().some((l) => l.startsWith('agent start')), 'nothing started');
  } finally { fix.cleanup(); }
});
