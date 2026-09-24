// Herd tabs (slice 5a): every case of test-tab-labels.sh — role
// abbreviations, the `herd_label` template, truncation and " 2" suffixes,
// the 3-column state file (with the migration of the old one-column
// list), manual > auto precedence, renames done in Herdr by hand,
// `spawn --tab-label` routing (herdTabPane) and the `tab-label` command —
// plus a multibyte label right at the herd_label_max limit. The stateful
// sections run against a file-backed fake `herdr` (writeFakeCli) in PATH;
// the `tab-label` command runs in a child process (stdout, exit code,
// stderr). Every test builds its own temp
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
  roleAbbrev, herdLabelMax, composeHerdLabel, herdAutoLabel, herdTabEntries,
  herdTabsRelabel, herdTabPane, cmdTabLabel,
} from '../lib/herdtabs.mjs';

const SCRIPTS = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const JS = {
  config: path.join(SCRIPTS, 'lib', 'config.mjs'),
  herdtabs: path.join(SCRIPTS, 'lib', 'herdtabs.mjs'),
};

// --- abbreviations (pure) ----------------------------------------------------

test('role abbreviations', () => {
  assert.equal(roleAbbrev('implementer'), 'impl');
  assert.equal(roleAbbrev('security-reviewer'), 'sec');
  assert.equal(roleAbbrev('sub-orchestrator'), 'sub');
  assert.equal(roleAbbrev('solid-ui'), 'solid-ui'); // project role keeps its file name
});

// --- template (pure) ----------------------------------------------------------

test('composeHerdLabel: {roles}, {n}, {i}, {orch}', () => {
  assert.equal(composeHerdLabel('{roles}', 'implementer reviewer implementer', 1), 'impl+rev');
  assert.equal(composeHerdLabel('{roles}', 'scouter', 1), 'scout');
  assert.equal(composeHerdLabel('{roles}', '', 1), '');
  assert.equal(composeHerdLabel('{roles} ({n})', 'implementer reviewer implementer', 1), 'impl+rev (3)');
  assert.equal(composeHerdLabel('{roles} {i}', 'implementer', 1), 'impl');
  assert.equal(composeHerdLabel('{roles} {i}', 'implementer', 3), 'impl 3');
  assert.equal(composeHerdLabel('{orch}: {roles}', 'designer solid-ui', 1, 'orchestrator-2'), 'orchestrator-2: des+solid-ui');
});

// --- truncation and suffixes (pure) -------------------------------------------

test('herdAutoLabel: cut to 16, strip dangling separators, " 2"/" 3" suffixes', () => {
  const root = tmp('ha-tabs-label-');
  try {
    const env = isoEnv(root);
    const c = loadConfig(env, path.join(root, 'repo'));
    assert.equal(herdAutoLabel('impl+rev', [], c, env), 'impl+rev');
    assert.equal(herdAutoLabel('impl+rev+insp+des+scout', [], c, env), 'impl+rev+insp+de');
    assert.equal(herdAutoLabel('impl+rev+insp+de+scout', [], c, env), 'impl+rev+insp+de');
    assert.equal(herdAutoLabel('impl+rev', ['impl+rev'], c, env), 'impl+rev 2');
    assert.equal(herdAutoLabel('impl+rev', ['impl+rev', 'impl+rev 2'], c, env), 'impl+rev 3');
    assert.equal(herdAutoLabel('impl+rev+insp+des+scout', ['impl+rev+insp+de'], c, env), 'impl+rev+insp 2');
    assert.equal(herdAutoLabel('', [], c, env), 'herd');
    assert.equal(herdAutoLabel('impl+rev', [], c, { ...env, HERDR_AGENTS_HERD_LABEL_MAX: '6' }), 'impl+r');
    assert.equal(herdLabelMax(c, { ...env, HERDR_AGENTS_HERD_LABEL_MAX: 'abc' }), 16, 'bad value → 16');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- fixture plumbing ----------------------------------------------------------

function tmp(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return fs.realpathSync(root);
}

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

// Fake herdr (the bash suite's fixture as a Node script): tab labels live
// in files under $HA_TABS; `pane list` reads $HA_PANES; `tab create` names
// the tab tN (N = file count + 1, suffixed x when taken); every call is
// logged to $HA_LOG.
function tabFakeSource() {
  return `
import fs from 'node:fs';
import path from 'node:path';
const argv = process.argv.slice(2);
const T = process.env.HA_TABS;
const LOG = process.env.HA_LOG;
fs.appendFileSync(LOG, argv.join(' ') + '\\n');
const out = (s) => process.stdout.write(s + '\\n');
const cmd = (argv[0] ?? '') + ' ' + (argv[1] ?? '');
switch (cmd) {
  case 'tab get': {
    const t = argv[2] ?? '';
    const f = path.join(T, t);
    if (!fs.existsSync(f)) { out('{"error":"tab_not_found"}'); process.exit(1); break; }
    const label = fs.readFileSync(f, 'utf8').replace(/\\n+$/, '');
    out(JSON.stringify({ result: { tab: { tab_id: t, label } } }));
    break;
  }
  case 'tab rename': {
    const id = argv[2] ?? '';
    fs.writeFileSync(path.join(T, id), argv.slice(3).join(' '));
    out('{"result":{}}');
    break;
  }
  case 'tab create': {
    const files = fs.existsSync(T) ? fs.readdirSync(T) : [];
    let n = 't' + (files.length + 1);
    while (fs.existsSync(path.join(T, n))) n += 'x';
    const li = argv.indexOf('--label');
    const l = li === -1 ? '' : (argv[li + 1] ?? '');
    fs.writeFileSync(path.join(T, n), l);
    out(JSON.stringify({ result: { tab: { tab_id: n }, root_pane: { pane_id: 'root-' + n } } }));
    break;
  }
  case 'pane list': out(fs.readFileSync(process.env.HA_PANES, 'utf8')); break;
  case 'pane layout': out(JSON.stringify({ result: { layout: { panes: [{ pane_id: 'x', rect: { x: 0, y: 0, width: 213, height: 28 } }] } } })); break;
  case 'pane split': out(JSON.stringify({ result: { pane: { pane_id: 'split-of-' + (argv[2] ?? '') } } })); break;
  case 'agent get': out(JSON.stringify({ result: { agent: { name: argv[2] ?? '' } } })); break;
  default:
    process.stderr.write(JSON.stringify({ error: 'unexpected: ' + argv.join(' ') }) + '\\n');
    process.exit(1);
}
`;
}

function makeFix(prefix) {
  const root = tmp(prefix);
  const bin = path.join(root, 'bin');
  const tabs = path.join(root, 'tabs');
  const cwd = path.join(root, 'repo');
  const ws = path.join(root, 'state', 'ws');
  const log = path.join(root, 'herdr.log');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(tabs, { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
  writeFakeCli(bin, 'herdr', tabFakeSource());
  const env = {
    ...isoEnv(root),
    HERDR_TAB_ID: 'caller',
    HERDR_PANE_ID: 'c',
    HA_TABS: tabs,
    HA_LOG: log,
    HA_PANES: path.join(root, 'panes.json'),
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
  };
  return {
    root, cwd, ws, tabs, log, env,
    ctx: loadConfig(env, cwd),
    setPanes(...specs) {
      const panes = specs.map((s) => {
        const [p, t] = s.split(' ');
        return { pane_id: p, tab_id: t };
      });
      fs.writeFileSync(env.HA_PANES, JSON.stringify({ result: { panes } }));
    },
    setRoster(...specs) {
      const rows = ['# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted'];
      for (const s of specs) {
        const [n, p, role] = s.split(' ');
        rows.push(`${n}\t${p}\tclaude\t${role}\tanthropic\t1\t/tmp\tnow`);
      }
      fs.writeFileSync(path.join(ws, 'agents.tsv'), rows.join('\n') + '\n');
    },
    // the herd-tab file content ('' when absent)
    stateFile() {
      const f = path.join(ws, 'herd-tab');
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    },
    // a tab's live label, like the bash $(cat file) (trailing newlines gone)
    tabLabel(id) {
      try { return fs.readFileSync(path.join(tabs, id), 'utf8').replace(/\n+$/, ''); } catch { return ''; }
    },
    logLines() {
      return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

// The `tab-label` command runs in a child process (it dies via dieFriction
// and writes to stdout like the real entry).
function runTabLabel(args, env, cwd) {
  const code = `
import { loadConfig } from ${JSON.stringify(JS.config)};
import { cmdTabLabel } from ${JSON.stringify(JS.herdtabs)};
cmdTabLabel(${JSON.stringify(args)}, loadConfig(process.env, process.cwd()), process.env, process.cwd());
`;
  return spawnSync(nodeBin(), ['--input-type=module', '-e', code], { env, cwd, encoding: 'utf8' });
}

// --- state file: migration of the old one-column list -------------------------

test('herd-tab file: one-column migration, dead tabs pruned, 3-column rewrite', () => {
  const fix = makeFix('ha-tabs-migrate-');
  try {
    fs.writeFileSync(path.join(fix.tabs, 't1'), 'herd\n');
    fs.writeFileSync(path.join(fix.tabs, 't2'), 'onda 2\n');
    fs.writeFileSync(path.join(fix.tabs, 't3'), '');
    fs.writeFileSync(path.join(fix.ws, 'herd-tab'), 't1\nt2\nt3\ngone\n');
    fix.setPanes();
    fix.setRoster();
    const entries = herdTabEntries(fix.ctx, fix.env, fix.cwd);
    assert.deepEqual(entries, [
      { tab: 't1', label: 'herd', mode: 'auto' },
      { tab: 't2', label: 'onda 2', mode: 'manual' },
      { tab: 't3', label: '-', mode: 'auto' },
    ]);
    assert.equal(fix.stateFile(), 't1\therd\tauto\nt2\t' + 'onda 2\tmanual\nt3\t-\tauto\n');
  } finally { fix.cleanup(); }
});

// bash `IFS=$'\t' read`: a run of tabs is one delimiter and leading or
// trailing tabs are dropped, so a line with an extra tab still reads as
// tab/label/mode (the review's `t4\tkeep\t\tauto`).
test('herd-tab file: repeated, leading and trailing tabs read like bash', () => {
  const fix = makeFix('ha-tabs-ifs-');
  try {
    for (const t of ['t1', 't2', 't3']) fs.writeFileSync(path.join(fix.tabs, t), 'keep\n');
    fs.writeFileSync(path.join(fix.ws, 'herd-tab'), 't1\tkeep\t\tauto\n\tt2\tkeep\tmanual\t\nt3\t\tkeep\n');
    fix.setPanes();
    fix.setRoster();
    const entries = herdTabEntries(fix.ctx, fix.env, fix.cwd);
    assert.deepEqual(entries, [
      { tab: 't1', label: 'keep', mode: 'auto' },
      { tab: 't2', label: 'keep', mode: 'manual' },
      // `t3\t\tkeep`: the empty label collapses, `keep` is read as the label
      // and the mode is empty → migrated like a one-column entry.
      { tab: 't3', label: 'keep', mode: 'manual' },
    ]);
    assert.equal(fix.stateFile(), 't1\tkeep\tauto\nt2\tkeep\tmanual\nt3\tkeep\tmanual\n');
  } finally { fix.cleanup(); }
});

// --- relabel -------------------------------------------------------------------

test('herdTabsRelabel: auto from roles, manual kept, repeats suffixed, empty → herd', () => {
  const fix = makeFix('ha-tabs-relabel-');
  try {
    fs.writeFileSync(path.join(fix.ws, 'herd-tab'), 't1\therd\tauto\nt2\t' + 'onda 2\tmanual\nt3\t-\tauto\n');
    fs.writeFileSync(path.join(fix.tabs, 't1'), 'herd');
    fs.writeFileSync(path.join(fix.tabs, 't2'), 'onda 2');
    fs.writeFileSync(path.join(fix.tabs, 't3'), '');
    fix.setPanes('w1 t1', 'w2 t1', 'w3 t1', 'w4 t2', 'w5 t3', 'w6 t3');
    fix.setRoster('impl w1 implementer', 'rev w2 reviewer', 'impl-2 w3 implementer', 'des w4 designer', 'impl-3 w5 implementer', 'rev-2 w6 reviewer');
    fs.writeFileSync(fix.log, '');
    herdTabsRelabel(fix.ctx, fix.env, fix.cwd);
    assert.equal(fix.stateFile(), 't1\timpl+rev\tauto\nt2\t' + 'onda 2\tmanual\nt3\timpl+rev 2\tauto\n');
    assert.equal(fix.tabLabel('t1'), 'impl+rev'); // t1 renamed in Herdr
    assert.equal(fix.tabLabel('t2'), 'onda 2'); // manual tab not renamed
    assert.equal(fix.tabLabel('t3'), 'impl+rev 2'); // repeated roles → " 2"
    fs.writeFileSync(fix.log, '');
    herdTabsRelabel(fix.ctx, fix.env, fix.cwd);
    assert.ok(!fix.logLines().some((l) => l.startsWith('tab rename')),
      `relabel must not rename when nothing changed: ${fix.logLines().join('\n')}`);
    // a released worker changes the label; a tab left without workers shows `herd`
    fix.setRoster('impl w1 implementer', 'impl-2 w3 implementer', 'des w4 designer');
    herdTabsRelabel(fix.ctx, fix.env, fix.cwd);
    assert.equal(fix.stateFile(), 't1\timpl\tauto\nt2\t' + 'onda 2\tmanual\nt3\therd\tauto\n');
    // custom template
    const env2 = { ...fix.env, HERDR_AGENTS_HERD_LABEL: '{orch}·{roles}{i}', HERDR_AGENTS_HERD_LABEL_MAX: '40' };
    const ctx2 = loadConfig(env2, fix.cwd);
    herdTabsRelabel(ctx2, env2, fix.cwd);
    assert.equal(fix.stateFile(), 't1\tc·impl\tauto\nt2\t' + 'onda 2\tmanual\nt3\tc·3\tauto\n');
    assert.equal(fix.tabLabel('t1'), 'c·impl');
    assert.equal(fix.tabLabel('t3'), 'c·3');
    herdTabsRelabel(fix.ctx, fix.env, fix.cwd); // back to the default template
  } finally { fix.cleanup(); }
});

test('herdTabsRelabel: a rename done in Herdr by hand is respected (manual > auto)', () => {
  const fix = makeFix('ha-tabs-hand-');
  try {
    fs.writeFileSync(path.join(fix.ws, 'herd-tab'), 't1\timpl\tauto\nt2\t' + 'onda 2\tmanual\nt3\therd\tauto\n');
    fs.writeFileSync(path.join(fix.tabs, 't1'), 'impl');
    fs.writeFileSync(path.join(fix.tabs, 't2'), 'onda 2');
    fs.writeFileSync(path.join(fix.tabs, 't3'), 'herd');
    fix.setPanes('w1 t1', 'w3 t1', 'w4 t2', 's3 t3');
    fix.setRoster('impl w1 implementer', 'impl-2 w3 implementer', 'des w4 designer');
    fs.writeFileSync(path.join(fix.tabs, 't1'), 'onda 3');
    herdTabsRelabel(fix.ctx, fix.env, fix.cwd);
    assert.equal(fix.stateFile(), 't1\t' + 'onda 3\tmanual\nt2\t' + 'onda 2\tmanual\nt3\therd\tauto\n');
    assert.equal(fix.tabLabel('t1'), 'onda 3'); // the hand rename is kept
  } finally { fix.cleanup(); }
});

// --- herdTabPane: manual labels and the auto path -------------------------------

test('herdTabPane: label with room splits it; label full → "<label> ·2"; new manual; auto path', () => {
  const fix = makeFix('ha-tabs-pane-');
  try {
    const env = { ...fix.env, HERDR_AGENTS_SPLIT_MAX_PANES: '2' };
    const c = loadConfig(env, fix.cwd);
    fs.writeFileSync(path.join(fix.ws, 'herd-tab'), 't1\t' + 'onda 3\tmanual\nt2\t' + 'onda 2\tmanual\nt3\therd\tauto\n');
    fs.writeFileSync(path.join(fix.tabs, 't1'), 'onda 3');
    fs.writeFileSync(path.join(fix.tabs, 't2'), 'onda 2');
    fs.writeFileSync(path.join(fix.tabs, 't3'), 'herd');
    fix.setPanes('w1 t1', 'w3 t1', 'w4 t2', 's3 t3');
    fix.setRoster('impl w1 implementer', 'impl-2 w3 implementer', 'des w4 designer');
    fs.writeFileSync(fix.log, '');
    assert.deepEqual(herdTabPane(c, '/tmp', 'onda 2', 'reviewer', env, fix.cwd), { pane: 'split-of-w4', created: 1 });
    assert.ok(fix.logLines().includes('pane split w4 --direction down --cwd /tmp --no-focus'),
      `expected a split in t2 (onda 2), log: ${fix.logLines().join('\n')}`);
    // the same label is now full → the next tab is "<label> ·2", pinned manual
    fix.setRoster('impl w1 implementer', 'impl-2 w3 implementer', 'des w4 designer', 'rev w7 reviewer');
    fix.setPanes('w1 t1', 'w3 t1', 'w4 t2', 'w7 t2', 's3 t3');
    fs.writeFileSync(fix.log, '');
    assert.deepEqual(herdTabPane(c, '/tmp', 'onda 2', 'reviewer', env, fix.cwd), { pane: 'root-t4', created: 1 });
    assert.ok(fix.logLines().some((l) => l.startsWith('tab create ') && l.includes('--label ' + 'onda 2 ·2')),
      `expected a tab labelled 'onda 2 ·2', log: ${fix.logLines().join('\n')}`);
    assert.equal(fix.stateFile(), 't1\t' + 'onda 3\tmanual\nt2\t' + 'onda 2\tmanual\nt3\therd\tauto\nt4\t' + 'onda 2 ·2\tmanual\n');
    // a never-seen label → a new manual tab
    assert.deepEqual(herdTabPane(c, '/tmp', 'paridade', 'implementer', env, fix.cwd), { pane: 'root-t5', created: 1 });
    // auto path: first tab with room (t3, a shell in it)
    assert.deepEqual(herdTabPane(c, '/tmp', '', 'scouter', env, fix.cwd), { pane: 'split-of-s3', created: 1 });
    assert.equal(fix.logLines().at(-1), 'pane split s3 --direction down --cwd /tmp --no-focus');
    // every tab full (cap 0) → a new auto tab, label deduped against existing ones
    const env0 = { ...fix.env, HERDR_AGENTS_SPLIT_MAX_PANES: '0' };
    assert.deepEqual(herdTabPane(loadConfig(env0, fix.cwd), '/tmp', '', 'implementer', env0, fix.cwd), { pane: 'root-t6', created: 1 });
    const lines = fix.stateFile().trim().split('\n');
    assert.equal(lines.at(-1), 't6\timpl\tauto');
  } finally { fix.cleanup(); }
});

// --- the tab-label command -------------------------------------------------------

test('tab-label command: list, pin, pin on a given tab, --auto, dedupe, errors', () => {
  const fix = makeFix('ha-tabs-cmd-');
  try {
    const env = { ...fix.env, HERDR_ENV: '1' };
    const c = loadConfig(env, fix.cwd);
    fs.writeFileSync(path.join(fix.ws, 'herd-tab'), 't1\t' + 'onda 3\tmanual\nt2\t' + 'onda 2\tmanual\nt3\therd\tauto\nt4\t' + 'onda 2 ·2\tmanual\nt5\tparidade\tmanual\n');
    fs.writeFileSync(path.join(fix.tabs, 't1'), 'onda 3');
    fs.writeFileSync(path.join(fix.tabs, 't2'), 'onda 2');
    fs.writeFileSync(path.join(fix.tabs, 't3'), 'herd');
    fs.writeFileSync(path.join(fix.tabs, 't4'), 'onda 2 ·2');
    fs.writeFileSync(path.join(fix.tabs, 't5'), 'paridade');
    fix.setPanes('w1 t1', 'w3 t1', 'w4 t2', 'w7 t2', 's3 t3');
    fix.setRoster('impl w1 implementer', 'impl-2 w3 implementer', 'des w4 designer', 'rev w7 reviewer');
    // list
    let r = runTabLabel([], env, fix.cwd);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.split('\n').some((l) => /^t2 *onda 2 *manual$/.test(l)), `tab-label list:\n${r.stdout}`);
    assert.ok(r.stdout.startsWith('TAB        LABEL              MODE\n'), r.stdout);
    // pin a label on the newest herd tab (HERDR_TAB_ID=caller is not one)
    r = runTabLabel(['paridade', '·', 'onda', '2'], env, fix.cwd);
    assert.equal(r.status, 0, r.stderr);
    let j = JSON.parse(r.stdout);
    assert.deepEqual(j, { tab: 't5', label: 'paridade · onda 2', mode: 'manual' });
    assert.equal(fix.tabLabel('t5'), 'paridade · onda 2');
    // pin on a given tab
    r = runTabLabel(['--tab', 't3', 'revisao'], env, fix.cwd);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { tab: 't3', label: 'revisao', mode: 'manual' });
    // back to auto
    r = runTabLabel(['--tab', 't3', '--auto'], env, fix.cwd);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { tab: 't3', label: 'herd', mode: 'auto' });
    // auto again: no worker, "herd" taken by t3 → "herd 2"
    r = runTabLabel(['--tab', 't5', '--auto'], env, fix.cwd);
    assert.equal(r.status, 0, r.stderr);
    j = JSON.parse(r.stdout);
    assert.equal(j.label, 'herd 2');
    assert.equal(j.mode, 'auto');
    // a tab this workspace does not track → refused
    r = runTabLabel(['--tab', 'nope', 'x'], env, fix.cwd);
    assert.equal(r.status, 3);
    assert.equal(r.stderr, 'herdr-agents: tab-label: nope is not a herd tab of this workspace (see: tab-label)\n');
    // a long label warns once
    r = runTabLabel(['--tab', 't3', 'um rótulo comprido demais para a sidebar'], env, fix.cwd);
    assert.equal(r.status, 0, r.stderr);
    const warns = r.stderr.split('\n').filter((l) => l.includes('longer than 16'));
    assert.equal(warns.length, 1, r.stderr);
    // multibyte right at the limit (16 code points): no warning; one past it: warn
    r = runTabLabel(['--tab', 't3', 'é'.repeat(16)], env, fix.cwd);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stderr.includes('longer than'), r.stderr);
    assert.equal(JSON.parse(r.stdout).label, 'é'.repeat(16));
    r = runTabLabel(['--tab', 't3', 'é'.repeat(17)], env, fix.cwd);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes('longer than 16'), r.stderr);
    // no herd tab at all
    fs.rmSync(path.join(fix.ws, 'herd-tab'), { force: true });
    r = runTabLabel([], env, fix.cwd);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'TAB        LABEL              MODE\n(no herd tab yet)\n');
    r = runTabLabel(['x'], env, fix.cwd);
    assert.equal(r.status, 3);
    assert.equal(r.stderr, 'herdr-agents: tab-label: no herd tab yet (workers overflow into one when the caller\'s tab is full)\n');
    // bad flags
    r = runTabLabel(['--bogus'], env, fix.cwd);
    assert.equal(r.status, 2);
    assert.equal(r.stderr, 'herdr-agents: tab-label: unknown option --bogus\n');
    r = runTabLabel(['--tab'], env, fix.cwd);
    assert.equal(r.status, 2);
    assert.equal(r.stderr, 'herdr-agents: tab-label: --tab expects a value\n');
    void c;
  } finally { fix.cleanup(); }
});
