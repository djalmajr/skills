// Session layer (per Herdr workspace, never versioned): the session.conf
// path and the `session set|clear|show` commands. Port of
// the original bash implementation :282-377. Resolution has no side effects — nothing
// is created until `session set` writes. Outside Herdr (no HERDR_WORKSPACE_ID
// and not HERDR_ENV=1) there is no session layer.
import fs from 'node:fs';
import path from 'node:path';
import { die, readTextFile, runCli } from './platform.mjs';
import { DieError, configKeyOk, configValueOk, configWritePair, configClearKey, splitPairArg, stateRootPath, stateRoot } from './config.mjs';

export function sessionConfPath(ctx, env = process.env, cwd = process.cwd()) {
  let ws = env.HERDR_WORKSPACE_ID || '';
  if (!ws && env.HERDR_ENV !== '1') return '';
  if (!ws) {
    // runCli resolves herdr through PATH/PATHEXT and runs a Windows .cmd
    // shim through the shell; a plain spawn of 'herdr' would not.
    const r = runCli('herdr', ['pane', 'current', '--current'], { env, timeoutMs: 10000 });
    if (!r.notFound && r.status === 0) {
      try {
        const j = JSON.parse(r.stdout || '');
        const wid = j?.result?.pane?.workspace_id;
        if (typeof wid === 'string' && wid) ws = wid;
      } catch { /* no usable workspace id */ }
    }
  }
  if (!ws) return '';
  return path.join(stateRootPath(ctx, env, cwd), ws, 'session.conf');
}

// cmd_session() port: dispatch set|clear|show; empty subcommand shows.
export function cmdSession(argv, ctx, env = process.env, cwd = process.cwd()) {
  const sub = argv[0] ?? '';
  switch (sub) {
    case 'set': cmdSessionSet(argv.slice(1), ctx, env, cwd); break;
    case 'clear': cmdSessionClear(argv.slice(1), ctx, env, cwd); break;
    case 'show': cmdSessionShow(ctx, env, cwd); break;
    case '': cmdSessionShow(ctx, env, cwd); break;
    default: die(`session: unknown subcommand '${sub}' (set <key> <value> | clear [key] | show)`, 2);
  }
}

function parsePair(argv, cmd) {
  let key = '';
  let value = '';
  let sawValue = 0;
  for (const a of argv) {
    if (a.startsWith('--')) die(`${cmd}: unknown option '${a}'`, 2);
    if (!key) {
      // An unquoted `key=<part> <rest>`: the shell splits the value on the
      // space and the first half arrives as `key=<part>` — split at the
      // first `=` so the next argument continues the value.
      const eq = a.indexOf('=');
      if (eq > 0) { key = a.slice(0, eq); value = a.slice(eq + 1); if (value !== '') sawValue = 1; }
      else key = a;
      continue;
    }
    if (sawValue === 0) { value = a; sawValue = 1; }
    // A value that starts with `-` (native CLI args, e.g. `-c a=b`) is not
    // split by the shell: keep joining the following arguments until the
    // value is complete. Values without a dash keep the old strict parse.
    else if (value.startsWith('-')) value += ` ${a}`;
    else die(`${cmd}: unexpected argument '${a}'`, 2);
  }
  return { key, value, sawValue };
}

// cmd_session_set() port.
export function cmdSessionSet(argv, ctx, env = process.env, cwd = process.cwd()) {
  const p = parsePair(argv, 'session set');
  const { key, value, sawValue } = splitPairArg(p.key, p.value, p.sawValue, 'session set');
  if (!key || sawValue === 0) die('usage: session set <key> <value> | <key>=<value>', 2);
  if (!value) die('session set: empty value', 2);
  if (!configKeyOk(key)) die(`session set: unknown key '${key}'`, 2);
  if (!configValueOk(key, value, env, cwd)) die(`session set: invalid value '${value}' for ${key}`, 2);
  const sf = sessionConfPath(ctx, env, cwd);
  if (!sf) die('session set: no Herdr workspace here (run inside Herdr, or set HERDR_WORKSPACE_ID)', 2);
  try { stateRoot(ctx, env, cwd); } catch { /* keep the .gitignore entry current; ignore failures like bash */ }
  fs.mkdirSync(path.dirname(sf), { recursive: true });
  try {
    configWritePair(sf, key, value, env);
  } catch (e) {
    if (e instanceof DieError) die(e.message, e.code);
    throw e;
  }
  process.stdout.write(`set ${key}=${value} in ${sf} (session: this Herdr workspace only; above project and user, below flags and HERDR_AGENTS_*)\n`);
}

// cmd_session_clear() port: `clear [key]`; without a key it removes the
// whole layer (the file) when present.
export function cmdSessionClear(argv, ctx, env = process.env, cwd = process.cwd()) {
  const key = argv[0] ?? '';
  if (argv.length > 1) die('usage: session clear [key]', 2);
  const sf = sessionConfPath(ctx, env, cwd);
  if (!sf) die('session clear: no Herdr workspace here (run inside Herdr, or set HERDR_WORKSPACE_ID)', 2);
  if (!key) {
    if (fs.existsSync(sf)) {
      fs.rmSync(sf);
      process.stdout.write(`session cleared: ${sf}\n`);
    } else {
      process.stdout.write('session is empty (nothing to clear)\n');
    }
    return;
  }
  if (!configKeyOk(key)) die(`session clear: unknown key '${key}'`, 2);
  if (!fs.existsSync(sf)) {
    process.stdout.write('session is empty (nothing to clear)\n');
    return;
  }
  configClearKey(sf, key);
  process.stdout.write(`cleared ${key} from ${sf}\n`);
}

// cmd_session_show() port: content plus the file path, or the empty message.
export function cmdSessionShow(ctx, env = process.env, cwd = process.cwd()) {
  const sf = sessionConfPath(ctx, env, cwd);
  if (sf) {
    try {
      if (fs.statSync(sf).size > 0) {
        process.stdout.write(readTextFile(sf) + `\nsession file: ${sf}\n`);
        return;
      }
    } catch { /* missing file: fall through to the empty message */ }
  }
  process.stdout.write('session is empty (no session overrides for this workspace)\n');
}
