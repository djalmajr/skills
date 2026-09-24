// The `init` command (slice 8b of the bash port): prints `doctor` on
// stderr and the JSON context on stdout —
// {orchestrator,pane_id,tab_id,workspace_id,layout,state_dir,first_run,title}
// — after ensuring the caller's agent is named after `orchestrator_name`
// (renamed via `herdr agent rename` when needed; idempotent). Port of
// the original bash implementation :2735-2744 (cmd_init). A living command: the
// entry applies require_env and the friction log. Reuses the ports of the
// earlier slices: ensureOrchestratorName (spawn.mjs), workspaceId /
// stateDir (state.mjs), cmdDoctor / projectIsFirstRun (doctor.mjs) and
// cfg (config.mjs).
//
// The `title` key is the caller
// pane's title in force after the init. The pane's current title is read
// with `herdr pane get <HERDR_PANE_ID>`; when `.result.pane.title` is
// absent, null or empty, `orchestrator: <basename of the project root>`
// is stored via paneTitle. An existing title is never touched. A `pane
// get` or `report-metadata` failure never fails the init — it warns
// (friction) and the key is `""` (the title could not be read).
import path from 'node:path';
import { cfg } from '../config.mjs';
import { ensureOrchestratorName } from '../spawn.mjs';
import { stateDir, workspaceId, warn } from '../state.mjs';
import { HERDR_TIMEOUT_MS, paneTitle } from '../herdr.mjs';
import { runCli, projectRoot } from '../platform.mjs';
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
  // Read the caller pane's current title; when absent, null or empty,
  // store `orchestrator: <basename of the project root>`. Best effort: a
  // failure only warns (friction) and the JSON key stays "".
  const pane = env.HERDR_PANE_ID ?? '';
  let title = '';
  if (pane !== '') {
    const r = runCli('herdr', ['pane', 'get', pane], { env, timeoutMs: HERDR_TIMEOUT_MS });
    let out = null;
    try { out = JSON.parse(r.stdout ?? ''); } catch { out = null; }
    const t = out && typeof out === 'object' ? out?.result?.pane?.title : undefined;
    // jq `// empty` semantics: absent / null / false read as ''.
    const existing = t === undefined || t === null || t === false ? '' : String(t);
    if (r.notFound || r.status !== 0) {
      warn('init: herdr pane get failed; pane title left as is');
    } else if (existing !== '') {
      title = existing; // an existing title is never touched
    } else {
      const fresh = `orchestrator: ${path.basename(projectRoot(env, cwd))}`;
      if (paneTitle(pane, fresh, env)) title = fresh;
      else warn('init: herdr pane report-metadata failed; pane title left as is');
    }
  }
  const first = projectIsFirstRun(ctx, env, cwd);
  const state = stateDir(ctx, env, cwd);
  const layout = cfg(ctx, 'layout', 'split', env);
  process.stdout.write(`${JSON.stringify({
    orchestrator: name ?? '',
    pane_id: pane,
    tab_id: env.HERDR_TAB_ID ?? '',
    workspace_id: workspaceId(ctx, env, cwd),
    layout,
    state_dir: state,
    first_run: first,
    title,
  }, null, 2)}\n`);
}
