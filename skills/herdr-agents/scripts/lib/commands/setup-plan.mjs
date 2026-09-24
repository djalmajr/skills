// `setup --plan` (slice 7c of the bash port): the same arguments as `setup`,
// `config set` and `session set`, but nothing is written — every write is
// simulated on copies in a private temp dir (fs.mkdtempSync under TMPDIR,
// removed at the end, including when the simulation fails) and the change of
// each file is printed: config files get one "key  before → after" line per
// changed key ((unset)/(removed) mark the missing ends, confKeys +
// planDiffFile, port of bash conf_keys/plan_diff_file); the instruction
// file, the Claude hooks and the .gitignore entry get a unified diff of the
// simulated write (planFileDiff, port of bash plan_file_diff).
//
// The unified diff is a own implementation (decision 2 of the slice brief):
// no dependency and no `diff` call — Myers' shortest-edit algorithm with
// three lines of context, in the exact format of
// `diff -u -L a/<p> -L b/<p>` (labels without date, `\ No newline at end
// of file` where it applies). Where more than one minimal edit script
// exists, the JS choice wins (accepted divergence); the scenarios of the
// tests use unambiguous edits and match macOS `diff`.
//
// Port of scripts/herdr-agents.sh :2318-2330 (need_value/need_pair),
// :2384-2418 (conf_keys/plan_diff_file/plan_file_diff) and :2420-2515
// (cmd_setup_plan). Reuses the ports of the earlier slices: setupLaneSpec /
// applyLaneFile (lanes.mjs), configKeyOk / configValueOk /
// configWritePair / configFileFor / fileKeyValue / stateRootPath
// (config.mjs), sessionConfPath (session.mjs), setupTargetExisting
// (commands/setup.mjs) and setupBlockResult / settingsHooksResult
// (setuptext.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  DieError, configKeyOk, configValueOk, configWritePair, configFileFor,
  fileKeyValue, stateRootPath,
} from '../config.mjs';
import { projectRoot, readTextFile } from '../platform.mjs';
import { applyLaneFile, setupLaneSpec } from '../lanes.mjs';
import { sessionConfPath } from '../session.mjs';
import { setupBlockResult, settingsHooksResult } from '../setuptext.mjs';
import { setupTargetExisting } from './setup.mjs';

// `[ -f ]` / `[ -L ]` ports (same as commands/setup.mjs, which does not
// export them).
function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
function isSymlink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

// Lines of a normalized text (awk-style trailing-newline semantics).
function splitLines(text) {
  if (text === '') return [];
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

// conf_keys <file> port (:2384): the distinct keys in file order, the same
// comment/trim rules as the config loader's rewrite awk (a `#` preceded by
// whitespace cuts the line; whole-line comments and lines without `=`
// pass; the key is the trimmed text before the first `=`). Not the loader's
// normalized key — the raw dotted key as written.
export function confKeys(file) {
  let raw;
  try { raw = readTextFile(file); } catch { return []; }
  const keys = [];
  const seen = new Set();
  for (const rawLine of splitLines(raw)) {
    let body = rawLine;
    const m = body.match(/[ \t]#.*$/);
    if (m) body = body.slice(0, m.index);
    const s = body.trim();
    if (s === '' || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq === -1) continue;
    const k = s.slice(0, eq).trim();
    if (k !== '' && !seen.has(k)) { seen.add(k); keys.push(k); }
  }
  return keys;
}

// plan_diff_file <before> <after> port (:2402): one
// "  <key>  <before> → <after>" line per changed key; the before file may be
// absent (then only the after keys are listed and every before is (unset));
// (removed) marks a key that disappears. Keys keep their before-file order,
// then the after-file order (bash: conf_keys of both, deduped in place).
export function planDiffFile(before, after) {
  const hasBefore = before !== '' && isFile(before);
  const keys = [];
  const seen = new Set();
  for (const k of [...(hasBefore ? confKeys(before) : []), ...confKeys(after)]) {
    if (!seen.has(k)) { seen.add(k); keys.push(k); }
  }
  const out = [];
  for (const k of keys) {
    const bv = hasBefore ? fileKeyValue(before, k) : '';
    const av = fileKeyValue(after, k);
    if (bv === av) continue;
    const b = bv === '' ? '(unset)' : bv;
    const a = av === '' ? '(removed)' : av;
    out.push(`  ${k.padEnd(20)} ${b} → ${a}\n`);
  }
  return out.join('');
}

// ---------- unified diff (`diff -u -L a/<label> -L b/<label>` format) ----------

// File content → diff lines: a file that does not end with a newline keeps
// its last line without one (GNU diff treats that last line as different
// from the same text with a final newline, so the newline state is part of
// the line identity); the absent file ('' content) has zero lines.
function diffLines(content) {
  if (content === '') return [];
  const nlEnd = content.endsWith('\n');
  const lines = (nlEnd ? content.slice(0, -1) : content).split('\n').map((t) => ({ t, nl: true }));
  if (!nlEnd && lines.length) lines[lines.length - 1].nl = false;
  return lines;
}

const NO_NEWLINE = '\\ No newline at end of file\n';

// myersOps(a, b) — a shortest edit script of the two line arrays as a list
// of merged ops { t: 'k' | 'd' | 'i', n } (kept / deleted old lines /
// inserted new lines) in order. Myers' O(ND) algorithm with a per-step V
// trace for the backtracking (k = old - new diagonal, V[k] = furthest old
// line; on a tie the insertion candidate wins, which matches GNU diff on
// the ambiguous cases verified). Diagonals overshoot the grid near the end
// (the furthest point is allowed to pass (n, m)); the backtracking walks
// back from (n, m) using the same selection rule per step.
function myersOps(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  const max = n + m;
  const off = max;
  const v = new Array(2 * max + 1).fill(0);
  v[off] = 0;
  const trace = [];
  let finalD = -1;
  for (let d = 0; d <= max && finalD < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      // O after the move, before the snake (diagonal k: O - I = k).
      let oq;
      if (k === -d) oq = v[k + 1 + off];            // only k+1 (insertion)
      else if (k === d) oq = v[k - 1 + off] + 1;     // only k-1 (deletion)
      else if (v[k + 1 + off] >= v[k - 1 + off] + 1) oq = v[k + 1 + off]; // tie → insertion
      else oq = v[k - 1 + off] + 1;
      let iq = oq - k;
      while (oq < n && iq < m && a[oq].t === b[iq].t && a[oq].nl === b[iq].nl) { oq++; iq++; }
      v[k + off] = oq;
      if (oq >= n && iq >= m) { finalD = d; break; }
    }
  }
  // Backtrack (o, i) = (n, m) → (0, 0). rev collects the script from the
  // tail: per step, the snake (kept lines) then the move.
  const rev = [];
  let o = n;
  let i = m;
  for (let d = finalD; d > 0; d--) {
    const vPrev = trace[d];
    const k = o - i;
    let kPrev;
    if (k === -d) kPrev = k + 1;
    else if (k === d) kPrev = k - 1;
    else if (vPrev[k + 1 + off] >= vPrev[k - 1 + off] + 1) kPrev = k + 1;
    else kPrev = k - 1;
    const isIns = kPrev === k + 1;
    const oq = isIns ? vPrev[kPrev + off] : vPrev[kPrev + off] + 1;
    const keep = o - oq; // the snake of the step (old == new lines)
    if (keep > 0) rev.push({ t: 'k', n: keep });
    rev.push({ t: isIns ? 'i' : 'd', n: 1 });
    o = vPrev[kPrev + off];
    i = o - kPrev;
  }
  const ops = [];
  if (o > 0) ops.push({ t: 'k', n: o }); // the d=0 snake from (0, 0)
  for (let j = rev.length - 1; j >= 0; j--) ops.push(rev[j]);
  // merge adjacent ops of the same kind (adjacent deletions/insertions)
  const merged = [];
  for (const op of ops) {
    const last = merged[merged.length - 1];
    if (last && last.t === op.t) last.n += op.n;
    else merged.push({ ...op });
  }
  return merged;
}

// groupHunks(ops, n, m, context): the change groups (maximal runs of
// d/i ops) with their old/new exclusive line bounds, merged when the kept
// lines between them are ≤ 2*context (GNU diff merges hunks then — a gap of
// exactly 2*context kept lines is still one hunk, one more line splits
// it). Returns the hunk spans { oh0, oh1, nh0, nh1 }.
function groupHunks(ops, n, m, context) {
  const groups = [];
  let oi = 0;
  let ni = 0;
  for (const op of ops) {
    if (op.t === 'k') { oi += op.n; ni += op.n; continue; }
    const dl = op.t === 'd' ? op.n : 0;
    const inc = op.t === 'i' ? op.n : 0;
    const last = groups[groups.length - 1];
    if (last && last.oEnd === oi && last.nEnd === ni) {
      last.oEnd = oi + dl;
      last.nEnd = ni + inc;
    } else {
      groups.push({ oStart: oi, oEnd: oi + dl, nStart: ni, nEnd: ni + inc });
    }
    oi += dl;
    ni += inc;
  }
  // (oi/ni above track the consumed lines of every op, d/i included.)
  const merged = [];
  for (const g of groups) {
    const last = merged[merged.length - 1];
    if (last && g.oStart - last.oEnd <= 2 * context) {
      last.oEnd = g.oEnd;
      last.nEnd = g.nEnd;
    } else merged.push({ ...g });
  }
  return merged.map((g) => ({
    oh0: Math.max(0, g.oStart - context),
    oh1: Math.min(n, g.oEnd + context),
    nh0: Math.max(0, g.nStart - context),
    nh1: Math.min(m, g.nEnd + context),
  }));
}

// The hunk header `@@ -l,s +l,s @@` (count omitted when 1, "0,0" when 0).
function hunkHeader(oh0, oh1, nh0, nh1) {
  const f = (start, count) => (count === 0 ? '0,0' : count === 1 ? `${start}` : `${start},${count}`);
  return `@@ -${f(oh0 + 1, oh1 - oh0)} +${f(nh0 + 1, nh1 - nh0)} @@\n`;
}

// renderHunk(h, …): the hunk body — leading kept lines, then, per change
// group, the deleted old lines before the inserted new ones (GNU's order
// within a block), then the kept lines between and after. A line that ends
// its file gets `\ No newline at end of file` when that file has no final
// newline (a context line at the shared end prints it once).
function renderHunk(h, a, b, n, m, ops) {
  const out = [hunkHeader(h.oh0, h.oh1, h.nh0, h.nh1)];
  let oi = 0; // old lines consumed (global)
  let ni = 0;
  let dels = [];
  let ins = [];
  const flush = () => {
    for (const li of dels) {
      out.push(`-${a[li].t}\n`);
      if (!a[li].nl) out.push(NO_NEWLINE);
    }
    dels = [];
    for (const li of ins) {
      out.push(`+${b[li].t}\n`);
      if (!b[li].nl) out.push(NO_NEWLINE);
    }
    ins = [];
  };
  for (const op of ops) {
    if (op.t === 'k') {
      flush();
      const o0 = Math.max(oi, h.oh0);
      const o1 = Math.min(oi + op.n, h.oh1);
      for (let li = o0; li < o1; li++) {
        out.push(` ${a[li].t}\n`);
        if (!a[li].nl) out.push(NO_NEWLINE); // equal in both files → once
      }
      oi += op.n;
      ni += op.n;
      continue;
    }
    if (op.t === 'd') {
      for (let li = Math.max(oi, h.oh0); li < Math.min(oi + op.n, h.oh1); li++) dels.push(li);
      oi += op.n;
      continue;
    }
    for (let li = Math.max(ni, h.nh0); li < Math.min(ni + op.n, h.nh1); li++) ins.push(li);
    ni += op.n;
  }
  flush();
  return out.join('');
}

// unifiedDiff <antes> <depois> <rótulo> — the output of
// `diff -u -L a/<rótulo> -L b/<rótulo>` for the two contents (strings; ''
// is the absent file), or '' when they are identical (the caller prints
// "(no change)"). Own Myers implementation (see myersOps); no `diff` call.
export function unifiedDiff(before, after, label) {
  if (before === after) return '';
  const a = diffLines(before);
  const b = diffLines(after);
  const ops = myersOps(a, b);
  const hunks = groupHunks(ops, a.length, b.length, 3);
  if (hunks.length === 0) return '';
  const out = [`--- a/${label}\n`, `+++ b/${label}\n`];
  for (const h of hunks) out.push(renderHunk(h, a, b, a.length, b.length, ops));
  return out.join('');
}

// plan_file_diff <path> <before> <after> port (:2410): the path, then
// "(no change)" or the unified diff of the simulated write, then the blank
// line. The contents are the strings of the simulated pair (the caller
// owns the simulation).
export function planFileDiff(file, before, after) {
  const d = unifiedDiff(before, after, file);
  return `${file}\n${d === '' ? '  (no change)\n' : d}\n`;
}

// cmd_setup_plan port (:2420): validate everything like the real writes
// (die 2 before anything is shown or written), simulate the config/session
// writes on copies in a private temp dir, then print the plan. Nothing is
// ever written outside the temp dir, which is removed at the end, including
// when the simulation dies (bash leaks it there; the brief requires the
// cleanup).
export function cmdSetupPlan(args, ctx, env = process.env, cwd = process.cwd()) {
  let panes = '';
  let target = '';
  let hooks = 1;
  const laneSpecs = [];
  const setProj = [];
  const setUser = [];
  const setSess = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const hasNext = i + 1 < args.length;
    const next = hasNext ? args[i + 1] : '';
    if (a === '--panes' || a === '--lane' || a === '--target') {
      // need_value: nothing follows the flag, or the next word is another
      // --flag.
      if (!hasNext || next.startsWith('--')) throw new DieError(`setup --plan: ${a} expects a value`, 2);
      const v = args[++i];
      if (a === '--panes') panes = v;
      else if (a === '--lane') laneSpecs.push(v);
      else target = v;
    } else if (a === '--set' || a === '--user-set' || a === '--session-set') {
      // need_pair: the key exists and is not a --flag (the value may start
      // with --); a missing value is the same "expects a value" die.
      if (!hasNext || next.startsWith('--') || i + 2 >= args.length) throw new DieError(`setup --plan: ${a} expects a value`, 2);
      const k = args[++i];
      const v = args[++i];
      if (a === '--set') setProj.push([k, v]);
      else if (a === '--user-set') setUser.push([k, v]);
      else setSess.push([k, v]);
    } else if (a === '--no-hooks') {
      hooks = 0;
    } else {
      throw new DieError(`setup --plan: unknown option '${a}'`, 2);
    }
  }
  if (panes !== '' && panes !== '3' && panes !== '4') throw new DieError('setup --plan: --panes must be 3 or 4', 2);
  for (const spec of laneSpecs) setupLaneSpec(spec); // the same writer as setup
  const validate = (pairs) => {
    for (const [k, v] of pairs) {
      if (!configKeyOk(k)) throw new DieError(`setup --plan: unknown key '${k}'`, 2);
      if (!configValueOk(k, v, env, cwd)) throw new DieError(`setup --plan: invalid value '${v}' for ${k}`, 2);
    }
  };
  validate(setProj);
  validate(setUser);
  validate(setSess);

  const root = projectRoot(env, cwd);
  const tmpd = fs.mkdtempSync(path.join(env.TMPDIR || os.tmpdir(), 'herdr-agents-plan.'));
  try {
    const projconf = configFileFor('project', env, cwd);
    const userconf = configFileFor('user', env);
    let sessfile = '';
    let touchedProj = 0;
    let touchedUser = 0;
    let touchedSess = 0;
    if (panes !== '' || laneSpecs.length > 0 || setProj.length > 0) {
      touchedProj = 1;
      const tmp = path.join(tmpd, 'proj.conf');
      if (fs.existsSync(projconf)) fs.copyFileSync(projconf, tmp); else fs.writeFileSync(tmp, '');
      // apply_lane_file … >/dev/null: the "set …" lines stay suppressed
      // (the warns go to stderr, like the bash).
      if (panes !== '') applyLaneFile(tmp, panes, env, cwd);
      for (const spec of laneSpecs) {
        const p = setupLaneSpec(spec);
        configWritePair(tmp, `lane.${p.name}.kind`, p.kind, env);
        if (p.model !== '') configWritePair(tmp, `lane.${p.name}.model`, p.model, env);
        if (p.effort !== '') configWritePair(tmp, `lane.${p.name}.effort`, p.effort, env);
      }
      for (const [k, v] of setProj) configWritePair(tmp, k, v, env);
    }
    if (setUser.length > 0) {
      touchedUser = 1;
      const tmpu = path.join(tmpd, 'user.conf');
      if (fs.existsSync(userconf)) fs.copyFileSync(userconf, tmpu); else fs.writeFileSync(tmpu, '');
      for (const [k, v] of setUser) configWritePair(tmpu, k, v, env);
    }
    if (setSess.length > 0) {
      sessfile = sessionConfPath(ctx, env, cwd) || '';
      if (sessfile === '') throw new DieError('setup --plan: --session-set needs a Herdr workspace (none resolvable here)', 2);
      touchedSess = 1;
      const tmps = path.join(tmpd, 'session.conf');
      if (fs.existsSync(sessfile)) fs.copyFileSync(sessfile, tmps); else fs.writeFileSync(tmps, '');
      for (const [k, v] of setSess) configWritePair(tmps, k, v, env);
    }

    process.stdout.write('plan (nothing is written):\n\n');
    if (touchedProj === 1) {
      process.stdout.write(`${projconf}\n`);
      process.stdout.write(planDiffFile(projconf, path.join(tmpd, 'proj.conf')));
      process.stdout.write('\n');
    }
    if (touchedUser === 1) {
      process.stdout.write(`${userconf}\n`);
      process.stdout.write(planDiffFile(userconf, path.join(tmpd, 'user.conf')));
      process.stdout.write('\n');
    }
    if (touchedSess === 1) {
      process.stdout.write(`${sessfile}\n`);
      process.stdout.write(planDiffFile(sessfile, path.join(tmpd, 'session.conf')));
      process.stdout.write('\n');
    }

    // The instruction block, the hooks and the .gitignore entry are part of
    // every setup, so the plan simulates those writes and shows the unified
    // diff of each file (config files keep the key before → after).
    if (target === '') {
      target = setupTargetExisting(root) ?? '';
      if (target === '') {
        if (isFile(path.join(root, 'AGENTS.md'))) target = path.join(root, 'AGENTS.md');
        else if (isFile(path.join(root, 'CLAUDE.md')) && !isSymlink(path.join(root, 'CLAUDE.md'))) target = path.join(root, 'CLAUDE.md');
        else target = path.join(root, 'AGENTS.md');
      }
    }
    if (!path.isAbsolute(target)) target = root + '/' + target;
    let instr = null;
    try { instr = readTextFile(target); } catch { /* absent */ }
    const instrAfter = setupBlockResult(instr);
    // A write the real setup refuses (exit 4, file untouched) is refused
    // here too, instead of showing an empty result as the file removed.
    if (instrAfter === null) throw new DieError(`setup --plan: could not produce the instruction block for ${target} (setup would refuse it and leave the file untouched)`, 4);
    process.stdout.write(planFileDiff(target, instr === null ? '' : instr, instrAfter));
    if (hooks === 1) {
      const sj = path.join(root, '.claude', 'settings.json');
      let sjc = null;
      try { sjc = readTextFile(sj); } catch { /* absent */ }
      const sjAfter = settingsHooksResult(sjc);
      if (sjAfter === null) throw new DieError(`setup --plan: could not merge hooks into ${sj} (setup would refuse it and leave the file untouched)`, 4);
      process.stdout.write(planFileDiff(sj, sjc === null ? '' : sjc, sjAfter));
    }
    // setup (and session set) call state_root, which adds the state dir to
    // the repo's .gitignore once; show that write too when it would happen.
    const gd = stateRootPath(ctx, env, cwd);
    const prefix = root + '/';
    if (gd.startsWith(prefix)) {
      const rel = gd.slice(prefix.length);
      const wt = spawnSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { env, stdio: 'ignore' });
      if (wt.status === 0) {
        const ci = spawnSync('git', ['-C', root, 'check-ignore', '-q', rel], { env, stdio: 'ignore' });
        if (ci.status !== 0) {
          let gi = '';
          try { gi = readTextFile(path.join(root, '.gitignore')); } catch { /* absent */ }
          process.stdout.write(planFileDiff(path.join(root, '.gitignore'), gi, gi + `${rel}/\n`));
        }
      }
    }
  } finally {
    fs.rmSync(tmpd, { recursive: true, force: true });
  }
}
