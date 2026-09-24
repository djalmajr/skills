// `setup --detect` (slice 7b of the bash port): print as JSON what this
// machine has — installed kinds (family, effort ceiling, three newest
// models), the models the user declared for the generic kinds pi and
// opencode (ids and the highest declared reasoning level only — apiKey,
// headers and {env:…} values never leave the files), the recommended
// reviewer, the effective lanes, the presets and the config with its
// source layers — and write nothing. Port of the original bash implementation
// :1978-2118 (pi_custom_models_json / opencode_custom_models_json /
// effective_build_family / recommend_reviewer_json / detect_top_models /
// detect_kind_json / detect_role_kinds_json / detect_worker_models_json)
// and :2119-2185 (cmd_setup_detect). The JSON is the jq -n pretty output
// (2-space indent, trailing newline) with the same keys in the same order.
// The custom-provider file readers live in lib/ownproviders.mjs (the
// single implementation, shared with the own-provider trap warnings);
// piCustomModelsJson / opencodeCustomModelsJson below keep the ported
// shapes from them. Each custom_models entry carries `warnings` (the
// traps found for that model, as the last key; [] when none) — the
// provider/model/file ids only, never the key values.
import fs from 'node:fs';
import path from 'node:path';
import { KNOWN_KINDS, cfg, cfgSource } from '../config.mjs';
import { agentFamily, kindExe, kindFamilyDisplay, kindEffortCeiling, kindSummary } from '../kinds.mjs';
import { modelIds, versionSortDesc } from '../models.mjs';
import { findExecutable } from '../platform.mjs';
import { laneAttr, laneNames, laneRolesCsv, presetLaneNamesFor, presetLaneRoles, splitRoles } from '../lanes.mjs';
import { fmGet, roleDirs } from '../roles.mjs';
import { resolvedRoleKind } from '../spawn.mjs';
import { opencodeOwnModels, piOwnModels, piProvidersParsed, opencodeFilesParsed } from '../ownproviders.mjs';

// pi_custom_models_json :1978 — [{id:"provider/model",max_effort}] from
// ~/.pi/agent/models.json. max_effort is the key with the highest ladder
// rank among the non-null thinkingLevelMap entries ("" when the model
// declares no known level). Only ids and levels are read; apiKey, headers
// and {env:…} values never leave the file. A malformed file — or a shape
// jq would reject mid-query (non-object providers, non-array models,
// non-object model entries, non-string ids, non-object thinkingLevelMap) —
// degrades to [], like the bash `|| printf '[]'`.
export function piCustomModelsJson(env = process.env) {
  const out = [];
  for (const p of piProvidersParsed(env)) {
    for (const m of p.models) out.push({ id: `${p.id}/${m.id}`, max_effort: m.maxEffort });
  }
  return out;
}

// opencode_custom_models_json :1994 — [{id:"provider/model",max_effort:""}]
// from the project opencode.json (its entries win on duplicate ids), then
// $OPENCODE_CONFIG, then ${XDG_CONFIG_HOME:-~/.config}/opencode/opencode.json,
// then ~/.opencode/opencode.json. opencode declares no per-model reasoning
// ladder: max_effort is always "". A malformed file is skipped, not a
// failure (bash `|| true` per file); provider options (apiKey, headers,
// {env:…}) never leave the files.
export function opencodeCustomModelsJson(env = process.env, cwd = process.cwd()) {
  // The jq reduce builds the id-keyed object in first-occurrence order;
  // `.[$x.id] = (.[$x.id] // $x)` keeps the first declaration (the project
  // file, read first).
  const seen = new Set();
  const out = [];
  for (const f of opencodeFilesParsed(env, cwd)) {
    for (const p of f.providers) {
      for (const m of p.models) {
        const id = `${p.id}/${m.id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ id, max_effort: '' });
      }
    }
  }
  return out;
}

// effective_build_family :2032 — the model family the build lane would run
// (lane kind + model, else the implementer role's config/frontmatter).
// Used to pick a reviewer from another family.
export function effectiveBuildFamily(ctx, env = process.env, cwd = process.cwd()) {
  let k = laneAttr(ctx, 'build', 'kind', null, env);
  if (k === '') k = resolvedRoleKind('implementer', ctx, env, cwd);
  let m = laneAttr(ctx, 'build', 'model', null, env);
  if (m === '') m = cfg(ctx, 'role_implementer_model', '', env);
  return agentFamily(k, m);
}

// recommend_reviewer_json :2051 — the reviewer suggestion. eligible is a
// list of {kind, model} (model may be '') — in cmd_setup_detect the
// installed kinds only, with an empty model. Policy order: codex, claude,
// then the other kinds (KNOWN_KINDS, deduped). The first eligible kind
// with a KNOWN family different from the build family wins; nothing
// eligible → null.
export function recommendReviewerJson(buildFamily, eligible) {
  const byKind = new Map();
  for (const e of eligible) {
    if (!byKind.has(e.kind)) byKind.set(e.kind, e.model ?? '');
  }
  const order = ['codex', 'claude', ...KNOWN_KINDS.filter((k) => k !== 'codex' && k !== 'claude')];
  for (const k of order) {
    if (!byKind.has(k)) continue; // a kind absent from the eligible list is not a candidate
    const m = byKind.get(k);
    const fam = agentFamily(k, m);
    if (fam === 'unknown') continue;
    if (fam === buildFamily) continue;
    return { kind: k, family: fam, model: m };
  }
  return null;
}

// detect_top_models :2074 — the up-to-3 newest ids of the kind. A missing
// or silent CLI yields []. The short timeout never writes the model cache
// (model_ids only caches at the full default timeout). The caller's
// HERDR_AGENTS_MODELS_TIMEOUT is honored when set (non-empty); otherwise
// the 5 s default.
export function detectTopModels(kind, env = process.env) {
  const ids = versionSortDesc(modelIds(kind, { ...env, HERDR_AGENTS_MODELS_TIMEOUT: env.HERDR_AGENTS_MODELS_TIMEOUT || '5' }));
  return ids.slice(0, 3);
}

// detect_kind_json :2084 — one entry of the kinds array. For the generic
// kinds the custom_models entries carry the own-provider trap warnings
// (as the last key, [] when none); the stable kinds keep an empty list.
export function detectKindJson(ctx, kind, env = process.env, cwd = process.cwd()) {
  const exe = kindExe(kind);
  const installed = findExecutable(exe, env) !== null;
  const family = kindFamilyDisplay(kind);
  const effortCeiling = kindEffortCeiling(kind);
  const models = detectTopModels(kind, env);
  const summary = kindSummary(kind);
  let custom = [];
  if (kind === 'pi') custom = piOwnModels(ctx, env);
  else if (kind === 'opencode') custom = opencodeOwnModels(env, cwd);
  return { kind, executable: exe, installed, family, effort_ceiling: effortCeiling, models, summary, custom_models: custom };
}

// detect_role_kinds_json :2099 — the effective role.<name>.kind of every
// role file (first role directory wins per name): the config override when
// one is set (source = its layer), otherwise the frontmatter (source "role").
export function detectRoleKindsJson(ctx, env = process.env, cwd = process.cwd()) {
  const seen = new Set();
  const out = [];
  for (const d of roleDirs(env, cwd)) {
    let names;
    try {
      // The bash glob is C-locale sorted (decision 4) and never matches
      // dotfiles; keep both rules.
      names = fs.readdirSync(d).filter((n) => !n.startsWith('.') && n.endsWith('.md')).sort();
    } catch { continue; }
    for (const n of names) {
      const name = n.slice(0, -3);
      if (seen.has(name)) continue;
      seen.add(name);
      const key = `role.${name}.kind`;
      const ck = key.replace(/[.-]/g, '_');
      let value;
      let source;
      if (cfg(ctx, ck, '', env) !== '') {
        value = cfg(ctx, ck, '', env);
        source = cfgSource(ctx, ck, env);
      } else {
        value = fmGet(path.join(d, n), 'kind');
        source = 'role';
      }
      out.push({ key, value, source });
    }
  }
  return out;
}

// detect_worker_models_json :2116 — model.<kind>.worker with the source
// layer for every known kind (an unset key keeps value "" and source
// "builtin", like cfg/cfg_source).
export function detectWorkerModelsJson(ctx, env = process.env) {
  return KNOWN_KINDS.map((k) => {
    const key = `model.${k}.worker`;
    const ck = `model_${k}_worker`;
    return { key, value: cfg(ctx, ck, '', env), source: cfgSource(ctx, ck, env) };
  });
}

// cmd_setup_detect :2119 (pure part) — the detect JSON document, with the
// bash key order: kinds, recommended_reviewer, then config (max_workers,
// multi_role, reuse_workers, panes, lanes, effective_lanes, presets,
// role_kinds, worker_models). The effective lanes are the preset of the
// panes value, or the custom lanes; the presets are the fixed 3- and
// 4-pane lists. The reviewer suggestion uses the installed kinds only
// (setup --probe refines it to the kinds that answer a real prompt).
export function setupDetectJson(ctx, env = process.env, cwd = process.cwd()) {
  const kinds = KNOWN_KINDS.map((k) => detectKindJson(ctx, k, env, cwd));
  const roleKinds = detectRoleKindsJson(ctx, env, cwd);
  const workerModels = detectWorkerModelsJson(ctx, env);
  const effectiveLanes = laneNames(ctx, env).map((lane) => ({
    name: lane,
    roles: splitRoles(laneRolesCsv(ctx, lane, env)),
    kind: laneAttr(ctx, lane, 'kind', null, env),
    model: laneAttr(ctx, lane, 'model', null, env),
    effort: laneAttr(ctx, lane, 'effort', null, env),
    approvals: laneAttr(ctx, lane, 'approvals', null, env),
  }));
  const presets = {};
  for (const p of ['3', '4']) {
    presets[p] = presetLaneNamesFor(p).map((lane) => ({
      name: lane,
      roles: splitRoles(presetLaneRoles(lane, p)),
    }));
  }
  const buildFamily = effectiveBuildFamily(ctx, env, cwd);
  const eligible = kinds.filter((k) => k.installed).map((k) => ({ kind: k.kind, model: '' }));
  return {
    kinds,
    recommended_reviewer: recommendReviewerJson(buildFamily, eligible),
    config: {
      max_workers: { value: cfg(ctx, 'max_workers', '3', env), source: cfgSource(ctx, 'max_workers', env) },
      multi_role: { value: cfg(ctx, 'multi_role', 'on', env), source: cfgSource(ctx, 'multi_role', env) },
      reuse_workers: { value: cfg(ctx, 'reuse_workers', 'on', env), source: cfgSource(ctx, 'reuse_workers', env) },
      panes: { value: cfg(ctx, 'panes', '4', env), source: cfgSource(ctx, 'panes', env) },
      lanes: { value: cfg(ctx, 'lanes', 'on', env), source: cfgSource(ctx, 'lanes', env) },
      effective_lanes: effectiveLanes,
      presets,
      role_kinds: roleKinds,
      worker_models: workerModels,
    },
  };
}

// cmd_setup_detect :2119 — print the detect JSON (the jq -n formatting:
// 2-space indent, trailing newline). Writes nothing.
export function cmdSetupDetect(ctx, env = process.env, cwd = process.cwd()) {
  process.stdout.write(`${JSON.stringify(setupDetectJson(ctx, env, cwd), null, 2)}\n`);
}
