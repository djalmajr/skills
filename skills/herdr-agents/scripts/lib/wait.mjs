// wait/collect bookkeeping (port slice 6a): the per-agent completion probe
// (report-size stability, blocked double-probe, auto-approve, quota,
// settled screen, gone / unavailable), the error-rank order for a
// multi-agent wait (4 > 11 > 7 > 6), the synchronous poll loop and the
// `wait` command. Port of scripts/herdr-agents.sh :3616-3810
// (kind_approve_keys :3616, try_auto_approve :3625, probe_agent :3644,
// notify_done :3690, wait_rank :3733, wait_raise :3742, wait_for :3751,
// cmd_wait :3802).
//
// Faithful-port notes:
//   - one compact JSON line per agent, same keys in the same order as the
//     bash `jq -n -c` literals (insertion order in JSON.stringify);
//   - the screen hash is the first field of the local `cksum` (the
//     ISO 8802-3 32-bit CRC over the bytes + the least-significant-first
//     length octets, complemented — the BSD/macOS default `cksum`,
//     algorithm 3). It is only ever compared against itself across probes.
//   - the `.approvals` counter is read-then-written without a lock, as in
//     bash (spec open question 6: ported as-is, documented);
//   - the poll sleep is synchronous (Atomics.wait) and defaults to 3 s
//     like `sleep 3`; HERDR_AGENTS_WAIT_POLL_MS shortens it for tests.
import fs from 'node:fs';
import path from 'node:path';
import { readTextFile } from './platform.mjs';
import { cfg, DieError } from './config.mjs';
import { stateDir, rosterLine, lastReport, warn, dieFriction, nowStamp, sleepSync } from './state.mjs';
import { agentState, agentRead, agentSendKeys, notificationShow } from './herdr.mjs';
import { quotaDetect } from './quota.mjs';
import { laneOfRole } from './lanes.mjs';
import { markTaskDone } from './tasks.mjs';

// ---------- kind_approve_keys (:3616) ----------

// Logical key that accepts the highlighted default of that CLI's approval
// dialog (herdr agent send-keys syntax).
export function kindApproveKeys(kind) {
  switch (kind) {
    case 'claude':
    case 'grok':
    case 'agy':
    case 'cursor': return 'enter'; // option 1 "Yes" is preselected
    case 'codex': return 'y'; // Codex approval: y = yes
    default: return 'enter';
  }
}

// ---------- try_auto_approve (:3625) ----------

// Returns true when a key was sent and the wait may continue. The counter
// is read then written without a lock (as in bash; spec open question 6).
export function tryAutoApprove(sd, agent, ctx, env = process.env) {
  if (cfg(ctx, 'auto_approve', 'off', env) !== 'on') return false;
  const maxRaw = cfg(ctx, 'max_auto_approvals', '20', env);
  const max = Number(maxRaw);
  // Absent counter = 0. A counter that exists but is not an integer (empty,
  // truncated by an interrupted write) fails closed like bash
  // `[ "$n" -lt "$max" ]`: warn-and-return, no keypress.
  let n = 0;
  let nRaw = null;
  try { nRaw = readTextFile(path.join(sd, 'wait', `${agent}.approvals`)); } catch { /* absent */ }
  if (nRaw !== null) n = /^\s*[0-9]+\s*$/.test(nRaw) ? Number(nRaw.trim()) : NaN;
  if (!(n < max)) {
    warn(`auto_approve: ${agent} reached max_auto_approvals=${maxRaw}; leaving it blocked`);
    return false;
  }
  const kind = rosterLine(sd, agent).split('\t')[2] ?? '';
  if (!agentSendKeys(agent, kindApproveKeys(kind), env)) return false;
  const next = n + 1;
  fs.writeFileSync(path.join(sd, 'wait', `${agent}.approvals`), `${next}\n`);
  fs.appendFileSync(path.join(sd, 'wait', `${agent}.approvals.log`), `${nowStamp()} auto-approved dialog #${next}\n`);
  warn(`auto_approve: answered dialog #${next} for '${agent}' with its default option`);
  fs.rmSync(path.join(sd, 'wait', `${agent}.blocked`), { force: true });
  return true;
}

// ---------- probe_agent (:3644) ----------

function reportNonEmpty(p) {
  if (!p) return false;
  try { return fs.statSync(p).size > 0; } catch { return false; }
}

// The first field of `cksum` for `text`: ISO 8802-3 32-bit CRC (poly
// 0x04C11DB7, init 0, MSB-first) over the UTF-8 bytes followed by the
// smallest little-endian octet count of the byte length, complemented —
// the BSD/macOS `cksum` default (algorithm 3; verified against the local
// binary). Used only to compare screen stability across probes.
export function cksumField(text) {
  const buf = Buffer.from(String(text), 'utf8');
  const extra = [];
  let n = buf.length;
  do { extra.push(n & 0xff); n >>>= 8; } while (n > 0);
  const data = Buffer.concat([buf, Buffer.from(extra)]);
  let crc = 0;
  for (const b of data) {
    crc ^= (b << 24);
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x04c11db7) & 0xffffffff : (crc << 1) & 0xffffffff;
      crc >>>= 0;
    }
  }
  return (~crc) >>> 0;
}

// The `.size` bookkeeping uses `wc -c < report`: the BSD/macOS `wc` prints
// the count right-justified in an 8-character field (9 digits in a
// 10-character field, wider counts unpadded), so the stored value keeps
// that padding to stay byte-identical with the bash write.
export function wcSize(size) {
  const s = String(size);
  const w = s.length < 8 ? 8 : s.length === 9 ? 10 : s.length;
  return s.padStart(w, ' ');
}

function readWaitFile(sd, agent, name) {
  try { return readTextFile(path.join(sd, 'wait', name)).replace(/\n+$/, ''); } catch { return null; }
}

// done | pending | blocked | working | settled | quota | gone |
// `unavailable\t<cause>` — per-agent screen/settled bookkeeping under
// <state>/wait/ (the .size/.screen/.since/.blocked/.quota files).
export function probeAgent(sd, agent, report, ctx, env = process.env) {
  const grace = Number(cfg(ctx, 'settled_grace', '45', env));
  if (reportNonEmpty(report)) {
    // Wait for the file size to stop changing (the worker may still be
    // writing); `.size` is cleared by waitFor, so a fresh report is only
    // `done` on the second probe.
    const size = fs.statSync(report).size;
    const prev = readWaitFile(sd, agent, `${agent}.size`) ?? '-1';
    fs.writeFileSync(path.join(sd, 'wait', `${agent}.size`), `${wcSize(size)}\n`);
    if (String(size) === prev.trim()) return 'done';
    return 'pending';
  }
  const st = agentState(agent, env);
  if (st.state === 'gone') return 'gone';
  if (st.state === 'unavailable') return `unavailable\t${st.cause}`;
  if (st.state === 'blocked') {
    // Detection can flag a transient approval UI; require two consecutive
    // blocked probes before acting. With auto_approve=on the default
    // option is sent and the wait continues (bounded by
    // max_auto_approvals).
    const bfile = path.join(sd, 'wait', `${agent}.blocked`);
    if (fs.existsSync(bfile)) return tryAutoApprove(sd, agent, ctx, env) ? 'working' : 'blocked';
    fs.writeFileSync(bfile, '');
    return 'working';
  }
  fs.rmSync(path.join(sd, 'wait', `${agent}.blocked`), { force: true });
  if (st.state !== 'working') {
    const qtext = agentRead(env, agent, { source: 'visible', lines: 20 });
    const q = quotaDetect(st.state, qtext);
    if (q) {
      // `printf '%s\n' "$(quota_detect …)"`: the command substitution strips
      // the trailing newlines, so an empty renewal leaves a one-line file.
      fs.writeFileSync(path.join(sd, 'wait', `${agent}.quota`), q[1] !== '' ? `${q[0]}\n${q[1]}\n` : `${q[0]}\n`);
      return 'quota';
    }
  }
  const screen = agentRead(env, agent, { source: 'visible' });
  const hash = String(cksumField(screen));
  const lastScreen = readWaitFile(sd, agent, `${agent}.screen`) ?? '';
  const nowS = Math.floor(Date.now() / 1000);
  if (st.state === 'working' || hash !== lastScreen) {
    fs.writeFileSync(path.join(sd, 'wait', `${agent}.screen`), `${hash}\n`);
    fs.writeFileSync(path.join(sd, 'wait', `${agent}.since`), `${nowS}\n`);
    return 'working';
  }
  const sinceRaw = readWaitFile(sd, agent, `${agent}.since`) ?? String(nowS);
  const since = Number(sinceRaw);
  // Bash `[ $((now_s - since)) -ge "$grace" ]`: a non-numeric operand
  // fails the test and the agent keeps working.
  if (Number.isFinite(since) && Number.isFinite(grace) && (nowS - since) >= grace) return 'settled';
  return 'working';
}

// ---------- notify_done (:3690) ----------

// notify=on: one notification per finished agent; best effort.
export function notifyDone(agent, report, ctx, env = process.env) {
  if (cfg(ctx, 'notify', 'off', env) === 'on') notificationShow(`herdr-agents: ${agent} finished`, report, env);
}

// ---------- wait_rank / wait_raise (:3733) ----------

// One order for a multi-agent wait: 4 unavailable > 11 quota > 7 blocked >
// 6 gone or settled. The argument order must not turn a quota into a
// blocked or a gone.
export function waitRank(code) {
  switch (String(code)) {
    case '4': return 4;
    case '11': return 3;
    case '7': return 2;
    case '6': return 1;
    default: return 0;
  }
}

// wait_raise: the candidate wins when it ranks strictly higher.
function waitRaise(rc, cand) {
  return waitRank(cand) > waitRank(rc) ? cand : rc;
}

// ---------- wait_for (:3751) ----------

// Poll interval in ms: 3 s like the bash `sleep 3`; the env override is
// test-only (undocumented for users) and only shortens it: an integer from
// 1 to 3000, anything else keeps 3000 (never a 0 ms busy loop).
export function pollIntervalMs(env) {
  const raw = env.HERDR_AGENTS_WAIT_POLL_MS;
  const v = /^[0-9]+$/.test(raw ?? '') ? Number(raw) : NaN;
  return v >= 1 && v <= 3000 ? v : 3000;
}

function jsonLine(obj, sink) {
  sink(`${JSON.stringify(obj)}\n`);
}

// Reads <state>/wait/<agent>.quota: line 1 = match, line 2 = renewal
// ('' when the file is absent or short).
function readQuotaFile(sd, agent) {
  const raw = readWaitFile(sd, agent, `${agent}.quota`);
  if (raw === null) return ['', ''];
  const lines = raw.split('\n');
  return [lines[0] ?? '', lines[1] ?? ''];
}

// wait_for <timeout_ms> <any> <agent>… → one JSON line per agent;
// rc 0 when every agent settles, 4/11/7/6 by rank otherwise, 9 on timeout
// (with a `timeout` line for each pending agent). Synchronous: the sleep
// between probes is Atomics.wait, so the caller's event loop never turns.
// `sink` receives each JSON line (default: process.stdout). The `wait`
// command prints them; `dispatch` captures them instead of printing (bash
// `out="$(wait_for …)"`) — the behavior is otherwise unchanged.
export function waitFor(agents, opts) {
  const { sd, ctx, env, timeoutMs, any = false, sink = (l) => process.stdout.write(l) } = opts;
  const pollMs = pollIntervalMs(env);
  const tm = Number(timeoutMs);
  // A non-numeric timeout would make the deadline check never fire (infinite
  // poll loop); 0 = timeout right after the first probe round.
  const deadline = Number.isFinite(tm)
    ? Math.floor(Date.now() / 1000) + Math.floor(tm / 1000)
    : 0;
  for (const a of agents) fs.rmSync(path.join(sd, 'wait', `${a}.size`), { force: true });
  let rc = 0;
  let remaining = [...agents];
  for (;;) {
    const pending = [];
    for (const a of remaining) {
      const r = lastReport(sd, a);
      const st = probeAgent(sd, a, r, ctx, env);
      const tag = st.split('\t')[0];
      switch (tag) {
        case 'done':
          jsonLine({ agent: a, status: 'done', report: r }, sink);
          notifyDone(a, r, ctx, env);
          markTaskDone(sd, a, env);
          if (any) return 0;
          break;
        case 'blocked':
          jsonLine({ agent: a, status: 'blocked', report: r }, sink);
          rc = waitRaise(rc, 7);
          break;
        case 'gone':
          jsonLine({ agent: a, status: 'gone', report: r }, sink);
          rc = waitRaise(rc, 6);
          break;
        case 'settled':
          jsonLine({ agent: a, status: 'settled-no-report', report: r }, sink);
          rc = waitRaise(rc, 6);
          break;
        case 'unavailable': {
          const cause = st.slice(st.indexOf('\t') + 1) || '';
          jsonLine({ agent: a, status: 'unavailable', report: r, error: cause }, sink);
          warn(`agent '${a}': herdr agent get failed: ${cause}`);
          rc = waitRaise(rc, 4);
          break;
        }
        case 'quota': {
          const [match, renewal] = readQuotaFile(sd, a);
          const f = rosterLine(sd, a).split('\t');
          const kind = f[2] ?? '';
          const model = f.length >= 9 ? (f[8] ?? '') : '';
          let lane = f.length >= 12 ? (f[11] ?? '') : '';
          const roleNow = f[3] ?? '';
          if (lane === '') lane = laneOfRole(ctx, roleNow, env);
          jsonLine({ agent: a, status: 'quota', report: r, lane, kind, model, match, renewal }, sink);
          warn(`quota: agent '${a}' lane=${lane || '?'} kind=${kind} model=${model || '?'} : ${match}${renewal ? `; renewal: ${renewal}` : ''}`);
          rc = waitRaise(rc, 11);
          break;
        }
        default:
          pending.push(a);
      }
    }
    remaining = pending;
    if (remaining.length === 0) return rc;
    if (Math.floor(Date.now() / 1000) >= deadline) {
      for (const a of remaining) jsonLine({ agent: a, status: 'timeout' }, sink);
      return 9;
    }
    sleepSync(pollMs);
  }
}

// ---------- cmd_wait (:3802) ----------

// `wait <agent>… [--timeout MS] [--any]`: rc 0 all done · 4 unavailable ·
// 11 quota · 7 blocked · 6 settled-no-report|gone · 9 timeout.
export function cmdWait(argv, ctx, env = process.env, cwd = process.cwd()) {
  const agents = [];
  let timeout = '';
  let any = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--timeout') {
      const v = argv[i + 1];
      if (v === undefined) dieFriction('wait: --timeout expects a value', 2);
      // Bash fails on the shell arithmetic; the port says why (decision).
      if (!/^[0-9]+$/.test(v)) dieFriction(`wait: --timeout expects milliseconds, got '${v}'`, 2);
      timeout = v;
      i += 1;
    } else if (a === '--any') {
      any = 1;
    } else if (a.startsWith('--')) {
      dieFriction(`wait: unknown option ${a}`, 2);
    } else {
      agents.push(a);
    }
  }
  if (agents.length === 0) dieFriction('wait: give at least one agent name', 2);
  const sd = stateDir(ctx, env, cwd);
  for (const a of agents) {
    if (rosterLine(sd, a) === '') dieFriction(`agent '${a}' is not in the roster`, 3);
  }
  if (timeout === '') timeout = cfg(ctx, 'dispatch_timeout', '900000', env);
  try {
    return waitFor(agents, { sd, ctx, env, timeoutMs: Number(timeout), any });
  } catch (e) {
    if (e instanceof DieError) dieFriction(e.message, e.code);
    throw e;
  }
}
