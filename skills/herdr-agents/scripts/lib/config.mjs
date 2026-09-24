// Configuration engine: file parsing, layers, cfg/cfg_source, validation,
// atomic rewrite, the `config` / `config set` commands and the state root.
// Port of scripts/herdr-agents.sh :77-281 (:378-392 for state_root).
// Behavior is identical to the bash version; CRLF is normalized to LF on
// read (decision 7) and the user config dir follows decision 4.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { die, readTextFile, projectRoot, userConfigPath, atomicWrite } from './platform.mjs';
import { roleFile } from './roles.mjs';
import { sessionConfPath } from './session.mjs';

export const CONFIG_SCALAR_KEYS = [
  'orchestrator_name', 'layout', 'regrid', 'max_workers', 'split_max_panes',
  'split_min_pane', 'herd_label', 'herd_label_max', 'reuse_workers',
  'multi_role', 'panes', 'lanes', 'worker_context', 'brief_lint', 'approvals',
  'auto_approve', 'max_auto_approvals', 'max_effort', 'family_check',
  'settled_grace', 'spawn_timeout', 'dispatch_timeout', 'state_dir',
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
    const key = normalizeKey(line.slice(0, eq));
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (!key) continue;
    ctx.entries.set(key, { value: val, source: label });
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
const DOTTED_KEY_RE = /^(?:role\.[a-z][a-z0-9_-]*\.(?:kind|model|effort)|lane\.[a-z][a-z0-9_-]*\.(?:roles|kind|model|effort|approvals)|model\.[a-z][a-z0-9_.-]+|effort\.[a-z][a-z0-9_-]+|args\.[a-z][a-z0-9_-]+)$/;
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
  if (key === 'max_workers') return /^[0-9]+$/.test(value);
  if (key === 'multi_role' || key === 'reuse_workers' || key === 'lanes') return ['on', 'off'].includes(value);
  if (key === 'panes') return ['3', '4'].includes(value);
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
    if (wt.status === 0) {
      const ci = spawnSync('git', ['-C', root, 'check-ignore', '-q', rel], { env, stdio: 'ignore' });
      if (ci.status !== 0) fs.appendFileSync(path.join(root, '.gitignore'), `${rel}/\n`);
    }
  }
  return d;
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

// cmd_config() port: KEY VALUE SOURCE table for the scalar keys (in order),
// then the dotted keys (args/role/model/effort/lane, sorted), then the layers
// and the layer file paths.
export function cmdConfig(ctx, env = process.env, cwd = process.cwd()) {
  const row = (k, v, s) => `${pad(k, 18)} ${pad(v, 30)} ${s}`;
  const lines = [row('KEY', 'VALUE', 'SOURCE')];
  for (const k of CONFIG_SCALAR_KEYS) lines.push(row(k, cfg(ctx, k, '', env), cfgSource(ctx, k, env)));
  const dotted = [...ctx.entries.keys()]
    .filter((k) => /^(args|role|model|effort|lane)_/.test(k))
    .sort();
  for (const k of dotted) lines.push(row(k, cfg(ctx, k, '', env), cfgSource(ctx, k, env)));
  lines.push(`\nlayers read:${ctx.sources.length ? ' ' + ctx.sources.join(' ') : ' (none)'}`);
  lines.push(`user file:    ${userConfigPath(process.platform, env)}`);
  lines.push(`project file: ${path.join(projectRoot(env, cwd), '.agents', 'herdr-agents.conf')}`);
  const sf = sessionConfPath(ctx, env, cwd);
  lines.push(`session file: ${sf || '(no workspace here)'}`);
  process.stdout.write(lines.join('\n') + '\n');
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
    if (!key) key = a;
    else if (sawValue === 0) { value = a; sawValue = 1; }
    else die(`config set: unexpected argument '${a}'`, 2);
  }
  if (!key || sawValue === 0) die('usage: config set <key> <value> [--project|--user]', 2);
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
