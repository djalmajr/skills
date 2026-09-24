#!/usr/bin/env node
// herdr-agents — JavaScript command entry.
//
// Dispatches every command of the bash script: `config [set <key> <value>
// [--project|--user]]`, `session [set <key> <value> | clear [key] | show]`,
// `roles`, `role <name>`, `kinds`, `models <kind>`, `model <kind> <spec>
// [effort]`, `spawn <role> …`, `dispatch <agent> <brief.md> …`,
// `run <role> <brief.md> …`, `status <agent>…`, `roster`, `friction`,
// `tab-label`, `layout-plan`, `wait <agent>…`, `collect <agent>`,
// `release <agent>`, `clean`, `doctor [--fix] [--panes 3|4] [--user]`,
// `explain`, `init`, `setup [--target FILE] [--no-hooks]
// [--dry-run] [--panes 3|4] [--lane name=kind[:model[:effort]]]` — its
// `--probe [--kind K --model M --timeout S]` form runs the per-kind
// probes, exclusive with `--plan` — plus `env` (the environment block for
// a feedback issue) and the help (`help`, `-h`, `--help`, or no command:
// the constant usage text of lib/usage.mjs, exit 0, no Herdr needed).
// An unknown command dies 2 like bash `main`'s `*` arm. Load the config
// layers before dispatching, like bash `main`. The living commands need
// the Herdr environment (`require_env`) and log their warnings/errors to
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
import { cmdEnv } from './lib/commands/env.mjs';
import { printUsage } from './lib/usage.mjs';
import { cmdLayoutPlan } from './lib/layout.mjs';
import { cmdRegrid } from './lib/regrid.mjs';
import { cmdTabLabel } from './lib/herdtabs.mjs';
import { cmdSpawn } from './lib/spawn.mjs';
import { cmdWait } from './lib/wait.mjs';
import { cmdDispatch } from './lib/dispatch.mjs';
import { cmdRun } from './lib/commands/run.mjs';
import { cmdCollect } from './lib/commands/collect.mjs';
import { cmdRelease } from './lib/commands/release.mjs';
import { cmdClean } from './lib/commands/clean.mjs';
import { cmdSetup } from './lib/commands/setup.mjs';
import { cmdDoctor } from './lib/commands/doctor.mjs';
import { cmdExplain } from './lib/commands/explain.mjs';
import { cmdInit } from './lib/commands/init.mjs';
import { die, findExecutable } from './lib/platform.mjs';

// The commands that log to friction when running inside Herdr (bash main's
// living-command list).
const LIVING = new Set(['spawn', 'dispatch', 'run', 'status', 'roster', 'friction', 'tab-label', 'regrid', 'wait', 'collect', 'release', 'clean', 'init']);

const argv = process.argv.slice(2);
const cmd = argv[0] ?? '';

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
    case 'doctor':
      cmdDoctor(argv.slice(1), ctx, env);
      break;
    case 'explain':
      cmdExplain(argv.slice(1), ctx, env);
      break;
    case 'init':
      cmdInit(ctx, env);
      break;
    case 'regrid':
      cmdRegrid(argv.slice(1), ctx, env);
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
    case 'env':
      cmdEnv(ctx, env);
      break;
    // bash main: `-h|--help|help|""` → usage, exit 0, no Herdr needed.
    case 'help':
    case '-h':
    case '--help':
    case '':
      printUsage();
      break;
    default:
      // bash main: `*) die "unknown command '$cmd'" 2`.
      die(`unknown command '${cmd}'`, 2);
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
