// Local setup mode (R28/D71): the instruction target for forks whose
// tracked AGENTS.md/CLAUDE.md belong to an upstream. `setup --local`
// writes the marked block to the untracked root `CLAUDE.local.md` (which
// Claude Code reads) and keeps it plus the state dir unversioned through
// the repo-local `.git/info/exclude` — never the tracked AGENTS.md,
// CLAUDE.md or .gitignore. Shared by `setup` and `setup --plan`; this
// module owns the mode decision and the git-local disk work, the commands
// own their messages' shape. DieError carries the die 2/4 contract.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DieError, cfg, stateRootPath } from './config.mjs';
import { atomicWrite, readTextFile } from './platform.mjs';

// The local instruction file (root). Claude Code reads it; other
// harnesses may need their own local mechanism (orchestrator docs).
export const LOCAL_INSTRUCTION_FILE = 'CLAUDE.local.md';

// resolveSetupMode <{ local, target, ctx, env, cmd }>: 'local' when
// --local was passed or setup_target=local holds and no explicit --target
// overrides it; 'canonical' otherwise. --local with --target dies 2
// before anything is written. A setup_target value outside
// canonical|local (hand-edited past validation) reads as canonical.
// `cmd` is 'setup' or 'setup --plan', for the die prefix.
export function resolveSetupMode({ local, target, ctx, env = process.env, cmd = 'setup' }) {
  if (local && target) throw new DieError(`${cmd}: --local and --target are exclusive`, 2);
  if (local) return 'local';
  if (target) return 'canonical';
  return cfg(ctx, 'setup_target', 'canonical', env) === 'local' ? 'local' : 'canonical';
}

// The local instruction target under the project root.
export function localTarget(root) {
  return path.join(root, LOCAL_INSTRUCTION_FILE);
}

// gitDirFor <root>: the absolute git dir (`rev-parse --absolute-git-dir`,
// so a worktree resolves to its own `<common>/.git/worktrees/<name>` and
// not to an assumed `.git` directory), or '' when git cannot say (not a
// work tree, git absent).
export function gitDirFor(root, env = process.env) {
  const abs = spawnSync('git', ['-C', root, 'rev-parse', '--absolute-git-dir'],
    { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 });
  if (abs.status === 0 && (abs.stdout || '').trim() !== '') return (abs.stdout || '').trim();
  const rel = spawnSync('git', ['-C', root, 'rev-parse', '--git-dir'],
    { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 });
  if (rel.status === 0 && (rel.stdout || '').trim() !== '') {
    const g = (rel.stdout || '').trim();
    return path.isAbsolute(g) ? g : path.join(root, g);
  }
  return '';
}

// excludePathFor <root>: the repo-local exclude file git actually reads:
// `rev-parse --git-path info/exclude` (in a linked worktree that is the
// common `<main>/.git/info/exclude`, not the worktree git dir's —
// `<absolute-git-dir>/info/exclude` is never read there), made absolute
// against the root when git prints it relatively. Falls back to the git
// dir join (plain-repo behavior) when --git-path is unavailable. '' when
// git cannot say.
export function excludePathFor(root, env = process.env) {
  const gp = spawnSync('git', ['-C', root, 'rev-parse', '--git-path', 'info/exclude'],
    { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 });
  if (gp.status === 0 && (gp.stdout || '').trim() !== '') {
    const p = (gp.stdout || '').trim();
    return path.isAbsolute(p) ? p : path.join(root, p);
  }
  const gd = gitDirFor(root, env);
  return gd === '' ? '' : path.join(gd, 'info', 'exclude');
}

// insideWorkTree <root>: `rev-parse --is-inside-work-tree` says yes.
export function insideWorkTree(root, env = process.env) {
  const r = spawnSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'],
    { env, stdio: 'ignore', timeout: 30_000 });
  return r.status === 0;
}

// isGitTracked <root> <rel>: the path is tracked (`ls-files
// --error-unmatch` exits 0). A git failure reads as untracked — the
// caller then treats the repo as not-a-work-tree anyway.
export function isGitTracked(root, rel, env = process.env) {
  const r = spawnSync('git', ['-C', root, 'ls-files', '--error-unmatch', '--', rel],
    { env, stdio: 'ignore', timeout: 30_000 });
  return r.status === 0;
}

// checkIgnoreStatus <root> <rel>: the `check-ignore -q` exit status (0 =
// ignored), or null when git itself failed.
export function checkIgnoreStatus(root, rel, env = process.env) {
  const r = spawnSync('git', ['-C', root, 'check-ignore', '-q', rel],
    { env, stdio: 'ignore', timeout: 30_000 });
  if (r.error) return null;
  return r.status;
}

// The root-anchored exclude entry for a repo-relative path:
// `/CLAUDE.local.md` for the instruction file, `/.herdr-agents` for the
// state dir — deliberately without a trailing slash, so the entry already
// matches before the directory is created (a trailing-slash pattern never
// matches a path missing from disk, and setup creates no state dir).
export function excludeEntry(rel) {
  return `/${String(rel ?? '').replace(/\/+$/, '')}`;
}

// missingExcludeEntries <current> <entries>: the entries with no exact
// line in the current exclude content (trailing CR ignored per line).
export function missingExcludeEntries(current, entries) {
  const have = new Set(String(current ?? '').split('\n').map((l) => l.replace(/\r$/, '')));
  return entries.filter((e) => !have.has(e));
}

// excludeAfterText <current> <entries>: the exclude content with the
// missing entries appended, one per line; prior content is preserved
// byte-for-byte (only a missing final newline is added first).
export function excludeAfterText(current, entries) {
  let out = String(current ?? '');
  for (const e of missingExcludeEntries(out, entries)) {
    if (out !== '' && !out.endsWith('\n')) out += '\n';
    out += `${e}\n`;
  }
  return out;
}

// sameDir <a> <b>: true only when both exist and name the same directory
// (same dev+inode). lstat identity — a symlink is NOT the directory it
// points at — so the containment walk stops at the real parent of any
// symlink component (an in-repo `loop -> root` never matches the root)
// while symlinked spellings of the same physical directory in the parent
// path (macOS /tmp vs /private/tmp, a linked ancestor) still match: the
// path walk resolves them before the final lstat sees the real directory.
function sameDir(a, b) {
  let sa, sb;
  try { sa = fs.lstatSync(a); sb = fs.lstatSync(b); } catch { return false; }
  return sa.isDirectory() && sb.isDirectory() && sa.dev === sb.dev && sa.ino === sb.ino;
}

// inRepoSymlinkIn <d> <candidates>: the first component of d's spelling
// — excluding the final component, which the alias phase judges by its
// target — that is a symlink whose link file physically sits inside a
// work tree of this repo (realpath of the parent + the name). Such an
// entry is visible to git as `?? <rel>` and no exclude rel for the named
// path can cover it (git never reports paths through a symlink) —
// classifyStateDir fails closed on it. A symlink whose link file sits
// outside every work tree (an outside alias) is safe, whatever its
// target.
function inRepoSymlinkIn(d, candidates) {
  const parts = d.split(path.sep).filter(Boolean);
  let p = '';
  for (let i = 0; i < parts.length; i++) {
    p = i === 0 ? `/${parts[0]}` : `${p}/${parts[i]}`;
    if (i === parts.length - 1) break;
    let s;
    try { s = fs.lstatSync(p); } catch { continue; }
    if (!s.isSymbolicLink()) continue;
    let dir = null;
    try { dir = fs.realpathSync(path.dirname(p)); } catch { continue; }
    const linkfile = path.join(dir, parts[i]);
    for (const rc of candidates) {
      if (linkfile === rc || linkfile.startsWith(rc + path.sep)) return p;
    }
  }
  return null;
}

// aliasMatch <d> <candidates>: the deepest existing ancestor of d
// (statSync — a final symlink reads as its directory) whose physical
// path (realpath) is inside — or equal to — a candidate worktree root,
// or null. The most specific (longest) root wins when the physical path
// sits under several (nested work trees). Missing tails are walked past
// — the state dir need not exist yet.
function aliasMatch(d, candidates) {
  for (let a = d; ; a = path.dirname(a)) {
    let s;
    try { s = fs.statSync(a); } catch { s = null; }
    if (s !== null && s.isDirectory()) {
      let p = null;
      try { p = fs.realpathSync(a); } catch { p = null; }
      if (p !== null) {
        let best = null;
        for (const rc of candidates) {
          if ((p === rc || p.startsWith(rc + path.sep)) && (best === null || rc.length > best.length)) best = rc;
        }
        if (best !== null) return { v: a, phys: p, rc: best };
      }
    }
    if (a === path.dirname(a)) break;
  }
  return null;
}

// insideVia <d> <dir>: the longest existing ancestor of d (including d
// itself) that is the same directory as dir, or null. d must be absolute
// and lexically normalized (path.resolve). Missing tails are walked past
// — the state dir need not exist yet — and only d's own ancestors are
// lstat'ed, so no symlink component below the match is followed: an
// in-repo symlink entry never matches the directory it points at, and
// its components stay visible to symlinkComponentBelow.
function insideVia(d, dir) {
  if (sameDir(d, dir)) return d;
  for (let cur = path.dirname(d); cur !== path.dirname(cur); cur = path.dirname(cur)) {
    if (sameDir(cur, dir)) return cur;
  }
  return null;
}

// symlinkComponentBelow <via> <d>: the first component of d below the
// matched root spelling via — including the final one — that is itself a
// symlink (lstat), or null. Git never reports paths through a symlink, so
// an exclude entry derived past such a component could not be guaranteed;
// classifyStateDir fails closed on it (kind 'symlink').
function symlinkComponentBelow(via, d) {
  let p = via;
  for (const c of d.slice(via.length + 1).split('/')) {
    p = path.join(p, c);
    let linked = false;
    try { linked = fs.lstatSync(p).isSymbolicLink(); } catch { /* absent: not a link */ }
    if (linked) return p;
  }
  return null;
}

// symlinkAt <p>: true when p exists and is itself a symlink (lstat).
function symlinkAt(p) {
  let s;
  try { s = fs.lstatSync(p); } catch { return false; }
  return s.isSymbolicLink();
}

// finalSymlinkTarget <d> <candidates>: d is a symlink — where its target
// sits relative to this repo's work trees: { root: true } when the target
// is a work tree root (the effective state directory IS the root),
// { inside: true } when the target is a different in-repo directory (an
// ignore entry for the symlink would name a different path than the one
// the state lands in), or null when the target is outside every work tree
// — or broken: the symlink entry itself is the git object, the supported
// case (repo/link2 -> outside).
function finalSymlinkTarget(d, candidates) {
  let t = null;
  try { t = fs.realpathSync(d); } catch { return null; /* broken: reads external */ }
  for (const c of candidates) if (sameDir(t, c)) return { root: true };
  for (const c of candidates) if (insideVia(t, c) !== null) return { inside: true };
  return null;
}

// descent <d> <via> <candidate> <candidates> <root>: classify d under the
// matched root spelling via (strict or alias phase). A symlink component
// strictly below via fails closed (kind 'symlink', link set); a final
// symlink is judged by finalSymlinkTarget (in-repo: refused; outside or
// broken: the lexical rel, the symlink entry is the git object); the rest
// is the rel from via — 'inside' for the current root, 'sibling' for a
// listed work tree root of the same repo.
function descent(d, via, candidate, candidates, root) {
  const linked = symlinkComponentBelow(via, d);
  if (linked !== null) {
    if (linked !== d) return { kind: 'symlink', shown: d, link: linked };
    const t = finalSymlinkTarget(d, candidates);
    if (t !== null) return t.root ? { kind: 'symlink', shown: d, rootTarget: true } : { kind: 'symlink', shown: d };
  }
  const rel = d.slice(via.length + 1);
  if (candidate === root) return { kind: 'inside', rel, shown: `${rel}/` };
  return { kind: 'sibling', rel, worktreeRoot: candidate, shown: d };
}

// worktreeRoots <root> <env>: the worktree root paths git lists for this
// repository (`git worktree list --porcelain`, the `worktree <path>`
// lines) — the current work tree among them — in git's own spelling.
// [] when git cannot say (not a work tree, git absent).
export function worktreeRoots(root, env = process.env) {
  const r = spawnSync('git', ['-C', root, 'worktree', 'list', '--porcelain'],
    { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 });
  if (r.status !== 0) return [];
  const out = [];
  for (const line of String(r.stdout).split('\n')) {
    if (line.startsWith('worktree ')) out.push(line.slice('worktree '.length));
  }
  return out;
}

// classifyStateDir <root> <ctx>: classifies the effective state dir
// ($HERDR_AGENTS_DIR else cfg state_dir) against the work trees of this
// repository — the single source for both the exclude entry (localRels)
// and the status line (stateDirShown), so the two cannot diverge (R28
// review P1/P2). Candidates are the current work tree root plus every
// root git lists for this repository (its own worktree list — nested and
// sibling linked work trees among them; work trees of other repositories
// are never listed, so a path in another repository reads external). The
// most specific (deepest) match wins, so a state dir under a nested
// linked work tree classifies against that work tree, not the enclosing
// one. Two phases: strict containment first (lstat — a symlink is not
// the directory it points at), then the alias phase — d's spelling
// reaches a root-equivalent directory only through a symlink (an alias
// to the root, to an interior directory, or a /tmp-style ancestor
// alias): a symlink whose link file physically sits inside a work tree
// fails closed, and the deepest existing ancestor whose physical path
// (realpath) is inside a candidate root anchors the rel.
//   kind 'inside'   — under the current work tree root (through any
//                     symlinked spelling in the parent path — macOS /tmp
//                     vs /private/tmp, an outside alias to the root
//                     parent/link -> repo or to an interior directory
//                     sublink -> repo/sub, which reads root-relative,
//                     e.g. `sub/newstate`): the exclude entry is
//                     the repo-relative name; shown is `rel/`. An in-repo
//                     symlink entry whose target is OUTSIDE the repo
//                     stays 'inside' as its own name — the symlink entry
//                     itself is the git object to hide.
//   kind 'sibling'  — under another work tree of the same repository (a
//                     worktree root git lists for this repo): the entry
//                     is the path relative to that work tree (only the
//                     common info/exclude is read there); shown is the
//                     actual absolute path.
//   kind 'root'     — the state path is the current or a sibling worktree
//                     root (including `.` and `sub/..` spellings):
//                     refuseUnignorableStateDir dies 4 — a worktree root
//                     cannot be safely hidden in the exclude file.
//   kind 'symlink'  — an in-repo symlink in the state path's spelling:
//                     git never reports paths through a symlink, so no
//                     exclude entry can be guaranteed for the named
//                     path — refuseUnignorableStateDir dies 4 before any
//                     mutation. "In-repo" means the symlink's link file
//                     physically sits under a work tree root (checked
//                     per component: realpath of the parent + the name),
//                     so an in-repo symlink reached through any alias —
//                     root, interior or ancestor — is caught. Fields:
//                     link — the symlink path the state path traverses;
//                     rootTarget — the final component aliases a work
//                     tree root (the effective state directory IS the
//                     root); neither — the final component is a symlink
//                     to a different in-repo directory (ignoring the
//                     entry would name a path the state never lands in).
//   kind 'external' — anywhere else: no state entry; shown is the
//                     resolved path and the status line says no
//                     repository Git exclusion is needed.
export function classifyStateDir(root, ctx, env = process.env, cwd = process.cwd()) {
  const d = path.resolve(stateRootPath(ctx, env, cwd));
  const candidates = [root];
  if (insideWorkTree(root, env)) {
    for (const wt of worktreeRoots(root, env)) if (wt !== root) candidates.push(wt);
  }
  // Phase A — strict containment (lstat: a symlink is not the directory
  // it points at): the deepest root d sits under with no symlink at the
  // match position. Symlinked spellings in the parent path (macOS /tmp
  // vs /private/tmp, dir/alias -> dir) still match — the path walk
  // resolves them before the final lstat. Any in-repo symlink component
  // below the matched root then fails closed (descent, kind 'symlink').
  let via = null;
  let candidate = null;
  for (const c of candidates) {
    const v = insideVia(d, c);
    if (v === null) continue;
    if (via === null || v.length > via.length) { via = v; candidate = c; }
  }
  if (via !== null) {
    if (via === d) return { kind: 'root', shown: d };
    return descent(d, via, candidate, candidates, root);
  }
  // Phase B — alias containment: the strict phase found no real-dir
  // anchor, so d's spelling reaches a root-equivalent directory only
  // through a symlink — an alias to the root (parent/link -> repo), to
  // an interior directory (sublink -> repo/sub), or a /tmp-style ancestor
  // alias. First, a symlink whose link file physically sits inside a
  // work tree of this repo fails closed (an in-repo entry git would show
  // that no exclude rel for the named path can cover). The final
  // component is judged through the match: an in-repo target aliases a
  // work-tree location and is refused below; an outside target
  // contributes its own entry as the tail (the symlink entry is the git
  // object). Then the deepest existing ancestor whose physical path
  // (realpath) is inside a candidate root anchors the rel: the
  // root-relative physical path of that ancestor plus the tail below it.
  const bad = inRepoSymlinkIn(d, candidates);
  if (bad !== null) return { kind: 'symlink', shown: d, link: bad };
  const m = aliasMatch(d, candidates);
  if (m === null) return { kind: 'external', shown: d };
  if (m.v === d && symlinkAt(d)) {
    // d itself aliases a work tree's location: the effective state
    // directory is inside the work tree (the root — or a different
    // in-repo directory), which an entry for the alias cannot cover.
    return m.phys === m.rc ? { kind: 'symlink', shown: d, rootTarget: true } : { kind: 'symlink', shown: d };
  }
  const rcRel = m.phys === m.rc ? '' : m.phys.slice(m.rc.length + 1);
  const tail = m.v === d ? '' : d.slice(m.v.length + 1);
  const rel = rcRel === '' ? tail : (tail === '' ? rcRel : `${rcRel}/${tail}`);
  if (m.rc === root) return { kind: 'inside', rel, shown: `${rel}/` };
  return { kind: 'sibling', rel, worktreeRoot: m.rc, shown: d };
}

// localRels <root> <ctx>: the exclude items for a local setup — the local
// instruction file plus the state dir when classifyStateDir places it under
// the current work tree ('inside') or under a sibling work tree of the same
// repo ('sibling' — the entry is relative to that work tree and rides the
// common info/exclude). A truly external state dir — or a worktree root /
// symlink-traversing path, which refuseUnignorableStateDir refuses — adds
// no entry. The rel is lexically normalized (path.resolve) but keeps
// actual-name risks (glob metachars, newlines, trailing whitespace) for
// assertSafeLocalRels to refuse.
export function localRels(root, ctx, env = process.env, cwd = process.cwd()) {
  const rels = [LOCAL_INSTRUCTION_FILE];
  const c = classifyStateDir(root, ctx, env, cwd);
  if (c.kind === 'inside' || c.kind === 'sibling') rels.push(c.rel);
  return rels;
}

// stateDirShown <root> <ctx> <env> <cwd>: the effective state dir as the
// local setup status line must name it — the classifyStateDir 'shown'
// field: `rel/` under the current work tree (HERDR_AGENTS_DIR=cache,
// cache/, ./cache and a symlinked root spelling all read `cache/`), the
// actual absolute path for a sibling work tree, the resolved path when
// external. The default reads back unchanged: `.herdr-agents/`.
export function stateDirShown(root, ctx, env = process.env, cwd = process.cwd()) {
  return classifyStateDir(root, ctx, env, cwd).shown;
}

// refuseUnignorableStateDir <root> <ctx> <env> <cwd> <cmd>: die 4 when
// the effective state path cannot be safely named in the git exclude
// file — a work tree root (current or a sibling work tree's, including
// `.` and `sub/..` spellings: naming the root would hide the whole work
// tree), or a path with a symlink component below the matched work tree
// root (loop/cache through an in-repo symlink, or a final symlink whose
// target is inside the repository: git cannot ignore a path through a
// symlink, so the exclusion could not be guaranteed). The supported
// symlink case — an in-repo entry pointing outside the repo
// (repo/link2 -> outside) — is not refused. Runs before any mutation or
// plan output — both commands call it at the top of their local
// preflight.
export function refuseUnignorableStateDir(root, ctx, env = process.env, cwd = process.cwd(), cmd = 'setup') {
  const c = classifyStateDir(root, ctx, env, cwd);
  if (c.kind === 'root') {
    throw new DieError(`${cmd}: refusing to use state path '${c.shown}' because it is the root of a git work tree; a work tree root cannot be named in the git exclude file (no files were changed; point HERDR_AGENTS_DIR or state_dir at a directory inside — or outside — the work tree)`, 4);
  }
  if (c.kind === 'symlink') {
    const reason = c.rootTarget
      ? 'it is a symlink to the root of a git work tree and the effective state directory is the work tree root, which cannot be named in the git exclude file'
      : c.link !== undefined
        ? `the path traverses the symlink '${c.link}' below the work tree root and git cannot ignore a path through a symlink`
        : 'it is a symlink to a directory inside the work tree and ignoring the symlink entry would not cover the path its target occupies';
    throw new DieError(`${cmd}: refusing to use state path '${c.shown}' because ${reason} (no files were changed; point HERDR_AGENTS_DIR or state_dir at a directory that does not pass through an in-repo symlink)`, 4);
  }
}

// refuseTrackedLocal <root> <cmd>: die 4 when CLAUDE.local.md is a symlink
// or is tracked — a symlink to the tracked CLAUDE.md would pass the tracked
// check while atomicWrite follows it onto the upstream file, and a tracked
// file is never silently called local. lstat (never stat) sees the link
// itself. Runs before any mutation or plan output.
export function refuseTrackedLocal(root, env = process.env, cmd = 'setup') {
  let symlinked = false;
  try { symlinked = fs.lstatSync(localTarget(root)).isSymbolicLink(); } catch { /* absent: not a link */ }
  if (symlinked) {
    throw new DieError(`${cmd}: ${LOCAL_INSTRUCTION_FILE} is a symlink; refusing to write local instructions through it (file left untouched; delete the link or replace it with a regular file, then re-run)`, 4);
  }
  if (isGitTracked(root, LOCAL_INSTRUCTION_FILE, env)) {
    throw new DieError(`${cmd}: ${LOCAL_INSTRUCTION_FILE} is tracked by git; refusing to overwrite it with local instructions (file left untouched)`, 4);
  }
}

// Unsafe exclude rels (R28 review): a state-dir name becomes a root-anchored
// info/exclude pattern, so git-ignore metacharacters broaden it — '*' writes
// `/*` and hides every unrelated untracked file at the root. A newline would
// inject extra patterns outright, and interior `.`/`..`/empty segments
// escape the anchor. A trailing separator names the same directory
// (`cache/` is `cache`), so it is normalized away before the segment check;
// interior empties (`a//b`) and traversal keep being refused. Leading
// `!`/`#` need no rejection: the entry starts with `/`, so they never read
// as negation or comment (probed against real git), and plain names (dots,
// dashes, slashes, interior spaces) keep working.
const UNSAFE_EXCLUDE_RE = /[*?\[\\\]\n\r]/;
// Trailing whitespace in a path segment (R28 review P2): git strips an
// unescaped trailing space from an exclude pattern, so a state dir ending
// in a space (HERDR_AGENTS_DIR='cache ') would be appended as `/cache `,
// the pattern git actually applies is `/cache`, and the real directory stays
// untracked while setup exits 0. The safe contract refuses any segment that
// ends in whitespace (after the trailing-separator normalization, so
// `cache /` is caught too); interior spaces (`my cache`) and a plain
// trailing separator (`cache/`) keep working.
export function assertSafeLocalRels(rels, cmd = 'setup') {
  for (const rel of rels ?? []) {
    const norm = String(rel).replace(/\/+$/, '');
    const segs = norm.split('/');
    if (segs.some((s) => /[\s]$/.test(s))) {
      throw new DieError(`${cmd}: refusing to ignore state path '${rel}' via the git exclude file because a path segment ends in whitespace (git strips it from the exclude pattern, so the directory would stay untracked) (no files were changed; set HERDR_AGENTS_DIR or state_dir to a plain directory name such as .herdr-agents)`, 4);
    }
    const traversal = segs.some((s) => s === '' || s === '.' || s === '..');
    if (UNSAFE_EXCLUDE_RE.test(norm) || traversal) {
      throw new DieError(`${cmd}: refusing to ignore state path '${rel}' via the git exclude file because it contains git-ignore metacharacters or escapes the repo root (no files were changed; set HERDR_AGENTS_DIR or state_dir to a plain directory name such as .herdr-agents)`, 4);
    }
  }
}

// gitCommonDirFor <root> <env>: the absolute git *common* dir — the git
// dir itself for a plain repo, or the `<common>/.git` a linked worktree's
// git dir sits under (its `commondir` file, made absolute against the git
// dir). The common dir is the anchor the exclude must live under: in a
// linked worktree the worktree git dir's `info/exclude` is never read, the
// common one is. '' when the git dir cannot be resolved.
export function gitCommonDirFor(root, env = process.env) {
  const gd = gitDirFor(root, env);
  if (gd === '') return '';
  let cf = '';
  try { cf = fs.readFileSync(path.join(gd, 'commondir'), 'utf8').trim(); } catch { /* plain repo */ }
  if (cf === '') return gd;
  return path.isAbsolute(cf) ? cf : path.normalize(path.join(gd, cf));
}

// refuseSymlinkedExclude <root> <env> <cmd>: die 4 when the effective
// exclude path (`rev-parse --git-path info/exclude`) — or any ancestor
// between the git common dir and it — is a symlink: atomicWrite would
// follow the link onto whatever it points at (a symlinked exclude onto the
// tracked .gitignore, or a symlinked `.git/info` onto the repo root that
// would make the "exclude" a tracked file), silently rewriting versioned
// content and breaking the local-mode boundary. lstat (never stat) sees
// each link itself; an absent path is fine (it will be created). The chain
// is anchored at the common dir, so a symlinked prefix outside the git
// metadata (e.g. /var on macOS) is not a refusal, and an exclude the git
// layout places outside that chain refuses as well — it is not inside the
// git metadata. Runs before any mutation or plan output.
export function refuseSymlinkedExclude(root, env = process.env, cmd = 'setup') {
  const excl = excludePathFor(root, env);
  if (excl === '') return; // unresolvable: ensure/plan fail their own way
  let symlinked = false;
  try { symlinked = fs.lstatSync(excl).isSymbolicLink(); } catch { /* absent: not a link */ }
  if (symlinked) {
    throw new DieError(`${cmd}: the git exclude file at ${excl} is a symlink; refusing to write local excludes through it (file left untouched; replace it with a regular file, then re-run)`, 4);
  }
  const common = gitCommonDirFor(root, env);
  if (common === '') return;
  const rel = path.relative(common, excl);
  if (path.isAbsolute(rel) || rel.startsWith('..')) {
    throw new DieError(`${cmd}: the git exclude file at ${excl} is not inside the git metadata at ${common}; refusing to write local excludes outside it (file left untouched)`, 4);
  }
  const comps = rel.split(path.sep);
  for (let i = 0; i < comps.length - 1; i++) {
    const p = path.join(common, ...comps.slice(0, i + 1));
    let linked = false;
    try { linked = fs.lstatSync(p).isSymbolicLink(); } catch { /* absent: created at write time */ }
    if (linked) {
      throw new DieError(`${cmd}: the git exclude file at ${excl} is redirected through a symlink at ${p} (outside the git metadata); refusing to write local excludes through it (file left untouched; replace the symlink with a real directory, then re-run)`, 4);
    }
  }
}

// excludeDirWritable <excl> <cmd> <active>: die 4 when the exclude cannot
// be written. atomicWrite's temp file and its rename both land in the
// exclude's directory, so the nearest existing ancestor of that directory
// must accept a new file (a missing parent is created at write time by the
// mkdir -p, and that creation needs the same permission). With the active
// probe (real setup only) a real temp-file probe is the check — access(2)
// can lie on some filesystems — and the probe is removed at once. Without
// it (plan/dry-run, which must stay write-free) the same ancestor gets a
// read-only W_OK access check instead: it refuses a parent that is already
// unwritable and writes nothing, and on a filesystem where access(2)
// over-accepts it cannot prove the eventual write — the real setup's probe
// still stands before its writes. Runs in the preflight, so a failure here
// dies 4 before any panes preset, block, hooks or plan line.
function excludeDirWritable(excl, cmd, active = true) {
  let probeDir = path.dirname(excl);
  for (;;) {
    let isDir = false;
    try { isDir = fs.statSync(probeDir).isDirectory(); } catch { /* walk up */ }
    if (isDir) break;
    const up = path.dirname(probeDir);
    if (up === probeDir) throw new DieError(`${cmd}: cannot write the git exclude file at ${excl} (no files were changed)`, 4);
    probeDir = up;
  }
  if (!active) {
    try { fs.accessSync(probeDir, fs.constants.W_OK); }
    catch { throw new DieError(`${cmd}: cannot write the git exclude file at ${excl} (no files were changed)`, 4); }
    return;
  }
  const probe = path.join(probeDir, `.herdr-agents-probe-${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
  } catch {
    try { fs.unlinkSync(probe); } catch { /* already gone */ }
    throw new DieError(`${cmd}: cannot write the git exclude file at ${excl} (no files were changed)`, 4);
  }
}

// readExcludeOrDie <excl> <cmd>: the exclude file's text. Only ENOENT reads
// as absent (''); any other read failure (EACCES on an unreadable file,
// EISDIR when the path is a directory, ENOTDIR, …) dies 4 before the caller
// writes anything — a setup that could not preserve the existing bytes never
// starts, and the plan refuses exactly what the real setup refuses.
function readExcludeOrDie(excl, cmd) {
  try { return readTextFile(excl); }
  catch (err) {
    if (err && err.code === 'ENOENT') return '';
    throw new DieError(`${cmd}: cannot read the git exclude file at ${excl} (file left untouched)`, 4);
  }
}

// preflightLocalExcludes <root> <rels> <env> <cmd> <active>: the half of
// the local exclude work run by both commands before any mutation or plan
// output. It refuses exactly what the write/plan halves would refuse —
// unsafe rels, an unresolvable exclude, a symlinked exclude (or one
// redirected outside the git metadata by a symlinked ancestor), an
// unreadable exclude (or a directory at the path), and an unwritable
// exclude destination (an entry missing, its directory read-only) — so
// `setup --local --panes N` dies 4 before the panes preset reaches the
// project config, and the plan refuses before a single plan line. The
// destination check is the active write probe by default (real setup) and
// the read-only W_OK access when `active` is false (plan/dry-run, which
// must not create even a transient probe file). Outside a work tree there
// is nothing to preflight: null. Inside one, returns { excl, needed,
// current } (current: the exclude text, or '' when nothing is missing and
// no read is needed).
export function preflightLocalExcludes(root, rels, env = process.env, cmd = 'setup', active = true) {
  assertSafeLocalRels(rels, cmd);
  if (!insideWorkTree(root, env)) return null;
  const excl = excludePathFor(root, env);
  if (excl === '') throw new DieError(`${cmd}: cannot resolve the git exclude file under ${root}; local excludes are unwritable (file left untouched)`, 4);
  refuseSymlinkedExclude(root, env, cmd);
  const needed = [];
  for (const rel of rels) {
    if (checkIgnoreStatus(root, rel, env) === 0) continue; // already ignored
    needed.push(excludeEntry(rel));
  }
  // Only a write that would touch the file needs its bytes; an unreadable
  // exclude (or a directory at the path) dies 4 here, before any panes
  // preset, block, hooks or plan line.
  const current = needed.length > 0 ? readExcludeOrDie(excl, cmd) : '';
  // And the write itself must be possible: a missing exclude under a
  // read-only directory (or a read-only chain up to it) dies 4 here, not
  // after the panes preset, block or plan already committed to the write.
  if (needed.length > 0) excludeDirWritable(excl, cmd, active);
  return { excl, needed, current };
}

// ensureLocalExcludes <root> <rels> <env> <cmd>: keep every repo-relative
// path in `rels` (the local instruction file, the state dir when it lives
// under the root) unversioned through the repo-local info/exclude,
// creating it (and its info dir) when needed. Outside a work tree there is
// nothing to keep unversioned: { path: '', added: [] }. DieError 4 when
// the exclude cannot be resolved, read or written — before the caller writes
// the instruction block. Returns { path, added } (added: the entries
// appended, in order).
export function ensureLocalExcludes(root, rels, env = process.env, cmd = 'setup') {
  const pre = preflightLocalExcludes(root, rels, env, cmd);
  if (pre === null) return { path: '', added: [] };
  const { excl, needed, current } = pre;
  if (needed.length === 0) return { path: excl, added: [] };
  const after = excludeAfterText(current, needed);
  const added = missingExcludeEntries(current, needed);
  try {
    fs.mkdirSync(path.dirname(excl), { recursive: true });
    atomicWrite(excl, after);
  } catch {
    throw new DieError(`${cmd}: could not write local excludes to ${excl} (file left untouched)`, 4);
  }
  return { path: excl, added };
}

// planLocalExcludes <root> <rels> <env> <cmd>: the read-only twin for
// `setup --plan --local` — { path, before, after } without touching the
// disk, or null outside a work tree (nothing to show). Only a missing
// exclude file reads as ''; an unreadable one (or a directory at the path)
// dies 4, the same refusal the real setup produces. Read-only end to end:
// the preflight runs without the active write probe (no transient file is
// created or removed under the git metadata — the plan is write-free).
export function planLocalExcludes(root, rels, env = process.env, cmd = 'setup --plan') {
  const pre = preflightLocalExcludes(root, rels, env, cmd, false);
  if (pre === null) return null;
  const { excl, needed, current } = pre;
  const before = needed.length === 0
    // Nothing to add: no read, so an unreadable file cannot fail a setup
    // that writes nothing (check-ignore already says everything is ignored).
    ? ''
    : current;
  return { path: excl, before, after: excludeAfterText(before, needed), added: missingExcludeEntries(before, needed) };
}
