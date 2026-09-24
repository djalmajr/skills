#!/usr/bin/env node
// herdr-agents — JavaScript entry (slices 1-7b of the bash port).
//
// Dispatches the ported commands (`config`, `config set`, `session`,
// `roles`, `role`, `kinds`, `models <kind>`, `model <kind> <spec>
// [effort]`, `spawn <role> …`, `dispatch <agent> <brief.md> …`,
// `run <role> <brief.md> …`, `status <agent>…`, `roster`, `friction`,
// `tab-label`, `layout-plan`, `wait <agent>…`, `collect <agent>`,
// `release <agent>`, `clean`, `setup [--target FILE] [--no-hooks]
// [--dry-run] [--panes 3|4] [--lane name=kind[:model[:effort]]] [--detect]`
// — its `--plan`/`--probe` forms are not ported yet and exit 2).
// Any other command is reported as not
// ported yet (exit 2) so the bash script remains the source of truth for
// the rest until the later slices land. Load the config layers before
// dispatching, like bash `main`. The living commands need the Herdr
// environment (`require_env`) and log their warnings/errors to
// <state>/friction.log, like bash `main` (layout-plan is not living, and
// requires the Herdr environment only in live mode). Decision 6:
// DieError with a message → die (friction for living commands); empty
// message → exit with the code only (bash passes herdr's own output
// through and exits with herdr's code).
import path from 'node:path';
import { loadConfig, cmdConfig, cmdConfigSet, DieError } from './lib/config.mjs';
import { cmdSession } from './lib/session.mjs';
import { cmdRoles, cmdRole } from './lib/roles.mjs';
import { cmdKinds } from './lib/kinds.mjs';
import { cmdModels, cmdModel } from './lib/models.mjs';
import { requireEnv } from './lib/herdr.mjs';
import { dieFriction, setFrictionLog, stateDir } from './lib/state.mjs';
import { cmdStatus } from './lib/commands/status.mjs';
import { cmdRoster } from './lib/commands/roster.mjs';
import { cmdFriction } from './lib/commands/friction.mjs';
import { cmdLayoutPlan } from './lib/layout.mjs';
import { cmdTabLabel } from './lib/herdtabs.mjs';
import { cmdSpawn } from './lib/spawn.mjs';
import { cmdWait } from './lib/wait.mjs';
import { cmdCollect } from './lib/commands/collect.mjs';
import { cmdRelease } from './lib/commands/release.mjs';
import { cmdClean } from './lib/commands/clean.mjs';
import { cmdDispatch } from './lib/dispatch.mjs';
import { cmdRun } from './lib/commands/run.mjs';
import { cmdSetup } from './lib/commands/setup.mjs';
import { findExecutable } from './lib/platform.mjs';

const PORTED = ['config', 'session', 'roles', 'role', 'kinds', 'models', 'model', 'spawn', 'dispatch', 'run', 'status', 'roster', 'friction', 'tab-label', 'layout-plan', 'wait', 'collect', 'release', 'clean', 'setup'];
// The commands that log to friction when running inside Herdr (bash main's
// living-command list, restricted to what this entry has ported).
const LIVING = new Set(['spawn', 'dispatch', 'run', 'status', 'roster', 'friction', 'tab-label', 'wait', 'collect', 'release', 'clean']);

const argv = process.argv.slice(2);
const cmd = argv[0] ?? '';

if (!PORTED.includes(cmd)) {
  process.stderr.write(`herdr-agents.mjs: '${cmd}' is not ported yet; use scripts/herdr-agents.sh\n`);
  process.exit(2);
}

const env = process.env;
const ctx = loadConfig();

try {
  if (LIVING.has(cmd)) {
    requireEnv(env);
    // FRICTION_LOG=<state>/friction.log when HERDR_ENV=1 and herdr is on
    // PATH (the jq requirement is gone, orchestrator decision 5).
    if (findExecutable('herdr', env)) {
      setFrictionLog(path.join(stateDir(ctx, env), 'friction.log'), cmd);
    }
  }

  switch (cmd) {
    case 'config':
      if (argv[1] === 'set') cmdConfigSet(argv.slice(2), ctx);
      else cmdConfig(ctx);
      break;
    case 'session':
      cmdSession(argv.slice(1), ctx);
      break;
    case 'roles':
      cmdRoles();
      break;
    case 'role':
      cmdRole(argv.slice(1));
      break;
    case 'kinds':
      cmdKinds();
      break;
    case 'models':
      cmdModels(argv.slice(1));
      break;
    case 'model':
      cmdModel(argv.slice(1));
      break;
    case 'spawn':
      cmdSpawn(argv.slice(1), ctx, env);
      break;
    case 'dispatch': {
      const rc = cmdDispatch(argv.slice(1), ctx, env);
      if (rc) process.exitCode = rc;
      break;
    }
    case 'run': {
      const rc = cmdRun(argv.slice(1), ctx, env);
      if (rc) process.exitCode = rc;
      break;
    }
    case 'status': {
      const rc = cmdStatus(argv.slice(1), ctx, env);
      if (rc) process.exitCode = rc;
      break;
    }
    case 'wait': {
      const rc = cmdWait(argv.slice(1), ctx, env);
      if (rc) process.exitCode = rc;
      break;
    }
    case 'collect': {
      const rc = cmdCollect(argv.slice(1), ctx, env);
      if (rc) process.exitCode = rc;
      break;
    }
    case 'release':
      cmdRelease(argv.slice(1), ctx, env);
      break;
    case 'clean':
      cmdClean(argv.slice(1), ctx, env);
      break;
    case 'setup':
      cmdSetup(argv.slice(1), ctx, env);
      break;
    case 'roster':
      cmdRoster(ctx, env);
      break;
    case 'friction':
      cmdFriction(ctx, env);
      break;
    case 'tab-label':
      requireEnv(env);
      cmdTabLabel(argv.slice(1), ctx, env);
      break;
    case 'layout-plan':
      cmdLayoutPlan(argv.slice(1), ctx, env);
      break;
  }
} catch (e) {
  // Decision 6: DieError with a message dies like bash `die` (friction is
  // logged by the living commands); an empty message only exits with the
  // code — bash passed herdr's own output through already.
  if (e instanceof DieError) {
    if (e.message !== '') dieFriction(e.message, e.code);
    process.exit(e.code ?? 1);
  }
  throw e;
}
