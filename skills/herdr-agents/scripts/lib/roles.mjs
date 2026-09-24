// Roles: directories, resolution, frontmatter (fm_get / role_body) and the
// `roles` / `role` commands. Port of scripts/herdr-agents.sh :403-457.
// Frontmatter files are read CRLF-normalized (decision 7).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { die, readTextFile, projectRoot } from './platform.mjs';

export function skillDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

// role_dirs() port: project .agents/herdr-roles, then $HERDR_AGENTS_ROLES
// (when a directory), then the skill's own roles dir.
export function roleDirs(env = process.env, cwd = process.cwd()) {
  const dirs = [];
  const project = path.join(projectRoot(env, cwd), '.agents', 'herdr-roles');
  if (isDir(project)) dirs.push(project);
  const extra = env.HERDR_AGENTS_ROLES;
  if (extra && isDir(extra)) dirs.push(extra);
  dirs.push(path.join(skillDir(), 'roles'));
  return dirs;
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// role_file() port: first directory wins; null when unknown (no die).
export function roleFile(role, env = process.env, cwd = process.cwd()) {
  for (const d of roleDirs(env, cwd)) {
    const f = path.join(d, `${role}.md`);
    if (isFile(f)) return f;
  }
  return null;
}

// resolve_role() port: first directory wins; unknown -> die 3.
export function resolveRole(role, env = process.env, cwd = process.cwd()) {
  const f = roleFile(role, env, cwd);
  if (f) return f;
  die(`unknown role '${role}' (run: herdr-agents.sh roles)`, 3);
}

// fm_get() port: frontmatter value for a key (first line must be `---`;
// frontmatter ends at the next `---`). List values `[a, b]` are flattened to
// `a b`; quotes are dropped; runs of spaces collapse to one. Empty string
// when the key is absent or the file has no frontmatter.
export function fmGet(file, key) {
  let text;
  try { text = readTextFile(file); } catch { return ''; }
  const lines = splitLines(text);
  if (lines[0] !== '---') return '';
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') break;
    const ci = lines[i].indexOf(':');
    if (ci === -1) continue;
    const k = lines[i].slice(0, ci).trim();
    if (k !== key) continue;
    let v = lines[i].slice(ci + 1).trim();
    if (v.startsWith('[')) v = v.slice(1);
    if (v.endsWith(']')) v = v.slice(0, -1);
    v = v.replace(/,/g, ' ').replace(/"/g, '').replace(/ +/g, ' ');
    return v;
  }
  return '';
}

// role_body() port: everything after the closing `---`; the whole file when
// the first line is not `---`; empty when the frontmatter never closes.
export function roleBody(file) {
  let text;
  try { text = readTextFile(file); } catch { return ''; }
  const lines = splitLines(text);
  if (lines[0] !== '---') return lines.length ? lines.join('\n') + '\n' : '';
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      const body = lines.slice(i + 1);
      return body.length ? body.join('\n') + '\n' : '';
    }
  }
  return '';
}

// Lines of a normalized text, awk-style: a trailing newline does not create a
// phantom last line, and a missing trailing newline still counts the last line.
function splitLines(text) {
  if (text === '') return [];
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

function pad(s, n) {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

// cmd_roles() port: one line per role file, first directory wins per name,
// glob-sorted per directory.
export function cmdRoles(env = process.env, cwd = process.cwd()) {
  const lines = [`${pad('ROLE', 18)} ${pad('KIND', 8)} ${pad('EFFORT', 8)} ${pad('MODE', 10)} SOURCE`];
  const seen = new Set();
  for (const d of roleDirs(env, cwd)) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    names = names.filter((n) => n.endsWith('.md')).sort();
    for (const n of names) {
      const full = path.join(d, n);
      if (!fs.existsSync(full)) continue;
      const name = n.slice(0, -3);
      if (seen.has(name)) continue;
      seen.add(name);
      lines.push(`${pad(name, 18)} ${pad(fmGet(full, 'kind'), 8)} ${pad(fmGet(full, 'effort'), 8)} ${pad(fmGet(full, 'mode'), 10)} ${full}`);
    }
  }
  process.stdout.write(lines.join('\n') + '\n');
}

// cmd_role() port: jq -n shape, pretty-printed, same key order.
export function cmdRole(argv, env = process.env, cwd = process.cwd()) {
  if (!argv.length) {
    // Bash uses ${1:?role} here: "1: role" on stderr, exit 1. The original
    // message carries the bash script path and line number, which has no JS
    // equivalent; keep the wording and exit code.
    process.stderr.write('herdr-agents.mjs: 1: role\n');
    process.exit(1);
  }
  const f = resolveRole(argv[0], env, cwd);
  const role = {
    file: f,
    name: fmGet(f, 'name'),
    kind: fmGet(f, 'kind'),
    alternatives: fmGet(f, 'alternatives').split(' ').filter((s) => s !== ''),
    mode: fmGet(f, 'mode'),
    timeout: fmGet(f, 'timeout'),
    effort: fmGet(f, 'effort'),
    model: fmGet(f, 'model'),
    approvals: fmGet(f, 'approvals'),
    description: fmGet(f, 'description'),
  };
  process.stdout.write(JSON.stringify(role, null, 2) + '\n');
}
