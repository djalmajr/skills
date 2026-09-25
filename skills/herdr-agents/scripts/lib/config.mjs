// Configuration engine: file parsing, layers, cfg/cfg_source, validation,
// atomic rewrite, the `config` / `config set` commands and the state root.
// Port of the original bash implementation :77-281 (:378-392 for state_root).
// Behavior is identical to the bash version; CRLF is normalized to LF on
// read (decision 7) and the user config dir follows decision 4.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { die, readTextFile, projectRoot, userConfigPath, atomicWrite } from './platform.mjs';
import { roleFile, roleDirs } from './roles.mjs';
import { sessionConfPath } from './session.mjs';
// Function-level use only (dottedKeyName), so the config<->lanes cycle is
// safe under Node and Bun (like roles<->resolve).
import { laneNames } from './lanes.mjs';

export const CONFIG_SCALAR_KEYS = [
  'orchestrator_name', 'layout', 'regrid', 'max_workers', 'split_max_panes',
  'split_min_pane', 'herd_label', 'herd_label_max', 'reuse_workers',
  'multi_role', 'panes', 'lanes', 'pane_mode', 'flex_extra', 'flex_roles',
  'worker_context', 'brief_lint', 'brief_lint_aliases', 'approvals',
  'auto_approve', 'max_auto_approvals', 'max_effort', 'family_check',
  'settled_grace', 'spawn_timeout', 'dispatch_timeout', 'provider_retries',
  'provider_retry_delay', 'prompt_check_seconds', 'stuck_warn_minutes', 'state_dir',
  'report_language', 'notify', 'feedback', 'feedback_repo',
];
export const KNOWN_KINDS = ['claude', 'codex', 'grok', 'agy', 'gemini', 'cursor', 'pi', 'opencode'];
export const EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max'];

// A library error with the same message/code contract as die(), without
// exiting the process. Command boundaries translate it back to die().
export class DieError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DieError';
    this.code = code;
  }
}

export function skillDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

// Key normalization (:114): drop all whitespace, . and - become _, keep only
// [a-zA-Z0-9_]. `role.implementer.kind` -> `role_implementer_kind`.
export function normalizeKey(raw) {
  return raw.replace(/\s+/g, '').replace(/[.-]/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
}

// Lines of a normalized text (awk-style trailing-newline semantics).
function splitLines(text) {
  if (text === '') return [];
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

// load_config_file() port: cut each line at its first `#`, trim, require `=`,
// normalize the key, trim the value and strip one pair of surrounding double
// quotes. Last assignment of a key in a file wins; later layers win over
// earlier ones.
function loadConfigFile(file, label, ctx) {
  let raw;
  try { raw = readTextFile(file); } catch { return; }
  ctx.sources.push(label);
  for (const rawLine of splitLines(raw)) {
    const hash = rawLine.indexOf('#');
    const line = (hash === -1 ? rawLine : rawLine.slice(0, hash)).trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const rawKey = line.slice(0, eq).trim();
    const key = normalizeKey(rawKey);
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (!key) continue;
    // original: the key as written in the file (dotted, unnormalized) —
    // the `config` table shows the names the files and `session set` use.
    ctx.entries.set(key, { value: val, source: label, original: rawKey });
  }
}

// load_config() port: defaults -> user -> project -> session (only when a
// workspace is resolvable). Returns { entries: Map<key,{value,source}>,
// sources: string[] }.
export function loadConfig(env = process.env, cwd = process.cwd()) {
  const ctx = { entries: new Map(), sources: [] };
  loadConfigFile(path.join(skillDir(), 'config.defaults'), 'defaults', ctx);
  loadConfigFile(userConfigPath(process.platform, env), 'user', ctx);
  loadConfigFile(path.join(projectRoot(env, cwd), '.agents', 'herdr-agents.conf'), 'project', ctx);
  const sf = sessionConfPath(ctx, env, cwd);
  if (sf) loadConfigFile(sf, 'session', ctx);
  return ctx;
}

// cfg <key> [fallback] — env HERDR_AGENTS_<KEY> > config layers > fallback.
// Empty values (env or file) are treated as unset, like the bash `${:-}`.
export function cfg(ctx, key, fallback = '', env = process.env) {
  const envName = `HERDR_AGENTS_${key.toUpperCase()}`;
  const envVal = env[envName];
  if (envVal) return envVal;
  const e = ctx.entries.get(key);
  if (e && e.value !== '') return e.value;
  return fallback;
}

// cfg_source() port: env | user | project | session | defaults | builtin.
// A key defined with an empty value still reports the layer that defined it.
export function cfgSource(ctx, key, env = process.env) {
  const envName = `HERDR_AGENTS_${key.toUpperCase()}`;
  if (env[envName]) return 'env';
  const e = ctx.entries.get(key);
  return e ? e.source : 'builtin';
}

// config_key_ok() port: scalar keys plus role/model/effort/args/lane patterns.
const DOTTED_KEY_RE = /^(?:role\.[a-z][a-z0-9_-]*\.(?:kind|model|effort|args)|lane\.[a-z][a-z0-9_-]*\.(?:roles|kind|model|effort|approvals|panes|args)|model\.[a-z][a-z0-9_.-]+|effort\.[a-z][a-z0-9_-]+|args\.[a-z][a-z0-9_-]+)$/;
export function configKeyOk(key) {
  if (CONFIG_SCALAR_KEYS.includes(key)) return true;
  return DOTTED_KEY_RE.test(key);
}

// config_roles_ok() port: every CSV token resolves to a role file.
export function configRolesOk(raw, env = process.env, cwd = process.cwd()) {
  if (!raw) return false;
  for (let r of raw.split(',')) {
    r = r.trim();
    if (!r) return false;
    if (!roleFile(r, env, cwd)) return false;
  }
  return true;
}

// config_value_ok() port: known enums only; other keys accept any one-line
// value without #, \n or \t (the loader cuts lines at the first #).
export function configValueOk(key, value, env = process.env, cwd = process.cwd()) {
  if (value.includes('\n') || value.includes('\t') || value.includes('#')) return false;
  if (key === 'approvals' || /^lane\..*\.approvals$/.test(key)) return ['ask', 'edits', 'full'].includes(value);
  if (key === 'max_workers' || key === 'provider_retries' || key === 'provider_retry_delay'
    || key === 'prompt_check_seconds' || key === 'stuck_warn_minutes') return /^[0-9]+$/.test(value);
  if (key === 'multi_role' || key === 'reuse_workers' || key === 'lanes') return ['on', 'off'].includes(value);
  if (key === 'panes') return ['2', '3', '4'].includes(value);
  if (key === 'pane_mode') return ['strict', 'flex'].includes(value);
  if (key === 'flex_extra') return /^[0-9]+$/.test(value);
  if (key === 'flex_roles') return configRolesOk(value, env, cwd);
  if (/^lane\..*\.panes$/.test(key)) return /^[1-9][0-9]*$/.test(value);
  if (/^role\..*\.kind$/.test(key) || /^lane\..*\.kind$/.test(key)) return KNOWN_KINDS.includes(value);
  if (/^lane\..*\.roles$/.test(key)) return configRolesOk(value, env, cwd);
  if (/^lane\..*\.effort$/.test(key)) return EFFORT_LADDER.includes(value);
  return true;
}

// config_file_for() port: `user` -> user config file; anything else -> project.
export function configFileFor(where, env = process.env, cwd = process.cwd()) {
  if (where === 'user') return userConfigPath(process.platform, env);
  return path.join(projectRoot(env, cwd), '.agents', 'herdr-agents.conf');
}

// state_root() path, no side effects: $HERDR_AGENTS_DIR (non-empty) else
// cfg state_dir .herdr-agents; relative paths are under the project root.
export function stateRootPath(ctx, env = process.env, cwd = process.cwd()) {
  let d = env.HERDR_AGENTS_DIR || cfg(ctx, 'state_dir', '.herdr-agents', env);
  if (!path.isAbsolute(d)) d = projectRoot(env, cwd) + '/' + d;
  return d;
}

// state_root() port: also keeps the .gitignore entry current (relative state
// dir under a git work tree that does not ignore it yet).
export function stateRoot(ctx, env = process.env, cwd = process.cwd()) {
  const root = projectRoot(env, cwd);
  const d = stateRootPath(ctx, env, cwd);
  const prefix = root + '/';
  if (d.startsWith(prefix)) {
    const rel = d.slice(prefix.length);
    const wt = spawnSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { env, stdio: 'ignore' });
    if (wt.status === 0 && gitignoreNeeds(root, rel, env)) {
      // Append (not rewrite): a symlinked .gitignore stays a link.
      const gi = path.join(root, '.gitignore');
      let text = '';
      try { text = readTextFile(gi); } catch { /* absent */ }
      fs.appendFileSync(gi, gitignoreAfter(text, rel).slice(text.length));
    }
  }
  return d;
}

// gitignore_needs: `<rel>/` must be added to the repo's .gitignore only when
// git says the path is definitely not ignored (check-ignore exit 1; an error
// such as 128 under load adds nothing, the next run retries) and no line of
// the file already names it.
export function gitignoreNeeds(root, rel, env = process.env) {
  const ci = spawnSync('git', ['-C', root, 'check-ignore', '-q', rel], { env, stdio: 'ignore', timeout: 30_000 });
  if (ci.status !== 1) return false;
  let text = '';
  try { text = readTextFile(path.join(root, '.gitignore')); } catch { return true; }
  const names = new Set([rel, `${rel}/`, `/${rel}`, `/${rel}/`]);
  return !text.split('\n').some((l) => names.has(l.replace(/\r$/, '')));
}

// gitignore_after: the .gitignore text with `<rel>/` appended on a line of
// its own, even when the text does not end with a newline.
export function gitignoreAfter(text, rel) {
  const sep = text !== '' && !text.endsWith('\n') ? '\n' : '';
  return `${text}${sep}${rel}/\n`;
}

// config_write_pair() port. Full-line comments stay; a trailing comment on
// the replaced line stays; duplicate assignments collapse to the first;
// missing keys are appended. The destination is replaced only after the
// rewrite still contains `key=` (die 4, file untouched otherwise).
export function configWritePair(dest, key, value, env = process.env) {
  // A missing file reads as empty; atomicWrite creates it 0600 (as bash's
  // mktemp + mv ends up).
  let raw = '';
  if (fs.existsSync(dest)) raw = readTextFile(dest);
  const out = [];
  let found = false;
  for (const rawLine of splitLines(raw)) {
    let body = rawLine;
    let comment = '';
    const m = body.match(/[ \t]#.*$/);
    if (m) {
      comment = body.slice(m.index);
      body = body.slice(0, m.index);
    }
    const stripped = body.trim();
    if (stripped === '' || stripped.startsWith('#')) {
      out.push(rawLine);
      continue;
    }
    const eq = stripped.indexOf('=');
    if (eq === -1) {
      out.push(rawLine);
      continue;
    }
    const k = stripped.slice(0, eq).trim();
    if (k === key) {
      if (!found) out.push(`${key}=${value}${comment}`);
      found = true;
      continue;
    }
    out.push(rawLine);
  }
  if (!found) out.push(`${key}=${value}`);
  const content = out.join('\n') + '\n';
  if (!content.includes(`${key}=`)) {
    throw new DieError(`config set: rewrite of ${dest} dropped ${key} (file left untouched)`, 4);
  }
  try {
    atomicWrite(dest, content);
  } catch {
    throw new DieError(`config set: could not rewrite ${dest} (file left untouched)`, 4);
  }
}

// file_key_value <file> <key> (:1134) — the LAST assignment of the exact
// trimmed key in the raw file, ignoring comments; '' when the file is
// missing or the key has no non-empty value. Keys are compared as written
// (dotted, unnormalized), so the lane migrator reads role.<r>.kind and
// lane.<l>.model straight from the file.
export function fileKeyValue(file, key) {
  let raw;
  try { raw = readTextFile(file); } catch { return ''; }
  let v = '';
  for (const rawLine of splitLines(raw)) {
    let body = rawLine;
    const m = body.match(/[ \t]#.*$/);
    if (m) body = body.slice(0, m.index);
    const stripped = body.trim();
    if (stripped === '' || stripped.startsWith('#')) continue;
    const eq = stripped.indexOf('=');
    if (eq === -1) continue;
    const k = stripped.slice(0, eq).trim();
    if (k === key) v = stripped.slice(eq + 1).trim();
  }
  return v;
}

// session_clear rewrite: same as config_write_pair without a value — drops
// every line whose key matches, keeps everything else byte-identical.
export function configClearKey(file, key) {
  const raw = readTextFile(file);
  const out = [];
  for (const rawLine of splitLines(raw)) {
    let body = rawLine;
    const m = body.match(/[ \t]#.*$/);
    if (m) body = body.slice(0, m.index);
    const stripped = body.trim();
    if (stripped !== '' && !stripped.startsWith('#')) {
      const eq = stripped.indexOf('=');
      if (eq !== -1 && stripped.slice(0, eq).trim() === key) continue;
    }
    out.push(rawLine);
  }
  const content = out.join('\n') + (out.length ? '\n' : '');
  try {
    atomicWrite(file, content);
  } catch {
    die(`session clear: could not rewrite ${file} (file left untouched)`, 4);
  }
}

function pad(s, n) {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

// dottedKeyName: the dotted spelling of a normalized dotted key for the
// `config` table, for a key that only exists in the environment
// (HERDR_AGENTS_* — the files do not hold an original spelling then):
// args.<kind> / effort.<kind> join with dots; model.<kind>[.worker|
// orchestrator] keeps its position; the role and lane middles are restored
// to a known role name (a role file) or lane name (the effective lanes) —
// the known spelling when the NORMALIZED names agree ('-' and '_' as the
// same character: a file lane.build-ui_v2.roles makes build-ui_v2 known),
// the underscored middle otherwise.
export function dottedKeyName(key, ctx, env = process.env, cwd = process.cwd()) {
  const parts = String(key).split('_');
  const head = parts[0] ?? '';
  if (head === 'args' || head === 'effort') return parts.join('.');
  if (head === 'model') {
    const position = parts[parts.length - 1];
    if (parts.length >= 3 && (position === 'worker' || position === 'orchestrator')) {
      return `model.${parts.slice(1, -1).join('.')}.${position}`;
    }
    return parts.join('.');
  }
  if ((head === 'role' || head === 'lane') && parts.length >= 3) {
    const attr = parts[parts.length - 1];
    const middle = parts.slice(1, -1).join('_');
    // The known spellings, by normalized name ('-' and '_' as the same
    // character) — the files' own spellings first (what the user wrote),
    // the effective lane names then (all underscores: file middles are
    // normalized, shell names cannot carry a hyphen).
    const norm = (s) => s.replace(/-/g, '_');
    const known = new Map();
    if (head === 'role') {
      for (const d of roleDirs(env, cwd)) {
        let entries;
        try { entries = fs.readdirSync(d); } catch { continue; }
        for (const name of entries) {
          if (!name.endsWith('.md')) continue;
          const r = name.slice(0, -3);
          if (!known.has(norm(r))) known.set(norm(r), r);
        }
      }
    } else {
      for (const k of ctx.entries.keys()) {
        if (!k.startsWith('lane_')) continue;
        const e = ctx.entries.get(k);
        if (!e || e.original === undefined) continue;
        const om = String(e.original).match(/^lane\.([A-Za-z0-9_-]+)\./);
        if (!om) continue;
        const spelling = om[1];
        if (!known.has(norm(spelling))) known.set(norm(spelling), spelling);
      }
      for (const l of laneNames(ctx, env)) {
        if (!known.has(norm(l))) known.set(norm(l), l);
      }
    }
    const spelling = known.get(norm(middle));
    if (spelling !== undefined) return `${head}.${spelling}.${attr}`;
    return `${head}.${middle}.${attr}`;
  }
  return parts.join('.');
}

// cmd_config() port: KEY VALUE SOURCE table for the scalar keys (in order),
// then the dotted keys (args/role/model/effort/lane, sorted) — the file's
// own spelling when a layer holds the key, the rebuilt dotted name for a
// key that only exists in the environment — then the layers and the layer
// file paths.
export function cmdConfig(ctx, env = process.env, cwd = process.cwd()) {
  const row = (k, v, s) => `${pad(k, 18)} ${pad(v, 30)} ${s}`;
  const lines = [row('KEY', 'VALUE', 'SOURCE')];
  for (const k of CONFIG_SCALAR_KEYS) lines.push(row(k, cfg(ctx, k, '', env), cfgSource(ctx, k, env)));
  const dotted = new Set();
  for (const k of ctx.entries.keys()) {
    if (/^(args|role|model|effort|lane)_/.test(k)) dotted.add(k);
  }
  // A dotted key that only the environment defines (HERDR_AGENTS_<KEY>):
  // cfg() never sees it through a file layer, so list it from the env itself
  // (empty env values count as unset, like the rest of cfg).
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith('HERDR_AGENTS_') || value === '') continue;
    const k = normalizeKey(name.slice('HERDR_AGENTS_'.length)).toLowerCase();
    if (/^(args|role|model|effort|lane)_/.test(k)) dotted.add(k);
  }
  for (const k of [...dotted].sort()) {
    const e = ctx.entries.get(k);
    const name = e && e.original !== undefined ? e.original : dottedKeyName(k, ctx, env, cwd);
    lines.push(row(name, cfg(ctx, k, '', env), cfgSource(ctx, k, env)));
  }
  lines.push(`\nlayers read:${ctx.sources.length ? ' ' + ctx.sources.join(' ') : ' (none)'}`);
  lines.push(`user file:    ${userConfigPath(process.platform, env)}`);
  lines.push(`project file: ${path.join(projectRoot(env, cwd), '.agents', 'herdr-agents.conf')}`);
  const sf = sessionConfPath(ctx, env, cwd);
  lines.push(`session file: ${sf || '(no workspace here)'}`);
  process.stdout.write(lines.join('\n') + '\n');
}

// A single `key=value` argument is the pair, like a line of the config file
// (`config set lanes=off`); `key value` as two arguments works as before. A
// single argument holding a space is almost always a shell variable that was
// not split (zsh keeps "$kv" whole): say so instead of a bare usage error.
export function splitPairArg(key, value, sawValue, cmd) {
  if (sawValue !== 0 || key === '') return { key, value, sawValue };
  const eq = key.indexOf('=');
  if (eq > 0) return { key: key.slice(0, eq), value: key.slice(eq + 1), sawValue: 1 };
  if (/\s/.test(key)) {
    die(`${cmd}: '${key}' arrived as one argument; pass the key and the value as two arguments or as key=value (zsh does not split "$var": use \${=var})`, 2);
  }
  return { key, value, sawValue };
}

// cmd_config_set() port: config set <key> <value> [--project|--user].
export function cmdConfigSet(argv, ctx, env = process.env, cwd = process.cwd()) {
  let key = '';
  let value = '';
  let where = 'project';
  let sawValue = 0;
  for (const a of argv) {
    if (a === '--project' || a === '--user') { where = a === '--user' ? 'user' : 'project'; continue; }
    if (a.startsWith('--')) die(`config set: unknown option '${a}'`, 2);
    if (!key) {
      // An unquoted `key=<part> <rest>`: the shell splits the value on the
      // space and the first half arrives as `key=<part>` — split at the
      // first `=` so the next argument continues the value.
      const eq = a.indexOf('=');
      if (eq > 0) { key = a.slice(0, eq); value = a.slice(eq + 1); if (value !== '') sawValue = 1; }
      else key = a;
      continue;
    }
    if (sawValue === 0) { value = a; sawValue = 1; }
    // A value that starts with `-` (native CLI args, e.g. `-c a=b`) is not
    // split by the shell: keep joining the following arguments until the
    // value is complete. Values without a dash keep the old strict parse.
    else if (value.startsWith('-')) value += ` ${a}`;
    else die(`config set: unexpected argument '${a}'`, 2);
  }
  ({ key, value, sawValue } = splitPairArg(key, value, sawValue, 'config set'));
  if (!key || sawValue === 0) die('usage: config set <key> <value> | <key>=<value> [--project|--user]', 2);
  if (!value) die('config set: empty value', 2);
  if (!configKeyOk(key)) die(`config set: unknown key '${key}'`, 2);
  if (!configValueOk(key, value, env, cwd)) die(`config set: invalid value '${value}' for ${key}`, 2);
  const dest = configFileFor(where, env, cwd);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    configWritePair(dest, key, value, env);
  } catch (e) {
    if (e instanceof DieError) die(e.message, e.code);
    throw e;
  }
  process.stdout.write(`set ${key}=${value} in ${dest}\n`);
}
