// Platform helpers for the herdr-agents JS port (slice 1).
//
// Port of the Unix plumbing the bash script relies on, with the Windows
// decisions from the port spec (section 6 + orchestrator decisions):
//   - user config dir: $XDG_CONFIG_HOME/herdr-agents/config when set (any
//     platform); otherwise Unix ~/.config/herdr-agents/config or
//     Windows %APPDATA%\herdr-agents\config (decision 4).
//   - CRLF -> LF normalization on every text read (decision 7).
//   - HOME / USERPROFILE via env, falling back to os.homedir().
// No npm dependencies: node:fs, node:path, node:os, node:child_process only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// die <msg> [code] — same message format and codes as the bash script.
export function die(message, code = 1) {
  process.stderr.write(`herdr-agents: ${message}\n`);
  process.exit(code);
}

export function homeDir(platform = process.platform, env = process.env) {
  if (platform === 'win32') return env.USERPROFILE || os.homedir();
  return env.HOME || os.homedir();
}

// User config file path (the `user` layer). Decision 4: XDG_CONFIG_HOME wins
// on every platform; otherwise per-platform defaults.
export function userConfigPath(platform = process.platform, env = process.env) {
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, 'herdr-agents', 'config');
  if (platform === 'win32') {
    if (env.APPDATA) return path.join(env.APPDATA, 'herdr-agents', 'config');
    return path.join(homeDir(platform, env), 'AppData', 'Roaming', 'herdr-agents', 'config');
  }
  return path.join(homeDir(platform, env), '.config', 'herdr-agents', 'config');
}

// Read a text file as UTF-8, normalizing CRLF to LF (decision 7). Throws on
// missing/unreadable files, like fs.readFileSync.
export function readTextFile(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

// project_root() port: `git rev-parse --show-toplevel`, else the cwd.
export function projectRoot(env = process.env, cwd = process.cwd()) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.status === 0) {
    const p = (r.stdout || '').trim();
    if (p) return p;
  }
  return cwd;
}

// `command -v` port: resolve an executable on PATH, honoring PATHEXT on
// Windows (decision 6). Returns the full path or null.
export function findExecutable(name, env = process.env, platform = process.platform) {
  const pathVar = env.PATH ?? env.Path ?? '';
  const dirs = pathVar.split(path.delimiter).filter(Boolean);
  const exts = platform === 'win32'
    ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      let st;
      try { st = fs.statSync(candidate); } catch { continue; }
      if (!st.isFile()) continue;
      if (platform === 'win32') return candidate;
      if (st.mode & 0o111) return candidate;
    }
  }
  return null;
}

// cmdInvocation <resolved .cmd/.bat> <args> [env] — how to run a batch file
// on Windows without handing unescaped arguments to a shell (the cross-spawn
// rules): `cmd.exe /d /s /c "<command> <args>"` with verbatim arguments. Each
// argument is wrapped in double quotes (embedded quotes and trailing
// backslashes escaped) and every cmd.exe metacharacter is caret-escaped —
// twice for npm shims under node_modules\.bin, which re-parse %*. A space,
// a quote, `&` or `%` in an argument can neither split it nor run a command.
const CMD_META_RE = /([()\][%!^"`<>&|;, *?])/g;
function cmdEscapeArg(arg, twice) {
  let s = `${arg}`;
  s = s.replace(/(\\*)"/g, '$1$1\\"');
  s = s.replace(/(\\*)$/, '$1$1');
  s = `"${s}"`.replace(CMD_META_RE, '^$1');
  return twice ? s.replace(CMD_META_RE, '^$1') : s;
}
export function cmdInvocation(resolved, args, env = process.env) {
  const twice = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(resolved);
  const command = path.win32.normalize(resolved).replace(CMD_META_RE, '^$1');
  const line = [command, ...args.map((a) => cmdEscapeArg(a, twice))].join(' ');
  return {
    command: env.COMSPEC || env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

// atomicWrite replaces `dest` with `content` and never loses it: the temp
// file sits next to `dest` (same filesystem, so the rename never crosses
// devices, e.g. a tmpfs /tmp), keeps the original mode (0600 for a new file,
// like bash's mktemp), and one rename replaces the destination — nothing is
// removed first, so a failure leaves `dest` as it was. Shared by the config
// rewrites and every roster rewrite (port decision 1).
export function atomicWrite(dest, content) {
  let mode = 0o600;
  try { mode = fs.statSync(dest).mode & 0o777; } catch { /* new file */ }
  const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, content, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, dest);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

// runCli <exe> <args> — resolve the CLI on PATH (PATHEXT-aware) and run it
// with an argument array, no shell, with an optional timeout (the `timeout`
// port). On Windows a .cmd/.bat target runs through cmd.exe with every
// argument escaped (cmdInvocation), never through `shell: true`. Returns
// { notFound, resolved, status, signal, stdout, stderr, timedOut }.
export function runCli(exe, args, opts = {}) {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const resolved = findExecutable(exe, env, platform);
  if (!resolved) {
    return { notFound: true, resolved: null, status: null, signal: null, stdout: '', stderr: '', timedOut: false };
  }
  let command = resolved;
  let argv = args;
  let verbatim = false;
  if (platform === 'win32' && /\.(bat|cmd)$/i.test(resolved)) {
    const inv = cmdInvocation(resolved, args, env);
    command = inv.command;
    argv = inv.args;
    verbatim = inv.windowsVerbatimArguments;
  }
  const child = spawnSync(command, argv, {
    env,
    cwd: opts.cwd,
    input: opts.input,
    encoding: 'utf8',
    timeout: opts.timeoutMs,
    killSignal: 'SIGTERM',
    windowsVerbatimArguments: verbatim,
  });
  return {
    notFound: false,
    resolved,
    status: child.status,
    signal: child.signal,
    stdout: typeof child.stdout === 'string' ? child.stdout : '',
    stderr: typeof child.stderr === 'string' ? child.stderr : '',
    timedOut: child.status === null && child.signal != null,
  };
}
