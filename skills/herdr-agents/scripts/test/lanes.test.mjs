// Lanes (slice 4): the sourced "presets and custom lanes" block of
// test-lanes.sh, the layer rule (cases 1-4, 7, 8 of the suite at the
// laneAttr/spawnKindLayer level), setupLaneSpec (valid + every error),
// laneDecide (every decision, incl. locked and pending-report) and
// enforceWorkerCap at the cap (DieError 8, the bash message). Each test
// builds its own temp HOME/XDG_CONFIG_HOME/TMPDIR/HERDR_AGENTS_DIR
// (decision 10); a fake `herdr` (writeFakeCli) is the only herdr on PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeFakeCli } from './fakes.mjs';
import { loadConfig } from '../lib/config.mjs';
import { cmdStatus } from '../lib/commands/status.mjs';
import {
  lanesEnabled, panesValue, presetLaneNames, laneNames, laneCount, laneRolesCsv,
  laneOfRole, cfgLayerRank, laneKindLayer, laneAttr, spawnKindLayer,
  findLaneWorker, laneDecide, setupLaneSpec, maxWorkers, liveWorkerNames, applyLaneFile,
  enforceWorkerCap,
} from '../lib/lanes.mjs';
import { DieError } from '../lib/kinds.mjs';

const ROSTER = '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\tmodel\tapprovals\troles\tlane\n';

function tmp(prefix) {
  let root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return fs.realpathSync(root);
}

// Isolated env: temp HOME / XDG_CONFIG_HOME / TMPDIR / HERDR_AGENTS_DIR,
// nothing else leaks in (the test runs hermetic, like the bash suites).
function isoEnv(root) {
  for (const d of ['home', 'conf', 'tmp', 'state', 'repo/.agents']) fs.mkdirSync(path.join(root, d), { recursive: true });
  return {
    HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'conf'),
    TMPDIR: path.join(root, 'tmp'),
    HERDR_AGENTS_DIR: path.join(root, 'state'),
    HERDR_WORKSPACE_ID: 'ws-test',
  };
}

const repoCwd = (root) => path.join(root, 'repo');
const projectConf = (root) => path.join(root, 'repo', '.agents', 'herdr-agents.conf');
const userConf = (root) => path.join(root, 'conf', 'herdr-agents', 'config');
const sessionConf = (root) => path.join(root, 'state', 'ws-test', 'session.conf');

function ctx(root, env, cwd) {
  return loadConfig(env, cwd ?? repoCwd(root));
}

test('presets and custom lanes (test-lanes.sh block)', () => {
  const root = tmp('ha-lanes-presets-');
  try {
    const env = isoEnv(root);
    const c = ctx(root, env);
    // panes=4 (default): build | explore | review
    assert.equal(laneOfRole(c, 'implementer', env), 'build');
    assert.equal(laneOfRole(c, 'designer', env), 'build');
    assert.equal(laneOfRole(c, 'scouter', env), 'explore');
    assert.equal(laneOfRole(c, 'researcher', env), 'explore');
    assert.equal(laneOfRole(c, 'reviewer', env), 'review');
    assert.equal(laneOfRole(c, 'ui-reviewer', env), 'review');
    assert.equal(laneOfRole(c, 'inspector', env), 'review');
    assert.equal(laneCount(c, env), 3, 'preset4 count');
    assert.equal(maxWorkers(c, env), '3', 'preset4 workers');
    assert.equal(laneOfRole(c, 'sub-orchestrator', env), '', 'sub-orchestrator has no lane');

    // panes=3 (project): build | read
    fs.mkdirSync(path.dirname(userConf(root)), { recursive: true });
    fs.writeFileSync(projectConf(root), 'panes=3\n');
    const c3 = ctx(root, env);
    assert.equal(laneOfRole(c3, 'scouter', env), 'read');
    assert.equal(laneOfRole(c3, 'reviewer', env), 'read');
    assert.equal(laneOfRole(c3, 'implementer', env), 'build');
    assert.equal(laneCount(c3, env), 2, 'preset3 count');
    assert.equal(maxWorkers(c3, env), '2', 'preset3 workers');

    // A custom lane replaces the preset entirely.
    fs.writeFileSync(projectConf(root), 'panes=4\nlane.ops.roles=implementer,tasker\n');
    const cc = ctx(root, env);
    assert.equal(laneOfRole(cc, 'implementer', env), 'ops');
    assert.equal(laneCount(cc, env), 1, 'custom count');
    assert.equal(laneOfRole(cc, 'scouter', env), '', 'custom drops the preset');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('status resolves state under its explicit cwd', () => {
  const root = tmp('ha-lanes-status-cwd-');
  const oldCwd = process.cwd();
  try {
    const caller = path.join(root, 'caller');
    const requested = path.join(root, 'requested');
    const fakeBin = path.join(root, 'fake-bin');
    fs.mkdirSync(caller, { recursive: true });
    fs.mkdirSync(requested, { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: caller, stdio: 'ignore' });
    spawnSync('git', ['init', '-q'], { cwd: requested, stdio: 'ignore' });
    writeFakeCli(fakeBin, 'herdr', 'process.exit(0);\n');
    const env = {
      ...isoEnv(root),
      HERDR_AGENTS_DIR: '.status-state',
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
    };
    const sd = path.join(requested, '.status-state', 'ws-test');
    const report = path.join(sd, 'reports', 'build.md');
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.writeFileSync(report, 'done\n');
    fs.writeFileSync(path.join(sd, 'last-report-build'), `${report}\n`);

    process.chdir(caller);
    const output = [];
    const oldWrite = process.stdout.write;
    process.stdout.write = (chunk) => { output.push(String(chunk)); return true; };
    try {
      const config = loadConfig(env, requested);
      assert.equal(cmdStatus(['build'], config, env, requested), 0);
    } finally {
      process.stdout.write = oldWrite;
    }
    assert.equal(output.join(''), `build\tdone\t${report}\n`);
  } finally {
    process.chdir(oldCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('applyLaneFile propagates write failures and leaves the source file untouched', () => {
  const root = tmp('ha-lanes-write-failure-');
  try {
    const env = isoEnv(root);
    const dest = path.join(root, 'dest', 'herdr-agents.conf');
    const original = 'role.implementer.kind=grok\n';
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, original);
    const rename = fs.renameSync;
    fs.renameSync = (from, to, ...args) => {
      if (to === dest) {
        const err = new Error('injected rename failure');
        err.code = 'EIO';
        throw err;
      }
      return rename.call(fs, from, to, ...args);
    };
    let caught;
    try {
      applyLaneFile(dest, '4', env, repoCwd(root));
    } catch (e) {
      caught = e;
    } finally {
      fs.renameSync = rename;
    }
    assert.ok(caught instanceof DieError, `expected DieError, got ${caught}`);
    assert.equal(caught.message, `config set: could not rewrite ${dest} (file left untouched)`);
    assert.equal(caught.code, 4);
    assert.equal(fs.readFileSync(dest, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(path.dirname(dest)), ['herdr-agents.conf']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('lanes only via the HERDR_AGENTS_LANE_<X>_ROLES env var', () => {
  const root = tmp('ha-lanes-env-');
  try {
    const base = isoEnv(root);
    const env = { ...base, HERDR_AGENTS_LANE_OPS_ROLES: 'implementer,tasker' };
    const c = ctx(root, env);
    assert.deepEqual(laneNames(c, env), ['ops']);
    assert.equal(laneOfRole(c, 'implementer', env), 'ops');
    assert.equal(laneOfRole(c, 'scouter', env), '', 'preset dropped by the env lane');
    // A hyphenated env var is not a valid shell name: bash compgen -v
    // never lists it, so it is invisible to the lane logic (no lane,
    // the presets stay). The hyphen reaches a lane name only through a
    // file key (lane.ui-review.roles → normalized lane ui_review).
    const envHyphen = { ...base, 'HERDR_AGENTS_LANE_UI-REVIEW_ROLES': 'ui-reviewer,inspector' };
    const cH = ctx(root, envHyphen);
    assert.deepEqual(laneNames(cH, envHyphen), ['build', 'explore', 'review'], 'hyphen env var is invisible');
    assert.equal(laneOfRole(cH, 'ui-reviewer', envHyphen), 'review');
    // The file key middle is the normalized name, as bash extracts it
    // (lane.ui-review.roles → lane ui_review), not "fixed".
    fs.writeFileSync(projectConf(root), 'lane.ui-review.roles=ui-reviewer,inspector\n');
    const c3 = ctx(root, base);
    assert.deepEqual(laneNames(c3, base), ['ui_review']);
    assert.equal(laneOfRole(c3, 'ui-reviewer', base), 'ui_review', 'normalized key name, not "fixed"');
    // ...and the invisible hyphen env var does not add a second lane.
    const c4 = ctx(root, envHyphen);
    assert.deepEqual(laneNames(c4, envHyphen), ['ui_review']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('laneNames: sort -u order (C locale) and only effective non-empty roles', () => {
  const root = tmp('ha-lanes-sort-');
  try {
    const env = isoEnv(root);
    fs.writeFileSync(projectConf(root), 'lane.zeta.roles=reviewer\nlane.alpha.roles=scouter\n');
    let c = ctx(root, env);
    assert.deepEqual(laneNames(c, env), ['alpha', 'zeta'], 'sorted');
    // lane.empty.roles= does not count; the env lane does.
    fs.writeFileSync(projectConf(root), 'lane.empty.roles=\nlane.ops.roles=implementer\n');
    c = ctx(root, { ...env, HERDR_AGENTS_LANE_B_ROLES: 'researcher' });
    assert.deepEqual(laneNames(c, { ...env, HERDR_AGENTS_LANE_B_ROLES: 'researcher' }), ['b', 'ops']);
    // Uppercase stays (the file key keeps its case) and C-locale sorts it
    // before lowercase.
    fs.writeFileSync(projectConf(root), 'lane.A.roles=reviewer\nlane.b.roles=scouter\n');
    c = ctx(root, env);
    assert.deepEqual(laneNames(c, env), ['A', 'b'], 'C locale: A before b');
    // Duplicated by file and env counts once.
    fs.writeFileSync(projectConf(root), 'lane.ops.roles=implementer\n');
    c = ctx(root, { ...env, HERDR_AGENTS_LANE_OPS_ROLES: 'implementer' });
    assert.deepEqual(laneNames(c, { ...env, HERDR_AGENTS_LANE_OPS_ROLES: 'implementer' }), ['ops'], 'deduped');
    // Only empty lane roles: the presets stay (custom lanes not present).
    fs.writeFileSync(projectConf(root), 'lane.empty.roles=\n');
    c = ctx(root, env);
    assert.deepEqual(laneNames(c, env), ['build', 'explore', 'review']);
    // lanes=off: the lane functions are unchanged (the spawn bypass is
    // slice 5); maxWorkers follows the explicit-value rule.
    const off = { ...env, HERDR_AGENTS_LANES: 'off' };
    fs.rmSync(projectConf(root), { force: true });
    c = ctx(root, off);
    assert.ok(!lanesEnabled(c, off));
    assert.deepEqual(laneNames(c, off), ['build', 'explore', 'review']);
    assert.equal(laneOfRole(c, 'implementer', off), 'build');
    assert.equal(maxWorkers(c, off), '3', 'lanes off: not the lane count');
    assert.equal(panesValue(c, off), '4');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('panesValue: 3 and 4 pass, anything else is 4', () => {
  const empty = { entries: new Map(), sources: [] };
  const env = {};
  assert.equal(panesValue(empty, env), '4');
  assert.equal(panesValue({ entries: new Map([['panes', { value: '3', source: 'project' }]]), sources: [] }, env), '3');
  assert.equal(panesValue({ entries: new Map([['panes', { value: '5', source: 'project' }]]), sources: [] }, env), '4');
  assert.equal(panesValue(empty, { HERDR_AGENTS_PANES: '3' }), '3');
  assert.equal(panesValue(empty, { HERDR_AGENTS_PANES: 'x' }), '4');
  assert.deepEqual(presetLaneNames(empty, env), ['build', 'explore', 'review']);
});

test('maxWorkers: explicit value per layer (user, project, env, session)', () => {
  const root = tmp('ha-lanes-mw-');
  try {
    const env = isoEnv(root);
    fs.mkdirSync(path.dirname(userConf(root)), { recursive: true });
    fs.writeFileSync(userConf(root), 'max_workers=2\n');
    fs.writeFileSync(projectConf(root), 'max_workers=5\npanes=3\n');
    let c = ctx(root, env);
    assert.equal(maxWorkers(c, env), '5', 'project explicit wins over user');
    assert.equal(maxWorkers(c, { ...env, HERDR_AGENTS_MAX_WORKERS: '0' }), '0', 'env explicit, 0 = no cap');
    fs.mkdirSync(path.dirname(sessionConf(root)), { recursive: true });
    fs.writeFileSync(sessionConf(root), 'max_workers=7\n');
    c = ctx(root, env);
    assert.equal(maxWorkers(c, env), '7', 'session explicit beats project');
    // A non-integer explicit value falls back to 3 (session layer gone).
    fs.rmSync(sessionConf(root), { force: true });
    fs.writeFileSync(projectConf(root), 'max_workers=abc\npanes=3\n');
    c = ctx(root, env);
    assert.equal(maxWorkers(c, env), '3', 'invalid value -> 3');
    // Not explicit anywhere (only the defaults layer): with lanes on the
    // cap is the lane count (panes=3 -> 2).
    fs.rmSync(userConf(root), { force: true });
    fs.rmSync(sessionConf(root), { force: true });
    fs.writeFileSync(projectConf(root), 'panes=3\n');
    c = ctx(root, env);
    assert.equal(cfgLayerRank(c, 'max_workers', env), 0, 'defaults rank');
    assert.equal(maxWorkers(c, env), '2', 'defaults are not explicit: lane count');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('layer rule: cases 1-4, 7, 8 and the --kind flag', () => {
  const env = {};
  const cOf = (pairs) => {
    const entries = new Map();
    for (const [key, value, source] of pairs) entries.set(key, { value, source });
    return { entries, sources: [...new Set(pairs.map((p) => p[2]))] };
  };
  // 1) user lane.kind+model, project lane.kind: the user model sits below
  // the project kind layer and is ignored.
  let c = cOf([
    ['lane_explore_kind', 'codex', 'project'],
    ['lane_explore_model', 'grok-4.7', 'user'],
    ['model_codex_worker', 'gpt-6-luna', 'project'],
  ]);
  assert.equal(spawnKindLayer(c, 'scouter', 'explore', false, env), 2);
  assert.equal(laneKindLayer(c, 'explore', env), 2);
  assert.equal(laneAttr(c, 'explore', 'kind', null, env), 'codex');
  assert.equal(laneAttr(c, 'explore', 'model', 2, env), '', 'user model below the project kind');
  assert.equal(laneAttr(c, 'explore', 'model', null, env), '', 'same when the kind layer is derived');
  // 2) project kind AND model (same layer): the project model wins.
  c = cOf([
    ['lane_explore_kind', 'codex', 'project'],
    ['lane_explore_model', 'gpt-6-luna', 'project'],
  ]);
  assert.equal(spawnKindLayer(c, 'scouter', 'explore', false, env), 2);
  assert.equal(laneAttr(c, 'explore', 'model', 2, env), 'gpt-6-luna');
  // 3) env lane kind, no env model: the user lane model is ignored.
  c = cOf([['lane_build_model', 'gpt-6-luna', 'user']]);
  const env3 = { HERDR_AGENTS_LANE_BUILD_KIND: 'pi' };
  assert.equal(spawnKindLayer(c, 'implementer', 'build', false, env3), 4);
  assert.equal(laneAttr(c, 'build', 'model', 4, env3), '', 'user model below the env kind');
  assert.equal(laneAttr(c, 'build', 'model', 3, env3), '', 'also below session rank');
  assert.equal(laneAttr(c, 'build', 'model', 1, env3), 'gpt-6-luna', 'at the user rank it applies');
  // 4) same rule for effort.
  c = cOf([
    ['lane_build_kind', 'pi', 'project'],
    ['lane_build_effort', 'high', 'user'],
    ['effort_pi', 'max', 'project'],
  ]);
  assert.equal(spawnKindLayer(c, 'implementer', 'build', false, env), 2);
  assert.equal(laneAttr(c, 'build', 'effort', 2, env), '', 'user effort below the project kind');
  assert.equal(laneAttr(c, 'build', 'effort', 1, env), 'high');
  // 7) no lane.kind: the role kind layer is the reference.
  c = cOf([
    ['lane_build_model', 'grok-4.7', 'user'],
    ['role_implementer_kind', 'codex', 'project'],
  ]);
  assert.equal(spawnKindLayer(c, 'implementer', 'build', false, env), 2, 'role kind layer');
  assert.equal(laneKindLayer(c, 'build', env), -1, 'no lane kind configured');
  assert.equal(laneAttr(c, 'build', 'model', 2, env), '', 'user model below the role kind');
  // 8) frontmatter kind (layer 0): any configured lane model applies.
  c = cOf([['lane_build_model', 'grok-4.7', 'user']]);
  assert.equal(spawnKindLayer(c, 'implementer', 'build', false, env), 0, 'frontmatter kind is layer 0');
  assert.equal(laneAttr(c, 'build', 'model', 0, env), 'grok-4.7');
  // --kind flag: layer 5, the top — a lane model from a lower layer is
  // dropped even when the kind comes from the flag (test-lanes.sh case 6).
  assert.equal(spawnKindLayer(c, 'implementer', 'build', true, env), 5);
  assert.equal(laneAttr(c, 'build', 'model', 5, env), '', 'user model below the flag kind');
  // roles/approvals are not subject to the layer rule.
  c = cOf([
    ['lane_build_roles', 'implementer,tasker', 'user'],
    ['lane_build_kind', 'codex', 'project'],
  ]);
  assert.equal(laneAttr(c, 'build', 'roles', null, env), 'implementer,tasker');
  assert.equal(laneRolesCsv(c, 'build', env), 'implementer,tasker', 'custom roles csv');
});

test('setupLaneSpec: valid specs and every rejection (code 2)', () => {
  assert.deepEqual(setupLaneSpec('build=codex'), { name: 'build', kind: 'codex', model: '', effort: '' });
  assert.deepEqual(setupLaneSpec('build=codex:gpt-6'), { name: 'build', kind: 'codex', model: 'gpt-6', effort: '' });
  assert.deepEqual(setupLaneSpec('build=codex:gpt-6:high'), { name: 'build', kind: 'codex', model: 'gpt-6', effort: 'high' });
  assert.deepEqual(setupLaneSpec('build=codex:'), { name: 'build', kind: 'codex', model: '', effort: '' });
  assert.deepEqual(setupLaneSpec('review=claude::max'), { name: 'review', kind: 'claude', model: '', effort: 'max' });

  const expectDie = (spec, message) => {
    assert.throws(() => setupLaneSpec(spec), (e) => e instanceof DieError && e.code === 2 && e.message === message,
      `spec '${spec}'`);
  };
  expectDie('build', 'setup: --lane expects name=kind[:model[:effort]]');
  expectDie('=codex', "setup: invalid lane name ''");
  expectDie('Build=codex', "setup: invalid lane name 'Build'");
  expectDie('bu ill=codex', "setup: invalid lane name 'bu ill'");
  expectDie('build=', "setup: --lane 'build=' needs a kind");
  expectDie('build=nope', "setup: unknown kind 'nope'");
  expectDie('build=codex:m:huge', "setup: invalid effort 'huge'");
  expectDie('build=codex:m:max:extra', "setup: --lane 'build=codex:m:max:extra' has too many ':' fields");
  // IFS=':' read: trailing ':' delimiters do not fill `extra`; only the first
  // line is read.
  assert.deepEqual(setupLaneSpec('x=claude:m:high::'), { name: 'x', kind: 'claude', model: 'm', effort: 'high' });
  assert.deepEqual(setupLaneSpec('x=claude:::'), { name: 'x', kind: 'claude', model: '', effort: '' });
  assert.deepEqual(setupLaneSpec('x=claude\n:m'), { name: 'x', kind: 'claude', model: '', effort: '' });
  expectDie('x=claude:m:high:e:', "setup: --lane 'x=claude:m:high:e:' has too many ':' fields");
  expectDie('build=codex:g#x', 'setup: --lane value cannot contain #');
  expectDie('build=c#dex', "setup: unknown kind 'c#dex'"); // the kind check runs first
});

// laneDecide: a fake herdr driven by a mode file + a roster in the state dir.
const FAKE_HERDR = `import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.HA_LOG, args.join(' ') + '\\n');
if (args[0] === 'agent' && args[1] === 'get') {
  const target = args[2];
  if (target === 'gone') {
    process.stderr.write(JSON.stringify({ error: { code: 'agent_not_found', message: 'gone' } }) + '\\n');
    process.exit(1);
  }
  const mode = fs.readFileSync(process.env.HA_MODE, 'utf8').trim();
  if (mode === 'denied') {
    process.stderr.write('Error: Os { code: 13, kind: PermissionDenied, message: "Permission denied" }\\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ result: { agent: { name: target, agent_status: mode } } }) + '\\n');
}
`;

function decideFixture(root, { mode = 'idle', rows = [] } = {}) {
  const env = isoEnv(root);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  writeFakeCli(bin, 'herdr', FAKE_HERDR);
  const log = path.join(root, 'herdr.log');
  fs.writeFileSync(log, '');
  fs.writeFileSync(path.join(root, 'mode'), `${mode}\n`);
  const full = { ...env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, HA_LOG: log, HA_MODE: path.join(root, 'mode') };
  const sd = path.join(root, 'state', 'ws-test');
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, 'agents.tsv'), ROSTER + rows.map((r) => (Array.isArray(r) ? r.join('\t') : r)).join('\n') + (rows.length ? '\n' : ''));
  const c = loadConfig(full, repoCwd(root));
  return { env: full, sd, c, root };
}

const row = (name, role, lane, extra = []) =>
  [name, `p-${name}`, 'grok', role, 'xai', '1', '/repo', 'now', 'grok-4.7', 'full', role, lane, ...extra].slice(0, 12);

test('laneDecide: absent, reuse, busy (working/blocked), gone, unavailable', () => {
  const root = tmp('ha-lanes-decide-');
  try {
    let fx = decideFixture(root, {});
    let d = laneDecide(fx.c, 'build', 'implementer', fx.env, repoCwd(root));
    assert.deepEqual(d, { decision: 'absent' });

    fx = decideFixture(root, { rows: [row('build', 'implementer', 'build')] });
    d = laneDecide(fx.c, 'build', 'implementer', fx.env, repoCwd(root));
    assert.deepEqual(d, { decision: 'reuse', name: 'build' });

    fx = decideFixture(root, { mode: 'working', rows: [row('build', 'implementer', 'build')] });
    d = laneDecide(fx.c, 'build', 'implementer', fx.env, repoCwd(root));
    assert.deepEqual(d, { decision: 'busy', name: 'build', state: 'working' });

    fx = decideFixture(root, { mode: 'blocked', rows: [row('build', 'implementer', 'build')] });
    d = laneDecide(fx.c, 'build', 'implementer', fx.env, repoCwd(root));
    assert.deepEqual(d, { decision: 'busy', name: 'build', state: 'blocked' });

    fx = decideFixture(root, { rows: [row('gone', 'implementer', 'build')] });
    d = laneDecide(fx.c, 'build', 'implementer', fx.env, repoCwd(root));
    assert.deepEqual(d, { decision: 'gone', name: 'gone' });

    fx = decideFixture(root, { mode: 'denied', rows: [row('build', 'implementer', 'build')] });
    d = laneDecide(fx.c, 'build', 'implementer', fx.env, repoCwd(root));
    assert.equal(d.decision, 'unavailable');
    assert.equal(d.name, 'build');
    assert.equal(d.cause, 'Error: Os { code: 13, kind: PermissionDenied, message: "Permission denied" }');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('laneDecide: pending-report, locked (current and history), reuse by name', () => {
  const root = tmp('ha-lanes-decide2-');
  try {
    const fx = decideFixture(root, { rows: [row('build', 'implementer', 'build')] });
    // No last-report yet: reuse.
    let d = laneDecide(fx.c, 'build', 'implementer', fx.env, repoCwd(root));
    assert.deepEqual(d, { decision: 'reuse', name: 'build' });
    // A recorded report that does not exist yet: pending-report.
    fs.writeFileSync(path.join(fx.sd, 'last-report-build'), path.join(fx.sd, 'reports', 'build.md') + '\n');
    d = laneDecide(fx.c, 'build', 'implementer', fx.env, repoCwd(root));
    assert.deepEqual(d, { decision: 'busy', name: 'build', state: 'pending-report' });
    // An empty report file: still pending-report.
    fs.mkdirSync(path.join(fx.sd, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(fx.sd, 'reports', 'build.md'), '');
    d = laneDecide(fx.c, 'build', 'implementer', fx.env, repoCwd(root));
    assert.deepEqual(d, { decision: 'busy', name: 'build', state: 'pending-report' });
    // A non-empty report file: the reuse/lock rules apply.
    fs.writeFileSync(path.join(fx.sd, 'reports', 'build.md'), 'done\n');
    // Reviewer over a worker whose CURRENT role is an edit role: locked.
    d = laneDecide(fx.c, 'build', 'reviewer', fx.env, repoCwd(root));
    assert.deepEqual(d, { decision: 'locked', name: 'build' });
    // ...and over a worker with an edit role in the HISTORY: locked.
    const fx2 = decideFixture(root, { rows: ['build\tp-build\tgrok\tresearcher\txai\t1\t/repo\tnow\tgrok-4.7\tfull\timplementer,researcher\tbuild'] });
    fs.writeFileSync(path.join(fx2.sd, 'last-report-build'), path.join(fx2.sd, 'reports', 'x.md'));
    fs.mkdirSync(path.join(fx2.sd, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(fx2.sd, 'reports', 'x.md'), 'done\n');
    d = laneDecide(fx2.c, 'build', 'reviewer', fx2.env, repoCwd(root));
    assert.deepEqual(d, { decision: 'locked', name: 'build' });
    // A non-edit reviewer over a read worker with NO edit history: reuse.
    const fx2b = decideFixture(root, { rows: ['build\tp-build\tgrok\tresearcher\txai\t1\t/repo\tnow\tgrok-4.7\tfull\tresearcher\tbuild'] });
    fs.writeFileSync(path.join(fx2b.sd, 'last-report-build'), path.join(fx2b.sd, 'reports', 'x.md'));
    fs.mkdirSync(path.join(fx2b.sd, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(fx2b.sd, 'reports', 'x.md'), 'done\n');
    d = laneDecide(fx2b.c, 'build', 'inspector', fx2b.env, repoCwd(root));
    assert.deepEqual(d, { decision: 'reuse', name: 'build' });
    // A non-review role over an edit worker: reuse (the lock is review-only).
    d = laneDecide(fx.c, 'build', 'tasker', fx.env, repoCwd(root));
    assert.deepEqual(d, { decision: 'reuse', name: 'build' });
    // Fallback to the worker name when the lane column is missing (11 cols).
    const fx3 = decideFixture(root, { rows: ['explore\tp-e\tagy\tscouter\tgoogle\t1\t/repo\tnow\tgemini\tfull\tscouter'] });
    d = laneDecide(fx3.c, 'explore', 'researcher', fx3.env, repoCwd(root));
    assert.deepEqual(d, { decision: 'reuse', name: 'explore' });
    // findLaneWorker prefers the lane column over the name.
    const fx4 = decideFixture(root, { rows: [row('other', 'implementer', 'build')] });
    assert.equal(findLaneWorker(fx4.sd, 'build').split('\t')[0], 'other', 'column 12 wins');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const FAKE_LIVE = `import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'agent' && args[1] === 'list') {
  process.stdout.write(fs.readFileSync(process.env.HA_LIVE, 'utf8'));
}
`;

test('enforceWorkerCap: at the cap (code 8, the bash message) and below it', () => {
  const root = tmp('ha-lanes-cap-');
  try {
    const env = isoEnv(root);
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    writeFakeCli(bin, 'herdr', FAKE_LIVE);
    const live = path.join(root, 'live.json');
    fs.writeFileSync(live, JSON.stringify({ result: { agents: [
      { name: 'w1', pane_id: 'p-w1' }, { name: 'w2', pane_id: 'p-w2' }, { name: 'w3', pane_id: 'p-w3' },
    ] } }) + '\n');
    const full = { ...env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, HA_LIVE: live };
    const sd = path.join(root, 'state', 'ws-test');
    fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(path.join(sd, 'agents.tsv'),
      ROSTER + [row('w1', 'implementer', 'build'), row('w2', 'scouter', 'explore'), row('w3', 'reviewer', 'review')].map((r) => r.join('\t')).join('\n') + '\n');
    const c = loadConfig(full, repoCwd(root));
    assert.deepEqual(liveWorkerNames(sd, full), ['w1', 'w2', 'w3']);
    // Default max_workers (defaults layer) with lanes on: cap = 3 lanes.
    assert.throws(() => enforceWorkerCap(c, full, repoCwd(root)), (e) =>
      e instanceof DieError && e.code === 8 && e.message ===
      'max_workers=3 reached (3 live: w1 w2 w3). Release a finished worker (release <name> --close), ' +
      'let spawn reuse an idle one of the same role (reuse_workers=on / --reuse), or raise max_workers.',
      'cap reached');
    // An explicit higher cap lets the spawn through.
    fs.writeFileSync(projectConf(root), 'max_workers=5\n');
    const c2 = loadConfig(full, repoCwd(root));
    assert.doesNotThrow(() => enforceWorkerCap(c2, full, repoCwd(root)));
    // An explicit 0 is no cap at all.
    fs.writeFileSync(projectConf(root), 'max_workers=0\n');
    const c3 = loadConfig(full, repoCwd(root));
    assert.doesNotThrow(() => enforceWorkerCap(c3, full, repoCwd(root)));
    // Only one of the three is live: below the cap.
    fs.rmSync(projectConf(root), { force: true });
    fs.writeFileSync(live, JSON.stringify({ result: { agents: [{ name: 'w1', pane_id: 'p-w1' }] } }) + '\n');
    const c4 = loadConfig(full, repoCwd(root));
    assert.doesNotThrow(() => enforceWorkerCap(c4, full, repoCwd(root)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
