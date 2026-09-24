// Herd tabs (slice 5a): the overflow tabs and their labels. The state
// file <state>/herd-tab holds one tab per line `tab\tlabel\tmode`
// (auto|manual; an empty label is stored as `-` because a tab-IFS read
// swallows empty fields). Auto labels are composed from the roles living
// in the tab (config `herd_label`, default {roles} → impl+rev; a repeat
// gets ` 2`, ` 3`…, cut to `herd_label_max` characters) and rewritten
// after every spawn, release and regrid. A live label that differs from
// the last one this skill wrote is a hand rename → manual. Old
// one-column files (ids only) migrate on read: a live label that still
// looks like `herd`/`herd-N` is auto, anything else was renamed by hand.
// Dead tabs (tab get fails) are pruned on read; the function rewrites the
// file on every read. Port of the original bash implementation :2867-3019 and
// :2924-2967 (role_abbrev … cmd_tab_label); file writes use atomicWrite
// (slice-4 decision).
import fs from 'node:fs';
import path from 'node:path';
import { readTextFile, atomicWrite } from './platform.mjs';
import { cfg, DieError } from './config.mjs';
import { stateDir, rosterRows, warn, workspaceId, dieFriction } from './state.mjs';
import { agentState, paneList, tabGet, tabRename, tabCreate, paneSplit, callerAgentName } from './herdr.mjs';
import { splitCap, autoDirectionFor } from './layout.mjs';

// role_abbrev() port: the short name each role contributes to the label.
const ROLE_ABBREV = {
  implementer: 'impl', reviewer: 'rev', inspector: 'insp', designer: 'des',
  scouter: 'scout', researcher: 'res', tasker: 'task', 'security-reviewer': 'sec',
  'sub-orchestrator': 'sub', planner: 'plan',
};
export function roleAbbrev(role) {
  return Object.prototype.hasOwnProperty.call(ROLE_ABBREV, role) ? ROLE_ABBREV[role] : role;
}

// herd_label_max() port: a validated number (bad value → 16, like the
// bash fallback; doctor warns).
export function herdLabelMax(ctx, env = process.env) {
  const v = cfg(ctx, 'herd_label_max', '16', env);
  return /^[0-9]+$/.test(v) ? Number(v) : 16;
}

// One herd-tab line parsed with bash `IFS=$'\t' read -r t label mode`
// semantics: tab is an IFS whitespace char, so leading and trailing tabs
// are dropped, a run of tabs is one delimiter (an empty field collapses
// away) and the last field keeps the remainder, inner tabs included.
function parseEntry(line) {
  let rest = line.replace(/^\t+|\t+$/g, '');
  const take = () => {
    const i = rest.indexOf('\t');
    if (i === -1) { const f = rest; rest = ''; return f; }
    const f = rest.slice(0, i);
    rest = rest.slice(i).replace(/^\t+/, '');
    return f;
  };
  const tab = take();
  const label = take();
  return { tab, label, mode: rest };
}

// The file-form label: an empty label is stored as `-` (a tab-IFS read
// would swallow the empty field).
function storedLabel(label) {
  return label === '' ? '-' : label;
}

// Entry lines of the file, CRLF-normalized (decision 7), with bash read's
// trailing-newline rule: the last line of a file that does not end in a
// newline is never read (read returns non-zero on it).
function entryLines(f) {
  let raw;
  try { raw = readTextFile(f); } catch { return []; }
  if (raw === '') return [];
  const lines = raw.split('\n');
  lines.pop(); // trailing '' after the final newline, or the unterminated last line
  return lines;
}

// herd_tab_entries() port: the live `<tab>\t<label>\t<mode>` entries —
// migrated (one-column files), drift-checked (an auto label renamed in
// Herdr is switched to manual), pruned (dead tabs) — and the file is
// rewritten with them. Returns the entries in file form (label `-` when
// empty), exactly what the function prints and stores.
export function herdTabEntries(ctx, env = process.env, cwd = process.cwd()) {
  const sd = stateDir(ctx, env, cwd);
  const f = path.join(sd, 'herd-tab');
  if (!fs.existsSync(f)) return [];
  const out = [];
  for (const line of entryLines(f)) {
    const { tab, label: stored, mode } = parseEntry(line);
    if (tab === '') continue;
    let label = stored === '-' ? '' : stored;
    const g = tabGet(tab, env);
    if (!g.ok) continue; // dead tab: pruned
    const cur = g.label;
    let lab = label;
    let m = mode;
    if (m === '') {
      // Old one/two-column line: a live label that still looks like
      // herd/herd-N is auto, anything else was renamed by hand.
      m = cur === '' || /^herd(-[0-9]+)?$/.test(cur) ? 'auto' : 'manual';
      lab = cur;
    } else if (m === 'auto' && lab !== '' && cur !== '' && cur !== lab) {
      m = 'manual';
      lab = cur; // renamed in Herdr: respect it
    }
    out.push({ tab, label: storedLabel(lab), mode: m });
  }
  atomicWrite(f, out.map((e) => `${e.tab}\t${e.label}\t${e.mode}\n`).join(''));
  return out;
}

// herd_tab_set() port: upsert one entry, order kept, rewriting the file
// in the 3-column form (a 1- or 2-column line is normalized the way
// herd_tab_line reprints it).
export function herdTabSet(ctx, tab, label, mode, env = process.env, cwd = process.cwd()) {
  const sd = stateDir(ctx, env, cwd);
  const f = path.join(sd, 'herd-tab');
  const out = [];
  let found = false;
  for (const line of entryLines(f)) {
    const p = parseEntry(line);
    if (p.tab === '') continue;
    if (p.tab === tab) {
      out.push(`${tab}\t${storedLabel(label)}\t${mode}`);
      found = true;
    } else {
      out.push(`${p.tab}\t${storedLabel(p.label)}\t${p.mode}`);
    }
  }
  if (!found) out.push(`${tab}\t${storedLabel(label)}\t${mode}`);
  atomicWrite(f, out.map((l) => `${l}\n`).join(''));
}

// compose_herd_label() port: {roles} = the distinct abbreviated roles
// joined by + (arrival order), {n} = the worker count (repeats included),
// {i} = the tab position from 2 ('' on the first tab), {orch} = the
// orchestrator name. Substitutions run in that order; the result is
// trimmed like the bash sed.
export function composeHerdLabel(tpl, roles, i = 1, orch = '') {
  const list = Array.isArray(roles) ? roles : String(roles).split(/\s+/).filter((s) => s !== '');
  let n = 0;
  let out = '';
  const seen = new Set();
  for (const r of list) {
    n += 1;
    const a = roleAbbrev(r);
    if (seen.has(a)) continue;
    seen.add(a);
    out = out === '' ? a : `${out}+${a}`;
  }
  const is = String(i);
  const iStr = /^[+-]?[0-9]+$/.test(is) && parseInt(is, 10) > 1 ? is : '';
  let s = String(tpl);
  s = s.split('{roles}').join(out);
  s = s.split('{n}').join(String(n));
  s = s.split('{i}').join(iStr);
  s = s.split('{orch}').join(orch);
  return s.trim();
}

// herd_auto_label() port: the base cut to herd_label_max characters
// (Unicode code points, like the bash in a UTF-8 locale), with trailing
// spaces, + and · removed; ` 2`, ` 3`… when an earlier tab already shows
// the label — the suffix fits inside the limit. `taken` is the array of
// labels already used (file form; an empty label is one '-').
export function herdAutoLabel(base, taken, ctx, env = process.env) {
  const max = herdLabelMax(ctx, env);
  const b = base === undefined || base === null || base === '' ? 'herd' : String(base);
  const chars = Array.from(b);
  const strip = (s) => s.replace(/[\s+·]+$/, '');
  const takenArr = Array.isArray(taken) ? taken : String(taken).split('\n');
  let cand = strip(chars.slice(0, max).join(''));
  let k = 2;
  while (takenArr.includes(cand)) {
    const suffix = ` ${k}`;
    const cut = Math.max(0, max - suffix.length);
    cand = strip(chars.slice(0, cut).join('')) + suffix;
    k += 1;
  }
  return cand;
}

// roster_roles_in_tab() port: the roles of this skill's workers whose
// pane sits in <tab>, roster order (a row with a matching pane and no
// role still counts, as an empty token, as in bash).
export function rosterRolesInTab(live, tab, ctx, env = process.env, cwd = process.cwd()) {
  const sd = stateDir(ctx, env, cwd);
  const out = [];
  for (const line of rosterRows(sd)) {
    const f = line.split('\t');
    const name = f[0] ?? '';
    if (name === '') continue;
    const pane = f[1] ?? '';
    if (!live.some((p) => p && p.pane_id === pane && p.tab_id === tab)) continue;
    out.push(f[3] ?? '');
  }
  return out;
}

// roster_panes_in_tab() port: this skill's live worker panes in <tab>,
// roster order. A failed agent query is not absence — only `gone` drops
// the pane, so a regrid never loses a live worker.
export function rosterPanesInTab(live, tab, ctx, env = process.env, cwd = process.cwd()) {
  const sd = stateDir(ctx, env, cwd);
  const out = [];
  for (const line of rosterRows(sd)) {
    const f = line.split('\t');
    const name = f[0] ?? '';
    if (name === '') continue;
    const pane = f[1] ?? '';
    if (!live.some((p) => p && p.pane_id === pane && p.tab_id === tab)) continue;
    if (agentState(name, env).state === 'gone') continue;
    out.push(pane);
  }
  return out;
}

// herd_tabs_relabel() port: recompute the auto labels from the roles
// living in each herd tab and rename the tabs that changed; manual
// entries are kept. A rename failure warns (and the friction log).
export function herdTabsRelabel(ctx, env = process.env, cwd = process.cwd()) {
  const ws = workspaceId(ctx, env, cwd);
  const live = paneList(env, ws);
  const entries = herdTabEntries(ctx, env, cwd);
  const tpl = cfg(ctx, 'herd_label', '{roles}', env);
  let orch = '';
  if (tpl.includes('{orch}')) {
    orch = callerAgentName(env);
    if (orch === '') orch = cfg(ctx, 'orchestrator_name', 'orchestrator', env);
  }
  let idx = 0;
  const taken = [];
  for (const e of entries) {
    if (e.tab === '') continue;
    let label = e.label === '-' ? '' : e.label;
    idx += 1;
    if (e.mode === 'auto') {
      const roles = rosterRolesInTab(live, e.tab, ctx, env, cwd);
      const want = herdAutoLabel(composeHerdLabel(tpl, roles, idx, orch), taken, ctx, env);
      const cur = tabGet(e.tab, env).label;
      if (want !== cur && !tabRename(e.tab, want, env)) {
        warn(`tab rename ${e.tab} → '${want}' failed`);
      }
      label = want;
    }
    taken.push(label);
    herdTabSet(ctx, e.tab, label, e.mode, env, cwd);
  }
}

// herd_tab_split() port: a new pane split off the last pane of <tab> in
// the live list; when the tab shows no pane, the tab's root pane stands
// in (no split). Returns { pane, created: 1 }; a failed split throws
// DieError 4 `pane split failed` (only the command boundary dies).
export function herdTabSplit(ctx, tab, workerCwd, env = process.env, cwd = process.cwd()) {
  const ws = workspaceId(ctx, env, cwd);
  const live = paneList(env, ws);
  const inTab = live.filter((p) => p && p.tab_id === tab);
  const anchor = inTab.length > 0 ? String(inTab[inTab.length - 1]?.pane_id ?? '') : '';
  if (anchor === '') return { pane: tabGet(tab, env).root, created: 1 };
  const dir = autoDirectionFor(env, anchor);
  const s = paneSplit(anchor, dir, workerCwd, env);
  if (!s.ok) throw new DieError('pane split failed', 4);
  return { pane: s.pane, created: 1 };
}

// herd_tab_pane() port: a pane in a herd tab holding fewer than
// split_max_panes of this skill's workers. With <label> (spawn
// --tab-label) the tab showing that label is used or created and pinned
// manual; a full one takes "<label> ·2", "·3"…. Without it, the first
// tab with room in order, else a new auto tab provisionally labelled
// after <role> (relabelled once the roster knows it). Returns
// { pane, created: 1 }; tab create / pane split failures throw DieError 4.
export function herdTabPane(ctx, workerCwd, label, role, env = process.env, cwd = process.cwd()) {
  const ws = workspaceId(ctx, env, cwd);
  const cap = splitCap(ctx, env);
  const live = paneList(env, ws);
  let newLabel;
  let newMode;
  if (label !== '') {
    let cand = label;
    let k = 2;
    for (;;) {
      const match = herdTabEntries(ctx, env, cwd).find((e) => e.label === cand);
      if (!match) break;
      if (rosterPanesInTab(live, match.tab, ctx, env, cwd).length < cap) {
        herdTabSet(ctx, match.tab, cand, 'manual', env, cwd);
        return herdTabSplit(ctx, match.tab, workerCwd, env, cwd);
      }
      cand = `${label} ·${k}`;
      k += 1;
    }
    newLabel = cand;
    newMode = 'manual';
  } else {
    const entries = herdTabEntries(ctx, env, cwd);
    for (const e of entries) {
      if (e.tab === '') continue;
      if (rosterPanesInTab(live, e.tab, ctx, env, cwd).length < cap) {
        return herdTabSplit(ctx, e.tab, workerCwd, env, cwd);
      }
    }
    newLabel = herdAutoLabel(role !== '' ? roleAbbrev(role) : '', entries.map((e) => e.label), ctx, env);
    newMode = 'auto';
  }
  const t = tabCreate(env, ws, workerCwd, newLabel);
  if (!t.ok) throw new DieError('tab create failed', 4);
  herdTabSet(ctx, t.tab, newLabel, newMode, env, cwd);
  return { pane: t.root, created: 1 };
}

// The command's JSON, exactly as bash prints it: `jq -n` pretty output
// (2-space indent, trailing newline). Values go through JSON.stringify,
// which matches jq for strings, booleans and numbers (the spawn slice
// reuses this for its {created_pane: bool} key).
export function jqPretty(obj) {
  const items = Object.keys(obj).map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(obj[k])}`);
  return `{\n${items.join(',\n')}\n}\n`;
}

// cmd_tab_label() port: no text → list the herd tabs (id, label, mode);
// with text → rename and pin the label (manual; a long label warns);
// --auto → back to the composed label. Default target: the caller's tab
// when it is a herd tab, else the newest one. JSON {tab,label,mode} on
// success. Dies (friction-logging, like bash main) 3 for no herd tab / a
// tab this workspace does not track, 4 for a failed rename, 2 for a bad
// flag.
export function cmdTabLabel(argv, ctx, env = process.env, cwd = process.cwd()) {
  let text = '';
  let tab = '';
  let auto = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--tab') {
      const v = argv[i + 1];
      if (v === undefined) dieFriction('tab-label: --tab expects a value', 2);
      tab = v;
      i += 1;
    } else if (a === '--auto') {
      auto = true;
    } else if (a.startsWith('--')) {
      dieFriction(`tab-label: unknown option ${a}`, 2);
    } else {
      text = text === '' ? a : `${text} ${a}`;
    }
  }
  const entries = herdTabEntries(ctx, env, cwd);
  if (text === '' && !auto) {
    const pad = (s, n) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
    process.stdout.write(`${pad('TAB', 10)} ${pad('LABEL', 18)} MODE\n`);
    for (const e of entries) process.stdout.write(`${pad(e.tab, 10)} ${pad(e.label, 18)} ${e.mode}\n`);
    if (entries.length === 0) process.stdout.write('(no herd tab yet)\n');
    return;
  }
  if (entries.length === 0) dieFriction('tab-label: no herd tab yet (workers overflow into one when the caller\'s tab is full)', 3);
  if (tab === '') {
    const callerTab = env.HERDR_TAB_ID ?? '';
    if (callerTab !== '' && entries.some((e) => e.tab === callerTab)) tab = callerTab;
    else tab = entries[entries.length - 1].tab;
  }
  if (!entries.some((e) => e.tab === tab)) dieFriction(`tab-label: ${tab} is not a herd tab of this workspace (see: tab-label)`, 3);
  let label;
  let mode;
  if (auto) {
    herdTabSet(ctx, tab, '', 'auto', env, cwd);
    herdTabsRelabel(ctx, env, cwd);
    label = herdTabEntries(ctx, env, cwd).find((e) => e.tab === tab)?.label ?? '';
    mode = 'auto';
  } else {
    const max = herdLabelMax(ctx, env);
    if (Array.from(text).length > max) warn(`label '${text}' is longer than ${max} characters; the sidebar will cut it`);
    if (!tabRename(tab, text, env)) dieFriction('tab rename failed', 4);
    herdTabSet(ctx, tab, text, 'manual', env, cwd);
    label = text;
    mode = 'manual';
  }
  process.stdout.write(jqPretty({ tab, label, mode }));
}
