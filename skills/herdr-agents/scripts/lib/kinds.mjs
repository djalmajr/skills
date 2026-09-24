// Kind table (slice 2): executables, families, effort ceilings, native flag
// translation (model/effort/approvals/context) and the `kinds` command.
// Port of scripts/herdr-agents.sh :458-545 and :655-714.
//
// Decisions honored here:
//   - agentFamily is the NEW rule (deliberate divergence from the bash
//     `agent_family`, which pattern-matches the whole id including provider
//     segments): (1) any id segment that starts with a known family name
//     (anthropic, openai, xai, google) wins; (2) otherwise only the LAST
//     segment is pattern-matched (claude-* -> anthropic, gpt-*/ *codex* ->
//     openai, grok-* -> xai, gemini-* -> google); (3) otherwise unknown.
//     Kinds with a fixed family (claude, codex, grok, agy, gemini) keep the
//     kind family. It does NOT parity with bash; it has its own JS tests.
//   - Windows: kindExe returns the canonical name (`cursor-agent` for
//     cursor); installation checks use findExecutable (PATHEXT) and every
//     CLI call goes through runCli.
import { KNOWN_KINDS } from './config.mjs';
import { findExecutable, runCli } from './platform.mjs';
// Function-level use only (cursorModelWithEffort), so the models<->kinds
// import cycle is safe under Node and Bun.
import { parseCursorModels } from './models.mjs';

// die() as an exception: command entry points catch this and die() so unit
// tests can assert the message and code without killing the process.
export class DieError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DieError';
    this.code = code;
  }
}

// warn() port (no friction log: kinds/models/model are not friction
// commands). Injected into the arg functions so cmd_model can suppress it,
// like the bash `2>/dev/null` on the arg group.
export function defaultWarn(msg) {
  process.stderr.write(`herdr-agents: warning: ${msg}\n`);
}

// Family names used by the agentFamily segment rule (decision).
const FAMILY_PREFIXES = ['anthropic', 'openai', 'xai', 'google'];

export function kindFamily(kind) {
  switch (kind) {
    case 'claude': return 'anthropic';
    case 'codex': return 'openai';
    case 'grok': return 'xai';
    case 'agy':
    case 'gemini': return 'google';
    default: return 'unknown';
  }
}

// FAMILY column for `kinds`/`setup --detect`: multi-model harnesses show
// "by model" because their family depends on the configured model id.
export function kindFamilyDisplay(kind) {
  if (kind === 'cursor' || kind === 'pi' || kind === 'opencode') return 'by model';
  return kindFamily(kind);
}

// agentFamily <kind> [model] — the family the reviewer rule compares.
// NEW rule (see header): an id segment that IS a family name first
// (`openrouter/anthropic/claude-x`), then patterns on the LAST segment only,
// never on provider names (`openai-compatible/x`, `xai-proxy/x` stay unknown).
export function agentFamily(kind, model = '') {
  const fam = kindFamily(kind);
  if (fam !== 'unknown' || model === '') return fam;
  const segs = model.split('/');
  for (const seg of segs) {
    if (FAMILY_PREFIXES.includes(seg)) return seg;
  }
  const last = segs[segs.length - 1];
  if (last.startsWith('claude-')) return 'anthropic';
  if (last.startsWith('gpt-') || last.includes('codex')) return 'openai';
  if (last.startsWith('grok-')) return 'xai';
  if (last.startsWith('gemini-')) return 'google';
  return 'unknown';
}

export function kindExe(kind) {
  return kind === 'cursor' ? 'cursor-agent' : kind;
}

export function effortRank(effort) {
  switch (effort) {
    case 'low': return 1;
    case 'medium': return 2;
    case 'high': return 3;
    case 'xhigh': return 4;
    case 'max': return 5;
    default: return 0;
  }
}

// Empty ceiling (unknown kind, opencode) = nothing to clamp.
export function kindEffortCeiling(kind) {
  switch (kind) {
    case 'claude':
    case 'pi': return 'max';
    case 'codex':
    case 'cursor':
    case 'grok': return 'xhigh';
    case 'agy':
    case 'gemini': return 'high';
    default: return '';
  }
}

// clamp_to <effort> <ceiling>: keep the effort unless it outranks the ceiling.
export function clampTo(effort, ceiling) {
  if (ceiling === '') return effort;
  return effortRank(effort) > effortRank(ceiling) ? ceiling : effort;
}

// cursor_model_with_effort :506-514: a model that already ends in an effort
// suffix is used as-is (warn); otherwise query --list-models and try
// model-effort, then model (warn), then pass-through (warn).
const CURSOR_EFFORT_SUFFIX_RE = /-(low|medium|high|xhigh|max|none)$/;

export function cursorModelWithEffort(model, effort, env = process.env, warn = defaultWarn) {
  if (CURSOR_EFFORT_SUFFIX_RE.test(model)) {
    warn(`cursor model '${model}' already encodes an effort; --effort ignored`);
    return model;
  }
  // Bash hardcodes `timeout 20` here (HERDR_AGENTS_MODELS_TIMEOUT does not
  // apply to this call).
  const r = runCli('cursor-agent', ['--list-models'], { env, timeoutMs: 20000 });
  const ids = parseCursorModels(r.stdout);
  if (ids.includes(`${model}-${effort}`)) return `${model}-${effort}`;
  if (ids.includes(model)) {
    warn(`cursor has no '${model}-${effort}'; using '${model}' (effort = model default)`);
    return model;
  }
  warn(`cursor model '${model}' not in --list-models; passing it through unchanged`);
  return model;
}

// kind_effort_args :515-540 — one arg per array slot, like the bash lines.
export function kindEffortArgs(kind, effort, model, env = process.env, warn = defaultWarn) {
  if (effort === '') return [];
  switch (kind) {
    case 'claude': return ['--effort', effort];
    case 'codex': return ['-c', `model_reasoning_effort="${effort}"`];
    case 'grok': return ['--reasoning-effort', effort];
    case 'agy':
    case 'gemini':
      // agy takes --effort only on Gemini ids; on a Claude or GPT-OSS id it
      // silently falls back to Gemini Flash (Medium). Ids ending in an effort
      // suffix already carry it.
      if (/-(minimal|low|medium|high|xhigh|max)$/.test(model)) return [];
      if (model === '' || model.startsWith('gemini')) return ['--effort', effort];
      warn(`${kind} model '${model}' takes no --effort; effort '${effort}' ignored`);
      return [];
    case 'cursor':
      // Effort rides in the model id; the model flag comes from here so it
      // is never passed twice.
      if (model !== '') return ['--model', cursorModelWithEffort(model, effort, env, warn)];
      warn('cursor ignores --effort without --model (pick an id from: cursor-agent --list-models)');
      return [];
    case 'pi': return ['--thinking', effort];
    case 'opencode':
      // --variant (provider effort) exists only on `opencode run`, not on
      // the TUI herdr starts; effort is not mappable there, so warn, not fail.
      warn(`opencode TUI takes no effort flag (--variant is only in 'opencode run'); effort '${effort}' ignored`);
      return [];
    default:
      warn(`no effort mapping for kind '${kind}'; effort ignored (pass the native flag after --)`);
      return [];
  }
}

// kind_model_args :543-562.
export function kindModelArgs(kind, model, effort, warn = defaultWarn) {
  if (model === '') return [];
  switch (kind) {
    case 'claude':
    case 'agy':
    case 'gemini':
    case 'grok': return ['--model', model];
    case 'codex': return ['-m', model];
    case 'cursor':
      // With effort set, kindEffortArgs already emits --model (suffixed).
      if (effort !== '') return [];
      return ['--model', model];
    case 'pi': return ['--model', model];
    case 'opencode': return ['-m', model];
    default:
      warn(`no model mapping for kind '${kind}'; model ignored`);
      return [];
  }
}

// approvals: ask (agent default) | edits (auto-accept file edits) | full (no
// prompts for tools or MCP servers, inside the CLI's own sandbox where it
// has one). Hook-trust and first-visit workspace-trust dialogs are
// deliberately NOT bypassed: put the CLI's own flag in `args.<kind>`.
export function kindApprovalArgs(kind, mode, warn = defaultWarn) {
  if (mode === '' || mode === 'ask') return [];
  if (mode !== 'edits' && mode !== 'full') {
    throw new DieError(`invalid approvals '${mode}' (ask|edits|full)`, 2);
  }
  switch (`${kind}:${mode}`) {
    case 'claude:edits': return ['--permission-mode', 'acceptEdits'];
    case 'claude:full': return ['--permission-mode', 'bypassPermissions', '--settings', '{"enableAllProjectMcpServers":true}'];
    case 'codex:edits': return ['-s', 'workspace-write', '-a', 'on-request'];
    case 'codex:full': return ['-s', 'workspace-write', '-a', 'never'];
    case 'grok:edits': return ['--permission-mode', 'acceptEdits'];
    case 'grok:full': return ['--permission-mode', 'bypassPermissions', '--always-approve'];
    case 'agy:edits': return ['--mode', 'accept-edits'];
    case 'agy:full': return ['--dangerously-skip-permissions'];
    case 'gemini:edits': return ['--mode', 'accept-edits'];
    case 'gemini:full': return ['--dangerously-skip-permissions'];
    case 'cursor:edits': return ['--trust', '--auto-review'];
    case 'cursor:full': return ['--trust', '--force', '--approve-mcps'];
    case 'pi:full': return []; // pi has no approval prompts at all
    case 'pi:edits':
      warn('pi has no approval prompts (its tools run as-is); approvals=edits is a no-op (restrict tools with --tools/--exclude-tools after --)');
      return [];
    case 'opencode:full': return ['--auto']; // approves permissions not explicitly denied
    case 'opencode:edits':
      warn('opencode has no edits approvals flag; use approvals=full (--auto) or per-tool permissions in opencode.json');
      return [];
    default:
      warn(`no approvals mapping for kind '${kind}'; pass the native flag after --`);
      return [];
  }
}

// kind_context_args :695-703 — lean keeps the worker from loading project
// instruction files where the CLI has a switch.
export function kindContextArgs(kind, mode) {
  if (mode !== 'lean') return [];
  if (kind === 'codex') return ['-c', 'project_doc_max_bytes=0'];
  if (kind === 'claude') return ['--disable-slash-commands'];
  return [];
}

// kind_summary :461-476 — one English sentence for `setup --detect`.
export function kindSummary(kind) {
  switch (kind) {
    case 'grok': return 'Best at writing code, bulk edits, and research. Recommended for implementation and research.';
    case 'cursor': return 'Also runs Grok models. Second choice for implementation and research.';
    case 'codex': return 'Strong at review and judgement. Recommended for review when implementation uses Grok or Cursor.';
    case 'claude': return 'Strong at security review and at leading the team. Recommended for security review, and for review when Codex is not installed.';
    case 'agy': return 'Reads screens well. Recommended for design and visual checks.';
    case 'gemini': return 'Same screen-reading family as agy. Use for design and visual checks when agy is not installed.';
    case 'pi': return 'Generic multi-model harness (pi). Set a provider/model id in the config; effort via --thinking; it has no approval prompts.';
    case 'opencode': return 'Generic multi-model harness (opencode). Set a provider/model id in the config; its TUI maps no effort flag; unattended runs use --auto.';
    default: return 'Installed assistant. Use it when a recommended one is not installed.';
  }
}

function pad(s, n) {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

// cmd_kinds :704-714 — KIND EXECUTABLE FAMILY EFFORT INSTALLED table.
// `installed` is a PATH lookup through findExecutable (PATHEXT on Windows).
export function cmdKinds(env = process.env, platform = process.platform) {
  const row = (a, b, c, d, e) => `${pad(a, 8)} ${pad(b, 13)} ${pad(c, 10)} ${pad(d, 8)} ${e}`;
  const lines = [row('KIND', 'EXECUTABLE', 'FAMILY', 'EFFORT', 'INSTALLED')];
  for (const k of KNOWN_KINDS) {
    const exe = kindExe(k);
    const installed = findExecutable(exe, env, platform) ? 'yes' : 'no';
    lines.push(row(k, exe, kindFamilyDisplay(k), kindEffortCeiling(k), installed));
  }
  process.stdout.write(lines.join('\n') + '\n');
}
