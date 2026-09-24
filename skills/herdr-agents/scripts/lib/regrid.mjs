// regrid (port slice 8a): the exact-grid reorganization of the panes this
// skill placed — the caller's tab (layout=split) keeps the caller and pulls
// workers back from the herd tabs while they fit (split_cap), parks them in
// a temporary tab (herdr refuses to move a pane into its own tab) and
// rebuilds them as a grid around the caller; every herd tab with ≥ 2
// workers moves into a fresh tab with the same label and is gridded there.
// Port of scripts/herdr-agents.sh :3065-3078 (move_pane /
// roster_replace_pane), :3099-3129 (build_grid / apply_grid), :3131-3143
// (park_panes) and :3145-3215 (cmd_regrid), plus the automatic calls at the
// end of cmd_spawn (:3604) and cmd_release (:4076).
//
// Faithful-port notes:
//   - the `herdr pane move` calls, their order and arguments (including the
//     4-decimal ratios `1/(remaining columns)` and `1/(remaining rows)` and
//     the literal `0.5` of the pull-back / first move / park moves) match
//     the bash;
//   - `buildGrid` collects the pane-id changes instead of printing
//     `<old>\t<new>` lines (bash pipes that output through `$( )` into
//     `apply_grid` — pure plumbing);
//   - `cmdRegrid` throws DieError 4 instead of `die … 4` so the automatic
//     callers (spawn, release --close) can catch it; the entry translates a
//     DieError into the same die (friction + exit code);
//   - a failed `agent get` is not absence: rosterPanesInTab (slice 5) keeps
//     the pane, so a regrid never drops a live worker it could not query.
import fs from 'node:fs';
import path from 'node:path';
import { runCli, projectRoot } from './platform.mjs';
import { cfg, DieError } from './config.mjs';
import { stateDir, workspaceId, warn, rosterReplacePane, logFrictionError } from './state.mjs';
import { HERDR_TIMEOUT_MS, paneList, tabCreate, paneClose } from './herdr.mjs';
import { gridSizes, splitCap, uiFocusedPane, restoreFocusIfStolen } from './layout.mjs';
import { herdTabEntries, herdTabSet, herdTabsRelabel, rosterPanesInTab } from './herdtabs.mjs';

// ---------- move_pane (:3065) ----------

// herdr pane move <pane> --tab <tab> --split <split> --target-pane <target>
// --ratio <ratio> --no-focus → { ok, pane }: the pane's id after the move.
// The id comes from `.result.move_result.pane.pane_id // .result.pane.
// pane_id // empty` — a missing id is still success (bash `jq -r … //
// empty` with exit 0), and callers treat '' as "unchanged". Output jq
// rejects is a failed move, like bash: invalid JSON, or a path that indexes
// a non-object (`[]`, `5`, `{"result":"x"}`); empty output and `null` pass.
export function movePane(pane, tab, split, target, ratio, env = process.env) {
  const r = runCli('herdr', ['pane', 'move', pane, '--tab', tab, '--split', split, '--target-pane', target, '--ratio', String(ratio), '--no-focus'], { env, timeoutMs: HERDR_TIMEOUT_MS });
  const failed = { ok: false, pane: '' };
  if (r.notFound || r.timedOut || r.status !== 0) return failed;
  const text = r.stdout ?? '';
  if (text.trim() === '') return { ok: true, pane: '' };
  let out;
  try { out = JSON.parse(text); } catch { return failed; }
  const first = jqPath(out, ['result', 'move_result', 'pane', 'pane_id']);
  if (!first.ok) return failed;
  let id = first.value;
  if (id === null || id === false) {
    const second = jqPath(out, ['result', 'pane', 'pane_id']);
    if (!second.ok) return failed;
    id = second.value;
  }
  // `jq -r` (no -c) prints a string raw and anything else as JSON indented
  // by two spaces.
  if (id === null || id === false) return { ok: true, pane: '' };
  return { ok: true, pane: typeof id === 'string' ? id : JSON.stringify(id, null, 2) };
}

// jq `.a.b.c`: null or a missing key gives null; indexing anything that is
// not an object (array, string, number, boolean) is jq's `Cannot index`.
function jqPath(v, keys) {
  for (const k of keys) {
    if (v === null || v === undefined) return { ok: true, value: null };
    if (typeof v !== 'object' || Array.isArray(v)) return { ok: false, value: null };
    v = Object.hasOwn(v, k) ? v[k] : null;
  }
  return { ok: true, value: v ?? null };
}

// ---------- build_grid / apply_grid (:3099 / :3124) ----------

// 4-decimal ratio like bash `awk 'BEGIN{printf "%.4f", 1/k}'`.
function ratio4(k) {
  return (1 / k).toFixed(4);
}

// build_grid <tab> <cell0> <cell…> → { ok, changes }: cell0 already fills
// <tab>; the other cells are moved in as an exact grid (gridSizes) in two
// passes — column heads first (right splits, ratio 1/remaining columns, so
// every column spans the full height), then the rows of each column (down
// splits, ratio 1/remaining rows). `changes` is one [old, new] per pane id
// that changed (none inside a workspace, measured).
export function buildGrid(tab, cells, env = process.env) {
  const { cols, rows: sizes } = gridSizes(cells.length);
  const cellsArr = [...cells];
  const heads = [];
  let idx = 0;
  for (let c = 0; c < cols; c += 1) { heads.push(idx); idx += sizes[c]; }
  const changes = [];
  const note = (i, m) => {
    if (m.pane !== '' && m.pane !== cellsArr[i]) { changes.push([cellsArr[i], m.pane]); cellsArr[i] = m.pane; }
  };
  let prev = cellsArr[0];
  for (let c = 1; c < cols; c += 1) {
    const i = heads[c];
    const m = movePane(cellsArr[i], tab, 'right', prev, ratio4(cols - c + 1), env);
    if (!m.ok) return { ok: false, changes };
    note(i, m);
    prev = cellsArr[i];
  }
  for (let c = 0; c < cols; c += 1) {
    const m0 = sizes[c];
    let i = heads[c];
    prev = cellsArr[i];
    for (let j = 1; j < m0; j += 1) {
      i += 1;
      const m = movePane(cellsArr[i], tab, 'down', prev, ratio4(m0 - j + 1), env);
      if (!m.ok) return { ok: false, changes };
      note(i, m);
      prev = cellsArr[i];
    }
  }
  return { ok: true, changes };
}

// apply_grid <tab> <cell0> <cell…> — buildGrid + one roster replace per
// changed pane id (rosterReplacePane is a no-op for unchanged ids).
export function applyGrid(ctx, tab, cells, env = process.env, cwd = process.cwd()) {
  const sd = stateDir(ctx, env, cwd);
  const r = buildGrid(tab, cells, env);
  if (!r.ok) return { ok: false };
  for (const [oldId, newId] of r.changes) if (oldId !== '') rosterReplacePane(sd, oldId, newId);
  return { ok: true };
}

// ---------- park_panes (:3131) ----------

// Move <first> into a fresh `herd-park` tab, then every other pane into it
// split down off the first (ratio 0.5, output discarded). { ok, tab }.
// Herdr refuses to move a pane inside its own tab, so a regrid of the
// caller's tab moves the workers out first; the park tab closes itself when
// its last pane leaves.
export function parkPanes(panes, env = process.env) {
  if (panes.length === 0) return { ok: false, tab: '' };
  const first = panes[0];
  const r0 = runCli('herdr', ['pane', 'move', first, '--new-tab', '--label', 'herd-park', '--no-focus'], { env, timeoutMs: HERDR_TIMEOUT_MS });
  if (r0.notFound || r0.timedOut || r0.status !== 0) return { ok: false, tab: '' };
  let out = null;
  try { out = JSON.parse(r0.stdout ?? ''); } catch { out = null; }
  const tab = out && typeof out === 'object' ? out?.result?.move_result?.pane?.tab_id : undefined;
  if (tab === undefined || tab === null || tab === '') return { ok: false, tab: '' };
  const park = String(tab);
  for (let i = 1; i < panes.length; i += 1) {
    const r = runCli('herdr', ['pane', 'move', panes[i], '--tab', park, '--split', 'down', '--target-pane', first, '--ratio', '0.5', '--no-focus'], { env, timeoutMs: HERDR_TIMEOUT_MS });
    if (r.notFound || r.timedOut || r.status !== 0) return { ok: false, tab: park };
  }
  return { ok: true, tab: park };
}

// ---------- cmd_regrid (:3145) ----------

// `regrid`: exact grids everywhere this skill placed panes. Throws DieError
// 4 on the bash die sites; the entry translates it (friction + exit code).
export function cmdRegrid(argv, ctx, env = process.env, cwd = process.cwd()) {
  void argv; // bash cmd_regrid takes no arguments and ignores extras
  const sd = stateDir(ctx, env, cwd);
  const ws = workspaceId(ctx, env, cwd);
  const root = projectRoot(env, cwd);
  const layout = cfg(ctx, 'layout', 'split', env);
  const focusBefore = uiFocusedPane(env);
  let live = paneList(env, ws);
  const summary = [];
  if (layout === 'split' && (env.HERDR_TAB_ID ?? '') !== '' && (env.HERDR_PANE_ID ?? '') !== '') {
    const callerTab = env.HERDR_TAB_ID;
    const callerPane = env.HERDR_PANE_ID;
    const panes = rosterPanesInTab(live, callerTab, ctx, env, cwd);
    // Room left next to the caller (workers released, cap raised): bring
    // overflowed workers back from the herd tabs, first tab first pane,
    // while caller + workers stays within split_max_panes. The user reads
    // one tab whenever it fits; a herd tab that empties closes itself.
    const cap = splitCap(ctx, env);
    outer:
    for (const e of herdTabEntries(ctx, env, cwd)) {
      if (e.tab === '') continue;
      for (const hp of rosterPanesInTab(live, e.tab, ctx, env, cwd)) {
        if (panes.length + 1 >= cap) break outer;
        const m = movePane(hp, callerTab, 'right', callerPane, '0.5', env);
        if (!m.ok) { warn(`regrid: could not bring ${hp} back into ${callerTab}`); continue; }
        let p = hp;
        if (m.pane !== '' && m.pane !== hp) { rosterReplacePane(sd, hp, m.pane); p = m.pane; }
        panes.push(p);
      }
    }
    live = paneList(env, ws);
    if (panes.length >= 1) {
      const park = parkPanes(panes, env);
      if (!park.ok) throw new DieError(`regrid: could not park the workers of tab ${callerTab} in a temporary tab`, 4);
      const g = applyGrid(ctx, callerTab, [callerPane, ...panes], env, cwd);
      if (!g.ok) throw new DieError(`regrid: a move back into ${callerTab} failed; remaining workers are alive in tab ${park.tab} (label herd-park)`, 4);
      summary.push({ tab: callerTab, label: 'caller', panes: panes.length + 1, cols: gridSizes(panes.length + 1).cols });
    }
  }
  let kept = '';
  for (const e of herdTabEntries(ctx, env, cwd)) {
    if (e.tab === '') continue;
    const label = e.label === '-' ? '' : e.label;
    const panes = rosterPanesInTab(live, e.tab, ctx, env, cwd);
    if (panes.length < 1) continue; // emptied by the pull-back: forget it
    let tab = e.tab;
    if (panes.length >= 2) {
      const created = tabCreate(env, ws, root, label !== '' ? label : 'herd');
      if (!created.ok) throw new DieError('tab create failed', 4);
      const newtab = created.tab;
      herdTabSet(ctx, newtab, label, e.mode, env, cwd); // tracked at once: a failed move must not orphan the tab
      const m = movePane(panes[0], newtab, 'right', created.root, '0.5', env);
      if (!m.ok) throw new DieError(`regrid: move of ${panes[0]} failed; remaining workers are alive in tab ${e.tab}`, 4);
      paneClose(created.root, env); // best effort, as bash >/dev/null 2>&1 || true
      if (m.pane !== '' && m.pane !== panes[0]) { rosterReplacePane(sd, panes[0], m.pane); panes[0] = m.pane; }
      const g = applyGrid(ctx, newtab, panes, env, cwd);
      if (!g.ok) throw new DieError(`regrid: a move into ${newtab} failed; remaining workers are alive in tab ${e.tab}`, 4);
      summary.push({ tab: newtab, label: label !== '' ? label : 'herd', panes: panes.length, cols: gridSizes(panes.length).cols });
      tab = newtab;
    }
    kept += `${tab}\t${label === '' ? '-' : label}\t${e.mode}\n`;
  }
  // The file only exists when there was one: herdTabEntries never creates
  // it, and bash guards the rewrite with [ -f ].
  const herdTabFile = path.join(sd, 'herd-tab');
  if (fs.existsSync(herdTabFile)) fs.writeFileSync(herdTabFile, kept);
  try {
    herdTabsRelabel(ctx, env, cwd);
  } catch {
    warn('regrid: relabel of the herd tabs failed');
  }
  restoreFocusIfStolen(focusBefore, uiFocusedPane(env), '', env);
  process.stdout.write(`${JSON.stringify({ regridded: summary })}\n`);
  return 0;
}

// ---------- the automatic call (cmd_spawn :3604, cmd_release :4076) ----------

// `(cmd_regrid) >/dev/null 2>&1 || warn <msg>`: run in the same process with
// stdout and stderr suppressed (a failure still lands in the friction log —
// that is what "see friction" points at), and turn a DieError into the
// warning; the caller keeps its own exit code.
export function autoRegrid(ctx, env = process.env, cwd = process.cwd(), message) {
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  let failed = false;
  try {
    process.stdout.write = () => true;
    process.stderr.write = () => true;
    cmdRegrid([], ctx, env, cwd);
  } catch (e) {
    if (e instanceof DieError) {
      // The suppressed bash subshell still logs the die to the friction
      // file before exiting — keep the `error(exit N)` line, then warn.
      logFrictionError(e.message, e.code ?? 1);
      failed = true;
    } else throw e;
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  if (failed) warn(message);
}
