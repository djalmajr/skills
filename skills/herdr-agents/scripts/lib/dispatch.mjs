// dispatch (port slice 6b): the reviewer family-conflict check, the brief
// contract lint (brief_lint=warn|strict|off), the composed prompt — role
// header, the role line, the role body, the brief, and the report contract,
// byte-identical to the bash printf sequence — the $TMPDIR routing of a
// worker whose cwd is not the project root, and the `dispatch` command
// (prompt submission, the prompt-arrival check, the pane task title, the
// optional wait and the exit codes 0/4/6/7/9/11/14/15). Port of the
// original bash implementation
// :3870-3886 (family_conflicts), :3887-3899 (lint_brief), :3900-4102
// (cmd_dispatch).
//
// S5 item 15 (+orchestrator amendment): before the send the visible screen
// is hashed (H0); for prompt_check_seconds (0 turns the check off) the
// agent is probed at min(1000, poll interval) ms — arrived when the state
// is working/blocked or a non-empty report exists; at the window's end, the
// prompt text sitting in the input box gets one Enter (enter_sent), a still
// H0 screen gets the single resend (resent), any other screen change counts
// as received; still nothing → `not-received` (exit 15). A `question` wait
// ends 7.
//
// Faithful-port notes:
//   - the dispatch JSON is one line (never pretty-printed) with
//     `wait_status` as the first key, so `dispatch … | tail -1` returns the
//     whole JSON and callers filtering a field never lose the status; the
//     other keys keep the bash `jq -n` order (agent, role, kind,
//     composed_prompt, report, report_exists, auto_approved,
//     and lane/model/match/renewal only on a quota, and lane/model/cause —
//     plus retries on a capacity — only on a provider-error/capacity);
//     `settled_report` sits right after `report` (before report_exists)
//     only when the internal wait settled on another report — an
//     amendment sent mid-wait re-pointed last-report-<agent> (D39) — and
//     report_exists then qualifies that report; `amend: true` sits right after report_exists on an amendment, and
//     `partial: N` right after that (or after report_exists without amend)
//     when the done report marks N item(s) partial (the count is captured
//     from the wait line; the warn is the wait's own, not repeated here);
//   - the wait JSON lines are captured, not printed (bash `out="$(wait_for
//     …)"`); waitFor's sink parameter (lib/wait.mjs) makes that possible
//     without changing the `wait` command;
//   - a worker whose roster cwd (column 7) is not the project root gets its
//     report and composed prompt under $TMPDIR/herdr-agents/<ws>/reports/
//     (spec 3.3); last-report-<agent> points at the effective path;
//   - `historyHasEdit` receives column 11 only. Bash's `read` with 11
//     variables folds column 12 (lane) into the last variable, so a
//     single-token history on a 12-column line is not detected there; that
//     quirk is a defect and is not ported (slice rule 7).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dieFriction, lastReport, nowStamp, rosterLine, rosterRows, sleepSync, stateDir, stateDirPath, warn, workspaceId } from './state.mjs';
import { cfg, DieError } from './config.mjs';
import { hasWord } from './text.mjs';
import { projectRoot } from './platform.mjs';
import { fmGet, roleBody, roleFile, roleIsEdit, historyHasEdit, REVIEW_ROLES } from './roles.mjs';
import { agentPrompt, agentState, agentRead, agentSendKeys, liveAgents } from './herdr.mjs';
import { briefTask, paneTaskTitle } from './tasks.mjs';
import { waitFor, pollIntervalMs, cksumField } from './wait.mjs';
import { roleTimeoutMs } from './resolve.mjs';
import { PROMPT_MARKER, lastNonEmptyLines, promptSitsInInput, markerSeq, markerSeqChanged } from './arrival.mjs';
// Re-exported so the names that were exported here before the move to
// lib/arrival.mjs keep their import path.
export { PROMPT_MARKER, lastNonEmptyLines, promptSitsInInput, markerSeq, markerSeqChanged };

// ---------- family_conflicts (:3870) ----------

// One "name (kind)" per edit agent of the family `fam` (roster rows whose
// family column equals `fam` and whose current role OR any roles-history
// token is an edit role; edit = role mode != read-only, so a documenter
// session counts too). A worker that only documented is not an edit
// agent: current role documenter with a roles history holding nothing but
// documenter (an empty history qualifies) is skipped. An empty or `unknown`
// family never conflicts, so a
// reviewer of an unmapped kind is never refused.
export function familyConflicts(sd, fam, env = process.env, cwd = process.cwd()) {
  if (fam === '' || fam === 'unknown') return [];
  const out = [];
  for (const line of rosterRows(sd)) {
    const f = line.split('\t');
    const name = f[0] ?? '';
    if (name === '') continue;
    if ((f[4] ?? '') !== fam) continue;
    const role = f[3] ?? '';
    const hist = f.length >= 11 ? (f[10] ?? '') : '';
    if (role === 'documenter') {
      const toks = hist === '' ? [] : hist.split(',').map((s) => s.trim()).filter((s) => s !== '');
      if (toks.every((t) => t === 'documenter')) continue;
    }
    if (roleIsEdit(role, env, cwd) || historyHasEdit(hist, env, cwd)) {
      out.push(`${name} (${f[2] ?? ''})`);
    }
  }
  return out;
}

// ---------- lint_brief (:3887) ----------

// The contract sections every brief must carry (orchestration contract
// rules 3, 5, 6 and the expected result): a level 1-3 header (any case) for
// each of the accepted spellings, plus a line that says no commit/push.
// Returns the missing list — ` [Goal] [Expected result] …`, leading space
// and all, as the message embeds it — or '' when the brief passes.
// Each check mirrors one `grep -qiE` (a line in the file must match).
// A read-only role (opts.readOnly) owns nothing, so the `Owned files`
// section is not asked of it; the other sections still hold. opts.aliases
// (from parseBriefLintAliases) maps a section name to alternate heading
// prefixes: a level 1-3 header that starts with one of them, case-
// insensitive, satisfies the section.
export function briefMissingSections(brief, opts = {}) {
  let text;
  try { text = fs.readFileSync(brief, 'utf8'); } catch { text = ''; }
  const aliases = opts.aliases ?? {};
  const aliasHit = (name) => {
    const alts = aliases[name];
    if (!Array.isArray(alts)) return false;
    return alts.some((h) => {
      const esc = String(h).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`^#{1,3} +${esc}`, 'im').test(text);
    });
  };
  const checks = [
    [[/^#{1,3} +goal/im], 'Goal'],
    [[/^#{1,3} +(expected result|acceptance|definition of done)/im], 'Expected result'],
    ...(opts.readOnly === true ? [] : [[[/^#{1,3} +(owned files|owned|scope)/im], 'Owned files']]),
    [[/^#{1,3} +(forbidden|non-goals|constraints)/im], 'Forbidden'],
    [[/^#{1,3} +report/im], 'Report'],
    [[/(commit|push)/i], "no-git line: say 'no commit/push'"],
  ];
  let missing = '';
  for (const [res, label] of checks) if (!res.some((re) => re.test(text)) && !aliasHit(label)) missing += ` [${label}]`;
  return missing;
}

// The reason each missing section costs the worker, keyed by the missing
// label, in the checks' order. The warning names the reason of every
// missing section (in the same order) so the message always explains the
// section it flags.
const SECTION_REASONS = {
  'Goal': 'the worker does not know what the slice is for',
  'Expected result': 'nothing says when the slice is done',
  'Owned files': 'workers without owned files collide',
  'Forbidden': 'nothing keeps the worker out of other files',
  'Report': 'without a report section the worker may never write one',
  "no-git line: say 'no commit/push'": 'the worker may commit or push',
};

// The reasons of the labels in a missing list, in the same order, joined
// by '; '.
export function missingSectionsReasons(missing) {
  const labels = String(missing).match(/\[([^\]]+)\]/g) ?? [];
  return labels.map((l) => SECTION_REASONS[l.slice(1, -1)] ?? '').join('; ');
}

// The aliasable sections (the no-commit/push line has no heading to
// alias). Section names must match the table above exactly.
const ALIAS_SECTIONS = ['Goal', 'Expected result', 'Owned files', 'Forbidden', 'Report'];

// Parse `brief_lint_aliases` (`Section=Heading1|Heading2,Section2=Heading`):
// returns the section → alternate-headings map and the malformed items that
// were ignored (no `=`, empty section or heading list, unknown section);
// the valid items still apply. Items split on commas, the section name ends
// at the first `=`, the headings split on `|`; empty items are skipped
// silently.
export function parseBriefLintAliases(value) {
  const sections = {};
  const ignored = [];
  for (const item of String(value ?? '').split(',')) {
    if (item === '') continue;
    const eq = item.indexOf('=');
    const name = eq === -1 ? '' : item.slice(0, eq);
    const heads = eq === -1 ? [] : item.slice(eq + 1).split('|').filter((h) => h !== '');
    if (eq === -1 || !ALIAS_SECTIONS.includes(name) || heads.length === 0) { ignored.push(item); continue; }
    sections[name] = heads;
  }
  return { sections, ignored };
}

// Lines (1-based) of the text that carry the empty-inline-code symptom: a
// run of exactly two backticks outside fenced code blocks — a run of three
// or more is a fence marker (or a longer inline delimiter) and does not
// count. A shell heredoc without quotes runs the backticks of a code span
// and leaves `` where the code was.
export function emptyCodeLines(text) {
  const out = [];
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  for (const [i, line] of String(text ?? '').split('\n').entries()) {
    const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!inFence && open) {
      inFence = true;
      fenceChar = open[1][0];
      fenceLen = open[1].length;
      continue;
    }
    if (inFence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,}) *$/);
      if (close && close[1][0] === fenceChar && close[1].length >= fenceLen) inFence = false;
      continue;
    }
    for (const m of line.matchAll(/`+/g)) {
      if (m[0].length === 2) { out.push(i + 1); break; }
    }
  }
  return out;
}

// lint_brief <file>: brief_lint=warn|strict|off (default warn). strict dies
// 2 (with a friction entry for the living command); warn prints the warning
// and continues. `off` never checks. A read-only role (opts.readOnly) skips
// the `Owned files` check (see briefMissingSections).
// The warning names the reason of every missing section: `brief <path> is
// missing sections: [A] [B] — <reason A>; <reason B>`; strict appends
// ` (brief_lint=strict)` to the same text.
// A separate check flags the empty-inline-code symptom (``): it runs in
// warn and strict alike (only brief_lint=off silences it), at most three
// per-line warnings, then one for the rest.
export function lintBrief(brief, ctx, env = process.env, opts = {}) {
  const mode = cfg(ctx, 'brief_lint', 'warn', env);
  if (mode === 'off') return;
  const { sections: aliases, ignored } = parseBriefLintAliases(cfg(ctx, 'brief_lint_aliases', '', env));
  for (const item of ignored) warn(`brief_lint_aliases: ignored '${item}' (use Section=Heading|Heading)`);
  let body = '';
  try { body = fs.readFileSync(brief, 'utf8'); } catch { body = ''; }
  const bad = emptyCodeLines(body);
  for (const n of bad.slice(0, 3)) {
    warn(`brief ${brief} line ${n} has empty inline code (\`\`): a shell heredoc without quotes may have run the backticks`);
  }
  if (bad.length > 3) warn(`… and ${bad.length - 3} more line(s)`);
  const missing = briefMissingSections(brief, { ...opts, aliases });
  if (missing === '') return;
  const message = `brief ${brief} is missing sections:${missing} — ${missingSectionsReasons(missing)}`;
  if (mode === 'strict') dieFriction(`${message} (brief_lint=strict)`, 2);
  warn(message);
}

// ---------- owned files of a brief ----------

// The accepted `Owned files` headers (the same spellings the lint asks
// for) and the lone words that are not paths (any case).
const OWNED_HEADER_RES = [/^#{1,3} +owned files/i, /^#{1,3} +owned/i, /^#{1,3} +scope/i];
const PATH_STOPWORDS = new Set(['nenhum', 'none']);

// The `Owned files` section (or its lint alias) of a brief text: from the
// header to the next header of the same or a higher level. '' when absent.
function ownedSection(text, aliases = {}) {
  const lines = String(text ?? '').split('\n');
  const alt = aliases['Owned files'];
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^(#{1,3}) +(.+)$/);
    if (!m) continue;
    const title = m[2];
    const aliased = Array.isArray(alt) && alt.some((h) => new RegExp(`^${String(h).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(title));
    if (OWNED_HEADER_RES.some((re) => re.test(lines[i])) || aliased) { start = i; level = m[1].length; break; }
  }
  if (start === -1) return '';
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i += 1) {
    const h = lines[i].match(/^(#{1,6}) /);
    if (h && h[1].length <= level) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

// A token that looks like a path: a single token with a "/" or a ".",
// not a lone stopword (trailing punctuation ignored).
function pathLike(token) {
  const t = String(token ?? '').trim();
  if (t === '' || t.includes(' ')) return false;
  if (PATH_STOPWORDS.has(t.replace(/[.,;:]+$/, '').toLowerCase())) return false;
  return /[/.]/.test(t);
}

// The paths a brief owns: the code spans and the path-like list items of
// its `Owned files` section (or lint alias). Normalized: a leading `./` and
// a trailing "/" are dropped, "Nenhum"/"none" ignored, deduplicated in
// first-seen order.
export function ownedPaths(text, aliases = {}) {
  const section = ownedSection(text, aliases);
  if (section === '') return [];
  const out = [];
  const push = (raw) => {
    let p = String(raw ?? '').trim();
    while (p.startsWith('./')) p = p.slice(2);
    if (p.endsWith('/')) p = p.slice(0, -1);
    if (!pathLike(p) || out.includes(p)) return;
    out.push(p);
  };
  for (const line of section.split('\n')) {
    for (const m of line.matchAll(/`([^`]+)`/g)) push(m[1]);
    const li = line.match(/^\s*([-*+]|\d+[.)])\s+([^`].*)$/);
    if (li) push(li[2]);
  }
  return out;
}

// The `# Brief` section of a composed brief file: from its level-1 header
// to the `# Report contract` header (or end of file) — the embedded brief
// is verbatim and carries its own level-1 headers, so only the report
// contract closes the block. '' when absent (an amendment's composed file
// has no `# Brief` section).
export function composedBriefSection(text) {
  const lines = String(text ?? '').split('\n');
  const start = lines.indexOf('# Brief');
  if (start === -1) return '';
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i] === '# Report contract') break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

// The composed brief a pending report was dispatched with: the same
// timestamp pair under briefs/ (state routing) or, with the $TMPDIR
// routing, alongside the report as `<name>.brief.md`. '' when neither
// candidate is a file.
export function pendingBriefPath(report) {
  const name = path.basename(String(report ?? ''));
  if (!name.endsWith('.md')) return '';
  const base = name.slice(0, -3);
  const dir = path.dirname(String(report));
  for (const c of [path.join(dir, '..', 'briefs', `${base}.md`), path.join(dir, `${base}.brief.md`)]) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ }
  }
  return '';
}

// A glob matches a path: `*` and `?` stay inside one segment (they never
// cross a `/`), `**` crosses segments (a `**/` also matches zero
// segments, so `dir/**/x` reaches `dir/x`), and `[...]` is a character
// class (a leading `!` or `^` negates; a `]` as the first member is
// literal; an unclosed class is a literal `[`).
export function globMatches(glob, str) {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 2;
        if (glob[i] === '/') { re += '(?:.*/)?'; i += 1; continue; }
        re += '.*';
        continue;
      }
      re += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') { re += '[^/]'; i += 1; continue; }
    if (c === '[') {
      let j = i + 1;
      if (glob[j] === '!' || glob[j] === '^') j += 1;
      let start = j;
      if (glob[j] === ']') j += 1; // a leading ] is a literal member
      let closed = -1;
      while (j < glob.length) { if (glob[j] === ']') { closed = j; break; } j += 1; }
      if (closed !== -1 && closed > start) {
        re += '[' + glob.slice(i + 1, closed).replace(/^[-^!]/, (m) => (m === '-' ? m : '^')) + ']';
        i = closed + 1;
        continue;
      }
      re += '\\[';
      i += 1;
      continue;
    }
    re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }
  return new RegExp(`^${re}$`).test(str);
}

// The literal part of a glob: the prefix before the first `*`, `?` or `[`
// (trailing slashes dropped); the whole string when it carries no wildcard.
function literalPrefix(p) {
  const i = p.search(/[*?[]/);
  return i === -1 ? p : p.slice(0, i).replace(/\/+$/, '');
}

// Two owned paths cross when they are equal, when one is a directory the
// other is inside (a segment boundary, either way), or — when either side
// carries a wildcard — when the glob matches the other path, when the
// glob's literal prefix and the path hold a directory relation (the prefix
// inside the path, or the path inside the prefix; an empty prefix crosses
// every relative path), or — glob against glob — when one literal prefix
// starts with the other, as text (`roles/reviewer*.md` and
// `roles/review*.md` both match `roles/reviewer.md`).
export function pathsCross(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  if (x === y) return true;
  const inside = (p, q) => p === q || p.startsWith(q + '/') || q.startsWith(p + '/');
  const hasGlob = (p) => /[*?[]/.test(p);
  if (!hasGlob(x) && !hasGlob(y)) return inside(x, y);
  const crossPlain = (g, t) => {
    if (globMatches(g, t)) return true;
    const p = literalPrefix(g);
    if (p === '') return true;
    return inside(p, t);
  };
  if (hasGlob(x) && !hasGlob(y)) return crossPlain(x, y);
  if (hasGlob(y) && !hasGlob(x)) return crossPlain(y, x);
  const px = literalPrefix(x);
  const py = literalPrefix(y);
  if (px === '' || py === '') return true;
  // Glob against glob: compare the raw text before the first wildcard, the
  // trailing `/` kept, so `roles/reviewer*` and `roles/review*` cross
  // (both match `roles/reviewer.md`) while `scripts/*` and `scripts2/*`
  // do not (the `/` is a segment boundary).
  const rx = rawPrefix(x);
  const ry = rawPrefix(y);
  return rx.startsWith(ry) || ry.startsWith(rx);
}

// The text before the first wildcard, as written (no trailing-`/` trim).
function rawPrefix(p) {
  const i = p.search(/[*?[]/);
  return i === -1 ? p : p.slice(0, i);
}

// The `# Brief` section a pending composed prompt still commits its worker
// to: the prompt's own `# Brief`; when the prompt is an amendment (no
// `# Brief`), the `# Brief` of the same agent's newest EARLIER composed
// prompt in the same directory (same file kind) that has one — the
// amendment amends that brief, so its owned files are still the worker's.
// '' when the file is unreadable or no earlier base brief exists.
export function pendingBriefSection(pb) {
  let body = '';
  try { body = fs.readFileSync(pb, 'utf8'); } catch { return ''; }
  const own = composedBriefSection(body);
  if (own !== '') return own;
  const baseName = path.basename(pb).replace(/\.brief\.md$/, '.md');
  const m = /^(.+)-(\d{8}T\d{6})(?:-(\d+))?\.md$/.exec(baseName);
  if (m === null) return '';
  const agent = m[1];
  const ts = m[2];
  const suf = m[3] === undefined ? 1 : Number(m[3]);
  const isBriefKind = path.basename(pb).endsWith('.brief.md');
  const dir = path.dirname(pb);
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return ''; }
  let best = null;
  for (const f of entries) {
    if (isBriefKind ? !f.endsWith('.brief.md') : f.endsWith('.brief.md')) continue;
    const mm = /^(.+)-(\d{8}T\d{6})(?:-(\d+))?\.md$/.exec(f.replace(/\.brief\.md$/, '.md'));
    if (mm === null || mm[1] !== agent) continue;
    if (mm[2] > ts || (mm[2] === ts && (mm[3] === undefined ? 1 : Number(mm[3])) >= suf)) continue;
    let content = '';
    try { content = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    const sec = composedBriefSection(content);
    if (sec === '') continue;
    const s2 = mm[3] === undefined ? 1 : Number(mm[3]);
    if (best === null || mm[2] > best.ts || (mm[2] === best.ts && s2 > best.suf)) best = { ts: mm[2], suf: s2, sec };
  }
  return best === null ? '' : best.sec;
}


// ---------- the composed prompt (:3930-3958) ----------
// The standing worker rules at the end of every composed prompt (the brief
// and the amendment): the same lines, never duplicated.
function standingRules() {
  return [
    `- Only you write this report, once all of the brief is done, including any part you handed to subagents or background tasks; a subagent never writes it. Report every item as it stands in the files, not as a subagent summarized it.\n`,
    `- Command output you put in the report is pasted from the run, never retyped or reconstructed.\n`,
    `- Nobody watches this terminal: do not ask interactive questions or wait for a confirmation. When the brief does not decide something, follow its "When the brief does not decide" section, or mark the item partial and list the gap and the options under open questions.\n`,
    `- Never invent names, endpoints, flags, credentials, URLs or requirements.\n`,
    `- Do not commit, push, tag, or open pull requests.\n`,
    `- When finished, reply in the terminal with exactly the report path and nothing else.\n`,
  ].join('');
}

// The sandbox notes of a codex worker: its sandbox cannot write under .git
// and has no network (local ports included) unless the opening args grant
// it. Both notes sit right before the standing rules, in the brief and the
// amendment prompts; a roster line without the opening-args column counts
// as empty args, and any other kind gets no note.
const SANDBOX_GIT_NOTE = '- Your sandbox cannot write under .git: do not run git mv, git checkout, git add or git commit. Describe renames and restores in the report; the orchestrator runs them.\n';
const SANDBOX_NET_NOTE = '- Your sandbox has no network, local ports included: tests that start a local server fail with "Operation not permitted". Mark them [partial] and say so; the orchestrator runs them. Still write the integration tests the brief asks for, even if you cannot run them here; do not replace them with unit tests of helpers, and add a test seam (an injectable value) when the code depends on something fixed, such as the build type.\n';

// D25: another live roster agent with an edit role shares this worker's
// cwd (roster column 7): the tree is being edited in parallel, so the
// global checks may fail in files outside this slice.
const SHARED_TREE_NOTE = '- Another worker edits this same tree now: run the global checks the brief asks for, but report failures in files you do not own as outside your slice (name the files), not as [partial] items of yours.\n';

export function sandboxNotes(kind, agentArgs) {
  if (kind !== 'codex') return [];
  const args = String(agentArgs ?? '').split(/\s+/).filter((a) => a !== '');
  // danger-full-access and the bypass flag both lift every limit; a token
  // that ENDS in network_access=true releases the network (the real token
  // is sandbox_workspace_write.network_access=true, passed via -c).
  const full = args.includes('danger-full-access')
    || args.includes('--dangerously-bypass-approvals-and-sandbox');
  const net = args.some((a) => a.endsWith('network_access=true'));
  const notes = [];
  if (!full) notes.push(SANDBOX_GIT_NOTE);
  if (!full && !net) notes.push(SANDBOX_NET_NOTE);
  return notes;
}

// The composed prompt file: `# Role: <name>`, the role line, the role body,
// `# Brief` with the brief verbatim (`cat` — no CRLF normalization), and
// `# Report contract` with the report path, the report language when
// `report_language` is set, the one-go rule, the `worker_context=lean` rule,
// and the standing worker rules (only the worker writes the report,
// nobody watches the terminal, never invent, no git, reply with the report
// path). Same lines, same order, as bash.
export function composePrompt(roleFile, role, agent, briefRaw, report, ctx, env = process.env, kind = '', agentArgs = '', sharedTree = false) {
  const out = [];
  out.push(`# Role: ${fmGet(roleFile, 'name')}\n\n`);
  out.push(`You are running as the \`${role}\` role, agent name \`${agent}\`, inside a multi-agent run coordinated by an orchestrator that cannot see your terminal.\n\n`);
  out.push(roleBody(roleFile));
  out.push(`\n\n# Brief\n\n`);
  out.push(briefRaw);
  out.push(`\n\n# Report contract\n\n`);
  out.push(`- Write your report as Markdown to \`${report}\` (create parent directories if needed) following the \`<report>\` section of your role. Give every item its state as \`[done]\`, \`[partial]\` or \`[skipped]\`, followed by the reason.\n`);
  const lang = cfg(ctx, 'report_language', '', env);
  if (lang !== '') out.push(`- Write the report in ${lang}.\n`);
  out.push(`- Write the report in one go, as the last action of your work; the orchestrator treats its existence as completion.\n`);
  if (cfg(ctx, 'worker_context', 'full', env) === 'lean') {
    out.push(`- This brief is self-contained. Do NOT read CLAUDE.md, AGENTS.md, ai-memory rules, wiki pages or other project instruction files unless the brief names them explicitly; the rules that apply are quoted in the brief. Start on the task immediately.\n`);
  }
  for (const n of sandboxNotes(kind, agentArgs)) out.push(n);
  if (sharedTree) out.push(SHARED_TREE_NOTE);
  out.push(standingRules());
  return out.join('');
}

// D25 pure core: does any OTHER roster agent hold an edit role, is live and
// sit in the same cwd (column 7) as the worker? `rows` are the roster TSV
// rows, `liveNames` the live agent names (one `herdr agent list` read, never
// a call per agent), `self` the worker's name, `selfCwd` its column 7 and
// `isEdit` the role→edit predicate (roleIsEdit).
export function sharedTreeEditor(rows, liveNames, self, selfCwd, isEdit) {
  if (String(selfCwd ?? '') === '') return false;
  // `liveNames` holds names, or the agents of `herdr agent list`: with an
  // agent's pane and a row's pane both known, the row is live only on the
  // same pane (a name alive on another pane is a stale row), as the roster
  // and the spawn read it.
  const live = liveNames.map((a) => (typeof a === 'string' ? { name: a, pane: '' } : { name: a?.name ?? '', pane: String(a?.pane_id ?? '') }));
  for (const row of rows) {
    const f = String(row).split('\t');
    const name = f[0] ?? '';
    const rowPane = f[1] ?? '';
    if (name === '' || name === self) continue;
    if (!live.some((a) => a.name === name && (a.pane === '' || rowPane === '' || a.pane === rowPane))) continue;
    if ((f[6] ?? '') !== selfCwd) continue;
    if (isEdit(f[3] ?? '')) return true;
  }
  return false;
}

// The amendment composed prompt: `# Amendment to your current brief`, the
// amendment verbatim (no CRLF normalization, as the brief), and `# Report
// contract` with the override line, the report path (with the one-report
// rule for a not-yet-written brief), the report language when
// `report_language` is set, the one-go rule and the standing worker rules.
// The worker already has the role and the current brief in context, so the
// amendment carries neither.
export function composeAmendment(amendRaw, report, ctx, env = process.env, kind = '', agentArgs = '', sharedTree = false) {
  const out = [];
  out.push(`# Amendment to your current brief\n\n`);
  out.push(amendRaw);
  out.push(`\n\n# Report contract\n\n`);
  out.push(`- This amendment overrides your current brief where they differ; the rest of that brief still holds.\n`);
  out.push(`- Write your report as Markdown to \`${report}\` (create parent directories if needed). If you have not written the report of your current brief yet, write one report there that covers the brief and this amendment; otherwise report only on the amendment.\n`);
  out.push(`- Give every item its state as \`[done]\`, \`[partial]\` or \`[skipped]\`, followed by the reason.\n`);
  const lang = cfg(ctx, 'report_language', '', env);
  if (lang !== '') out.push(`- Write the report in ${lang}.\n`);
  out.push(`- Write the report in one go, as the last action of your work; the orchestrator treats its existence as completion.\n`);
  for (const n of sandboxNotes(kind, agentArgs)) out.push(n);
  if (sharedTree) out.push(SHARED_TREE_NOTE);
  out.push(standingRules());
  return out.join('');
}

// ---------- one dispatch, one pair of paths ----------

// nowStamp is second-granular, so a dispatch (or an amendment) inside the
// same second as an earlier one would reuse the `<agent>-<ts>` pair: the
// old report would be read as the new dispatch's completion. A pair is
// taken when the composed prompt exists, the report exists, or last-report
// already points at the report. Returns '' for the free unsuffixed pair,
// else the first of '-2', '-3', … for which the pair is free. Pure: the
// paths come from `composedAt`/`reportAt` (the suffix is applied to the
// timestamp), `exists` decides file presence and `lastReport` is the
// current content of last-report-<agent> ('' when absent).
export function dispatchPairSuffix(composedAt, reportAt, exists, lastReport) {
  for (let n = 1; ; n += 1) {
    const suf = n === 1 ? '' : `-${n}`;
    const c = composedAt(suf);
    const r = reportAt(suf);
    if (!exists(c) && !exists(r) && lastReport !== r) return suf;
  }
}

// ---------- cmd_dispatch (:3900) ----------

// `dispatch <agent> <brief.md> [--role R] [--timeout MS] [--no-wait]
// [--allow-same-family] [--amend]` → the final JSON, rc 0/4/6/7/9/11/14/15.
// The `${1:?}` / `${2:?}` parameter errors are bash builtins (exit 1, no
// friction entry), so they use a plain stderr line, not dieFriction.
//
// `--amend` sends <brief.md> as an amendment of the agent's current brief:
// it needs an earlier dispatch (last-report-<agent> exists), keeps the
// current role (--role conflicts), skips the section lint (a delta, not a
// brief) and the family check (the role and the worker are the original
// dispatch's), and writes a new report that last-report-<agent> points at
// (the wait/<agent>.* markers are cleared, as on a plain dispatch, so the
// wait watches the amendment's report). The pane keeps the current task
// title, without the report mark (✓) while the amendment is in flight.
export function cmdDispatch(argv, ctx, env = process.env, cwd = process.cwd()) {
  const agent = argv[0];
  const brief = argv[1];
  if (agent === undefined || agent === '') {
    process.stderr.write('herdr-agents.mjs: 1: agent\n');
    process.exit(1);
  }
  if (brief === undefined || brief === '') {
    process.stderr.write('herdr-agents.mjs: 2: brief.md\n');
    process.exit(1);
  }
  let role = '';
  let timeout = '';
  let wait = 1;
  let allow = 0;
  let amend = 0;
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--role' || a === '--timeout') {
      const v = argv[i + 1];
      if (v === undefined) dieFriction(`dispatch: ${a} expects a value`, 2);
      if (a === '--role') role = v;
      else timeout = v;
      i += 1;
    } else if (a === '--no-wait') {
      wait = 0;
    } else if (a === '--allow-same-family') {
      allow = 1;
    } else if (a === '--amend') {
      amend = 1;
    } else if (a.startsWith('--')) {
      dieFriction(`dispatch: unknown option ${a}`, 2);
    } else {
      // Bash lumps a stray positional into the same `*` branch.
      dieFriction(`dispatch: unknown option ${a}`, 2);
    }
  }
  if (amend === 1 && role !== '') dieFriction('dispatch: --amend keeps the current role; drop --role', 2);
  // Bash `[ -f "$brief" ]`: a regular file (a directory or a broken link is
  // "not found").
  let briefIsFile = false;
  try { briefIsFile = fs.statSync(brief).isFile(); } catch { briefIsFile = false; }
  if (!briefIsFile) dieFriction(`brief not found: ${brief}`, 2);
  // Only the path, no side effects: nothing is created before the lint
  // (a strict lint must die without leaving a state dir behind). The
  // roster and last-report are read straight from the files; a missing
  // roster is empty.
  const sd = stateDirPath(ctx, env, cwd);
  const line = rosterLine(sd, agent);
  if (line === '') dieFriction(`agent '${agent}' is not in this skill's roster (spawn it first, or pass a name you spawned)`, 3);
  // The amendment's precondition: an earlier dispatch recorded the report
  // the worker was told to write (last-report-<agent>).
  if (amend === 1 && !fs.existsSync(path.join(sd, `last-report-${agent}`))) {
    dieFriction(`dispatch: --amend needs an earlier dispatch to '${agent}' (nothing to amend)`, 2);
  }
  const cols = line.split('\t');
  if (role === '') role = cols[3] ?? '';
  const kind = cols[2] ?? '';
  const family = cols[4] ?? '';
  const rf = roleFile(role, env, cwd);
  if (rf === null) dieFriction(`unknown role '${role}' (run: herdr-agents roles)`, 3);
  // The section lint runs after the role is resolved: a read-only role
  // (mode != edit) needs no `Owned files` section. An amendment is a
  // delta, not a brief: no section lint.
  if (amend !== 1) lintBrief(brief, ctx, env, { readOnly: !roleIsEdit(role, env, cwd) });
  // The role's timeout (frontmatter, else dispatch_timeout), scaled by the
  // role's effective effort (xhigh 1.5x, max 2x) — the same value a later
  // `wait` without --timeout uses.
  if (timeout === '') timeout = String(roleTimeoutMs(role, ctx, env, cwd));

  // Reviewer family check (REVIEW_ROLES, not REVIEW_ROLES_ALL): an edit
  // agent of the same family — current role or roles history — blocks a
  // strict check (5); warn mode and --allow-same-family only warn. An
  // amendment reuses the original dispatch's role and worker: skipped.
  const familyCheck = cfg(ctx, 'family_check', 'strict', env);
  if (amend !== 1 && hasWord(REVIEW_ROLES, role) && familyCheck !== 'off') {
    const conflicts = familyConflicts(sd, family, env, cwd);
    if (conflicts.length > 0) {
      if (allow === 1 || familyCheck === 'warn') {
        warn(`reviewer '${agent}' shares model family '${family}' with: ${conflicts.join(' ')}`);
      } else {
        dieFriction(`reviewer '${agent}' (${kind}, ${family}) shares a model family with edit agents: ${conflicts.join(' ')}. Spawn the reviewer with another --kind, pass --allow-same-family, or set family_check=warn.`, 5);
      }
    }
  }

  // Owned-files overlap: every other roster agent whose report is still
  // pending (last-report-<agent> exists and the recorded report is absent
  // or empty) is still working the files of its composed brief. When the
  // new brief owns any of those paths (equal, inside a directory, or a
  // glob prefix), warn once per agent with at most five paths. Advisory
  // only — never blocks; skipped on --amend (the worker keeps its own
  // brief) and when the new brief has no `Owned files` section.
  if (amend !== 1) {
    const ownedAliases = parseBriefLintAliases(cfg(ctx, 'brief_lint_aliases', '', env)).sections;
    let newBody = '';
    try { newBody = fs.readFileSync(brief, 'utf8'); } catch { newBody = ''; }
    const mine = ownedPaths(newBody, ownedAliases);
    const isEdit = roleIsEdit(role, env, cwd);
    for (const row of rosterRows(sd)) {
      const other = row.split('\t')[0];
      if (other === '' || other === agent) continue;
      const rep = lastReport(sd, other);
      if (rep === '') continue;
      let pending = true;
      try { pending = fs.statSync(rep).size === 0; } catch { pending = true; }
      if (!pending) continue;
      const pb = pendingBriefPath(rep);
      if (pb === '') continue;
      // An amendment prompt has no `# Brief` of its own: the overlap check
      // uses the `# Brief` of the agent's newest earlier base brief — the
      // amendment amends that brief, so its files are still the worker's.
      const theirs = ownedPaths(pendingBriefSection(pb), ownedAliases);
      const hits = mine.filter((p) => theirs.some((q) => pathsCross(p, q)));
      if (hits.length === 0) continue;
      const shown = hits.slice(0, 5).join(', ');
      warn(isEdit
        ? `brief ${brief} owns files that '${other}' is still editing: ${shown}`
        : `reviewing files that '${other}' is still editing: ${shown}`);
    }
  }

  // Report and composed prompt under the state dir — or under the shared
  // tmp when the worker's cwd is not this repo root (worktree, other
  // checkout): its sandbox may not reach the repo root, while every known
  // sandbox allows cwd, /tmp and $TMPDIR (spec 3.3).
  // First write of the dispatch: create the state dir (briefs/,
  // reports/, wait/, the roster header) only after the lint and the
  // family check; stateDir returns the same path as stateDirPath above.
  stateDir(ctx, env, cwd);
  const ts = nowStamp();
  const wcwd = cols[6] ?? '';
  // D25: another live roster agent with an edit role in the same cwd
  // (column 7) edits this same tree: the composed prompt (brief and
  // amendment) carries the shared-tree line right before the standing
  // rules. One `herdr agent list` read (never a call per agent); a herdr
  // failure skips the advisory line and never blocks the dispatch.
  let sharedTree = false;
  try {
    sharedTree = sharedTreeEditor(rosterRows(sd), liveAgents(env), agent, wcwd, (r) => roleIsEdit(r, env, cwd));
  } catch { sharedTree = false; }
  const tmpReports = wcwd !== '' && wcwd !== projectRoot(env, cwd)
    ? path.join(env.TMPDIR || os.tmpdir(), 'herdr-agents', workspaceId(ctx, env, cwd), 'reports')
    : null;
  const composedAt = (suf) => (tmpReports !== null
    ? path.join(tmpReports, `${agent}-${ts}${suf}.brief.md`)
    : path.join(sd, 'briefs', `${agent}-${ts}${suf}.md`));
  const reportAt = (suf) => (tmpReports !== null
    ? path.join(tmpReports, `${agent}-${ts}${suf}.md`)
    : path.join(sd, 'reports', `${agent}-${ts}${suf}.md`));
  // A dispatch in the same second as an earlier one must not reuse the
  // pair (the old report would be read as the new dispatch's
  // completion): <ts>-2, then <ts>-3, … until a free pair; without a
  // collision the names stay `<agent>-<ts>.md`.
  const suf = dispatchPairSuffix(composedAt, reportAt, (p) => fs.existsSync(p), lastReport(sd, agent));
  const composed = composedAt(suf);
  const report = reportAt(suf);
  if (tmpReports !== null) fs.mkdirSync(tmpReports, { recursive: true });
  fs.mkdirSync(path.dirname(composed), { recursive: true });
  fs.writeFileSync(composed, amend === 1
    ? composeAmendment(fs.readFileSync(brief, 'utf8'), report, ctx, env, kind, cols[13] ?? '', sharedTree)
    : composePrompt(rf, role, agent, fs.readFileSync(brief, 'utf8'), report, ctx, env, kind, cols[13] ?? '', sharedTree));
  fs.writeFileSync(path.join(sd, `last-report-${agent}`), `${report}\n`);
  for (const suf of ['size', 'screen', 'since', 'blocked', 'approvals', 'quota',
    'provider', 'provider-cause', 'capacity-retries', 'capacity-at',
    'question', 'stuck-hash', 'stuck-since', 'stuck-warned',
    'not-received', 'enter-retry', 'approve-screen']) {
    fs.rmSync(path.join(sd, 'wait', `${agent}.${suf}`), { force: true });
  }

  // Submit. Bash merges stdout+stderr into `result` (2>&1) and fails on a
  // non-zero exit. The prompt always starts with PROMPT_MARKER (the
  // input-box marker of the arrival check below). An amendment is named as
  // such: it amends the brief the worker is already on.
  const text = amend === 1
    ? `${PROMPT_MARKER}${composed} in full and execute it. It amends the brief you are working on. When finished, write your report to ${report} and reply with exactly that path and nothing else.`
    : `${PROMPT_MARKER}${composed} in full and execute it. It contains your role, your brief, and your report contract. When finished, write your report to ${report} and reply with exactly that path and nothing else.`;
  // Item 15 (+amendment): the acceptance of the `agent prompt` call is not
  // proof the prompt reached the worker (a dead pane kept its welcome
  // screen; a CLI kept the text sitting in its input box). With the check
  // on (prompt_check_seconds a positive integer; 0 turns it off, and an
  // invalid value fails safe = off) the visible screen is hashed before
  // the send (H0) and, for prompt_check_seconds at min(1000, poll
  // interval) ms, the agent is probed:
  //   1. arrived when the state is working or blocked, or a non-empty
  //      report exists (a screen change alone no longer counts);
  //   2. at the window's end, when one of the last 15 non-empty visible
  //      lines carries the marker, the prompt sat in the input box: one
  //      Enter key, then a fresh window with only rule 1;
  //   3. still on the exact H0 screen (and not 2): the single resend of
  //      the same text (fresh H0), then a fresh window with only rule 1;
  //   4. a changed screen (and not 2, and not arrived): considered
  //      received (a worker detected by a screen that does not report
  //      working), no resend.
  // Still nothing: `not-received`, exit 15.
  const rawWin = String(cfg(ctx, 'prompt_check_seconds', '15', env));
  const checkOn = /^[0-9]+$/.test(rawWin) && Number(rawWin) > 0;
  let H0 = '';
  if (checkOn) H0 = cksumField(agentRead(env, agent, { source: 'visible' }));
  let status = 'submitted';
  const p = agentPrompt(agent, text, env);
  if (!p.ok) {
    status = 'error';
    process.stdout.write(JSON.stringify({ wait_status: 'error', agent, role, kind, composed_prompt: composed, report, report_exists: false, raw: p.raw }) + '\n');
    warn(`prompt submission failed; inspect with: herdr agent get ${agent} && herdr agent read ${agent}. Do not resend blindly.`);
    return 4;
  }
  let resent = false;
  let enterSent = false;
  if (checkOn) {
    const windowMs = Number(rawWin) * 1000;
    const pollMs = Math.min(1000, pollIntervalMs(env));
    // Rule 1 only: the state or the report says the prompt landed.
    const arrived = () => {
      const st = agentState(agent, env);
      if (st.state === 'working' || st.state === 'blocked') return true;
      try { return fs.statSync(report).size > 0; } catch { return false; }
    };
    const waitForArrival = (ms) => {
      const deadline = Date.now() + ms;
      for (;;) {
        if (arrived()) return true;
        if (Date.now() >= deadline) break;
        sleepSync(pollMs);
      }
      return arrived();
    };
    // Same keys as the error case above (without raw). The .not-received
    // marker (epoch seconds + the agent's state_change_seq read now) lets a
    // later `wait` retry the Enter instead of watching the still screen
    // until the timeout, and discard the marker when the seq shows the
    // agent changed state in the meantime. A new dispatch clears it (as it
    // clears every other wait marker). The check only runs with a positive
    // prompt_check_seconds, so the marker never lands with the check off.
    const notReceived = (what) => {
      let reportNow = false;
      try { reportNow = fs.statSync(report).size > 0; } catch { reportNow = false; }
      const seq = agentState(agent, env).seq;
      fs.writeFileSync(path.join(sd, 'wait', `${agent}.not-received`),
        `${Math.floor(Date.now() / 1000)}${seq !== '' ? ` ${seq}` : ''}\n`);
      process.stdout.write(JSON.stringify({ wait_status: 'not-received', agent, role, kind, composed_prompt: composed, report, report_exists: reportNow }) + '\n');
      warn(`prompt to '${agent}' was not received after ${what}; read the pane (herdr agent read ${agent} --source visible) before sending anything else`);
      return 15;
    };
    if (!waitForArrival(windowMs)) {
      const screen = agentRead(env, agent, { source: 'visible' });
      if (promptSitsInInput(screen)) {
        // (2) the text is visible in the input box: it sat there without
        // an Enter. Send one Enter and re-check with only rule 1.
        agentSendKeys(agent, 'enter', env);
        enterSent = true;
        warn(`prompt to '${agent}' sat in the input box; sent Enter`);
        if (!waitForArrival(windowMs)) return notReceived('an Enter on the text left in its input box');
      } else if (String(cksumField(screen)) === String(H0)) {
        // (3) the screen never moved: resend the same text once.
        warn(`prompt to '${agent}' did not arrive (screen unchanged, agent not working); sending it once more`);
        H0 = cksumField(agentRead(env, agent, { source: 'visible' }));
        if (agentPrompt(agent, text, env).ok) {
          resent = true;
          if (!waitForArrival(windowMs)) return notReceived('one resend');
        } else {
          return notReceived('one resend');
        }
      }
      // (4) the screen changed without the input marker — a worker
      // detected by a screen that does not report working: received, no
      // resend.
    }
  }

  // The task the pane shows. A plain dispatch titles it from the brief's
  // H1 (or the file name); the report mark (✓) lands in wait_for →
  // mark_task_done. An amendment keeps the current task: the mark is
  // dropped (file and pane) while the amendment is in flight, so the wait
  // re-marks it when the amendment's report lands; without a task file the
  // amendment's own file names the task.
  let taskTitle;
  if (amend === 1) {
    const tf = path.join(sd, `task-${agent}`);
    let cur = '';
    try { cur = fs.readFileSync(tf, 'utf8').replace(/\n+$/, ''); } catch { cur = ''; }
    if (cur.endsWith(' ✓')) cur = cur.slice(0, -' ✓'.length);
    taskTitle = cur !== '' ? cur : `${role}: ${briefTask(brief)}`;
    fs.writeFileSync(tf, `${taskTitle}\n`);
  } else {
    taskTitle = `${role}: ${briefTask(brief)}`;
    fs.writeFileSync(path.join(sd, `task-${agent}`), `${taskTitle}\n`);
  }
  // Re-read the pane from the roster now, like bash pane_task_title: the
  // line may have changed while the prompt was being sent.
  paneTaskTitle(sd, agent, taskTitle, env);

  // The wait (unless --no-wait): one JSON line for the agent, captured, not
  // printed — the final JSON below is the only stdout besides warnings.
  let wrc = 0;
  let qerr = '';
  let qmatch = '';
  let qrenew = '';
  let qlane = '';
  let qmodel = '';
  let pcause = '';
  let preties = 0;
  let qtext = '';
  let wpartial = 0;
  let wverdict = '';
  let wfindings;
  let wseverity;
  let wdialog;
  let wsettled = '';
  if (wait === 1) {
    const lines = [];
    try {
      wrc = waitFor([agent], { sd, ctx, env, timeoutMs: Number(timeout), any: false, sink: (l) => { lines.push(l); } });
    } catch (e) {
      if (e instanceof DieError) dieFriction(e.message, e.code);
      throw e;
    }
    const last = lines.length > 0 ? JSON.parse(lines[lines.length - 1]) : {};
    status = last.status ?? '';
    qerr = last.error ?? '';
    // D39: the internal wait follows the last-report-<agent> pointer, and
    // an amendment sent mid-wait re-points it: the wait line's `report`
    // is then the report the agent is actually writing. Name it
    // (settled_report) and qualify report_exists for it — the dispatch's
    // own report will never arrive. Same report (or no report on the
    // line): nothing changes, not even the key.
    if (typeof last.report === 'string' && last.report !== '' && last.report !== report) wsettled = last.report;
    // The done wait line carries `partial: N` when the report marks
    // item(s) partial; it lands in the final JSON (the warn already came
    // from the wait).
    if (last.status === 'done' && Number.isInteger(last.partial)) wpartial = last.partial;
    // The done wait line carries the review header (verdict, findings,
    // severity) when the report starts with it; they land in the final
    // JSON the same way (the wait already warns on a bad header).
    if (last.status === 'done') {
      if (last.verdict !== undefined) wverdict = last.verdict;
      if (last.findings !== undefined) wfindings = last.findings;
      if (last.severity !== undefined) wseverity = last.severity;
    }
    // The blocked wait line carries the dialog (the last 20 non-empty
    // visible lines): the final JSON carries it the same way, so a block
    // inside a dispatch keeps the screen context the wait line provides.
    if (last.status === 'blocked' && last.dialog !== undefined) wdialog = last.dialog;
    if (last.status === 'quota') {
      qmatch = last.match ?? '';
      qrenew = last.renewal ?? '';
      qlane = last.lane ?? '';
      qmodel = last.model ?? '';
    } else if (last.status === 'provider-error' || last.status === 'capacity') {
      qlane = last.lane ?? '';
      qmodel = last.model ?? '';
      pcause = last.cause ?? '';
      preties = Number.isInteger(last.retries) ? last.retries : 0;
    } else if (last.status === 'question') {
      qtext = last.question ?? '';
    }
  }

  let reportExists = false;
  try { reportExists = fs.statSync(wsettled !== '' ? wsettled : report).size > 0; } catch { reportExists = false; }
  let approvals = 0;
  try {
    const v = Number(fs.readFileSync(path.join(sd, 'wait', `${agent}.approvals`), 'utf8').trim());
    approvals = Number.isFinite(v) ? v : 0;
  } catch { approvals = 0; }
  const out = {
    wait_status: status,
    agent, role, kind, composed_prompt: composed, report,
  };
  // settled_report: the report the internal wait settled on when an
  // amendment re-pointed last-report-<agent> mid-wait (D39). It sits
  // right after `report`, before report_exists (which then qualifies it);
  // absent when the wait followed the dispatch's own report.
  if (wsettled !== '') out.settled_report = wsettled;
  out.report_exists = reportExists;
  // amend: true marks this JSON as the one of an amendment (not a fresh
  // brief). It sits right after report_exists because it qualifies the
  // report named by `report` — the new one the wait now watches.
  if (amend === 1) out.amend = true;
  // dialog: the screen the agent is sitting on (the blocked wait line's
  // field). It sits right after report_exists (and amend, when present),
  // before the review header fields, mirroring the wait line.
  if (wdialog !== undefined) out.dialog = wdialog;
  // The review header fields sit right after report_exists (and amend,
  // when present), before partial: only when the done wait line carried
  // them.
  if (wverdict !== '') out.verdict = wverdict;
  if (wfindings !== undefined) out.findings = wfindings;
  if (wseverity !== undefined) out.severity = wseverity;
  // partial: N sits right after report_exists (and amend, when present):
  // it qualifies the same report. The warn already came from waitFor.
  if (wpartial > 0) out.partial = wpartial;
  out.auto_approved = approvals;
  if (status === 'question') out.question = qtext;
  if (enterSent) out.enter_sent = true;
  if (resent) out.resent = true;
  if (status === 'quota') Object.assign(out, { lane: qlane, model: qmodel, match: qmatch, renewal: qrenew });
  if (status === 'provider-error' || status === 'capacity') {
    Object.assign(out, { lane: qlane, model: qmodel, cause: pcause });
    if (status === 'capacity') out.retries = preties;
  }
  // One line, wait_status first: `dispatch … | tail -1` returns the whole
  // JSON and a filter on any field keeps the status.
  process.stdout.write(JSON.stringify(out) + '\n');

  switch (status) {
    case 'question':
      // waitFor already warned; the JSON line carries the question text.
      return 7;
    case 'blocked':
      warn(`agent '${agent}' is blocked on an approval or question; run: herdr agent read ${agent} --source recent-unwrapped --lines 80`);
      return 7;
    case 'timeout':
      warn(`timeout waiting for the report of '${agent}'; it may still be working. Run: herdr-agents wait ${agent}`);
      return 9;
    case 'settled-no-report':
      warn(`agent '${agent}' settled without writing ${report}; collect will fall back to terminal output`);
      return 6;
    case 'gone':
      warn(`agent '${agent}' is no longer live`);
      return 6;
    case 'unavailable':
      warn(`agent '${agent}': herdr agent get failed${qerr !== '' ? `: ${qerr}` : ''}. The worker may still be live; do not spawn a replacement.`);
      return 4;
    case 'quota':
      warn(`agent '${agent}' hit a quota limit${qmatch !== '' ? `: ${qmatch}` : ''}. Ask the user: switch the lane kind/model, wait for renewal, take the slice, or pause.`);
      return 11;
    case 'provider-error':
      warn(`agent '${agent}' stopped on a provider error: ${pcause}. It is idle without a report; ask the user whether to resend the brief, switch the assistant, or wait.`);
      return 14;
    case 'capacity':
      warn(`agent '${agent}' is still at provider capacity after ${preties} continue(s): ${pcause}. Ask the user whether to wait and resend, switch the assistant, or pause.`);
      return 14;
    default:
      // done (or the no-wait `submitted`): waitFor's own rank code, 0 here.
      return wrc === 0 ? 0 : wrc;
  }
}
