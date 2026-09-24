// The `friction` command (moved out of lib/state.mjs in slice 4).
// Port of scripts/herdr-agents.sh :4151-4157.
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../state.mjs';
import { readTextFile } from '../platform.mjs';

export function cmdFriction(ctx, env = process.env, cwd = process.cwd()) {
  const f = path.join(stateDir(ctx, env, cwd), 'friction.log');
  let st = null;
  try { st = fs.statSync(f); } catch { /* absent */ }
  if (!st || st.size === 0) {
    process.stdout.write(`no friction recorded under ${f}\n`);
    return 0;
  }
  process.stdout.write(`friction log (${f}): timestamp, level, command, message\n`);
  process.stdout.write(readTextFile(f));
  return 0;
}
