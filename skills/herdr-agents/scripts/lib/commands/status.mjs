// The `status` command (moved out of lib/state.mjs in slice 4 so that
// state no longer imports lanes/quota). Port of
// the original bash implementation :3671-3727: one TSV line per agent, JSON for
// quota, rc 0 / 4 (unavailable) / 11 (quota). `done` and `unknown-agent`
// never consult herdr; quota is only considered when the agent is not
// working.
import fs from 'node:fs';
import { stateDir, rosterLine, lastReport, warn, dieFriction } from '../state.mjs';
import { agentState, agentRead } from '../herdr.mjs';
import { laneOfRole } from '../lanes.mjs';
import { quotaDetect } from '../quota.mjs';

// `done` requires the recorded report file to exist and be non-empty
// (bash `[ -s "$r" ]`), not just the path to be recorded.
function reportNonEmpty(p) {
  if (!p) return false;
  try { return fs.statSync(p).size > 0; } catch { return false; }
}

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
