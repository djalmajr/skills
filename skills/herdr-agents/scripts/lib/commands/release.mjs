// The `release` command (port slice 6a). Port of
// scripts/herdr-agents.sh :4051-4083: refuses to release an unqueryable
// worker without `--force` (rc 4), refuses `--close` on a still-working
// worker with a pending report (rc 3), closes only panes this skill
// created, clears the pane title when not closing, removes the roster row
// and the worker's last-report / task / wait files, then regrid (slice 8)
// or the herd-tab relabel, and reports leftover `.worktrees/` worktrees.
// The `${1:?agent}` parameter error is bash's builtin (exit 1, no
// friction entry), so it uses plain die, not dieFriction.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { die } from '../platform.mjs';
import { cfg } from '../config.mjs';
import {
  stateDir, rosterLine, rosterRemove, lastReport, lastReportPath, warn, dieFriction,
} from '../state.mjs';
import { agentState, paneClose } from '../herdr.mjs';
import { herdTabsRelabel } from '../herdtabs.mjs';
import { paneTaskTitle } from '../tasks.mjs';

// `--close` only when the report file exists and is non-empty
// (bash `[ -z "$r" ] || [ ! -s "$r" ]`).
function reportEmpty(r) {
  if (!r) return true;
  try { return fs.statSync(r).size === 0; } catch { return true; }
}

// `release <agent> [--close] [--force]` → rc 0 · 3 (not in roster /
// closing a working worker discards its work) · 4 (unqueryable without
// --force).
export function cmdRelease(argv, ctx, env = process.env, cwd = process.cwd()) {
  const agent = argv[0];
  if (agent === undefined) die('agent: Parameter not set', 1);
  let close = 0;
  let force = 0;
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--close') close = 1;
    else if (a === '--force') force = 1;
    else dieFriction(`release: unknown option ${a}`, 2);
  }
  const sd = stateDir(ctx, env, cwd);
  const line = rosterLine(sd, agent);
  if (line === '') dieFriction(`agent '${agent}' is not in the roster`, 3);
  const f = line.split('\t');
  const pane = f[1] ?? '';
  const created = f[5] ?? '';
  const wdir = f[6] ?? '';
  const r = lastReport(sd, agent);
  if (force !== 1 && reportEmpty(r)) {
    const st = agentState(agent, env);
    if (st.state === 'unavailable') {
      dieFriction(`agent '${agent}': herdr agent get failed (${st.cause}). Refusing to release; the worker may still be live. Retry when herdr answers, or pass --force.`, 4);
    }
    if (close === 1 && r !== '' && st.state === 'working') {
      dieFriction(`agent '${agent}' is still working and has not written ${r}; closing now discards its work. Run 'wait ${agent}' first, or release --close --force`, 3);
    }
  }
  if (close === 1) {
    if (created === '1') {
      // `herdr pane close … >/dev/null && printf 'closed pane …'`: a
      // failed close just skips the line (set -e does not fire inside the
      // && list).
      if (paneClose(pane, env)) process.stdout.write(`closed pane ${pane}\n`);
    } else {
      warn(`pane ${pane} was not created by this skill; not closing it`);
    }
  }
  if (close !== 1) paneTaskTitle(sd, agent, null, env);
  rosterRemove(sd, agent);
  fs.rmSync(lastReportPath(sd, agent), { force: true });
  fs.rmSync(path.join(sd, `task-${agent}`), { force: true });
  const waitDir = path.join(sd, 'wait');
  for (const w of fs.readdirSync(waitDir)) {
    if (w.startsWith(`${agent}.`)) fs.rmSync(path.join(waitDir, w), { force: true });
  }
  if (close === 1 && cfg(ctx, 'regrid', 'on', env) === 'on') {
    // slice 8: bash runs `(cmd_regrid) >/dev/null 2>&1 || warn "regrid
    // after release failed; panes left as they are (see friction)" here.
  } else {
    // `herd_tabs_relabel >/dev/null 2>&1 || warn …` — any failure (a
    // library DieError included) becomes the warning, as in bash.
    try {
      herdTabsRelabel(ctx, env, cwd);
    } catch {
      warn('relabel of the herd tabs failed (see friction)');
    }
  }
  const wt = spawnSync('git', ['-C', wdir, 'worktree', 'list'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const leftovers = (wt.stdout || '').split('\n').filter((l) => l.includes('/.worktrees/'));
  if (leftovers.length > 0) {
    process.stdout.write('leftover worktrees (not removed):\n');
    for (const l of leftovers) process.stdout.write(`${l}\n`);
  }
  process.stdout.write(`released ${agent}\n`);
}
