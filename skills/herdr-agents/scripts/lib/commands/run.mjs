// The `run` command (port slice 6b). Port of scripts/herdr-agents.sh
// :4103-4119 (cmd_run): chains `spawn` → `dispatch` → `collect`. Spawn runs
// in a child process, like the bash command substitution `spawned="$(cmd_spawn
// …)"`: its stdout is captured (printed once, unchanged) and a failing spawn
// stops the run with the same code (`set -e` on the assignment). Dispatch and
// collect failure returns do NOT stop the run (the bash `|| true`); a `die`
// exits the whole run in both implementations.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DieError } from '../config.mjs';
import { dieFriction } from '../state.mjs';
import { cmdDispatch } from '../dispatch.mjs';
import { cmdCollect } from './collect.mjs';

// The entry this process runs (herdr-agents.mjs, two levels up from
// scripts/lib/commands).
const JS_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'herdr-agents.mjs');

// The flag split of cmd_run: spawn flags keep their values; --timeout,
// --allow-same-family and --no-wait go to dispatch; -- ends the parse and
// everything after it is a spawn native argument.
export function splitRunArgs(argv) {
  const spawnArgs = [];
  const dispatchArgs = [];
  let noWait = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') {
      spawnArgs.push('--', ...argv.slice(i + 1));
      break;
    }
    if (a === '--name' || a === '--kind' || a === '--direction' || a === '--ratio'
      || a === '--cwd' || a === '--pane' || a === '--effort' || a === '--model'
      || a === '--approvals' || a === '--tab-label') {
      // A value flag without its value is a usage error before any spawn
      // (bash dies on the unbound variable; spec 1.2: exit 2).
      if (argv[i + 1] === undefined) dieFriction(`run: ${a} expects a value`, 2);
      spawnArgs.push(a, argv[i + 1]);
      i += 1;
    } else if (a === '--reuse' || a === '--fresh') {
      spawnArgs.push(a);
    } else if (a === '--timeout') {
      if (argv[i + 1] === undefined) dieFriction('run: --timeout expects a value', 2);
      dispatchArgs.push(a, argv[i + 1]);
      i += 1;
    } else if (a === '--allow-same-family') {
      dispatchArgs.push(a);
    } else if (a === '--no-wait') {
      noWait = 1;
      dispatchArgs.push(a);
    } else if (a.startsWith('--')) {
      dieFriction(`run: unknown option ${a}`, 2);
    } else {
      // Bash lumps a stray positional into the same `*` branch.
      dieFriction(`run: unknown option ${a}`, 2);
    }
  }
  return { spawnArgs, dispatchArgs, noWait };
}

// `run <role> <brief.md> [spawn/dispatch flags]` → rc 0 (the bash script
// always ends 0 unless a `die` kills it or the spawn child fails). The
// positional-argument errors are bash builtins (exit 1, no friction).
export function cmdRun(argv, ctx, env = process.env, cwd = process.cwd()) {
  const role = argv[0];
  const brief = argv[1];
  if (role === undefined || role === '') {
    process.stderr.write('herdr-agents.mjs: 1: role\n');
    process.exit(1);
  }
  if (brief === undefined || brief === '') {
    process.stderr.write('herdr-agents.mjs: 2: brief.md\n');
    process.exit(1);
  }
  const { spawnArgs, dispatchArgs, noWait } = splitRunArgs(argv.slice(2));

  // Spawn in a child: the captured stdout is the spawn JSON (printed once,
  // trailing newlines normalized to one, as `printf '%s\n' "$spawned"`); a
  // failing child stops the run with its code (its stderr is inherited, so
  // the spawn warnings stream to the terminal, as in bash; the captured
  // stdout of a failing spawn is discarded, as the bash assignment is).
  const r = spawnSync(process.execPath, [JS_ENTRY, 'spawn', role, ...spawnArgs], {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const spawned = r.stdout ?? '';
  if (r.status !== 0) process.exit(r.status === null ? 1 : r.status);
  let name;
  try { name = JSON.parse(spawned).name; } catch { name = undefined; }
  if (name === undefined || name === null) name = 'null'; // `jq -r .name`
  process.stdout.write(`${spawned.replace(/\n+$/, '')}\n`);

  // `|| true`: the wait status codes (4/6/7/9/11) never stop the run —
  // collect still runs below. A DieError (usage, family, transport) dies
  // like bash `die`, logged under `run` (bash CURRENT_CMD stays `run`
  // inside the function).
  try {
    cmdDispatch([name, brief, ...dispatchArgs], ctx, env, cwd);
  } catch (e) {
    if (e instanceof DieError) dieFriction(e.message, e.code);
    throw e;
  }

  // Collect: `|| true` (skipped with --no-wait). Its rc 4/6 are swallowed.
  if (noWait !== 1) {
    try {
      cmdCollect([name], ctx, env, cwd);
    } catch (e) {
      if (e instanceof DieError) dieFriction(e.message, e.code);
      throw e;
    }
  }
  return 0;
}
