// `setup --probe` (slice 8b of the bash port): one minimal non-interactive
// prompt ("Reply with exactly ok") per kind/model, with a short timeout, no
// pane, no Herdr, no TTY. Each probe is classified ready | no-auth |
// quota | error, and the cause is always a fixed category (not installed |
// timeout after <N>s | not authenticated | quota exhausted [; renews
// <value>] | exit <code>) — the CLI output is never printed, so a key the
// CLI prints in its error line can never reach the JSON. Port of
// scripts/herdr-agents.sh :2225-2330 (PROBE_PROMPT / probe_timeout /
// probe_default_model / probe_cmd / probe_noauth_line / probe_kind) and
// :2332-2417 (need_value + cmd_setup_probe). Reuses the ports of the
// earlier slices: kindExe / kindModelArgs (kinds.mjs), resolveModel
// (models.mjs), quotaDetect / renewalValue (quota.mjs), redactSecrets
// (text.mjs), runCli / findExecutable (platform.mjs), piCustomModelsJson /
// opencodeCustomModelsJson / effectiveBuildFamily / recommendReviewerJson
// (setup-detect.mjs), KNOWN_KINDS / cfg (config.mjs).
//
// The probe runs the CLI with runCli(mergeOutput: true): stdin is
// /dev/null and stdout+stderr share one file (not a pipe), so a CLI child
// left alive holding the output cannot hold the probe past the timeout.
// The combined text is read in the order it was written; the bash
// concatenates the stdout file and then the stderr file — an accepted
// divergence: the classification only searches lines.
import { KNOWN_KINDS, cfg, DieError } from '../config.mjs';
import { kindExe, kindModelArgs } from '../kinds.mjs';
import { resolveModel } from '../models.mjs';
import { findExecutable, runCli } from '../platform.mjs';
import { renewalValue, quotaDetect } from '../quota.mjs';
import { redactSecrets } from '../text.mjs';
import {
  effectiveBuildFamily, opencodeCustomModelsJson, piCustomModelsJson,
  recommendReviewerJson,
} from './setup-detect.mjs';

// PROBE_PROMPT :2225 — the minimal non-interactive prompt.
export const PROBE_PROMPT = 'Reply with exactly ok';

// probe_timeout :2230 — whole seconds >= 1 (0 would disable the limit and
// let a hung CLI block the probe). An invalid HERDR_AGENTS_PROBE_TIMEOUT
// is a usage error, not a fallback: it must be impossible to run a probe
// without a limit. Default 20 s.
export function probeTimeout(env = process.env) {
  const v = env.HERDR_AGENTS_PROBE_TIMEOUT ?? '';
  if (v !== '') {
    if (!/^[1-9][0-9]*$/.test(v)) throw new DieError('setup --probe: timeout must be a whole number of seconds ≥ 1', 2);
    return v;
  }
  return '20';
}

// probe_default_model :2242 — the model spec spawn would use for this
// kind: model.<kind>.worker, then model.<kind>, else the CLI's own
// default (empty). The kinds with a listing resolve the spec (alias/regex)
// the same way spawn does; bash swallows the die (a cursor spec with no
// match) and ends up with the empty model.
export function probeDefaultModel(ctx, kind, env = process.env, cwd = process.cwd()) {
  let m = cfg(ctx, `model_${kind}_worker`, '', env);
  if (m === '') m = cfg(ctx, `model_${kind}`, '', env);
  if (m !== '') {
    switch (kind) {
      // Kinds with a listing: resolve a spec (alias/regex) the same way spawn does.
      case 'codex':
      case 'cursor':
      case 'agy':
      case 'grok':
        try { m = resolveModel(kind, m, '', env, () => {}); } catch { m = ''; }
        break;
      default: break;
    }
  }
  return m;
}

// probe_cmd :2256 — the argv of the probe for one kind/model: the minimal
// prompt and the kind's native model flag, in each CLI's own order.
export function probeCmd(kind, model, warn = () => {}) {
  // bash: kind_model_args … 2>/dev/null — the warnings never reach the
  // probe.
  const ma = kindModelArgs(kind, model, '', warn);
  switch (kind) {
    case 'claude': return ['claude', '-p', PROBE_PROMPT, ...ma];
    case 'codex': return ['codex', 'exec', ...ma, PROBE_PROMPT];
    case 'grok': return ['grok', '-p', PROBE_PROMPT, ...ma];
    case 'agy': return ['agy', '-p', PROBE_PROMPT, ...ma];
    case 'gemini': return ['gemini', '-p', PROBE_PROMPT, ...ma];
    case 'cursor': return ['cursor-agent', '-p', PROBE_PROMPT, ...ma];
    case 'pi': return ['pi', '-p', '--no-session', PROBE_PROMPT, ...ma];
    case 'opencode': return ['opencode', 'run', PROBE_PROMPT, ...ma];
    default: return [kind, PROBE_PROMPT];
  }
}

// probe_noauth_line :2275 — a provider/CLI login message, not an ordinary
// error: the first line matching any of the patterns (bash grep -i -m1
// over the alternatives), '' when none.
const NOAUTH_RES = [
  /not logged in/i,
  /not (yet )?authenticated/i,
  /please (log|sign) ?in/i,
  /log ?in (to|first)/i,
  /unauthorized/i,
  /unauthenticated/i,
  /(missing|no|invalid) (api )?key/i,
  /api key (is )?(missing|required)/i,
  /authentication (failed|required|error)/i,
  /access denied/i,
  /no (valid )?credentials/i,
];
export function probeNoauthLine(text) {
  for (const line of String(text).split('\n')) {
    if (NOAUTH_RES.some((re) => re.test(line))) return line;
  }
  return '';
}

// probe_kind :2295 — one probe: {kind,model,status,cause,source}. The
// cause never copies CLI text: it is a fixed category, so a key the CLI
// prints in its error line can never reach the JSON.
export function probeKind(ctx, kind, model, source = 'configured', timeoutSec = '20', env = process.env, cwd = process.cwd()) {
  const exe = kindExe(kind);
  if (findExecutable(exe, env) === null) {
    return { kind, model, status: 'error', cause: 'not installed', source };
  }
  // probeCmd returns [exe, …argv]; runCli resolves exe on PATH itself.
  const argv = probeCmd(kind, model).slice(1);
  // Each stream to its own file (a live child cannot hold the probe past
  // the timeout); classified as stdout then stderr, like bash `cat "$outf";
  // cat "$errf"` (quotaDetect takes the first renewal line).
  const r = runCli(exe, argv, { env, cwd, timeoutMs: Number(timeoutSec) * 1000, outputFiles: true });
  const combined = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  let status;
  let cause;
  if (r.timedOut || (r.status === null && r.signal !== null)) {
    // bash: timeout exits 124 (137 after a kill); the JS flag stands for
    // both (and for any death by signal).
    status = 'error';
    cause = `timeout after ${timeoutSec}s`;
  } else if (probeNoauthLine(combined) !== '') {
    status = 'no-auth';
    cause = 'not authenticated';
  } else {
    const q = quotaDetect('idle', combined);
    if (q !== null) {
      status = 'quota';
      cause = 'quota exhausted';
      const val = renewalValue(q[1]);
      if (val !== '') cause = `${cause}; renews ${redactSecrets(val)}`;
    } else if (r.status === 0) {
      status = 'ready';
      cause = '';
    } else {
      // A spawn that never ran (a bad shebang interpreter, a file that is
      // not executable) has no exit code: `timeout` reports 127 when the
      // command cannot be found and 126 when it cannot be invoked.
      const rc = r.status ?? (r.error === 'ENOENT' ? 127 : 126);
      status = 'error';
      cause = `exit ${rc}`;
    }
  }
  return { kind, model, status, cause, source };
}

// cmd_setup_probe :2341 — parse the flags (--kind/--model/--timeout; a
// value flag rejects a following flag), check --model-needs---kind and
// the timeout (whole seconds >= 1) before any CLI runs, build the pairs
// (one per KNOWN_KINDS + up to 5 own models per installed generic kind,
// the rest skipped_custom), run the probes, refine the recommended
// reviewer to the kinds that answered a real prompt, and print the JSON
// {probes,recommended_reviewer,skipped_custom} (2-space indent, the bash
// jq key order).
export function cmdSetupProbe(args, ctx, env = process.env, cwd = process.cwd()) {
  let kind = '';
  let model = '';
  let to = '';
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--kind' || a === '--model' || a === '--timeout') {
      // need_value :2332: nothing follows, or the next word is another flag.
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) throw new DieError(`setup --probe: ${a} expects a value`, 2);
      if (a === '--kind') kind = next;
      else if (a === '--model') model = next;
      else to = next;
      i += 1;
    } else {
      throw new DieError(`setup --probe: unknown option '${a}'`, 2);
    }
  }
  // A model belongs to one kind; alone it would be ignored by the aggregate probe.
  if (model !== '' && kind === '') throw new DieError('setup --probe: --model needs --kind (probe one kind/model: --kind K --model M)', 2);
  // Whole seconds >= 1 (0 would disable the limit). Fails before any CLI runs.
  let timeoutSec = probeTimeout(env);
  if (to !== '') {
    if (!/^[1-9][0-9]*$/.test(to)) throw new DieError('setup --probe: timeout must be a whole number of seconds ≥ 1', 2);
    timeoutSec = to;
  }
  if (kind !== '') {
    if (!KNOWN_KINDS.includes(kind)) throw new DieError(`setup --probe: unknown kind '${kind}' (see: kinds)`, 2);
    if (model === '') model = probeDefaultModel(ctx, kind, env, cwd);
  }
  const pairs = [];
  const skipped = [];
  if (kind !== '') {
    pairs.push({ kind, source: 'configured', model });
  } else {
    for (const k of KNOWN_KINDS) pairs.push({ kind: k, source: 'configured', model: probeDefaultModel(ctx, k, env, cwd) });
    // The aggregate probe also covers the user's own models (the
    // --detect custom_models) of each installed generic kind, up to 5 per
    // kind in detect order; the rest is reported in skipped_custom, each
    // probeable with --kind K --model provider/model.
    for (const k of ['pi', 'opencode']) {
      if (findExecutable(kindExe(k), env) === null) continue;
      const cust = k === 'pi' ? piCustomModelsJson(env) : opencodeCustomModelsJson(env, cwd);
      let n = 0;
      for (const c of cust) {
        if (c.id === '') continue;
        n += 1;
        if (n <= 5) pairs.push({ kind: k, source: 'custom', model: c.id });
        else skipped.push({ kind: k, id: c.id });
      }
    }
  }
  const probes = pairs.map((p) => probeKind(ctx, p.kind, p.model, p.source, timeoutSec, env, cwd));
  // The reviewer suggestion is refined to the kinds that answered ready
  // (kind + model, like the bash el_file) over the effective build family.
  const ready = probes.filter((p) => p.status === 'ready').map((p) => ({ kind: p.kind, model: p.model }));
  const rec = recommendReviewerJson(effectiveBuildFamily(ctx, env, cwd), ready);
  process.stdout.write(`${JSON.stringify({ probes, recommended_reviewer: rec, skipped_custom: skipped }, null, 2)}\n`);
}
