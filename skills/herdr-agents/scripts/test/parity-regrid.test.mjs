// Parity (slice 8a): `regrid`, output by output and call by call. The same
// fixture (a state-tracking sh fake `herdr`, temporary HOME / XDG_CONFIG_HOME
// / HERDR_AGENTS_DIR / TMPDIR, HERDR_WORKSPACE_ID=ws) runs against
// `bash scripts/herdr-agents.sh` and `node scripts/herdr-agents.mjs` and is
// compared on rc, stdout, normalized stderr and, after the run, the fake's
// call log (every `herdr` argv line, byte for byte), the pane-state file,
// the tab-label files and the `herd-tab` file:
//   - pull: layout=split pulls a worker back to the caller's tab while it
//     fits, parks and rebuilds the grid, and forgets emptied herd tabs;
//   - herd: layout=tab keeps a single-pane herd tab, rebuilds a 3-pane one
//     in a fresh tab with the same label, and forgets a tab whose worker is
//     gone;
//   - kept: an unqueryable worker's pane is kept in the grid (a failed
//     query is not absence), a gone worker's pane is dropped
//     (test-status.sh :295-330);
//   - fail: a failed move exits 4 with the bash message and the same
//     friction entry (timestamps normalized).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixtureEnv, nodeBin, normalizeErr } from './parity.mjs';

const SCRIPTS = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const BASH_ENTRY = path.join(SCRIPTS, 'herdr-agents.sh');
const JS_ENTRY = path.join(SCRIPTS, 'herdr-agents.mjs');

// State-tracking sh fake herdr. The pane→tab table lives in $HA_STATE as
// `pane<TAB>tab` lines (the seed file is $HA_SEED). Tab labels are files in
// $HA_TABS. `pane move` rewrites the table (`--new-tab` creates park-N,
// labelled herd-park, and reports the tab id in
// `move_result.pane.tab_id`, as the real herdr does); `tab create`
// creates t-new-N with root pane r-new-N; `agent get` answers per
// $HA_AGENTS/<name> (denied/gone) or idle. Every call is appended to
// $HA_LOG. HA_MOVE_FAIL (a file) makes every `pane move` fail.
const TAB_FAKE = `#!/bin/sh
printf '%s\\n' "$*" >> "$HA_LOG"
case "$1 $2" in
  "tab get")
    t="$3"
    if [ -f "$HA_TABS/$t" ]; then
      printf '{"result":{"tab":{"tab_id":"%s","label":"%s"}}}\\n' "$t" "$(cat "$HA_TABS/$t")"
    else
      printf '{"error":{"code":"tab_not_found"}}\\n'
      exit 1
    fi ;;
  "tab rename")
    shift 2; t="$1"; shift; printf '%s' "$*" > "$HA_TABS/$t"; printf '{"result":{}}\\n' ;;
  "tab create")
    label=""
    while [ $# -gt 0 ]; do
      case "$1" in --label) label="$2"; shift 2 ;; *) shift ;; esac
    done
    n="$(cat "$HA_COUNTERS/tnew" 2>/dev/null || echo 0)"; n=$((n+1)); printf '%s' "$n" > "$HA_COUNTERS/tnew"
    t="t-new-$n"; r="r-new-$n"
    mkdir -p "$HA_TABS"; printf '%s' "$label" > "$HA_TABS/$t"
    printf '%s\\t%s\\n' "$r" "$t" >> "$HA_STATE"
    printf '{"result":{"tab":{"tab_id":"%s","label":"%s"},"root_pane":{"pane_id":"%s"}}}\\n' "$t" "$label" "$r" ;;
  "pane list")
    out=""
    while IFS="$(printf '\\t')" read -r p t; do
      [ -n "$p" ] || continue
      [ -n "$out" ] && out="$out,"
      out="$out{\\"pane_id\\":\\"$p\\",\\"tab_id\\":\\"$t\\"}"
    done < "$HA_STATE"
    printf '{"result":{"panes":[%s]}}\\n' "$out" ;;
  "pane move")
    if [ -n "$HA_MOVE_FAIL" ] && [ -f "$HA_MOVE_FAIL" ]; then
      printf '{"error":{"code":"permission_denied"}}\\n'; exit 1
    fi
    shift 2; pane="$1"; shift; dest=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --new-tab) dest="__new"; shift ;;
        --tab) dest="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    if [ "$dest" = "__new" ]; then
      n="$(cat "$HA_COUNTERS/park" 2>/dev/null || echo 0)"; n=$((n+1)); printf '%s' "$n" > "$HA_COUNTERS/park"
      dest="park-$n"
      mkdir -p "$HA_TABS"; printf 'herd-park\\n' > "$HA_TABS/$dest"
      printf '{"result":{"move_result":{"pane":{"pane_id":"%s","tab_id":"%s"}}}}\\n' "$pane" "$dest"
    else
      printf '{"result":{"move_result":{"pane":{"pane_id":"%s"}}}}\\n' "$pane"
    fi
    awk -F '\\t' -v p="$pane" -v d="$dest" 'BEGIN{OFS="\\t"} $1==p{$2=d} {print}' "$HA_STATE" > "$HA_STATE.tmp" && mv "$HA_STATE.tmp" "$HA_STATE" ;;
  "pane close")
    awk -F '\\t' -v p="$3" '$1!=p' "$HA_STATE" > "$HA_STATE.tmp" && mv "$HA_STATE.tmp" "$HA_STATE"
    printf '{"result":{}}\\n' ;;
  "agent get")
    t="$3"; m=""
    [ -f "$HA_AGENTS/$t" ] && m="$(cat "$HA_AGENTS/$t")"
    case "$m" in
      gone)   printf '{"error":{"code":"agent_not_found"}}\\n'; exit 1 ;;
      denied) printf '{"error":{"code":"permission_denied"}}\\n'; exit 1 ;;
      *)      printf '{"result":{"agent":{"name":"%s","agent_status":"idle"}}}\\n' "$t" ;;
    esac ;;
  "agent list")
    printf '{"result":{"agents":[]}}\\n' ;;
  *)
    printf '{"error":{"code":"unexpected","message":"unexpected: %s"}}\\n' "$*"; exit 1 ;;
esac
`;

function makeFix(prefix, name, seed) {
  let root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  root = fs.realpathSync(root);
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const conf = path.join(root, 'conf');
  const state = path.join(root, 'state');
  const tmp = path.join(root, 'tmp');
  for (const d of [repo, home, conf, state, tmp]) fs.mkdirSync(d, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
  const env = fixtureEnv({
    HOME: home,
    XDG_CONFIG_HOME: conf,
    HERDR_AGENTS_DIR: state,
    HERDR_WORKSPACE_ID: 'ws',
    TMPDIR: tmp,
  });
  const bin = path.join(root, 'fakebin');
  const tabs = path.join(root, 'tabs');
  const agents = path.join(root, 'agents');
  const counters = path.join(root, 'counters');
  const setup = () => {
    fs.rmSync(bin, { recursive: true, force: true });
    fs.rmSync(tabs, { recursive: true, force: true });
    fs.rmSync(agents, { recursive: true, force: true });
    fs.rmSync(counters, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
    fs.rmSync(path.join(root, 'herdr.log'), { force: true });
    fs.rmSync(path.join(root, 'panes'), { force: true });
    fs.rmSync(path.join(root, 'move-fail'), { force: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(tabs, { recursive: true });
    fs.mkdirSync(agents, { recursive: true });
    fs.mkdirSync(counters, { recursive: true });
    fs.mkdirSync(path.join(state, 'ws'), { recursive: true });
    fs.writeFileSync(path.join(bin, 'herdr'), TAB_FAKE, { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'panes'), seed.panes);
    for (const [id, label] of Object.entries(seed.tabs ?? {})) fs.writeFileSync(path.join(tabs, id), label + '\n');
    for (const [name, mode] of Object.entries(seed.agentModes ?? {})) fs.writeFileSync(path.join(agents, name), mode);
    if (seed.moveFail) fs.writeFileSync(path.join(root, 'move-fail'), '1\n');
    if (seed.herdTab !== undefined) fs.writeFileSync(path.join(state, 'ws', 'herd-tab'), seed.herdTab);
    fs.writeFileSync(path.join(state, 'ws', 'agents.tsv'), seed.roster);
  };
  const stepEnv = (over) => ({
    ...env,
    HERDR_ENV: '1',
    HA_TABS: tabs,
    HA_STATE: path.join(root, 'panes'),
    HA_AGENTS: agents,
    HA_COUNTERS: counters,
    HA_LOG: path.join(root, 'herdr.log'),
    HA_MOVE_FAIL: seed.moveFail ? path.join(root, 'move-fail') : '',
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    ...over,
  });
  const read = (rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; } };
  const walk = (dir, prefix = '') => {
    const out = {};
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      const rel = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.isDirectory()) Object.assign(out, walk(path.join(dir, e.name), rel));
      else out[rel] = read(rel);
    }
    return out;
  };
  return {
    root, repo, setup, stepEnv, read, walk,
    files() {
      const out = {
        'herdr.log': read('herdr.log'),
        'state/ws/herd-tab': read('state/ws/herd-tab'),
        'state/ws/agents.tsv': read('state/ws/agents.tsv'),
        'panes': read('panes'),
      };
      const fr = read('state/ws/friction.log');
      if (fr !== null) {
        out['state/ws/friction.log'] = fr.split('\n').map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'TS')).join('\n');
      }
      Object.assign(out, walk(tabs));
      return out;
    },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

const ROW = (name, pane, role, tab) => `${name}\t${pane}\tgrok\t${role}\txai\t1\t/tmp\t\n`;

function runScenario(name, seed, envOver, args) {
  const fix = makeFix(`ha-parity-regrid-${name}-`, name, seed);
  let bashRes, bashFiles, nodeRes, nodeFiles;
  try {
    for (const impl of ['bash', 'node']) {
      fix.setup();
      const r = spawnSync(
        impl === 'bash' ? 'bash' : nodeBin(),
        [impl === 'bash' ? BASH_ENTRY : JS_ENTRY, ...args],
        { cwd: fix.repo, env: fix.stepEnv(envOver), encoding: 'utf8', timeout: 20000 },
      );
      const files = fix.files();
      if (impl === 'bash') { bashRes = r; bashFiles = files; } else { nodeRes = r; nodeFiles = files; }
    }
  } finally { fix.cleanup(); }
  const where = `${name} (${args.join(' ')})`;
  assert.equal(nodeRes.status, bashRes.status, `${where}: exit code (bash=${bashRes.status} node=${nodeRes.status})\nnode stderr:\n${nodeRes.stderr}\nbash stderr:\n${bashRes.stderr}`);
  assert.equal(nodeRes.stdout, bashRes.stdout, `${where}: stdout (node first)\nnode:\n${nodeRes.stdout}\nbash:\n${bashRes.stdout}`);
  assert.equal(normalizeErr(nodeRes.stderr), normalizeErr(bashRes.stderr), `${where}: stderr normalized (node first)\nnode:\n${nodeRes.stderr}\nbash:\n${bashRes.stderr}`);
  for (const [rel, b] of Object.entries(bashFiles)) {
    assert.equal(nodeFiles[rel], b, `${where}: file ${rel} after the run (node first)\nnode:\n${nodeFiles[rel]}\nbash:\n${b}`);
  }
  assert.deepEqual(Object.keys(nodeFiles).sort(), Object.keys(bashFiles).sort(), `${where}: the set of changed files`);
}

test('parity: regrid pulls a worker back to the caller tab, parks, grids, forgets emptied tabs', { timeout: 120000 }, () => {
  runScenario('pull', {
    roster: [
      '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted',
      ROW('w1', 'p1', 'implementer', 't0'),
      ROW('w2', 'p2', 'scouter', 't1'),
    ].join('\n') + '\n',
    panes: 'C\tt0\np1\tt0\np2\tt1\n',
    tabs: { t1: 'herd', t2: 'herd' },
    herdTab: 't1\therd\tauto\nt2\therd\tauto\n',
  }, { HERDR_TAB_ID: 't0', HERDR_PANE_ID: 'C', HERDR_AGENTS_SPLIT_MAX_PANES: '4' }, ['regrid']);
});

test('parity: regrid with layout=tab keeps, rebuilds and forgets the herd tabs', { timeout: 120000 }, () => {
  runScenario('herd', {
    roster: [
      '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted',
      ROW('s1', 'q1', 'implementer', 't1'),
      ROW('b1', 'q2', 'implementer', 't2'),
      ROW('b2', 'q3', 'implementer', 't2'),
      ROW('b3', 'q4', 'implementer', 't2'),
      ROW('g1', 'q5', 'implementer', 't3'),
    ].join('\n') + '\n',
    panes: 'q1\tt1\nq2\tt2\nq3\tt2\nq4\tt2\n', // q5 is gone
    tabs: { t1: 'solo', t2: 'herd', t3: 'herd' },
    herdTab: 't1\tsolo\tauto\nt2\t-\tauto\nt3\therd\tauto\n',
  }, { HERDR_AGENTS_LAYOUT: 'tab' }, ['regrid']);
});

test('parity: regrid keeps an unqueryable worker pane and drops a gone one', { timeout: 120000 }, () => {
  runScenario('kept', {
    roster: [
      '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted',
      ROW('stuck', 'p2', 'implementer', 't0'),
      ROW('dead', 'p3', 'implementer', 't0'),
    ].join('\n') + '\n',
    panes: 'C\tt0\np2\tt0\np3\tt0\n',
    agentModes: { stuck: 'denied', dead: 'gone' },
    herdTab: '',
  }, { HERDR_TAB_ID: 't0', HERDR_PANE_ID: 'C' }, ['regrid']);
});

test('parity: regrid exits 4 on a failed move, with the bash message and friction entry', { timeout: 120000 }, () => {
  runScenario('fail', {
    roster: [
      '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted',
      ROW('w1', 'p1', 'implementer', 't0'),
    ].join('\n') + '\n',
    panes: 'C\tt0\np1\tt0\n',
    moveFail: true,
    herdTab: '',
  }, { HERDR_TAB_ID: 't0', HERDR_PANE_ID: 'C' }, ['regrid']);
});
