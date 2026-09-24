// The `collect` command (port slice 6a). Port of
// the original bash implementation :4004-4017: a ready report is printed under its
// `<!-- report: <path> -->` marker (rc 0); otherwise an unqueryable roster
// worker warns and exits 4 (no terminal fallback), and the rest falls back
// to `herdr agent read --source recent-unwrapped --lines <N>` (rc 6). The
// `${1:?agent}` parameter error is bash's builtin (exit 1, no friction
// entry), so it uses plain die, not dieFriction.
import fs from 'node:fs';
import { die, runCli } from '../platform.mjs';
import { stateDir, rosterLine, lastReport, warn, dieFriction } from '../state.mjs';
import { agentState, HERDR_TIMEOUT_MS } from '../herdr.mjs';

// `done` requires the recorded report file to exist and be non-empty
// (bash `[ -s "$r" ]`), not just the path to be recorded.
function reportNonEmpty(p) {
  if (!p) return false;
  try { return fs.statSync(p).size > 0; } catch { return false; }
}

// `collect <agent> [--lines N]` (default 120) → rc 0 (report), 4
// (unavailable), 6 (fallback) — or herdr's own code when the fallback read
// fails (bash `set -e` passes it through).
export function cmdCollect(argv, ctx, env = process.env, cwd = process.cwd()) {
  const agent = argv[0];
  if (agent === undefined) die('agent: Parameter not set', 1);
  let lines = 120;
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--lines') {
      const v = argv[i + 1];
      if (v === undefined) dieFriction('collect: --lines expects a value', 2);
      lines = v;
      i += 1;
    } else {
      dieFriction(`collect: unknown option ${a}`, 2);
    }
  }
  const sd = stateDir(ctx, env, cwd);
  const report = lastReport(sd, agent);
  if (report !== '' && reportNonEmpty(report)) {
    process.stdout.write(`<!-- report: ${report} -->\n`);
    process.stdout.write(fs.readFileSync(report, 'utf8')); // `cat`
    return 0;
  }
  if (rosterLine(sd, agent) !== '') {
    const st = agentState(agent, env);
    if (st.state === 'unavailable') {
      warn(`no report file yet for '${agent}', and herdr agent get failed: ${st.cause}. The worker may still be live.`);
      return 4;
    }
  }
  warn(`no report file yet for '${agent}' (expected ${report || '<none dispatched>'}); falling back to recent terminal output`);
  const r = runCli('herdr', ['agent', 'read', agent, '--source', 'recent-unwrapped', '--lines', String(lines)], { env, timeoutMs: HERDR_TIMEOUT_MS });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.notFound) die('herdr CLI not found in PATH', 2);
  if (r.status !== 0) return r.status ?? 1;
  return 6;
}
