// `doctor` and `doctor --fix` (bash port): the advisory
// environment/configuration check that never blocks, and the preset writer.
// Port of the original bash implementation :1528-1557 (doctor_fix), :1558-1682
// (doctor_lane_warnings), :1683-1709 (project_has_roster /
// project_is_first_run), :1710-1753 (doctor_role_kind / doctor_used_kinds)
// and :1755-1826 (cmd_doctor).
//
// Same lines, same order, same text as the bash (the 6-column
// `ok`/`warn` printf, `first_run: true|false`, the final `N ok, M
// warning(s)`), with the two decided differences: no `jq` line (orchestrator
// decision 5 — the ok count drops by one) and the launcher path where the
// bash prints `$0` (decision 2b; switch-to-JS decision 4 — the user runs
// the launcher, not the .mjs). `--fix` writes with the ported applyLaneFile
// and shows the diff with the unifiedDiff (labels `a/<file>` /
// `b/<file>` instead of bash's process-substitution header, which is
// non-deterministic — /dev/fd/N and a timestamp); after a successful fix it
// runs the check in-process where the bash re-execs itself (spec §4.4).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DieError, cfg, cfgSource, configFileFor, fileKeyValue, loadConfig,
  stateRoot, stateRootPath,
} from '../config.mjs';
import {
  applyLaneFile, cfgLayerRank, configExplicit, effectiveLaneSignature, flexExtra, laneAttr, laneCapacity,
  laneCapacitySum, laneKey, laneNames, laneOfRole, laneRolesCsv, lanesEnabled, legacyPresetSignature,
  LEGACY_PRESETS, maxWorkers, paneMode, panesValue, splitRoles,
} from '../lanes.mjs';
import { findExecutable, homeDir, projectRoot, readTextFile, runCli } from '../platform.mjs';
import { fmGet, isReviewRole, roleDirs, roleFile, roleIsEdit } from '../roles.mjs';
import { resolveRoleSettings } from '../resolve.mjs';
import { resolveModel } from '../models.mjs';
import { sessionConfPath } from '../session.mjs';
import { splitCap, splitMin } from '../layout.mjs';
import { herdLabelMax } from '../herdtabs.mjs';
import { setupHookDoctor } from '../setuptext.mjs';
import { kindExe } from '../kinds.mjs';
import { ownProviderDoctorLines } from '../ownproviders.mjs';
import { sandboxNotes } from '../dispatch.mjs';
import { configNativeArgs } from '../spawn.mjs';
import { setupTargetExisting, projectNeedsConfigPrompt } from './setup.mjs';
import { unifiedDiff } from './setup-plan.mjs';

// Where the user runs the program from — the launcher (switch-to-JS
// decision 4), where the bash prints `$0` (decision 2b): scripts/herdr-agents
// on POSIX, scripts\herdr-agents.cmd on Windows. The goldens normalize it to
// PROG.
export const ENTRY_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..',
  process.platform === 'win32' ? 'herdr-agents.cmd' : 'herdr-agents',
);

// `isFile` / `isDir` ports (regular file / directory, symlinks followed).
function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// The 6-column say line (`printf '%-6s %s'`) with the ok/warn counters.
export class DoctorSay {
  constructor() { this.okCount = 0; this.warnCount = 0; }
  say(kind, msg) {
    if (kind === 'warn') this.warnCount += 1; else this.okCount += 1;
    process.stdout.write(`${kind.padEnd(6)} ${msg}\n`);
  }
  ok(msg) { this.say('ok', msg); }
  warn(msg) { this.say('warn', msg); }
}

// resolved_role_kind <role> port: the config role.<role>.kind (dash →
// underscore key), else the role file's frontmatter kind; '' when the role
// cannot be resolved.
function resolvedRoleKind(r, ctx, env, cwd) {
  const v = cfg(ctx, `role_${String(r).replace(/-/g, '_')}_kind`, '', env);
  if (v !== '') return v;
  const f = roleFile(r, env, cwd);
  return f ? fmGet(f, 'kind') : '';
}

// doctor_role_kind <role> port (:1710): the kind a spawn resolves for the
// role — config, else frontmatter (empty when it cannot be resolved). The
// planner is the orchestrator: `spawn planner` exits 12 before resolving a
// kind, so it uses none.
export function doctorRoleKind(r, ctx, env = process.env, cwd = process.cwd()) {
  if (r === 'planner') return '';
  const v = cfg(ctx, `role_${String(r).replace(/-/g, '_')}_kind`, '', env);
  if (v !== '') return v;
  const f = roleFile(r, env, cwd);
  return f ? fmGet(f, 'kind') : '';
}

// doctor_used_kinds port (:1724): the sorted, unique kinds the effective
// configuration resolves — for each lane, lane.<name>.kind when set (it wins
// for every role in the lane), else the effective kind of the lane's roles;
// with lanes off, every role file. The documenter never counts: in strict
// it borrows a build slot without joining the lane's kind, and in the flex
// mode its kind belongs to the capacity-0 docs lane, which the lanes-on
// branch reaches through the lane.<name>.kind key (or, with lanes off, is
// configured per role). Kinds no spawn can resolve are not
// warned about.
export function doctorUsedKinds(ctx, env = process.env, cwd = process.cwd()) {
  const out = [];
  if (lanesEnabled(ctx, env)) {
    for (const lane of laneNames(ctx, env)) {
      if (lane === '') continue;
      const k = laneAttr(ctx, lane, 'kind', undefined, env);
      if (k !== '') { out.push(k); continue; }
      for (const part of laneRolesCsv(ctx, lane, env).split(',')) {
        const r = part.trim();
        if (r === '') continue;
        if (r === 'documenter') continue; // its kind never joins the lane's
        const rk = doctorRoleKind(r, ctx, env, cwd);
        if (rk !== '') out.push(rk);
      }
    }
  } else {
    const seen = new Set();
    for (const d of roleDirs(env, cwd)) {
      let entries;
      try { entries = fs.readdirSync(d); } catch { continue; }
      for (const name of entries.sort()) {
        if (!name.endsWith('.md')) continue;
        const r = name.slice(0, -3);
        if (seen.has(r)) continue;
        seen.add(r);
        if (r === 'documenter') continue; // see above: per-role, not a lane
        const k = doctorRoleKind(r, ctx, env, cwd);
        if (k !== '') out.push(k);
      }
    }
  }
  return [...new Set(out)].sort();
}

// doctor_lane_warnings port (:1558): the lane/configuration warnings — the
// explicit-panes prompt, unknown/duplicated roles, edit+review in one lane,
// the planner in a lane, per-role kind/model under a lane kind, divergent
// role kinds without lane.<name>.kind, the dropped lane effort (as an ok
// line, so the orchestrator sees the resolution decision; the dropped
// model is a warn — doctorDiscardedModels), the old preset lanes, the
// orphan lane keys (a lane.<l>.<attr> whose lane does not exist), the
// max_workers / split_max_panes alignment and the role.planner.*
// leftovers (a session layer counts like the user/project layers).
export function doctorLaneWarnings(ctx, env = process.env, cwd = process.cwd(), say = new DoctorSay()) {
  const psrc = cfgSource(ctx, 'panes', env);
  const lanesVal = cfg(ctx, 'lanes', 'on', env);
  if (lanesVal !== 'on' && lanesVal !== 'off') say.warn(`config: lanes='${lanesVal}' is not on|off`);
  const panesRaw = cfg(ctx, 'panes', '4', env);
  if (panesRaw === '2' || panesRaw === '3' || panesRaw === '4') {
    if (psrc === 'defaults' || psrc === 'builtin') {
      say.warn(`config: panes is not set in the project or user file (default ${panesRaw}). Ask the user for 2, 3 or 4 panes, then run '${ENTRY_SCRIPT} doctor --fix --panes <n>' with their answer.`);
    } else {
      say.ok(`config: panes=${panesRaw} (${psrc})`);
    }
  } else {
    say.warn(`config: panes='${panesRaw}' is not 2, 3 or 4 (doctor --fix --panes 2|3|4 writes a preset)`);
  }
  const pmRaw = cfg(ctx, 'pane_mode', 'strict', env);
  if (pmRaw === 'strict') {
    say.ok(`config: pane_mode=strict (never more than ${panesValue(ctx, env)} panels)`);
  } else if (pmRaw === 'flex') {
    say.ok(`config: pane_mode=flex (+${flexExtra(ctx, env)} temporary panel for ${cfg(ctx, 'flex_roles', 'reviewer,documenter', env)})`);
  } else {
    say.warn(`config: pane_mode='${pmRaw}' is not strict|flex`);
  }
  let unknown = '';
  let dup = '';
  let mixed = '';
  const seen = new Set();
  for (const lane of laneNames(ctx, env)) {
    if (lane === '') continue;
    const roles = laneRolesCsv(ctx, lane, env);
    let hasEdit = 0;
    let hasReview = 0;
    for (const part of roles.split(',')) {
      const r = part.trim();
      if (r === '') continue;
      if (!roleFile(r, env, cwd)) unknown += ` ${lane}:${r}`;
      if (seen.has(r)) dup += ` ${r}`;
      seen.add(r);
      if (roleIsEdit(r, env, cwd)) hasEdit = 1;
      if (isReviewRole(r)) hasReview = 1;
      if (r === 'planner') {
        say.warn(`lanes: '${lane}' includes planner. The orchestrator is the planner and opens no pane; remove it from the lane.`);
      }
    }
    if (hasEdit === 1 && hasReview === 1) mixed += ` ${lane}`;
    const laneKind = laneAttr(ctx, lane, 'kind', undefined, env);
    if (laneKind !== '') {
      // A lane effort sitting in a layer below the layer that set the
      // lane kind was chosen for another kind: resolution drops it; report
      // the decision as ok so the orchestrator can see it. (The dropped
      // lane model gets its own warn: doctorDiscardedModels.)
      const kkey = laneKey(lane, 'kind');
      const klayer = cfgLayerRank(ctx, kkey, env);
      const ekey = laneKey(lane, 'effort');
      const evalue = cfg(ctx, ekey, '', env);
      if (evalue !== '' && cfgLayerRank(ctx, ekey, env) < klayer) {
        say.ok(`lanes: lane '${lane}' kind ${laneKind} (${cfgSource(ctx, kkey, env)}); ignored lane effort ${evalue} from ${cfgSource(ctx, ekey, env)} (another kind)`);
      }
      for (const part of roles.split(',')) {
        const r = part.trim();
        if (r === '') continue;
        if (r === 'documenter') continue; // its kind is per-role, never the lane's
        const rk = `role_${String(r).replace(/-/g, '_')}_kind`;
        const rm = `role_${String(r).replace(/-/g, '_')}_model`;
        if (configExplicit(ctx, rk, env)) {
          say.warn(`config: role.${r}.kind is set and lane '${lane}' has kind=${laneKind}. Remove role.${r}.kind (doctor --fix); the lane shares one kind.`);
        }
        if (configExplicit(ctx, rm, env)) {
          say.warn(`config: role.${r}.model is set and lane '${lane}' has its own kind. Remove role.${r}.model (doctor --fix).`);
        }
      }
    } else {
      let kindsList = '';
      let firstK = '';
      let haveK = 0;
      let differ = 0;
      for (const part of roles.split(',')) {
        const r = part.trim();
        if (r === '') continue;
        if (r === 'planner') continue;
        if (r === 'documenter') continue; // its kind never joins the lane's
        const rkind = resolvedRoleKind(r, ctx, env, cwd);
        kindsList = kindsList === '' ? `${r}=${rkind}` : `${kindsList} ${r}=${rkind}`;
        if (haveK === 0) { firstK = rkind; haveK = 1; }
        else if (rkind !== firstK) differ = 1;
      }
      if (differ === 1) {
        say.warn(`lanes: lane '${lane}' has no lane.${lane}.kind and its roles disagree (${kindsList}). Orchestrator: ask the user, then run 'setup --lane ${lane}=<kind>[:<model>[:<effort>]]'.`);
      }
    }
  }
  if (unknown !== '') say.warn(`lanes: unknown roles:${unknown}. Use a role from 'roles', or remove it.`);
  else say.ok('lanes: every role is known');
  if (dup !== '') say.warn(`lanes: roles in more than one lane:${dup}. Keep each role in one lane.`);
  else say.ok('lanes: no role is in two lanes');
  if (mixed !== '') {
    say.warn(`lanes:${mixed} mix an edit role with a review role (a session must not review code it wrote). Split them the way panes=4 separates build from review.`);
  } else {
    say.ok('lanes: edit and review roles are separated');
  }
  // The effective lane.*.roles come from an old preset (build|read or
  // build|explore|review): the config still loads, but the lanes are the
  // old ones — point at the migration (research joins the build lane).
  const effSig = effectiveLaneSignature(ctx, env);
  for (const p of ['4', '3']) {
    if (effSig !== legacyPresetSignature(p)) continue;
    const names = Object.keys(LEGACY_PRESETS[p]).join(', ');
    say.warn(`lanes: the lanes come from an old preset (${names}); run '${ENTRY_SCRIPT} doctor --fix --panes ${panesValue(ctx, env)}' to move to the new ones (research joins the build lane).`);
    break;
  }
  // Orphan lane keys (lanes on): every effective lane.<l>.<attr> whose lane
  // is not one of the lane names — one line per key, sorted.
  const lanes = laneNames(ctx, env);
  const knownLanes = new Set(lanes);
  const orphanRe = /^lane_(.+)_(roles|kind|model|effort|approvals|panes|args)$/;
  const orphans = [];
  for (const key of ctx.entries.keys()) {
    const m = key.match(orphanRe);
    if (!m) continue;
    const value = cfg(ctx, key, '', env);
    if (value === '' || knownLanes.has(m[1])) continue;
    orphans.push([key, `lane.${m[1]}.${m[2]}`, value]);
  }
  orphans.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [key, dotted, value] of orphans) {
    say.warn(`config: ${dotted}=${value} (${cfgSource(ctx, key, env)}) sets a lane that does not exist (lanes: ${lanes.join(' ')}). doctor --fix removes it.`);
  }
  // max_workers against the sum of the lane capacities (not the lane
  // count: the build lane of panes=4 holds 2); in the flex mode the sum
  // includes flex_extra, the temporary worker's live slot.
  const mw = cfg(ctx, 'max_workers', '3', env);
  const sum = laneCapacitySum(ctx, env) + (paneMode(ctx, env) === 'flex' ? flexExtra(ctx, env) : 0);
  const caps = lanes.map((lane) => `${lane}=${laneCapacity(ctx, lane, env)}`).join(' ');
  if (configExplicit(ctx, 'max_workers', env) && mw !== String(sum)) {
    say.warn(`config: max_workers=${mw} but the lanes hold ${sum} workers (${caps}). Set max_workers=${sum} (doctor --fix aligns it).`);
  } else {
    say.ok(`config: max_workers=${maxWorkers(ctx, env)} matches the lanes (${caps})`);
  }
  if (configExplicit(ctx, 'split_max_panes', env)) {
    const sp = cfg(ctx, 'split_max_panes', '', env);
    const p = Number(panesValue(ctx, env));
    const e = flexExtra(ctx, env);
    const flex = paneMode(ctx, env) === 'flex';
    // The mode's cap: panes in strict, panes + flex_extra in flex (the
    // temporary panel counts, so it stays in the caller's tab).
    const cap = flex ? p + e : p;
    if (/^[0-9]+$/.test(sp) && Number(sp) > cap) {
      if (flex) {
        say.warn(`config: split_max_panes=${sp} is greater than panes=${panesValue(ctx, env)} + flex_extra=${e}. Set split_max_panes=${cap} (doctor --fix aligns it).`);
      } else {
        say.warn(`config: split_max_panes=${sp} is greater than panes=${panesValue(ctx, env)}. Set split_max_panes=${panesValue(ctx, env)} (doctor --fix aligns it).`);
      }
    }
    if (lanesEnabled(ctx, env) && flex && /^[0-9]+$/.test(sp) && Number(sp) < cap) {
      say.warn(`config: split_max_panes=${sp} leaves no room for the temporary panel (panes=${panesValue(ctx, env)} + flex_extra=${e}); the extra worker will open in a herd tab. Remove split_max_panes or set ${cap}.`);
    }
  }
  // compgen -v | grep '^CFG_role_planner_' port: every role.planner.* key
  // the config layers set (compgen lists them sorted), by source — the
  // session layer counts like the user/project layers.
  for (const key of [...ctx.entries.keys()].filter((k) => k.startsWith('role_planner_')).sort()) {
    const src = cfgSource(ctx, key, env);
    if (src === 'user' || src === 'project' || src === 'env' || src === 'session') {
      say.warn(`config: ${key} is set (${src}) but the planner is the orchestrator and opens no pane. Remove it (doctor --fix).`);
    }
  }
}

// The models the resolution drops because the kind they belong to comes
// from a layer above their own — one warn per dropped model, the keys as
// written in the files:
//   config: role.<r>.model=<v> (<layer>) is ignored: role.<r>.kind=<k>
//     comes from a higher layer (<layer>) without a model
//   config: lane.<n>.model=<v> (<layer>) is ignored: lane.<n>.kind=<k>
//     comes from a higher layer (<layer>) without a model
// The frontmatter is the lowest layer: its model belongs to the
// frontmatter's kind, and a kind from a config layer drops it (the spawn
// falls through to model.<kind>.<position> / model.<kind> / the CLI
// default). No warn when a role model at the kind's layer or above
// replaces it:
//   config: role file model '<spec>' of '<r>' is ignored: role.<r>.kind=
//     <k> comes from a higher layer (<layer>)
// The role check skips the planner (spawn never resolves its kind) and a
// role that sits in a lane with its own kind: there the effective kind is
// the lane kind and the per-lane "remove role.<r>.model" warn already
// names the key (the frontmatter warn shares that skip — the brief text
// names role.<r>.kind, which the lane kind does not decide).
export function doctorDiscardedModels(ctx, env = process.env, cwd = process.cwd(), say = new DoctorSay()) {
  if (lanesEnabled(ctx, env)) {
    for (const lane of laneNames(ctx, env)) {
      if (lane === '') continue;
      const kkey = laneKey(lane, 'kind');
      const mkey = laneKey(lane, 'model');
      const k = cfg(ctx, kkey, '', env);
      const m = cfg(ctx, mkey, '', env);
      if (k === '' || m === '') continue;
      if (cfgLayerRank(ctx, mkey, env) < cfgLayerRank(ctx, kkey, env)) {
        say.warn(`config: lane.${lane}.model=${m} (${cfgSource(ctx, mkey, env)}) is ignored: lane.${lane}.kind=${k} comes from a higher layer (${cfgSource(ctx, kkey, env)}) without a model`);
      }
    }
  }
  const lanesOn = lanesEnabled(ctx, env);
  const seen = new Set();
  for (const d of roleDirs(env, cwd)) {
    let entries;
    try { entries = fs.readdirSync(d); } catch { continue; }
    for (const name of entries.sort()) {
      if (!name.endsWith('.md')) continue;
      const r = name.slice(0, -3);
      if (seen.has(r)) continue;
      seen.add(r);
      if (r === 'planner') continue;
      const prefix = `role_${String(r).replace(/-/g, '_')}_`;
      const kkey = `${prefix}kind`;
      const mkey = `${prefix}model`;
      const k = cfg(ctx, kkey, '', env);
      const m = cfg(ctx, mkey, '', env);
      // The effective kind is the lane kind when the role sits in a lane
      // with its own kind; both warn forms name role.<r>.kind, so the
      // lane-kind case stays to the per-lane warns.
      let laneKindSet = false;
      if (lanesOn) {
        const lane = laneOfRole(ctx, r, env);
        laneKindSet = lane !== '' && cfg(ctx, laneKey(lane, 'kind'), '', env) !== '';
      }
      if (k !== '' && m !== '' && !laneKindSet && cfgLayerRank(ctx, mkey, env) < cfgLayerRank(ctx, kkey, env)) {
        say.warn(`config: role.${r}.model=${m} (${cfgSource(ctx, mkey, env)}) is ignored: role.${r}.kind=${k} comes from a higher layer (${cfgSource(ctx, kkey, env)}) without a model`);
      }
      // The frontmatter model (the lowest layer): dropped whenever the
      // kind comes from a config layer — resolveRoleSettings discards it
      // the same way. A role model at the kind's layer or above wins
      // anyway, so the warn only fires without one (like the lane case
      // below); a role model under the kind's layer is dropped too, and
      // then both warns fire.
      const roleModelWins = m !== '' && cfgLayerRank(ctx, mkey, env) >= cfgLayerRank(ctx, kkey, env);
      if (k !== '' && !laneKindSet && !roleModelWins) {
        const f = roleFile(r, env, cwd);
        const fmModel = f ? fmGet(f, 'model') : '';
        if (fmModel !== '') {
          say.warn(`config: role file model '${fmModel}' of '${r}' is ignored: role.${r}.kind=${k} comes from a higher layer (${cfgSource(ctx, kkey, env)})`);
        }
      }
      // The lane's own kind drops the frontmatter model the same way. A
      // lane model would win anyway, so the warn only fires without one.
      if (laneKindSet) {
        const lane = laneOfRole(ctx, r, env);
        const lkKey = laneKey(lane, 'kind');
        const lk = cfg(ctx, lkKey, '', env);
        const f = roleFile(r, env, cwd);
        const fmModel = f ? fmGet(f, 'model') : '';
        if (fmModel !== '' && cfg(ctx, laneKey(lane, 'model'), '', env) === '') {
          say.warn(`config: role file model '${fmModel}' of '${r}' is ignored: lane.${lane}.kind=${lk} comes from a higher layer (${cfgSource(ctx, lkKey, env)})`);
        }
      }
    }
  }
}

// The layer of a resolution *From source: the trailing `(layer)` when the
// step came from a config layer, the source text itself otherwise
// (`role file`, `flag`).
function sourceLayer(from) {
  const m = String(from).match(/\(([^)]+)\)$/);
  return m ? m[1] : String(from);
}

// modelSpecUnresolved: the spec matches no model of the kind, with the
// same code a spawn uses (models.mjs resolveModel). resolveModel warns
// exactly `no <kind> model matches '<spec>'; passing it through unchanged`
// when the list is non-empty and no alternative matches; the empty-list
// branch (CLI absent, cache absent) warns nothing and passes the spec
// through, so an unavailable list is not a failure. A cursor spec without
// a match dies 2 there (the strict CLI) — caught as unresolved.
function modelSpecUnresolved(kind, spec, env) {
  let unresolved = false;
  const warn = (m) => {
    if (m === `no ${kind} model matches '${spec}'; passing it through unchanged`) unresolved = true;
  };
  try {
    resolveModel(kind, spec, '', env, warn);
  } catch (e) {
    if (e instanceof DieError) unresolved = true;
    else throw e;
  }
  return unresolved;
}

// doctor_model_pairs: every effective kind+model pair is resolved against
// the kind with the same code a spawn uses: lanes on → each lane with a
// lane kind and a layer-effective lane model, plus — a lane with a model
// but no lane kind → the pair the spawn assembles for each of its roles
// (the effective lane model against the role's own effective kind, the
// same resolution a flagless spawn runs); lanes off → each role with a
// resolved kind and model spec. A spec that no model of the kind matches
// warns:
//   config: <role|lane> '<name>' model '<spec>' (<layer>) does not resolve
//   for kind '<kind>' (<layer>)
// (the no-lane-kind role pair adds "of role '<r>' (<layer>)"). A kind whose
// model list is unavailable (CLI absent, cache absent) is skipped without
// a warn; modelIds is only called for the kinds of the checked pairs, so
// an unused kind never costs a CLI call.
export function doctorModelPairs(ctx, env = process.env, cwd = process.cwd(), say = new DoctorSay()) {
  const pairs = [];
  if (lanesEnabled(ctx, env)) {
    for (const lane of laneNames(ctx, env)) {
      if (lane === '') continue;
      const kind = laneAttr(ctx, lane, 'kind', null, env);
      const spec = laneAttr(ctx, lane, 'model', null, env);
      if (kind === '' && spec !== '') {
        // No lane kind: the spawn applies the effective lane model to the
        // effective kind of every role that resolves to this lane —
        // validate each such role's pair (its own kind and the layer that
        // decided it). A role that resolves to another lane, whose kind is
        // unresolved, or whose resolution did not take the lane model,
        // never gets this lane's model from a spawn.
        const specLayer = cfgSource(ctx, laneKey(lane, 'model'), env);
        const seen = new Set();
        for (const r of splitRoles(laneRolesCsv(ctx, lane, env))) {
          if (seen.has(r)) continue;
          seen.add(r);
          const res = resolveRoleSettings(r, ctx, env, cwd);
          if (res.lane !== lane || res.kind === '') continue;
          if (!(res.modelSpec === spec && res.modelFrom.startsWith(`lane ${lane} (`))) continue;
          if (modelSpecUnresolved(res.kind, spec, env)) {
            say.warn(`config: lane '${lane}' model '${spec}' (${specLayer}) does not resolve for kind '${res.kind}' of role '${r}' (${sourceLayer(res.kindFrom)})`);
          }
        }
        continue;
      }
      if (kind === '' || spec === '') continue;
      pairs.push({
        unit: 'lane', name: lane, kind, spec,
        specLayer: cfgSource(ctx, laneKey(lane, 'model'), env),
        kindLayer: cfgSource(ctx, laneKey(lane, 'kind'), env),
      });
    }
  } else {
    const seen = new Set();
    for (const d of roleDirs(env, cwd)) {
      let entries;
      try { entries = fs.readdirSync(d); } catch { continue; }
      for (const name of entries.sort()) {
        if (!name.endsWith('.md')) continue;
        const r = name.slice(0, -3);
        if (seen.has(r)) continue;
        seen.add(r);
        if (r === 'planner') continue;
        const res = resolveRoleSettings(r, ctx, env, cwd);
        if (res.kind === '' || res.modelSpec === '') continue;
        pairs.push({
          unit: 'role', name: r, kind: res.kind, spec: res.modelSpec,
          specLayer: sourceLayer(res.modelFrom), kindLayer: sourceLayer(res.kindFrom),
        });
      }
    }
  }
  for (const p of pairs) {
    if (modelSpecUnresolved(p.kind, p.spec, env)) {
      say.warn(`config: ${p.unit} '${p.name}' model '${p.spec}' (${p.specLayer}) does not resolve for kind '${p.kind}' (${p.kindLayer})`);
    }
  }
}

// lane_args_ignored warnings: the native args the current lane mode cannot
// apply. With lanes on, a role.<role>.args never reaches a worker that
// opens in a lane (the lane session is shared by its roles, one set of
// args per lane) — one line per lane and laned role. With lanes off, a
// lane.<name>.args reaches no worker (the lanes never open) — one line per
// set lane key, naming the effective roles of the lane (the per-role key
// is where the args belong then; a lane without roles ends without the
// role list). Advisory only: nothing here rewrites the config.
export function laneArgsIgnoredWarnings(ctx, env = process.env, cwd = process.cwd(), say = new DoctorSay()) {
  if (lanesEnabled(ctx, env)) {
    for (const lane of laneNames(ctx, env)) {
      if (lane === '') continue;
      for (const part of laneRolesCsv(ctx, lane, env).split(',')) {
        const r = part.trim();
        if (r === '') continue;
        if (cfg(ctx, `role_${String(r).replace(/-/g, '_')}_args`, '', env) === '') continue;
        say.warn(`config: role.${r}.args is ignored: '${r}' runs in lane '${lane}' (lanes=on); set lane.${lane}.args instead`);
      }
    }
    return;
  }
  const keys = [...ctx.entries.keys()]
    .filter((k) => /^lane_(.*)_args$/.test(k) && cfg(ctx, k, '', env) !== '')
    .sort();
  for (const key of keys) {
    const lane = key.match(/^lane_(.*)_args$/)[1];
    const roles = laneRolesCsv(ctx, lane, env).split(',')
      .map((part) => part.trim())
      .filter((r) => r !== '');
    const list = roles.length > 0 ? ` (${roles.join(', ')})` : '';
    say.warn(`config: lane.${lane}.args is ignored (lanes=off); set role.<role>.args for its roles instead${list}`);
  }
}

// The UI roles the codex-without-network check covers: the designer and
// the inspector open the project's UI and run its e2e tests, and codex's
// default sandbox does not open local ports (listen EPERM) — without
// network access the UI work cannot be verified from the worker, so the
// doctor says so before the work starts. The check uses the kind a spawn
// would resolve for the role (lanes or not) and the exact tokens a spawn
// would pass: args.codex plus lane.<n>.args or role.<r>.args (the same
// assembly as the spawn's native args), and the dispatch's sandbox-notes
// rule for the network lift (a token that ends in network_access=true,
// danger-full-access, or the bypass flag).
export function doctorCodexNetworkWarnings(ctx, env = process.env, cwd = process.cwd(), say = new DoctorSay()) {
  for (const role of ['designer', 'inspector']) {
    const res = resolveRoleSettings(role, ctx, env, cwd);
    if (res.kind !== 'codex') continue;
    const args = configNativeArgs('codex', res.lane, role, ctx, env, cwd);
    // sandboxNotes ('codex', args) pushes the git note whenever the
    // full-access flags are absent and the network note on top when the
    // network is also not released — more than one note means the network
    // stays off.
    if (sandboxNotes('codex', args).length <= 1) continue;
    const key = res.lane !== '' ? `lane.${res.lane}.args` : `role.${role}.args`;
    say.warn(`config: ${role} runs on codex without network: it cannot open a local port, so the UI and e2e tests do not run (listen EPERM); set ${key}=-c sandbox_workspace_write.network_access=true, or run the e2e yourself`);
  }
}

// project_has_roster port (:1683): a roster row under the state root (any
// agents.tsv with a line that is not a `#` comment and not blank; a
// header-only roster never counts).
export function projectHasRoster(ctx, env = process.env, cwd = process.cwd()) {
  const root = stateRootPath(ctx, env, cwd);
  if (!isDir(root)) return false;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return false; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (walk(p)) return true; continue; }
      if (e.name !== 'agents.tsv' || !e.isFile()) continue;
      let raw;
      try { raw = readTextFile(p); } catch { continue; }
      for (const line of raw.split('\n')) {
        if (line.startsWith('#')) continue;
        if (line.replace(/\s/g, '') !== '') return true;
      }
    }
    return false;
  };
  return walk(root);
}

// project_is_first_run port (:1696): no team choice yet (the setup prompt
// test) and no roster row.
export function projectIsFirstRun(ctx, env = process.env, cwd = process.cwd()) {
  const conf = configFileFor('project', env, cwd);
  if (!projectNeedsConfigPrompt(conf)) return false;
  return !projectHasRoster(ctx, env, cwd);
}

// doctor_fix port (:1528): validate --panes (2|3|4) or take it from the
// target file, apply the preset with applyLaneFile, and print the diff of
// the simulated write (unifiedDiff; the bash diff header carries
// a process-substitution path and a timestamp, which the JS replaces with
// the a/<file> / b/<file> labels of the same diff format). --session
// targets the workspace session.conf, the same way --user targets the
// user file (and dies 2 outside a resolvable workspace).
export function doctorFix(where, flag, ctx, env = process.env, cwd = process.cwd()) {
  let dest;
  if (where === 'session') {
    dest = sessionConfPath(ctx, env, cwd);
    if (!dest) throw new DieError('doctor: --session needs a Herdr workspace', 2);
  } else {
    dest = configFileFor(where, env, cwd);
  }
  let panes = '';
  if (flag === '' || flag === undefined) { /* panes from the file below */ }
  else if (flag === '2' || flag === '3' || flag === '4') panes = flag;
  else throw new DieError('doctor --fix: --panes must be 2, 3 or 4', 2);
  if (panes === '') panes = fileKeyValue(dest, 'panes');
  if (panes === '2' || panes === '3' || panes === '4') { /* ok */ }
  else if (panes === '') {
    throw new DieError(`doctor --fix: panes is not set in ${dest}. Orchestrator: ask the user whether to run 2, 3 or 4 panes, then re-run 'doctor --fix --panes <n>'.`, 2);
  } else {
    throw new DieError(`doctor --fix: panes=${panes} in ${dest} is not 2, 3 or 4`, 2);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // `$(cat "$dest")` — the command substitution strips the trailing newlines;
  // the diff below compares that text against the file, so a file that only
  // changed in trailing newlines still reads as changed, like the bash.
  let before = '';
  if (isFile(dest)) before = readTextFile(dest).replace(/\n+$/, '');
  for (const line of applyLaneFile(dest, panes, env, cwd)) process.stdout.write(`${line}\n`);
  const after = readTextFile(dest);
  if (before === after.replace(/\n+$/, '')) {
    process.stdout.write(`doctor --fix: no changes in ${dest}\n`);
  } else {
    process.stdout.write(`doctor --fix: updated ${dest}\n`);
    process.stdout.write(unifiedDiff(before, after, dest));
  }
}

// The SessionStart doctor check accepts only the command setup currently writes.
function settingsHasDoctorHook(file) {
  let j;
  try { j = JSON.parse(readTextFile(file)); } catch { return false; }
  if (!j || typeof j !== 'object') return false;
  const events = j.hooks?.SessionStart;
  if (!Array.isArray(events)) return false;
  for (const entry of events) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) continue;
    for (const hook of entry.hooks) {
      if (hook && typeof hook === 'object' && hook.command === setupHookDoctor()) return true;
    }
  }
  return false;
}

// The advisory checks (bash cmd_doctor, :1768-1824). Never blocks; always
// returns 0. Decision 5: the jq line is gone (the ok count drops by one);
// decision 2b: the entry's path where the bash prints `$0` (switch-to-JS
// decision 4: the launcher).
export function doctorCheck(ctx, env = process.env, cwd = process.cwd()) {
  const s = new DoctorSay();
  if (env.HERDR_ENV === '1') s.ok('inside Herdr (HERDR_ENV=1)');
  else s.warn('HERDR_ENV != 1: not inside a Herdr pane');
  // jq: not a requirement any more (orchestrator decision 5).
  const herdrFound = findExecutable('herdr', env);
  if (herdrFound) {
    // awk '{print $2}' over the CLI version output, first X.Y.Z of
    // `herdr status server` (grep -oE | head -1).
    const cli = (runCli('herdr', ['--version'], { env }).stdout ?? '')
      .split('\n').map((l) => l.trim().split(/\s+/)[1] ?? '').filter((x) => x !== '').join('\n');
    const srvM = (runCli('herdr', ['status', 'server'], { env }).stdout ?? '').match(/[0-9]+\.[0-9]+\.[0-9]+/);
    const srv = srvM ? srvM[0] : '';
    if (srv !== '' && srv !== cli) {
      s.warn(`herdr client ${cli} vs server ${srv}: restart the server (herdr update --handoff) so CLI and server agree`);
    } else {
      s.ok(`herdr ${cli}`);
    }
  } else {
    s.warn('herdr CLI not in PATH');
  }
  // official skill: present and identical to what the binary ships
  const home = homeDir(process.platform, env);
  let f = '';
  for (const cand of [
    path.join(home, '.agents', 'skills', 'herdr', 'SKILL.md'),
    path.join(home, '.claude', 'skills', 'herdr', 'SKILL.md'),
  ]) {
    if (isFile(cand)) { f = cand; break; }
  }
  if (f === '') {
    s.warn('official herdr skill not installed: bunx skills add herdrdev/herdr --skill herdr -g -y');
  } else if (herdrFound && (runCli('herdr', ['--skill'], { env }).stdout ?? '') !== readTextFileSafe(f)) {
    s.warn(`official herdr skill at ${f} differs from 'herdr --skill' (stale after herdr update?): bunx skills update herdr -g`);
  } else {
    s.ok(`official herdr skill matches the binary (${f})`);
  }
  // Kinds the effective configuration actually resolves (lanes, role config,
  // frontmatter): warn only for those, so a kind nobody uses does not nag
  // and a lane on a missing kind cannot slip through.
  const used = doctorUsedKinds(ctx, env, cwd);
  const missing = [];
  for (const k of used) {
    if (!findExecutable(kindExe(k), env)) missing.push(k);
  }
  if (used.length === 0) s.ok('kinds: none configured (spawn passes --kind)');
  else if (missing.length === 0) s.ok(`kinds installed: ${used.join(' ')}`);
  else s.warn(`kinds in use but not in PATH: ${missing.join(' ')} (roles or lanes using them will fail to start)`);
  // Own-provider traps (references/kinds.md "Reasoning
  // models on your own server"): each warning as its own warn line (into
  // the friction count like the others), after the kinds lines; one ok
  // line when an own provider is declared and nothing was found; nothing
  // at all when no own provider is declared. Never prints key values.
  const own = ownProviderDoctorLines(ctx, env, cwd);
  for (const w of own.warnings) s.warn(w);
  if (own.declared && own.warnings.length === 0) s.ok('own providers: no known trap');
  const d = stateRoot(ctx, env, cwd);
  try {
    fs.mkdirSync(d, { recursive: true });
    fs.accessSync(d, fs.constants.W_OK);
    s.ok(`state dir writable: ${d}`);
  } catch {
    s.warn(`state dir not writable: ${d}`);
  }
  const layout = cfg(ctx, 'layout', 'split', env);
  if (layout === 'split' || layout === 'tab') {
    s.ok(`config: layout=${layout} approvals=${cfg(ctx, 'approvals', '', env)} auto_approve=${cfg(ctx, 'auto_approve', '', env)} reuse_workers=${cfg(ctx, 'reuse_workers', '', env)} multi_role=${cfg(ctx, 'multi_role', 'on', env)} worker_context=${cfg(ctx, 'worker_context', '', env)}`);
  } else {
    s.warn(`config: invalid layout '${layout}' (split|tab)`);
  }
  const multiRole = cfg(ctx, 'multi_role', 'on', env);
  if (multiRole !== 'on' && multiRole !== 'off') {
    s.warn(`config: multi_role='${multiRole}' is not on|off (cross-role reuse stays off until it is)`);
  }
  const capRaw = cfg(ctx, 'split_max_panes', '4', env);
  const cap = splitCap(ctx, env);
  if (!/^[0-9]+$/.test(capRaw)) s.warn(`config: split_max_panes='${capRaw}' is not a number (using 4)`);
  else if (cap < 2) s.warn(`config: split_max_panes=${cap} leaves no room next to the caller; every worker will overflow into herd tabs (set 2 or more)`);
  else s.ok(`config: split_max_panes=${cap} split_min_pane=${splitMin(ctx, env)}`);
  const mwRaw = cfg(ctx, 'max_workers', '3', env);
  const mw = maxWorkers(ctx, env);
  if (!/^[0-9]+$/.test(mwRaw)) s.warn(`config: max_workers='${mwRaw}' is not a number (using 3)`);
  else if (Number(mw) === 0) s.ok('config: max_workers=0 (no cap on live workers)');
  else s.ok(`config: max_workers=${mw} (orchestrator + ${mw} workers)`);
  if (lanesEnabled(ctx, env)) doctorLaneWarnings(ctx, env, cwd, s);
  else s.ok('config: lanes=off (per-role reuse unchanged)');
  doctorDiscardedModels(ctx, env, cwd, s);
  doctorModelPairs(ctx, env, cwd, s);
  laneArgsIgnoredWarnings(ctx, env, cwd, s);
  doctorCodexNetworkWarnings(ctx, env, cwd, s);
  const minRaw = cfg(ctx, 'split_min_pane', '0.18', env);
  if (!/^0?\.[0-9]+$/.test(minRaw)) s.warn(`config: split_min_pane='${minRaw}' must be a fraction like 0.18 (using 0.18)`);
  const hlmRaw = cfg(ctx, 'herd_label_max', '16', env);
  if (!/^[0-9]+$/.test(hlmRaw)) s.warn(`config: herd_label_max='${hlmRaw}' is not a number (using 16)`);
  else s.ok(`config: herd_label='${cfg(ctx, 'herd_label', '{roles}', env)}' herd_label_max=${herdLabelMax(ctx, env)}`);
  // Instruction block + hooks: without them the orchestrator forgets to
  // delegate when a prompt does not say "herdr" or "workers". `setup`
  // writes both.
  const root = projectRoot(env, cwd);
  const t = setupTargetExisting(root);
  if (t) s.ok(`instruction block present in ${path.basename(t)}`);
  else s.warn(`no herdr-agents block in AGENTS.md/CLAUDE.md: run '${ENTRY_SCRIPT} setup' (writes the delegation rules between <!-- herdr-agents:start/end --> markers)`);
  if (isFile(path.join(root, '.claude', 'settings.json')) && settingsHasDoctorHook(path.join(root, '.claude', 'settings.json'))) {
    s.ok('Claude hooks present in .claude/settings.json');
  } else {
    s.warn(`no herdr-agents hooks in .claude/settings.json: run '${ENTRY_SCRIPT} setup' (UserPromptSubmit reminder + SessionStart doctor)`);
  }
  process.stdout.write(`first_run: ${projectIsFirstRun(ctx, env, cwd) ? 'true' : 'false'}\n`);
  process.stdout.write(`${s.okCount} ok, ${s.warnCount} warning(s)\n`);
}

// readTextFile that reads '' when the file is unreadable (the bash diff
// against a vanishing file).
function readTextFileSafe(file) {
  try { return readTextFile(file); } catch { return ''; }
}

// cmd_doctor port (:1755): `doctor --fix [--panes 2|3|4] [--user|--session]`
// rewrites the project (or user, or session) file, then runs the check in
// the same process (where the bash re-execs itself, unless
// HERDR_AGENTS_LIB=1).
export function cmdDoctor(args, ctx, env = process.env, cwd = process.cwd()) {
  let doFix = 0;
  let fixPanes = '';
  let fixWhere = 'project';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--fix') doFix = 1;
    else if (a === '--panes') {
      i += 1;
      // bash `fix_panes="${2:-}"`: a bare trailing --panes reads as empty
      // (the bash set -e on `shift 2` would exit 1 without a message; the
      // JS keeps parsing and lets the file value / the die below decide).
      fixPanes = args[i] ?? '';
    } else if (a === '--user') fixWhere = 'user';
    else if (a === '--session') fixWhere = 'session';
    else throw new DieError(`doctor: unknown option '${a}'`, 2);
  }
  if (doFix === 1) {
    doctorFix(fixWhere, fixPanes, ctx, env, cwd);
    if (env.HERDR_AGENTS_LIB === '1') return;
    // bash: exec bash "$0" doctor — a fresh process reloads the config, so
    // the check sees the file the fix just wrote.
    doctorCheck(loadConfig(env, cwd), env, cwd);
    return;
  }
  doctorCheck(ctx, env, cwd);
}
