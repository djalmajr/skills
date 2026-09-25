// Lanes: the sourced "presets and custom lanes" block of
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
  LEGACY_PRESETS, lanesEnabled, panesValue, paneMode, flexExtra, presetLaneNames,
  presetLaneNamesFor, presetLaneCount, presetSignature, presetRolesFlat,
  laneNames, laneCount,
  laneRolesCsv, laneOfRole, cfgLayerRank, laneKindLayer, laneAttr, spawnKindLayer,
  laneWorkers, laneDecide, setupLaneSpec, maxWorkers, liveWorkerNames, liveBurstWorkers,
  applyLaneFile,
  laneCapacity, presetLaneCapacity, presetLaneRoles, enforceWorkerCap,
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

test('presets 2/3/4: lanes, roles, capacities, and custom lanes', () => {
  const root = tmp('ha-lanes-presets-');
  try {
    const env = isoEnv(root);
    const c = ctx(root, env);
    // panes=4 (default, strict mode): build (6 roles, capacity 2, the
    // documenter borrows a build slot) | review (4 roles, capacity 1).
    // Exploration goes to the builders: scouter/researcher are in the
    // build lane.
    assert.equal(laneOfRole(c, 'implementer', env), 'build');
    assert.equal(laneOfRole(c, 'designer', env), 'build');
    assert.equal(laneOfRole(c, 'tasker', env), 'build');
    assert.equal(laneOfRole(c, 'scouter', env), 'build');
    assert.equal(laneOfRole(c, 'researcher', env), 'build');
    assert.equal(laneOfRole(c, 'documenter', env), 'build', 'strict: the documenter joins the build lane');
    assert.equal(laneOfRole(c, 'reviewer', env), 'review');
    assert.equal(laneOfRole(c, 'security-reviewer', env), 'review');
    assert.equal(laneOfRole(c, 'ui-reviewer', env), 'review');
    assert.equal(laneOfRole(c, 'inspector', env), 'review');
    assert.deepEqual(presetLaneNames(c, env), ['build', 'review']);
    assert.equal(laneCount(c, env), 2, 'preset4 count');
    assert.equal(laneRolesCsv(c, 'build', env), 'implementer,designer,tasker,scouter,researcher,documenter');
    assert.equal(laneRolesCsv(c, 'review', env), 'reviewer,security-reviewer,ui-reviewer,inspector');
    assert.equal(laneCapacity(c, 'build', env), 2, 'preset4 build capacity');
    assert.equal(laneCapacity(c, 'review', env), 1, 'preset4 review capacity');
    assert.equal(maxWorkers(c, env), '3', 'preset4 workers (2+1)');
    assert.equal(laneOfRole(c, 'sub-orchestrator', env), '', 'sub-orchestrator has no lane');

    // panes=3 (project): build | review, both capacity 1.
    fs.mkdirSync(path.dirname(userConf(root)), { recursive: true });
    fs.writeFileSync(projectConf(root), 'panes=3\n');
    const c3 = ctx(root, env);
    assert.equal(laneOfRole(c3, 'scouter', env), 'build');
    assert.equal(laneOfRole(c3, 'documenter', env), 'build');
    assert.equal(laneOfRole(c3, 'reviewer', env), 'review');
    assert.equal(laneOfRole(c3, 'implementer', env), 'build');
    assert.deepEqual(presetLaneNames(c3, env), ['build', 'review']);
    assert.equal(laneCount(c3, env), 2, 'preset3 count');
    assert.equal(laneCapacity(c3, 'build', env), 1, 'preset3 build capacity');
    assert.equal(maxWorkers(c3, env), '2', 'preset3 workers (1+1)');

    // panes=2 (project): only build; the review roles have no lane.
    fs.writeFileSync(projectConf(root), 'panes=2\n');
    const c2 = ctx(root, env);
    assert.equal(laneOfRole(c2, 'scouter', env), 'build');
    assert.equal(laneOfRole(c2, 'implementer', env), 'build');
    assert.equal(laneOfRole(c2, 'reviewer', env), '', 'preset2 has no review lane');
    assert.deepEqual(presetLaneNames(c2, env), ['build']);
    assert.equal(laneCount(c2, env), 1, 'preset2 count');
    assert.equal(laneCapacity(c2, 'build', env), 1);
    assert.equal(maxWorkers(c2, env), '1', 'preset2 workers');

    // The old presets stay exported for the migration; nothing
    // else reads them, and the old lanes are gone from the new presets.
    assert.deepEqual(LEGACY_PRESETS, {
      '3': { build: 'implementer,designer,tasker', read: 'scouter,researcher,reviewer,security-reviewer,ui-reviewer,inspector' },
      '4': { build: 'implementer,designer,tasker', explore: 'scouter,researcher', review: 'reviewer,security-reviewer,ui-reviewer,inspector' },
    });
    assert.equal(presetLaneRoles('explore', '4'), '', 'explore is no longer a preset lane');
    assert.equal(presetLaneRoles('read', '3'), '', 'read is no longer a preset lane');
    assert.equal(presetLaneCapacity('build', '4'), 2);
    assert.equal(presetLaneCapacity('review', '4'), 1);
    assert.equal(presetLaneCapacity('build', '2'), 1);

    // The flex mode (pane_mode=flex): build | review | docs on every pane
    // count. The documenter owns the docs lane (capacity 0, a temporary
    // worker only), the build lane drops it, and at panes=2 the review
    // lane stays at capacity 0 (a temporary reviewer only).
    fs.writeFileSync(projectConf(root), 'panes=4\npane_mode=flex\n');
    const f4 = ctx(root, env);
    assert.equal(paneMode(f4, env), 'flex');
    assert.deepEqual(presetLaneNames(f4, env), ['build', 'review', 'docs']);
    assert.equal(laneOfRole(f4, 'documenter', env), 'docs', 'flex: the documenter owns the docs lane');
    assert.equal(laneOfRole(f4, 'reviewer', env), 'review');
    assert.equal(laneRolesCsv(f4, 'build', env), 'implementer,designer,tasker,scouter,researcher');
    assert.equal(laneRolesCsv(f4, 'docs', env), 'documenter');
    assert.equal(laneCapacity(f4, 'build', env), 2, 'flex4 build capacity');
    assert.equal(laneCapacity(f4, 'review', env), 1, 'flex4 review capacity');
    assert.equal(laneCapacity(f4, 'docs', env), 0, 'flex4 docs capacity 0');
    assert.equal(maxWorkers(f4, env), '4', 'flex4 workers (2+1+0 plus the temporary panel)');
    fs.writeFileSync(projectConf(root), 'panes=3\npane_mode=flex\n');
    const f3 = ctx(root, env);
    assert.deepEqual(presetLaneNames(f3, env), ['build', 'review', 'docs']);
    assert.equal(laneCapacity(f3, 'build', env), 1);
    assert.equal(laneCapacity(f3, 'docs', env), 0);
    assert.equal(maxWorkers(f3, env), '3', 'flex3 workers (1+1+0 plus the temporary panel)');
    fs.writeFileSync(projectConf(root), 'panes=2\npane_mode=flex\n');
    const f2 = ctx(root, env);
    assert.deepEqual(presetLaneNames(f2, env), ['build', 'review', 'docs']);
    assert.equal(laneCapacity(f2, 'review', env), 0, 'flex2: the review lane holds no resident worker');
    assert.equal(laneCapacity(f2, 'docs', env), 0);
    assert.equal(maxWorkers(f2, env), '2', 'flex2 workers (1+0+0 plus the temporary panel)');
    // flex_extra: the number of temporary panels (integer ≥ 0, default 1;
    // an invalid value falls back to the default).
    assert.equal(flexExtra(f2, env), 1);
    fs.writeFileSync(projectConf(root), 'panes=2\npane_mode=flex\nflex_extra=2\n');
    assert.equal(flexExtra(ctx(root, env), env), 2);
    fs.writeFileSync(projectConf(root), 'panes=2\npane_mode=flex\nflex_extra=0\n');
    assert.equal(flexExtra(ctx(root, env), env), 0, 'flex_extra=0: no temporary panel');
    fs.writeFileSync(projectConf(root), 'panes=2\npane_mode=flex\nflex_extra=-1\n');
    assert.equal(flexExtra(ctx(root, env), env), 1, 'invalid flex_extra falls back to 1');
    // The mode helpers on the (panes, mode) pairs directly.
    assert.deepEqual(presetLaneNamesFor('2', 'flex'), ['build', 'review', 'docs']);
    assert.deepEqual(presetLaneNamesFor('2'), ['build']);
    assert.equal(presetLaneCount('4', 'flex'), 3);
    assert.equal(presetLaneRoles('docs', '2', 'flex'), 'documenter');
    assert.equal(presetLaneCapacity('review', '2', 'flex'), 0);
    assert.equal(presetLaneCapacity('build', '4', 'flex'), 2);
    assert.equal(presetSignature('4', 'flex'),
      'build=implementer,designer,tasker,scouter,researcher\ndocs=documenter\nreview=reviewer,security-reviewer,ui-reviewer,inspector');
    assert.equal(presetSignature('2', 'flex'), presetSignature('4', 'flex'), 'the flex roles signature does not depend on panes');
    assert.equal(presetRolesFlat('3', 'flex'),
      'implementer,designer,tasker,scouter,researcher,reviewer,security-reviewer,ui-reviewer,inspector,documenter');
    // Mutation captured: the documenter leaving the strict build lane, the
    // flex presets keeping the documenter in the build lane (or losing the
    // docs lane), the flex panes=2 review capacity being 1, flex_extra
    // falling back on a valid-looking value, or max_workers not adding the
    // temporary panel in the flex mode.

    // A custom lane replaces the preset entirely and starts with capacity 1.
    fs.writeFileSync(projectConf(root), 'panes=4\nlane.ops.roles=implementer,tasker\n');
    const cc = ctx(root, env);
    assert.equal(laneOfRole(cc, 'implementer', env), 'ops');
    assert.equal(laneCount(cc, env), 1, 'custom count');
    assert.equal(laneOfRole(cc, 'scouter', env), '', 'custom drops the preset');
    assert.equal(laneCapacity(cc, 'ops', env), 1, 'custom lane: capacity 1');
    // ...until it sets lane.<name>.panes (valid integer ≥ 1).
    fs.writeFileSync(projectConf(root), 'panes=4\nlane.ops.roles=implementer,tasker\nlane.ops.panes=3\n');
    assert.equal(laneCapacity(ctx(root, env), 'ops', env), 3, 'lane.ops.panes key');
    // An invalid lane.<name>.panes is ignored (falls back to 1).
    fs.writeFileSync(projectConf(root), 'panes=4\nlane.ops.roles=implementer,tasker\nlane.ops.panes=0\n');
    const cc0 = ctx(root, env);
    assert.equal(laneCapacity(cc0, 'ops', env), 1, 'invalid panes key ignored');
    assert.equal(maxWorkers(cc0, env), '1', 'invalid key: still capacity 1');
    // Mutation captured: the capacity falling back to the preset for custom
    // lanes, or lane.<name>.panes accepting '0' / '01' / '1.5'.
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
    // The rewrite that fails is the configDropLegacy one (the build/
    // review lanes disagree on the frontmatter kinds, so no lane.<l>.kind
    // is written first): its message has no 'config set:' prefix.
    assert.equal(caught.message, `could not rewrite ${dest} (file left untouched)`);
    assert.equal(caught.code, 4);
    assert.equal(fs.readFileSync(dest, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(path.dirname(dest)), ['herdr-agents.conf']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------- applyLaneFile (the preset file freezes no roles/limits) ----------

test('applyLaneFile: a preset file drops the roles, the old lanes and the derived keys', () => {
  const root = tmp('ha-lanes-apply-');
  try {
    const env = isoEnv(root);
    const dest = projectConf(root);
    // The brief's Expected result: the old 4-pane config with an
    // explore attr, an explicit max_workers and panes=4.
    fs.writeFileSync(dest, [
      '# keep this comment',
      'lane.build.roles=implementer,designer,tasker',
      'lane.explore.roles=scouter,researcher',
      'lane.explore.kind=grok',
      'lane.review.roles=reviewer,security-reviewer,ui-reviewer,inspector',
      'max_workers=3',
      'panes=4',
    ].join('\n') + '\n');
    const lines = applyLaneFile(dest, '4', env, repoCwd(root));
    const conf = fs.readFileSync(dest, 'utf8');
    assert.ok(conf.split('\n').includes('# keep this comment'), conf);
    assert.ok(!/^lane\./m.test(conf), `no lane lines left:\n${conf}`);
    assert.ok(!/^max_workers=/m.test(conf), conf);
    assert.ok(!/^split_max_panes=/m.test(conf), conf);
    assert.ok(conf.split('\n').includes('panes=4'), conf);
    assert.ok(conf.split('\n').includes('reuse_workers=on'), conf);
    assert.ok(lines.includes('removed lane.explore.kind=grok (research runs on the build lane now)'), lines.join('\n'));
    assert.ok(lines.includes('removed max_workers=3 (derived from the lanes)'), lines.join('\n'));
    assert.ok(lines.includes('set panes=4'), lines.join('\n'));
    assert.ok(lines.includes('set reuse_workers=on'), lines.join('\n'));
    assert.ok(!lines.some((l) => l.startsWith('set lane.')), lines.join('\n'));
    // Mutation captured: writing the preset lane roles or max_workers
    // back into the file, keeping the explore attr, or skipping the
    // removal lines would fail the asserts above.
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('applyLaneFile: lane.read.<attr> moves to lane.review.<attr>, an existing one wins', () => {
  const root = tmp('ha-lanes-apply-read-');
  try {
    const env = isoEnv(root);
    const dest = projectConf(root);
    // The old 3-pane preset (build|read) with a read attr.
    fs.writeFileSync(dest, [
      'panes=3',
      'lane.build.roles=implementer,designer,tasker',
      'lane.read.roles=scouter,researcher,reviewer,security-reviewer,ui-reviewer,inspector',
      'lane.read.kind=codex',
    ].join('\n') + '\n');
    const lines = applyLaneFile(dest, '3', env, repoCwd(root));
    let conf = fs.readFileSync(dest, 'utf8');
    assert.ok(conf.split('\n').includes('lane.review.kind=codex'), conf);
    assert.ok(!/^lane\.read\./m.test(conf), conf);
    assert.ok(!/^lane\..*\.roles=/m.test(conf), conf);
    assert.ok(lines.includes('moved lane.read.kind=codex to lane.review.kind'), lines.join('\n'));
    // The move keeps the comment of the moved line.
    fs.writeFileSync(dest, 'panes=3\nlane.read.effort=low # keep me\n');
    const lines2 = applyLaneFile(dest, '4', env, repoCwd(root));
    conf = fs.readFileSync(dest, 'utf8');
    assert.ok(conf.split('\n').includes('lane.review.effort=low # keep me'), conf);
    assert.ok(lines2.includes('moved lane.read.effort=low to lane.review.effort'), lines2.join('\n'));
    // An existing lane.review.<attr> is not overwritten: the read line is
    // only removed.
    fs.writeFileSync(dest, 'panes=3\nlane.read.kind=codex\nlane.review.kind=grok\n');
    const lines3 = applyLaneFile(dest, '4', env, repoCwd(root));
    conf = fs.readFileSync(dest, 'utf8');
    assert.ok(conf.split('\n').includes('lane.review.kind=grok'), conf);
    assert.ok(!/^lane\.read\./m.test(conf), conf);
    assert.ok(lines3.includes('removed lane.read.kind=codex (lane.review.kind is already set)'), lines3.join('\n'));
    // Key PRESENCE decides, not the value: an empty `lane.review.kind=`
    // line is already set too — the read line is removed and nothing is
    // written (a move would leave two lines for the same key, `grok`
    // above an empty one).
    fs.writeFileSync(dest, 'panes=3\nlane.read.kind=grok\nlane.review.kind=\n');
    const lines5 = applyLaneFile(dest, '4', env, repoCwd(root));
    conf = fs.readFileSync(dest, 'utf8');
    assert.ok(conf.split('\n').filter((l) => l.startsWith('lane.review.kind')).length === 1, `one lane.review.kind line:\n${conf}`);
    assert.ok(conf.split('\n').includes('lane.review.kind='), conf);
    assert.ok(!/^lane\.read\./m.test(conf), conf);
    assert.ok(lines5.includes('removed lane.read.kind=grok (lane.review.kind is already set)'), lines5.join('\n'));
    assert.ok(!lines5.some((l) => l.startsWith('moved lane.read.kind')), lines5.join('\n'));
    // At panes=2 the preset has no review lane: the read attr is removed
    // with the generic line (no move to lane.review.<attr>).
    fs.writeFileSync(dest, 'panes=2\nlane.read.kind=codex\n');
    const lines4 = applyLaneFile(dest, '2', env, repoCwd(root));
    conf = fs.readFileSync(dest, 'utf8');
    assert.ok(!/^lane\.read\./m.test(conf), conf);
    assert.ok(!/^lane\.review\./m.test(conf), conf);
    assert.ok(lines4.includes('removed lane.read.kind=codex (no lane \'read\' in the panes=2 preset)'), lines4.join('\n'));
    // Mutation captured: lane.read.kind overwriting the existing
    // lane.review.kind (the file would read codex and the line would say
    // `moved`), writing a lane.review.kind for a present-but-empty key
    // (two lines for the same key), keeping the read line, or moving at
    // panes=2 (the file would gain a lane.review.kind the preset does not
    // use).
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('applyLaneFile: a custom file keeps its lanes and aligns max_workers to the capacities', () => {
  const root = tmp('ha-lanes-apply-custom-');
  try {
    const env = isoEnv(root);
    const dest = projectConf(root);
    fs.writeFileSync(dest, [
      '# custom comment',
      'lane.ops.roles=implementer,tasker',
      'lane.ops.kind=grok',
      'lane.ops.panes=2',
      'max_workers=7',
      'split_max_panes=6',
      'panes=4',
    ].join('\n') + '\n');
    const lines = applyLaneFile(dest, '4', env, repoCwd(root));
    const conf = fs.readFileSync(dest, 'utf8');
    for (const keep of ['# custom comment', 'lane.ops.roles=implementer,tasker', 'lane.ops.kind=grok', 'lane.ops.panes=2', 'reuse_workers=on']) {
      assert.ok(conf.split('\n').includes(keep), `missing ${keep}:\n${conf}`);
    }
    assert.ok(conf.split('\n').includes('max_workers=2'), conf); // the capacity, not the lane count
    assert.ok(conf.split('\n').includes('split_max_panes=4'), conf);
    assert.ok(!lines.some((l) => l.startsWith('removed lane.') || l.startsWith('moved lane.')), lines.join('\n'));
    assert.ok(lines.includes('set max_workers=2'), lines.join('\n'));
    // The flex mode leaves a live slot for the temporary worker: the
    // written max_workers is the sum + flex_extra, split_max_panes the
    // mode's cap. Without the extra slot the burst dies on the cap
    // (exit 8) once the capacities are full.
    fs.writeFileSync(dest, [
      'lane.ops.roles=implementer,tasker',
      'lane.ops.panes=2',
      'pane_mode=flex',
      'panes=4',
    ].join('\n') + '\n');
    const linesFlex = applyLaneFile(dest, '4', env, repoCwd(root));
    const confFlex = fs.readFileSync(dest, 'utf8');
    assert.ok(confFlex.split('\n').includes('max_workers=3'), confFlex); // 2 capacities + 1 temporary slot
    assert.ok(confFlex.split('\n').includes('split_max_panes=5'), confFlex);
    assert.ok(linesFlex.includes('set max_workers=3'), linesFlex.join('\n'));
    // Mutation captured: the written max_workers without the flex_extra
    // (the file would read max_workers=2 and the burst would hit exit 8),
    // or the max_workers sum replaced by the lane count (the file would
    // read max_workers=1), or the old-lane removal rules running on a
    // custom file.
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('applyLaneFile: any other lane outside the preset is removed, comments stay', () => {
  const root = tmp('ha-lanes-apply-orphan-');
  try {
    const env = isoEnv(root);
    const dest = projectConf(root);
    // No roles lines: the file is a preset file; the orphan attrs of the
    // lanes outside the panes=4 preset are removed, the preset lanes keep
    // their attrs.
    fs.writeFileSync(dest, [
      '# head comment',
      'lane.ops.kind=agy',
      'lane.explore.model=grok-4.7',
      'lane.review.panes=2',
      '# tail comment',
    ].join('\n') + '\n');
    const lines = applyLaneFile(dest, '4', env, repoCwd(root));
    const conf = fs.readFileSync(dest, 'utf8');
    assert.ok(conf.split('\n').includes('# head comment'), conf);
    assert.ok(conf.split('\n').includes('# tail comment'), conf);
    assert.ok(conf.split('\n').includes('lane.review.panes=2'), conf);
    assert.ok(!/^lane\.ops\./m.test(conf), conf);
    assert.ok(!/^lane\.explore\./m.test(conf), conf);
    assert.ok(lines.includes("removed lane.ops.kind=agy (no lane 'ops' in the panes=4 preset)"), lines.join('\n'));
    assert.ok(lines.includes('removed lane.explore.model=grok-4.7 (research runs on the build lane now)'), lines.join('\n'));
    // panes=2: the review lane is outside the preset too (the generic
    // line, not the read move).
    fs.writeFileSync(dest, 'lane.review.kind=grok\n');
    const lines2 = applyLaneFile(dest, '2', env, repoCwd(root));
    const conf2 = fs.readFileSync(dest, 'utf8');
    assert.ok(!/^lane\.review\./m.test(conf2), conf2);
    assert.ok(lines2.includes("removed lane.review.kind=grok (no lane 'review' in the panes=2 preset)"), lines2.join('\n'));
    // Mutation captured: keeping the orphan lanes, or sending the review
    // attr of a panes=2 file through the read move.
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('applyLaneFile: the old presets are treated as preset files (not custom)', () => {
  const root = tmp('ha-lanes-apply-legacy-');
  try {
    const env = isoEnv(root);
    const dest = projectConf(root);
    // The old 4-pane preset signature is a preset file: no custom warn,
    // the roles go, the attrs of the old lanes go with their lines.
    fs.writeFileSync(dest, [
      'lane.build.roles=implementer,designer,tasker',
      'lane.explore.roles=scouter,researcher',
      'lane.explore.kind=grok',
      'lane.review.roles=reviewer,security-reviewer,ui-reviewer,inspector',
      'max_workers=3',
      'panes=4',
    ].join('\n') + '\n');
    const keepErr = process.stderr.write.bind(process.stderr);
    const keepOut = process.stdout.write.bind(process.stdout);
    let err = '';
    process.stderr.write = (s) => { err += s; return true; };
    process.stdout.write = () => true;
    let lines;
    try { lines = applyLaneFile(dest, '4', env, repoCwd(root)); } finally {
      process.stderr.write = keepErr;
      process.stdout.write = keepOut;
    }
    const conf = fs.readFileSync(dest, 'utf8');
    assert.ok(!/^lane\..*\.roles=/m.test(conf), conf);
    assert.ok(!/^max_workers=/m.test(conf), conf);
    assert.ok(conf.split('\n').includes('panes=4'), conf);
    assert.ok(!err.includes('are custom'), `no custom warn:\n${err}`);
    assert.ok(lines.includes('removed max_workers=3 (derived from the lanes)'), lines.join('\n'));
    // Mutation captured: the old preset signature treated as custom (the
    // roles stay and the custom warn prints).
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
    assert.deepEqual(laneNames(cH, envHyphen), ['build', 'review'], 'hyphen env var is invisible');
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
    assert.deepEqual(laneNames(c, env), ['build', 'review']);
    // lanes=off: the lane functions are unchanged (the spawn bypass is
    // in the spawn command); maxWorkers follows the explicit-value rule.
    const off = { ...env, HERDR_AGENTS_LANES: 'off' };
    fs.rmSync(projectConf(root), { force: true });
    c = ctx(root, off);
    assert.ok(!lanesEnabled(c, off));
    assert.deepEqual(laneNames(c, off), ['build', 'review']);
    assert.equal(laneOfRole(c, 'implementer', off), 'build');
    assert.equal(maxWorkers(c, off), '3', 'lanes off: not the lane count');
    assert.equal(panesValue(c, off), '4');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('panesValue: 2, 3 and 4 pass, anything else is 4', () => {
  const empty = { entries: new Map(), sources: [] };
  const env = {};
  assert.equal(panesValue(empty, env), '4');
  assert.equal(panesValue({ entries: new Map([['panes', { value: '2', source: 'project' }]]), sources: [] }, env), '2');
  assert.equal(panesValue({ entries: new Map([['panes', { value: '3', source: 'project' }]]), sources: [] }, env), '3');
  assert.equal(panesValue({ entries: new Map([['panes', { value: '5', source: 'project' }]]), sources: [] }, env), '4');
  assert.equal(panesValue(empty, { HERDR_AGENTS_PANES: '2' }), '2');
  assert.equal(panesValue(empty, { HERDR_AGENTS_PANES: 'x' }), '4');
  assert.deepEqual(presetLaneNames(empty, env), ['build', 'review']);
  // Mutation captured: panesValue still rejecting '2' (it would read 4 and
  // the two-lane preset).
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
    // cap is the sum of the lane capacities (panes=3 -> 1+1).
    fs.rmSync(userConf(root), { force: true });
    fs.rmSync(sessionConf(root), { force: true });
    fs.writeFileSync(projectConf(root), 'panes=3\n');
    c = ctx(root, env);
    assert.equal(cfgLayerRank(c, 'max_workers', env), 0, 'defaults rank');
    assert.equal(maxWorkers(c, env), '2', 'defaults are not explicit: sum of capacities');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('maxWorkers: the sum of the lane capacities (3/2/1 for panes 4/3/2)', () => {
  const root = tmp('ha-lanes-mw-cap-');
  try {
    const env = isoEnv(root);
    fs.rmSync(projectConf(root), { force: true });
    assert.equal(maxWorkers(ctx(root, env), env), '3', 'panes=4 (default): 2+1');
    fs.writeFileSync(projectConf(root), 'panes=3\n');
    assert.equal(maxWorkers(ctx(root, env), env), '2', 'panes=3: 1+1');
    fs.writeFileSync(projectConf(root), 'panes=2\n');
    assert.equal(maxWorkers(ctx(root, env), env), '1', 'panes=2: 1');
    // An explicit max_workers still wins over the capacity sum.
    fs.writeFileSync(projectConf(root), 'panes=4\nmax_workers=9\n');
    assert.equal(maxWorkers(ctx(root, env), env), '9', 'explicit wins');
    // lane.<name>.panes keys change the sum of the preset lanes.
    fs.rmSync(projectConf(root), { force: true });
    fs.writeFileSync(projectConf(root), 'lane.review.panes=2\n');
    assert.equal(maxWorkers(ctx(root, env), env), '4', 'build 2 + review 2');
    fs.writeFileSync(projectConf(root), 'lane.build.panes=5\nlane.review.panes=0\n');
    assert.equal(maxWorkers(ctx(root, env), env), '6', 'invalid key ignored: 5 + preset 1');
    // Mutation captured: the capacity sum replaced by the lane count (panes
    // 4 would read 2), or lane.<name>.panes ignored by maxWorkers.
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

// Per-agent states from a live file (the capacity cases mix
// working/idle/locked workers in one lane).
const FAKE_HERDR_PERNAME = `import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'agent' && args[1] === 'get') {
  const target = args[2];
  if (target === 'gone') {
    process.stderr.write(JSON.stringify({ error: { code: 'agent_not_found', message: 'gone' } }) + '\\n');
    process.exit(1);
  }
  let agents = [];
  try { const j = JSON.parse(fs.readFileSync(process.env.HA_LIVE, 'utf8')); agents = (j && j.agents) ?? []; } catch { agents = []; }
  const a = agents.find((x) => x && x.name === target);
  if (a && a.agent_status === 'denied') {
    process.stderr.write('Error: Os { code: 13, kind: PermissionDenied, message: "Permission denied" }\\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ result: { agent: { name: target, agent_status: a ? a.agent_status : 'idle' } } }) + '\\n');
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

// Same plumbing as decideFixture, but per-agent states from a live file
// (the capacity cases mix working/idle/locked in one lane).
function capFixture(root, rows, live) {
  const env = isoEnv(root);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  writeFakeCli(bin, 'herdr', FAKE_HERDR_PERNAME);
  const liveFile = path.join(root, 'live.json');
  fs.writeFileSync(liveFile, JSON.stringify({ agents: live }));
  const full = { ...env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, HA_LIVE: liveFile };
  const sd = path.join(root, 'state', 'ws-test');
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, 'agents.tsv'), ROSTER + rows.map((r) => (Array.isArray(r) ? r.join('\t') : r)).join('\n') + (rows.length ? '\n' : ''));
  const c = loadConfig(full, repoCwd(root));
  return { env: full, sd, c, root };
}

test('laneDecide: absent, reuse, gone (open), unavailable, capacity open', () => {
  const root = tmp('ha-lanes-decide-');
  try {
    let fx = decideFixture(root, {});
    let d = laneDecide(fx.c, 'build', 'implementer', fx.env, repoCwd(root));
    assert.equal(d.decision, 'absent');
    assert.equal(d.capacity, 2, 'preset4 build capacity');
    assert.equal(d.n, 0);

    // One idle worker: reuse (reuse wins over the spare room).
    fx = decideFixture(root, { rows: [row('build', 'implementer', 'build')] });
    d = laneDecide(fx.c, 'build', 'implementer', fx.env, repoCwd(root));
    assert.equal(d.decision, 'reuse');
    assert.equal(d.name, 'build');
    assert.equal(d.candidate, 'build');
    assert.equal(d.n, 1);

    // A gone row is listed for removal and never counted: the lane is open.
    fx = decideFixture(root, { rows: [row('gone', 'implementer', 'build')] });
    d = laneDecide(fx.c, 'build', 'implementer', fx.env, repoCwd(root));
    assert.equal(d.decision, 'open');
    assert.deepEqual(d.gone, ['gone']);
    assert.equal(d.n, 0);

    // Unavailable: recorded, never spawns a replacement.
    fx = decideFixture(root, { mode: 'denied', rows: [row('build', 'implementer', 'build')] });
    d = laneDecide(fx.c, 'build', 'implementer', fx.env, repoCwd(root));
    assert.equal(d.decision, 'unavailable');
    assert.equal(d.name, 'build');
    assert.equal(d.cause, 'Error: Os { code: 13, kind: PermissionDenied, message: "Permission denied" }');

    // Capacity 2, one occupied worker: room left → open (the new pane fits).
    fx = decideFixture(root, { mode: 'working', rows: [row('build', 'implementer', 'build')] });
    d = laneDecide(fx.c, 'build', 'tasker', fx.env, repoCwd(root));
    assert.equal(d.decision, 'open');
    assert.equal(d.n, 1);

    // panes=3: capacity 1 — the same single working worker is a full lane.
    fs.writeFileSync(projectConf(root), 'panes=3\n');
    fx = decideFixture(root, { mode: 'working', rows: [row('build', 'implementer', 'build')] });
    d = laneDecide(fx.c, 'build', 'tasker', fx.env, repoCwd(root));
    assert.equal(d.decision, 'busy');
    assert.equal(d.name, 'build');
    assert.equal(d.state, 'working');
    assert.equal(d.capacity, 1);
    assert.deepEqual(d.occupants, ['build']);
    // Mutation captured: the capacity ignored in the decision (the full
    // panes=3 lane would read open), the lane count (2) used instead of the
    // capacity (1), or a gone row counted against the capacity.
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('laneDecide: full lane (busy, --fresh candidate, locked), pending-report, reuse by name', () => {
  const root = tmp('ha-lanes-decide3-');
  try {
    // panes=4 build capacity 2: two occupied workers → full (exit 10).
    let fx = capFixture(root,
      [row('build', 'implementer', 'build'), row('build-2', 'tasker', 'build')],
      [{ name: 'build', agent_status: 'working' }, { name: 'build-2', agent_status: 'blocked' }]);
    let d = laneDecide(fx.c, 'build', 'tasker', fx.env, repoCwd(root));
    assert.equal(d.decision, 'busy');
    assert.equal(d.name, 'build', 'first occupant');
    assert.equal(d.state, 'working');
    assert.equal(d.n, 2);
    assert.equal(d.capacity, 2);
    assert.deepEqual(d.occupants, ['build', 'build-2']);

    // --fresh (reuse off): the idle candidate does not fire the reuse; the
    // full lane is busy and the candidate is named (today's --fresh message
    // in the caller).
    fx = capFixture(root,
      [row('build', 'implementer', 'build'), row('build-2', 'tasker', 'build')],
      [{ name: 'build', agent_status: 'idle' }, { name: 'build-2', agent_status: 'working' }]);
    d = laneDecide(fx.c, 'build', 'tasker', fx.env, repoCwd(root), false);
    assert.equal(d.decision, 'busy');
    assert.equal(d.candidate, 'build');
    // ...with room, --fresh opens a new worker instead.
    fx = capFixture(root, [row('build', 'implementer', 'build')], [{ name: 'build', agent_status: 'idle' }]);
    d = laneDecide(fx.c, 'build', 'tasker', fx.env, repoCwd(root), false);
    assert.equal(d.decision, 'open');
    assert.equal(d.candidate, 'build');

    // All live workers locked (edit history, review role) and the lane is
    // full → locked (exit 5 in the caller), the first one named.
    const edited = 'build\tp-build\tgrok\tresearcher\txai\t1\t/repo\tnow\tgrok-4.7\tfull\timplementer,researcher\tbuild';
    const edited2 = 'build-2\tp-build2\tgrok\tresearcher\txai\t1\t/repo\tnow\tgrok-4.7\tfull\timplementer,researcher\tbuild';
    fx = capFixture(root, [edited, edited2], [{ name: 'build', agent_status: 'idle' }, { name: 'build-2', agent_status: 'idle' }]);
    d = laneDecide(fx.c, 'build', 'reviewer', fx.env, repoCwd(root));
    assert.equal(d.decision, 'locked');
    assert.equal(d.name, 'build', 'first locked');

    // The CURRENT role edit (no history) also locks, when the lane is full.
    fx = capFixture(root,
      [row('build', 'implementer', 'build'), row('build-2', 'tasker', 'build')],
      [{ name: 'build', agent_status: 'idle' }, { name: 'build-2', agent_status: 'idle' }]);
    d = laneDecide(fx.c, 'build', 'reviewer', fx.env, repoCwd(root));
    assert.equal(d.decision, 'locked');

    // ...with room left, a locked lane still opens (capacity first). A
    // non-review role over edit workers is a plain candidate.
    fx = capFixture(root, [edited], [{ name: 'build', agent_status: 'idle' }]);
    d = laneDecide(fx.c, 'build', 'reviewer', fx.env, repoCwd(root));
    assert.equal(d.decision, 'open');
    fx = capFixture(root,
      [row('build', 'implementer', 'build'), row('build-2', 'tasker', 'build')],
      [{ name: 'build', agent_status: 'idle' }, { name: 'build-2', agent_status: 'idle' }]);
    d = laneDecide(fx.c, 'build', 'tasker', fx.env, repoCwd(root));
    assert.equal(d.decision, 'reuse');
    assert.equal(d.name, 'build');

    // A pending report makes the worker occupied; at capacity 1 it is busy.
    fs.writeFileSync(projectConf(root), 'panes=3\n');
    fx = capFixture(root, [row('build', 'implementer', 'build')], [{ name: 'build', agent_status: 'idle' }]);
    d = laneDecide(fx.c, 'build', 'tasker', fx.env, repoCwd(root));
    assert.equal(d.decision, 'reuse', 'no report yet: candidate');
    fs.writeFileSync(path.join(fx.sd, 'last-report-build'), path.join(fx.sd, 'reports', 'build.md') + '\n');
    d = laneDecide(fx.c, 'build', 'tasker', fx.env, repoCwd(root));
    assert.equal(d.decision, 'busy');
    assert.equal(d.state, 'pending-report');
    assert.equal(d.name, 'build');

    // Fallback to the worker name when the lane column is missing (11 cols):
    // old rows count when named as the lane.
    fx = capFixture(root, ['explore\tp-e\tagy\tscouter\tgoogle\t1\t/repo\tnow\tgemini\tfull\tscouter'], [{ name: 'explore', agent_status: 'idle' }]);
    d = laneDecide(fx.c, 'explore', 'researcher', fx.env, repoCwd(root));
    assert.equal(d.decision, 'reuse');
    assert.equal(d.name, 'explore');
    // A lane column always wins over the name: a row named 'build' in the
    // review lane is not a build worker.
    fx = capFixture(root, [row('build', 'inspector', 'review')], [{ name: 'build', agent_status: 'idle' }]);
    assert.equal(laneWorkers(fx.sd, 'build').length, 0, 'lane column wins');
    assert.equal(laneWorkers(fx.sd, 'review').length, 1);
    // Mutation captured: the lane column losing to the name (a review worker
    // counted as a build worker), a pending report counting as reusable, or
    // --fresh reusing the idle candidate instead of reporting it.
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

// A roster row with the 13th column `burst` (a temporary worker). The
// plain row() helper slices to 12 columns, so a burst row is built with the
// marker in column 13.
const burstRow = (name, role, lane) =>
  [name, `p-${name}`, 'grok', role, 'xai', '1', '/repo', 'now', 'grok-4.7', 'full', role, lane, 'burst'];

test('liveBurstWorkers: only the temporary (burst) workers that are live', () => {
  const root = tmp('ha-lanes-burst-live-');
  try {
    const env = isoEnv(root);
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    writeFakeCli(bin, 'herdr', FAKE_LIVE);
    const live = path.join(root, 'live.json');
    // b1 and b2 are burst rows; w1 is a plain row. All three are live.
    fs.writeFileSync(live, JSON.stringify({ result: { agents: [
      { name: 'b1', pane_id: 'p-b1' }, { name: 'b2', pane_id: 'p-b2' }, { name: 'w1', pane_id: 'p-w1' },
    ] } }) + '\n');
    const full = { ...env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, HA_LIVE: live };
    const sd = path.join(root, 'state', 'ws-test');
    fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(path.join(sd, 'agents.tsv'),
      ROSTER + [burstRow('b1', 'documenter', 'docs'), row('w1', 'implementer', 'build'), burstRow('b2', 'reviewer', 'review')].map((r) => r.join('\t')).join('\n') + '\n');
    assert.deepEqual(liveBurstWorkers(sd, full), ['b1', 'b2'], 'burst rows only');
    assert.deepEqual(liveWorkerNames(sd, full), ['b1', 'w1', 'b2'], 'plain rows still listed');
    // A burst worker that is no longer live is not counted.
    fs.writeFileSync(live, JSON.stringify({ result: { agents: [
      { name: 'b1', pane_id: 'p-b1' }, { name: 'w1', pane_id: 'p-w1' },
    ] } }) + '\n');
    assert.deepEqual(liveBurstWorkers(sd, full), ['b1'], 'dead burst worker dropped');
    // Mutation captured: counting a plain (non-burst) row as temporary, or
    // a live burst worker that is gone.
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
