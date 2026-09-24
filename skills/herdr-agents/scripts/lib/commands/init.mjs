// The `init` command (slice 8b of the bash port): prints `doctor` on
// stderr and the JSON context on stdout —
// {orchestrator,pane_id,tab_id,workspace_id,layout,state_dir,first_run} —
// after ensuring the caller's agent is named after `orchestrator_name`
// (renamed via `herdr agent rename` when needed; idempotent). Port of
// scripts/herdr-agents.sh :2735-2744 (cmd_init). A living command: the
// entry applies require_env and the friction log. Reuses the ports of the
// earlier slices: ensureOrchestratorName (spawn.mjs), workspaceId /
// stateDir (state.mjs), cmdDoctor / projectIsFirstRun (doctor.mjs) and
// cfg (config.mjs).
import { cfg } from '../config.mjs';
import { ensureOrchestratorName } from '../spawn.mjs';
import { stateDir, workspaceId } from '../state.mjs';
import { cmdDoctor, projectIsFirstRun } from './doctor.mjs';

export function cmdInit(ctx, env = process.env, cwd = process.cwd()) {
  // bash: cmd_doctor >&2 — the doctor report goes to stderr; the JSON is
  // the only stdout. doctor is advisory and never dies here; the
  // redirection is restored in the finally, like autoRegrid (regrid.mjs)
  // silences the automatic regrid. doctor.mjs itself is untouched (slice
  // 7d still owns it).
  const stdoutWrite = process.stdout.write;
  try {
    process.stdout.write = (chunk, ...rest) => process.stderr.write(chunk, ...rest);
    cmdDoctor([], ctx, env, cwd);
  } finally {
    process.stdout.write = stdoutWrite;
  }
  const name = ensureOrchestratorName(ctx, env);
  const first = projectIsFirstRun(ctx, env, cwd);
  const state = stateDir(ctx, env, cwd);
  const layout = cfg(ctx, 'layout', 'split', env);
  process.stdout.write(`${JSON.stringify({
    orchestrator: name ?? '',
    pane_id: env.HERDR_PANE_ID ?? '',
    tab_id: env.HERDR_TAB_ID ?? '',
    workspace_id: workspaceId(ctx, env, cwd),
    layout,
    state_dir: state,
    first_run: first,
  }, null, 2)}\n`);
}
