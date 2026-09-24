// Pane task titles (port slice 6a): the task a brief names (brief_task),
// display-only pane title (pane_task_title) and the one-shot check
// mark (mark_task_done). Port of the original bash implementation :3695-3729. The
// pane id goes before the options (herdr 0.9.1 rejects `--source` first) —
// paneTitle in herdr.mjs already encodes that. A herdr without
// report-metadata (or any failure) changes nothing and never throws.
import path from 'node:path';
import { readTextFile, atomicWrite } from './platform.mjs';
import { rosterLine } from './state.mjs';
import { paneTitle } from './herdr.mjs';

// The first line of the brief that carries any text (awk 'NF{print; exit}'),
// CR-stripped (tr -d '\r'); '' when the file is absent or blank.
function firstTextLine(file) {
  let raw;
  try { raw = readTextFile(file); } catch { return ''; }
  for (const line of raw.split('\n')) {
    if (line.trim() !== '') return line;
  }
  return '';
}

// brief_task <brief> (:3695) → the task the brief names: its first H1
// line (not a contract section such as `# Goal`), without a leading
// `Brief —` / `Brief:` / `Brief -`; else the file name without .md.
export function briefTask(file) {
  let h = firstTextLine(file).replace(/\r/g, '');
  h = h.startsWith('# ') ? h.slice(2) : '';
  // Contract sections never name a task (case-insensitive, as `grep -qiE`).
  if (/^(goal|owned files|owned|scope|forbidden|non-goals|constraints|report|expected result|acceptance criteria|acceptance|decisions already made|context|sources)[ \t]*$/i.test(h)) h = '';
  // `sed -E 's/^Brief[[:space:]]*(—|:|-)[[:space:]]*//'` (first match only).
  h = h.replace(/^Brief[ \t]*(—|:|-)[ \t]*/, '');
  if (h === '') h = path.basename(file, '.md');
  return h;
}

// pane_task_title <agent> <title>|null (:3709) — a display-only title on
// the agent's pane (null clears it). Best effort: no roster row or no pane
// id is a no-op, a herdr without report-metadata changes nothing.
export function paneTaskTitle(sd, agent, title, env = process.env) {
  const line = rosterLine(sd, agent);
  if (line === '') return;
  const pane = line.split('\t')[1] ?? '';
  if (pane === '') return;
  paneTitle(pane, title === null ? null : title, env);
}

// mark_task_done <agent> (:3721) — adds a check mark to the pane title
// once the report exists (once per dispatch, via the `task-<agent>` file
// that `dispatch` writes). No task file: a dispatch without a title
// (or a pre-title dispatch), nothing to mark.
export function markTaskDone(sd, agent, env = process.env) {
  const f = path.join(sd, `task-${agent}`);
  let t;
  try { t = readTextFile(f); } catch { return; }
  t = t.replace(/\n+$/, '');
  if (t.endsWith(' ✓')) return;
  atomicWrite(f, `${t} ✓\n`);
  paneTaskTitle(sd, agent, `${t} ✓`, env);
}
