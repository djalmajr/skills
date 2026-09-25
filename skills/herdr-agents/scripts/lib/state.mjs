// On-disk state (port slice 3): workspace resolution, the state dir, the
// roster (12-column agents.tsv with a mkdir-based lock), last-report-*
// and the friction log (warn / die-with-log).
//
// Behavior mirrors the original bash implementation (:378-402, :718-742, :773-853);
// CRLF is normalized to LF on read (decision 7) and paths go through
// path.join (decision 3). Slice 4 moved the text helpers to lib/text.mjs,
// the quota detection to lib/quota.mjs, the lanes to lib/lanes.mjs and
// the status/roster/friction commands to lib/commands/*, so this module
// only owns state.
import fs from 'node:fs';
import path from 'node:path';
import { die, readTextFile, runCli, atomicWrite } from './platform.mjs';
import { stateRoot, DieError } from './config.mjs';

// ---------- time (local, like bash `date`) ----------

function pad2(n) { return String(n).padStart(2, '0'); }

// now() port: date +%Y%m%dT%H%M%S (roster column 8).
export function nowStamp(d = new Date()) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}T${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

// date +%Y-%m-%dT%H:%M:%S (friction log column 1).
export function nowIso(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// ---------- friction log (log_friction / warn) ----------

let frictionLog = '';
let frictionCmd = '';

// main() port for the living commands: FRICTION_LOG=<state>/friction.log
// when HERDR_ENV=1 and herdr is on PATH (the jq check is gone, decision 5).
export function setFrictionLog(file, cmd) {
  frictionLog = file;
  frictionCmd = cmd;
}

// log_friction port: append TSV, never fail (bash `2>/dev/null || true`).
// A friction log line is TSV (date \t level \t command \t message): a
// message or command carrying \n, \r or \t would open lines missing the
// four columns (breaking `awk -F'\t'` and the sort on column 1). Sanitize
// before writing — the log is the only place the text is kept verbatim.
export function frictionSafe(text) {
  return String(text).replace(/[\r\n\t]+/g, ' ');
}

function logFriction(level, message) {
  if (!frictionLog) return;
  try {
    const cmd = frictionSafe(frictionCmd || '?');
    const msg = frictionSafe(message);
    fs.appendFileSync(frictionLog, `${nowIso()}\t${level}\t${cmd}\t${msg}\n`);
  } catch { /* best effort */ }
}

// warn() port: stderr line plus a `warning` friction entry.
export function warn(message) {
  process.stderr.write(`herdr-agents: warning: ${message}\n`);
  logFriction('warning', message);
}

// die() that also records `error(exit N)` in the friction log, like bash.
// Exported: the moved commands (lib/commands/*) keep the same
// log-then-die behavior.
export function dieFriction(message, code = 1) {
  logFriction(`error(exit ${code})`, message);
  die(message, code);
}

// The friction entry of a `die` without the exit: bash `die` inside the
// suppressed `(cmd_regrid) >/dev/null 2>&1` of the automatic regrid calls
// still appends the `error(exit N)` line (the "see friction" of the outer
// warning points at it).
export function logFrictionError(message, code = 1) {
  logFriction(`error(exit ${code})`, message);
}

// ---------- workspace / state dir ----------

// workspace_id() port: $HERDR_WORKSPACE_ID, else `herdr pane current
// --current | jq -r .result.pane.workspace_id`. Decision 6: a herdr
// failure passes the CLI's own output through and throws a DieError with
// an empty message and herdr's code (the entry exits with the code only);
// a missing/null id prints as `null`, exactly like `jq -r`.
export function workspaceId(ctx, env = process.env, cwd = process.cwd()) {
  if (env.HERDR_WORKSPACE_ID) return env.HERDR_WORKSPACE_ID;
  const r = runCli('herdr', ['pane', 'current', '--current'], { env, timeoutMs: 30_000 });
  if (r.notFound) throw new DieError('herdr CLI not found in PATH', 2);
  if (r.status !== 0) {
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    throw new DieError('', r.status ?? 1);
  }
  let j;
  try { j = JSON.parse(r.stdout || ''); } catch { throw new DieError('', 2); } // jq parse failure
  const wid = j && typeof j === 'object' ? j?.result?.pane?.workspace_id : undefined;
  return wid === undefined || wid === null ? 'null' : String(wid);
}

const ROSTER_HEADER = '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\tmodel\tapprovals\troles\tlane\n';

// state_dir_path() port: <state_root>/<workspace_id> without the side
// effects of stateDir (no subdirs, no roster header). Commands that only
// read the state (a lint may still die) use this.
export function stateDirPath(ctx, env = process.env, cwd = process.cwd()) {
  return path.join(stateRoot(ctx, env, cwd), workspaceId(ctx, env, cwd));
}

// state_dir() port: <state_root>/<workspace_id> with briefs/, reports/,
// wait/ and the agents.tsv header (created only when the file is absent).
export function stateDir(ctx, env = process.env, cwd = process.cwd()) {
  const d = stateDirPath(ctx, env, cwd);
  fs.mkdirSync(path.join(d, 'briefs'), { recursive: true });
  fs.mkdirSync(path.join(d, 'reports'), { recursive: true });
  fs.mkdirSync(path.join(d, 'wait'), { recursive: true });
  const tsv = path.join(d, 'agents.tsv');
  if (!fs.existsSync(tsv)) fs.writeFileSync(tsv, ROSTER_HEADER);
  return d;
}

// ---------- roster ----------

// Every line of agents.tsv (header included), CRLF-normalized. A missing
// file reads as empty.
function tsvLines(sd) {
  let raw;
  try { raw = readTextFile(path.join(sd, 'agents.tsv')); } catch { raw = ''; }
  const lines = raw.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// roster_rows() port: everything but the `#` header (empty lines kept, as
// `grep -v '^#'` does).
export function rosterRows(sd) {
  return tsvLines(sd).filter((l) => !l.startsWith('#'));
}

// roster_line() port: the LAST row whose column 1 is `name`, else ''.
export function rosterLine(sd, name) {
  let found = '';
  for (const l of rosterRows(sd)) {
    if (l.split('\t')[0] === name) found = l;
  }
  return found;
}

// sleepSync: synchronous wait via Atomics.wait on a SharedArrayBuffer
// (works in Node and Bun, no event loop needed). Exported: the wait loop
// (lib/wait.mjs) reuses it for its 3 s poll interval.
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// roster_lock() port: an exclusive mkdir of <state>/agents.lock; a lock
// whose mtime is older than 60 s is an orphan (rmdir and retry at once);
// otherwise, or when the orphan cannot be removed, spin 50 ms between
// tries, 200 tries, then die 4. Two processes that find the same orphan at
// the same instant can race (no owner token), as in bash; the lock is held
// for milliseconds, so this needs a crash plus a collision.
function rosterLock(sd) {
  const lock = path.join(sd, 'agents.lock');
  let i = 0;
  for (;;) {
    try {
      fs.mkdirSync(lock); // no `recursive`: EEXIST means held
      return;
    } catch { /* held (or vanished): check staleness */ }
    let removed = false;
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > 60_000) {
        fs.rmdirSync(lock);
        removed = true;
      }
    } catch { /* vanished, or the orphan cannot be removed: counts as a try */ }
    if (removed) continue;
    i += 1;
    if (i >= 200) {
      dieFriction(`roster lock ${lock} held for too long; remove it if no herdr-agents command is running`, 4);
    }
    sleepSync(50);
  }
}

// roster_unlock() port (best effort rmdir).
function rosterUnlock(sd) {
  try { fs.rmdirSync(path.join(sd, 'agents.lock')); } catch { /* best effort */ }
}

// with_roster_lock(fn) port: every roster writer holds the lock; it is
// released in a finally, even when fn throws. fn's return value passes
// through; a throw propagates after the unlock.
export function withRosterLock(sd, fn) {
  rosterLock(sd);
  try {
    return fn();
  } finally {
    rosterUnlock(sd);
  }
}

// Roster append (bash :3451): one 12-column line under the lock. The
// direct append (not a rewrite) is the reference behavior.
export function rosterAppend(sd, fields) {
  withRosterLock(sd, () => {
    fs.appendFileSync(path.join(sd, 'agents.tsv'), fields.join('\t') + '\n');
  });
}

// roster_remove() port: rewrite without the row, under the lock.
export function rosterRemove(sd, name) {
  withRosterLock(sd, () => {
    const lines = tsvLines(sd).filter((l) => l.split('\t')[0] !== name);
    const f = path.join(sd, 'agents.tsv');
    atomicWriteRoster(f, lines);
  });
}

// roster_set_role() port: column 4 becomes the new role, column 11 (roles
// history) gains it, keeping the previous role when that column was empty.
// Old 8-column lines grow to 11. Under the lock.
export function rosterSetRole(sd, name, role) {
  withRosterLock(sd, () => {
    const lines = tsvLines(sd).map((l) => {
      const arr = l.split('\t');
      if (arr[0] !== name) return l;
      const prev = arr[3] ?? '';
      let hist = arr.length >= 11 ? (arr[10] ?? '') : '';
      if (hist === '') hist = prev;
      else if (!hist.split(',').includes(prev)) hist = `${hist},${prev}`;
      if (prev !== role) {
        if (hist === '') hist = role;
        else hist = `${hist},${role}`;
      }
      arr[3] = role;
      while (arr.length < 11) arr.push('');
      arr[10] = hist;
      return arr.join('\t');
    });
    atomicWriteRoster(path.join(sd, 'agents.tsv'), lines);
  });
}

// roster_replace_pane() port (bash :3066): column 2 old → new, under the
// lock; a no-op when old==new or new is empty.
export function rosterReplacePane(sd, oldPane, newPane) {
  if (oldPane === newPane || newPane === '') return;
  withRosterLock(sd, () => {
    const lines = tsvLines(sd).map((l) => {
      const arr = l.split('\t');
      if (arr[1] === oldPane) arr[1] = newPane;
      return arr.join('\t');
    });
    atomicWriteRoster(path.join(sd, 'agents.tsv'), lines);
  });
}

// Shared roster rewrite: atomicWrite (port decision 1) with the awk
// output convention — a trailing newline per row, empty file when empty.
function atomicWriteRoster(f, lines) {
  atomicWrite(f, lines.length ? lines.join('\n') + '\n' : '');
}

// ---------- last-report ----------

export function lastReportPath(sd, agent) {
  return path.join(sd, `last-report-${agent}`);
}

// The report path recorded for the agent (`$(cat last-report-<a>)`), i.e.
// the file content without trailing newlines; '' when absent.
export function lastReport(sd, agent) {
  let raw;
  try { raw = readTextFile(lastReportPath(sd, agent)); } catch { return ''; }
  return raw.replace(/\n+$/, '');
}
