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
//   - the dispatch JSON keeps the bash `jq -n` key order (agent, role, kind,
//     composed_prompt, report, wait_status, report_exists, auto_approved,
//     and lane/model/match/renewal only on a quota, and lane/model/cause —
//     plus retries on a capacity — only on a provider-error/capacity);
//     `amend: true` sits right after report_exists on an amendment, and
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
import { agentPrompt, agentState, agentRead, agentSendKeys } from './herdr.mjs';
import { briefTask, paneTaskTitle } from './tasks.mjs';
import { jqPretty } from './herdtabs.mjs';
import { waitFor, pollIntervalMs, cksumField } from './wait.mjs';
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
// and all, as the bash message embeds it — or '' when the brief passes.
// Each check mirrors one `grep -qiE` (a line in the file must match).
// A read-only role (opts.readOnly) owns nothing, so the `Owned files`
// section is not asked of it; the other sections still hold.
export function briefMissingSections(brief, opts = {}) {
  let text;
  try { text = fs.readFileSync(brief, 'utf8'); } catch { text = ''; }
  const checks = [
    [/^#{1,3} +goal/im, 'Goal'],
    [/^#{1,3} +(expected result|acceptance|definition of done)/im, 'Expected result'],
    ...(opts.readOnly === true ? [] : [[/^#{1,3} +(owned files|owned|scope)/im, 'Owned files']]),
    [/^#{1,3} +(forbidden|non-goals|constraints)/im, 'Forbidden'],
    [/^#{1,3} +report/im, 'Report'],
    [/(commit|push)/i, "no-git line: say 'no commit/push'"],
  ];
  let missing = '';
  for (const [re, label] of checks) if (!re.test(text)) missing += ` [${label}]`;
  return missing;
}

// lint_brief <file>: brief_lint=warn|strict|off (default warn). strict dies
// 2 (with a friction entry for the living command); warn prints the warning
// and continues. `off` never checks. A read-only role (opts.readOnly) skips
// the `Owned files` check (see briefMissingSections).
export function lintBrief(brief, ctx, env = process.env, opts = {}) {
  const mode = cfg(ctx, 'brief_lint', 'warn', env);
  if (mode === 'off') return;
  const missing = briefMissingSections(brief, opts);
  if (missing === '') return;
  if (mode === 'strict') dieFriction(`brief ${brief} is missing sections:${missing} (brief_lint=strict)`, 2);
  warn(`brief ${brief} is missing sections:${missing} — workers without owned/forbidden files collide, without a report section never finish`);
}

// ---------- the composed prompt (:3930-3958) ----------
// The standing worker rules at the end of every composed prompt (the brief
// and the amendment): the same lines, never duplicated.
function standingRules() {
  return [
    `- Only you write this report, once all of the brief is done, including any part you handed to subagents or background tasks; a subagent never writes it. Report every item as it stands in the files, not as a subagent summarized it.\n`,
    `- Nobody watches this terminal: do not ask interactive questions or wait for a confirmation. When the brief does not decide something, follow its "When the brief does not decide" section, or mark the item partial and list the gap and the options under open questions.\n`,
    `- Never invent names, endpoints, flags, credentials, URLs or requirements.\n`,
    `- Do not commit, push, tag, or open pull requests.\n`,
    `- When finished, reply in the terminal with exactly the report path and nothing else.\n`,
  ].join('');
}

// The composed prompt file: `# Role: <name>`, the role line, the role body,
// `# Brief` with the brief verbatim (`cat` — no CRLF normalization), and
// `# Report contract` with the report path, the report language when
// `report_language` is set, the one-go rule, the `worker_context=lean` rule,
// and the standing worker rules (only the worker writes the report,
// nobody watches the terminal, never invent, no git, reply with the report
// path). Same lines, same order, as bash.
export function composePrompt(roleFile, role, agent, briefRaw, report, ctx, env = process.env) {
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
  out.push(standingRules());
  return out.join('');
}

// The amendment composed prompt: `# Amendment to your current brief`, the
// amendment verbatim (no CRLF normalization, as the brief), and `# Report
// contract` with the override line, the report path (with the one-report
// rule for a not-yet-written brief), the report language when
// `report_language` is set, the one-go rule and the standing worker rules.
// The worker already has the role and the current brief in context, so the
// amendment carries neither.
export function composeAmendment(amendRaw, report, ctx, env = process.env) {
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
  if (timeout === '') timeout = fmGet(rf, 'timeout');
  if (timeout === '') timeout = cfg(ctx, 'dispatch_timeout', '900000', env);

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
    ? composeAmendment(fs.readFileSync(brief, 'utf8'), report, ctx, env)
    : composePrompt(rf, role, agent, fs.readFileSync(brief, 'utf8'), report, ctx, env));
  fs.writeFileSync(path.join(sd, `last-report-${agent}`), `${report}\n`);
  for (const suf of ['size', 'screen', 'since', 'blocked', 'approvals', 'quota',
    'provider', 'provider-cause', 'capacity-retries', 'capacity-at',
    'question', 'stuck-hash', 'stuck-since', 'stuck-warned',
    'not-received', 'enter-retry']) {
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
    process.stdout.write(jqPretty({ agent, role, kind, composed_prompt: composed, report, wait_status: 'error', report_exists: false, raw: p.raw }));
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
      process.stdout.write(jqPretty({ agent, role, kind, composed_prompt: composed, report,
        wait_status: 'not-received', report_exists: reportNow }));
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
    // The done wait line carries `partial: N` when the report marks
    // item(s) partial; it lands in the final JSON (the warn already came
    // from the wait).
    if (last.status === 'done' && Number.isInteger(last.partial)) wpartial = last.partial;
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
  try { reportExists = fs.statSync(report).size > 0; } catch { reportExists = false; }
  let approvals = 0;
  try {
    const v = Number(fs.readFileSync(path.join(sd, 'wait', `${agent}.approvals`), 'utf8').trim());
    approvals = Number.isFinite(v) ? v : 0;
  } catch { approvals = 0; }
  const out = {
    agent, role, kind, composed_prompt: composed, report,
    wait_status: status, report_exists: reportExists,
  };
  // amend: true marks this JSON as the one of an amendment (not a fresh
  // brief). It sits right after report_exists because it qualifies the
  // report named by `report` — the new one the wait now watches.
  if (amend === 1) out.amend = true;
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
  process.stdout.write(jqPretty(out));

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
