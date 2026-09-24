// Golden (slice 9a-A): the `herdr-agents spawn` scenarios run only the
// JS (`node scripts/herdr-agents.mjs`) and compare against the value
// stored once in test/golden/parity-spawn.json (test/golden.mjs:
// HERDR_AGENTS_GOLDEN unset checks the JS value against the stored value, =update
// overwrites the stored value with the JS value for review).
//
// Mirrors test-lanes.sh:165-420 (spawn scenarios, incl. the config-layer
// cases) plus the extra criteria (agent_pane_busy x2, agent_not_ready,
// --pane, overflow to a herd tab on a full caller tab). Each scenario runs
// in a fresh fixture (fake `herdr` CLI + fake agent CLIs) and the stored
// value holds, per step: exit code, stdout, normalized stderr and the
// stored herdr CLI calls (omitted for the busy2 scenario, as before);
// plus the final roster (created_at normalized to T) and `herd-tab` file.
// The fixture root becomes <ROOT> in every string of the stored value.
//
// node --test test/parity-spawn.test.mjs

import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { JS_ENTRY, fixtureEnv, nodeBin, normalizeErr } from './parity.mjs';
import { golden, normalizeRoots } from './golden.mjs';

// The fixture contract is POSIX (the sh fake CLIs), so the scenarios are
// skipped on Windows.
const SKIP =
  process.platform === 'win32'
    ? 'Windows: the sh fake CLIs need a POSIX host'
    : false;

const SUITE = 'parity-spawn';

const HEADER =
  '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\tmodel\tapprovals\troles\tlane\n';

// The fake herdr speaks the exact shapes the skill consumes. State comes
// from env-pointed files so scenario steps can mutate it between commands.
const FAKE_HERDR = `#!/bin/sh
printf '%s\\n' "$*" >> "$HA_LOG"
target="\${3:-}"
mode=$(cat "$HA_MODE" 2>/dev/null || echo idle)
case "$1 $2" in
  "--version"*) echo 'herdr 1.0.0' ;;
  "status server"*) echo 'server 1.0.0' ;;
  "agent get")
    case "$target" in
      gone|dead) echo '{"error":{"code":"agent_not_found","message":"gone"}}' >&2; exit 1 ;;
    esac
    case "$mode" in
      working) echo "{\"result\":{\"agent\":{\"name\":\"$target\",\"agent_status\":\"working\"}}}" ;;
      blocked) echo "{\"result\":{\"agent\":{\"name\":\"$target\",\"agent_status\":\"blocked\"}}}" ;;
      gone) echo '{"error":{"code":"agent_not_found","message":"gone"}}' >&2; exit 1 ;;
      *) echo "{\"result\":{\"agent\":{\"name\":\"$target\",\"agent_status\":\"idle\"}}}" ;;
    esac ;;
  "agent list")
    if [ -f "$HA_LIVE" ]; then cat "$HA_LIVE"; else echo '{"result":{"agents":[]}}'; fi ;;
  "agent start")
    case "$mode" in
      busy2)
        n=$(cat "$HA_STARTN" 2>/dev/null || echo 0)
        n=$((n + 1)); echo "$n" > "$HA_STARTN"
        if [ "$n" -le 2 ]; then
          echo '{"error":{"code":"agent_pane_busy","message":"shell not ready"}}' >&2
          exit 1
        fi ;;
      notready) echo 'agent_not_ready: login prompt' >&2; exit 1 ;;
    esac
    echo '{"result":{"started":true}}' ;;
  "agent read") cat "$HA_SCREEN" ;;
  "pane list")
    if [ -f "$HA_PANES" ]; then cat "$HA_PANES"; else echo '{"result":{"panes":[]}}'; fi ;;
  "pane layout")
    if [ -f "$HA_LAYOUT" ]; then cat "$HA_LAYOUT"; else echo '{"error":"no layout"}' >&2; exit 1; fi ;;
  "tab create") echo '{"result":{"tab":{"tab_id":"t-herd","label":"herd"},"root_pane":{"pane_id":"p-new"}}}' ;;
  "tab get") echo '{"result":{"tab":{"tab_id":"t-herd","label":"herd"},"root_pane":{"pane_id":"p-root"}}}' ;;
  "tab rename") echo '{"result":{}}' ;;
  "agent rename") echo '{"result":{}}' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;

// Roster row (test-lanes.sh:33-35, add_worker) — model always grok-4.7.
const ROW = (fix, name, role, lane, kind = 'grok') =>
  `${name}\tp-${name}\t${kind}\t${role}\txai\t1\t${fix.repo}\tgrok-4.7\tfull\t${role}\t${lane}\n`;

function makeParityFixture(name) {
  let root = fs.mkdtempSync(path.join(os.tmpdir(), `ha-parity-spawn-${name}-`));
  root = fs.realpathSync(root);
  const bin = path.join(root, 'bin');
  const repo = path.join(root, 'repo');
  const state = path.join(root, 'state');
  for (const d of [bin, repo, path.join(root, 'home'), path.join(root, 'config'), path.join(root, 'tmp'),
    path.join(state, 'ws', 'briefs'), path.join(state, 'ws', 'reports'), path.join(state, 'ws', 'wait')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Agent instructions\n');
  const ws = path.join(state, 'ws');
  const fix = {
    root, bin, repo, state, ws,
    herdrLog: path.join(root, 'herdr.log'),
    live: path.join(root, 'live.json'),
    mode: path.join(root, 'mode'),
    screen: path.join(root, 'screen'),
    panes: path.join(root, 'panes.json'),
    layout: path.join(root, 'layout.json'),
    startN: path.join(root, 'start-n'),
    conf: path.join(root, 'home', '.config', 'herdr-agents', 'config.toml'),
    files: {
      roster: path.join(ws, 'agents.tsv'),
      herdTab: path.join(ws, 'herd-tab'),
    },
    seed() {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.mkdirSync(path.join(ws, 'briefs'), { recursive: true });
      fs.mkdirSync(path.join(ws, 'reports'), { recursive: true });
      fs.mkdirSync(path.join(ws, 'wait'), { recursive: true });
      fs.writeFileSync(path.join(ws, 'agents.tsv'), HEADER);
      fs.writeFileSync(this.live, '{"result":{"agents":[]}}\n');
      fs.writeFileSync(this.mode, 'idle\n');
      fs.writeFileSync(this.screen, 'plain screen\n');
      fs.rmSync(this.panes, { force: true });
      fs.rmSync(this.layout, { force: true });
      fs.rmSync(this.startN, { force: true });
      fs.rmSync(this.herdrLog, { force: true });
      fs.rmSync(this.conf, { force: true });
      fs.rmSync(this.files.herdTab, { force: true });
      fs.rmSync(path.join(ws, 'friction.log'), { force: true });
    },
    env() {
      const base = fixtureEnv();
      delete base.NODE_OPTIONS;
      delete base.HERDR_TAB_ID;
      delete base.HERDR_AGENT_NAME;
      return {
        ...base,
        HOME: path.join(root, 'home'),
        XDG_CONFIG_HOME: path.join(root, 'config'),
        TMPDIR: path.join(root, 'tmp'),
        HERDR_AGENTS_DIR: state,
        HERDR_WORKSPACE_ID: 'ws',
        HA_LOG: this.herdrLog,
        HA_MODE: this.mode,
        HA_LIVE: this.live,
        HA_SCREEN: this.screen,
        HA_PANES: this.panes,
        HA_LAYOUT: this.layout,
        HA_STARTN: this.startN,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      };
    },
  };
  return fix;
}

// The roster's `started` column differs per run; normalize it to T before
// it is stored.
function normRosterCols(s) {
  if (s == null) return null;
  return s.split('\n').map((l) => {
    if (l === '' || l.startsWith('#')) return l;
    const f = l.split('\t');
    if (f.length > 7) f[7] = 'T'; // created_at differs per run
    return f.join('\t');
  }).join('\n');
}

// Run the step script against the JS entry in a fresh fixture and return
// the golden value: rc, stdout, normalized stderr and the herdr
// call log per step (omitted when opts.skipLog), plus the final roster and
// `herd-tab` file. `entry` is [bin, ...binArgs] (the JS entry). The fixture
// root becomes <ROOT> in every string of the value.
function spawnValue(entry, name, script, opts = {}) {
  const fix = makeParityFixture(name);
  try {
    fs.writeFileSync(path.join(fix.bin, 'herdr'), FAKE_HERDR, { mode: 0o755 });
    fs.writeFileSync(path.join(fix.bin, 'grok'), '#!/bin/sh\n[ "${1:-}" = models ] && printf "%s\\n" grok-4.7\n', { mode: 0o755 });
    fs.writeFileSync(path.join(fix.bin, 'agy'), '#!/bin/sh\n[ "${1:-}" = models ] && printf "gemini-2.5 (latest)\\n"\n', { mode: 0o755 });
    fix.seed();
    const baseEnv = fix.env();
    const steps = [];
    for (const step of script) {
      if (step.fs) { step.fs(fix); continue; }
      fs.rmSync(fix.herdrLog, { force: true });
      const r = spawnSync(entry[0], [...entry.slice(1), ...step.args], {
        cwd: fix.repo,
        env: { ...baseEnv, HERDR_ENV: '1', HERDR_AGENTS_LAYOUT: 'tab', HERDR_AGENTS_REGRID: 'off', ...step.env },
        encoding: 'utf8',
        timeout: 60000,
      });
      const st = {
        args: step.args,
        rc: r.status === null ? -1 : r.status,
        out: r.stdout ?? '',
        err: normalizeErr(r.stderr ?? ''),
      };
      if (!opts.skipLog) {
        st.log = fs.existsSync(fix.herdrLog) ? fs.readFileSync(fix.herdrLog, 'utf8') : '';
      }
      steps.push(st);
    }
    const files = {};
    for (const [label, file] of Object.entries(fix.files)) {
      const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      files[label] = label === 'roster' ? normRosterCols(raw) : raw;
    }
    return normalizeRoots({ steps, files }, { '<ROOT>': fix.root });
  } finally {
    fs.rmSync(fix.root, { recursive: true, force: true });
  }
}

// ---- scenario helpers ------------------------------------------------------

const addWorkers = (fix, ...rows) => {
  const lines = [HEADER];
  for (const [name, role, lane, kind] of rows) lines.push(ROW(fix, name, role, lane, kind));
  fs.writeFileSync(fix.files.roster, lines.join(''));
};
const resetRoster = (fix) => {
  fs.writeFileSync(fix.files.roster, HEADER);
  fs.writeFileSync(fix.live, '{"result":{"agents":[]}}\n');
  fs.writeFileSync(fix.mode, 'idle\n');
  fs.rmSync(fix.startN, { force: true });
  fs.rmSync(fix.files.herdTab, { force: true });
};
const live = (fix, agents) => fs.writeFileSync(fix.live, `${JSON.stringify({ result: { agents } })}\n`);
const mode = (fix, m) => fs.writeFileSync(fix.mode, `${m}\n`);
const conf = (fix, text) => {
  if (text == null) fs.rmSync(fix.conf, { force: true });
  else {
    fs.mkdirSync(path.dirname(fix.conf), { recursive: true });
    fs.writeFileSync(fix.conf, text);
  }
};
const rmHerdTab = (fix) => fs.rmSync(fix.files.herdTab, { force: true });

// ---- scenarios (test-lanes.sh:165-420 + brief extras) ----------------------

test('parity spawn: planner is 12, a sub-orchestrator outside a lane is 3', { timeout: 120000, skip: SKIP }, () => {
  const script = [
    { fs: resetRoster },
    { args: ['spawn', 'planner'] },
    { fs: resetRoster },
    { args: ['spawn', 'sub-orchestrator'] },
  ];
  let value;
  const actual = () => (value !== undefined ? value : (value = spawnValue([nodeBin(), JS_ENTRY], 'errors', script))); // check/update
  golden(SUITE, 'errors', actual);
});

test('parity spawn: fresh worker, lane reuse, kind mismatch, lane-kind reuse', { timeout: 120000, skip: SKIP }, () => {
  const script = [
    { fs: resetRoster },
    { args: ['spawn', 'implementer'] },
    { fs: (f) => { addWorkers(f, ['explore', 'scouter', 'explore']); live(f, [{ name: 'explore', pane_id: 'p-explore', agent_status: 'idle' }]); mode(f, 'idle'); rmHerdTab(f); } },
    { args: ['spawn', 'researcher'] },
    { fs: resetRoster },
    { args: ['spawn', 'designer'] },
    { fs: (f) => { live(f, [{ name: 'build', pane_id: 'p-build', agent_status: 'idle' }]); mode(f, 'idle'); } },
    { args: ['spawn', 'implementer'] },
    { fs: (f) => {
      conf(f, 'lane.build.kind = "grok"\n');
      addWorkers(f, ['build', 'designer', 'build', 'agy']);
      live(f, [{ name: 'build', pane_id: 'p-build', agent_status: 'idle' }]);
      mode(f, 'idle');
    } },
    { args: ['spawn', 'implementer'] },
    { fs: (f) => { addWorkers(f, ['build', 'designer', 'build', 'grok']); } },
    { args: ['spawn', 'implementer'] },
    { fs: (f) => { conf(f, null); } },
  ];
  let value;
  const actual = () => (value !== undefined ? value : (value = spawnValue([nodeBin(), JS_ENTRY], 'kind', script))); // check/update
  golden(SUITE, 'kind', actual);
});

test('parity spawn: busy 10, gone recreated, worker cap 8, locked 5, lane kind, lanes=off reuse', { timeout: 120000, skip: SKIP }, () => {
  const script = [
    { fs: (f) => { addWorkers(f, ['build', 'implementer', 'build']); live(f, [{ name: 'build', pane_id: 'p-build', agent_status: 'working' }]); mode(f, 'working'); } },
    { args: ['spawn', 'tasker'] },
    { fs: (f) => { addWorkers(f, ['build', 'implementer', 'build']); live(f, []); mode(f, 'gone'); } },
    { args: ['spawn', 'implementer'] },
    { fs: (f) => {
      addWorkers(f, ['explore', 'scouter', 'explore'], ['review', 'reviewer', 'review', 'codex'], ['extra', 'researcher', 'extra']);
      live(f, [
        { name: 'explore', pane_id: 'p-explore' },
        { name: 'review', pane_id: 'p-review' },
        { name: 'extra', pane_id: 'p-extra' },
      ]);
    } },
    { args: ['spawn', 'implementer'] },
    { fs: (f) => {
      conf(f, 'lane.mix.roles = "implementer,reviewer"\n');
      addWorkers(f, ['mix', 'implementer', 'mix']);
      live(f, [{ name: 'mix', pane_id: 'p-mix', agent_status: 'idle' }]);
      mode(f, 'idle');
    } },
    { args: ['spawn', 'reviewer'] },
    { fs: (f) => {
      conf(f, 'lane.build.kind = "codex"\n');
      resetRoster(f);
    } },
    { args: ['spawn', 'implementer'] },
    { fs: (f) => {
      conf(f, null);
      fs.writeFileSync(f.files.roster, `${HEADER}implementer\tp-impl\tgrok\timplementer\txai\t1\t${f.repo}\tnow\n`);
      live(f, [{ name: 'implementer', pane_id: 'p-impl', agent_status: 'idle' }]);
      mode(f, 'idle');
    } },
    { args: ['spawn', 'implementer'], env: { HERDR_AGENTS_LANES: 'off' } },
  ];
  let value;
  const actual = () => (value !== undefined ? value : (value = spawnValue([nodeBin(), JS_ENTRY], 'lane-states', script))); // check/update
  golden(SUITE, 'lane-states', actual);
});

// The config-layer cases of test-lanes.sh:324-399 (case 5 needs the unported
// `doctor` command and is skipped here; it is covered by the JS unit tests).
test('parity spawn: config layers (user vs project vs env, kind/model/effort precedence)', { timeout: 120000, skip: SKIP }, () => {
  const script = [
    // case 1: user lane.kind + model, project lane.kind wins; project kind model wins.
    { fs: (f) => {
      conf(f, 'lane.explore.kind = "grok"\nlane.explore.model = "grok-4.7"\nlane.explore.model.codex.worker = "gpt-6-luna"\n');
      fs.mkdirSync(path.join(f.repo, '.agents'), { recursive: true });
      fs.writeFileSync(path.join(f.repo, '.agents', 'herdr-agents.conf'), 'lane.explore.kind = "codex"\n');
      resetRoster(f);
    } },
    { args: ['spawn', 'scouter'] },
    { fs: (f) => { conf(f, null); fs.rmSync(path.join(f.repo, '.agents', 'herdr-agents.conf'), { force: true }); resetRoster(f); } },
    // case 2: project-only layer applies.
    { fs: (f) => {
      fs.writeFileSync(path.join(f.repo, '.agents', 'herdr-agents.conf'), 'lane.explore.kind = "codex"\nlane.explore.model = "grok-4.7"\nlane.explore.model.codex.worker = "gpt-6-luna"\n');
    } },
    { args: ['spawn', 'scouter'] },
    { fs: (f) => { fs.rmSync(path.join(f.repo, '.agents', 'herdr-agents.conf'), { force: true }); resetRoster(f); } },
    // case 3: env layer beats project; project kind model for the env kind wins.
    { fs: (f) => {
      conf(f, 'lane.build.model = "gpt-6-luna"\nlane.build.model.pi.worker = "my-provider/my-model"\n');
      fs.writeFileSync(path.join(f.repo, '.agents', 'herdr-agents.conf'), 'lane.build.kind = "pi"\n');
    } },
    { args: ['spawn', 'implementer'], env: { HERDR_AGENTS_LANE_BUILD_KIND: 'pi' } },
    { fs: (f) => { conf(f, null); fs.rmSync(path.join(f.repo, '.agents', 'herdr-agents.conf'), { force: true }); resetRoster(f); } },
    // case 4: user kind + effort, project kind wins with its effort.
    { fs: (f) => {
      conf(f, 'lane.build.kind = "codex"\nlane.build.effort = "high"\n');
      fs.writeFileSync(path.join(f.repo, '.agents', 'herdr-agents.conf'), 'lane.build.kind = "pi"\nlane.build.effort.pi = "max"\n');
    } },
    { args: ['spawn', 'implementer'] },
    { fs: (f) => { conf(f, null); fs.rmSync(path.join(f.repo, '.agents', 'herdr-agents.conf'), { force: true }); resetRoster(f); } },
    // case 6: explicit --kind with the layer effort (fresh, then same-flag reuse).
    { fs: (f) => {
      conf(f, 'lane.build.effort = "high"\n');
      fs.writeFileSync(path.join(f.repo, '.agents', 'herdr-agents.conf'), 'lane.build.effort.pi = "max"\nlane.build.model.pi.worker = "my-provider/my-model"\n');
    } },
    { args: ['spawn', 'implementer', '--kind', 'pi'] },
    { fs: (f) => { live(f, [{ name: 'build', pane_id: 'p-build', agent_status: 'idle' }]); mode(f, 'idle'); } },
    { args: ['spawn', 'implementer', '--kind', 'pi'] },
    { fs: (f) => { conf(f, null); fs.rmSync(path.join(f.repo, '.agents', 'herdr-agents.conf'), { force: true }); resetRoster(f); } },
    // case 7: role kind from the project layer beats the user lane model.
    { fs: (f) => {
      conf(f, 'lane.build.model = "grok-4.7"\n');
      fs.writeFileSync(path.join(f.repo, '.agents', 'herdr-agents.conf'), 'role.implementer.kind = "codex"\nrole.implementer.model.codex.worker = "gpt-6-luna"\n');
    } },
    { args: ['spawn', 'implementer'] },
    { fs: (f) => { fs.rmSync(path.join(f.repo, '.agents', 'herdr-agents.conf'), { force: true }); resetRoster(f); } },
    // case 8: user lane model applies when nothing deeper decides the kind.
    { fs: (f) => { conf(f, 'lane.build.model = "grok-4.7"\n'); } },
    { args: ['spawn', 'implementer'] },
    { fs: (f) => { conf(f, null); } },
  ];
  let value;
  const actual = () => (value !== undefined ? value : (value = spawnValue([nodeBin(), JS_ENTRY], 'layers', script))); // check/update
  golden(SUITE, 'layers', actual);
});

test('parity spawn: agent_pane_busy twice, then success (15x1s retry budget)', { timeout: 120000, skip: SKIP }, () => {
  // The retry budget makes the call log timing-dependent: stored without
  // the log, as the parity comparison skipped it before.
  const script = [
    { fs: (f) => { resetRoster(f); mode(f, 'busy2'); } },
    { args: ['spawn', 'implementer'] },
    { fs: (f) => { mode(f, 'idle'); } },
  ];
  let value;
  const actual = () => (value !== undefined ? value : (value = spawnValue([nodeBin(), JS_ENTRY], 'busy2', script, { skipLog: true }))); // check/update
  golden(SUITE, 'busy2', actual);
});

test('parity spawn: agent_not_ready registers, prints JSON + screen, exits 7', { timeout: 120000, skip: SKIP }, () => {
  const script = [
    { fs: (f) => { resetRoster(f); mode(f, 'notready'); } },
    { args: ['spawn', 'implementer'] },
  ];
  let value;
  const actual = () => (value !== undefined ? value : (value = spawnValue([nodeBin(), JS_ENTRY], 'notready', script))); // check/update
  golden(SUITE, 'notready', actual);
});

test('parity spawn: --pane places the worker in a given pane', { timeout: 120000, skip: SKIP }, () => {
  const script = [
    { fs: resetRoster },
    { args: ['spawn', 'implementer', '--pane', 'p-x', '--name', 'solo'] },
    { args: ['spawn', 'scouter', '--pane', 'p-y', '--tab-label', 'extra', '--name', 'side'] },
  ];
  let value;
  const actual = () => (value !== undefined ? value : (value = spawnValue([nodeBin(), JS_ENTRY], 'given-pane', script))); // check/update
  golden(SUITE, 'given-pane', actual);
});

// The caller's split tab is full → the worker overflows into a herd tab.
test('parity spawn: a full caller tab overflows the worker into a herd tab', { timeout: 120000, skip: SKIP }, () => {
  const layoutDoc = {
    result: {
      layout: {
        area: { x: 0, y: 0, width: 107, height: 57 },
        panes: [
          { pane_id: 'c', tab_id: 't-main', focused: false, rect: { x: 0, y: 0, width: 53, height: 57 } },
          { pane_id: 'p-w1', tab_id: 't-main', focused: false, rect: { x: 53, y: 0, width: 54, height: 57 } },
          { pane_id: 'p-w2', tab_id: 't-main', focused: false, rect: { x: 0, y: 28, width: 53, height: 29 } },
          { pane_id: 'p-w3', tab_id: 't-main', focused: false, rect: { x: 53, y: 28, width: 54, height: 29 } },
        ],
      },
    },
  };
  const panesWs = {
    result: {
      panes: [
        { pane_id: 'c', tab_id: 't-main' },
        { pane_id: 'p-w1', tab_id: 't-main' },
        { pane_id: 'p-w2', tab_id: 't-main' },
        { pane_id: 'p-w3', tab_id: 't-main' },
      ],
    },
  };
  const script = [
    { fs: (f) => {
      addWorkers(f, ['w1', 'implementer', 'build'], ['w2', 'scouter', 'explore'], ['w3', 'reviewer', 'review']);
      live(f, [
        { name: 'w1', pane_id: 'w1', agent_status: 'idle' },
        { name: 'w2', pane_id: 'w2', agent_status: 'idle' },
        { name: 'w3', pane_id: 'w3', agent_status: 'idle' },
      ]);
      mode(f, 'idle');
      fs.writeFileSync(f.layout, `${JSON.stringify(layoutDoc)}\n`);
      fs.writeFileSync(f.panes, `${JSON.stringify(panesWs)}\n`);
    } },
    {
      args: ['spawn', 'designer'],
      env: {
        HERDR_PANE_ID: 'c',
        HERDR_TAB_ID: 't-main',
        HERDR_AGENTS_LANES: 'off',
        HERDR_AGENTS_LAYOUT: 'split',
        HERDR_AGENTS_SPLIT_MAX_PANES: '3',
        HERDR_AGENTS_MAX_WORKERS: '4',
      },
    },
  ];
  let value;
  const actual = () => (value !== undefined ? value : (value = spawnValue([nodeBin(), JS_ENTRY], 'overflow', script))); // check/update
  golden(SUITE, 'overflow', actual);
});
