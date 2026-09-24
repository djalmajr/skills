// regrid (slice 8a): the units the acceptance criterion lists —
// buildGrid's pane-move sequence for 2 to 7 cells (column heads first, then
// rows, the 4-decimal ratios), a failed move, applyGrid updating the roster
// when the pane id changes, parkPanes (herd-park tab, the rest split down
// off the first), cmdRegrid with layout=split (pull-back from a herd tab up
// to the cap, park + grid around the caller, the emptied tab forgotten),
// herd tabs with 1 pane (kept) and 3 (rebuilt in a fresh tab), the
// pane-move failure (message and code 4), and the automatic regrid of
// spawn and release --close (a failure becoming the bash warning). A fake
// `herdr` (writeFakeCli) tracks the pane→tab state so the refetched `pane
// list` reflects the moves; the real herdr is never used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeFakeCli } from './fakes.mjs';
import { nodeBin } from './parity.mjs';
import { fileURLToPath } from 'node:url';
import { loadConfig, DieError } from '../lib/config.mjs';
import {
  buildGrid, applyGrid, parkPanes, movePane, cmdRegrid, autoRegrid,
} from '../lib/regrid.mjs';

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS_ENTRY = path.join(SCRIPTS, 'herdr-agents.mjs');

// ---------- fake herdr (Node, tracked pane→tab state) ----------
// Every call is logged as one "$*" line (FAKE_LOG). `pane list --workspace`
// answers from FAKE_STATE (lines `pane<TAB>tab`, seed order); the bare
// `pane list` reports FAKE_FOCUSED. `agent get` per FAKE_MODE_DIR/mode-<t>
// else FAKE_MODE (denied → PermissionDenied, missing → agent_not_found,
// else the mode as agent_status). `pane move` rewrites FAKE_STATE (the new
// id is m-<pane> when FAKE_REMAP exists, the same pane otherwise),
// `--new-tab` creates park-N (label file in FAKE_TABS); FAKE_MOVE_FAIL
// fails every move, FAKE_MOVE_FAIL_AFTER fails from the (N+1)-th on.
const HERDR_FAKE = `
import fs from 'node:fs';
const argv = process.argv.slice(2);
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, argv.join(' ') + '\\n');
const S = process.env.FAKE_STATE || '';
const T = process.env.FAKE_TABS || '';
const C = process.env.FAKE_COUNTERS || '';
const readState = () => { try { return fs.readFileSync(S, 'utf8').split('\\n').filter((l) => l !== ''); } catch { return []; } };
const writeState = (lines) => fs.writeFileSync(S, lines.length ? lines.join('\\n') + '\\n' : '');
const setPane = (pane, tab) => {
  const lines = readState();
  const at = lines.findIndex((l) => l.split('\\t')[0] === pane);
  const line = pane + '\\t' + tab;
  if (at >= 0) lines[at] = line; else lines.push(line);
  writeState(lines);
};
const dropPane = (pane) => writeState(readState().filter((l) => l.split('\\t')[0] !== pane));
const remap = (p) => { try { fs.accessSync(process.env.FAKE_REMAP); return 'm-' + p; } catch { return p; } };
const bump = (name) => {
  const f = C + '/' + name;
  let n = 0;
  try { n = parseInt(fs.readFileSync(f, 'utf8'), 10); } catch {}
  n += 1;
  fs.writeFileSync(f, String(n));
  return n;
};
const cmd = (argv[0] || '') + ' ' + (argv[1] || '');
if (cmd === 'pane list') {
  if (argv[2] === '--workspace') {
    const panes = readState().map((l) => { const [p, t] = l.split('\\t'); return { pane_id: p, tab_id: t, focused: false }; });
    process.stdout.write(JSON.stringify({ result: { panes } }) + '\\n');
  } else if (process.env.FAKE_FOCUSED) {
    process.stdout.write(JSON.stringify({ result: { panes: [{ pane_id: process.env.FAKE_FOCUSED, focused: true }] } }) + '\\n');
  } else {
    process.stdout.write('{"result":{"panes":[]}}\\n');
  }
} else if (cmd === 'agent get') {
  const t = argv[2] || '';
  let mode = '';
  if (process.env.FAKE_MODE_DIR) { try { mode = fs.readFileSync(process.env.FAKE_MODE_DIR + '/mode-' + t, 'utf8').trim(); } catch {} }
  if (!mode) { try { mode = fs.readFileSync(process.env.FAKE_MODE, 'utf8').trim(); } catch {} }
  if (!mode) mode = 'idle';
  if (mode === 'denied') {
    process.stderr.write('Error: Os { code: 13, kind: PermissionDenied, message: "Permission denied" }\\n');
    process.exit(1);
  }
  if (mode === 'missing') {
    process.stderr.write('{"error":{"code":"agent_not_found","message":"agent target ' + t + ' not found"}}\\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ result: { agent: { name: t, agent_status: mode } } }) + '\\n');
} else if (cmd === 'pane move') {
  const failAll = process.env.FAKE_MOVE_FAIL && fs.existsSync(process.env.FAKE_MOVE_FAIL);
  let failAfter = false;
  if (process.env.FAKE_MOVE_FAIL_AFTER !== undefined) {
    const f = C + '/moves';
    let n = 0;
    try { n = parseInt(fs.readFileSync(f, 'utf8'), 10); } catch {}
    n += 1;
    fs.writeFileSync(f, String(n));
    failAfter = n > Number(process.env.FAKE_MOVE_FAIL_AFTER);
  }
  if (failAll || failAfter) { process.stderr.write('move failed\\n'); process.exit(1); }
  let dest = '';
  let newtab = false;
  for (let i = 3; i < argv.length; i += 1) {
    if (argv[i] === '--tab') dest = argv[i + 1];
    else if (argv[i] === '--new-tab') { newtab = true; dest = 'park-' + bump('park'); fs.mkdirSync(T, { recursive: true }); fs.writeFileSync(T + '/' + dest, 'herd-park'); }
  }
  const np = remap(argv[2]);
  setPane(np, dest);
  process.stdout.write(JSON.stringify({ result: { move_result: { pane: { pane_id: np, tab_id: dest } } } }) + '\\n');
} else if (cmd === 'tab create') {
  let label = '';
  for (let i = 2; i < argv.length; i += 1) if (argv[i] === '--label') label = argv[i + 1];
  const tn = 't-new-' + bump('tnew');
  const rn = 'r-new-' + bump('troot');
  fs.mkdirSync(T, { recursive: true });
  fs.writeFileSync(T + '/' + tn, label);
  setPane(rn, tn);
  process.stdout.write(JSON.stringify({ result: { tab: { tab_id: tn, label }, root_pane: { pane_id: rn } } }) + '\\n');
} else if (cmd === 'tab get') {
  const f = T + '/' + argv[2];
  if (fs.existsSync(f)) {
    process.stdout.write(JSON.stringify({ result: { tab: { tab_id: argv[2], label: fs.readFileSync(f, 'utf8').trim() }, root_pane: { pane_id: 'r-' + argv[2] } } }) + '\\n');
  } else {
    process.stderr.write('{"error":"tab_not_found"}\\n');
    process.exit(1);
  }
} else if (cmd === 'tab rename') {
  const f = T + '/' + argv[2];
  if (fs.existsSync(f)) fs.writeFileSync(f, argv[3] || '');
  process.stdout.write('{"result":{}}\\n');
} else if (cmd === 'pane close') {
  dropPane(argv[2]);
  process.stdout.write('{"result":{}}\\n');
} else if (cmd === 'pane layout') {
  process.stdout.write('{"result":{"layout":{"panes":[{"pane_id":"q3","rect":{"x":0,"y":0,"width":100,"height":50}}]}}}\\n');
} else if (cmd === 'pane split') {
  const anchor = argv[2];
  const st = readState().find((l) => l.split('\\t')[0] === anchor);
  const np = 'p-split-' + bump('split');
  setPane(np, st ? st.split('\\t')[1] : '');
  process.stdout.write(JSON.stringify({ result: { pane: { pane_id: np } } }) + '\\n');
} else if (cmd === 'agent focus' || cmd === 'pane focus' || cmd === 'agent read'
  || cmd === 'agent start' || cmd === 'agent rename' || cmd === 'agent send-keys') {
  process.stdout.write('{"result":{}}\\n');
} else if (cmd === 'agent list') {
  process.stdout.write('{"result":{"agents":[]}}\\n');
} else {
  process.stderr.write('unexpected: ' + argv.join(' ') + '\\n');
  process.exit(1);
};
`;

// ---------- fixture plumbing ----------

const H12 = '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\tmodel\tapprovals\troles\tlane\n';
const ROW = (name, pane, role, tab, lane = '') =>
  `${name}\t${pane}\tgrok\t${role}\txai\t1\t/tmp/work\tnow\tgrok-4.7\task\t${role}\t${lane}`;

function makeFix(prefix) {
  let root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  root = fs.realpathSync(root);
  const bin = path.join(root, 'bin');
  const repo = path.join(root, 'repo');
  const state = path.join(root, 'state');
  const ws = path.join(state, 'ws');
  const tabs = path.join(root, 'tabs');
  const counters = path.join(root, 'counters');
  const modeDir = path.join(root, 'modes');
  for (const d of [bin, repo, ws, path.join(ws, 'briefs'), path.join(ws, 'reports'), path.join(ws, 'wait'),
    tabs, counters, modeDir, path.join(root, 'home'), path.join(root, 'conf'), path.join(root, 'tmp')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  spawnSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
  writeFakeCli(bin, 'herdr', HERDR_FAKE);
  const env = {
    HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'conf'),
    TMPDIR: path.join(root, 'tmp'),
    HERDR_AGENTS_DIR: state,
    HERDR_WORKSPACE_ID: 'ws',
    HERDR_ENV: '1',
    FAKE_STATE: path.join(root, 'panes.txt'),
    FAKE_TABS: tabs,
    FAKE_COUNTERS: counters,
    FAKE_MODE: path.join(root, 'mode'),
    FAKE_MODE_DIR: modeDir,
    FAKE_REMAP: path.join(root, 'remap'),
    FAKE_MOVE_FAIL: path.join(root, 'move-fail'),
    FAKE_LOG: path.join(root, 'herdr.log'),
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  };
  fs.writeFileSync(env.FAKE_MODE, 'idle\n');
  const fix = {
    root, repo, state, ws, env, ctx: loadConfig(env, repo),
    panes(pairs) { fs.writeFileSync(env.FAKE_STATE, pairs.map(([p, t]) => `${p}\t${t}`).join('\n') + '\n'); },
    live() {
      try {
        return fs.readFileSync(env.FAKE_STATE, 'utf8').trim().split('\n').filter((l) => l !== '')
          .map((l) => { const [p, t] = l.split('\t'); return { pane_id: p, tab_id: t }; });
      } catch { return []; }
    },
    tab(tab, label = 'herd') { fs.writeFileSync(path.join(tabs, tab), label); },
    writeRoster(...rows) {
      fs.writeFileSync(path.join(ws, 'agents.tsv'), H12 + rows.map((r) => `${r}\n`).join(''));
    },
    roster() { return fs.readFileSync(path.join(ws, 'agents.tsv'), 'utf8'); },
    modeOf(agent, m) { fs.writeFileSync(path.join(modeDir, `mode-${agent}`), `${m}\n`); },
    on(f, file) { fs.writeFileSync(file, '1\n'); },
    off(f, file) { fs.rmSync(file, { force: true }); },
    log() { try { return fs.readFileSync(env.FAKE_LOG, 'utf8').trim().split('\n').filter((l) => l !== ''); } catch { return []; } },
    clearLog() { fs.writeFileSync(env.FAKE_LOG, ''); },
    herdTab() { try { return fs.readFileSync(path.join(ws, 'herd-tab'), 'utf8'); } catch { return null; } },
    setHerdTab(content) { fs.writeFileSync(path.join(ws, 'herd-tab'), content); },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
  fix.writeRoster();
  return fix;
}

// Run cmdRegrid in-process, capturing stdout; returns { out, err, error }.
function runRegrid(fix, args, over = {}) {
  const env = { ...fix.env, ...over };
  const out = [];
  const err = [];
  const so = process.stdout.write;
  const se = process.stderr.write;
  let error = null;
  try {
    process.stdout.write = (s) => { out.push(s); return true; };
    process.stderr.write = (s) => { err.push(s); return true; };
    cmdRegrid(args, fix.ctx, env, fix.repo);
  } catch (e) {
    error = e;
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
  return { out: out.join(''), err: err.join(''), error };
}

function entry(fix, args, over = {}) {
  return spawnSync(nodeBin(), [JS_ENTRY, ...args], {
    cwd: fix.repo,
    env: { ...fix.env, ...over },
    encoding: 'utf8',
    timeout: 60_000,
  });
}

// ---------- buildGrid (test-layout.sh grid shapes) ----------

// The exact move sequence per cell count, pane ids preserved (no remap):
// column heads first (right, 1/remaining columns), then the rows of each
// column (down, 1/remaining rows).
const SEQUENCE = {
  2: ['c1 right c0 0.5000'],
  3: ['c1 right c0 0.5000', 'c2 down c1 0.5000'],
  4: ['c2 right c0 0.5000', 'c1 down c0 0.5000', 'c3 down c2 0.5000'],
  5: ['c1 right c0 0.3333', 'c3 right c1 0.5000', 'c2 down c1 0.5000', 'c4 down c3 0.5000'],
  6: ['c2 right c0 0.3333', 'c4 right c2 0.5000', 'c1 down c0 0.5000', 'c3 down c2 0.5000', 'c5 down c4 0.5000'],
  7: ['c2 right c0 0.3333', 'c4 right c2 0.5000', 'c1 down c0 0.5000', 'c3 down c2 0.5000', 'c5 down c4 0.3333', 'c6 down c5 0.5000'],
};

test('buildGrid: the exact pane-move sequence for 2 to 7 cells', { timeout: 30000 }, () => {
  for (let n = 2; n <= 7; n += 1) {
    const fix = makeFix(`ha-regrid-grid-${n}-`);
    try {
      fix.clearLog();
      const cells = Array.from({ length: n }, (_, i) => `c${i}`);
      const r = buildGrid('t0', cells, fix.env);
      assert.equal(r.ok, true, `n=${n}`);
      assert.deepEqual(r.changes, [], `n=${n}: ids preserved`);
      const moves = fix.log().filter((l) => l.startsWith('pane move '));
      const want = SEQUENCE[n].map((s) => {
        const [pane, dir, target, ratio] = s.split(' ');
        return `pane move ${pane} --tab t0 --split ${dir} --target-pane ${target} --ratio ${ratio} --no-focus`;
      });
      assert.deepEqual(moves, want, `n=${n}: ${JSON.stringify(moves)}`);
    } finally { fix.cleanup(); }
  }
});

test('buildGrid: one cell is a no-op, a failed move stops the grid', { timeout: 30000 }, () => {
  let fix = makeFix('ha-regrid-grid-1-');
  try {
    fix.clearLog();
    const r = buildGrid('t0', ['c0'], fix.env);
    assert.equal(r.ok, true);
    assert.deepEqual(fix.log(), [], 'no move for a single cell');
  } finally { fix.cleanup(); }
  fix = makeFix('ha-regrid-grid-fail-');
  try {
    fix.clearLog();
    fix.on(fix, fix.env.FAKE_MOVE_FAIL);
    const r = buildGrid('t0', ['c0', 'c1', 'c2'], fix.env);
    assert.equal(r.ok, false);
    assert.equal(fix.log().filter((l) => l.startsWith('pane move ')).length, 1, 'stops at the failed move');
  } finally { fix.cleanup(); }
});

test('applyGrid: the roster follows the new pane ids, and nothing changes otherwise', { timeout: 30000 }, () => {
  const fix = makeFix('ha-regrid-apply-');
  try {
    fix.writeRoster(
      ROW('w1', 'c1', 'implementer', 't0'),
      ROW('w2', 'c2', 'scouter', 't0'),
      ROW('w3', 'c3', 'inspector', 't0'),
    );
    fix.on(fix, fix.env.FAKE_REMAP);
    const before = fix.roster();
    const r = applyGrid(fix.ctx, 't0', ['c0', 'c1', 'c2', 'c3'], fix.env, fix.repo);
    assert.equal(r.ok, true);
    const after = fix.roster();
    assert.notEqual(after, before, 'the roster changed');
    assert.ok(after.includes('w1\tm-c1\t'), `w1: ${after}`);
    assert.ok(after.includes('w2\tm-c2\t'), `w2: ${after}`);
    assert.ok(after.includes('w3\tm-c3\t'), `w3: ${after}`);
    // The caller pane is not a roster row: untouched.
    assert.ok(!after.includes('m-c0'), 'the caller pane is not rewritten');
    // No remap: ids preserved → the roster bytes are untouched.
    const fix2 = makeFix('ha-regrid-apply-same-');
    try {
      fix2.writeRoster(ROW('w1', 'c1', 'implementer', 't0'), ROW('w2', 'c2', 'scouter', 't0'));
      const before2 = fix2.roster();
      const r2 = applyGrid(fix2.ctx, 't0', ['c0', 'c1', 'c2'], fix2.env, fix2.repo);
      assert.equal(r2.ok, true);
      assert.equal(fix2.roster(), before2, 'ids preserved → the roster is byte-identical');
    } finally { fix2.cleanup(); }
  } finally { fix.cleanup(); }
});

// ---------- parkPanes ----------

test('parkPanes: herd-park tab, the rest split down off the first', { timeout: 30000 }, () => {
  const fix = makeFix('ha-regrid-park-');
  try {
    fix.clearLog();
    const r = parkPanes(['w1', 'w2', 'w3'], fix.env);
    assert.deepEqual(r, { ok: true, tab: 'park-1' });
    assert.deepEqual(fix.log(), [
      'pane move w1 --new-tab --label herd-park --no-focus',
      'pane move w2 --tab park-1 --split down --target-pane w1 --ratio 0.5 --no-focus',
      'pane move w3 --tab park-1 --split down --target-pane w1 --ratio 0.5 --no-focus',
    ]);
    assert.equal(fix.herdTab(), null, 'parking does not touch the herd-tab file');
  } finally { fix.cleanup(); }
});

test('parkPanes: a failed move or an empty list fails closed', { timeout: 30000 }, () => {
  let fix = makeFix('ha-regrid-park-fail-');
  try {
    fix.clearLog();
    fix.on(fix, fix.env.FAKE_MOVE_FAIL);
    assert.deepEqual(parkPanes(['w1', 'w2'], fix.env), { ok: false, tab: '' }, 'the first move fails');
    assert.equal(parkPanes([], fix.env).ok, false, 'no panes');
    fix.off(fix, fix.env.FAKE_MOVE_FAIL);
    // The first move succeeds (park created), the second fails: the park
    // id is still reported (bash captures it before the loop runs).
    const r = parkPanes(['w1', 'w2'], { ...fix.env, FAKE_MOVE_FAIL_AFTER: '1' });
    assert.deepEqual(r, { ok: false, tab: 'park-1' });
    assert.equal(r.ok, false);
  } finally { fix.cleanup(); }
});

// ---------- cmdRegrid ----------

test('cmdRegrid: layout=split pulls workers back up to the cap, parks and grids, forgets the emptied tab', { timeout: 30000 }, () => {
  const fix = makeFix('ha-regrid-cmd-split-');
  try {
    fix.clearLog();
    fix.writeRoster(
      ROW('w1', 'p1', 'implementer', 't0'),
      ROW('w2', 'p2', 'scouter', 't1'),
      ROW('w3', 'p3', 'inspector', 't1'),
    );
    fix.panes([['C', 't0'], ['p1', 't0'], ['p2', 't1'], ['p3', 't1']]);
    fix.tab('t1', 'herd');
    fix.setHerdTab('t1\therd\tauto\n');
    const r = runRegrid(fix, ['regrid'], {
      HERDR_TAB_ID: 't0',
      HERDR_PANE_ID: 'C',
      HERDR_AGENTS_SPLIT_MAX_PANES: '4',
    });
    assert.equal(r.error, null, r.err);
    assert.equal(r.out, '{"regridded":[{"tab":"t0","label":"caller","panes":4,"cols":2}]}\n');
    assert.equal(fix.herdTab(), '', 'the emptied tab is forgotten (file truncated)');
    assert.deepEqual(fix.log(), [
      'pane list',
      'pane list --workspace ws',
      'agent get w1',
      'tab get t1',
      'agent get w2',
      'agent get w3',
      'pane move p2 --tab t0 --split right --target-pane C --ratio 0.5 --no-focus',
      'pane move p3 --tab t0 --split right --target-pane C --ratio 0.5 --no-focus',
      'pane list --workspace ws',
      'pane move p1 --new-tab --label herd-park --no-focus',
      'pane move p2 --tab park-1 --split down --target-pane p1 --ratio 0.5 --no-focus',
      'pane move p3 --tab park-1 --split down --target-pane p1 --ratio 0.5 --no-focus',
      'pane move p2 --tab t0 --split right --target-pane C --ratio 0.5000 --no-focus',
      'pane move p1 --tab t0 --split down --target-pane C --ratio 0.5000 --no-focus',
      'pane move p3 --tab t0 --split down --target-pane p2 --ratio 0.5000 --no-focus',
      'tab get t1',
      'pane list --workspace ws',
      'pane list',
    ], fix.log().join('\n'));
  } finally { fix.cleanup(); }
});

test('cmdRegrid: the cap stops the pull-back (caller + workers stays within split_max_panes)', { timeout: 30000 }, () => {
  const fix = makeFix('ha-regrid-cmd-cap-');
  try {
    fix.clearLog();
    fix.writeRoster(
      ROW('w1', 'p1', 'implementer', 't0'),
      ROW('w2', 'p2', 'implementer', 't0'),
      ROW('w3', 'p3', 'implementer', 't1'),
    );
    fix.panes([['C', 't0'], ['p1', 't0'], ['p2', 't0'], ['p3', 't1']]);
    fix.tab('t1', 'herd');
    fix.setHerdTab('t1\therd\tauto\n');
    // Cap 3: caller + the two workers already fill it → nothing is pulled
    // back; the herd tab keeps its single worker.
    const r = runRegrid(fix, ['regrid'], {
      HERDR_TAB_ID: 't0',
      HERDR_PANE_ID: 'C',
      HERDR_AGENTS_SPLIT_MAX_PANES: '3',
    });
    assert.equal(r.error, null, r.err);
    assert.equal(r.out, '{"regridded":[{"tab":"t0","label":"caller","panes":3,"cols":2}]}\n');
    assert.equal(fix.herdTab(), 't1\timpl\tauto\n', 'the single-pane herd tab stays (relabeled)');
    const moves = fix.log().filter((l) => l.startsWith('pane move '));
    assert.ok(moves.every((m) => !m.includes('--split right --target-pane C --ratio 0.5 --no-focus')), `no pull-back at the cap: ${moves}`);
    assert.deepEqual(moves, [
      'pane move p1 --new-tab --label herd-park --no-focus',
      'pane move p2 --tab park-1 --split down --target-pane p1 --ratio 0.5 --no-focus',
      'pane move p1 --tab t0 --split right --target-pane C --ratio 0.5000 --no-focus',
      'pane move p2 --tab t0 --split down --target-pane p1 --ratio 0.5000 --no-focus',
    ], moves.join('\n'));
  } finally { fix.cleanup(); }
});

test('cmdRegrid: layout=tab keeps a single-pane herd tab, rebuilds a 3-pane one, forgets an empty one', { timeout: 30000 }, () => {
  const fix = makeFix('ha-regrid-cmd-herd-');
  try {
    fix.clearLog();
    fix.writeRoster(
      ROW('s1', 'q1', 'implementer', 't1'),
      ROW('b1', 'q2', 'implementer', 't2'),
      ROW('b2', 'q3', 'implementer', 't2'),
      ROW('b3', 'q4', 'implementer', 't2'),
      ROW('g1', 'q5', 'implementer', 't3'),
    );
    fix.panes([['q1', 't1'], ['q2', 't2'], ['q3', 't2'], ['q4', 't2']]); // q5 is dead
    fix.tab('t1', 'solo');
    fix.tab('t2', 'herd');
    fix.tab('t3', 'herd');
    fix.setHerdTab('t1\tsolo\tauto\nt2\t-\tauto\nt3\therd\tauto\n');
    const r = runRegrid(fix, ['regrid'], { HERDR_AGENTS_LAYOUT: 'tab' });
    assert.equal(r.error, null, r.err);
    assert.equal(r.out, '{"regridded":[{"tab":"t-new-1","label":"herd","panes":3,"cols":2}]}\n');
    assert.equal(fix.herdTab(), 't1\timpl\tauto\nt-new-1\timpl 2\tauto\n');
    assert.deepEqual(fix.log(), [
      'pane list',
      'pane list --workspace ws',
      'tab get t1',
      'tab get t2',
      'tab get t3',
      'agent get s1',
      'agent get b1',
      'agent get b2',
      'agent get b3',
      `tab create --workspace ws --cwd ${fix.repo} --label herd --no-focus`,
      'pane move q2 --tab t-new-1 --split right --target-pane r-new-1 --ratio 0.5 --no-focus',
      'pane close r-new-1',
      'pane move q3 --tab t-new-1 --split right --target-pane q2 --ratio 0.5000 --no-focus',
      'pane move q4 --tab t-new-1 --split down --target-pane q3 --ratio 0.5000 --no-focus',
      'pane list --workspace ws',
      'tab get t1',
      'tab get t-new-1',
      'tab get t1',
      'tab rename t1 impl',
      'tab get t-new-1',
      'tab rename t-new-1 impl 2',
      'pane list',
    ], fix.log().join('\n'));
  } finally { fix.cleanup(); }
});

test('cmdRegrid: a failed move throws DieError 4 with the bash message', { timeout: 30000 }, () => {
  let fix = makeFix('ha-regrid-cmd-fail-park-');
  try {
    fix.clearLog();
    fix.writeRoster(ROW('w1', 'p1', 'implementer', 't0'));
    fix.panes([['C', 't0'], ['p1', 't0']]);
    fix.on(fix, fix.env.FAKE_MOVE_FAIL);
    const r = runRegrid(fix, ['regrid'], { HERDR_TAB_ID: 't0', HERDR_PANE_ID: 'C' });
    assert.ok(r.error instanceof DieError, String(r.error));
    assert.equal(r.error.code, 4);
    assert.equal(r.error.message, 'regrid: could not park the workers of tab t0 in a temporary tab');
  } finally { fix.cleanup(); }
  // The park succeeds (move 1), the first grid move fails (move 2): the
  // park tab id is in the message, like the bash `$park` variable.
  fix = makeFix('ha-regrid-cmd-fail-grid-');
  try {
    fix.clearLog();
    fix.writeRoster(ROW('w1', 'p1', 'implementer', 't0'));
    fix.panes([['C', 't0'], ['p1', 't0']]);
    const r = runRegrid(fix, ['regrid'], {
      HERDR_TAB_ID: 't0',
      HERDR_PANE_ID: 'C',
      FAKE_MOVE_FAIL_AFTER: '1',
    });
    assert.ok(r.error instanceof DieError, String(r.error));
    assert.equal(r.error.code, 4);
    assert.equal(r.error.message, 'regrid: a move back into t0 failed; remaining workers are alive in tab park-1 (label herd-park)');
  } finally { fix.cleanup(); }
});

test('cmdRegrid: the entry exits 4 with the message and a friction entry', { timeout: 30000 }, () => {
  const fix = makeFix('ha-regrid-entry-fail-');
  try {
    fix.writeRoster(ROW('w1', 'p1', 'implementer', 't0'));
    fix.panes([['C', 't0'], ['p1', 't0']]);
    fix.on(fix, fix.env.FAKE_MOVE_FAIL);
    const r = entry(fix, ['regrid'], { HERDR_TAB_ID: 't0', HERDR_PANE_ID: 'C' });
    assert.equal(r.status, 4, r.stderr);
    assert.match(r.stderr, /regrid: could not park the workers of tab t0 in a temporary tab/);
    const friction = fs.readFileSync(path.join(fix.ws, 'friction.log'), 'utf8');
    assert.ok(friction.includes('\terror(exit 4)\tregrid\tregrid: could not park the workers of tab t0 in a temporary tab\n'), friction);
  } finally { fix.cleanup(); }
});

test('cmdRegrid: the test-status.sh kept-panes case (unqueryable kept, gone dropped)', { timeout: 30000 }, () => {
  const fix = makeFix('ha-regrid-cmd-kept-');
  try {
    fix.clearLog();
    fix.writeRoster(
      ROW('stuck', 'p2', 'implementer', 't0'),
      ROW('dead', 'p3', 'implementer', 't0'),
    );
    fix.panes([['C', 't0'], ['p2', 't0'], ['p3', 't0']]);
    fix.modeOf('stuck', 'denied');
    fix.modeOf('dead', 'missing');
    const r = runRegrid(fix, ['regrid'], { HERDR_TAB_ID: 't0', HERDR_PANE_ID: 'C' });
    assert.equal(r.error, null, r.err);
    // The denied worker's pane is kept in the grid, the gone one is not.
    assert.equal(r.out, '{"regridded":[{"tab":"t0","label":"caller","panes":2,"cols":2}]}\n');
    const moves = fix.log().filter((l) => l.startsWith('pane move '));
    assert.ok(moves.some((m) => m.startsWith('pane move p2 ')), `p2 moved: ${moves}`);
    assert.ok(moves.every((m) => !m.startsWith('pane move p3 ')), `p3 not moved: ${moves}`);
  } finally { fix.cleanup(); }
});

// ---------- the automatic regrid (spawn / release --close) ----------

// A fixture with one herd tab holding two workers: the automatic regrid
// rebuilds it, so the regrid is visible in the log and its failure is
// visible as the bash warning. The grok fake keeps the spawn quiet.
function seedHerdTab(fix) {
  fix.clearLog();
  fix.writeRoster(
    ROW('b1', 'q2', 'scouter', 't1'),
    ROW('b2', 'q3', 'scouter', 't1'),
  );
  fix.panes([['q2', 't1'], ['q3', 't1']]);
  fix.tab('t1', 'herd');
  fix.setHerdTab('t1\therd\tauto\n');
}

test('spawn: the automatic regrid rebuilds the herd tab silently', { timeout: 60000 }, () => {
  const fix = makeFix('ha-regrid-auto-spawn-');
  try {
    writeFakeCli(fix.env.PATH.split(path.delimiter)[0], 'grok', 'process.exit(0);\n');
    seedHerdTab(fix);
    const r = entry(fix, ['spawn', 'implementer'], { HERDR_AGENTS_LAYOUT: 'tab' });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.name, 'build');
    assert.equal(j.placement, 'herd');
    assert.equal(j.pane_id, 'p-split-1');
    // The regrid ran: the herd tab with 3 workers was rebuilt in a fresh
    // tab (labeled as the already-relabeled source tab), and none of its
    // output leaked into the spawn output.
    const log = fix.log();
    assert.ok(log.includes('tab create --workspace ws --cwd ' + fix.repo + ' --label scout+impl --no-focus'), log.join('\n'));
    assert.ok(log.includes('pane move q2 --tab t-new-1 --split right --target-pane r-new-1 --ratio 0.5 --no-focus'), log.join('\n'));
    assert.ok(!/warning/.test(r.stderr), r.stderr);
    assert.ok(r.stdout.trim().endsWith('}'), 'only the spawn JSON on stdout');
  } finally { fix.cleanup(); }
});

test('spawn: a failed automatic regrid is the bash warning and keeps the spawn code', { timeout: 60000 }, () => {
  const fix = makeFix('ha-regrid-auto-spawn-fail-');
  try {
    writeFakeCli(fix.env.PATH.split(path.delimiter)[0], 'grok', 'process.exit(0);\n');
    seedHerdTab(fix);
    fix.on(fix, fix.env.FAKE_MOVE_FAIL);
    const r = entry(fix, ['spawn', 'implementer'], { HERDR_AGENTS_LAYOUT: 'tab' });
    assert.equal(r.status, 0, `the spawn succeeded: ${r.stderr}`);
    assert.match(r.stderr, /^herdr-agents: warning: regrid after spawn failed; panes left as inserted \(see friction\)\n$/);
    const friction = fs.readFileSync(path.join(fix.ws, 'friction.log'), 'utf8');
    assert.ok(friction.includes('\terror(exit 4)\tspawn\tregrid: move of q2 failed; remaining workers are alive in tab t1\n'), friction);
    assert.ok(friction.includes('\twarning\tspawn\tregrid after spawn failed; panes left as inserted (see friction)\n'), friction);
  } finally { fix.cleanup(); }
});

test('release --close: the automatic regrid rebuilds the herd tab silently', { timeout: 60000 }, () => {
  const fix = makeFix('ha-regrid-auto-release-');
  try {
    fix.writeRoster(
      ROW('a', 'pa', 'implementer', 't0'),
      ROW('b1', 'q2', 'scouter', 't1'),
      ROW('b2', 'q3', 'scouter', 't1'),
    );
    fix.panes([['pa', 't0'], ['q2', 't1'], ['q3', 't1']]);
    fix.tab('t1', 'herd');
    fix.setHerdTab('t1\therd\tauto\n');
    const rep = path.join(fix.ws, 'reports', 'a.md');
    fs.writeFileSync(rep, 'done\n');
    fs.writeFileSync(path.join(fix.ws, 'last-report-a'), rep + '\n');
    const r = entry(fix, ['release', 'a', '--close']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'closed pane pa\nreleased a\n');
    const log = fix.log();
    assert.ok(log.includes('pane close pa'), log.join('\n'));
    assert.ok(log.includes('tab create --workspace ws --cwd ' + fix.repo + ' --label herd --no-focus'), log.join('\n'));
    assert.ok(log.includes('pane move q2 --tab t-new-1 --split right --target-pane r-new-1 --ratio 0.5 --no-focus'), log.join('\n'));
    assert.ok(!/warning/.test(r.stderr), r.stderr);
  } finally { fix.cleanup(); }
});

test('release --close: a failed automatic regrid is the bash warning and keeps the release code', { timeout: 60000 }, () => {
  const fix = makeFix('ha-regrid-auto-release-fail-');
  try {
    fix.writeRoster(
      ROW('a', 'pa', 'implementer', 't0'),
      ROW('b1', 'q2', 'scouter', 't1'),
      ROW('b2', 'q3', 'scouter', 't1'),
    );
    fix.panes([['pa', 't0'], ['q2', 't1'], ['q3', 't1']]);
    fix.tab('t1', 'herd');
    fix.setHerdTab('t1\therd\tauto\n');
    const rep = path.join(fix.ws, 'reports', 'a.md');
    fs.writeFileSync(rep, 'done\n');
    fs.writeFileSync(path.join(fix.ws, 'last-report-a'), rep + '\n');
    fix.on(fix, fix.env.FAKE_MOVE_FAIL);
    const r = entry(fix, ['release', 'a', '--close']);
    assert.equal(r.status, 0, `the release succeeded: ${r.stderr}`);
    assert.equal(r.stdout, 'closed pane pa\nreleased a\n');
    assert.match(r.stderr, /^herdr-agents: warning: regrid after release failed; panes left as they are \(see friction\)\n$/);
    const friction = fs.readFileSync(path.join(fix.ws, 'friction.log'), 'utf8');
    assert.ok(friction.includes('\terror(exit 4)\trelease\tregrid: move of q2 failed; remaining workers are alive in tab t1\n'), friction);
  } finally { fix.cleanup(); }
});

test('release without --close: the relabel branch is untouched by the regrid', { timeout: 60000 }, () => {
  const fix = makeFix('ha-regrid-auto-noclose-');
  try {
    fix.writeRoster(
      ROW('a', 'pa', 'implementer', 't0'),
      ROW('b1', 'q2', 'scouter', 't1'),
    );
    fix.panes([['pa', 't0'], ['q2', 't1']]);
    fix.tab('t1', 'herd');
    fix.setHerdTab('t1\therd\tauto\n');
    const rep = path.join(fix.ws, 'reports', 'a.md');
    fs.writeFileSync(rep, 'done\n');
    fs.writeFileSync(path.join(fix.ws, 'last-report-a'), rep + '\n');
    const r = entry(fix, ['release', 'a']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'released a\n');
    const log = fix.log();
    assert.ok(!log.some((l) => l.startsWith('pane move ')), 'no regrid without --close');
    assert.ok(log.some((l) => l.startsWith('pane report-metadata pa --source herdr-agents --clear-title')),
      'the title is cleared, as before');
  } finally { fix.cleanup(); }
});

test('movePane: output jq rejects is a failed move, like bash move_pane', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-regrid-move-out-'));
  try {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    writeFakeCli(bin, 'herdr', "process.stdout.write(process.env.FAKE_MOVE_OUT ?? '');\n");
    const mv = (out) => movePane('p1', 't1', 'right', 'p0', '0.5000',
      { ...process.env, PATH: bin + path.delimiter + process.env.PATH, FAKE_MOVE_OUT: out });
    // Each expectation matches `jq -r '.result.move_result.pane.pane_id //
    // .result.pane.pane_id // empty'` (jq 1.8): rc 0 passes, rc 5 fails.
    const ok = (pane) => ({ ok: true, pane });
    const failed = { ok: false, pane: '' };
    assert.deepEqual(mv('{"result":{"move_result":{"pane":{"pane_id":"p9"}}}}'), ok('p9'));
    assert.deepEqual(mv('{"result":{"pane":{"pane_id":"p2"}}}'), ok('p2'), 'the second path');
    assert.deepEqual(mv('{"result":{}}'), ok(''), 'no id: success, pane unchanged');
    assert.deepEqual(mv(''), ok(''), 'empty output');
    assert.deepEqual(mv('  \n'), ok(''), 'blank output');
    assert.deepEqual(mv('null'), ok(''), 'null');
    assert.deepEqual(mv('not json'), failed, 'invalid JSON');
    assert.deepEqual(mv('{"result":'), failed, 'truncated JSON');
    assert.deepEqual(mv('[]'), failed, 'an array cannot be indexed');
    assert.deepEqual(mv('5'), failed, 'a number cannot be indexed');
    assert.deepEqual(mv('"x"'), failed, 'a string cannot be indexed');
    assert.deepEqual(mv('true'), failed, 'a boolean cannot be indexed');
    assert.deepEqual(mv('{"result":"x"}'), failed, 'result is a string');
    // `jq -r` (no -c) prints a non-string id as JSON indented by two spaces.
    assert.deepEqual(mv('{"result":{"pane":{"pane_id":7}}}'), ok('7'), 'a number');
    assert.deepEqual(mv('{"result":{"pane":{"pane_id":{"a": 1}}}}'), ok('{\n  "a": 1\n}'), 'an object');
    assert.deepEqual(mv('{"result":{"pane":{"pane_id":["a", "b"]}}}'), ok('[\n  "a",\n  "b"\n]'), 'an array');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
