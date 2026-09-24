// Parity (slice 5a): `layout-plan --layout` and `tab-label`, output by
// output — the same fixture (fake `herdr` via an sh launcher, temporary
// HOME / XDG_CONFIG_HOME / HERDR_AGENTS_DIR / TMPDIR, HERDR_WORKSPACE_ID=ws)
// runs against `bash scripts/herdr-agents.sh` and `node
// scripts/herdr-agents.mjs`:
//   - `layout-plan --layout` over six fixtures (vazio, só o chamador,
//     cheio, mínimo, empate, 3×2), byte-for-byte stdout;
//   - `tab-label` (list, rename, --auto, error with a tab it does not
//     track, error with no herd tab at all): stdout, normalized stderr,
//     exit code and the final `herd-tab` file (and the fake's tab-label
//     files) after the run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixtureEnv, nodeBin, normalizeErr, parityScenario } from './parity.mjs';

const SCRIPTS = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const BASH_ENTRY = path.join(SCRIPTS, 'herdr-agents.sh');
const JS_ENTRY = path.join(SCRIPTS, 'herdr-agents.mjs');

// ---------- layout-plan fixtures ----------

function seedLayoutFixtures(fix) {
  const w = 213;
  const h = 57;
  const P = (id, x, y, wd, ht) => ({ pane_id: id, focused: false, rect: { x, y, width: wd, height: ht } });
  const doc = (panes) => JSON.stringify({ result: { layout: { area: { x: 0, y: 0, width: w, height: h }, panes } } });
  fs.writeFileSync(path.join(fix.root, 'fx-vazio.json'), doc([]));
  fs.writeFileSync(path.join(fix.root, 'fx-caller.json'), doc([P('C', 0, 0, 213, 57)]));
  fs.writeFileSync(path.join(fix.root, 'fx-cheio.json'), doc([
    P('C', 0, 0, 71, 29), P('F', 0, 29, 71, 28), P('A', 71, 0, 71, 29),
    P('B', 71, 29, 71, 28), P('D', 142, 0, 71, 29), P('E', 142, 29, 71, 28),
  ]));
  fs.writeFileSync(path.join(fix.root, 'fx-min.json'), doc([
    P('C', 0, 0, 71, 19), P('A', 0, 19, 71, 19), P('B', 0, 38, 71, 19),
    P('D', 71, 0, 71, 19), P('E', 71, 19, 71, 19), P('F', 71, 38, 71, 19),
    P('G', 142, 0, 71, 19), P('H', 142, 19, 71, 19), P('I', 142, 38, 71, 19),
  ]));
  fs.writeFileSync(path.join(fix.root, 'fx-empate.json'), doc([P('C', 0, 0, 107, 57), P('A', 107, 0, 106, 57)]));
  fs.writeFileSync(path.join(fix.root, 'fx-3x2.json'), doc([
    P('C', 0, 0, 71, 57), P('A', 71, 0, 71, 29), P('B', 71, 29, 71, 28),
    P('D', 142, 0, 71, 29), P('E', 142, 29, 71, 28),
  ]));
}

// Twelve bash/node runs: past bun's 5 s default test timeout.
test('parity: layout-plan --layout (six fixtures, byte for byte)', { timeout: 120000 }, () => {
  parityScenario(null, 'layout-plan', {
    seed: seedLayoutFixtures,
    steps: [
      // vazio: no panes at all → the caller pane stands in, split right
      { args: ['layout-plan', '--layout', '../fx-vazio.json', '--me', 'C', '--mine', 'A B D'] },
      // só o chamador: the full tab is as wide as it is tall → right
      { args: ['layout-plan', '--layout', '../fx-caller.json', '--me', 'C', '--mine', ''] },
      // cheio: default cap (4) reached → overflow full
      { args: ['layout-plan', '--layout', '../fx-cheio.json', '--me', 'C', '--mine', 'A B D E F'] },
      // mínimo: 3x3 (0.333 x 0.333), cap 12 → no pane can be halved (min)
      { args: ['layout-plan', '--layout', '../fx-min.json', '--me', 'C', '--mine', 'A B D E F G H I'], env: { HERDR_AGENTS_SPLIT_MAX_PANES: '12' } },
      // empate: 107/106 columns tie on area → the worker, split down
      { args: ['layout-plan', '--layout', '../fx-empate.json', '--me', 'C', '--mine', 'A'] },
      // 3×2 with the cap raised to 6 → split the caller, grid 3x2
      { args: ['layout-plan', '--layout', '../fx-3x2.json', '--me', 'C', '--mine', 'A B D E'], env: { HERDR_AGENTS_SPLIT_MAX_PANES: '6' } },
    ],
    files: [],
  });
});

// ---------- tab-label ----------

// sh fake herdr (parity runs the bash script too, so the fake stays a sh
// launcher): tab labels live in files under $HA_TABS; `pane list` reads
// $HA_PANES; every call is logged to $HA_LOG.
const TAB_FAKE = `#!/bin/sh
printf '%s\\n' "$*" >> "$HA_LOG"
T="$HA_TABS"
P="$HA_PANES"
case "$1 $2" in
  "tab get")
    if [ -f "$T/$3" ]; then
      printf '{"result":{"tab":{"tab_id":"%s","label":"%s"}}}\\n' "$3" "$(cat "$T/$3")"
    else
      printf '{"error":"tab_not_found"}\\n'
      exit 1
    fi ;;
  "tab rename")
    shift 2; id="$1"; shift; printf '%s' "$*" > "$T/$id"; printf '{"result":{}}\\n' ;;
  "pane list") cat "$P" ;;
  *) printf '{"error":"unexpected: %s"}\\n' "$*" >&2; exit 1 ;;
esac
`;

// One fixture per scenario; `seed()` resets it so the bash and node runs
// start from the same state.
function makeTabFixture(prefix, name) {
  let root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  root = fs.realpathSync(root);
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const conf = path.join(root, 'conf');
  const state = path.join(root, 'state');
  const tmp = path.join(root, 'tmp');
  for (const d of [repo, home, conf, state, tmp]) fs.mkdirSync(d, { recursive: true });
  const env = fixtureEnv({
    HOME: home,
    XDG_CONFIG_HOME: conf,
    HERDR_AGENTS_DIR: state,
    HERDR_WORKSPACE_ID: 'ws',
    TMPDIR: tmp,
  });
  const bin = path.join(root, 'fakebin');
  const tabs = path.join(root, 'tabs');
  const seed = () => {
    fs.rmSync(bin, { recursive: true, force: true });
    fs.rmSync(tabs, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
    fs.rmSync(path.join(root, 'herdr.log'), { force: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(tabs, { recursive: true });
    fs.mkdirSync(path.join(state, 'ws'), { recursive: true });
    fs.writeFileSync(path.join(bin, 'herdr'), TAB_FAKE, { mode: 0o755 });
    if (name !== 'no-tab') {
      fs.writeFileSync(path.join(tabs, 't1'), 'onda\n');
      fs.writeFileSync(path.join(tabs, 't2'), 'herd\n');
      fs.writeFileSync(path.join(tabs, 't3'), '');
      fs.writeFileSync(path.join(state, 'ws', 'herd-tab'), 't1\nt2\nt3\n');
      const rows = [
        '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted',
        'a1\tw1\tclaude\tscouter\tanthropic\t1\t/tmp\tnow',
        'a2\tw2\tclaude\treviewer\tanthropic\t1\t/tmp\tnow',
        'a3\tw3\tclaude\tdesigner\tanthropic\t1\t/tmp\tnow',
      ];
      fs.writeFileSync(path.join(state, 'ws', 'agents.tsv'), rows.join('\n') + '\n');
      fs.writeFileSync(path.join(root, 'panes.json'),
        JSON.stringify({ result: { panes: [
          { pane_id: 'w1', tab_id: 't1' }, { pane_id: 'w2', tab_id: 't1' }, { pane_id: 'w3', tab_id: 't2' },
        ] } }));
    }
  };
  const stepEnv = {
    ...env,
    HERDR_ENV: '1',
    HERDR_TAB_ID: 'caller',
    HA_TABS: tabs,
    HA_LOG: path.join(root, 'herdr.log'),
    HA_PANES: path.join(root, 'panes.json'),
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
  };
  return {
    root, repo, seed, stepEnv,
    read(rel) { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; } },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

function runTabScenario(t, name, steps, files) {
  void t;
  const fix = makeTabFixture(`ha-par-tabs-${name}-`, name);
  try {
    const runs = [];
    for (const impl of ['bash', 'node']) {
      fix.seed();
      const rs = [];
      for (const step of steps) {
        const [binx, ...binArgs] = impl === 'bash' ? ['bash', BASH_ENTRY] : [nodeBin(), JS_ENTRY];
        const r = spawnSync(binx, [...binArgs, ...step.args], { cwd: fix.repo, env: fix.stepEnv, encoding: 'utf8' });
        rs.push({ rc: r.status === null ? -1 : r.status, out: r.stdout ?? '', err: r.stderr ?? '' });
      }
      runs.push({ rs, files: files.map((rel) => ({ rel, content: fix.read(rel) })) });
    }
    const [bashR, nodeR] = runs;
    for (let i = 0; i < bashR.rs.length; i += 1) {
      const where = `${name}: step ${i + 1} (${steps[i].args.join(' ')})`;
      assert.equal(nodeR.rs[i].rc, bashR.rs[i].rc, `${where}: exit code (bash=${bashR.rs[i].rc} node=${nodeR.rs[i].rc})`);
      assert.equal(nodeR.rs[i].out, bashR.rs[i].out, `${where}: stdout (node output first)\nnode:\n${nodeR.rs[i].out}\nbash:\n${bashR.rs[i].out}`);
      assert.equal(normalizeErr(nodeR.rs[i].err), normalizeErr(bashR.rs[i].err), `${where}: stderr normalized\nnode:\n${nodeR.rs[i].err}\nbash:\n${bashR.rs[i].err}`);
    }
    for (let i = 0; i < files.length; i += 1) {
      assert.equal(nodeR.files[i].content, bashR.files[i].content,
        `${name}: file ${files[i]} after the run (node content first)\nnode:\n${nodeR.files[i].content}\nbash:\n${bashR.files[i].content}`);
    }
  } finally { fix.cleanup(); }
}

test('parity: tab-label (list, rename, --auto, unknown tab)', { timeout: 180000 }, (t) => {
  runTabScenario(t, 'full', [
    { args: ['tab-label'] },
    { args: ['tab-label', 'nova', 'aba'] },
    { args: ['tab-label', '--tab', 't3', '--auto'] },
    { args: ['tab-label', '--tab', 'nope', 'x'] },
  ], ['state/ws/herd-tab', 'tabs/t1', 'tabs/t2', 'tabs/t3']);
});

test('parity: tab-label with no herd tab at all', { timeout: 120000 }, (t) => {
  runTabScenario(t, 'no-tab', [
    { args: ['tab-label'] },
    { args: ['tab-label', 'x'] },
  ], ['state/ws/herd-tab']);
});
