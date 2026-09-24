// Own-provider traps (backlog item 8): the settings that break a reasoning
// model served by your own OpenAI-compatible endpoint, documented in
// references/kinds.md ("Reasoning models on your own server"). Three traps
// are checked and reported — `doctor` warn lines and the per-model
// `warnings` of `setup --detect` custom_models:
//
//   1. a literal apiKey written in the file instead of an environment
//      reference (pi: "$MY_API_KEY", opencode: "{env:MY_API_KEY}");
//   2. pi: a model maxTokens without an 8192 headroom over the reasoning
//      budget of the effort in use (effort.pi, empty -> high; the budget is
//      settings.json thinkingBudgets[level], else the defaults minimal 1024
//      / low 2048 / medium 8192 / high 16384; xhigh/max without a defined
//      value: no check);
//   3. opencode: a model without thinking_token_budget in its options.
//
// The file readers are the ones `setup --detect` used for custom_models
// (extracted here, single implementation — setup-detect.mjs builds its
// custom_models lists from them, so nothing is parsed twice): the same
// files, the same degradation (a malformed pi models.json degrades the
// whole file to []; a malformed opencode.json is skipped per file), and
// secrets never leave the files — only ids, effort levels, numeric budgets
// and the file paths are reported.
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.mjs';
import { homeDir, projectRoot, readTextFile } from './platform.mjs';

// `[ -f ]` port: regular file, symlinks followed; false when unreadable.
function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// jq `a // ""` on the id: null, undefined and false all count as empty;
// any other value (numbers included) is passed through — where jq then
// fails the whole file (string + number is not a string concatenation).
function orEmpty(v) {
  return v === null || v === undefined || v === false ? '' : v;
}

// The reasoning ladder of the pi thinkingLevelMap (jq $ladder in
// pi_custom_models_json): the declared levels mapped to a rank.
// No prototype: a thinkingLevelMap key such as `constructor` or `toString`
// must rank 0 like any other unknown level (jq `$ladder[.key] // 0`).
const THINKING_LADDER = Object.assign(Object.create(null), { low: 1, medium: 2, high: 3, xhigh: 4, max: 5 });

// Rule 2 (pi): the default thinking budgets of the effort levels. A level
// with a thinkingBudgets entry of its own wins; xhigh/max (and any other
// level) without a defined value get no check.
const PI_BUDGET_DEFAULTS = Object.assign(Object.create(null), { minimal: 1024, low: 2048, medium: 8192, high: 16384 });

// The 8192 tokens of headroom over the reasoning budget (kinds.md: the
// max_tokens covers reasoning, the answer and the tool calls).
const PI_HEADROOM = 8192;

// Rule 1 (pi): absent (null/missing) lets the CLI read the environment; a
// string starting with `$` is an environment reference; anything else —
// including a non-string value or the empty string — is a literal key.
function piApiKeyShape(v) {
  if (v === null || v === undefined) return 'absent';
  return typeof v === 'string' && v.startsWith('$') ? 'ref' : 'literal';
}

// Rule 1 (opencode): absent is fine; exactly `{env:NAME}` (a valid
// environment variable name, nothing else) is a reference; anything else
// present is a literal key.
function opencodeApiKeyShape(v) {
  if (v === null || v === undefined) return 'absent';
  if (typeof v === 'string' && v.startsWith('{env:') && v.endsWith('}')) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.slice(6, -1))) return 'ref';
  }
  return 'literal';
}

// The structured read of ~/.pi/agent/models.json: one record per provider
// with the apiKey shape (absent/ref/literal — the value never) and the
// models with their id, the max declared reasoning level (the ladder, last
// of the maximum ranks; "" when no known level is declared) and the numeric
// maxTokens (null when missing or not a number). The same degradation as
// the bash/jq port: a malformed file — or a shape jq would reject
// mid-query (non-object providers, non-array models, non-object model
// entries, non-string ids, non-object thinkingLevelMap) — degrades the
// whole file to [].
export function piProvidersParsed(env = process.env) {
  const f = path.join(homeDir(process.platform, env), '.pi', 'agent', 'models.json');
  let root;
  try { root = JSON.parse(readTextFile(f)); } catch { return []; }
  if (root === null || root === false) return [];
  if (typeof root !== 'object' || Array.isArray(root)) return [];
  const providers = orEmpty(root.providers);
  if (typeof providers !== 'object' || Array.isArray(providers)) return [];
  const out = [];
  for (const [p, pv] of Object.entries(providers)) {
    const provider = orEmpty(pv);
    if (typeof provider !== 'object' || Array.isArray(provider)) return [];
    const models = orEmpty(provider.models);
    if (!Array.isArray(models)) return [];
    const modelsOut = [];
    for (const m of models) {
      const model = orEmpty(m);
      if (typeof model !== 'object' || Array.isArray(model)) return [];
      const id = orEmpty(model.id);
      if (typeof id !== 'string') return []; // jq: string + number → file fails
      if (id === '') continue;
      let tlm = orEmpty(model.thinkingLevelMap);
      if (tlm === '') tlm = {};
      if (typeof tlm !== 'object' || Array.isArray(tlm)) return [];
      // jq: to_entries | map(select(.value != null)) | map({key, r}) as $lv
      // | if length == 0 then "" else (max_by(.r) | if .r > 0 then .key else "")
      // — max_by keeps the LAST of the maximum ranks (jq `>=` reduce).
      let best = null;
      for (const [k, v] of Object.entries(tlm)) {
        if (v === null) continue;
        const r = THINKING_LADDER[k] ?? 0;
        if (best === null || r >= best.r) best = { key: k, r };
      }
      const maxTokens = typeof model.maxTokens === 'number' ? model.maxTokens : null;
      modelsOut.push({ id, maxEffort: best === null || best.r === 0 ? '' : best.key, maxTokens });
    }
    out.push({ file: f, id: p, apiKey: piApiKeyShape(provider.apiKey), models: modelsOut });
  }
  return out;
}

// The pi thinkingBudgets of ~/.pi/agent/settings.json as level -> numeric
// budget; a missing/malformed file or a non-object thinkingBudgets yields
// {} (no check — the malformed file is already tolerated by the readers).
// A level whose value is not a number is dropped: "no value" for rule 2.
export function piThinkingBudgets(env = process.env) {
  const f = path.join(homeDir(process.platform, env), '.pi', 'agent', 'settings.json');
  let root;
  try { root = JSON.parse(readTextFile(f)); } catch { return {}; }
  if (root === null || root === false) return {};
  if (typeof root !== 'object' || Array.isArray(root)) return {};
  const tb = root.thinkingBudgets;
  if (tb === null || tb === undefined) return {};
  if (typeof tb !== 'object' || Array.isArray(tb)) return {};
  const out = Object.assign(Object.create(null), {});
  for (const [k, v] of Object.entries(tb)) if (typeof v === 'number') out[k] = v;
  return out;
}

// The structured read of the opencode.json files, in read order: the
// project file (its entries win on duplicate model ids), $OPENCODE_CONFIG,
// ${XDG_CONFIG_HOME:-~/.config}/opencode/opencode.json, then
// ~/.opencode/opencode.json. A malformed file is skipped, not a failure
// (bash `|| true` per file); a provider entry that is not an object — or
// models that are not an object — aborts the whole file, like the
// bash/jq mid-query failure the port mirrored. Provider options (apiKey,
// headers, {env:…}) never leave the files: only the apiKey shape (and the
// file path) is kept.
export function opencodeFilesParsed(env = process.env, cwd = process.cwd()) {
  const files = [];
  const proj = path.join(projectRoot(env, cwd), 'opencode.json');
  if (isFile(proj)) files.push(proj);
  const oc = env.OPENCODE_CONFIG;
  if (oc && isFile(oc)) files.push(oc);
  const xdg = path.join(env.XDG_CONFIG_HOME || path.join(homeDir(process.platform, env), '.config'), 'opencode', 'opencode.json');
  if (isFile(xdg)) files.push(xdg);
  const homeF = path.join(homeDir(process.platform, env), '.opencode', 'opencode.json');
  if (isFile(homeF)) files.push(homeF);
  const out = [];
  for (const f of files) {
    let root;
    try { root = JSON.parse(readTextFile(f)); } catch { continue; }
    if (root === null || root === false) continue;
    if (typeof root !== 'object' || Array.isArray(root)) continue;
    const provider = orEmpty(root.provider);
    if (typeof provider !== 'object' || Array.isArray(provider)) continue;
    const providers = [];
    let aborted = false;
    for (const [p, pv] of Object.entries(provider)) {
      const entry = orEmpty(pv);
      if (typeof entry !== 'object' || Array.isArray(entry)) { aborted = true; break; }
      const models = orEmpty(entry.models);
      if (models === '') continue;
      if (typeof models !== 'object' || Array.isArray(models)) { aborted = true; break; }
      const opts = orEmpty(entry.options);
      const apiKey = (typeof opts === 'object' && !Array.isArray(opts)) ? opencodeApiKeyShape(opts.apiKey) : 'absent';
      // models.<model>.options.thinking_token_budget counts only as a
      // number: null or "16000" is no budget the server can use.
      const modelsOut = Object.keys(models).map((id) => {
        const m = orEmpty(models[id]);
        const mOpts = (typeof m === 'object' && !Array.isArray(m)) ? orEmpty(m.options) : '';
        const budget = (typeof mOpts === 'object' && !Array.isArray(mOpts)) ? mOpts.thinking_token_budget : undefined;
        const hasBudget = typeof budget === 'number' && Number.isFinite(budget);
        return { id, hasBudget };
      });
      providers.push({ id: p, apiKey, models: modelsOut });
    }
    if (aborted) continue; // the file degrades to nothing, like the bash || true per file
    if (providers.length > 0) out.push({ file: f, providers });
  }
  return out;
}

// The warning texts (exact, backlog item 8). `<p>` = provider id,
// `<m>` = model id, `<file>` = the file path.
const keyWarning = (p, kind, file) =>
  `own provider '${p}' (${kind}) has a literal apiKey in ${file}; use an environment reference (pi: "$MY_API_KEY", opencode: "{env:MY_API_KEY}")`;
const headroomWarning = (p, m, n, level, b) =>
  `pi model ${p}/${m}: maxTokens ${n} leaves less than 8192 tokens over the ${level} reasoning budget (${b}); answers and tool calls get truncated. Set maxTokens to at least ${b + PI_HEADROOM}`;
const budgetWarning = (p, m) =>
  `opencode model ${p}/${m} has no thinking_token_budget in its options; the skill's effort is dropped and the server default applies`;

// The pi custom models with their warnings, in file order (provider order,
// model order): {id: "provider/model", max_effort, warnings} with
// warnings as the last key. Rule 1 fires on every model of a provider with
// a literal apiKey; rule 2 fires per model with a numeric maxTokens below
// budget + 8192 (no maxTokens: no check).
export function piOwnModels(ctx, env = process.env) {
  const providers = piProvidersParsed(env);
  // The level is the effective effort.pi (empty -> high); the budget is the
  // thinkingBudgets entry for the level, else the default for the level; a
  // level with no defined value (xhigh/max or unknown) skips the check.
  const level = cfg(ctx, 'effort_pi', '', env) || 'high';
  const budgets = piThinkingBudgets(env);
  let budget = typeof budgets[level] === 'number' ? budgets[level] : PI_BUDGET_DEFAULTS[level];
  if (typeof budget !== 'number') budget = null;
  const out = [];
  for (const p of providers) {
    for (const m of p.models) {
      const warnings = [];
      if (p.apiKey === 'literal') warnings.push(keyWarning(p.id, 'pi', p.file));
      if (budget !== null && m.maxTokens !== null && m.maxTokens < budget + PI_HEADROOM) {
        warnings.push(headroomWarning(p.id, m.id, m.maxTokens, level, budget));
      }
      out.push({ id: `${p.id}/${m.id}`, max_effort: m.maxEffort, warnings });
    }
  }
  return out;
}

// The opencode custom models with their warnings, in first-occurrence
// order (the project file is read first; the first declaration of a model
// id wins, with the key shape and the budget of the file that declared it
// first): {id: "provider/model", max_effort: "", warnings} with warnings as
// the last key. Rule 1 fires on every model of a provider entry with a
// literal apiKey; rule 3 fires on a model whose options lack
// thinking_token_budget.
export function opencodeOwnModels(env = process.env, cwd = process.cwd()) {
  const seen = new Set();
  const out = [];
  for (const f of opencodeFilesParsed(env, cwd)) {
    for (const p of f.providers) {
      for (const m of p.models) {
        const id = `${p.id}/${m.id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const warnings = [];
        if (p.apiKey === 'literal') warnings.push(keyWarning(p.id, 'opencode', f.file));
        if (!m.hasBudget) warnings.push(budgetWarning(p.id, m.id));
        out.push({ id, max_effort: '', warnings });
      }
    }
  }
  return out;
}

// The own-provider lines for `doctor`, after the kinds lines: every
// warning as its own line (pi models first, then opencode, model order),
// and one ok line when at least one own provider is declared and nothing
// was found. A provider counts as declared when it contributes at least
// one model entry — the skill only sees the models. The literal-key trap
// is a property of the provider, so its warning is reported once per
// provider (deduped; `setup --detect` keeps it on every model of the
// provider), while the headroom (pi) and budget (opencode) traps stay
// per-model.
export function ownProviderDoctorLines(ctx, env = process.env, cwd = process.cwd()) {
  const models = [...piOwnModels(ctx, env), ...opencodeOwnModels(env, cwd)];
  const warnings = [];
  // One key line per provider, even when it is declared in more than one
  // opencode file (the first file is named). The identity is the text up to
  // the file — `own provider '<id>' (<kind>)` — because a provider id may
  // itself hold a `/` (`org/alpha`), so it cannot be cut from the model id.
  const seenKey = new Set();
  for (const m of models) {
    for (const w of m.warnings) {
      const at = w.startsWith("own provider '") ? w.indexOf(' has a literal apiKey in ') : -1;
      if (at !== -1) {
        const provider = w.slice(0, at);
        if (seenKey.has(provider)) continue;
        seenKey.add(provider);
      }
      warnings.push(w);
    }
  }
  return { declared: models.length > 0, warnings };
}
