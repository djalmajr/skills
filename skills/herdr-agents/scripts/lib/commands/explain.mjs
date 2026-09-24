// `explain` (slice 7d of the bash port): what the team is doing right now,
// as human text (never JSON). Port of the original bash implementation :4132-4165
// (explain_state_dir), :4167-4205 (explain_activity), :4207-4229
// (explain_collect_rows), :4231-4253 (explain_recommendation),
// :4255-4273 (explain_print_running), :4275-4281 (explain_idle_paragraph)
// and :4283-4300 (cmd_explain).
//
// The bash resolves the state dir by calling `herdr pane current` once to
// check and once inside `state_dir`; the JS follows the same call shape
// (findExecutable + runCli, then stateDir → workspaceId) through the
// already-ported client. A missing herdr just means there is nothing to
// describe. The bash's mktemp scratch file is not observable (created and
// removed within the call); the JS builds the rows in memory.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DieError, stateRootPath } from '../config.mjs';
import { laneAttr, laneNames, laneOfRole, lanesEnabled, panesValue } from '../lanes.mjs';
import { findExecutable, readTextFile, runCli } from '../platform.mjs';
import { stateDir, lastReport } from '../state.mjs';
import { agentRead, agentState } from '../herdr.mjs';
import { quotaDetect } from '../quota.mjs';

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// A roster row (a line that is neither a `#` comment nor blank) — a
// header-only agents.tsv never started an agent.
function rosterHasRow(tsv) {
  let raw;
  try { raw = readTextFile(tsv); } catch { return false; }
  for (const line of raw.split('\n')) {
    if (line.startsWith('#')) continue;
    if (line.replace(/\s/g, '') !== '') return true;
  }
  return false;
}

// explain_state_dir port (:4132): { rc, sd } — rc 0 with the state dir when
// one is resolvable (HERDR_WORKSPACE_ID, the current pane, or the only
// workspace with a roster row); rc 1 when no roster is anywhere; rc 2 when
// several workspaces have one and none is current (the caller must not
// claim that nothing is running).
export function explainStateDir(ctx, env = process.env, cwd = process.cwd()) {
  if (env.HERDR_WORKSPACE_ID) {
    try { return { rc: 0, sd: stateDir(ctx, env, cwd) }; } catch { return { rc: 1, sd: '' }; }
  }
  if (findExecutable('herdr', env)) {
    const r = runCli('herdr', ['pane', 'current', '--current'], { env, timeoutMs: 30_000 });
    if (r.status === 0) {
      try { return { rc: 0, sd: stateDir(ctx, env, cwd) }; } catch { return { rc: 1, sd: '' }; }
    }
  }
  const root = stateRootPath(ctx, env, cwd);
  if (!isDir(root)) return { rc: 1, sd: '' };
  // An unreadable root lists nothing, like bash `find … 2>/dev/null`.
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { entries = []; }
  let count = 0;
  let only = '';
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const tsv = path.join(root, e.name, 'agents.tsv');
    if (!rosterHasRow(tsv)) continue;
    count += 1;
    only = path.join(root, e.name);
  }
  if (count === 1) return { rc: 0, sd: only };
  if (count === 0) return { rc: 1, sd: '' };
  return { rc: 2, sd: '' };
}

// explain_activity <name> <sd> port (:4167): one human phrase. A finished
// report (the recorded path exists and is non-empty — the bash `-s` check
// on the cat'ed content) is idle. working wins over a report that is still
// missing. Quota is only considered when the agent is not working,
// blocked, gone or unavailable.
export function explainActivity(name, sd, ctx, env = process.env, cwd = process.cwd()) {
  const report = lastReport(sd, name);
  let reportUsable = false;
  if (report !== '') {
    try { reportUsable = fs.statSync(report).size > 0; } catch { reportUsable = false; }
  }
  if (report !== '' && reportUsable) return 'idle';
  if (!findExecutable('herdr', env)) {
    return report !== '' ? 'waiting for report' : 'idle';
  }
  const orig = agentState(name, env).state;
  if (orig === 'working') return 'working';
  if (orig !== 'blocked' && orig !== 'gone' && orig !== 'unavailable') {
    const qtext = agentRead(env, name, { source: 'visible', lines: 20 });
    if (quotaDetect(orig, qtext)) return 'out of quota';
  }
  if (report !== '') return 'waiting for report';
  switch (orig) {
    case 'idle':
    case 'done':
    case '':
      return 'idle';
    case 'blocked':
      return 'waiting for approval';
    case 'gone':
      return 'closed';
    case 'unavailable':
      return 'state unknown';
    default:
      return orig;
  }
}

// explain_collect_rows port (:4207): one TSV row per roster row —
// lane<TAB>role<TAB>kind<TAB>model<TAB>activity, with the file's lane
// column 12, the lane of the role, then the name as fallbacks, and
// default / unspecified for the empty fields.
export function explainCollectRows(sd, ctx, env = process.env, cwd = process.cwd()) {
  const rows = [];
  let raw;
  try { raw = readTextFile(path.join(sd, 'agents.tsv')); } catch { return rows; }
  for (const line of raw.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const f = line.split('\t');
    const name = f[0] ?? '';
    if (name === '') continue;
    const kind = f[2] ?? '';
    const role = f[3] ?? '';
    const model = f[8] ?? '';
    let lane = f[11] ?? '';
    if (lane === '') lane = laneOfRole(ctx, role, env);
    if (lane === '') lane = name;
    rows.push([
      lane,
      role === '' ? 'unspecified' : role,
      kind === '' ? 'unspecified' : kind,
      model === '' ? 'default' : model,
      explainActivity(name, sd, ctx, env, cwd),
    ]);
  }
  return rows;
}

// explain_recommendation port (:4231): the 3-vs-4 panels paragraph, the
// lanes=off note, and the `Chosen for <lane>: …` lines.
export function explainRecommendation(ctx, env = process.env) {
  const out = [];
  if (panesValue(ctx, env) === '3') {
    out.push('Recommendation: 3 panels - one writes code, and one takes turns researching and reviewing. Lighter on quota. 4 panels run research, implementation, and review at the same time.');
  } else {
    out.push('Recommendation: 4 panels - research, implementation, and review at the same time. Uses more quota. 3 panels are the lighter choice.');
  }
  if (!lanesEnabled(ctx, env)) {
    out.push('Each agent keeps its own assistant instead of sharing one panel.');
    return out;
  }
  for (const lane of laneNames(ctx, env)) {
    if (lane === '') continue;
    const kind = laneAttr(ctx, lane, 'kind', undefined, env);
    if (kind === '') continue;
    const model = laneAttr(ctx, lane, 'model', undefined, env);
    out.push(model !== '' ? `Chosen for ${lane}: ${kind}, model ${model}.` : `Chosen for ${lane}: ${kind}.`);
  }
  return out;
}

const rowLine = (r) => `${r[0]}: ${r[1]}, ${r[2]}, model ${r[3]}, ${r[4]}`;

// explain_print_running port (:4255): `Panels: <n>.`, one line per lane in
// the preset order (a lane with no row is `not started`), the lanes outside
// the preset in roster order, then the recommendation.
export function explainPrintRunning(rows, ctx, env = process.env) {
  const out = [`Panels: ${panesValue(ctx, env)}.`];
  const lanes = laneNames(ctx, env);
  if (lanesEnabled(ctx, env)) {
    for (const lane of lanes) {
      if (lane === '') continue;
      const matches = rows.filter((r) => r[0] === lane);
      if (matches.length === 0) out.push(`${lane}: not started`);
      else for (const r of matches) out.push(rowLine(r));
    }
    const known = new Set(lanes);
    for (const r of rows) {
      if (!known.has(r[0])) out.push(rowLine(r));
    }
  } else {
    for (const r of rows) out.push(rowLine(r));
  }
  out.push('');
  out.push(...explainRecommendation(ctx, env));
  return out;
}

// explain_idle_paragraph port (:4275) — the fixed idle text.
export function explainIdleParagraph() {
  return ['herdr-agents runs a small team of agents in Herdr panels. You stay in this panel and lead. Each other panel is one agent with one job: researching, writing code, or reviewing. Those agents never commit or push. You can watch a panel or close it. Each assistant spends the quota of its own account. Nothing is running yet. To start, describe the work here. The first time, you are asked how many agents to open and which assistant each job should use, and nothing opens until you agree. Four panels are recommended when research, implementation, and review should happen at the same time; that uses more quota. Three panels are the lighter choice: one writes code, and one takes turns researching and reviewing.'];
}

// cmd_explain port (:4283): no arguments; the ambiguity message (rc 2)
// does not claim that nothing is running.
export function cmdExplain(args, ctx, env = process.env, cwd = process.cwd()) {
  if (args.length > 0) throw new DieError('explain: takes no arguments', 2);
  const { rc, sd } = explainStateDir(ctx, env, cwd);
  if (rc === 2) {
    process.stdout.write('Agents were started in more than one Herdr workspace, and this command is not running inside one of them, so it cannot tell which team you mean.\n');
    process.stdout.write('Run explain from a panel inside the workspace you are asking about.\n');
    return;
  }
  const rows = sd !== '' && isFile(path.join(sd, 'agents.tsv'))
    ? explainCollectRows(sd, ctx, env, cwd)
    : [];
  if (rows.length === 0) {
    for (const line of explainIdleParagraph()) process.stdout.write(`${line}\n`);
    return;
  }
  for (const line of explainPrintRunning(rows, ctx, env)) process.stdout.write(`${line}\n`);
}
