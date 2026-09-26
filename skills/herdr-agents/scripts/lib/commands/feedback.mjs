// `herdr-agents feedback send <report.md> "<one-line summary>"` — the
// feedback=local delivery: instead of filing an issue in feedback_repo the
// orchestrator's friction report becomes a file in feedback_dir (the local
// maintainer's directory), plus a one-line notice to feedback_to (a pane or
// an agent) when that key is set.
//
// The file lands as <feedback_dir>/from-<project>-<YYYY-MM-DD>.md, with
// <project> the project folder name (projectRoot) and any character outside
// [A-Za-z0-9._-] replaced by -, the date local. When a file of the day
// already exists the next free letter is used before the .md
// (from-app-2026-09-25-b.md, -c, …); the write uses the `wx` flag so an
// existing file is never overwritten.
//
// With feedback_to set the notice goes through agentPrompt (lib/herdr.mjs):
// `herdr-agents feedback from <project> (<workspace>): <summary> —
// <dest>`, with <workspace> from workspaceId. \r, \n and \t in the summary
// are turned into spaces, so the prompt is always one line.
//
// Output is one JSON line: {"status":"sent","file":…,"notified":…} on
// success (exit 0, notified null without feedback_to) and
// {"status":"filed","file":…,"notified":null,"error":<raw>} when the notice
// fails (exit 4: the file stays, one warn in the friction log). A
// successful send records a note line `feedback sent: <dest>` in the
// friction log (the friction add format, command column feedback). Every
// precondition dies 2 (policy not local, feedback_dir empty or not a
// directory, report missing or empty, summary empty).
import fs from 'node:fs';
import path from 'node:path';
import { cfg, DieError } from '../config.mjs';
import { agentPrompt } from '../herdr.mjs';
import { projectRoot } from '../platform.mjs';
import { frictionSafe, nowIso, stateDir, warn, workspaceId } from '../state.mjs';

export function cmdFeedback(argv, ctx, env = process.env, cwd = process.cwd()) {
  const rest = argv ?? [];
  let sub = '';
  const words = [];
  for (const a of rest) {
    const t = String(a);
    if (t.startsWith('--')) throw new DieError(`feedback: unknown option ${t}`, 2);
    else if (sub === '' && words.length === 0) sub = t;
    else words.push(t);
  }
  if (sub !== 'send') throw new DieError(`feedback: unknown subcommand '${sub}'`, 2);
  if (words.length !== 2) throw new DieError('usage: feedback send <report.md> "<one-line summary>"', 2);
  const [report, rawSummary] = words;
  if (rawSummary === '') throw new DieError('feedback send: the one-line summary is required', 2);
  // One line only: \r, \n and \t become spaces (the prompt and the JSON
  // line must not open a second line).
  const summary = rawSummary.replace(/[\r\n\t]+/g, ' ');
  const feedback = cfg(ctx, 'feedback', 'ask', env);
  if (feedback !== 'local') {
    throw new DieError(`feedback send: feedback=${feedback}, not local; file an issue instead (see "Improving this skill")`, 2);
  }
  const dir = cfg(ctx, 'feedback_dir', '', env);
  // Absolute only: a relative value would point somewhere else from each
  // working directory (the doctor applies the same rule).
  let dirIsDir = false;
  if (dir !== '' && path.isAbsolute(dir)) { try { dirIsDir = fs.statSync(dir).isDirectory(); } catch { dirIsDir = false; } }
  if (!dirIsDir) {
    throw new DieError('feedback send: feedback_dir is empty, relative or not a directory; set feedback_dir to the maintainer\'s directory (absolute path)', 2);
  }
  let reportIsFile = false;
  try { reportIsFile = fs.statSync(report).isFile() && fs.statSync(report).size > 0; } catch { reportIsFile = false; }
  if (!reportIsFile) throw new DieError(`feedback send: the report must be a non-empty file: ${report}`, 2);

  // <feedback_dir>/from-<project>-<YYYY-MM-DD>.md, local date; a taken
  // name takes -b, -c, … (the letter of the attempt, 'a' = no suffix),
  // and the wx flag keeps the write from ever overwriting.
  const project = path.basename(projectRoot(env, cwd)).replace(/[^A-Za-z0-9._-]/g, '-');
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const base = `from-${project}-${date}`;
  const content = fs.readFileSync(report, 'utf8');
  let dest = '';
  for (let n = 97; n <= 122; n += 1) { // 'a'..='z': 'a' is the unsuffixed name
    dest = n === 97 ? path.join(dir, `${base}.md`) : path.join(dir, `${base}-${String.fromCharCode(n)}.md`);
    try {
      fs.writeFileSync(dest, content, { flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST' || n === 122) {
        throw new DieError(`feedback send: could not write ${dest} (${e.code ?? e.message})`, 4);
      }
    }
  }

  const to = cfg(ctx, 'feedback_to', '', env);
  if (to !== '') {
    const text = `herdr-agents feedback from ${project} (${workspaceId(ctx, env, cwd)}): ${summary} — ${dest}`;
    const r = agentPrompt(to, text, env);
    if (!r.ok) {
      // The file stays; the send was filed, the notice failed.
      warn(`feedback send: the notice to ${to} failed: ${r.raw}`);
      process.stdout.write(`${JSON.stringify({ status: 'filed', file: dest, notified: null, error: r.raw })}\n`);
      return 4;
    }
  }
  const logPath = path.join(stateDir(ctx, env, cwd), 'friction.log');
  fs.appendFileSync(logPath, `${nowIso()}\tnote\tfeedback\t${frictionSafe(`feedback sent: ${dest}`)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ status: 'sent', file: dest, notified: to !== '' ? to : null })}\n`);
  return 0;
}
