// On-disk state (port slice 3): workspace resolution, the state dir, the
// roster (12-column agents.tsv with a mkdir-based lock), last-report-*,
// the friction log, sanitize_cause, quota detection and the `status`,
// `roster` and `friction` commands.
//
// Behavior mirrors scripts/herdr-agents.sh (:378-402, :718-742, :773-853,
// :3671-3727, :4009-4033, :4151-4157); CRLF is normalized to LF on read
// (decision 7) and paths go through path.join (decision 3). The quota
// detection helpers and the lane fallback are an interim home here until
// the slice 4 modules (lib/quota.mjs, lib/lanes.mjs) land and take them
// over.
import fs from 'node:fs';
import path from 'node:path';
import { die, readTextFile, runCli, atomicWrite } from './platform.mjs';
import { stateRoot, cfg } from './config.mjs';
import { agentState, agentRead, liveAgents, paneList, tabList } from './herdr.mjs';

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
function logFriction(level, message) {
  if (!frictionLog) return;
  try {
    fs.appendFileSync(frictionLog, `${nowIso()}\t${level}\t${frictionCmd || '?'}\t${message}\n`);
  } catch { /* best effort */ }
}

// warn() port: stderr line plus a `warning` friction entry.
export function warn(message) {
  process.stderr.write(`herdr-agents: warning: ${message}\n`);
  logFriction('warning', message);
}

// die() that also records `error(exit N)` in the friction log, like bash.
function dieFriction(message, code = 1) {
  logFriction(`error(exit ${code})`, message);
  die(message, code);
}

// ---------- workspace / state dir ----------

// workspace_id() port: $HERDR_WORKSPACE_ID, else `herdr pane current
// --current | jq -r .result.pane.workspace_id`. A herdr failure passes the
// CLI's own output through and exits with its code (bash `set -e` on the
// pipeline); a missing/null id prints as `null`, exactly like `jq -r`.
export function workspaceId(ctx, env = process.env, cwd = process.cwd()) {
  if (env.HERDR_WORKSPACE_ID) return env.HERDR_WORKSPACE_ID;
  const r = runCli('herdr', ['pane', 'current', '--current'], { env, timeoutMs: 30_000 });
  if (r.notFound) die('herdr CLI not found in PATH', 2);
  if (r.status !== 0) {
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    process.exit(r.status ?? 1);
  }
  let j;
  try { j = JSON.parse(r.stdout || ''); } catch { process.exit(2); } // jq parse failure
  const wid = j && typeof j === 'object' ? j?.result?.pane?.workspace_id : undefined;
  return wid === undefined || wid === null ? 'null' : String(wid);
}

const ROSTER_HEADER = '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\tmodel\tapprovals\troles\tlane\n';

// state_dir() port: <state_root>/<workspace_id> with briefs/, reports/,
// wait/ and the agents.tsv header (created only when the file is absent).
export function stateDir(ctx, env = process.env, cwd = process.cwd()) {
  const d = path.join(stateRoot(ctx, env, cwd), workspaceId(ctx, env, cwd));
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

// sleepSync: synchronous 50 ms wait via Atomics.wait on a
// SharedArrayBuffer (works in Node and Bun, no event loop needed).
function sleepSync(ms) {
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

// ---------- sanitize_cause ----------

// sanitize_cause() port: one line, no tabs, control characters dropped
// (printables 0x20-0x7E only), runs of spaces collapsed, at most 200 chars.
export function sanitizeCause(s) {
  let out = String(s).replace(/[\n\r\t]/g, ' ').replace(/[^\x20-\x7e]/g, '').replace(/ {2,}/g, ' ').replace(/^ +| +$/g, '');
  return out.length > 200 ? out.slice(0, 200) : out;
}

// ---------- quota detection (interim home; slice 4 owns lib/quota.mjs) ----------

// Port of :1030-1133. Provider lines only, never on source-code lines,
// never while working. Returns [match, renewal] (either possibly empty)
// or null when this is not a quota stop.

const QUOTA_RES = [
  /hit your usage limit/i,
  /Individual quota reached/i,
  /You exceeded your current quota/i,
  /quota exceeded/i,
  /RESOURCE_EXHAUSTED/i,
  /429 Too Many Requests/i,
  /rate limit exceeded/i,
  /You've hit your( [A-Za-z]+)? limit/i,
  /You have hit your( [A-Za-z]+)? limit/i,
  /You have reached your( specified)?( (workspace )?API)? usage limits?/i,
  /You've reached your( specified)?( (workspace )?API)? usage limits?/i,
];

const RENEWAL_RES = [
  /resets? (at|in|on) /i,
  /try again (at|in) /i,
  /available (again )?(at|in) /i,
  /retry after /i,
  /in [0-9]+ (minute|hour|second)s?/i,
];

// redact_secrets() port (the four sed -E passes, in order).
export function redactSecrets(s) {
  return String(s)
    .replace(/(sk|pk|rk)_(live|test)_[A-Za-z0-9]+/g, '[redacted]')
    .replace(/(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/[Bb]earer [A-Za-z0-9._~+/-]+/g, 'Bearer [redacted]')
    .replace(/(api[_-]?key|token|secret|password)=[^ ]*/g, '$1=[redacted]');
}

// quota_line_is_code() port: the line is source code, not a provider error.
function quotaLineIsCode(line) {
  return /^\s*(#|\/\/|\/\*)/.test(line)
    || /\s#(\s|$)/.test(line)
    || /(^|[^:])\/\/|\/\*/.test(line)
    || /(^|[^A-Za-z0-9_])return([^A-Za-z0-9_]|$)/.test(line)
    || /(^|[^A-Za-z0-9_])function([^A-Za-z0-9_]|$)/.test(line)
    || /(^|[^A-Za-z0-9_])func\s/.test(line)
    || /[A-Za-z0-9_]\s+=\s*/.test(line)
    || /[A-Za-z0-9_]=["']/.test(line);
}

// quota_phrase_quoted() port: the matched phrase is a string literal, not
// a sentence the provider printed. A JSON "message" field, or a
// `insufficient_quota` / `rate_limit_error` key, still counts as a match.
function quotaPhraseQuoted(line, re) {
  const m = re.exec(line.toLowerCase());
  if (!m) return false;
  const pre = line.slice(0, m.index).replace(/[ \t]+$/, '');
  const post = line.slice(m.index + m[0].length).replace(/^[ \t]+/, '');
  if (pre.includes('"message"') || pre.includes('insufficient_quota') || pre.includes('rate_limit_error')) return false;
  const pc = pre.length ? pre[pre.length - 1] : '';
  const nc = post.length ? post[0] : '';
  return (pc === '"' && nc === '"') || (pc === "'" && nc === "'") || (pc === '`' && nc === '`');
}

export function quotaDetect(state, screen) {
  if (state === 'working') return null;
  if (!screen) return null;
  const lines = screen.split('\n');
  let line = '';
  outer: for (const candidate of lines) {
    if (!candidate) continue;
    if (quotaLineIsCode(candidate)) continue;
    for (const re of QUOTA_RES) {
      if (!re.test(candidate)) continue;
      if (quotaPhraseQuoted(candidate, re)) continue;
      line = candidate;
      break outer;
    }
  }
  if (!line) return null;
  let renewal = '';
  for (const l of lines) {
    if (RENEWAL_RES.some((re) => re.test(l))) { renewal = l; break; }
  }
  return [sanitizeCause(redactSecrets(line)), sanitizeCause(redactSecrets(renewal))];
}

// ---------- lane fallback for the quota report (interim; slice 4 lanes) ----------

function panesValue(ctx, env) {
  const p = cfg(ctx, 'panes', '4', env);
  return p === '3' || p === '4' ? p : '4';
}

function presetLaneNamesFor(p) {
  return p === '3' ? ['build', 'read'] : ['build', 'explore', 'review'];
}

function presetLaneRoles(lane, p) {
  switch (`${p}:${lane}`) {
    case '4:build':
    case '3:build': return 'implementer,designer,tasker';
    case '4:explore': return 'scouter,researcher';
    case '4:review': return 'reviewer,security-reviewer,ui-reviewer,inspector';
    case '3:read': return 'scouter,researcher,reviewer,security-reviewer,ui-reviewer,inspector';
    default: return '';
  }
}

// custom_lanes_present() port: any lane.<name>.roles value in a config
// layer or in the HERDR_AGENTS_LANE_*_ROLES environment.
function customLanesPresent(ctx, env) {
  for (const [k, v] of ctx.entries) {
    if (/^lane_.+_roles$/.test(k) && v.value) return true;
  }
  for (const [k, v] of Object.entries(env)) {
    if (/^HERDR_AGENTS_LANE_.+_ROLES$/.test(k) && v) return true;
  }
  return false;
}

// lane_names() port: the custom lane names (key middle, as bash compgen
// extracts them) when any layer defines one, else the preset lanes.
function laneNames(ctx, env) {
  if (!customLanesPresent(ctx, env)) return presetLaneNamesFor(panesValue(ctx, env));
  const names = [];
  for (const k of ctx.entries.keys()) {
    const m = k.match(/^lane_(.+)_roles$/);
    if (m && m[1] && !names.includes(m[1])) names.push(m[1]);
  }
  for (const [k, v] of Object.entries(env)) {
    const m = k.match(/^HERDR_AGENTS_LANE_(.+)_ROLES$/);
    if (m && m[1] && v) {
      const n = m[1].toLowerCase();
      if (!names.includes(n)) names.push(n);
    }
  }
  return names;
}

// lane_of_role() port: first lane (custom or preset) whose roles include
// the role; '' when none.
export function laneOfRole(ctx, role, env = process.env) {
  for (const lane of laneNames(ctx, env)) {
    const key = `lane_${lane.replace(/-/g, '_')}_roles`;
    const csv = customLanesPresent(ctx, env) ? cfg(ctx, key, '', env) : presetLaneRoles(lane, panesValue(ctx, env));
    const roles = csv.split(',').map((s) => s.trim()).filter(Boolean);
    if (roles.includes(role)) return lane;
  }
  return '';
}

// ---------- commands ----------

// cmd_status() port (:3671-3727): one TSV line per agent, JSON for quota,
// rc 0 / 4 (unavailable) / 11 (quota). `done` and `unknown-agent` never
// consult herdr; quota is only considered when the agent is not working.
export function cmdStatus(argv, ctx, env = process.env, cwd = process.cwd()) {
  if (argv.length === 0) dieFriction('status: give at least one agent name', 2);
  const sd = stateDir(ctx, env, cwd);
  let rc = 0;
  for (const a of argv) {
    const r = lastReport(sd, a);
    let state = '';
    let cause = '';
    let match = '';
    let renewal = '';
    let kind = '';
    let model = '';
    let lane = '';
    let quota = false;
    if (reportNonEmpty(r)) {
      state = 'done';
    } else if (!rosterLine(sd, a)) {
      state = 'unknown-agent';
    } else {
      const st = agentState(a, env);
      state = st.state;
      cause = st.cause;
      const orig = state;
      if (state === 'idle' || state === 'done') state = 'no-report-yet';
      if (state === 'unavailable') {
        if (rc !== 11) rc = 4;
        warn(`agent '${a}': herdr agent get failed: ${cause}`);
      } else if (orig !== 'working' && orig !== 'gone' && orig !== 'blocked' && orig !== 'unavailable') {
        const qtext = agentRead(env, a, { source: 'visible', lines: 20 });
        const q = quotaDetect(orig, qtext);
        if (q) {
          quota = true;
          match = q[0];
          renewal = q[1];
          rc = 11;
          const f = rosterLine(sd, a).split('\t');
          kind = f[2] ?? '';
          model = f.length >= 9 ? (f[8] ?? '') : '';
          lane = f.length >= 12 ? (f[11] ?? '') : '';
          const roleNow = f[3] ?? '';
          if (!lane) lane = laneOfRole(ctx, roleNow, env);
          warn(`quota: agent '${a}' lane=${lane || '?'} kind=${kind} model=${model || '?'} : ${match}${renewal ? `; renewal: ${renewal}` : ''}`);
        }
      }
    }
    if (quota) {
      process.stdout.write(JSON.stringify({ agent: a, status: 'quota', report: r, lane, kind, model, match, renewal }) + '\n');
    } else if (cause) {
      process.stdout.write(`${a}\t${state}\t${r}\t${cause}\n`);
    } else {
      process.stdout.write(`${a}\t${state}\t${r}\n`);
    }
  }
  return rc;
}

// `done` requires the recorded report file to exist and be non-empty
// (bash `[ -s "$r" ]`), not just the path to be recorded.
function reportNonEmpty(p) {
  if (!p) return false;
  try { return fs.statSync(p).size > 0; } catch { return false; }
}

// cmd_roster() port (:3876-3902): the NAME/ROLE/KIND/PANE/TAB/STATE/REPORT/
// CWD table, the other live agents, and the config footer.
export function cmdRoster(ctx, env = process.env, cwd = process.cwd()) {
  const sd = stateDir(ctx, env, cwd);
  const live = liveAgents(env);
  const ws = workspaceId(ctx, env, cwd);
  const panes = paneList(env, ws);
  const tabs = tabList(env, ws);

  // tab_of() port: the pane's tab label (truncated to 16), the tab id when
  // the label is null, `-` when the pane has no tab.
  const tabOf = (pane) => {
    const p = panes.find((x) => x && x.pane_id === pane);
    const t = p ? p.tab_id : undefined;
    if (t === undefined || t === null) return '-';
    const tb = tabs.find((x) => x && x.tab_id === t);
    let label = tb ? tb.label : undefined;
    if (label === undefined || label === null || label === false) label = t;
    return String(label).slice(0, 16);
  };

  const pad = (s, n) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
  process.stdout.write(`${pad('NAME', 20)} ${pad('ROLE', 18)} ${pad('KIND', 8)} ${pad('PANE', 8)} ${pad('TAB', 16)} ${pad('STATE', 9)} ${pad('REPORT', 16)} CWD\n`);

  const rows = rosterRows(sd);
  for (const l of rows) {
    const f = l.split('\t');
    const name = f[0] ?? '';
    if (!name) continue;
    const pane = f[1] ?? '';
    const kind = f[2] ?? '';
    const role = f[3] ?? '';
    const cwd = f[6] ?? '';
    const rolesHist = f.length >= 11 ? (f[10] ?? '') : '';
    const la = live.find((x) => x && ((x.name ?? '') === name || x.pane_id === pane));
    const state = la && la.agent_status !== undefined && la.agent_status !== null ? String(la.agent_status) : 'gone';
    const repPath = lastReport(sd, name);
    let rep = 'none';
    if (repPath) {
      try { rep = fs.statSync(repPath).size > 0 ? 'ready' : 'pending'; } catch { rep = 'pending'; }
    }
    let roleCell = role;
    if (rolesHist && rolesHist !== role) {
      const cand = `${role} (${rolesHist})`;
      if (cand.length <= 18) roleCell = cand;
    }
    process.stdout.write(`${pad(name, 20)} ${pad(roleCell, 18)} ${pad(kind, 8)} ${pad(pane, 8)} ${pad(tabOf(pane), 16)} ${pad(state, 9)} ${pad(rep, 16)} ${cwd}\n`);
  }

  process.stdout.write('\n# other live agents (not spawned by this skill)\n');
  const rosterPanes = new Set(rows.map((l) => l.split('\t')[1]).filter((p) => p !== '' && p !== undefined));
  for (const la of live) {
    const p = la && la.pane_id !== undefined && la.pane_id !== null ? String(la.pane_id) : 'null';
    if (rosterPanes.has(p)) continue;
    const n = la && la.name !== undefined && la.name !== null ? String(la.name) : '-';
    const ag = la && la.agent !== undefined && la.agent !== null ? String(la.agent) : 'null';
    const s = la && la.agent_status !== undefined && la.agent_status !== null ? String(la.agent_status) : 'null';
    process.stdout.write(`${pad(n, 20)} ${pad('-', 18)} ${pad(ag, 8)} ${pad(p, 8)} ${pad(tabOf(p), 16)} ${pad(s, 9)}\n`);
  }

  process.stdout.write(`\nlayout=${cfg(ctx, 'layout', 'split', env)} reuse_workers=${cfg(ctx, 'reuse_workers', 'on', env)} multi_role=${cfg(ctx, 'multi_role', 'on', env)} auto_approve=${cfg(ctx, 'auto_approve', 'off', env)}\n`);
}

// cmd_friction() port (:4151-4157).
export function cmdFriction(ctx, env = process.env, cwd = process.cwd()) {
  const f = path.join(stateDir(ctx, env, cwd), 'friction.log');
  let st = null;
  try { st = fs.statSync(f); } catch { /* absent */ }
  if (!st || st.size === 0) {
    process.stdout.write(`no friction recorded under ${f}\n`);
    return 0;
  }
  process.stdout.write(`friction log (${f}): timestamp, level, command, message\n`);
  process.stdout.write(readTextFile(f));
  return 0;
}
