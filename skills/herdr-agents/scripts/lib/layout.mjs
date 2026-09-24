// Placement (slice 5a): where a new worker opens in the split layout — the
// per-tab capacity and minimum-pane rules, the split anchor over a `herdr
// pane layout` document, the grid shapes, the UI focus helpers and the
// `layout-plan` command. Port of the original bash implementation :2731-2855
// (auto_direction_for … restore_focus_if_stolen) and :3076-3090
// (grid_sizes); the herd-tab side lives in lib/herdtabs.mjs.
//
// Faithful-port notes:
//   - Fractions are rounded the way the jq reference does: 2 decimals for
//     the anchor decision (a 107/106-column pair counts as a tie) and
//     3 decimals in the layout-plan candidates.
//   - The anchor sort is `sort_by(-area, me, y, x)`: largest area first,
//     a worker before the caller, then top-left first.
//   - A document without a usable .result.layout (or whose area cannot be
//     computed) reads as "no candidates": the jq reference fails there and
//     the bash callers fall back to the caller pane split `right`.
//   - `layout-plan --layout/--me/--mine` with a missing value dies 2
//     `<flag> expects a value` (spec 1.2 rule); the bash loop would spin
//     forever on a dangling `--layout`, so the loop is not ported.
import fs from 'node:fs';
import { die, runCli } from './platform.mjs';
import { cfg } from './config.mjs';
import { lanesEnabled, panesValue, configExplicit } from './lanes.mjs';
import { stateDir, rosterRows } from './state.mjs';
import { requireEnv, paneLayout, agentFocus, paneFocusBack, HERDR_TIMEOUT_MS } from './herdr.mjs';

// split_cap() port: panes per tab, caller included. With lanes on and no
// explicit split_max_panes it follows `panes`; a non-integer value falls
// back to 4 (`doctor` warns about the bad value).
export function splitCap(ctx, env = process.env) {
  if (lanesEnabled(ctx, env) && !configExplicit(ctx, 'split_max_panes', env)) return Number(panesValue(ctx, env));
  const v = cfg(ctx, 'split_max_panes', '4', env);
  return /^[0-9]+$/.test(v) ? Number(v) : 4;
}

// split_min() port: the smallest pane a split may leave, as a fraction of
// the tab; a value not matching ^0?\.[0-9]+$ falls back to 0.18.
export function splitMin(ctx, env = process.env) {
  const v = cfg(ctx, 'split_min_pane', '0.18', env);
  return /^0?\.[0-9]+$/.test(v) ? Number(v) : 0.18;
}

// The parts of a usable layout document (panes + tab area), or null when
// the document is not a `herdr pane layout` result the jq reference could
// work on. The area is `.area` when it is a usable object, else inferred
// from the max of x+width / y+height over the panes (needs ≥ 1 pane).
function layoutParts(doc) {
  const L = doc && typeof doc === 'object' ? doc.result?.layout : undefined;
  if (!L || typeof L !== 'object' || !Array.isArray(L.panes)) return null;
  const panes = L.panes;
  let area = null;
  if (L.area && typeof L.area === 'object') {
    const w = Number(L.area.width);
    const h = Number(L.area.height);
    if (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) area = { width: w, height: h };
  }
  if (!area) {
    if (panes.length === 0) return null;
    let w = 0;
    let h = 0;
    for (const p of panes) {
      const r = p && typeof p === 'object' ? p.rect : undefined;
      const x = Number(r?.x);
      const pw = Number(r?.width);
      const y = Number(r?.y);
      const ph = Number(r?.height);
      if (Number.isFinite(x) && Number.isFinite(pw)) w = Math.max(w, x + pw);
      if (Number.isFinite(y) && Number.isFinite(ph)) h = Math.max(h, y + ph);
    }
    if (w <= 0 || h <= 0) return null;
    area = { width: w, height: h };
  }
  return { panes, area };
}

// split_anchor_from_layout() port, pure over a parsed layout document.
// `mine` is an array of pane ids (the bash callers pass the roster panes
// space-padded). Candidates are the caller plus those workers in the tab;
// sizes are fractions of the tab area (2 decimals, so 107/106 columns tie).
// `full`: the tab already holds `cap` candidates. `min`: no candidate can
// be halved without leaving a pane thinner than `min`. Otherwise the
// largest area, split on its longer side (width fraction ≥ height
// fraction → right); ties go to a worker before the caller, then
// top-left first. Returns { anchor, direction } | { overflow:
// 'full' | 'min' } | null (no candidates / unusable document).
export function splitAnchorFromLayout(layoutDoc, me, mine, cap, min) {
  const parts = layoutParts(layoutDoc);
  if (!parts) return null;
  const { panes, area } = parts;
  const cands = [];
  for (const p of panes) {
    if (!p || typeof p !== 'object') continue;
    const id = p.pane_id;
    if (typeof id !== 'string' || (id !== me && !mine.includes(id))) continue;
    const r = p.rect ?? {};
    const w = Math.round((Number(r.width) / area.width) * 100) / 100;
    const h = Math.round((Number(r.height) / area.height) * 100) / 100;
    if (!Number.isFinite(w) || !Number.isFinite(h)) continue; // jq would fail here
    cands.push({ pane_id: id, me: id === me, x: Number(r.x) || 0, y: Number(r.y) || 0, w, h });
  }
  if (cands.length === 0) return null;
  if (cands.length >= Number(cap)) return { overflow: 'full' };
  for (const c of cands) {
    c.area = c.w * c.h;
    c.long = Math.max(c.w, c.h);
  }
  const ok = cands.filter((c) => c.long / 2 >= Number(min));
  if (ok.length === 0) return { overflow: 'min' };
  // sort_by(-.area, .me, .y, .x): area descending (largest first), a
  // worker (me=false) before the caller, then y, then x ascending.
  ok.sort((a, b) => (b.area - a.area) || ((a.me ? 1 : 0) - (b.me ? 1 : 0)) || (a.y - b.y) || (a.x - b.x));
  const top = ok[0];
  return { anchor: top.pane_id, direction: top.w >= top.h ? 'right' : 'down' };
}

// grid_sizes() port: cols = ⌈√n⌉, rows balanced, the extra rows go to the
// LAST columns so cell 0 (the caller) keeps the least crowded column
// (3 cells → caller full height on the left, two workers stacked on the
// right). n < 1 → { cols: 0, rows: [] } (bash prints `0`).
export function gridSizes(n) {
  n = Math.trunc(Number(n));
  if (!(n >= 1)) return { cols: 0, rows: [] };
  let cols = 1;
  while (cols * cols < n) cols += 1;
  const base = Math.floor(n / cols);
  const extra = n % cols;
  const rows = [];
  for (let c = 0; c < cols; c += 1) rows.push(c >= cols - extra ? base + 1 : base);
  return { cols, rows };
}

// auto_direction_for() port: split the pane on its longer side — width
// (cells) ≥ 160 and ≥ 2× the height → `right`, else `down`. No usable
// layout (herdr failed, unparseable, pane not in it) → the bash fallback
// is `right` when there is no layout at all, `down` otherwise.
export function autoDirectionFor(env = process.env, paneId = '') {
  const r = paneLayout(env, paneId);
  const layout = r.stdout ?? '';
  if (layout === '') return 'right';
  let doc;
  try { doc = JSON.parse(layout); } catch { return 'down'; }
  const panes = doc && typeof doc === 'object' ? doc?.result?.layout?.panes : undefined;
  if (!Array.isArray(panes)) return 'down';
  const sel = paneId !== '' ? paneId : (env.HERDR_PANE_ID ?? '');
  let found = null;
  for (const p of panes) {
    if (!p || typeof p !== 'object') continue;
    if (p.pane_id === sel || (sel === '' && p.focused === true)) { found = p; break; }
  }
  const w = found ? Number(found.rect?.width) : NaN;
  const h = found ? Number(found.rect?.height) : NaN;
  if (Number.isFinite(w) && Number.isFinite(h) && w >= 160 && w >= 2 * h) return 'right';
  return 'down';
}

// ui_focused_pane() port: the pane the TUI keyboard is in, across
// workspaces; '' when none is focused or herdr/JSON fails. `focused` must
// be the boolean true (jq `.focused == true`).
export function uiFocusedPane(env = process.env) {
  const r = runCli('herdr', ['pane', 'list'], { env, timeoutMs: HERDR_TIMEOUT_MS });
  let doc;
  try { doc = JSON.parse(r.stdout ?? ''); } catch { return ''; }
  const panes = doc && typeof doc === 'object' ? doc?.result?.panes : undefined;
  if (!Array.isArray(panes)) return '';
  for (const p of panes) {
    if (!p || typeof p !== 'object') continue;
    if (p.focused === true) return p.pane_id === undefined || p.pane_id === null ? '' : String(p.pane_id);
  }
  return '';
}

// restore_focus_if_stolen() port: undo a focus steal back to `prev`, and
// only while the keyboard is still on `stolen` (a different focused pane
// means the user moved — leave it). A caller shell has no agent name:
// step back across the split just made (right → left, down → up); a
// non-caller shell is not chased with a directional focus.
export function restoreFocusIfStolen(prev, stolen, dir = '', env = process.env) {
  if (prev === '' || stolen === '' || prev === stolen) return;
  if (uiFocusedPane(env) !== stolen) return;
  if (agentFocus(prev, env)) return;
  if (prev !== (env.HERDR_PANE_ID ?? '')) return;
  let back = '';
  if (dir === 'right') back = 'left';
  else if (dir === 'down') back = 'up';
  else return;
  paneFocusBack(back, stolen, env);
}

// pick_split_anchor() port: the split anchor for the caller's tab — the
// largest pane of caller + roster workers, `overflow` when the tab is
// full or no pane can be halved. No usable layout (herdr failed or
// unparseable) → the caller pane split `right`, like bash.
export function pickSplitAnchor(ctx, env = process.env, cwd = process.cwd()) {
  const me = env.HERDR_PANE_ID ?? '';
  const r = paneLayout(env);
  const layout = r.stdout ?? '';
  if (layout === '') return { anchor: me, direction: 'right' };
  let doc;
  try { doc = JSON.parse(layout); } catch { return { anchor: me, direction: 'right' }; }
  const sd = stateDir(ctx, env, cwd);
  const mine = [];
  for (const line of rosterRows(sd)) {
    const pane = line.split('\t')[1] ?? '';
    if (pane !== '' && !mine.includes(pane)) mine.push(pane);
  }
  const out = splitAnchorFromLayout(doc, me, mine, splitCap(ctx, env), splitMin(ctx, env));
  return out === null ? { anchor: me, direction: 'right' } : out;
}

// cmd_layout_plan() port: explain the next split placement. With
// `--layout FILE|-` the saved document is evaluated (no Herdr needed);
// otherwise the live layout plus the roster's worker panes. Same compact
// JSON, same key order (placement, anchor, direction, reason, cap,
// min_pane, candidates, grid) and same numbers as the bash jq pipeline.
export function cmdLayoutPlan(argv, ctx, env = process.env, cwd = process.cwd()) {
  let file = '';
  let me = env.HERDR_PANE_ID ?? '';
  let mine = '';
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--layout' || a === '--me' || a === '--mine') {
      const v = argv[i + 1];
      if (v === undefined) die(`layout-plan: ${a} expects a value`, 2);
      if (a === '--layout') file = v;
      else if (a === '--me') me = v;
      else mine = v;
      i += 1;
    } else {
      die(`layout-plan: unknown option ${a}`, 2);
    }
  }
  let layoutText;
  if (file !== '') {
    if (file === '-') {
      layoutText = fs.readFileSync(0, 'utf8');
    } else {
      try {
        layoutText = fs.readFileSync(file, 'utf8');
      } catch (e) {
        // bash `layout="$(cat "$file")" || die` — cat's own stderr line
        // reaches the user before the die message; reproduce it.
        const catErr = e.code === 'ENOENT' ? 'No such file or directory'
          : e.code === 'EACCES' ? 'Permission denied'
          : e.code === 'EISDIR' ? 'Is a directory'
          : String(e.message);
        process.stderr.write(`cat: ${file}: ${catErr}\n`);
        die(`layout-plan: cannot read ${file}`, 2);
      }
    }
  } else {
    requireEnv(env);
    const r = paneLayout(env);
    if (r.notFound || r.status !== 0) die('pane layout failed', 4);
    layoutText = r.stdout ?? '';
    if (mine === '') {
      const sd = stateDir(ctx, env, cwd);
      const ids = [];
      for (const line of rosterRows(sd)) {
        const pane = line.split('\t')[1] ?? '';
        if (pane !== '') ids.push(pane);
      }
      mine = ids.join(' ');
    }
  }
  // Invalid JSON: bash lets jq fail mid-pipeline (rc 5, jq's own error);
  // the port reports it (decision: 2 for a --layout document, 4 for a live
  // `pane layout` answer).
  let doc;
  try { doc = JSON.parse(layoutText); } catch {
    if (file !== '') die(`layout-plan: ${file === '-' ? 'stdin' : file} is not a pane layout JSON document`, 2);
    die('pane layout failed', 4);
  }
  const mineArr = mine === '' ? [] : mine.split(/\s+/).filter((s) => s !== '');
  const cap = splitCap(ctx, env);
  const min = splitMin(ctx, env);
  const res = splitAnchorFromLayout(doc, me, mineArr, cap, min);
  let anchor;
  let dir;
  if (res === null) { anchor = me; dir = 'right'; }
  else if (res.overflow !== undefined) { anchor = 'overflow'; dir = res.overflow; }
  else { anchor = res.anchor; dir = res.direction; }
  const parts = layoutParts(doc);
  const cands = [];
  if (parts) {
    for (const p of parts.panes) {
      if (!p || typeof p !== 'object') continue;
      const id = p.pane_id;
      if (typeof id !== 'string' || (id !== me && !mineArr.includes(id))) continue;
      const r = p.rect ?? {};
      const w = Math.round((Number(r.width) / parts.area.width) * 1000) / 1000;
      const h = Math.round((Number(r.height) / parts.area.height) * 1000) / 1000;
      if (!Number.isFinite(w) || !Number.isFinite(h)) continue; // jq would fail here
      cands.push({ pane_id: id, caller: id === me, width: w, height: h });
    }
  }
  const placement = anchor === 'overflow' ? 'herd' : 'split';
  const plan = {
    placement,
    anchor: anchor === 'overflow' ? null : anchor,
    direction: anchor === 'overflow' ? null : dir,
    reason: anchor === 'overflow' ? dir : 'largest-area',
    cap,
    min_pane: min,
    candidates: cands,
  };
  if (placement === 'split') {
    const n = cands.length + 1;
    const g = gridSizes(n);
    plan.grid = { cells: n, cols: g.cols, rows_per_col: g.rows };
  } else {
    plan.grid = null;
  }
  process.stdout.write(`${JSON.stringify(plan)}\n`);
}
