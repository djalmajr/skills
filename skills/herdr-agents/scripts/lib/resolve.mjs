// Role settings resolution: the flag → lane → role.<r>.<attr> → frontmatter
// → kind-default chain that a `spawn` runs for one role (cmdSpawn in
// lib/spawn.mjs), extracted so the `roles` table can show the same values
// a flagless spawn would use. Each value carries the source that decided
// it (`*From`):
//   flag · lane <lane> (<layer>) · role config (<layer>) ·
//   effort.<kind> (<layer>) · role file ·
//   model.<kind>.<position> (<layer>) · model.<kind> (<layer>) ·
//   approvals (<layer>) · default (the value is empty; the CLI decides).
// <layer> is the cfgSource of the deciding key (defaults, user, project,
// session, env). No clamping, no model resolution, no CLI calls and no die:
// `spawn` keeps its own errors and runs the post-resolution steps (effort
// clamp, codex ceiling, resolveModel) after this. A role without a lane
// (or lanes off) resolves with lane '' and skips the lane steps.
// The roles/lanes imports are function-level use only (resolveRoleSettings),
// so the cycles are safe under Node and Bun (like models<->kinds).
import { cfg, cfgSource } from './config.mjs';
import { fmGet, roleFile } from './roles.mjs';
import { lanesEnabled, laneAttr, laneKey, laneOfRole, spawnKindLayer } from './lanes.mjs';

// resolveRoleSettings <role> [flags]: the settings a spawn uses for `role`.
// flags = { kind, model, effort, approvals } — empty strings when the flag
// is absent (all four empty = the flagless spawn the `roles` table shows).
// Returns { lane, kind, kindFrom, modelSpec, modelFrom, effort, effortFrom,
// approvals, approvalsFrom, kindLayer }; modelSpec is the configured spec
// (never resolved against a CLI), and kindLayer is the reference rank for
// the lane model/effort rule (5 = the --kind flag).
export function resolveRoleSettings(role, ctx, env = process.env, cwd = process.cwd(), flags = {}) {
  const flagKind = flags.kind ?? '';
  const flagModel = flags.model ?? '';
  const flagEffort = flags.effort ?? '';
  const flagApprovals = flags.approvals ?? '';
  const rk = String(role).replace(/-/g, '_');
  const f = roleFile(role, env, cwd);
  const front = (key) => (f ? fmGet(f, key) : '');

  // The first lane (in lane_names order) listing the role; '' when none or
  // lanes off — the lane steps are skipped then, and spawn keeps its own
  // error for a laned role that sits in no lane.
  let lane = '';
  if (lanesEnabled(ctx, env)) lane = laneOfRole(ctx, role, env);
  const kindLayer = spawnKindLayer(ctx, role, lane, flagKind !== '', env);

  // kind: flag → lane.<l>.kind → role.<r>.kind → frontmatter (spec 5.3).
  let kind = flagKind;
  let kindFrom = 'flag';
  if (kind === '' && lane !== '') {
    const v = laneAttr(ctx, lane, 'kind', null, env);
    if (v !== '') { kind = v; kindFrom = `lane ${lane} (${cfgSource(ctx, laneKey(lane, 'kind'), env)})`; }
  }
  if (kind === '') {
    const v = cfg(ctx, `role_${rk}_kind`, '', env);
    if (v !== '') { kind = v; kindFrom = `role config (${cfgSource(ctx, `role_${rk}_kind`, env)})`; }
  }
  if (kind === '') {
    const v = front('kind');
    if (v !== '') { kind = v; kindFrom = 'role file'; }
  }
  if (kind === '') kindFrom = 'default';

  // effort: flag → lane.<l>.effort → role.<r>.effort → effort.<kind> →
  // frontmatter. No clamping or validation: spawn's job after this.
  let effort = flagEffort;
  let effortFrom = 'flag';
  if (effort === '' && lane !== '') {
    const v = laneAttr(ctx, lane, 'effort', kindLayer, env);
    if (v !== '') { effort = v; effortFrom = `lane ${lane} (${cfgSource(ctx, laneKey(lane, 'effort'), env)})`; }
  }
  if (effort === '') {
    const v = cfg(ctx, `role_${rk}_effort`, '', env);
    if (v !== '') { effort = v; effortFrom = `role config (${cfgSource(ctx, `role_${rk}_effort`, env)})`; }
  }
  if (effort === '') {
    const v = cfg(ctx, `effort_${kind}`, '', env);
    if (v !== '') { effort = v; effortFrom = `effort.${kind} (${cfgSource(ctx, `effort_${kind}`, env)})`; }
  }
  if (effort === '') {
    const v = front('effort');
    if (v !== '') { effort = v; effortFrom = 'role file'; }
  }
  if (effort === '') effortFrom = 'default';

  // model: flag → lane.<l>.model → role.<r>.model → frontmatter →
  // model.<kind>.<position> → model.<kind>. The spec stays unresolved.
  const position = role === 'sub-orchestrator' ? 'orchestrator' : 'worker';
  let modelSpec = flagModel;
  let modelFrom = 'flag';
  if (modelSpec === '' && lane !== '') {
    const v = laneAttr(ctx, lane, 'model', kindLayer, env);
    if (v !== '') { modelSpec = v; modelFrom = `lane ${lane} (${cfgSource(ctx, laneKey(lane, 'model'), env)})`; }
  }
  if (modelSpec === '') {
    const v = cfg(ctx, `role_${rk}_model`, '', env);
    if (v !== '') { modelSpec = v; modelFrom = `role config (${cfgSource(ctx, `role_${rk}_model`, env)})`; }
  }
  if (modelSpec === '') {
    const v = front('model');
    if (v !== '') { modelSpec = v; modelFrom = 'role file'; }
  }
  if (modelSpec === '') {
    const v = cfg(ctx, `model_${kind}_${position}`, '', env);
    if (v !== '') { modelSpec = v; modelFrom = `model.${kind}.${position} (${cfgSource(ctx, `model_${kind}_${position}`, env)})`; }
  }
  if (modelSpec === '') {
    const v = cfg(ctx, `model_${kind}`, '', env);
    if (v !== '') { modelSpec = v; modelFrom = `model.${kind} (${cfgSource(ctx, `model_${kind}`, env)})`; }
  }
  if (modelSpec === '') modelFrom = 'default';

  // approvals: flag → lane.<l>.approvals → role.<r>.approvals → frontmatter
  // → the approvals setting (ask when nothing is set).
  let approvals = flagApprovals;
  let approvalsFrom = 'flag';
  if (approvals === '' && lane !== '') {
    const v = laneAttr(ctx, lane, 'approvals', null, env);
    if (v !== '') { approvals = v; approvalsFrom = `lane ${lane} (${cfgSource(ctx, laneKey(lane, 'approvals'), env)})`; }
  }
  if (approvals === '') {
    const v = cfg(ctx, `role_${rk}_approvals`, '', env);
    if (v !== '') { approvals = v; approvalsFrom = `role config (${cfgSource(ctx, `role_${rk}_approvals`, env)})`; }
  }
  if (approvals === '') {
    const v = front('approvals');
    if (v !== '') { approvals = v; approvalsFrom = 'role file'; }
  }
  if (approvals === '') {
    const v = cfg(ctx, 'approvals', '', env);
    approvals = v !== '' ? v : 'ask';
    approvalsFrom = v !== '' ? `approvals (${cfgSource(ctx, 'approvals', env)})` : 'default';
  }

  return { lane, kind, kindFrom, modelSpec, modelFrom, effort, effortFrom, approvals, approvalsFrom, kindLayer };
}
