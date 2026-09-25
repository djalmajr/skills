// Lanes (bash port): presets and custom lanes, the layer rules for
// lane kind/model/effort, the reuse decision, the worker cap, and the
// lane-file rewrite (migrate / drop / apply). Port of
// the original bash implementation :846-1029 (lanes_enabled … lane_decide),
// :1230-1449 (signatures, config_drop_legacy, migrate_lane_attr,
// apply_lane_file) and :1476-1515 (setup_lane_spec, max_workers,
// enforce_worker_cap).
//
// Faithful-port notes:
//   - laneNames sorts and dedups like `sort -u` in the C locale (code-unit
//     order) and only includes lanes whose EFFECTIVE lane.<name>.roles is
//     non-empty (an empty lane.x.roles= does not count).
//   - A lane name is the normalized key middle, exactly as bash extracts
//     it (lane.ui-review.roles → lane ui_review; the env var
//     HERDR_AGENTS_LANE_UI-REVIEW_ROLES → lane ui-review).
//   - panesValue accepts 2, 3 or 4, anything else is 4.
//   - The presets are per (pane count, pane_mode) pair: strict (panes 2:
//     build; 3/4: build+review; the documenter joins the build lane) and
//     flex (always build+review+docs; the docs lane and, at panes=2, the
//     review lane hold capacity 0 — a temporary worker only). A lane holds
//     a CAPACITY of workers (lane.<name>.panes, the build lane of the
//     4-pane preset has 2), and laneDecide consults every worker of the
//     lane instead of one. LEGACY_PRESETS keeps the old preset table for
//     the migration (doctor/setup).
//   - applyLaneFile treats an empty / new-preset / old-preset
//     lane.*.roles signature as a preset file and stops freezing roles
//     and limits in it (no lane.<l>.roles, no lane.<l>.panes, no
//     max_workers, no split_max_panes written; the old read/explore
//     lane attrs are moved to review / dropped); a custom file aligns
//     max_workers to the sum of the lane capacities.
//   - Errors are DieError exceptions with the bash message and code
//     (2 = bad --lane spec, 8 = worker cap, 4 = rewrite left the file
//     untouched); nothing here calls process.exit.
import fs from 'node:fs';
import { cfg, cfgSource, KNOWN_KINDS, EFFORT_LADDER, DieError, fileKeyValue, configWritePair, loadConfig } from './config.mjs';
import { hasWord } from './text.mjs';
import { stateDir, rosterRows, lastReport, warn } from './state.mjs';
import { agentState, liveAgents } from './herdr.mjs';
import { roleFile, fmGet, isReviewRole, roleIsEdit, historyHasEdit } from './roles.mjs';
import { readTextFile, atomicWrite } from './platform.mjs';

// Lines of a normalized text (awk-style trailing-newline semantics).
function splitLines(text) {
  if (text === '') return [];
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

// ---------- enabled / panes / presets (:846-895) ----------

// config_explicit <k> (:846): the effective value came from a user layer
// (user|project|env|session), not from defaults/builtin.
export function configExplicit(ctx, key, env = process.env) {
  return ['user', 'project', 'env', 'session'].includes(cfgSource(ctx, key, env));
}

// lanes_enabled (:853): lanes=off turns lanes off.
export function lanesEnabled(ctx, env = process.env) {
  return cfg(ctx, 'lanes', 'on', env) !== 'off';
}

// panes_value: 2|3|4 (pane count, counting the orchestrator), anything
// else 4.
export function panesValue(ctx, env = process.env) {
  const p = cfg(ctx, 'panes', '4', env);
  return p === '2' || p === '3' || p === '4' ? p : '4';
}

// pane_mode: strict|flex, default strict. At run time anything but
// 'flex' resolves to strict (the doctor reports the raw value).
export function paneMode(ctx, env = process.env) {
  return cfg(ctx, 'pane_mode', 'strict', env) === 'flex' ? 'flex' : 'strict';
}

// flex_extra: the temporary panels the flex mode may open beyond the lane
// capacities (integer ≥ 0, default 1; an invalid value falls back to the
// default, like the other derived caps).
export function flexExtra(ctx, env = process.env) {
  const v = cfg(ctx, 'flex_extra', '1', env);
  return /^[0-9]+$/.test(v) ? Number(v) : 1;
}

// lane_key <name> <attr> (:867): lane.<name>.<attr> as a normalized key,
// with '-' → '_'.
export function laneKey(name, attr) {
  return `lane_${String(name).replace(/-/g, '_')}_${attr}`;
}

// The old presets (panes=3: build|read; panes=4: build|explore|review),
// kept ONLY for the migration (doctor/setup); nothing else reads it.
export const LEGACY_PRESETS = {
  '3': { build: 'implementer,designer,tasker', read: 'scouter,researcher,reviewer,security-reviewer,ui-reviewer,inspector' },
  '4': { build: 'implementer,designer,tasker', explore: 'scouter,researcher', review: 'reviewer,security-reviewer,ui-reviewer,inspector' },
};

// preset_lane_names_for: the preset lanes of the (panes, mode) pair —
// strict: panes=2 → build; panes=3 and 4 → build review. flex: always
// build review docs (the docs lane and, at panes=2, the review lane hold
// no resident worker: capacity 0, temporary workers only).
export function presetLaneNamesFor(p, mode = 'strict') {
  if (mode === 'flex') return ['build', 'review', 'docs'];
  return p === '2' ? ['build'] : ['build', 'review'];
}

// preset_lane_names: the preset for the effective panes value and mode.
export function presetLaneNames(ctx, env = process.env) {
  return presetLaneNamesFor(panesValue(ctx, env), paneMode(ctx, env));
}

// preset_lane_count: the preset lane count of the (panes, mode) pair.
export function presetLaneCount(p, mode = 'strict') {
  return presetLaneNamesFor(p, mode).length;
}

// preset_lane_roles <lane> <panes> [mode]: exploration goes to the
// builders (the build lane carries scouter/researcher in every preset).
// The documenter joins the build lane in strict (it borrows a build
// slot) and owns the capacity-0 docs lane in flex. The review lane
// disappears at panes=2 in strict, where the orchestrator reviews; in
// flex it stays at capacity 0 (a temporary reviewer only).
export function presetLaneRoles(lane, p, mode = 'strict') {
  if (mode === 'flex') {
    switch (lane) {
      case 'build': return 'implementer,designer,tasker,scouter,researcher';
      case 'review': return 'reviewer,security-reviewer,ui-reviewer,inspector';
      case 'docs': return 'documenter';
      default: return '';
    }
  }
  switch (`${p}:${lane}`) {
    case '4:build':
    case '3:build':
    case '2:build': return 'implementer,designer,tasker,scouter,researcher,documenter';
    case '4:review':
    case '3:review': return 'reviewer,security-reviewer,ui-reviewer,inspector';
    default: return '';
  }
}

// preset_lane_capacity <lane> <panes> [mode]: only the build lane of the
// 4-pane preset holds more than one worker (2); the flex capacity-0
// lanes (docs, and review at panes=2) hold a temporary worker only;
// every other preset lane holds 1. The review lanes are 1 because a
// review must not sit on a worker that edited.
export function presetLaneCapacity(lane, p, mode = 'strict') {
  if (mode === 'flex') {
    if (lane === 'build') return p === '4' ? 2 : 1;
    if (lane === 'docs') return 0;
    if (lane === 'review') return p === '2' ? 0 : 1;
    return 1;
  }
  if (p === '4' && lane === 'build') return 2;
  return 1;
}

// preset_roles_flat <panes> [mode]: every preset role, one CSV.
export function presetRolesFlat(p, mode = 'strict') {
  return presetLaneNamesFor(p, mode)
    .map((lane) => presetLaneRoles(lane, p, mode))
    .filter((r) => r !== '')
    .join(',');
}

// legacy_preset_signature <panes>: the old preset's lane roles as
// sorted `lane=roles` lines — the same shape as presetSignature, kept
// ONLY for the migration (the doctor old-preset warn and the
// applyLaneFile preset test); nothing else reads it.
export function legacyPresetSignature(p) {
  const table = LEGACY_PRESETS[p];
  if (!table) return '';
  return Object.entries(table).map(([lane, roles]) => `${lane}=${roles}`).sort().join('\n');
}

// ---------- custom lanes (:906-938) ----------

// The env branch of custom_lanes_present / lane_names only sees names a
// shell can hold — bash `compgen -v` never lists hyphenated env vars, so
// they stay invisible here as well.
const SHELL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// custom_lanes_present (:906): any effective lane.<name>.roles in a config
// layer or in the HERDR_AGENTS_LANE_*_ROLES environment. The env branch
// only sees names a shell can hold — bash `compgen -v` never lists
// hyphenated env vars, so they stay invisible here as well.
export function customLanesPresent(ctx, env = process.env) {
  for (const k of ctx.entries.keys()) {
    if (/^lane_(.*)_roles$/.test(k) && cfg(ctx, k, '', env) !== '') return true;
  }
  for (const [k, v] of Object.entries(env)) {
    if (SHELL_NAME_RE.test(k) && /^HERDR_AGENTS_LANE_(.*)_ROLES$/.test(k) && v) return true;
  }
  return false;
}

// lane_names (:924): the preset lanes, or — when any layer defines a
// lane.<name>.roles — the custom lane names derived from the key
// (CFG middle as stored, env middle lowercased), kept only when the
// effective lane.<name>.roles is non-empty, sorted and deduped like
// `sort -u` in the C locale. A hyphen only reaches a lane name through
// the env branch (bash compgen -v lists only valid shell names, so a
// hyphenated env var is invisible — the file key middle is normalized
// and never carries one: lane.ui-review.roles → lane ui_review).
export function laneNames(ctx, env = process.env) {
  if (!customLanesPresent(ctx, env)) return presetLaneNamesFor(panesValue(ctx, env), paneMode(ctx, env));
  const names = new Set();
  for (const k of ctx.entries.keys()) {
    const m = k.match(/^lane_(.*)_roles$/);
    if (!m) continue;
    const name = m[1];
    // `lane..roles`: bash prints an empty name that nothing counts.
    if (name !== '' && cfg(ctx, laneKey(name, 'roles'), '', env) !== '') names.add(name);
  }
  for (const [k, v] of Object.entries(env)) {
    if (!SHELL_NAME_RE.test(k)) continue; // compgen -v never lists it
    const m = k.match(/^HERDR_AGENTS_LANE_(.*)_ROLES$/);
    if (!m || !v) continue;
    const name = m[1].toLowerCase();
    if (cfg(ctx, laneKey(name, 'roles'), '', env) !== '') names.add(name);
  }
  return [...names].sort();
}

// lane_count: number of lanes.
export function laneCount(ctx, env = process.env) {
  return laneNames(ctx, env).length;
}

// lane_roles_csv <lane>: the effective lane.<name>.roles (custom) or the
// preset roles of the effective (panes, mode) pair.
export function laneRolesCsv(ctx, lane, env = process.env) {
  if (customLanesPresent(ctx, env)) return cfg(ctx, laneKey(lane, 'roles'), '', env);
  return presetLaneRoles(lane, panesValue(ctx, env), paneMode(ctx, env));
}

// lane_capacity <lane>: the number of workers the lane may hold.
// The effective lane.<name>.panes when defined and valid (integer ≥ 1);
// else the preset capacity of the effective (panes, mode) pair when no
// custom lane exists (a capacity-0 lane holds a temporary worker only);
// else 1 (a custom lane is one worker unless it sets lane.<name>.panes).
export function laneCapacity(ctx, lane, env = process.env) {
  const v = cfg(ctx, laneKey(lane, 'panes'), '', env);
  if (/^[1-9][0-9]*$/.test(v)) return Number(v);
  if (!customLanesPresent(ctx, env)) return presetLaneCapacity(lane, panesValue(ctx, env), paneMode(ctx, env));
  return 1;
}

// lane_capacity_sum <ctx> <env>: the sum of the capacities of the
// effective lanes (the max_workers a file aligns to when the preset
// derives it — panes 4 → 3, panes 3 → 2, panes 2 → 1).
export function laneCapacitySum(ctx, env = process.env) {
  return laneNames(ctx, env).reduce((sum, lane) => sum + laneCapacity(ctx, lane, env), 0);
}

// effective_lane_signature <ctx> <env>: the effective lane.<n>.roles as
// sorted `n=roles` lines ('' when none) — the same shape as
// fileLaneSignature, but over every config layer plus the env lanes
// (the doctor old-preset detector; the file signature reads one file).
export function effectiveLaneSignature(ctx, env = process.env) {
  const vals = new Map();
  for (const k of ctx.entries.keys()) {
    const m = k.match(/^lane_(.*)_roles$/);
    if (!m || m[1] === '') continue;
    const v = cfg(ctx, k, '', env);
    if (v !== '') vals.set(m[1], v);
  }
  for (const [k, v] of Object.entries(env)) {
    if (!SHELL_NAME_RE.test(k) || !v) continue; // compgen -v never lists it
    const m = k.match(/^HERDR_AGENTS_LANE_(.*)_ROLES$/);
    if (!m) continue;
    const name = m[1].toLowerCase();
    const val = cfg(ctx, laneKey(name, 'roles'), '', env);
    if (val !== '') vals.set(name, val);
  }
  return [...vals].map(([lane, roles]) => `${lane}=${roles}`).sort().join('\n');
}

// ---------- layer rules (:940-1000) ----------

// cfg_layer_rank <key>: env=4 > session=3 > project=2 > user=1 >
// defaults/builtin=0. Flag callers pass 5 themselves.
export function cfgLayerRank(ctx, key, env = process.env) {
  switch (cfgSource(ctx, key, env)) {
    case 'env': return 4;
    case 'session': return 3;
    case 'project': return 2;
    case 'user': return 1;
    default: return 0;
  }
}

// lane_kind_layer <lane>: the rank of the effective lane.<l>.kind, or -1
// when no config layer sets one (role config/frontmatter may still decide).
export function laneKindLayer(ctx, lane, env = process.env) {
  const key = laneKey(lane, 'kind');
  if (cfg(ctx, key, '', env) === '') return -1;
  return cfgLayerRank(ctx, key, env);
}

// lane_attr <lane> <attr> [kind-layer]: the cfg value for the lane key.
// model|effort only belong to the kind the lane resolves to: a value from
// a layer below the effective lane kind is ignored ('' — resolution
// continues with the next source). kindLayer is the layer rank of the kind
// in effect (cfg_layer_rank; 5 = the --kind flag); when omitted, the
// effective lane.<lane>.kind layer is used (-1 skips the check).
export function laneAttr(ctx, lane, attr, kindLayer = null, env = process.env) {
  if (kindLayer === null || kindLayer === undefined) kindLayer = laneKindLayer(ctx, lane, env);
  const key = laneKey(lane, attr);
  const val = cfg(ctx, key, '', env);
  if (val === '') return '';
  if (attr === 'model' || attr === 'effort') {
    if (kindLayer >= 0) {
      const ar = cfgLayerRank(ctx, key, env);
      if (ar < kindLayer) return '';
    }
  }
  return val;
}

// spawn_kind_layer <role> <lane> <kind-flag-set>: the layer rank of the
// kind a spawn uses, the reference for the lane model/effort rule: 5 for
// --kind, else the layer of lane.<lane>.kind, else of role.<role>.kind,
// else 0 (the role frontmatter, the lowest layer — any configured lane
// model/effort applies then). Spawn and its reuse check use the same value.
export function spawnKindLayer(ctx, role, lane, kindFlagSet, env = process.env) {
  if (kindFlagSet) return 5;
  if (lane && cfg(ctx, laneKey(lane, 'kind'), '', env) !== '') {
    return cfgLayerRank(ctx, laneKey(lane, 'kind'), env);
  }
  const roleKey = `role_${String(role).replace(/-/g, '_')}_kind`;
  if (cfg(ctx, roleKey, '', env) !== '') return cfgLayerRank(ctx, roleKey, env);
  return 0;
}

// splitRoles <csv>: the roles of a lane list. Bash turns commas into spaces
// and word-splits (`tr ',' ' '`, `${csv//,/ }`), so a comma, a space, a
// tab or a newline all separate roles.
export function splitRoles(csv) {
  return String(csv).split(/[,\s]+/).filter((s) => s !== '');
}

// lane_of_role <role> (:1001): the first lane (in lane_names order) whose
// roles include the role; '' when none.
export function laneOfRole(ctx, role, env = process.env) {
  for (const lane of laneNames(ctx, env)) {
    const roles = splitRoles(laneRolesCsv(ctx, lane, env));
    if (roles.includes(role)) return lane;
  }
  return '';
}

// ---------- spawn decision in a lane (:1009-1055, multi-worker) ----------

// lane_workers <lane>: every roster row that belongs to the lane,
// in roster order: column 12 equal to the lane, or — rows without a lane
// column — named as the lane (a lane column, when present, always wins
// over the name).
export function laneWorkers(sd, lane) {
  const out = [];
  for (const line of rosterRows(sd)) {
    if (!line) continue;
    const f = line.split('\t');
    const name = f[0] ?? '';
    const laneCol = f.length >= 12 ? (f[11] ?? '') : '';
    if (laneCol === lane || (laneCol === '' && name === lane)) out.push(line);
  }
  return out;
}

// A recorded report path pointing at an absent or empty file is
// pending (bash: `[ -n "$rep" ] && [ ! -s "$rep" ]`).
function reportPending(sd, name) {
  const rep = lastReport(sd, name);
  if (rep === '') return false;
  try { return fs.statSync(rep).size === 0; } catch { return true; }
}

// lane_decide <lane> <role> (replaces the single-worker decision):
// consults EVERY worker of the lane, in roster order, and decides with the
// lane capacity:
//   gone        → never counted (the caller removes the row + today's
//                 warning); listed in `gone`;
//   unavailable → recorded (the first one; never spawns a replacement);
//   locked      → idle/done that may not take the requested review role
//                 (the worker edited: current or history);
//   candidate   → idle/done without a pending report (and not locked);
//   occupied    → anything else (working, blocked, pending report, unknown).
// Result, in priority order:
//   1. a candidate and reuse is on  → 'reuse' (the FIRST candidate; the
//      kind-mismatch / exit 13 checks stay in the caller);
//   2. an unavailable               → 'unavailable' (exit 4 in the caller);
//   3. live workers (not gone) < capacity → 'open' (a new worker fits);
//   4. every live worker locked     → 'locked' (exit 5 in the caller);
//   5. otherwise                    → 'busy' (exit 10: `name` is the first
//      occupied worker and `occupants` lists every live one for the full
//      warning).
// 'absent' when the lane has no worker row at all. With reuse off
// (--fresh) a candidate never fires priority 1; `candidate` still names
// the first idle one so the caller can keep today's --fresh message when
// the lane is full. Two nearly simultaneous decisions read the same
// roster before any `agent start` lands: nothing reserves a slot, so two
// spawns can pass the lane capacity (and max_workers) by one — the
// accepted limitation.
export function laneDecide(ctx, lane, role, env = process.env, cwd = process.cwd(), reuseOn = true) {
  const sd = stateDir(ctx, env, cwd);
  const capacity = laneCapacity(ctx, lane, env);
  const rows = laneWorkers(sd, lane);
  const gone = [];
  const occupants = [];
  let unavailable = null;
  let candidate = '';
  let firstLocked = '';
  let lockedCount = 0;
  let name = '';
  let state = '';
  for (const line of rows) {
    const f = line.split('\t');
    const nm = f[0] ?? '';
    const st = agentState(nm, env);
    const wstate = st.state;
    if (wstate === 'gone') { gone.push(nm); continue; }
    occupants.push(nm);
    if (wstate === 'unavailable') { if (unavailable === null) unavailable = { name: nm, cause: st.cause }; continue; }
    if (wstate === 'idle' || wstate === 'done') {
      if (reportPending(sd, nm)) { if (name === '') { name = nm; state = 'pending-report'; } continue; }
      const cur = f[3] ?? '';
      const hist = f.length >= 11 ? (f[10] ?? '') : '';
      if (isReviewRole(role) && (roleIsEdit(cur, env, cwd) || historyHasEdit(hist, env, cwd))) {
        if (firstLocked === '') firstLocked = nm;
        lockedCount += 1;
        continue;
      }
      if (candidate === '') candidate = nm;
      continue;
    }
    if (name === '') { name = nm; state = wstate || 'unknown'; }
  }
  const base = { gone, capacity, n: occupants.length, occupants, candidate };
  if (rows.length === 0) return { decision: 'absent', name: '', state: '', cause: '', ...base };
  if (candidate !== '' && reuseOn) return { decision: 'reuse', name: candidate, state: '', cause: '', ...base };
  if (unavailable !== null) return { decision: 'unavailable', name: unavailable.name, state: '', cause: unavailable.cause, ...base };
  if (occupants.length < capacity) return { decision: 'open', name: '', state: '', cause: '', ...base };
  if (lockedCount > 0 && lockedCount === occupants.length) {
    return { decision: 'locked', name: firstLocked, state: '', cause: '', ...base };
  }
  return { decision: 'busy', name, state, cause: '', ...base };
}

// ---------- --lane spec validation (:1476-1491) ----------

// setup_lane_spec <name=kind[:model[:effort]]> → { name, kind, model,
// effort }. Same messages and code 2 for every rejection.
export function setupLaneSpec(spec) {
  const s = String(spec);
  const i = s.indexOf('=');
  if (i === -1) throw new DieError('setup: --lane expects name=kind[:model[:effort]]', 2);
  const name = s.slice(0, i);
  const rest = s.slice(i + 1).split('\n')[0]; // `read` takes one line
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw new DieError(`setup: invalid lane name '${name}'`, 2);
  // IFS=':' read -r kind model effort extra: the last field keeps the rest,
  // minus the trailing ':' delimiters (`x=k:m:e::` is accepted, `x=k:m:e:f:`
  // is not).
  const parts = rest.split(':');
  const kind = parts[0] ?? '';
  const model = parts[1] ?? '';
  const effort = parts[2] ?? '';
  const extra = parts.slice(3).join(':').replace(/:+$/, '');
  if (extra !== '') throw new DieError(`setup: --lane '${s}' has too many ':' fields`, 2);
  if (kind === '') throw new DieError(`setup: --lane '${s}' needs a kind`, 2);
  if (!hasWord(KNOWN_KINDS.join(' '), kind)) throw new DieError(`setup: unknown kind '${kind}'`, 2);
  if (effort !== '' && !hasWord(EFFORT_LADDER.join(' '), effort)) throw new DieError(`setup: invalid effort '${effort}'`, 2);
  if ((kind + model + effort).includes('#')) throw new DieError('setup: --lane value cannot contain #', 2);
  return { name, kind, model, effort };
}

// ---------- worker cap (:1505-1515) ----------

// max_workers: validated cap on live workers (the orchestrator does not
// count). With lanes on and no explicit max_workers (user/project/env/
// session), the cap is the SUM of the lane capacities (panes 4 → 3,
// panes 3 → 2, panes 2 → 1) plus flex_extra in the flex mode (the
// temporary panels); otherwise the value when it is an integer
// ≥ 0, else 3.
export function maxWorkers(ctx, env = process.env) {
  if (lanesEnabled(ctx, env) && !configExplicit(ctx, 'max_workers', env)) {
    let total = laneNames(ctx, env).reduce((sum, lane) => sum + laneCapacity(ctx, lane, env), 0);
    if (paneMode(ctx, env) === 'flex') total += flexExtra(ctx, env);
    return String(total);
  }
  const v = cfg(ctx, 'max_workers', '3', env);
  return /^[0-9]+$/.test(v) ? v : '3';
}

// live_worker_names: roster workers whose agent (by name or pane) is
// still live in `herdr agent list`.
export function liveWorkerNames(sd, env = process.env) {
  const live = liveAgents(env);
  const out = [];
  for (const line of rosterRows(sd)) {
    const f = line.split('\t');
    const name = f[0] ?? '';
    if (!name) continue;
    const pane = f[1] ?? '';
    if (live.some((a) => a && ((a.name ?? '') === name || a.pane_id === pane))) out.push(name);
  }
  return out;
}

// live_burst_workers: roster workers marked temporary (roster column 13
// `burst`) whose agent (by name or pane) is still live — the temporary
// workers that already sit in the extra panels (rows without the column
// are not temporary).
export function liveBurstWorkers(sd, env = process.env) {
  const live = liveAgents(env);
  const out = [];
  for (const line of rosterRows(sd)) {
    const f = line.split('\t');
    const name = f[0] ?? '';
    if (!name || (f[12] ?? '') !== 'burst') continue;
    const pane = f[1] ?? '';
    if (live.some((a) => a && ((a.name ?? '') === name || a.pane_id === pane))) out.push(name);
  }
  return out;
}

// enforce_worker_cap: refuse a new worker (DieError 8) once max_workers
// are live. Reusing an idle worker never reaches this check.
export function enforceWorkerCap(ctx, env = process.env, cwd = process.cwd()) {
  const capStr = maxWorkers(ctx, env);
  const cap = Number(capStr);
  if (cap <= 0) return;
  const sd = stateDir(ctx, env, cwd);
  const names = liveWorkerNames(sd, env);
  if (names.length < cap) return;
  throw new DieError(
    `max_workers=${capStr} reached (${names.length} live: ${names.join(' ')}). ` +
    'Release a finished worker (release <name> --close), let spawn reuse an idle one of ' +
    'the same role (reuse_workers=on / --reuse), or raise max_workers.',
    8,
  );
}

// ---------- lane-file rewrite (:1230-1449) ----------

// file_lane_signature <file>: the lane.<n>.roles lines as sorted
// `n=roles` lines ('' when none).
export function fileLaneSignature(file) {
  let raw;
  try { raw = readTextFile(file); } catch { return ''; }
  const lines = [];
  for (const rawLine of splitLines(raw)) {
    let body = rawLine;
    const m = body.match(/[ \t]#.*$/);
    if (m) body = body.slice(0, m.index);
    const stripped = body.trim();
    if (stripped === '' || stripped.startsWith('#')) continue;
    const eq = stripped.indexOf('=');
    if (eq === -1) continue;
    const k = stripped.slice(0, eq).trim();
    if (/^lane\.[A-Za-z0-9_-]+\.roles$/.test(k)) {
      lines.push(`${k.slice(5, k.length - 6)}=${stripped.slice(eq + 1).trim()}`);
    }
  }
  lines.sort();
  return lines.join('\n');
}

// preset_signature <panes> [mode]: the preset lanes' roles of the
// (panes, mode) pair, the same shape.
export function presetSignature(p, mode = 'strict') {
  const lines = presetLaneNamesFor(p, mode).map((lane) => `${lane}=${presetLaneRoles(lane, p, mode)}`);
  lines.sort();
  return lines.join('\n');
}

// file_laned_roles <file>: every lane.<n>.roles value, one CSV.
export function fileLanedRoles(file) {
  const sig = fileLaneSignature(file);
  if (sig === '') return '';
  return sig.split('\n').map((l) => l.slice(l.indexOf('=') + 1)).join(',');
}

// file_lane_count <file>: number of lane.<n>.roles lines.
export function fileLaneCount(file) {
  const sig = fileLaneSignature(file);
  return sig === '' ? 0 : sig.split('\n').length;
}

// config_drop_legacy <dest> { dropKind, dropModel, dropLanes } (:1286):
// drop role.planner.*, the per-role kind/model keys of the named roles,
// and (optionally) every lane.*.roles line. Full-line comments stay.
// The lists arrive as parameters (decision 8, not HA_* env vars) and the
// rewrite is atomicWrite; DieError 4, file untouched, on failure.
export function configDropLegacy(dest, { dropKind = [], dropModel = [], dropLanes = false } = {}) {
  let raw;
  try { raw = readTextFile(dest); } catch { throw new DieError(`could not rewrite ${dest} (file left untouched)`, 4); }
  const kindSet = new Set(dropKind);
  const modelSet = new Set(dropModel);
  const out = [];
  for (const rawLine of splitLines(raw)) {
    let body = rawLine;
    const m = body.match(/[ \t]#.*$/);
    if (m) body = body.slice(0, m.index);
    const stripped = body.trim();
    if (stripped === '' || stripped.startsWith('#')) { out.push(rawLine); continue; }
    const eq = stripped.indexOf('=');
    if (eq === -1) { out.push(rawLine); continue; }
    const k = stripped.slice(0, eq).trim();
    if (/^role\.planner\./.test(k)) continue;
    if (/^role\.[A-Za-z0-9_-]+\.kind$/.test(k) && kindSet.has(k.slice(5, k.length - 5))) continue;
    if (/^role\.[A-Za-z0-9_-]+\.model$/.test(k) && modelSet.has(k.slice(5, k.length - 6))) continue;
    if (dropLanes && /^lane\.[A-Za-z0-9_-]+\.roles$/.test(k)) continue;
    out.push(rawLine);
  }
  try {
    atomicWrite(dest, out.length ? out.join('\n') + '\n' : '');
  } catch {
    throw new DieError(`could not rewrite ${dest} (file left untouched)`, 4);
  }
}

// file_role_resolved <file> <role> <kind|model>: the value in that file,
// else the frontmatter value ('' when neither).
export function fileRoleResolved(dest, role, attr, env = process.env, cwd = process.cwd()) {
  let v = fileKeyValue(dest, `role.${role}.${attr}`);
  if (v === '') {
    const f = roleFile(role, env, cwd);
    if (f) v = fmGet(f, attr);
  }
  return v;
}

// migrate_lane_attr <dest> <lane> <roles-csv> <kind|model> (:1338):
// unanimous non-empty value → write lane.<name>.<attr> (recorded in
// acc.lines as the `set lane.<l>.<attr>=<v>` line) and remember the roles
// so the caller can drop their role.* keys (acc.dropKind / acc.dropModel,
// the bash dynamic-scope accumulation). Disagreement → keep the keys and
// warn. An empty consensus writes nothing. A lane.<name>.<attr> already
// in the file is left as the user set it, and the per-role keys are
// dropped. acc = { dropKind: [], dropModel: [], lines: [] }.
export function migrateLaneAttr(dest, lane, rolesCsv, attr, acc, env = process.env, cwd = process.cwd()) {
  const existing = fileKeyValue(dest, `lane.${lane}.${attr}`);
  const laneKind = fileKeyValue(dest, `lane.${lane}.kind`);
  let first = '';
  let have = false;
  let agree = true;
  const list = [];
  for (const r of splitRoles(rolesCsv)) {
    if (r === 'planner') continue;
    // The documenter borrows a build slot in strict but its kind never
    // votes on the lane's (its own kind is configured per role, or via
    // the docs lane in the flex mode).
    if (r === 'documenter') continue;
    if (existing !== '') {
      (attr === 'kind' ? acc.dropKind : acc.dropModel).push(r);
      continue;
    }
    let val = '';
    if (attr === 'model') {
      // A lane model only makes sense for a lane with one CLI
      // (lane.*.kind). A role.*.model in the file always votes; a
      // frontmatter model votes only when its frontmatter kind is the
      // lane kind; an empty model does not vote.
      if (laneKind === '') return;
      val = fileKeyValue(dest, `role.${r}.model`);
      if (val === '') {
        const rf = roleFile(r, env, cwd);
        if (rf && fmGet(rf, 'kind') === laneKind) val = fmGet(rf, 'model');
      }
      if (val === '') continue;
    } else {
      val = fileRoleResolved(dest, r, attr, env, cwd);
    }
    list.push(`${r}=${val}`);
    if (!have) { first = val; have = true; }
    else if (val !== first) agree = false;
  }
  if (existing !== '') return;
  if (!have) return;
  if (agree && first !== '') {
    configWritePair(dest, `lane.${lane}.${attr}`, first, env);
    acc.lines.push(`set lane.${lane}.${attr}=${first}`);
    for (const r of splitRoles(rolesCsv)) {
      if (r === 'planner') continue;
      if (r === 'documenter') continue; // its role.<r>.* keys stay
      (attr === 'kind' ? acc.dropKind : acc.dropModel).push(r);
    }
    return;
  }
  if (!agree) {
    warn(`lane '${lane}' ${attr}s differ (${list.join(' ')}). Left the role.*.${attr} keys in place. Orchestrator: ask the user which ${attr} this lane should use, then run 'setup --lane ${lane}=<kind>[:<model>[:<effort>]]'.`);
  }
}

// The attrs of a lane key as written in the file (`lane.<l>.<attr>`,
// dotted form, the attrs the config validator accepts besides
// roles) or null.
const LANE_ATTR_RE = /^lane\.([A-Za-z0-9_-]+)\.(kind|model|effort|approvals|panes|args)$/;
const LANE_ROLES_RE = /^lane\.[A-Za-z0-9_-]+\.roles$/;

// file_key_present <file> <key>: the exact trimmed key has a line in the
// file — even an empty `key=` assignment (fileKeyValue reads both as
// ''). Comments do not count.
function fileKeyPresent(file, key) {
  let raw;
  try { raw = readTextFile(file); } catch { return false; }
  for (const rawLine of splitLines(raw)) {
    let body = rawLine;
    const m = body.match(/[ \t]#.*$/);
    if (m) body = body.slice(0, m.index);
    const stripped = body.trim();
    if (stripped === '' || stripped.startsWith('#')) continue;
    const eq = stripped.indexOf('=');
    if (eq === -1) continue;
    if (stripped.slice(0, eq).trim() === key) return true;
  }
  return false;
}

// drop_preset_file_extras <dest> <panes> <lines>: one rewrite pass
// over a file treated as preset (the preset is resolved at run time from
// panes, so the file freezes no roles and no limits):
//   - every lane.<l>.roles line is removed (none are written back);
//   - max_workers and split_max_panes are removed, printed as
//     `removed max_workers=<v> (derived from the lanes)` and
//     `removed split_max_panes=<v> (derived from panes)`;
//   - the attrs of the lanes that do not exist in the panes preset:
//       lane.read.<attr>   → lane.review.<attr> when the preset has the
//         review lane (panes 3 and 4) and that key is not in the file
//         (`moved lane.read.<attr>=<v> to lane.review.<attr>`, the value
//         is the effective one — last assignment wins, like fileKeyValue);
//         when it is, the line is only removed (`removed
//         lane.read.<attr>=<v> (lane.review.<attr> is already set)`);
//         at panes=2 (no review lane) it gets the generic removal line;
//       lane.explore.<attr> → removed (`removed lane.explore.<attr>=<v>
//         (research runs on the build lane now)`);
//       any other lane      → removed (`removed lane.<l>.<attr>=<v>
//         (no lane '<l>' in the panes=<n> preset)`).
// In a custom file none of this happens. Full-line comments and every
// other line stay. The printed lines are pushed into `lines` in file
// order; the rewrite is atomicWrite (DieError 4, file untouched, on
// failure — the configDropLegacy message, so the caller's diff still
// reads as a failed rewrite).
function dropPresetFileExtras(dest, panes, lines, env, mode = 'strict') {
  let raw;
  try { raw = readTextFile(dest); } catch { throw new DieError(`could not rewrite ${dest} (file left untouched)`, 4); }
  const presetLanes = new Set(presetLaneNamesFor(panes, mode));
  const out = [];
  const moved = new Set();
  for (const rawLine of splitLines(raw)) {
    let body = rawLine;
    let comment = '';
    const cm = body.match(/[ \t]#.*$/);
    if (cm) { comment = body.slice(cm.index); body = body.slice(0, cm.index); }
    const stripped = body.trim();
    if (stripped === '' || stripped.startsWith('#')) { out.push(rawLine); continue; }
    const eq = stripped.indexOf('=');
    if (eq === -1) { out.push(rawLine); continue; }
    const k = stripped.slice(0, eq).trim();
    const v = stripped.slice(eq + 1).trim();
    if (LANE_ROLES_RE.test(k)) continue; // every roles line goes
    if (k === 'max_workers') {
      lines.push(`removed max_workers=${v} (derived from the lanes)`);
      continue;
    }
    if (k === 'split_max_panes') {
      lines.push(`removed split_max_panes=${v} (derived from panes)`);
      continue;
    }
    const am = k.match(LANE_ATTR_RE);
    if (am && !presetLanes.has(am[1])) {
      const [, lane, attr] = am;
      // The read→review move only when the target preset keeps the
      // review lane (panes 3 and 4); at panes=2 the read lane is gone
      // like any other lane that is not in the preset.
      if (lane === 'read' && presetLanes.has('review')) {
        const target = `lane.review.${attr}`;
        // Key PRESENCE decides (even an empty `lane.review.<attr>=` is
        // present): writing would leave two lines for the same key.
        if (fileKeyPresent(dest, target) || moved.has(attr)) {
          lines.push(`removed lane.read.${attr}=${v} (${target} is already set)`);
          continue;
        }
        const effective = fileKeyValue(dest, `lane.read.${attr}`);
        out.push(`${target}=${effective}${comment}`);
        moved.add(attr);
        lines.push(`moved lane.read.${attr}=${effective} to ${target}`);
        continue;
      }
      if (lane === 'explore') {
        lines.push(`removed lane.explore.${attr}=${v} (research runs on the build lane now)`);
        continue;
      }
      lines.push(`removed lane.${lane}.${attr}=${v} (no lane '${lane}' in the panes=${panes} preset)`);
      continue;
    }
    out.push(rawLine);
  }
  try {
    atomicWrite(dest, out.length ? out.join('\n') + '\n' : '');
  } catch {
    throw new DieError(`could not rewrite ${dest} (file left untouched)`, 4);
  }
}

// apply_lane_file <dest> <panes 2|3|4> (:1395, migration): the file is
// a PRESET file when its lane.*.roles signature is empty, a preset of
// either mode (2, 3 or 4 panes, strict or flex) or an old preset
// (LEGACY_PRESETS 3 or 4); any other signature is custom (today's warn,
// the file keeps its lanes). For a preset file the preset is resolved at
// run time from panes and the effective pane_mode: the file freezes no
// roles and no limits — applyLaneFile drops every lane.<l>.roles, moves
// the old read/explore lane attrs (dropPresetFileExtras), removes
// max_workers and split_max_panes (both derived: the sum of the lane
// capacities, the pane count) and writes panes + reuse_workers=on. For a
// custom file:
// as before, but max_workers is the sum of the lane capacities
// (laneCapacitySum) plus flex_extra in the flex mode (the temporary
// worker needs a live slot, or the burst dies on the cap), and
// split_max_panes the mode's cap (panes in strict, panes + flex_extra
// in flex). A unanimous
// per-role kind/model is still copied onto the lane before the role.*
// keys are dropped (the documenter never votes — its kind is configured
// per role, or via the docs lane in the flex mode); a divergent lane
// keeps its keys (warn); the role.
// planner.* keys are always removed. Returns the printed lines (the
// `set …` / `moved …` / `removed …` lines, in order); the warnings go
// through warn (friction log).
export function applyLaneFile(dest, panes, env = process.env, cwd = process.cwd()) {
  if (!fs.existsSync(dest)) {
    try { fs.writeFileSync(dest, '', { flag: 'a' }); } catch {
      throw new DieError(`config set: could not rewrite ${dest} (file left untouched)`, 4);
    }
  }
  const sig = fileLaneSignature(dest);
  const presetSigs = new Set();
  for (const pp of ['2', '3', '4']) for (const mm of ['strict', 'flex']) presetSigs.add(presetSignature(pp, mm));
  const isPreset = sig === '' || presetSigs.has(sig)
    || sig === legacyPresetSignature('3') || sig === legacyPresetSignature('4');
  const ctx = loadConfig(env, cwd);
  const mode = paneMode(ctx, env);
  const lines = [];
  if (!isPreset) {
    warn(`lane roles in ${dest} are custom; left in place. Remove them to restore the panes=${panes} preset.`);
  } else {
    dropPresetFileExtras(dest, panes, lines, env, mode);
  }
  const acc = { dropKind: [], dropModel: [], lines };
  const pairs = isPreset
    ? presetLaneNamesFor(panes, mode).map((lane) => [lane, presetLaneRoles(lane, panes, mode)])
    : sig.split('\n').filter((l) => l !== '').map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    });
  for (const [lane, rolesCsv] of pairs) {
    migrateLaneAttr(dest, lane, rolesCsv, 'kind', acc, env, cwd);
    migrateLaneAttr(dest, lane, rolesCsv, 'model', acc, env, cwd);
  }
  configDropLegacy(dest, { dropKind: acc.dropKind, dropModel: acc.dropModel, dropLanes: isPreset });
  configWritePair(dest, 'panes', panes, env);
  lines.push(`set panes=${panes}`);
  if (!isPreset) {
    // The file keeps its custom lanes: max_workers is the sum of their
    // capacities (the effective lanes, incl. the env lane.*.roles) plus
    // flex_extra in the flex mode — the temporary worker needs a live
    // slot, or the burst dies on the cap; split_max_panes the mode's cap
    // (panes in strict, panes + flex_extra in flex, so the temporary
    // panel stays in the caller's tab).
    const sum = laneCapacitySum(ctx, env);
    const mw = sum + (mode === 'flex' ? flexExtra(ctx, env) : 0);
    configWritePair(dest, 'max_workers', String(mw), env);
    lines.push(`set max_workers=${mw}`);
    const spCap = mode === 'flex' ? Number(panes) + flexExtra(ctx, env) : Number(panes);
    configWritePair(dest, 'split_max_panes', String(spCap), env);
    lines.push(`set split_max_panes=${spCap}`);
  }
  configWritePair(dest, 'reuse_workers', 'on', env);
  lines.push('set reuse_workers=on');
  lines.push('removed role.planner.* and the role kind/model keys of lanes that agreed; divergent lanes kept theirs');
  return lines;
}
