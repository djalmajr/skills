// The `spawn` command (port slice 5b): resolve kind/model/effort/approvals
// of a role (same order as bash `cmd_spawn` :3377-3607 and spec 5.3),
// decide reuse (by lane or by role), enforce the worker cap, place the
// pane (split, herd tab or a given `--pane`), start the agent with the
// `agent_pane_busy` retry and register the worker in the roster.
//
// Behavior mirrors scripts/herdr-agents.sh (:735-736, :1507-1523,
// :3198-3376, :3377-3607). The lane decision, the worker cap, the split
// anchor and the herd tabs come from the already-ported modules (lanes,
// layout, herdtabs); regrid after spawn is slice 8 (decision 5 — one
// commented extension point in cmdSpawn).
import fs from 'node:fs';
import { DieError, cfg, EFFORT_LADDER } from './config.mjs';
import { runCli, findExecutable } from './platform.mjs';
import { hasWord } from './text.mjs';
import {
  agentFamily, clampTo, effortRank, kindApprovalArgs, kindContextArgs,
  kindEffortArgs, kindEffortCeiling, kindExe, kindModelArgs,
} from './kinds.mjs';
import { codexModelCeiling, resolveModel } from './models.mjs';
import {
  fmGet, historyHasEdit, isReviewRole, resolveRole, roleFile, roleIsEdit,
} from './roles.mjs';
import {
  enforceWorkerCap, laneAttr, laneDecide, laneOfRole, lanesEnabled, panesValue, spawnKindLayer,
} from './lanes.mjs';
import {
  agentRead, agentState, callerAgentName, HERDR_TIMEOUT_MS, liveAgents, paneSplit,
} from './herdr.mjs';
import {
  dieFriction, lastReport, nowStamp, rosterAppend, rosterLine, rosterRemove,
  rosterSetRole, rosterRows, stateDir, warn,
} from './state.mjs';
import { pickSplitAnchor, restoreFocusIfStolen, uiFocusedPane } from './layout.mjs';
import { herdTabPane, herdTabsRelabel, jqPretty } from './herdtabs.mjs';

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
// effort.<kind>, frontmatter; clamped to the kind ceiling and max_effort.
export function resolveSpawnEffort(role, lane, kind, kindLayer = '', ctx, env = process.env, cwd = process.cwd()) {
  let effort = laneAttr(ctx, lane, 'effort', kindLayer === '' ? null : kindLayer, env);
  if (effort === '') effort = cfg(ctx, `role_${String(role).replace(/-/g, '_')}_effort`, '', env);
  if (effort === '') effort = cfg(ctx, `effort_${kind}`, '', env);
  if (effort === '') {
    const f = roleFile(role, env, cwd);
    if (f) effort = fmGet(f, 'effort');
  }
  if (effort !== '' && hasWord(EFFORT_LADDER.join(' '), effort)) {
    effort = clampTo(clampTo(effort, kindEffortCeiling(kind)), cfg(ctx, 'max_effort', '', env));
  }
  return effort;
}

// ---------- reuse (no lane) ----------

// find_reusable :3206: an idle/done worker of the same role (always) or,
// with multi_role=on, of another role when kind, cwd and resolved model
// match, the worker's approvals are at least the request, and the roster
// line has the model/approvals/roles columns. A worker that has edited
// (EDIT_ROLES or mode: edit, now or in `roles`) is never reused as a
// review role. Old 8-column lines are only reused for the same role.
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
    if (!isSame) {
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
      else if (a === '--kind') { kind = v; kindSet = 1; }
      else if (a === '--direction') direction = v;
      else if (a === '--ratio') ratio = v;
      else if (a === '--cwd') cwdArg = v;
      else if (a === '--pane') pane = v;
      else timeout = v;
      i += 1;
    }
  }
  ensureOrchestratorName(ctx, env);
  const f = resolveRole(role, env, cwd);
  const rk = String(role).replace(/-/g, '_');
  if (role === 'planner') {
    dieFriction('spawn planner: the orchestrator is the planner and does not open a pane. Plan in this session.', 12);
  }
  let lane = '';
  if (lanesEnabled(ctx, env)) {
    lane = laneOfRole(ctx, role, env);
    if (lane === '') dieFriction(`spawn: role '${role}' is not in any lane (panes=${panesValue(ctx, env)}). Add it with lane.<name>.roles, or set lanes=off.`, 3);
  }
  // kind: flag → lane.<l>.kind → role.<r>.kind → frontmatter (spec 5.3).
  if (kind === '') kind = laneAttr(ctx, lane, 'kind', null, env);
  if (kind === '') kind = cfg(ctx, `role_${rk}_kind`, '', env);
  if (kind === '') kind = fmGet(f, 'kind');
  if (kind === '') dieFriction(`role ${role} has no default kind; pass --kind`, 3);
  const kindLayer = spawnKindLayer(ctx, role, lane, kindSet !== 0, env);
  if (!findExecutable(kindExe(kind), env)) warn(`executable '${kindExe(kind)}' not found in PATH; herdr agent start may fail`);
  if (role === 'sub-orchestrator' && kind === 'codex'
    && !cfg(ctx, 'args_codex', '', env).includes('danger-full-access')) {
    warn("sub-orchestrator on codex: its sandbox blocks the Herdr socket (every 'herdr' call fails with Operation not permitted). Use --kind claude, or set args.codex=-s danger-full-access if you accept that.");
  }
  const position = role === 'sub-orchestrator' ? 'orchestrator' : 'worker';
  if (effort === '') effort = laneAttr(ctx, lane, 'effort', kindLayer, env);
  if (effort === '') effort = cfg(ctx, `role_${rk}_effort`, '', env);
  if (effort === '') effort = cfg(ctx, `effort_${kind}`, '', env);
  if (effort === '') effort = fmGet(f, 'effort');
  let modelSpec = model;
  if (modelSpec === '') modelSpec = laneAttr(ctx, lane, 'model', kindLayer, env);
  if (modelSpec === '') modelSpec = cfg(ctx, `role_${rk}_model`, '', env);
  if (modelSpec === '') modelSpec = fmGet(f, 'model');
  if (modelSpec === '') modelSpec = cfg(ctx, `model_${kind}_${position}`, '', env);
  if (modelSpec === '') modelSpec = cfg(ctx, `model_${kind}`, '', env);
  if (approvals === '') approvals = laneAttr(ctx, lane, 'approvals', null, env);
  if (approvals === '') approvals = cfg(ctx, `role_${rk}_approvals`, '', env);
  if (approvals === '') approvals = fmGet(f, 'approvals');
  if (approvals === '') approvals = cfg(ctx, 'approvals', 'ask', env);
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
  if (modelSpec !== '') {
    model = resolveModel(kind, modelSpec, effort, env);
    if (kind === 'codex' && effort !== '') {
      const mc = codexModelCeiling(model, env);
      if (mc !== '' && effortRank(effort) > effortRank(mc)) {
        warn(`codex model ${model} supports up to '${mc}'; effort '${effort}' clamped`);
        effort = mc;
      }
    }
  }
  if (reuse === '') reuse = cfg(ctx, 'reuse_workers', 'on', env);

  const sd = stateDir(ctx, env, cwd);
  // Lane decision (lanes on, no --pane): reuse/busy/gone/unavailable/locked.
  if (lane !== '' && pane === '') {
    const d = laneDecide(ctx, lane, role, env, cwd);
    switch (d.decision) {
      case 'reuse': {
        if (reuse !== 'on') {
          process.stdout.write(`${JSON.stringify({ status: 'busy', lane, name: d.name })}\n`);
          warn(`lane '${lane}' already has idle worker '${d.name}'. Release it before --fresh, or dispatch on it. Run 'wait ${d.name}', then dispatch.`);
          process.exit(10);
        }
        const line = rosterLine(sd, d.name);
        const lf = line.split('\t');
        const actualKind = lf[2] ?? '';
        if (laneAttr(ctx, lane, 'kind', null, env) === '') {
          // No lane.<l>.kind: the first spawn locked the process; a
          // different kind, model or effort must not reuse it with exit 0.
          const sessionRole = lf[3] ?? '';
          const sessionModel = lf.length >= 9 ? (lf[8] ?? '') : '';
          const sessionEffort = resolveSpawnEffort(sessionRole, lane, actualKind, kindLayer, ctx, env, cwd);
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
        emitReuse(d.name, role, actualKind, ctx, env, cwd);
        warn(`reusing idle lane '${lane}' worker '${d.name}' as ${role}; its session already holds earlier briefs`);
        return;
      }
      case 'busy':
        process.stdout.write(`${JSON.stringify({ status: 'busy', lane, name: d.name })}\n`);
        warn(`lane '${lane}' worker '${d.name}' is busy (${d.state}). Run 'wait ${d.name}', then dispatch.`);
        process.exit(10);
        break;
      case 'gone':
        rosterRemove(sd, d.name);
        warn(`lane '${lane}' worker '${d.name}' is gone; opening a new pane`);
        break;
      case 'unavailable':
        dieFriction(`lane '${lane}' worker '${d.name}' matches but herdr agent get failed (${d.cause}). Not spawning a replacement; it may still be live.`, 4);
        break;
      case 'locked':
        dieFriction(`lane '${lane}' worker '${d.name}' has edited and cannot take review role '${role}'.`, 5);
        break;
      case 'absent':
        break;
      default:
        dieFriction(`spawn: unexpected lane decision '${d.decision}'`, 4);
    }
  }
  // Reuse without a lane (reuse_workers=on or --reuse, no --pane).
  if (reuse === 'on' && pane === '') {
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
  if (name === '') name = uniqueName(lane !== '' ? lane : role, env);
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) dieFriction(`invalid agent name '${name}' (must match [a-z][a-z0-9_-]{0,31})`, 2);
  if (agentNameTaken(name, env)) dieFriction(`agent name '${name}' is already live`, 3);
  const wctx = cfg(ctx, 'worker_context', 'full', env);
  const built = [
    ...kindContextArgs(kind, wctx),
    ...kindApprovalArgs(kind, approvals),
    ...kindModelArgs(kind, model, effort),
    ...kindEffortArgs(kind, effort, model, env),
  ];
  const extra = cfg(ctx, `args_${kind}`, '', env);
  if (extra !== '') for (const a of extra.split(/\s+/).filter((x) => x !== '')) built.push(a);
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
  rosterAppend(sd, [name, pane, kind, role, family, String(created), cwdArg, nowStamp(), model, approvals !== '' ? approvals : 'ask', role, lane]);
  if (placement === 'herd') {
    try { herdTabsRelabel(ctx, env, cwd); }
    catch { warn('relabel of the herd tabs failed (see friction)'); }
  }
  process.stdout.write(jqPretty({
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
  }));
  // slice 8: bash runs `(cmd_regrid) >/dev/null 2>&1 || warn "regrid after
  // spawn failed; panes left as inserted (see friction)" here when
  // autoRegrid && cfg regrid on. Until then the JS port does not regrid
  // (parity tests run with HERDR_AGENTS_REGRID=off).
  // if (autoRegrid === 1 && cfg(ctx, 'regrid', 'on', env) === 'on') { /* cmd_regrid */ }
  if (blocked === 1) {
    warn(`agent '${name}' is blocked during startup (update prompt, login, trust dialog…). Screen follows; ask the user before answering it, then: herdr agent send-keys ${name} <keys>; herdr agent wait ${name} --timeout 60000`);
    process.stdout.write(agentRead(env, name, { source: 'visible', lines: 40 }));
    process.exit(7);
  }
}
