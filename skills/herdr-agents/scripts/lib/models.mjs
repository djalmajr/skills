// Model listing, version ordering, resolution and the `models`/`model`
// commands (slice 2). Port of scripts/herdr-agents.sh :564-654.
//
// CLI calls go through runCli (PATH/PATHEXT, timeout, no shell). The model
// cache keeps the same location and format as bash:
// $TMPDIR/herdr-agents-models-<kind>.txt (joined with the platform
// separator), fresh for 60 minutes, not written while
// HERDR_AGENTS_MODELS_TIMEOUT shortens the CLI calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { die, homeDir, readTextFile, runCli } from './platform.mjs';
import {
  DieError, defaultWarn, agentFamily, kindEffortCeiling,
  kindModelArgs, kindEffortArgs, effortRank,
} from './kinds.mjs';

// -(minimal|low|medium|high|xhigh|max)(-fast)?$ (bash EFFORT_SUFFIX_RE :564).
export const EFFORT_SUFFIX_RE = /-(minimal|low|medium|high|xhigh|max)(-fast)?$/;

// Parsers per kind (bash :571-590). Output is always a list of ids, one per
// line; a failing CLI yields an empty list (pass-through spec downstream).

// cursor: `cursor-agent --list-models`, lines like `grok-4.7 - xAI Grok 4.7`.
export function parseCursorModels(stdout) {
  const ids = [];
  for (const line of String(stdout).split('\n')) {
    const m = line.match(/^([a-z0-9.-]+) - /);
    if (m) ids.push(m[1]);
  }
  return ids;
}

// agy: `agy models`, NF>=2 with a bare id in field 1.
export function parseAgyModels(stdout) {
  const ids = [];
  for (const line of String(stdout).split('\n')) {
    const parts = line.trim().split(/\s+/).filter((p) => p !== '');
    if (parts.length >= 2 && /^[a-z0-9.-]+$/.test(parts[0])) ids.push(parts[0]);
  }
  return ids;
}

// grok: `grok models`, every `grok-N...` token, sorted unique (grep -oE |
// sort -u).
export function parseGrokModels(stdout) {
  const out = new Set();
  for (const line of String(stdout).split('\n')) {
    const m = line.match(/grok-[0-9][0-9a-z.-]*/g);
    if (m) for (const id of m) out.add(id);
  }
  return [...out].sort();
}

export function modelsCacheFile(kind, env = process.env) {
  return path.join(env.TMPDIR || os.tmpdir(), `herdr-agents-models-${kind}.txt`);
}

// model_ids :571-590 — one id per line (cached for 1h); empty for kinds
// without a list. HERDR_AGENTS_MODELS_TIMEOUT (seconds) shortens the CLI
// calls and does not write the cache.
export function modelIds(kind, env = process.env) {
  const file = modelsCacheFile(kind, env);
  const tRaw = env.HERDR_AGENTS_MODELS_TIMEOUT;
  const short = tRaw !== undefined && tRaw !== '';
  try {
    const st = fs.statSync(file);
    if (st.size > 0 && st.mtimeMs > Date.now() - 60 * 60 * 1000) {
      return readTextFile(file).split('\n').filter((l) => l !== '');
    }
  } catch { /* no fresh cache */ }
  // t(default): the effective timeout in seconds; null when the configured
  // value is not a number (bash `timeout <bad>` fails -> empty output).
  const t = (dflt) => {
    if (!short) return dflt;
    const n = Number(tRaw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  let out = [];
  switch (kind) {
    case 'codex': {
      // No CLI call: read ~/.codex/models_cache.json (.models[].slug).
      const f = path.join(homeDir(process.platform, env), '.codex', 'models_cache.json');
      try {
        const data = JSON.parse(readTextFile(f));
        if (data && Array.isArray(data.models)) {
          out = data.models
            .map((m) => (m && m.slug !== null && m.slug !== undefined) ? String(m.slug) : '')
            .filter((s) => s !== '');
        }
      } catch { out = []; }
      break;
    }
    case 'cursor': {
      const sec = t(20);
      if (sec !== null) out = parseCursorModels(runCli('cursor-agent', ['--list-models'], { env, timeoutMs: sec * 1000 }).stdout);
      break;
    }
    case 'agy': {
      const sec = t(30);
      if (sec !== null) out = parseAgyModels(runCli('agy', ['models'], { env, timeoutMs: sec * 1000 }).stdout);
      break;
    }
    case 'grok': {
      const sec = t(20);
      if (sec !== null) out = parseGrokModels(runCli('grok', ['models'], { env, timeoutMs: sec * 1000 }).stdout);
      break;
    }
    default:
      out = [];
  }
  if (!short && out.length > 0) {
    try { fs.writeFileSync(file, out.join('\n') + '\n'); } catch { /* cache write is best effort */ }
  }
  return out;
}

// version_sort_desc :591-599 — newest first: numeric fields compared left to
// right (zero-padded to 6 digits per field, as strings), lexicographic
// tie-break on the id. Matches the bash `sort -k1,1r -k2,2` on ASCII ids.
export function versionSortDesc(ids) {
  const keyed = ids.map((id) => {
    const key = id.split(/[^0-9]+/)
      .filter((p) => /^\d+$/.test(p))
      .map((p) => `${p.padStart(6, '0')}.`)
      .join('');
    return { key, id };
  });
  keyed.sort((a, b) => {
    if (a.key !== b.key) return a.key > b.key ? -1 : 1;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return 0;
  });
  return keyed.map((k) => k.id);
}

// ereRegExp <pattern> [flags] — the model-spec dialect. Bash hands the spec to
// whatever `grep -E` is installed (GNU, BSD, ugrep), and they disagree on
// escapes, so the dialect is defined here instead: a case-insensitive regex
// where `(?…` groups (lookarounds, named or non-capturing groups) return null
// — no grep accepts them, so the spec passes through unresolved — POSIX
// bracket classes (`[[:digit:]]`) are translated, and \d \w \s \b \xHH work.
const UNSUPPORTED_RE = /\(\?/;
const POSIX_CLASS = {
  alpha: 'A-Za-z', digit: '0-9', alnum: 'A-Za-z0-9', upper: 'A-Z', lower: 'a-z',
  xdigit: '0-9A-Fa-f', space: ' \\t\\n\\r\\f\\v', blank: ' \\t',
  punct: '!-\\/:-@\\[-`{-~',
};
export function ereRegExp(pattern, flags = 'i') {
  if (UNSUPPORTED_RE.test(pattern)) return null;
  const src = pattern.replace(/\[:([a-z]+):\]/g, (m, name) => POSIX_CLASS[name] ?? m);
  try { return new RegExp(src, flags); } catch { return null; }
}

// resolve_model :602-635 — spec = exact id | alias | case-insensitive ERE
// over the listed ids; `a|b` tries alternatives in order. Without a list the
// spec passes through unchanged. cursor is strict (die 2): its CLI rejects
// ids absent from --list-models.
export function resolveModel(kind, spec, effort, env = process.env, warn = defaultWarn) {
  if (spec === '') return '';
  const ids = modelIds(kind, env);
  if (ids.length === 0) return spec;
  for (const raw of spec.split('|')) {
    const alt = raw.trim();
    if (alt === '') continue;
    if (ids.includes(alt)) return alt;
    const re = ereRegExp(alt); // grep -iE; a bad or non-ERE pattern: no match
    if (kind === 'cursor' || kind === 'agy') {
      // Strip the effort suffix, dedupe, regex over the bases, exclude
      // -fast, newest base wins.
      const stripped = [...new Set(ids.map((i) => i.replace(EFFORT_SUFFIX_RE, '')))];
      const matched = re ? stripped.filter((s) => re.test(s) && !s.endsWith('-fast')) : [];
      const base = versionSortDesc(matched)[0] ?? '';
      if (base === '') continue;
      if (effort !== '' && ids.includes(`${base}-${effort}`)) return `${base}-${effort}`;
      if (ids.includes(base)) return base;
      for (const cand of ['max', 'xhigh', 'high', 'medium', 'low', 'minimal']) {
        if (effort !== '' && effortRank(cand) > effortRank(effort)) continue;
        if (ids.includes(`${base}-${cand}`)) return `${base}-${cand}`;
      }
      // bash: grep -E "^$base-" — $base is unescaped (dots match any char);
      // replicate with a regex, falling back to a literal prefix.
      const reFb = ereRegExp(`^${base}-`, '');
      const m = ids.find((i) => (reFb ? reFb.test(i) : i.startsWith(`${base}-`)));
      return m ?? '';
    }
    const cand = re ? versionSortDesc(ids.filter((i) => re.test(i)))[0] : '';
    if (cand) return cand;
  }
  if (kind === 'cursor') {
    throw new DieError(`no cursor model matches '${spec}'; cursor-agent rejects model ids absent from --list-models (context overrides are only usable when that model/account exposes them)`, 2);
  }
  warn(`no ${kind} model matches '${spec}'; passing it through unchanged`);
  return spec;
}

// codex_model_ceiling :636-650 — highest reasoning effort the cached model
// advertises; '' when the file or the model is absent.
export function codexModelCeiling(model, env = process.env) {
  const f = path.join(homeDir(process.platform, env), '.codex', 'models_cache.json');
  let data;
  try { data = JSON.parse(readTextFile(f)); } catch { return ''; }
  const models = data && Array.isArray(data.models) ? data.models : [];
  let best = '';
  let bestRank = 0;
  for (const m of models) {
    if (!m || m.slug !== model || !Array.isArray(m.supported_reasoning_levels)) continue;
    for (const l of m.supported_reasoning_levels) {
      if (!l || typeof l.effort !== 'string') continue;
      const r = effortRank(l.effort);
      if (r > bestRank) { bestRank = r; best = l.effort; }
    }
  }
  return best;
}

// cmd_models :642 — list the ids of one kind, newest first.
export function cmdModels(argv, env = process.env) {
  const kind = argv[0] ?? '';
  if (!kind) {
    // Bash `${1:?kind}`: `1: kind` on stderr, exit 1.
    process.stderr.write('herdr-agents.mjs: 1: kind\n');
    process.exit(1);
  }
  const ids = modelIds(kind, env);
  // The bash pipeline `printf '%s\n' "$out" | version_sort_desc` always
  // emits at least one line: a blank line when the list is empty. Reproduce
  // the exact stdout for kinds without a list.
  const sorted = ids.length ? versionSortDesc(ids) : [''];
  for (const id of sorted) process.stdout.write(`${id}\n`);
}

// cmd_model :643-654 — JSON {kind,spec,effort,model,family,effort_ceiling,
// agent_args}; warnings from the arg functions are suppressed, like the
// bash `2>/dev/null` on the group.
export function cmdModel(argv, env = process.env) {
  const kind = argv[0] ?? '';
  const spec = argv[1] ?? '';
  const effort = argv[2] ?? '';
  if (!kind) {
    process.stderr.write('herdr-agents.mjs: 1: kind\n');
    process.exit(1);
  }
  if (!spec) {
    process.stderr.write('herdr-agents.mjs: 2: spec\n');
    process.exit(1);
  }
  let r;
  try {
    r = resolveModel(kind, spec, effort, env);
  } catch (e) {
    if (e instanceof DieError) die(e.message, e.code);
    throw e;
  }
  const quiet = () => {};
  const agentArgs = [...kindModelArgs(kind, r, effort, quiet), ...kindEffortArgs(kind, effort, r, env, quiet)];
  const out = {
    kind,
    spec,
    effort,
    model: r,
    family: agentFamily(kind, r),
    effort_ceiling: kind === 'codex' ? codexModelCeiling(r, env) : kindEffortCeiling(kind),
    agent_args: agentArgs.join(' '),
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}
