// Layout (slice 5a): every case of test-layout.sh — the split anchor by
// area, per-tab capacity, the minimum pane, the grid shapes, `layout-plan`
// over a fixture (byte-for-byte, like the bash suite asserts), the herd
// tabs first-with-room / new-tab path and the focus return — plus
// splitCap/splitMin with invalid values, explicit split_max_panes and the
// lanes-on follows-panes rule. The herd-tab and focus sections run against
// a fake `herdr` (writeFakeCli) in PATH; the pure functions run in
// process. Every test builds its own temp
// HOME/XDG_CONFIG_HOME/TMPDIR/HERDR_AGENTS_DIR (decision 10).
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
  splitCap, splitMin, splitAnchorFromLayout, gridSizes, autoDirectionFor,
  pickSplitAnchor, uiFocusedPane, restoreFocusIfStolen,
} from '../lib/layout.mjs';
import { herdTabPane } from '../lib/herdtabs.mjs';

const SCRIPTS = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ENTRY = path.join(SCRIPTS, 'herdr-agents.mjs');

function tmp(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return fs.realpathSync(root);
}

// Isolated env: temp HOME / XDG_CONFIG_HOME / TMPDIR / HERDR_AGENTS_DIR,
// nothing else leaks in (the test runs hermetic, like the bash suites).
function isoEnv(root) {
  for (const d of ['home', 'conf', 'tmp', 'state/ws', 'repo']) fs.mkdirSync(path.join(root, d), { recursive: true });
  return {
    HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'conf'),
    TMPDIR: path.join(root, 'tmp'),
    HERDR_AGENTS_DIR: path.join(root, 'state'),
    HERDR_WORKSPACE_ID: 'ws',
  };
}

const projectConf = (root) => path.join(root, 'repo', '.agents', 'herdr-agents.conf');
const ctx = (root, env) => loadConfig(env, path.join(root, 'repo'));

// layout <tab-w> <tab-h> "<id> <x> <y> <w> <h>" … → a `herdr pane layout`
// document (test-layout.sh's helper, same shape).
function layout(W, H, ...specs) {
  const panes = specs.map((s) => {
    const [id, ...nums] = s.split(' ');
    const [x, y, w, h] = nums.map(Number);
    return { pane_id: id, focused: false, rect: { x, y, width: w, height: h } };
  });
  return JSON.parse(JSON.stringify({ result: { layout: { area: { x: 0, y: 0, width: W, height: H }, panes } } }));
}

const doc = (...args) => layout(...args);

// --- anchor by area (pure, all test-layout.sh cases) ----------------------

test('split anchor: by area, tie to the worker, foreign panes ignored', () => {
  // caller alone: the full tab is as wide as it is tall in fractions → right
  assert.deepEqual(splitAnchorFromLayout(doc(213, 57, 'C 0 0 213 57'), 'C', [], 6, 0.18), { anchor: 'C', direction: 'right' });
  // two columns: both 0.5x1.0 → the taller side wins (down); tie on area
  // goes to the worker, not the caller
  assert.deepEqual(splitAnchorFromLayout(doc(213, 57, 'C 0 0 107 57', 'A 107 0 106 57'), 'C', ['A'], 6, 0.18), { anchor: 'A', direction: 'down' });
  // the operator's screenshot: one full column next to a stack of strips
  // → split the full column, not the strips
  assert.deepEqual(
    splitAnchorFromLayout(doc(213, 57, 'C 0 0 107 57', 'A 107 0 106 29', 'B 107 29 106 14', 'D 107 43 106 14'), 'C', ['A', 'B', 'D'], 6, 0.18),
    { anchor: 'C', direction: 'down' },
  );
  // panes not in the roster (another tool's shell) are not candidates and do not count
  assert.deepEqual(splitAnchorFromLayout(doc(213, 57, 'C 0 0 107 57', 'X 107 0 106 57'), 'C', [], 6, 0.18), { anchor: 'C', direction: 'down' });
  // --direction/--ratio are not part of the pure decision: the wider fraction decides
  assert.deepEqual(splitAnchorFromLayout(doc(213, 57, 'C 0 0 213 20', 'A 0 20 213 37'), 'C', ['A'], 6, 0.18), { anchor: 'A', direction: 'right' });
  // a document without a usable layout reads as no candidates (jq would fail)
  assert.equal(splitAnchorFromLayout(null, 'C', [], 6, 0.18), null);
  assert.equal(splitAnchorFromLayout({ result: { layout: { panes: [] } } }, 'C', [], 6, 0.18), null);
  assert.equal(splitAnchorFromLayout({ no: 'layout' }, 'C', [], 6, 0.18), null);
});

// --- capacity (pure) --------------------------------------------------------

test('split anchor: per-tab capacity', () => {
  const GRID3x2 = doc(213, 57, 'C 0 0 71 57', 'A 71 0 71 29', 'B 71 29 71 28', 'D 142 0 71 29', 'E 142 29 71 28');
  assert.deepEqual(splitAnchorFromLayout(GRID3x2, 'C', ['A', 'B', 'D', 'E'], 6, 0.18), { anchor: 'C', direction: 'down' });
  const FULL = doc(213, 57, 'C 0 0 71 29', 'F 0 29 71 28', 'A 71 0 71 29', 'B 71 29 71 28', 'D 142 0 71 29', 'E 142 29 71 28');
  assert.deepEqual(splitAnchorFromLayout(FULL, 'C', ['A', 'B', 'D', 'E', 'F'], 6, 0.18), { overflow: 'full' });
  assert.deepEqual(splitAnchorFromLayout(FULL, 'C', ['A', 'B', 'D', 'E', 'F'], 9, 0.18), { anchor: 'A', direction: 'down' });
  assert.deepEqual(splitAnchorFromLayout(doc(213, 57, 'C 0 0 213 57'), 'C', [], 1, 0.18), { overflow: 'full' });
});

// --- minimum pane (pure) -----------------------------------------------------

test('split anchor: minimum pane', () => {
  // 3x3 grid (0.333 x 0.333): halving any side gives 0.167 < 0.18 →
  // overflow by min, even under a cap of 12
  const GRID3x3 = doc(213, 57, 'C 0 0 71 19', 'A 0 19 71 19', 'B 0 38 71 19', 'D 71 0 71 19', 'E 71 19 71 19', 'F 71 38 71 19', 'G 142 0 71 19', 'H 142 19 71 19', 'I 142 38 71 19');
  assert.deepEqual(splitAnchorFromLayout(GRID3x3, 'C', ['A', 'B', 'D', 'E', 'F', 'G', 'H', 'I'], 12, 0.18), { overflow: 'min' });
  assert.deepEqual(splitAnchorFromLayout(GRID3x3, 'C', ['A', 'B', 'D', 'E', 'F', 'G', 'H', 'I'], 12, 0.1), { anchor: 'D', direction: 'right' });
  // a small pane is skipped even when it is the only worker; the caller
  // (still large) is split instead
  assert.deepEqual(splitAnchorFromLayout(doc(213, 57, 'C 0 0 213 45', 'A 0 45 213 12'), 'C', ['A'], 6, 0.18), { anchor: 'C', direction: 'right' });
});

// --- grid shapes (pure) -------------------------------------------------------

test('grid sizes: the extra rows go to the last columns', () => {
  assert.deepEqual(gridSizes(1), { cols: 1, rows: [1] });
  assert.deepEqual(gridSizes(2), { cols: 2, rows: [1, 1] });
  assert.deepEqual(gridSizes(3), { cols: 2, rows: [1, 2] }); // caller column stays single
  assert.deepEqual(gridSizes(4), { cols: 2, rows: [2, 2] });
  assert.deepEqual(gridSizes(5), { cols: 3, rows: [1, 2, 2] });
  assert.deepEqual(gridSizes(6), { cols: 3, rows: [2, 2, 2] });
  assert.deepEqual(gridSizes(7), { cols: 3, rows: [2, 2, 3] });
  assert.deepEqual(gridSizes(0), { cols: 0, rows: [] });
});

// --- splitCap / splitMin: invalid values, explicit, follows panes -----------

test('splitCap/splitMin: validation and the lanes-on follows-panes rule', () => {
  const root = tmp('ha-layout-cap-');
  try {
    const env = isoEnv(root);
    let e = ctx(root, env);
    assert.equal(splitCap(e, env), 4, 'default: lanes on, no explicit → panes (4)');
    assert.equal(splitMin(e, env), 0.18, 'default min');

    e = ctx(root, { ...env, HERDR_AGENTS_PANES: '3' });
    assert.equal(splitCap(e, env), 4, 'env panes does not override the config panes');
    assert.equal(splitCap(e, { ...env, HERDR_AGENTS_PANES: '3' }), 3, 'lanes on → follows panes=3');

    e = ctx(root, { ...env, HERDR_AGENTS_SPLIT_MAX_PANES: '6' });
    assert.equal(splitCap(e, { ...env, HERDR_AGENTS_SPLIT_MAX_PANES: '6' }), 6, 'explicit env value wins');

    fs.mkdirSync(path.dirname(projectConf(root)), { recursive: true });
    fs.writeFileSync(projectConf(root), 'split_max_panes=5\n');
    e = ctx(root, env);
    assert.equal(splitCap(e, env), 5, 'explicit project value wins');

    fs.writeFileSync(projectConf(root), 'split_max_panes=abc\n');
    e = ctx(root, env);
    assert.equal(splitCap(e, env), 4, 'invalid value → default');

    fs.writeFileSync(projectConf(root), 'split_max_panes=1.5\n');
    e = ctx(root, env);
    assert.equal(splitCap(e, env), 4, 'non-integer → default');

    fs.writeFileSync(projectConf(root), 'lanes=off\npanes=3\n');
    e = ctx(root, env);
    assert.equal(splitCap(e, env), 4, 'lanes off → cfg default, does not follow panes');

    fs.writeFileSync(projectConf(root), 'lanes=off\nsplit_max_panes=7\npanes=3\n');
    e = ctx(root, env);
    assert.equal(splitCap(e, env), 7, 'lanes off → the explicit value');

    // flex mode: the derived cap adds the temporary panel, so the burst
    // worker fits the caller's tab (panes + flex_extra).
    fs.writeFileSync(projectConf(root), 'panes=3\npane_mode=flex\n');
    e = ctx(root, env);
    assert.equal(splitCap(e, env), 4, 'flex lanes on, no explicit → panes(3) + flex_extra(1) = 4');
    fs.writeFileSync(projectConf(root), 'panes=4\npane_mode=flex\nflex_extra=2\n');
    e = ctx(root, env);
    assert.equal(splitCap(e, env), 6, 'flex flex_extra=2 → panes(4) + 2 = 6');
    // An explicit split_max_panes still wins over the flex derivation.
    fs.writeFileSync(projectConf(root), 'panes=4\npane_mode=flex\nsplit_max_panes=3\n');
    e = ctx(root, env);
    assert.equal(splitCap(e, env), 3, 'flex with an explicit split_max_panes → the explicit value');

    assert.equal(splitMin(e, { ...env, HERDR_AGENTS_SPLIT_MIN_PANE: '0.10' }), 0.1, 'env min');
    assert.equal(splitMin(e, { ...env, HERDR_AGENTS_SPLIT_MIN_PANE: '1' }), 0.18, 'integer → default');
    assert.equal(splitMin(e, { ...env, HERDR_AGENTS_SPLIT_MIN_PANE: '0.5x' }), 0.18, 'bad fraction → default');
    assert.equal(splitMin(e, { ...env, HERDR_AGENTS_SPLIT_MIN_PANE: '0.123' }), 0.123, 'long fraction kept');
    assert.equal(splitMin(e, { ...env, HERDR_AGENTS_SPLIT_MIN_PANE: '.9' }), 0.9, 'leading zero optional');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- layout-plan over a fixture (byte-for-byte, like the bash suite) -------

// The exact bytes the bash suite produces (captured from the bash script);
// the JS entry must match them byte for byte.
const GRID3x2 = JSON.stringify({
  result: { layout: { area: { x: 0, y: 0, width: 213, height: 57 }, panes: [
    { pane_id: 'C', focused: false, rect: { x: 0, y: 0, width: 71, height: 57 } },
    { pane_id: 'A', focused: false, rect: { x: 71, y: 0, width: 71, height: 29 } },
    { pane_id: 'B', focused: false, rect: { x: 71, y: 29, width: 71, height: 28 } },
    { pane_id: 'D', focused: false, rect: { x: 142, y: 0, width: 71, height: 29 } },
    { pane_id: 'E', focused: false, rect: { x: 142, y: 29, width: 71, height: 28 } },
  ] } } });
const FULL = JSON.stringify({
  result: { layout: { area: { x: 0, y: 0, width: 213, height: 57 }, panes: [
    { pane_id: 'C', focused: false, rect: { x: 0, y: 0, width: 71, height: 29 } },
    { pane_id: 'F', focused: false, rect: { x: 0, y: 29, width: 71, height: 28 } },
    { pane_id: 'A', focused: false, rect: { x: 71, y: 0, width: 71, height: 29 } },
    { pane_id: 'B', focused: false, rect: { x: 71, y: 29, width: 71, height: 28 } },
    { pane_id: 'D', focused: false, rect: { x: 142, y: 0, width: 71, height: 29 } },
    { pane_id: 'E', focused: false, rect: { x: 142, y: 29, width: 71, height: 28 } },
  ] } } });

function runLayoutPlan(input, args, env, cwd) {
  return spawnSync(nodeBin(), [ENTRY, 'layout-plan', ...args], { input, env, cwd, encoding: 'utf8' });
}

test('layout-plan over a fixture: default cap full, cap 6 split, full grid', () => {
  const root = tmp('ha-layout-plan-');
  try {
    const env = isoEnv(root);
    const cwd = path.join(root, 'repo');
    // Default cap is 4 panes (caller + max_workers 3): a fifth pane overflows.
    let r = runLayoutPlan(GRID3x2, ['--layout', '-', '--me', 'C', '--mine', 'A B D'], env, cwd);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout,
      '{"placement":"herd","anchor":null,"direction":null,"reason":"full","cap":4,"min_pane":0.18,' +
      '"candidates":[{"pane_id":"C","caller":true,"width":0.333,"height":1},' +
      '{"pane_id":"A","caller":false,"width":0.333,"height":0.509},' +
      '{"pane_id":"B","caller":false,"width":0.333,"height":0.491},' +
      '{"pane_id":"D","caller":false,"width":0.333,"height":0.509}],"grid":null}\n');
    // Geometry with the cap raised to 6 (3x2 grid).
    r = runLayoutPlan(GRID3x2, ['--layout', '-', '--me', 'C', '--mine', 'A B D E'], { ...env, HERDR_AGENTS_SPLIT_MAX_PANES: '6' }, cwd);
    assert.equal(r.status, 0, r.stderr);
    const plan = JSON.parse(r.stdout);
    assert.equal(`${plan.placement} ${plan.anchor} ${plan.direction}`, 'split C down');
    assert.deepEqual(plan.grid, { cells: 6, cols: 3, rows_per_col: [2, 2, 2] });
    assert.equal(plan.cap, 6);
    assert.equal(plan.min_pane, 0.18);
    // The full grid overflows even at cap 6.
    r = runLayoutPlan(FULL, ['--layout', '-', '--me', 'C', '--mine', 'A B D E F'], { ...env, HERDR_AGENTS_SPLIT_MAX_PANES: '6' }, cwd);
    assert.equal(r.status, 0, r.stderr);
    const p2 = JSON.parse(r.stdout);
    assert.equal(`${p2.placement} ${p2.reason}`, 'herd full');
    assert.equal(p2.anchor, null);
    assert.equal(p2.direction, null);
    assert.equal(p2.grid, null);
    assert.equal(p2.candidates.length, 6);
    // --layout with a file, and its errors.
    const fx = path.join(root, 'fx.json');
    fs.writeFileSync(fx, GRID3x2);
    r = runLayoutPlan('', ['--layout', fx, '--me', 'C', '--mine', 'A B D'], env, cwd);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).placement, 'herd');
    r = runLayoutPlan('', ['--layout', path.join(root, 'missing.json'), '--me', 'C'], env, cwd);
    assert.equal(r.status, 2);
    assert.equal(r.stderr, `cat: ${path.join(root, 'missing.json')}: No such file or directory\nherdr-agents: layout-plan: cannot read ${path.join(root, 'missing.json')}\n`);
    r = runLayoutPlan('', ['--layout'], env, cwd);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.stderr, 'herdr-agents: layout-plan: --layout expects a value\n');
    r = runLayoutPlan('', ['--bogus'], env, cwd);
    assert.equal(r.status, 2);
    assert.equal(r.stderr, "herdr-agents: layout-plan: unknown option --bogus\n");
    // No candidates at all (vazio document): the caller pane stands in, right.
    const vazio = JSON.stringify({ result: { layout: { area: { x: 0, y: 0, width: 213, height: 57 }, panes: [] } } });
    r = runLayoutPlan(vazio, ['--layout', '-', '--me', 'C', '--mine', 'A B D'], env, cwd);
    assert.equal(r.status, 0, r.stderr);
    const p3 = JSON.parse(r.stdout);
    assert.equal(`${p3.placement} ${p3.anchor} ${p3.direction}`, 'split C right');
    assert.deepEqual(p3.candidates, []);
    assert.deepEqual(p3.grid, { cells: 1, cols: 1, rows_per_col: [1] });
    // Live mode outside Herdr dies 2 (require_env).
    r = runLayoutPlan('', [], env, cwd);
    assert.equal(r.status, 2);
    assert.equal(r.stderr, 'herdr-agents: not running inside Herdr (HERDR_ENV != 1); refusing to control a session from outside\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- herd tabs: first tab with room, else a new tab named after the role ---

// Fake herdr (the bash suite's fixture as a Node script): two herd tabs
// exist (t1 full with 6 workers, t2 with 2); `tab create`, `tab rename`
// and `pane split` log what they were asked.
function herdFakeSource(root) {
  return `
import fs from 'node:fs';
import path from 'node:path';
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(${JSON.stringify(root)}, 'herdr.log'), argv.join(' ') + '\\n');
const cmd = (argv[0] ?? '') + ' ' + (argv[1] ?? '');
const out = (s) => process.stdout.write(s + '\\n');
switch (cmd) {
  case 'tab get': {
    const t = argv[2] ?? '';
    if (t === 't1' || t === 't2' || t === 't3') {
      out(JSON.stringify({ result: { tab: { tab_id: t, label: 'herd' }, root_pane: { pane_id: 'r' } } }));
      break;
    }
    out('{"error":"tab_not_found"}');
    process.exit(1);
    break;
  }
  case 'tab rename': out('{"result":{}}'); break;
  case 'pane list': out(JSON.stringify({ result: { panes: [
    { pane_id: 'w1', tab_id: 't1' }, { pane_id: 'w2', tab_id: 't1' }, { pane_id: 'w3', tab_id: 't1' },
    { pane_id: 'w4', tab_id: 't1' }, { pane_id: 'w5', tab_id: 't1' }, { pane_id: 'w6', tab_id: 't1' },
    { pane_id: 'w7', tab_id: 't2' }, { pane_id: 'w8', tab_id: 't2' },
  ] } })); break;
  case 'agent get': out(JSON.stringify({ result: { agent: { name: argv[2] ?? '' } } })); break;
  case 'pane layout': out(JSON.stringify({ result: { layout: { panes: [{ pane_id: 'w8', rect: { x: 0, y: 0, width: 213, height: 28 } }] } } })); break;
  case 'pane split': out('{"result":{"pane":{"pane_id":"new-split"}}}'); break;
  case 'tab create': out('{"result":{"tab":{"tab_id":"t3"},"root_pane":{"pane_id":"new-root"}}}'); break;
  default:
    process.stderr.write(JSON.stringify({ error: 'unexpected: ' + argv.join(' ') }) + '\\n');
    process.exit(1);
}
`;
}

test('herd tabs: second tab with room splits it; dead tab pruned, old format migrated', () => {
  const root = tmp('ha-layout-herdtab-');
  try {
    const bin = path.join(root, 'bin');
    const state = path.join(root, 'state');
    const cwd = path.join(root, 'repo');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(state, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    writeFakeCli(bin, 'herdr', herdFakeSource(root));
    const env = {
      ...isoEnv(root),
      HERDR_AGENTS_DIR: state,
      HERDR_AGENTS_SPLIT_MAX_PANES: '6',
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    };
    fs.writeFileSync(path.join(state, 'ws', 'herd-tab'), 't1\nt2\ndead-tab\n'); // old one-column format
    const rows = ['# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted'];
    for (let i = 1; i <= 8; i += 1) rows.push(`a${i}\tw${i}\tclaude\tscouter\tanthropic\t1\t/tmp\tnow`);
    fs.writeFileSync(path.join(state, 'ws', 'agents.tsv'), rows.join('\n') + '\n');
    const c = loadConfig(env, cwd);
    const res = herdTabPane(c, '/tmp', '', '', env, cwd);
    assert.deepEqual(res, { pane: 'new-split', created: 1 });
    const log = fs.readFileSync(path.join(root, 'herdr.log'), 'utf8').split('\n').filter(Boolean);
    assert.ok(log.includes('pane split w8 --direction right --cwd /tmp --no-focus'), `expected a split of the last pane of t2, log: ${log.join('\n')}`);
    assert.equal(fs.readFileSync(path.join(state, 'ws', 'herd-tab'), 'utf8'), 't1\therd\tauto\nt2\therd\tauto\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('herd tabs: every tab full → a new auto tab named after the role', () => {
  const root = tmp('ha-layout-herdtab2-');
  try {
    const bin = path.join(root, 'bin');
    const state = path.join(root, 'state');
    const cwd = path.join(root, 'repo');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(state, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    writeFakeCli(bin, 'herdr', herdFakeSource(root));
    const env = {
      ...isoEnv(root),
      HERDR_AGENTS_DIR: state,
      HERDR_AGENTS_SPLIT_MAX_PANES: '2',
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    };
    fs.writeFileSync(path.join(state, 'ws', 'herd-tab'), 't1\therd\tauto\nt2\therd\tauto\n');
    const rows = ['# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted'];
    for (let i = 1; i <= 8; i += 1) rows.push(`a${i}\tw${i}\tclaude\tscouter\tanthropic\t1\t/tmp\tnow`);
    fs.writeFileSync(path.join(state, 'ws', 'agents.tsv'), rows.join('\n') + '\n');
    const c = loadConfig(env, cwd);
    const res = herdTabPane(c, '/tmp', '', 'implementer', env, cwd);
    assert.deepEqual(res, { pane: 'new-root', created: 1 });
    const log = fs.readFileSync(path.join(root, 'herdr.log'), 'utf8').split('\n').filter(Boolean);
    assert.ok(log.some((l) => l.startsWith('tab create ') && l.includes('--label impl')), `expected a tab labelled impl, log: ${log.join('\n')}`);
    assert.equal(fs.readFileSync(path.join(state, 'ws', 'herd-tab'), 'utf8'), 't1\therd\tauto\nt2\therd\tauto\nt3\timpl\tauto\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- focus: undo a steal only while the keyboard is still on that pane -----

function focusFakeSource(root) {
  return `
import fs from 'node:fs';
import path from 'node:path';
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(${JSON.stringify(root)}, 'focus.log'), argv.join(' ') + '\\n');
const cmd = (argv[0] ?? '') + ' ' + (argv[1] ?? '');
const out = (s) => process.stdout.write(s + '\\n');
switch (cmd) {
  case 'pane list': {
    const p = process.env.FOCUS_PANE ?? 'none';
    out(JSON.stringify({ result: { panes: [{ pane_id: p, focused: true }] } }));
    break;
  }
  case 'agent focus':
    if (process.env.FOCUS_AGENT_FAIL === '1') process.exit(1);
    out('{"result":{}}');
    break;
  case 'pane focus': out('{"result":{}}'); break;
  default:
    process.stderr.write('{"error":"unexpected"}\\n');
    process.exit(1);
}
`;
}

test('restore focus: only the steal, only while the keyboard is still there', () => {
  const root = tmp('ha-layout-focus-');
  try {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    writeFakeCli(bin, 'herdr', focusFakeSource(root));
    const logFile = path.join(root, 'focus.log');
    const baseEnv = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      HERDR_PANE_ID: 'caller',
    };
    const focusCmds = () => fs.existsSync(logFile)
      ? fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.startsWith('agent focus') || l.startsWith('pane focus'))
      : [];
    const reset = (over) => {
      fs.rmSync(logFile, { force: true });
      return { ...baseEnv, ...over };
    };
    // stolen focus returns to the previous pane
    let env = reset({ FOCUS_PANE: 'newp' });
    restoreFocusIfStolen('userp', 'newp', 'right', env);
    assert.deepEqual(focusCmds(), ['agent focus userp']);
    // a pane the user moved to is left alone
    env = reset({ FOCUS_PANE: 'other' });
    restoreFocusIfStolen('userp', 'newp', 'right', env);
    assert.deepEqual(focusCmds(), []);
    // empty or unchanged focus is not touched
    env = reset({ FOCUS_PANE: 'newp' });
    restoreFocusIfStolen('', 'newp', 'right', env);
    restoreFocusIfStolen('newp', 'newp', 'right', env);
    assert.deepEqual(focusCmds(), []);
    // caller shell: agent focus failed → step back across the split
    env = reset({ FOCUS_PANE: 'newp', FOCUS_AGENT_FAIL: '1', HERDR_PANE_ID: 'userp' });
    restoreFocusIfStolen('userp', 'newp', 'right', env);
    assert.equal(focusCmds().at(-1), 'pane focus --direction left --pane newp');
    // a non-caller shell is not chased with a directional focus
    env = reset({ FOCUS_PANE: 'newp' });
    restoreFocusIfStolen('userp', 'newp', 'right', env);
    assert.deepEqual(focusCmds(), ['agent focus userp']);
    // down split steps back up
    env = reset({ FOCUS_PANE: 'newp', FOCUS_AGENT_FAIL: '1', HERDR_PANE_ID: 'userp' });
    restoreFocusIfStolen('userp', 'newp', 'down', env);
    assert.equal(focusCmds().at(-1), 'pane focus --direction up --pane newp');
    // uiFocusedPane: the focused pane across workspaces ('' when herdr
    // fails)
    assert.equal(uiFocusedPane(env), 'newp');
    assert.equal(uiFocusedPane({ ...env, PATH: '/nonexistent' }), '');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// pickSplitAnchor: live layout + roster (no usable layout → caller right).
test('pickSplitAnchor: no usable layout falls back to the caller pane right', () => {
  const root = tmp('ha-layout-pick-');
  try {
    const bin = path.join(root, 'bin');
    const cwd = path.join(root, 'repo');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    // A herdr that answers `pane layout --current` with garbage.
    writeFakeCli(bin, 'herdr', "process.stdout.write('not json');\n");
    const env = {
      ...isoEnv(root),
      HERDR_PANE_ID: 'C',
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    };
    const c = loadConfig(env, cwd);
    assert.deepEqual(pickSplitAnchor(c, env, cwd), { anchor: 'C', direction: 'right' });
    // A usable layout: the largest of caller + roster workers.
    writeFakeCli(bin, 'herdr', 'if (process.argv[2] === "pane" && process.argv[3] === "layout") process.stdout.write(' +
      JSON.stringify(JSON.stringify({
        result: { layout: { area: { x: 0, y: 0, width: 213, height: 57 }, panes: [
          { pane_id: 'C', focused: false, rect: { x: 0, y: 0, width: 107, height: 57 } },
          { pane_id: 'A', focused: false, rect: { x: 107, y: 0, width: 106, height: 57 } },
        ] } } })) +
      ");\n");
    const rows = ['# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted', 'a1\tA\tclaude\tscouter\tanthropic\t1\t/tmp\tnow'];
    fs.mkdirSync(path.join(root, 'state', 'ws'), { recursive: true });
    fs.writeFileSync(path.join(root, 'state', 'ws', 'agents.tsv'), rows.join('\n') + '\n');
    assert.deepEqual(pickSplitAnchor(c, env, cwd), { anchor: 'A', direction: 'down' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// autoDirectionFor: the pure decision over a fake `pane layout` answer.
test('autoDirectionFor: wide pane right, tall pane down, missing pane right', () => {
  const root = tmp('ha-layout-auto-');
  try {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const envBase = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` };
    writeFakeCli(bin, 'herdr', 'if (process.argv[2] === "pane" && process.argv[3] === "layout") process.stdout.write(' +
      JSON.stringify(JSON.stringify({
        result: { layout: { panes: [
          { pane_id: 'wide', focused: false, rect: { x: 0, y: 0, width: 213, height: 28 } },
          { pane_id: 'tall', focused: true, rect: { x: 0, y: 0, width: 57, height: 213 } },
        ] } } })) +
      ");\n");
    assert.equal(autoDirectionFor(envBase, 'wide'), 'right');
    assert.equal(autoDirectionFor(envBase, 'tall'), 'down');
    assert.equal(autoDirectionFor(envBase, 'nope'), 'down'); // pane not in the layout
    // --current: the focused pane is used when no pane id is selected.
    const envCur = { ...envBase, HERDR_PANE_ID: '' };
    assert.equal(autoDirectionFor(envCur, ''), 'down');
    // herdr missing → no layout → right.
    assert.equal(autoDirectionFor({ ...process.env, PATH: '/nonexistent' }, 'wide'), 'right');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Invalid JSON: bash lets jq fail mid-pipeline (rc 5 and jq's error); the
// port reports the document as invalid (rc 2), for a file and for stdin.
test('layout-plan: a --layout document that is not JSON exits 2 with a message', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ha-layout-badjson-')));
  try {
    const cwd = path.join(root, 'repo');
    fs.mkdirSync(cwd, { recursive: true });
    const bad = path.join(root, 'bad.json');
    fs.writeFileSync(bad, 'not json');
    const env = isoEnv(root);
    const r = spawnSync(nodeBin(), [ENTRY, 'layout-plan', '--layout', bad, '--me', 'C'], { env, cwd, encoding: 'utf8' });
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, `herdr-agents: layout-plan: ${bad} is not a pane layout JSON document\n`);
    const s = spawnSync(nodeBin(), [ENTRY, 'layout-plan', '--layout', '-', '--me', 'C'], { env, cwd, encoding: 'utf8', input: '{' });
    assert.equal(s.status, 2, s.stderr);
    assert.equal(s.stderr, 'herdr-agents: layout-plan: stdin is not a pane layout JSON document\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
