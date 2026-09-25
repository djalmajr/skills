// wait/collect bookkeeping (port slice 6a): the per-agent completion probe
// (report-size stability, blocked double-probe, auto-approve, quota,
// provider error / capacity double-probe with the bounded continue
// prompts, settled screen, gone / unavailable), the error-rank order for a
// multi-agent wait (4 > 11 > 14 > 15 > 7 > 6), the synchronous poll loop
// and the `wait` command. Port of the original bash implementation
// :3616-3810
// (kind_approve_keys :3616, try_auto_approve :3625, probe_agent :3644,
// notify_done :3690, wait_rank :3733, wait_raise :3742, wait_for :3751,
// cmd_wait :3802).
//
// A dispatch that ended `not-received` records the moment in
// <state>/wait/<agent>.not-received (epoch seconds). The probe that finds
// that marker with the agent not working/blocked continues what the
// dispatch left: while the prompt is still visible in the agent's input
// box it retries one Enter per prompt_check_seconds window, up to three
// (the constant below); the agent starting to work clears the markers and
// the probe goes on as usual; otherwise the wait ends `not-received`
// (rank between 14 and 7).
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
import { agentState, agentRead, agentSendKeys, notificationShow, agentPrompt } from './herdr.mjs';
import { promptSitsInInput, markerSeqChanged } from './arrival.mjs';
import { sanitizeCause } from './text.mjs';
import { dialogKind, questionText } from './dialog.mjs';
import { quotaDetect } from './quota.mjs';
import { providerDetect } from './provider.mjs';
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

// The wait retries the Enter at most this many times (one per
// prompt_check_seconds window): a CLI that is still opening swallows the
// first Enter(s), and three windows cover a slow opening. Not a config key
// on purpose.
const ENTER_RETRY_LIMIT = 3;

// done | pending | blocked | question | working | settled | quota |
// provider-error | capacity | gone | not-received |
// `unavailable\t<cause>` — per-agent screen/settled bookkeeping under
// <state>/wait/ (the .size/.screen/.since/.blocked/.question/.stuck-hash/
// .stuck-since/.stuck-warned/.quota/.provider/.provider-cause/
// .capacity-retries/.capacity-at files; a not-received dispatch adds
// .not-received and the wait's Enter retries .enter-retry).
// S5 items 2 and 11a: a confirmed blocked screen that matches the kind's
// question marker (lib/dialog.mjs) returns `question` with the text saved
// in <agent>.question (no key sent, same rank as blocked); a working
// agent whose visible screen only changes in its counters (digits, progress
// glyphs) for stuck_warn_minutes gets one friction line (nothing sent, the
// status stays working).
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
  // A dispatch that ended not-received recorded the moment and the
  // agent's state_change_seq in .not-received ("<epoch> <seq>"; an
  // epoch-only marker is an older one and stays valid). Working or blocked
  // means the prompt arrived late, and a seq that moved means the agent
  // changed state in the meantime: in both cases drop the markers and go on
  // with the normal probe (no key in the seq case). Otherwise the wait
  // continues the dispatch with a bounded Enter retry (see below).
  const nrFile = path.join(sd, 'wait', `${agent}.not-received`);
  const retryFile = path.join(sd, 'wait', `${agent}.enter-retry`);
  if (fs.existsSync(nrFile)) {
    const markText = readWaitFile(sd, agent, `${agent}.not-received`);
    // True when the marker holds a seq, the current one is known, and the
    // two differ: the agent did something since the dispatch gave up, so a
    // prompt echo in the last lines is no proof the input box is stuck.
    const seqChanged = markerSeqChanged(markText, st.seq);
    if (st.state === 'working' || st.state === 'blocked' || seqChanged) {
      fs.rmSync(nrFile, { force: true });
      fs.rmSync(retryFile, { force: true });
    } else {
      // The same prompt_check_seconds read and validation as the dispatch
      // arrival check: a positive integer; the marker only exists when the
      // check ran with one, so an absent or invalid window just has no
      // grace between retries.
      const rawWin = String(cfg(ctx, 'prompt_check_seconds', '15', env));
      const winS = /^[0-9]+$/.test(rawWin) && Number(rawWin) > 0 ? Number(rawWin) : 0;
      let lastEpoch = 0;
      const markEpoch = Number(String(markText ?? '').trim().split(/\s+/)[0]);
      if (Number.isFinite(markEpoch)) lastEpoch = markEpoch;
      // .enter-retry: "<attempts> <epoch of the last Enter>". While it is
      // absent the last attempt is the dispatch's not-received moment; a
      // file that is not two integers fails closed (no more Enters), like
      // the .approvals counter.
      let attempts = 0;
      const retryRaw = readWaitFile(sd, agent, `${agent}.enter-retry`);
      if (retryRaw !== null) {
        const parts = retryRaw.trim().split(/\s+/);
        const a = Number(parts[0]);
        const e = Number(parts[1]);
        if (!Number.isFinite(a) || !Number.isFinite(e) || parts.length !== 2) return 'not-received';
        attempts = a;
        lastEpoch = e;
      }
      const nowS = Math.floor(Date.now() / 1000);
      // Inside the window since the last attempt: nothing to do, the agent
      // keeps working.
      if (nowS - lastEpoch < winS) return 'working';
      if (attempts < ENTER_RETRY_LIMIT && promptSitsInInput(agentRead(env, agent, { source: 'visible' }))) {
        const n = attempts + 1;
        agentSendKeys(agent, 'enter', env);
        fs.writeFileSync(retryFile, `${n} ${nowS}\n`);
        warn(`prompt to '${agent}' was still in its input box; sent Enter again (${n} of ${ENTER_RETRY_LIMIT})`);
        return 'working';
      }
      // The three retries are spent, or the prompt is no longer in the
      // input box with the agent not working: the wait ends not-received.
      return 'not-received';
    }
  }
  if (st.state === 'blocked') {
    // Detection can flag a transient approval UI; require two consecutive
    // blocked probes before acting. With auto_approve=on the default
    // option is sent and the wait continues (bounded by
    // max_auto_approvals). A decision question is never auto-answered: on
    // the confirmed probe the visible screen is read, and when it matches
    // the kind's question marker the wait reports `question` with the text
    // and sends no key — with or without auto_approve.
    const bfile = path.join(sd, 'wait', `${agent}.blocked`);
    if (fs.existsSync(bfile)) {
      const kind = rosterLine(sd, agent).split('\t')[2] ?? '';
      const visible = agentRead(env, agent, { source: 'visible', lines: 40 });
      if (dialogKind(kind, visible) === 'question') {
        fs.writeFileSync(path.join(sd, 'wait', `${agent}.question`), `${questionText(visible)}\n`);
        return 'question';
      }
      return tryAutoApprove(sd, agent, ctx, env) ? 'working' : 'blocked';
    }
    fs.writeFileSync(bfile, '');
    return 'working';
  }
  fs.rmSync(path.join(sd, 'wait', `${agent}.blocked`), { force: true });
  // The provider double-confirm and the capacity delay only hold across
  // consecutive probes that keep seeing the stop: a working agent or a
  // screen without it clears both (the continue counter stays per dispatch).
  const pfile = path.join(sd, 'wait', `${agent}.provider`);
  const atFile = path.join(sd, 'wait', `${agent}.capacity-at`);
  const clearProviderMarks = () => {
    fs.rmSync(pfile, { force: true });
    fs.rmSync(atFile, { force: true });
  };
  if (st.state === 'working') clearProviderMarks();
  // The visible screen, read at most once per probe: the stuck check and the
  // settled check below share it.
  let screen = null;
  const visibleScreen = () => (screen ??= agentRead(env, agent, { source: 'visible' }));
  // A working agent whose visible screen only changes in its counters
  // (digits and progress glyphs) for stuck_warn_minutes is probably stuck in
  // one tool call: one friction line, once, nothing is sent and the status
  // stays working. 0 disables the check.
  const limitMin = Number(cfg(ctx, 'stuck_warn_minutes', '20', env));
  if (st.state === 'working' && limitMin > 0) {
    const norm = String(visibleScreen())
      .replace(/\r\n/g, '\n')
      .replace(/[0-9]+/g, '#')
      .replace(/[\u2800-\u28ff◐◑◒◓]/g, '*');
    const h = String(cksumField(norm));
    const nowS = Math.floor(Date.now() / 1000);
    if (readWaitFile(sd, agent, `${agent}.stuck-hash`) !== h) {
      fs.writeFileSync(path.join(sd, 'wait', `${agent}.stuck-hash`), `${h}\n`);
      fs.writeFileSync(path.join(sd, 'wait', `${agent}.stuck-since`), `${nowS}\n`);
      fs.rmSync(path.join(sd, 'wait', `${agent}.stuck-warned`), { force: true });
    } else if (!fs.existsSync(path.join(sd, 'wait', `${agent}.stuck-warned`))) {
      const sinceS = Number(readWaitFile(sd, agent, `${agent}.stuck-since`));
      // A missing or non-numeric .stuck-since keeps the agent working (never
      // a false warning).
      if (Number.isFinite(sinceS) && (nowS - sinceS) >= limitMin * 60) {
        warn(`agent '${agent}' has shown the same screen (apart from counters) for ${Math.floor((nowS - sinceS) / 60)} min while working; it may be stuck in one tool call. Inspect: herdr agent read ${agent} --source recent-unwrapped --lines 60`);
        fs.writeFileSync(path.join(sd, 'wait', `${agent}.stuck-warned`), '');
      }
    }
  }
  if (st.state !== 'working') {
    const qtext = agentRead(env, agent, { source: 'visible', lines: 20 });
    const q = quotaDetect(st.state, qtext);
    if (q) {
      // `printf '%s\n' "$(quota_detect …)"`: the command substitution strips
      // the trailing newlines, so an empty renewal leaves a one-line file.
      fs.writeFileSync(path.join(sd, 'wait', `${agent}.quota`), q[1] !== '' ? `${q[0]}\n${q[1]}\n` : `${q[0]}\n`);
      clearProviderMarks(); // a quota screen interrupts any provider confirmation
      return 'quota';
    }
    // Provider stop (after the quota, which always wins): the same screen,
    // read as recent-unwrapped (long lines arrive unbroken).
    const ptext = agentRead(env, agent, { source: 'recent-unwrapped', lines: 40 });
    const p = providerDetect(st.state, ptext);
    if (p) {
      // Double confirm, like blocked: the first detection records the
      // screen hash and the detected status in <agent>.provider and keeps
      // working; it acts only on the next probe when the hash AND the
      // status are the same. Any difference re-records the new detection.
      const target = `${String(cksumField(ptext))}\n${p.status}`;
      const prev = readWaitFile(sd, agent, `${agent}.provider`);
      if (prev !== target) {
        fs.rmSync(pfile, { force: true });
        fs.writeFileSync(pfile, `${target}\n`);
        return 'working';
      }
      // Confirmed: the same screen hash and status as the previous probe.
      fs.writeFileSync(path.join(sd, 'wait', `${agent}.provider-cause`), `${p.cause}\n`);
      if (p.status === 'provider-error') return 'provider-error';
      // Capacity is transient: at most provider_retries continue prompts,
      // each at least provider_retry_delay apart from the first
      // confirmation (the .capacity-at epoch-s marker).
      let used = 0;
      const usedRaw = readWaitFile(sd, agent, `${agent}.capacity-retries`);
      if (usedRaw !== null) {
        // A counter that exists but is not an integer fails closed, like
        // the .approvals counter: treat it as exhausted.
        if (!/^\s*[0-9]+\s*$/.test(usedRaw)) return 'capacity';
        used = Number(usedRaw.trim());
      }
      const limit = Number(cfg(ctx, 'provider_retries', '3', env));
      if (!Number.isFinite(limit) || used >= limit) return 'capacity';
      const atRaw = readWaitFile(sd, agent, `${agent}.capacity-at`);
      if (atRaw === null) {
        fs.writeFileSync(atFile, `${Math.floor(Date.now() / 1000)}\n`);
        return 'working';
      }
      const delay = Number(cfg(ctx, 'provider_retry_delay', '60', env));
      const at = Number(atRaw);
      const nowS = Math.floor(Date.now() / 1000);
      // Bash `[ $((now_s - since)) -ge "$grace" ]`: a non-numeric operand
      // fails the test and the agent keeps working.
      if (!(Number.isFinite(at) && Number.isFinite(delay) && (nowS - at) >= delay)) return 'working';
      const report = lastReport(sd, agent);
      const sent = agentPrompt(agent,
        `The model provider was at capacity and your last request failed. Continue the task from where you stopped; do not redo finished steps. When finished, write your report to ${report} and reply with only that path.`,
        env);
      if (!sent.ok) {
        // The continue never left: warn and act as if exhausted.
        warn(`provider capacity: failed to send the continue to '${agent}': ${sanitizeCause(sent.raw) || 'unknown error'}; acting as exhausted`);
        return 'capacity';
      }
      fs.writeFileSync(path.join(sd, 'wait', `${agent}.capacity-retries`), `${used + 1}\n`);
      fs.rmSync(atFile, { force: true });
      fs.rmSync(pfile, { force: true });
      warn(`provider capacity: sent continue #${used + 1} of ${limit} to '${agent}': ${p.cause}`);
      return 'working';
    }
    clearProviderMarks();
  }
  const hash = String(cksumField(visibleScreen()));
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

// One order for a multi-agent wait: 4 unavailable > 11 quota >
// 14 provider-error or capacity > 15 not-received > 7 blocked >
// 6 gone or settled. The argument order must not turn a quota into a
// blocked or a gone.
export function waitRank(code) {
  switch (String(code)) {
    case '4': return 6;
    case '11': return 5;
    case '14': return 4;
    case '15': return 3;
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
// rc 0 when every agent settles, 4/11/14/15/7/6 by rank otherwise, 9 on
// timeout (with a `timeout` line for each pending agent). Synchronous: the sleep
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
        case 'question': {
          const q = readWaitFile(sd, a, `${a}.question`) ?? '';
          jsonLine({ agent: a, status: 'question', report: r, question: q }, sink);
          warn(`agent '${a}' asked a question; nobody answers it automatically. Ask the user, then answer with herdr agent send-keys/prompt, or release the worker.`);
          rc = waitRaise(rc, 7);
          break;
        }
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
        case 'not-received':
          jsonLine({ agent: a, status: 'not-received', report: r }, sink);
          warn(`prompt to '${a}' never reached it: read the pane (herdr agent read ${a} --source visible), then dispatch again`);
          rc = waitRaise(rc, 15);
          break;
        case 'provider-error':
        case 'capacity': {
          const cause = readWaitFile(sd, a, `${a}.provider-cause`) ?? '';
          const f = rosterLine(sd, a).split('\t');
          const kind = f[2] ?? '';
          const model = f.length >= 9 ? (f[8] ?? '') : '';
          let lane = f.length >= 12 ? (f[11] ?? '') : '';
          const roleNow = f[3] ?? '';
          if (lane === '') lane = laneOfRole(ctx, roleNow, env);
          if (tag === 'provider-error') {
            jsonLine({ agent: a, status: 'provider-error', report: r, lane, kind, model, cause }, sink);
            warn(`provider error: agent '${a}' lane=${lane || '?'} kind=${kind} model=${model || '?'} : ${cause}`);
          } else {
            const retryRaw = readWaitFile(sd, a, `${a}.capacity-retries`);
            const retries = retryRaw !== null && /^\s*[0-9]+\s*$/.test(retryRaw) ? Number(retryRaw.trim()) : 0;
            jsonLine({ agent: a, status: 'capacity', report: r, lane, kind, model, cause, retries }, sink);
            warn(`provider capacity: agent '${a}' lane=${lane || '?'} kind=${kind} model=${model || '?'} : ${cause}`);
          }
          rc = waitRaise(rc, 14);
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
// 11 quota · 14 provider-error|capacity · 15 not-received ·
// 7 blocked (or a question) · 6 settled-no-report|gone · 9 timeout.
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
