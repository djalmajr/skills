// Lanes (port slice 4): presets and custom lanes, the layer rules for
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
//   - panesValue accepts only 3 or 4, anything else is 4.
//   - Errors are DieError exceptions with the bash message and code
//     (2 = bad --lane spec, 8 = worker cap, 4 = rewrite left the file
//     untouched); nothing here calls process.exit.
import fs from 'node:fs';
import { cfg, cfgSource, KNOWN_KINDS, EFFORT_LADDER, DieError, fileKeyValue, configWritePair } from './config.mjs';
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

// panes_value (:860): 3|4, anything else 4.
export function panesValue(ctx, env = process.env) {
  const p = cfg(ctx, 'panes', '4', env);
  return p === '3' || p === '4' ? p : '4';
}

// lane_key <name> <attr> (:867): lane.<name>.<attr> as a normalized key,
// with '-' → '_'.
export function laneKey(name, attr) {
  return `lane_${String(name).replace(/-/g, '_')}_${attr}`;
}

// preset_lane_names_for (:870): panes=3 → build read; else build explore review.
export function presetLaneNamesFor(p) {
  return p === '3' ? ['build', 'read'] : ['build', 'explore', 'review'];
}

// preset_lane_names: the preset for the effective panes value.
export function presetLaneNames(ctx, env = process.env) {
  return presetLaneNamesFor(panesValue(ctx, env));
}

// preset_lane_count.
export function presetLaneCount(p) {
  return p === '3' ? 2 : 3;
}

// preset_lane_roles <lane> <panes> (:879).
export function presetLaneRoles(lane, p) {
  switch (`${p}:${lane}`) {
    case '4:build':
    case '3:build': return 'implementer,designer,tasker';
    case '4:explore': return 'scouter,researcher';
    case '4:review': return 'reviewer,security-reviewer,ui-reviewer,inspector';
    case '3:read': return 'scouter,researcher,reviewer,security-reviewer,ui-reviewer,inspector';
    default: return '';
  }
}

// preset_roles_flat <panes>: every preset role, one CSV.
export function presetRolesFlat(p) {
  return presetLaneNamesFor(p)
    .map((lane) => presetLaneRoles(lane, p))
    .filter((r) => r !== '')
    .join(',');
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
  if (!customLanesPresent(ctx, env)) return presetLaneNamesFor(panesValue(ctx, env));
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
// preset roles.
export function laneRolesCsv(ctx, lane, env = process.env) {
  if (customLanesPresent(ctx, env)) return cfg(ctx, laneKey(lane, 'roles'), '', env);
  return presetLaneRoles(lane, panesValue(ctx, env));
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

// ---------- reuse decision (:1009-1055) ----------

// find_lane_worker <lane>: the first roster row whose column 12 is the
// lane; else the LAST row named as the lane (bash keeps the last
// by_name); null when none.
export function findLaneWorker(sd, lane) {
  let byName = '';
  for (const line of rosterRows(sd)) {
    if (!line) continue;
    const f = line.split('\t');
    const name = f[0] ?? '';
    const laneCol = f.length >= 12 ? (f[11] ?? '') : '';
    if (laneCol === lane) return line;
    if (name === lane) byName = line;
  }
  return byName || null;
}

// A recorded report path pointing at an absent or empty file is
// pending (bash: `[ -n "$rep" ] && [ ! -s "$rep" ]`).
function reportPending(sd, name) {
  const rep = lastReport(sd, name);
  if (rep === '') return false;
  try { return fs.statSync(rep).size === 0; } catch { return true; }
}

// lane_decide <lane> <role> (:1018): the reuse decision for a spawn into
// this lane. { decision, name?, state?, cause? } with decision in
// absent | reuse | busy | gone | unavailable | locked. busy carries the
// worker state (working, blocked, pending-report, unknown, …).
export function laneDecide(ctx, lane, role, env = process.env, cwd = process.cwd()) {
  const sd = stateDir(ctx, env, cwd);
  const line = findLaneWorker(sd, lane);
  if (!line) return { decision: 'absent' };
  const f = line.split('\t');
  const name = f[0] ?? '';
  const st = agentState(name, env);
  const state = st.state;
  if (state === 'gone') return { decision: 'gone', name };
  if (state === 'working' || state === 'blocked') return { decision: 'busy', name, state };
  if (state === 'unavailable') return { decision: 'unavailable', name, cause: st.cause };
  if (state === 'idle' || state === 'done') {
    if (reportPending(sd, name)) return { decision: 'busy', name, state: 'pending-report' };
    const cur = f[3] ?? '';
    const hist = f.length >= 11 ? (f[10] ?? '') : '';
    if (isReviewRole(role) && (roleIsEdit(cur, env, cwd) || historyHasEdit(hist, env, cwd))) {
      return { decision: 'locked', name };
    }
    return { decision: 'reuse', name };
  }
  return { decision: 'busy', name, state: state || 'unknown' };
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
// session), the cap is the number of lanes; otherwise the value when it
// is an integer ≥ 0, else 3.
export function maxWorkers(ctx, env = process.env) {
  if (lanesEnabled(ctx, env) && !configExplicit(ctx, 'max_workers', env)) {
    return String(laneCount(ctx, env));
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

// preset_signature <panes>: the preset lanes' roles, the same shape.
export function presetSignature(p) {
  const lines = presetLaneNamesFor(p).map((lane) => `${lane}=${presetLaneRoles(lane, p)}`);
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
      (attr === 'kind' ? acc.dropKind : acc.dropModel).push(r);
    }
    return;
  }
  if (!agree) {
    warn(`lane '${lane}' ${attr}s differ (${list.join(' ')}). Left the role.*.${attr} keys in place. Orchestrator: ask the user which ${attr} this lane should use, then run 'setup --lane ${lane}=<kind>[:<model>[:<effort>]]'.`);
  }
}

// apply_lane_file <dest> <panes 3|4> (:1395): writes panes, the preset
// lanes when the file has none or only a preset, aligns max_workers and
// split_max_panes, turns reuse_workers on, and copies a unanimous
// per-role kind/model onto the lane before removing those keys. A lane
// whose roles disagree keeps the keys; role.planner.* is always removed.
// Returns the printed lines (the `set …` lines, in order); the warnings
// go through warn (friction log).
export function applyLaneFile(dest, panes, env = process.env, cwd = process.cwd()) {
  if (!fs.existsSync(dest)) {
    try { fs.writeFileSync(dest, '', { flag: 'a' }); } catch {
      throw new DieError(`config set: could not rewrite ${dest} (file left untouched)`, 4);
    }
  }
  const sig = fileLaneSignature(dest);
  let custom = false;
  const lines = [];
  if (sig !== '' && sig !== presetSignature('3') && sig !== presetSignature('4')) {
    custom = true;
    warn(`lane roles in ${dest} are custom; left in place. Remove them to restore the panes=${panes} preset.`);
  }
  let dropLanes = false;
  const acc = { dropKind: [], dropModel: [], lines };
  let pairs;
  if (!custom) {
    if (sig !== presetSignature(panes)) dropLanes = true;
    pairs = presetLaneNamesFor(panes).map((lane) => [lane, presetLaneRoles(lane, panes)]);
  } else {
    pairs = sig.split('\n').filter((l) => l !== '').map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    });
  }
  for (const [lane, rolesCsv] of pairs) {
    migrateLaneAttr(dest, lane, rolesCsv, 'kind', acc, env, cwd);
    migrateLaneAttr(dest, lane, rolesCsv, 'model', acc, env, cwd);
  }
  configDropLegacy(dest, { dropKind: acc.dropKind, dropModel: acc.dropModel, dropLanes });
  configWritePair(dest, 'panes', panes, env);
  lines.push(`set panes=${panes}`);
  let n;
  if (!custom) {
    for (const lane of presetLaneNamesFor(panes)) {
      const roles = presetLaneRoles(lane, panes);
      configWritePair(dest, `lane.${lane}.roles`, roles, env);
      lines.push(`set lane.${lane}.roles=${roles}`);
    }
    n = String(presetLaneCount(panes));
  } else {
    n = String(fileLaneCount(dest));
  }
  configWritePair(dest, 'max_workers', n, env);
  lines.push(`set max_workers=${n}`);
  configWritePair(dest, 'split_max_panes', panes, env);
  lines.push(`set split_max_panes=${panes}`);
  configWritePair(dest, 'reuse_workers', 'on', env);
  lines.push('set reuse_workers=on');
  lines.push('removed role.planner.* and the role kind/model keys of lanes that agreed; divergent lanes kept theirs');
  return lines;
}
