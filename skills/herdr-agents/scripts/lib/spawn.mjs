// The `spawn` command (bash port): resolve kind/model/effort/approvals
// of a role (same order as bash `cmd_spawn` :3377-3607 and spec 5.3),
// decide the lane (capacity per lane — reuse the first idle worker,
// open another while there is room, otherwise busy) or reuse by role,
// enforce the worker cap, place the pane (split, herd tab or a given
// `--pane`), start the agent with the `agent_pane_busy` retry and register
// the worker in the roster.
//
// Behavior mirrors the original bash implementation (:735-736, :1507-1523,
// :3198-3376, :3377-3607). The lane decision, the worker cap, the split
// anchor and the herd tabs come from the already-ported modules (lanes,
// layout, herdtabs); regrid after spawn is decision 5 (one commented
// extension point in cmdSpawn).
import fs from 'node:fs';
import { DieError, cfg, EFFORT_LADDER } from './config.mjs';
import { runCli, findExecutable } from './platform.mjs';
import { hasWord } from './text.mjs';
import {
  agentFamily, clampTo, effortRank, kindApprovalArgs, kindContextArgs,
  kindEffortArgs, kindEffortCeiling, kindExe, kindModelArgs,
} from './kinds.mjs';
import { codexEffortCeiling, codexModelCeiling, resolveModel } from './models.mjs';
import {
  fmGet, historyHasEdit, isReviewRole, resolveRole, roleFile, roleIsEdit,
} from './roles.mjs';
import {
  customLanesPresent, enforceWorkerCap, flexExtra, laneAttr, laneDecide, laneKey, lanesEnabled,
  liveBurstWorkers, paneMode, panesValue, spawnKindLayer, splitRoles,
} from './lanes.mjs';
import { resolveRoleSettings } from './resolve.mjs';
import {
  agentRead, agentState, callerAgentName, HERDR_TIMEOUT_MS, liveAgents, paneSplit,
} from './herdr.mjs';
import {
  dieFriction, lastReport, nowStamp, rosterAppend, rosterLine, rosterRemove,
  rosterSetRole, rosterRows, stateDir, warn,
} from './state.mjs';
import { pickSplitAnchor, restoreFocusIfStolen, uiFocusedPane } from './layout.mjs';
import { herdTabPane, herdTabsRelabel, jqPretty } from './herdtabs.mjs';
import { autoRegrid as runAutoRegrid } from './regrid.mjs';

// ---------- names ----------

// approvals_rank :3195: ask=1, edits=2, full=3; unknown is 0 and satisfies
// nothing.
export function approvalsRank(mode) {
  if (mode === 'ask') return 1;
  if (mode === 'edits') return 2;
  if (mode === 'full') return 3;
  return 0;
}

// agent_name_taken :735: a live agent (herdr agent list) already has this
// name.
export function agentNameTaken(name, env = process.env) {
  return liveAgents(env).some((a) => a && (a.name ?? '') === name);
}

// unique_name :736: <base>, <base>-2, <base>-3… — the first name that is
// not live.
export function uniqueName(base, env = process.env) {
  let n = base;
  let i = 2;
  while (agentNameTaken(n, env)) { n = `${base}-${i}`; i += 1; }
  return n;
}

// ensure_orchestrator_name :1512: the caller's own agent is named after
// `orchestrator_name` (default `orchestrator`). Idempotent; silent when the
// caller pane hosts no recognized agent. Returns the (possibly renamed)
// name, '' when none.
export function ensureOrchestratorName(ctx, env = process.env) {
  if ((env.HERDR_PANE_ID ?? '') === '') return '';
  const want = cfg(ctx, 'orchestrator_name', 'orchestrator', env);
  const r = runCli('herdr', ['agent', 'get', env.HERDR_PANE_ID], { env, timeoutMs: HERDR_TIMEOUT_MS });
  if (r.notFound || r.status !== 0) return ''; // the pane hosts no agent
  const cur = callerAgentName(env);
  if (cur === want || cur.startsWith(`${want}-`)) return cur;
  const n = uniqueName(want, env);
  const rr = runCli('herdr', ['agent', 'rename', env.HERDR_PANE_ID, n], { env, timeoutMs: HERDR_TIMEOUT_MS });
  if (rr.notFound || rr.status !== 0) {
    warn(`could not rename the caller agent to '${n}'`);
    return '';
  }
  return n;
}

// ---------- resolution chains (spec 5.3) ----------

// resolved_role_kind :3216: role config (any layer), else frontmatter.
// Does not read the lane key.
export function resolvedRoleKind(role, ctx, env = process.env, cwd = process.cwd()) {
  let v = cfg(ctx, `role_${String(role).replace(/-/g, '_')}_kind`, '', env);
  if (v === '') {
    const f = roleFile(role, env, cwd);
    if (f) v = fmGet(f, 'kind');
  }
  return v;
}

// resolve_spawn_effort :3222: the effort spawn would use with no flag —
// lane effort (same layer or above the kind's), role.<r>.effort,
// effort.<kind>, frontmatter; clamped to the kind ceiling and max_effort,
// and for codex to the ceiling of `model` (the session's).
export function resolveSpawnEffort(role, lane, kind, kindLayer = '', ctx, env = process.env, cwd = process.cwd(), model = '') {
  let effort = laneAttr(ctx, lane, 'effort', kindLayer === '' ? null : kindLayer, env);
  if (effort === '') effort = cfg(ctx, `role_${String(role).replace(/-/g, '_')}_effort`, '', env);
  if (effort === '') effort = cfg(ctx, `effort_${kind}`, '', env);
  if (effort === '') {
    const f = roleFile(role, env, cwd);
    if (f) effort = fmGet(f, 'effort');
  }
  if (effort !== '' && hasWord(EFFORT_LADDER.join(' '), effort)) {
    effort = clampTo(clampTo(effort, kindEffortCeiling(kind)), cfg(ctx, 'max_effort', '', env));
    if (kind === 'codex') effort = clampTo(effort, codexEffortCeiling(model, env));
  }
  return effort;
}

// ---------- reuse (no lane) ----------

// The native args a spawn passes from the configuration layers: the
// `args.<kind>` tokens followed by the `lane.<lane>.args` tokens (a lane
// spawn) or the `role.<role>.args` tokens (everything else), joined with a
// single space. Recorded in roster column 14 at the spawn and compared by
// the reuse checks: the live process keeps the args it opened with, so a
// config/session change after the spawn cannot silently swap them.
function configNativeArgs(kind, lane, role, ctx, env = process.env) {
  const scoped = lane !== ''
    ? cfg(ctx, laneKey(lane, 'args'), '', env)
    : cfg(ctx, `role_${String(role).replace(/-/g, '_')}_args`, '', env);
  const tokens = [];
  for (const v of [cfg(ctx, `args_${kind}`, '', env), scoped]) {
    if (v === '') continue;
    for (const a of v.split(/\s+/).filter((x) => x !== '')) tokens.push(a);
  }
  return tokens.join(' ');
}

// find_reusable :3206: an idle/done worker of the same role (always) or,
// with multi_role=on, of another role when kind, cwd and resolved model
// match, the worker's approvals are at least the request, and the roster
// line has the model/approvals/roles columns. A worker that has edited
// (EDIT_ROLES or mode: edit, now or in `roles`) is never reused as a
// review role. Old 8-column lines are only reused for the same role. In
// both cases the roster column 14 (the native args the worker opened with)
// must equal the args this spawn would build now.
// Returns:
//   { name }                         — reuse (bash rc 0, the name);
//   { unavailable: { cause, name } } — a same-role match cannot be queried
//                                      (bash rc 4: do not spawn a copy);
//   null                             — nothing to reuse (bash rc 1).
export function findReusable(role, kind, workerCwd, name = '', wantModel = '', wantApprovals = '', ctx, env = process.env, cwd = process.cwd()) {
  const multi = cfg(ctx, 'multi_role', 'on', env);
  const sd = stateDir(ctx, env, cwd);
  let blocked = null;
  let crossHit = '';
  for (const line of rosterRows(sd)) {
    if (line === '') continue;
    const f = line.split('\t');
    const nm = f[0] ?? '';
    const k = f[2] ?? '';
    const r = f[3] ?? '';
    const c = f[6] ?? '';
    const wModel = f.length >= 9 ? (f[8] ?? '') : '';
    const wApprovals = f.length >= 10 ? (f[9] ?? '') : '';
    const wRoles = f.length >= 11 ? (f[10] ?? '') : '';
    if (nm === '') continue;
    if (name !== '' && nm !== name) continue;
    if (k !== kind || c !== workerCwd) continue;
    const isSame = r === role;
    if (isSame) {
      // Same-role reuse compares the recorded model and approvals when the
      // row has the columns: the model as a string ('' only
      // matches '') and the approvals rank ≥ the request ('ask' when
      // empty). Old 8-column lines keep kind + cwd only, as before.
      if (f.length >= 9 && wModel !== wantModel) continue;
      if (f.length >= 10) {
        const reqRank = approvalsRank(wantApprovals !== '' ? wantApprovals : 'ask');
        if (approvalsRank(wApprovals) < reqRank) continue;
      }
    } else {
      if (multi !== 'on') continue;
      if (f.length < 11) continue; // old 8-column lines: same role only
      // Both models recorded and equal (bash :3318): never borrow a session
      // started with another model.
      if (wantModel === '' || wModel === '' || wModel !== wantModel) continue;
      const req = wantApprovals !== '' ? wantApprovals : 'ask';
      if (wApprovals === '') continue;
      const reqRank = approvalsRank(req);
      if (reqRank <= 0) continue;
      if (approvalsRank(wApprovals) < reqRank) continue;
      if (isReviewRole(role) && (roleIsEdit(r, env, cwd) || historyHasEdit(wRoles, env, cwd))) continue;
    }
    // Roster column 14 holds the native args the process opened with
    // (a line without the column reads as ''); the live session still runs
    // with them, so a config or session change after the spawn must not
    // silently swap the worker's args — reuse only when they match the
    // args this spawn would build now.
    if ((f.length >= 14 ? (f[13] ?? '') : '') !== configNativeArgs(kind, '', role, ctx, env)) continue;
    // A recorded report path pointing at an empty (or missing) file is a
    // pending report — the worker is not ready to be reused.
    const rep = lastReport(sd, nm);
    if (rep !== '') {
      let size = null;
      try { size = fs.statSync(rep).size; } catch { size = null; }
      if (size === null || size === 0) continue;
    }
    const st = agentState(nm, env);
    if (st.state === 'unavailable') {
      // Only a same-role match blocks the spawn (rc 4); an unqueryable
      // sibling must not prevent a new worker of this role.
      if (isSame && !blocked) blocked = { cause: st.cause, name: nm };
      continue;
    }
    if (st.state === 'idle' || st.state === 'done') {
      if (isSame) return { name: nm }; // an idle same-role match wins now
      if (crossHit === '') crossHit = nm;
    }
  }
  if (blocked) return { unavailable: blocked };
  if (crossHit !== '') return { name: crossHit };
  return null;
}

// The capacity-0 lane refusal (the flex presets only): the lane takes a
// temporary worker only, and no burst slot is free. A role in flex_roles
// is told to release a live temporary worker or raise flex_extra; a role
// outside flex_roles may not use the temporary panel at all.
function tempLaneBusy(lane, role, sd, ctx, env) {
  const rolesCsv = cfg(ctx, 'flex_roles', 'reviewer,documenter', env);
  if (!splitRoles(rolesCsv).includes(role)) {
    warn(`role '${role}' may not use the temporary panel (flex_roles=${rolesCsv})`);
    return;
  }
  const live = liveBurstWorkers(sd, env);
  const remedy = live.length > 0 ? `Release one (release ${live[0]}), or raise flex_extra.` : 'Raise flex_extra.';
  warn(`lane '${lane}' only takes a temporary worker (pane_mode=flex) and none is free: flex_extra=${flexExtra(ctx, env)}, live temporary workers: ${live.length > 0 ? live.join(', ') : 'none'}. ${remedy}`);
}

// emit_reuse :3344: when the role changes, retarget the roster line, then
// print the reused spawn JSON (includes previous_role). Same-role reuse
// leaves the line as it is. Returns false when the name has no roster row.
export function emitReuse(name, role, kind, ctx, env = process.env, cwd = process.cwd()) {
  const sd = stateDir(ctx, env, cwd);
  let eline = rosterLine(sd, name);
  if (eline === '') return false;
  const prev = eline.split('\t')[3] ?? '';
  if (prev !== role) {
    rosterSetRole(sd, name, role);
    eline = rosterLine(sd, name);
  }
  const f = eline.split('\t');
  process.stdout.write(jqPretty({
    name,
    pane_id: f[1] ?? '',
    kind,
    role,
    family: f[4] ?? '',
    reused: true,
    previous_role: prev,
    status: 'ready',
  }));
  return true;
}

// Synchronous 1 s wait for the agent_pane_busy retry (Atomics, like the
// roster lock; works on Node and Bun without an event loop).
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---------- the command ----------

// herdr agent start … — bash merges 2>&1 and greps the output, so the
// caller needs the merged text. Returns { ok, out }.
function agentStart(name, kind, pane, timeout, nativeArgs, env) {
  const args = ['agent', 'start', name, '--kind', kind, '--pane', pane, '--timeout', String(timeout)];
  if (nativeArgs.length > 0) args.push('--', ...nativeArgs);
  const to = Number(timeout);
  const r = runCli('herdr', args, { env, timeoutMs: Number.isFinite(to) ? to + 30_000 : 30_000 });
  return { ok: !r.notFound && r.status === 0, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

// cmd_spawn() port (:3377-3607). argv is everything after the role.
// Errors follow the bash codes: 12 planner, 3 role/lane/name, 2 usage,
// 10 busy lane, 13 kind mismatch, 4 herdr failures, 5 locked lane,
// 8 worker cap (via DieError, caught at the entry), 7 blocked at startup.
export function cmdSpawn(argv, ctx, env = process.env, cwd = process.cwd()) {
  const role = argv[0];
  if (role === undefined || role === '') dieFriction('spawn: missing role', 2);
  let name = '';
  let kind = '';
  let kindSet = 0;
  let direction = '';
  let ratio = '';
  let cwdArg = cwd;
  let pane = '';
  let timeout = '';
  let effort = '';
  let model = '';
  let modelSpec = '';
  let approvals = '';
  let reuse = '';
  let tabLabel = '';
  const nativeArgs = [];
  {
    const rest = argv.slice(1);
    outer: for (let i = 0; i < rest.length; i += 1) {
      const a = rest[i];
      if (a === '--') { for (let j = i + 1; j < rest.length; j += 1) nativeArgs.push(rest[j]); break outer; }
      const valued = a === '--tab-label' || a === '--effort' || a === '--model' || a === '--approvals'
        || a === '--name' || a === '--kind' || a === '--direction' || a === '--ratio'
        || a === '--cwd' || a === '--pane' || a === '--timeout';
      if (!valued) {
        if (a === '--reuse') { reuse = 'on'; continue; }
        if (a === '--fresh') { reuse = 'off'; continue; }
        dieFriction(`spawn: unknown option ${a}`, 2);
      }
      const v = rest[i + 1];
      if (v === undefined) dieFriction(`spawn: ${a} expects a value`, 2);
      if (a === '--tab-label') tabLabel = v;
      else if (a === '--effort') effort = v;
      else if (a === '--model') model = v;
      else if (a === '--approvals') approvals = v;
      else if (a === '--name') name = v;
      else if (a === '--kind') {
        // An empty --kind would pass as "no flag" to the resolution while
        // still ranking as a flag for the lane model/effort rule.
        if (v === '') dieFriction('spawn: --kind expects a kind', 2);
        kind = v;
        kindSet = 1;
      }
      else if (a === '--direction') direction = v;
      else if (a === '--ratio') ratio = v;
      else if (a === '--cwd') cwdArg = v;
      else if (a === '--pane') pane = v;
      else timeout = v;
      i += 1;
    }
  }
  ensureOrchestratorName(ctx, env);
  resolveRole(role, env, cwd);
  if (role === 'planner') {
    dieFriction('spawn planner: the orchestrator is the planner and does not open a pane. Plan in this session.', 12);
  }
  // Resolution chain (lib/resolve.mjs, shared with the `roles` table):
  // flag → lane → role.<r>.<attr> → frontmatter → kind default. Spawn keeps
  // its own errors here and the post-chain steps (clamp, codex ceiling,
  // resolveModel) unchanged.
  const res = resolveRoleSettings(role, ctx, env, cwd, { kind, model, effort, approvals });
  const lane = res.lane;
  if (lane === '' && lanesEnabled(ctx, env)) {
    // panes=2 has no review lane at all: the orchestrator reviews (its
    // model family is picked by hand). Other roles keep the generic
    // message.
    if (panesValue(ctx, env) === '2' && isReviewRole(role) && !customLanesPresent(ctx, env)) {
      dieFriction(`spawn: with panes=2 the orchestrator reviews (pick its model family by hand); role '${role}' has no lane. Use panes=3 or 4, or pane_mode=flex for a temporary reviewer.`, 3);
    }
    dieFriction(`spawn: role '${role}' is not in any lane (panes=${panesValue(ctx, env)}). Add it with lane.<name>.roles, or set lanes=off.`, 3);
  }
  kind = res.kind;
  if (kind === '') dieFriction(`role ${role} has no default kind; pass --kind`, 3);
  const kindLayer = spawnKindLayer(ctx, role, lane, kindSet !== 0, env);
  if (!findExecutable(kindExe(kind), env)) warn(`executable '${kindExe(kind)}' not found in PATH; herdr agent start may fail`);
  if (role === 'sub-orchestrator' && kind === 'codex'
    && !cfg(ctx, 'args_codex', '', env).includes('danger-full-access')) {
    warn("sub-orchestrator on codex: its sandbox blocks the Herdr socket (every 'herdr' call fails with Operation not permitted). Use --kind claude, or set args.codex=-s danger-full-access if you accept that.");
  }
  effort = res.effort;
  modelSpec = res.modelSpec;
  approvals = res.approvals;
  if (approvals !== 'ask' && approvals !== 'edits' && approvals !== 'full') {
    dieFriction(`invalid approvals '${approvals}' (ask|edits|full)`, 2);
  }
  if (timeout === '') timeout = cfg(ctx, 'spawn_timeout', '60000', env);
  if (effort !== '') {
    if (!hasWord(EFFORT_LADDER.join(' '), effort)) dieFriction(`invalid effort '${effort}' (low|medium|high|xhigh|max)`, 2);
    const ceiling = kindEffortCeiling(kind);
    const maxEffort = cfg(ctx, 'max_effort', 'max', env);
    const clamped = clampTo(clampTo(effort, ceiling), maxEffort);
    if (clamped !== effort) {
      warn(`effort '${effort}' clamped to '${clamped}' (kind ceiling ${ceiling}, max_effort ${maxEffort})`);
      effort = clamped;
    }
  }
  if (modelSpec !== '') model = resolveModel(kind, modelSpec, effort, env);
  // codex: the model's own ceiling (xhigh when the cache does not list it),
  // also with no model spec (the CLI's default model).
  if (kind === 'codex' && effort !== '') {
    const mc = codexEffortCeiling(model, env);
    if (effortRank(effort) > effortRank(mc)) {
      if (codexModelCeiling(model, env) !== '') {
        warn(`codex model ${model} supports up to '${mc}'; effort '${effort}' clamped`);
      } else {
        warn(`codex model ${model || '(CLI default)'} is not in ~/.codex/models_cache.json; effort '${effort}' clamped to '${mc}'`);
      }
      effort = mc;
    }
  }
  if (reuse === '') reuse = cfg(ctx, 'reuse_workers', 'on', env);

  const sd = stateDir(ctx, env, cwd);
  // Lane decision (lanes on, no --pane): capacity — reuse the first
  // idle worker, open another while there is room, otherwise busy. Gone
  // rows are removed (today's warning) and never count against the
  // capacity. A temporary (burst) worker opens when the decision is
  // busy (the lane is full, no idle) or the lane holds no resident
  // worker at all (capacity 0), and only in the flex mode, only for a
  // flex_roles role, and only while fewer than flex_extra temporary
  // workers are live; otherwise the busy exit 10 (the strict mode never
  // opens a burst).
  let burst = 0;
  if (lane !== '' && pane === '') {
    const d = laneDecide(ctx, lane, role, env, cwd, reuse === 'on');
    for (const g of d.gone) {
      rosterRemove(sd, g);
      warn(`lane '${lane}' worker '${g}' is gone; opening a new pane`);
    }
    burst = paneMode(ctx, env) === 'flex'
      && splitRoles(cfg(ctx, 'flex_roles', 'reviewer,documenter', env)).includes(role)
      && (d.decision === 'busy' || (d.capacity === 0 && d.decision === 'absent'))
      && liveBurstWorkers(sd, env).length < flexExtra(ctx, env)
        ? 1
        : 0;
    switch (d.decision) {
      case 'reuse': {
        const line = rosterLine(sd, d.name);
        const lf = line.split('\t');
        const actualKind = lf[2] ?? '';
        if (laneAttr(ctx, lane, 'kind', null, env) === '') {
          // No lane.<l>.kind: the first spawn locked the process; a
          // different kind, model or effort must not reuse it with exit 0.
          const sessionRole = lf[3] ?? '';
          const sessionModel = lf.length >= 9 ? (lf[8] ?? '') : '';
          const sessionEffort = resolveSpawnEffort(sessionRole, lane, actualKind, kindLayer, ctx, env, cwd, sessionModel);
          const mismatch = actualKind !== kind
            || sessionModel !== model
            || sessionEffort !== effort;
          if (mismatch) {
            process.stdout.write(`${JSON.stringify({
              status: 'kind-mismatch', lane, name: d.name,
              session_kind: actualKind, requested_kind: kind,
              session_model: sessionModel, requested_model: model,
              session_effort: sessionEffort, requested_effort: effort,
            })}\n`);
            warn(`lane '${lane}' worker '${d.name}' is ${actualKind} (model ${sessionModel !== '' ? sessionModel : '?'}, effort ${sessionEffort !== '' ? sessionEffort : '?'}); this role wants ${kind} (model ${model !== '' ? model : '?'}, effort ${effort !== '' ? effort : '?'}). Set lane.${lane}.kind or release the lane, then spawn again.`);
            process.exit(13);
          }
        } else if (actualKind !== kind) {
          // lane.<l>.kind is set but the live process runs another CLI:
          // the key does not retarget a running session.
          process.stdout.write(`${JSON.stringify({
            status: 'kind-mismatch', lane, name: d.name,
            session_kind: actualKind, requested_kind: kind,
          })}\n`);
          warn(`lane '${lane}' worker '${d.name}' runs ${actualKind} but lane.${lane}.kind is ${kind}. Release the lane ('release ${d.name} --close'), then spawn again.`);
          process.exit(13);
        }
        // The roster column 14 holds the native args the idle worker opened
        // with (a line without the column reads as ''); the lane session is
        // shared by its roles, so a change after the spawn cannot silently
        // swap them.
        const sessionArgs = lf.length >= 14 ? (lf[13] ?? '') : '';
        const wantedArgs = configNativeArgs(kind, lane, role, ctx, env);
        if (sessionArgs !== wantedArgs) {
          process.stdout.write(`${JSON.stringify({
            status: 'kind-mismatch', lane, name: d.name,
            session_args: sessionArgs, requested_args: wantedArgs,
          })}\n`);
          warn(`lane '${lane}' worker '${d.name}' was started with other native args ('${sessionArgs}'); this spawn wants '${wantedArgs}'. Release the lane, then spawn again.`);
          process.exit(13);
        }
        emitReuse(d.name, role, actualKind, ctx, env, cwd);
        warn(`reusing idle lane '${lane}' worker '${d.name}' as ${role}; its session already holds earlier briefs`);
        return;
      }
      case 'busy': {
        if (burst === 1) break; // the temporary worker opens below
        // --fresh with an idle worker and a full lane: today's busy.
        if (d.candidate !== '' && reuse !== 'on') {
          process.stdout.write(`${JSON.stringify({ status: 'busy', lane, name: d.candidate })}\n`);
          warn(`lane '${lane}' already has idle worker '${d.candidate}'. Release it before --fresh, or dispatch on it. Run 'wait ${d.candidate}', then dispatch.`);
          process.exit(10);
        }
        if (d.capacity === 0) {
          // A capacity-0 lane holds a temporary worker only (flex);
          // with no burst slot left it is full.
          process.stdout.write(`${JSON.stringify({ status: 'busy', lane, name: d.name })}\n`);
          tempLaneBusy(lane, role, sd, ctx, env);
          process.exit(10);
          break;
        }
        process.stdout.write(`${JSON.stringify({ status: 'busy', lane, name: d.name })}\n`);
        warn(`lane '${lane}' is full (${d.n} of ${d.capacity}: ${d.occupants.join(' ')}). Run 'wait ${d.name}', then dispatch.`);
        process.exit(10);
        break;
      }
      case 'open':
        break;
      case 'absent':
        if (d.capacity === 0 && burst === 0) {
          // A capacity-0 lane holds a temporary worker only (flex);
          // with no burst slot left it is full.
          process.stdout.write(`${JSON.stringify({ status: 'busy', lane, name: d.name })}\n`);
          tempLaneBusy(lane, role, sd, ctx, env);
          process.exit(10);
        }
        break;
      case 'unavailable':
        dieFriction(`lane '${lane}' worker '${d.name}' matches but herdr agent get failed (${d.cause}). Not spawning a replacement; it may still be live.`, 4);
        break;
      case 'locked':
        dieFriction(`lane '${lane}' worker '${d.name}' has edited and cannot take review role '${role}'.`, 5);
        break;
      default:
        dieFriction(`spawn: unexpected lane decision '${d.decision}'`, 4);
    }
  }
  // Reuse without a lane (reuse_workers=on or --reuse, no --pane): the bash
  // `elif` after the lane block, so a role in a lane never reaches it (with
  // an empty lane it spawns, under the max_workers cap).
  if (lane === '' && reuse === 'on' && pane === '') {
    const found = findReusable(role, kind, cwdArg, name, model, approvals, ctx, env, cwd);
    if (found && found.name !== undefined) {
      const prevRole = rosterLine(sd, found.name).split('\t')[3] ?? '';
      emitReuse(found.name, role, kind, ctx, env, cwd);
      if (prevRole === role) {
        warn(`reusing idle worker '${found.name}' (${kind}, ${role}); its session already holds earlier briefs`);
      } else {
        warn(`reusing idle worker '${found.name}' (${kind}, was ${prevRole}, now ${role}); its session already holds earlier briefs`);
      }
      return;
    }
    if (found && found.unavailable) {
      dieFriction(`worker '${found.unavailable.name}' matches this role, kind and cwd but herdr agent get failed (${found.unavailable.cause}). Not spawning a replacement; it may still be live.`, 4);
    }
  }
  enforceWorkerCap(ctx, env, cwd);
  // A --name already live (any pane or workspace) gets a unique suffix
  // instead of dying; a computed name is already unique.
  if (name !== '') {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) dieFriction(`invalid agent name '${name}' (must match [a-z][a-z0-9_-]{0,31})`, 2);
    if (agentNameTaken(name, env)) {
      const taken = name;
      name = uniqueName(name, env);
      if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) dieFriction(`invalid agent name '${name}' (must match [a-z][a-z0-9_-]{0,31})`, 2);
      warn(`agent name '${taken}' is taken by another pane or workspace; using '${name}'`);
    }
  } else {
    name = uniqueName(lane !== '' ? lane : role, env);
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) dieFriction(`invalid agent name '${name}' (must match [a-z][a-z0-9_-]{0,31})`, 2);
    if (agentNameTaken(name, env)) dieFriction(`agent name '${name}' is already live`, 3);
  }
  const wctx = cfg(ctx, 'worker_context', 'full', env);
  const built = [
    ...kindContextArgs(kind, wctx),
    ...kindApprovalArgs(kind, approvals),
    ...kindModelArgs(kind, model, effort),
    ...kindEffortArgs(kind, effort, model, env),
  ];
  // The configured native args (args.<kind> then lane.<lane>.args or
  // role.<role>.args) come after the skill args and before the args after
  // --; the joined string is what roster column 14 records.
  const native = configNativeArgs(kind, lane, role, ctx, env);
  if (native !== '') for (const a of native.split(/\s+/)) built.push(a);
  const agentArgs = [...built, ...nativeArgs];
  let created = 0;
  let placement = 'given';
  let autoRegrid = 0;
  const layout = cfg(ctx, 'layout', 'split', env);
  const focusBefore = uiFocusedPane(env);
  if (tabLabel !== '' && pane !== '') warn('--tab-label ignored: --pane places the worker in a given pane');
  if (pane === '') {
    let anchor = 'overflow';
    let autoDir = 'layout';
    // split layout: largest pane of caller + workers of this tab, unless
    // the tab is full (split_max_panes) or no pane can be halved
    // (split_min_pane) → overflow into the herd tabs like layout=tab.
    if (layout !== 'tab' && tabLabel === '') {
      const res = pickSplitAnchor(ctx, env, cwd);
      if (res.overflow !== undefined) { anchor = 'overflow'; autoDir = res.overflow; }
      else { anchor = res.anchor; autoDir = res.direction; }
    }
    // An explicit --direction forces a split of the caller's pane.
    if (anchor === 'overflow' && direction !== '' && tabLabel === '') anchor = env.HERDR_PANE_ID ?? '';
    if (anchor === 'overflow' || anchor === '') {
      if (layout !== 'tab' && tabLabel === '') {
        warn(`caller tab has no room for another pane (${autoDir}); placing '${name}' in a herd tab`);
      }
      const t = herdTabPane(ctx, cwdArg, tabLabel, role, env, cwd);
      pane = t.pane;
      created = 1;
      direction = '';
      placement = 'herd';
      autoRegrid = 1;
    } else {
      if (direction === '' && ratio === '') autoRegrid = 1;
      if (direction === '') direction = autoDir;
      const s = paneSplit(anchor, direction, cwdArg, env, ratio !== '' ? ratio : '0.5');
      if (!s.ok) dieFriction('pane split failed', 4);
      pane = s.pane;
      created = 1;
      placement = 'split';
    }
  }
  // A freshly split pane may not have reached its shell prompt yet
  // (agent_pane_busy); retry for a few seconds before giving up.
  let blocked = 0;
  let tries = 0;
  for (;;) {
    const r = agentStart(name, kind, pane, timeout, agentArgs, env);
    if (r.ok) break;
    if (r.out.includes('agent_not_ready')) { blocked = 1; break; }
    if (r.out.includes('agent_pane_busy') && tries < 15) { tries += 1; sleepSync(1000); continue; }
    process.stderr.write(`${r.out.replace(/\n+$/, '')}\n`);
    dieFriction(`agent start failed for ${name} (${kind}) in pane ${pane}; pane left open for inspection`, 4);
  }
  restoreFocusIfStolen(focusBefore, pane, direction, env);
  const family = agentFamily(kind, model);
  // Roster line: the 12 base columns, then column 13 (the `burst` marker
  // for temporary workers — present even when empty, since writing column
  // 14 requires it) and column 14 (the native args the worker opened with,
  // '' when none; a line without it reads as '').
  const rosterFields = [name, pane, kind, role, family, String(created), cwdArg, nowStamp(), model, approvals !== '' ? approvals : 'ask', role, lane, burst === 1 ? 'burst' : '', native];
  rosterAppend(sd, rosterFields);
  if (placement === 'herd') {
    try { herdTabsRelabel(ctx, env, cwd); }
    catch { warn('relabel of the herd tabs failed (see friction)'); }
  }
  const out = {
    name,
    pane_id: pane,
    kind,
    role,
    family,
    created_pane: created === 1,
    layout,
    placement,
    effort: effort !== '' ? effort : 'default',
    model: model !== '' ? model : 'default',
    model_spec: modelSpec,
    approvals: approvals !== '' ? approvals : 'ask',
    agent_args: agentArgs.join(' '),
    status: blocked === 1 ? 'blocked_at_startup' : 'ready',
  };
  if (burst === 1) out.burst = true;
  process.stdout.write(jqPretty(out));
  // `(cmd_regrid) >/dev/null 2>&1 || warn …` (:3604): after the JSON and
  // before the blocked check, like bash; the regrid output is suppressed
  // and a failure becomes the warning (the friction log holds the detail).
  if (autoRegrid === 1 && cfg(ctx, 'regrid', 'on', env) === 'on') {
    runAutoRegrid(ctx, env, cwd, 'regrid after spawn failed; panes left as inserted (see friction)');
  }
  if (blocked === 1) {
    warn(`agent '${name}' is blocked during startup (update prompt, login, trust dialog…). Screen follows; ask the user before answering it, then: herdr agent send-keys ${name} <keys>; herdr agent wait ${name} --timeout 60000`);
    process.stdout.write(agentRead(env, name, { source: 'visible', lines: 40 }));
    process.exit(7);
  }
}
