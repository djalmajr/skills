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
// The check-window sequence (FAKE_SEQ): one element per agent get of the
// FAKE_SEQ_TARGET agent (update/plain = alive, gone = agent_not_found);
// the FAKE_SEQ_STATE file holds the number of calls. agent read of the
// target answers the current element's screen (gone answers the retained
// screen of FAKE_READ_GONE when set, else fails).
const seqElement = (advance) => {
  let i = 0;
  try { i = parseInt(fs.readFileSync(process.env.FAKE_SEQ_STATE, 'utf8'), 10); } catch {}
  if (advance) { i += 1; fs.writeFileSync(process.env.FAKE_SEQ_STATE, String(i)); }
  const seq = process.env.FAKE_SEQ.split(',');
  return seq[Math.max(0, Math.min(i - 1, seq.length - 1))];
};
if (cmd === 'agent get') {
  const t = argv[2] ?? '';
  if (process.env.FAKE_SEQ !== undefined && t === process.env.FAKE_SEQ_TARGET) {
    if (seqElement(true) === 'gone') {
      process.stderr.write('{"error":{"code":"agent_not_found","message":"gone"}}\\n');
      process.exit(1);
    }
    const a0 = live().find((x) => x && ((x.name ?? '') === t || x.pane_id === t));
    const dbgOut = JSON.stringify({ result: { agent: a0 ? { name: a0.name, agent_status: a0.agent_status ?? 'idle' } : { name: t, agent_status: 'idle' } } }) + '\\n';
    process.stdout.write(dbgOut);
    process.exit(0);
  }
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
  // Fail only after an agent start (the marker the fake touches on start):
  // the pre-start name checks still list fine.
  if (process.env.FAKE_LIVE_FAIL_AFTER_START) {
    try { if (fs.existsSync(process.env.FAKE_LIVE_FAIL_AFTER_START)) { process.stderr.write('herdr says no\\n'); process.exit(3); } } catch {}
  }
  process.stdout.write(JSON.stringify({ result: { agents: live() } }) + '\\n');
} else if (cmd === 'pane close') {
  if (process.env.FAKE_CLOSE_FAIL) { process.stderr.write('{"error":{"code":"pane_not_found","message":"no pane"}}\\n'); process.exit(1); }
  process.stdout.write('{"result":{}}\\n');
} else if (cmd === 'agent start') {
  if (process.env.FAKE_LIVE_FAIL_AFTER_START) { try { fs.writeFileSync(process.env.FAKE_LIVE_FAIL_AFTER_START, '1\\n'); } catch {} }
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
  if (m === 'timeout') { process.stderr.write('{"error":{"code":"timeout","message":"timed out waiting for agent startup"}}\\n'); process.exit(1); }
  process.stdout.write('{"result":{"started":true}}\\n');
} else if (cmd === 'agent read') {
  const t = argv[2] ?? '';
  if (process.env.FAKE_SEQ !== undefined && t === process.env.FAKE_SEQ_TARGET) {
    const el = seqElement(false);
    if (el === 'update') {
      process.stdout.write('❯ codex -s workspace-write\\nUpdating Codex via \`npm install -g @openai/codex\`...\\nchanged 2 packages in 14s\\n🎉 Update ran successfully! Please restart Codex.\\n');
    } else if (el === 'gone' && process.env.FAKE_READ_GONE) {
      process.stdout.write(fs.readFileSync(process.env.FAKE_READ_GONE, 'utf8'));
    } else if (el === 'gone') {
      process.exit(1);
    } else {
      process.stdout.write('screen line 1\\nscreen line 2\\n');
    }
  } else {
    process.stdout.write('screen line 1\\nscreen line 2\\n');
  }
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
  return spawnSync(nodeBin(), ['--input-type=module', '-e', code], { env: fix.env, cwd: fix.repo, encoding: 'utf8', timeout: 30_000 });
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

test('resolveRoleSettings: a role model from a layer below the effective kind is dropped', () => {
  const { fix, proj } = confFix('ha-spawn-role-model-layer-');
  try {
    const user = path.join(fix.env.XDG_CONFIG_HOME, 'herdr-agents', 'config');
    const userConf = (text) => {
      fs.mkdirSync(path.dirname(user), { recursive: true });
      fs.writeFileSync(user, text);
      fix.ctx = loadConfig(fix.env, fix.repo);
    };
    // 1) The kind sits in a higher layer (project) than the model (user):
    // the model is dropped and the chain continues (nothing for pi here,
    // so the CLI decides).
    userConf('role.implementer.model=my-provider/my-model\n');
    proj('role.implementer.kind=pi\n');
    let res = resolveRoleSettings('implementer', fix.ctx, fix.env, fix.repo);
    assert.equal(res.kind, 'pi');
    assert.equal(res.kindLayer, 2);
    assert.equal(res.modelSpec, '', 'the user model under the project kind is dropped');
    assert.equal(res.modelFrom, 'default');
    // 2) The effective kind is the LANE kind: the role model is judged
    // against the lane kind's layer too.
    userConf('role.implementer.model=my-provider/my-model\n');
    proj('lane.build.kind=pi\n');
    res = resolveRoleSettings('implementer', fix.ctx, fix.env, fix.repo);
    assert.equal(res.kind, 'pi');
    assert.equal(res.kindFrom, 'lane build (project)');
    assert.equal(res.kindLayer, 2);
    assert.equal(res.modelSpec, '', 'the user role model under the project lane kind is dropped');
    // 3) The model sits at a higher layer than the kind (user kind,
    // project model): the model applies.
    userConf('role.implementer.kind=pi\n');
    proj('role.implementer.model=my-provider/my-model\n');
    res = resolveRoleSettings('implementer', fix.ctx, fix.env, fix.repo);
    assert.equal(res.kindLayer, 1);
    assert.equal(res.modelSpec, 'my-provider/my-model');
    assert.equal(res.modelFrom, 'role config (project)');
    // 4) Same layer as the kind: the model applies.
    userConf('');
    proj('role.implementer.kind=pi\nrole.implementer.model=my-provider/my-model\n');
    res = resolveRoleSettings('implementer', fix.ctx, fix.env, fix.repo);
    assert.equal(res.modelSpec, 'my-provider/my-model');
    assert.equal(res.modelFrom, 'role config (project)');
    // 5) The kind comes from the frontmatter (no layer): the model applies
    // as before.
    userConf('role.implementer.model=my-provider/my-model\n');
    proj('');
    res = resolveRoleSettings('implementer', fix.ctx, fix.env, fix.repo);
    assert.equal(res.kind, 'grok', 'the frontmatter kind');
    assert.equal(res.kindLayer, 0);
    assert.equal(res.modelSpec, 'my-provider/my-model');
    assert.equal(res.modelFrom, 'role config (user)');
    // 6) The --kind flag (no --model) is the top layer: the configured role
    // model is dropped (the chain continues with model.<kind>.<position>);
    // a flag model still wins.
    proj('role.implementer.model=my-provider/my-model\n');
    res = resolveRoleSettings('implementer', fix.ctx, fix.env, fix.repo, { kind: 'cursor' });
    assert.equal(res.kind, 'cursor');
    assert.equal(res.kindLayer, 5);
    assert.equal(res.modelSpec, 'grok|muse', 'a flag kind drops the configured role model (the cursor default applies)');
    assert.equal(res.modelFrom, 'model.cursor.worker (defaults)');
    res = resolveRoleSettings('implementer', fix.ctx, fix.env, fix.repo, { kind: 'cursor', model: 'm1' });
    assert.equal(res.modelSpec, 'm1');
    assert.equal(res.modelFrom, 'flag');
    // 7) The expected shape: a lane kind above the lane model — the codex
    // default spec applies, not the user lane model.
    userConf('lane.review.model=opus\n');
    proj('lane.review.kind=codex\n');
    res = resolveRoleSettings('reviewer', fix.ctx, fix.env, fix.repo);
    assert.equal(res.lane, 'review');
    assert.equal(res.kind, 'codex');
    assert.equal(res.modelSpec, 'sol|gpt-5', 'the codex default spec, not the user lane model');
    assert.equal(res.modelFrom, 'model.codex.worker (defaults)');
    // Mutation captured: the role model layer check disabled (cases 1, 2
    // and 6 would keep the user/project model), the check comparing
    // against the role kind only (case 2 would keep the user model), or a
    // frontmatter kind ranked above a configured model (case 5 would drop
    // it).
  } finally { fix.cleanup(); }
});

test('resolveRoleSettings: the frontmatter model follows the kind layer rule', () => {
  const { fix, proj } = confFix('ha-spawn-fm-model-layer-');
  try {
    // ui-reviewer: the frontmatter holds kind agy and model gemini|sonnet.
    // Kind only in the frontmatter (layer 0): the frontmatter model
    // applies, as before.
    let res = resolveRoleSettings('ui-reviewer', fix.ctx, fix.env, fix.repo);
    assert.equal(res.kind, 'agy');
    assert.equal(res.kindFrom, 'role file');
    assert.equal(res.kindLayer, 0);
    assert.equal(res.modelSpec, 'gemini|sonnet');
    assert.equal(res.modelFrom, 'role file');
    // The kind comes from a config layer (project): the frontmatter model
    // is dropped and the chain continues with model.<kind>.<position>.
    proj('role.ui-reviewer.kind=grok\n');
    res = resolveRoleSettings('ui-reviewer', fix.ctx, fix.env, fix.repo);
    assert.equal(res.kind, 'grok');
    assert.equal(res.kindFrom, 'role config (project)');
    assert.equal(res.kindLayer, 2);
    assert.equal(res.modelSpec, 'grok', 'model.grok.worker (defaults) takes over');
    assert.equal(res.modelFrom, 'model.grok.worker (defaults)');
    // A model.<kind> layer fills the dropped frontmatter model.
    proj('role.ui-reviewer.kind=pi\nmodel.pi=pi-model\n');
    res = resolveRoleSettings('ui-reviewer', fix.ctx, fix.env, fix.repo);
    assert.equal(res.kind, 'pi');
    assert.equal(res.modelSpec, 'pi-model');
    assert.equal(res.modelFrom, 'model.pi (project)');
    // The --kind flag (the top layer): the frontmatter model is dropped
    // the same way (nothing configured for pi, so the CLI decides).
    proj('role.ui-reviewer.kind=grok\n');
    res = resolveRoleSettings('ui-reviewer', fix.ctx, fix.env, fix.repo, { kind: 'pi' });
    assert.equal(res.kind, 'pi');
    assert.equal(res.kindFrom, 'flag');
    assert.equal(res.kindLayer, 5);
    assert.equal(res.modelSpec, '');
    assert.equal(res.modelFrom, 'default');
    // Mutation captured: the frontmatter model kept when the kind comes
    // from a higher layer (cases 2 and 3 would show gemini|sonnet) or
    // dropped when the kind also sits in the frontmatter (case 1 would
    // show the default).
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

// Two editors in the same tree: the second spawn warns (one warn per
// other live editor, read-only roles out, a not-alive row out) — on a
// new worker and on a reuse (lanes off, the findReusable path).
test('spawn: another live editor in the same cwd warns (one per editor)', { timeout: 60000 }, () => {
  const fix = makeFix('ha-spawn-same-tree-');
  try {
    const row12 = (name, role, cwd) =>
      `${name}\tp-${name}\tgrok\t${role}\txai\t0\t${cwd}\tnow\tgrok-4.7\task\t${role}\t`;
    const TAIL = `both edit ${fix.repo}: builds and test runs see each other's changes in progress; give each a git worktree (spawn --cwd <worktree>) to isolate them`;
    // A live editor and a live read-only role in this very repo (the cwd
    // a spawn opens in), both outside the build lane (lane column empty).
    fix.writeRoster(
      row12('other', 'implementer', fix.repo),
      row12('reader', 'scouter', fix.repo),
    );
    fix.live([
      { name: 'other', pane_id: 'p-other', agent_status: 'working' },
      { name: 'reader', pane_id: 'p-reader', agent_status: 'working' },
    ]);
    // New worker (lanes on): it warns about the live editor only.
    let r = runSpawn(fix, ['implementer']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes(` and 'other' both edit ${fix.repo}: `) && r.stderr.includes(TAIL),
      'the new worker warns about the live editor: ' + r.stderr);
    assert.ok(!r.stderr.includes('reader'), 'the read-only role does not enter: ' + r.stderr);
    // A roster line whose agent is not alive does not warn.
    fix.writeRoster(row12('ghost', 'implementer', fix.repo));
    fix.live([]);
    r = runSpawn(fix, ['implementer']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stderr.includes('both edit'), 'a not-alive editor does not warn: ' + r.stderr);
    // Two live editors in the same tree: one warn per other editor.
    fix.writeRoster(row12('e1', 'implementer', fix.repo), row12('e2', 'implementer', fix.repo));
    fix.live([
      { name: 'e1', pane_id: 'p-e1', agent_status: 'working' },
      { name: 'e2', pane_id: 'p-e2', agent_status: 'working' },
    ]);
    r = runSpawn(fix, ['implementer']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal((r.stderr.match(/both edit/g) || []).length, 2, 'one warn per other editor: ' + r.stderr);
    // Reuse (lanes off): the reused worker is the one named in the warn.
    fix.writeRoster(row12('other2', 'implementer', fix.repo), row12('other', 'implementer', fix.repo));
    fix.live([
      { name: 'other2', pane_id: 'p-other2', agent_status: 'idle' },
      { name: 'other', pane_id: 'p-other', agent_status: 'working' },
    ]);
    r = runSpawn(fix, ['implementer'], { HERDR_AGENTS_LANES: 'off' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(JSON.parse(r.stdout).reused === true, 'the idle worker is reused: ' + r.stdout);
    assert.ok(r.stderr.includes(`'other2' and 'other' both edit ${fix.repo}: `) && r.stderr.includes(TAIL),
      'the reuse warns about the other editor: ' + r.stderr);
    // Mutation captured: the check skipped on the new-worker or reuse
    // paths (no warn at all), a read-only role entering the check (a warn
    // naming 'reader'), a not-alive row counted as a live editor (a warn
    // in the ghost case), or two editors producing a single warn.
  } finally { fix.cleanup(); }
});

// The advisory check runs after the worker is started: a failing
// `agent list` there must not fail the spawn (the worker is already in
// the roster) — it skips the warn, and the final JSON is still printed.
test('spawn: a failing agent list after the start never fails the spawn', { timeout: 60000 }, () => {
  const fix = makeFix('ha-spawn-same-tree-fail-');
  try {
    const row12 = (name, role, cwd) =>
      `${name}\tp-${name}\tgrok\t${role}\txai\t0\t${cwd}\tnow\tgrok-4.7\task\t${role}\t`;
    // A live editor candidate in this very repo: the advisory check has
    // something to look up once the worker is started.
    fix.writeRoster(row12('other', 'implementer', fix.repo));
    fix.live([{ name: 'other', pane_id: 'p-other', agent_status: 'working' }]);
    // agent list fails only after an agent start (the marker the fake
    // touches on start): the pre-start name check still lists fine.
    const r = runSpawn(fix, ['implementer'], { FAKE_LIVE_FAIL_AFTER_START: path.join(fix.root, 'live-fail-after-start') });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.role, 'implementer');
    assert.ok(j.name !== '', 'the final JSON names the started worker: ' + r.stdout);
    assert.ok(!r.stderr.includes('both edit'), 'no advisory warn when the list fails: ' + r.stderr);
    // The advisory call happened after the start (and failed there).
    const log = fix.logLines();
    const iStart = log.findIndex((l) => l.startsWith('agent start '));
    const iList = log.findIndex((l, i) => i > iStart && l === 'agent list');
    assert.ok(iStart > -1 && iList > iStart, `agent list after the start: ${log}`);
    // Mutation captured: the advisory liveAgents failure propagating (the
    // spawn dies without the final JSON after the worker is started, or
    // the warn is printed anyway) breaks the rc, the JSON and the warn
    // asserts above.
  } finally { fix.cleanup(); }
});

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

// ---------- the post-start check (self-update and early exit) ----------

// A spawn whose agent is driven by the check-window sequence: FAKE_SEQ
// (update/plain = alive, gone = agent_not_found), one element per
// `agent get` of the spawned name; the poll interval is the test env
// override (50 ms), so the windows run in milliseconds.
function runSpawnSeq(fix, name, seq, over = {}) {
  const seqState = path.join(fix.root, 'seq-state');
  fs.rmSync(seqState, { force: true });
  // The update markers are per kind (the codex auto-update is the only
  // evidence so far): the spawned agent is a codex. Codex models come from
  // ~/.codex/models_cache.json (no CLI call), so the fixture home gets a
  // cache with the worker's model.
  const codexHome = path.join(fix.root, 'home', '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'sol' }, { slug: 'gpt-5' }] }));
  return runSpawn(fix, ['implementer', '--name', name, '--pane', 'p-q'], {
    HERDR_AGENTS_LANES: 'off',
    HERDR_AGENTS_WAIT_POLL_MS: '50',
    HERDR_AGENTS_ROLE_IMPLEMENTER_KIND: 'codex',
    FAKE_SEQ: seq,
    FAKE_SEQ_TARGET: name,
    FAKE_SEQ_STATE: seqState,
    ...over,
  });
}

test('spawn: a CLI that updates itself at start is relaunched once, then ready', { timeout: 60000 }, () => {
  const fix = makeFix('ha-spawn-selfupdate-');
  try {
    fix.clearLog();
    const r = runSpawnSeq(fix, 'upd', 'update,gone,plain');
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.name, 'upd');
    assert.equal(j.status, 'ready');
    assert.ok(r.stderr.includes("warning: 'upd' (codex) updated itself at start and exited; started it again"), r.stderr);
    // One relaunch in the SAME pane with the SAME args: two starts, the
    // second identical to the first.
    const starts = fix.logLines().filter((l) => l.startsWith('agent start upd '));
    assert.equal(starts.length, 2, fix.logLines().join('\n'));
    assert.equal(starts[1], starts[0], 'the relaunch reuses the pane and the args');
    // The roster line is written (once), in the new pane.
    assert.equal(fix.row('upd').split('\t')[1], 'p-q');
    assert.equal(fix.roster().split('\n').filter((l) => l.startsWith('upd\t')).length, 1, 'one line for the name');
    // Mutation captured: no relaunch (the spawn would die 4 instead of
    // ready), a second relaunch (three starts), or a relaunch with another
    // pane/args.
  } finally { fix.cleanup(); }
});

test('spawn: an agent that exits right after start without the marker dies 4, no roster line', { timeout: 60000 }, () => {
  const fix = makeFix('ha-spawn-earlyexit-');
  try {
    // The pane still holds the screen the agent left (FAKE_READ_GONE): 7
    // lines, the message keeps the last 5.
    const crash = path.join(fix.root, 'crash');
    fs.writeFileSync(crash, 'Error: the CLI crashed at startup\nat main (cli.js:1:1)\nframe two\nframe three\nframe four\nframe five\nframe six\n');
    fix.clearLog();
    const r = runSpawnSeq(fix, 'dead1', 'gone', { FAKE_READ_GONE: crash });
    assert.equal(r.status, 4, r.stderr);
    assert.equal(r.stderr,
      "herdr-agents: agent 'dead1' (codex) exited right after start; last screen lines: frame two / frame three / frame four / frame five / frame six\n",
      r.stderr);
    // The exit is logged in the friction log (the pane is left open, as
    // the start failure does).
    const friction = fs.readFileSync(path.join(fix.ws, 'friction.log'), 'utf8');
    assert.ok(friction.includes('error(exit 4)'), friction);
    // No relaunch: the agent start happened once.
    assert.equal(fix.logLines().filter((l) => l.startsWith('agent start dead1 ')).length, 1, fix.logLines().join('\n'));
    assert.equal(fix.row('dead1'), '', 'no roster line for the dead agent');
    // Mutation captured: a relaunch without the marker (a second start),
    // the roster line written, another exit code, or the wrong screen
    // tail (more/less than the last 5 non-empty lines).
  } finally { fix.cleanup(); }
});

test('spawn: the relaunch that exits again dies 4 (no second relaunch)', { timeout: 60000 }, () => {
  const fix = makeFix('ha-spawn-relaunch-exit-');
  try {
    fix.clearLog();
    const r = runSpawnSeq(fix, 'dead2', 'update,gone,update,gone');
    assert.equal(r.status, 4, r.stderr);
    // The relaunch happened once (the warning names it) — and only once.
    assert.equal(r.stderr.split('updated itself at start and exited; started it again').length - 1, 1, r.stderr);
    const starts = fix.logLines().filter((l) => l.startsWith('agent start dead2 '));
    assert.equal(starts.length, 2, 'one relaunch only: ' + fix.logLines().join('\n'));
    // The exit message carries the last screen the window read (the
    // update screen of the relaunched agent).
    assert.ok(r.stderr.includes("agent 'dead2' (codex) exited right after start; last screen lines: ❯ codex -s workspace-write / Updating Codex via"), r.stderr);
    assert.equal(fix.row('dead2'), '', 'no roster line');
    // Mutation captured: a second relaunch (three starts), the relaunch
    // warning missing, or the roster line written on the exit.
  } finally { fix.cleanup(); }
});

test('spawn: an alive agent without the marker proceeds after the first probe', { timeout: 60000 }, () => {
  const fix = makeFix('ha-spawn-window-ok-');
  try {
    fix.clearLog();
    const r = runSpawnSeq(fix, 'ok1', 'plain');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).status, 'ready');
    // The window ends the instant it sees alive-without-marker: exactly
    // one probe (agent get + agent read) of the new agent — not the full
    // 5 s window.
    assert.equal(fix.logLines().filter((l) => l === 'agent get ok1').length, 1, fix.logLines().join('\n'));
    assert.equal(fix.logLines().filter((l) => l.startsWith('agent read ok1 ')).length, 1, fix.logLines().join('\n'));
    assert.ok(!r.stderr.includes('updated itself'), r.stderr);
    // Mutation captured: the full window waited (several probes) or the
    // check window missing entirely (no probe of the new agent).
  } finally { fix.cleanup(); }
});

test('spawn: a reused name replaces the stale roster lines (name and pane) with a warning', { timeout: 60000 }, () => {
  const fix = makeFix('ha-spawn-stalename-');
  try {
    // Two stale lines: one with the name the spawn will take (the agent
    // exited, so the name is free) and one with the pane the spawn will
    // use (a freed pane is reused); both belong to agents that exited.
    fix.writeRoster(
      'oldw\tp-old\tgrok\timplementer\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\timplementer',
      'other\tp-q\tgrok\tscouter\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\tscouter',
    );
    fix.live([]);
    fix.clearLog();
    const r = runSpawn(fix, ['implementer', '--name', 'oldw', '--pane', 'p-q'], { HERDR_AGENTS_LANES: 'off' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).name, 'oldw');
    assert.ok(r.stderr.includes("warning: replaced the stale roster line of 'oldw' (pane p-old)"), r.stderr);
    assert.ok(r.stderr.includes("warning: replaced the stale roster line of 'other' (pane p-q)"), r.stderr);
    // One line per name: the new line only, in the new worker's pane.
    assert.equal(fix.row('oldw').split('\t')[1], 'p-q');
    assert.equal(fix.roster().split('\n').filter((l) => l.startsWith('oldw\t')).length, 1, 'no orphan line for the name');
    assert.equal(fix.row('other'), '', 'the same-pane stale line is removed too');
    // Mutation captured: the stale lines kept (two lines for the name),
    // the same-pane line kept, or the warning missing.
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

test('spawn: the temporary (burst) worker — flex only, flex_roles, capped by flex_extra', { timeout: 60000 }, () => {
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

// A relative --cwd resolves against the caller's directory: the roster and
// the pane get the absolute path (passed as written, the pane opened in the
// home directory). A --cwd that is not a directory exits 2 before a pane.
test('spawn: a relative --cwd is resolved to an absolute directory', { timeout: 60000 }, () => {
  const { fix, proj } = confFix('ha-spawn-relcwd-');
  try {
    proj('lanes=off\n');
    fs.mkdirSync(path.join(fix.repo, 'wt', 'ai'), { recursive: true });
    let r = runSpawn(fix, ['implementer', '--cwd', 'wt/ai'], { HERDR_AGENTS_LANES: 'off' });
    assert.equal(r.status, 0, r.stderr);
    const f = fix.row(JSON.parse(r.stdout).name).split('\t');
    assert.equal(f[6], path.join(fix.repo, 'wt', 'ai'), 'column 7 holds the absolute cwd');
    r = runSpawn(fix, ['scouter', '--cwd', 'no/such/dir'], { HERDR_AGENTS_LANES: 'off' });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /spawn: --cwd .*no\/such\/dir is not a directory/);
    // Mutation captured: keeping the --cwd as written stores `wt/ai` in
    // column 7; dropping the directory check opens a pane for a missing
    // path.
  } finally { fix.cleanup(); }
});

// Scoped native args are flags of one CLI: role.<r>.args set for the
// role's configured kind is not passed when the spawn runs another kind (a
// codex `-c <key>=<value>` is --continue to claude: it resumed the
// orchestrator's conversation). A resume flag from any source is refused
// before a pane opens; a failed start closes the pane the spawn opened.
test('spawn: scoped args stay with their kind; resume flags are refused; a failed start closes its pane', { timeout: 60000 }, () => {
  const { fix, proj } = confFix('ha-spawn-scoped-kind-');
  try {
    proj('lanes=off\nrole.implementer.kind=grok\nrole.implementer.args=-c sandbox_workspace_write.network_access=true\n');
    // The configured kind: the args are passed.
    let r = runSpawn(fix, ['implementer'], { HERDR_AGENTS_LANES: 'off' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(JSON.parse(r.stdout).agent_args.includes('-c sandbox_workspace_write.network_access=true'), r.stdout);
    // Another kind by flag: not passed, with a warning.
    r = runSpawn(fix, ['implementer', '--kind', 'claude', '--fresh'], { HERDR_AGENTS_LANES: 'off' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!JSON.parse(r.stdout).agent_args.includes('-c'), 'the codex-style args never reach claude: ' + r.stdout);
    assert.match(r.stderr, /role\.implementer\.args not passed: those args belong to kind grok and this spawn runs claude/);
    // A resume flag for claude from args.claude: exit 2, no pane, no start.
    proj('lanes=off\nargs.claude=--continue\n');
    fix.clearLog();
    r = runSpawn(fix, ['implementer', '--kind', 'claude', '--fresh'], { HERDR_AGENTS_LANES: 'off' });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /spawn: '--continue' would make claude resume an earlier session/);
    assert.ok(!fix.logLines().some((l) => l.startsWith('pane split') || l.startsWith('agent start') || l.startsWith('tab create')), fix.logLines().join('\n'));
    // A failed start in a pane the spawn opened: the pane is closed.
    proj('lanes=off\n');
    fix.clearLog();
    r = runSpawn(fix, ['implementer', '--fresh'], { HERDR_AGENTS_LANES: 'off', FAKE_START_MODE: 'timeout' });
    assert.equal(r.status, 4, r.stderr);
    assert.match(r.stderr, /closed the pane this spawn opened/);
    assert.ok(fix.logLines().some((l) => l.startsWith('pane close ')), fix.logLines().join('\n'));
    // A close that fails says so: the agent may still be running there.
    r = runSpawn(fix, ['implementer', '--fresh'], { HERDR_AGENTS_LANES: 'off', FAKE_START_MODE: 'timeout', FAKE_CLOSE_FAIL: '1' });
    assert.equal(r.status, 4, r.stderr);
    assert.match(r.stderr, /pane close failed and the pane is still open, check it for a running agent/);
    // Mutation captured: dropping the kind check passes the codex args to
    // claude; removing the resume guard starts claude with --continue; the
    // old "pane left open" path skips the pane close.
  } finally { fix.cleanup(); }
});

test('spawn: a session set after the spawn blocks the reuse', { timeout: 60000 }, (t) => {
  // Same role: the worker opened without args; a session-layer role arg
  // afterwards makes the requested args differ → no reuse.
  t.test('same role', { timeout: 60000 }, () => {
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
  t.test('cross-role', { timeout: 60000 }, () => {
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
  t.test('lane', { timeout: 60000 }, () => {
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
