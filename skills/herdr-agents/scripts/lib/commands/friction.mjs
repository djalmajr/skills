// `herdr-agents friction` and `herdr-agents friction add "<text>"
// [--brief <path>]`.
//
// `friction` (no argument) prints the whole friction log of the current
// workspace.
//
// `friction add` records one friction line at level `note` with the
// command `friction` (like the warn()/die() entries of the living
// commands) when the orchestrator observes a friction the tools do not
// log themselves. When --brief is given the message ends with
// ` (brief: <path>)`. Prints `recorded` and exits 0.
//
// Both read/write <state>/friction.log and every written line keeps the
// four TSV columns (date, level, command, message): \r, \n and \t are
// sanitized out of the message (and the brief path) before writing, or a
// single entry would open lines missing columns.
import fs from 'node:fs';
import path from 'node:path';
import { readTextFile } from '../platform.mjs';
import { DieError } from '../config.mjs';
import { stateDir, nowIso, frictionSafe } from '../state.mjs';

export function cmdFriction(argv, ctx, env = process.env, cwd = process.cwd()) {
  const rest = argv ?? [];
  let sub = '';
  let brief = '';
  const words = [];
  for (let i = 0; i < rest.length; i += 1) {
    const a = String(rest[i]);
    if (a === '--brief') {
      const v = rest[i + 1];
      if (v === undefined || String(v).startsWith('--')) throw new DieError('friction add: --brief expects a path', 2);
      brief = String(v);
      i += 1;
    } else if (a.startsWith('--')) {
      throw new DieError(`friction: unknown option ${a}`, 2);
    } else if (sub === '' && words.length === 0) {
      sub = a;
    } else {
      words.push(a);
    }
  }
  if (sub === '') {
    // The no-argument `friction` keeps its exact output: the header line
    // (and the raw log) when there is anything, the "no friction" line
    // when the log is absent or empty.
    const logPath = path.join(stateDir(ctx, env, cwd), 'friction.log');
    let st = null;
    try { st = fs.statSync(logPath); } catch { /* absent */ }
    if (!st || st.size === 0) {
      process.stdout.write(`no friction recorded under ${logPath}\n`);
      return;
    }
    process.stdout.write(`friction log (${logPath}): timestamp, level, command, message\n`);
    process.stdout.write(readTextFile(logPath));
    return;
  }
  if (sub !== 'add') throw new DieError(`friction: unknown subcommand '${sub}'`, 2);
  const text = words.join(' ');
  if (text === '') throw new DieError('friction add: give the text to record', 2);
  const message = brief !== '' ? `${text} (brief: ${brief})` : text;
  const logPath = path.join(stateDir(ctx, env, cwd), 'friction.log');
  fs.appendFileSync(logPath, `${nowIso()}\tnote\tfriction\t${frictionSafe(message)}\n`, { mode: 0o600 });
  process.stdout.write('recorded\n');
}
