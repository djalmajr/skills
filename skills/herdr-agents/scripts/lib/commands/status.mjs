// The `status` command (moved out of lib/state.mjs in slice 4 so that
// state no longer imports lanes/quota). Port of
// the original bash implementation :3671-3727: one TSV line per agent,
// JSON for quota, for a provider stop and for a blocked worker whose
// screen is a decision question (S5 item 2: status `question` with the
// text, rc 7 instead of the blocked TSV line), rc 0 / 4 (unavailable) /
// 7 (question) / 11 (quota) / 14 (provider-error or capacity) /
// 15 (not-received: a dispatch ended not-received and the agent is not
// working or blocked and its state_change_seq has not moved since the
// marker — read-only, the wait is the one that retries the Enter).
// `done`
// and `unknown-agent` never consult herdr; quota is only considered when
// the agent is not working, and always wins over the provider detection;
// the provider gets one probe only — no double confirm, no continue.
import fs from 'node:fs';
import path from 'node:path';
import { stateDir, rosterLine, lastReport, warn, dieFriction } from '../state.mjs';
import { agentState, agentRead, liveAgents } from '../herdr.mjs';
import { laneOfRole } from '../lanes.mjs';
import { quotaDetect } from '../quota.mjs';
import { providerDetect } from '../provider.mjs';
import { dialogKind, questionText } from '../dialog.mjs';
import { waitRank } from '../wait.mjs';
import { markerSeqChanged } from '../arrival.mjs';

// True when a live agent with this name exists and none of them sits in
// `pane` (a herdr failure keeps the direct query: false).
function nameAliveInOtherPane(name, pane, env) {
  let agents;
  try { agents = liveAgents(env); } catch { return false; }
  const ps = agents.filter((x) => x && (x.name ?? '') === name)
    .map((x) => (x.pane_id !== undefined && x.pane_id !== null ? String(x.pane_id) : ''));
  return ps.length > 0 && !ps.includes(pane);
}

// `done` requires the recorded report file to exist and be non-empty
// (bash `[ -s "$r" ]`), not just the path to be recorded.
function reportNonEmpty(p) {
  if (!p) return false;
  try { return fs.statSync(p).size > 0; } catch { return false; }
}

// The not-received marker's content ('' when unreadable): read-only — this
// command never drops a marker (the wait is the one that does).
function readMarker(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

export function cmdStatus(argv, ctx, env = process.env, cwd = process.cwd()) {
  if (argv.length === 0) dieFriction('status: give at least one agent name (herdr-agents roster lists them all)', 2);
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
    let question = '';
    let provider = null;
    if (reportNonEmpty(r)) {
      state = 'done';
    } else if (!rosterLine(sd, a)) {
      state = 'unknown-agent';
    } else {
      const linePane = rosterLine(sd, a).split('\t')[1] ?? '';
      const st = agentState(a, env);
      state = st.state;
      cause = st.cause;
      const orig = state;
      // A line whose name is alive in ANOTHER pane is stale: the agent it
      // recorded (the line's pane) is gone — report gone, not the other
      // agent's state (a line without a known pane keeps the name query,
      // any pane).
      const stale = linePane !== '' && state !== 'gone' && state !== 'unavailable'
        && nameAliveInOtherPane(a, linePane, env);
      if (stale) { state = 'gone'; cause = ''; }
      if (state === 'idle' || state === 'done') state = 'no-report-yet';
      if (state === 'unavailable') {
        if (rc !== 11) rc = 4;
        warn(`agent '${a}': herdr agent get failed: ${cause}`);
      } else if (!stale && fs.existsSync(path.join(sd, 'wait', `${a}.not-received`))
        && orig !== 'working' && orig !== 'blocked'
        && !markerSeqChanged(readMarker(path.join(sd, 'wait', `${a}.not-received`)), st.seq)) {
        // A dispatch that ended not-received recorded the moment and the
        // agent's state_change_seq; this command only reads the marker — it
        // never sends a key and never drops it (the wait is the one that
        // retries the Enter). A seq that moved means the agent changed
        // state since, so the marker is stale and the normal status holds.
        state = 'not-received';
        // rc 15 sits below 4, 11 and 14 and above 7 and 6 (the global
        // wait rank).
        if (waitRank(15) > waitRank(rc)) rc = 15;
      } else if (!stale && orig === 'blocked') {
        // A blocked worker whose visible screen is a decision question is
        // reported as `question` (rc 7) with the text, not blocked (one
        // probe only, like the provider stop).
        const kindNow = rosterLine(sd, a).split('\t')[2] ?? '';
        const visible = agentRead(env, a, { source: 'visible', lines: 40 });
        if (dialogKind(kindNow, visible) === 'question') {
          question = questionText(visible);
          // rc 7 sits below 11 and 14 and above 0 (the global wait rank).
          if (waitRank(7) > waitRank(rc)) rc = 7;
        }
      } else if (!stale && orig !== 'working' && orig !== 'gone' && orig !== 'blocked' && orig !== 'unavailable') {
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
        } else {
          // Provider stop: one probe only (no double confirm, no
          // continue prompt), the same recent-unwrapped 40-line screen.
          const ptext = agentRead(env, a, { source: 'recent-unwrapped', lines: 40 });
          const p = providerDetect(orig, ptext);
          if (p) {
            provider = p;
            // rc 14 sits below 11 and above 0 — the global wait rank also
            // keeps it below 4 (unavailable).
            if (waitRank(14) > waitRank(rc)) rc = 14;
          }
        }
      }
    }
    if (quota) {
      process.stdout.write(JSON.stringify({ agent: a, status: 'quota', report: r, lane, kind, model, match, renewal }) + '\n');
    } else if (provider) {
      process.stdout.write(JSON.stringify({ agent: a, status: provider.status, report: r, cause: provider.cause }) + '\n');
    } else if (question !== '') {
      process.stdout.write(JSON.stringify({ agent: a, status: 'question', report: r, question }) + '\n');
    } else if (cause) {
      process.stdout.write(`${a}\t${state}\t${r}\t${cause}\n`);
    } else {
      process.stdout.write(`${a}\t${state}\t${r}\n`);
    }
  }
  return rc;
}
