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
  laneCapacitySum, laneKey, laneNames, laneRolesCsv, lanesEnabled, legacyPresetSignature,
  LEGACY_PRESETS, maxWorkers, paneMode, panesValue,
} from '../lanes.mjs';
import { findExecutable, homeDir, projectRoot, readTextFile, runCli } from '../platform.mjs';
import { fmGet, isReviewRole, roleDirs, roleFile, roleIsEdit } from '../roles.mjs';
import { splitCap, splitMin } from '../layout.mjs';
import { herdLabelMax } from '../herdtabs.mjs';
import { setupHookDoctor } from '../setuptext.mjs';
import { kindExe } from '../kinds.mjs';
import { ownProviderDoctorLines } from '../ownproviders.mjs';
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
// role kinds without lane.<name>.kind, the dropped lane model/effort (as an
// ok line, so the orchestrator sees the resolution decision), the old
// preset lanes, the orphan lane keys (a lane.<l>.<attr> whose
// lane does not exist), the max_workers / split_max_panes alignment and
// the role.planner.* leftovers.
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
      // A lane model/effort sitting in a layer below the layer that set the
      // lane kind was chosen for another kind: resolution drops it; report
      // the decision as ok so the orchestrator can see it.
      const kkey = laneKey(lane, 'kind');
      const klayer = cfgLayerRank(ctx, kkey, env);
      for (const a of ['model', 'effort']) {
        const akey = laneKey(lane, a);
        const avalue = cfg(ctx, akey, '', env);
        if (avalue === '') continue;
        if (cfgLayerRank(ctx, akey, env) < klayer) {
          say.ok(`lanes: lane '${lane}' kind ${laneKind} (${cfgSource(ctx, kkey, env)}); ignored lane ${a} ${avalue} from ${cfgSource(ctx, akey, env)} (another kind)`);
        }
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
  const orphanRe = /^lane_(.+)_(roles|kind|model|effort|approvals|panes)$/;
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
  // the config layers set (compgen lists them sorted), by source.
  for (const key of [...ctx.entries.keys()].filter((k) => k.startsWith('role_planner_')).sort()) {
    const src = cfgSource(ctx, key, env);
    if (src === 'user' || src === 'project' || src === 'env') {
      say.warn(`config: ${key} is set (${src}) but the planner is the orchestrator and opens no pane. Remove it (doctor --fix).`);
    }
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
// the a/<file> / b/<file> labels of the same diff format).
export function doctorFix(where, flag, ctx, env = process.env, cwd = process.cwd()) {
  const dest = configFileFor(where, env, cwd);
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

// cmd_doctor port (:1755): `doctor --fix [--panes 2|3|4] [--user]` rewrites
// the project (or user) file, then runs the check in the same process
// (where the bash re-execs itself, unless HERDR_AGENTS_LIB=1).
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
