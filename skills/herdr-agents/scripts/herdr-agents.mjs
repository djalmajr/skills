#!/usr/bin/env node
// herdr-agents — JavaScript entry (slices 1-3 of the bash port).
//
// Dispatches the ported commands (`config`, `config set`, `session`,
// `roles`, `role`, `kinds`, `models <kind>`, `model <kind> <spec>
// [effort]`, `status <agent>…`, `roster`, `friction`). Any other command
// is reported as not ported yet (exit 2) so the bash script remains the
// source of truth for the rest until the later slices land. Load the
// config layers before dispatching, like bash `main`. The living
// commands need the Herdr environment (`require_env`) and log their
// warnings/errors to <state>/friction.log, like bash `main`.
import path from 'node:path';
import { loadConfig, cmdConfig, cmdConfigSet } from './lib/config.mjs';
import { cmdSession } from './lib/session.mjs';
import { cmdRoles, cmdRole } from './lib/roles.mjs';
import { cmdKinds } from './lib/kinds.mjs';
import { cmdModels, cmdModel } from './lib/models.mjs';
import { requireEnv } from './lib/herdr.mjs';
import { cmdStatus, cmdRoster, cmdFriction, setFrictionLog, stateDir } from './lib/state.mjs';
import { findExecutable } from './lib/platform.mjs';

const PORTED = ['config', 'session', 'roles', 'role', 'kinds', 'models', 'model', 'status', 'roster', 'friction'];
// The commands that log to friction when running inside Herdr (bash main's
// living-command list, restricted to what this entry has ported).
const LIVING = new Set(['status', 'roster', 'friction']);

const argv = process.argv.slice(2);
const cmd = argv[0] ?? '';

if (!PORTED.includes(cmd)) {
  process.stderr.write(`herdr-agents.mjs: '${cmd}' is not ported yet; use scripts/herdr-agents.sh\n`);
  process.exit(2);
}

const env = process.env;
const ctx = loadConfig();

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
  case 'status': {
    const rc = cmdStatus(argv.slice(1), ctx, env);
    if (rc) process.exitCode = rc;
    break;
  }
  case 'roster':
    cmdRoster(ctx, env);
    break;
  case 'friction':
    cmdFriction(ctx, env);
    break;
}
