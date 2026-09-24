// Client for the `herdr` CLI (port slice 3). Every call goes through
// runCli (never `shell: true`) with a timeout. The JSON read and the
// `agent_state` classification follow spec section 4.1 exactly:
// `gone` only for `agent_not_found`; every other failed `herdr agent get`
// is `unavailable` with a sanitized cause — never `gone`. `agentState`
// never throws, so command substitutions stay safe.
import { die, runCli, findExecutable } from './platform.mjs';
import { sanitizeCause } from './state.mjs';

// A ceiling for every `herdr` call (decision: the bash script left these
// calls untimed and hung with a stuck server; 30 s is generous for a local
// CLI). A timed-out call is a herdr failure: liveAgents dies 4 with a
// message, agentState is `unavailable` with a timeout cause, the best-effort
// reads fall back as on any other failure. The parameter exists for tests.
const HERDR_TIMEOUT_MS = 30_000;
const timedOutMsg = (what, ms) => `herdr ${what} timed out after ${ms / 1000}s`;

// require_env() port. Decision 5 (orchestrator): `jq` is no longer a
// requirement, so the `jq is required` check is gone; HERDR_ENV and the
// herdr CLI still are.
export function requireEnv(env = process.env) {
  if (env.HERDR_ENV !== '1') die('not running inside Herdr (HERDR_ENV != 1); refusing to control a session from outside', 2);
  if (!findExecutable('herdr', env)) die('herdr CLI not found in PATH', 2);
}

// herdr agent list → .result.agents (array of {name, pane_id, agent_status,
// agent}). Mirrors `live_agents_json`: on a herdr failure the CLI's own
// output is passed through and the caller's exit code is herdr's (bash
// `set -e` on the pipeline), with no extra message.
export function liveAgents(env = process.env, timeoutMs = HERDR_TIMEOUT_MS) {
  const r = runCli('herdr', ['agent', 'list'], { env, timeoutMs });
  if (r.notFound) die('herdr CLI not found in PATH', 2);
  if (r.timedOut) die(timedOutMsg('agent list', timeoutMs), 4);
  if (r.status !== 0) {
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    process.exit(r.status ?? 1);
  }
  let out = null;
  try { out = JSON.parse(r.stdout || ''); } catch { out = null; }
  const agents = out && typeof out === 'object' ? out?.result?.agents : undefined;
  return Array.isArray(agents) ? agents : [];
}

// herdr pane list --workspace <ws> → .result.panes // []. The bash call
// discards stderr and falls back to [] when anything fails.
export function paneList(env, ws) {
  const r = runCli('herdr', ['pane', 'list', '--workspace', ws], { env, timeoutMs: HERDR_TIMEOUT_MS });
  if (r.status !== 0) return [];
  try {
    const out = JSON.parse(r.stdout || '');
    const panes = out?.result?.panes;
    return Array.isArray(panes) ? panes : [];
  } catch { return []; }
}

// herdr tab list --workspace <ws> → .result.tabs // [].
export function tabList(env, ws) {
  const r = runCli('herdr', ['tab', 'list', '--workspace', ws], { env, timeoutMs: HERDR_TIMEOUT_MS });
  if (r.status !== 0) return [];
  try {
    const out = JSON.parse(r.stdout || '');
    const tabs = out?.result?.tabs;
    return Array.isArray(tabs) ? tabs : [];
  } catch { return []; }
}

// herdr agent read <agent> --source <s> [--lines N] → stdout text (best
// effort, '' when the call fails), like the bash `2>/dev/null || true`.
export function agentRead(env, agent, { source, lines } = {}) {
  const args = ['agent', 'read', agent, '--source', source];
  if (lines !== undefined) args.push('--lines', String(lines));
  const r = runCli('herdr', args, { env, timeoutMs: HERDR_TIMEOUT_MS });
  if (r.notFound || r.status !== 0) return '';
  return r.stdout;
}

// agent_state() port (bash :793-830, spec 4.1): runs `herdr agent get
// <target>` with stderr captured separately. Classification:
//   - stderr/stdout carrying JSON with .error.code == agent_not_found →
//     gone (the only `gone`);
//   - any other .error.code → unavailable, cause `<code>: <message>`;
//   - success without .result.agent.agent_status → unavailable, cause
//     `agent get returned no agent_status` (decision: kept, rc 4 upstream);
//   - failure without JSON → unavailable, cause sanitized stderr (or stdout
//     when stderr is empty), fallback `herdr agent get failed (exit <rc>)`.
// Always returns; never throws.
export function agentState(target, env = process.env, timeoutMs = HERDR_TIMEOUT_MS) {
  const r = runCli('herdr', ['agent', 'get', target], { env, timeoutMs });
  if (r.timedOut) return { state: 'unavailable', cause: timedOutMsg('agent get', timeoutMs) };
  // Bash exit code; 127 for a missing CLI.
  const rc = r.notFound ? 127 : r.status ?? 1;
  let raw = r.stderr ?? '';
  if (!raw) raw = r.stdout ?? '';
  let code = '';
  let msg = '';
  if (raw) {
    try {
      const j = JSON.parse(raw);
      if (j && typeof j === 'object' && j.error && typeof j.error === 'object') {
        const c = j.error.code;
        if (c !== null && c !== undefined && c !== false) {
          code = typeof c === 'string' ? c : String(c);
          const m = j.error.message;
          msg = m === null || m === undefined ? '' : typeof m === 'string' ? m : String(m);
        }
      }
    } catch { /* not JSON: no error code */ }
  }
  if (code === 'agent_not_found') return { state: 'gone', cause: '' };
  if (rc === 0 && !code) {
    let out = null;
    try { out = JSON.parse(r.stdout || ''); } catch { out = null; }
    const st = out && typeof out === 'object' ? out?.result?.agent?.agent_status : undefined;
    // jq -r '.result.agent.agent_status // empty': only null/false collapse.
    if (st !== undefined && st !== null && st !== false && st !== '') {
      return { state: String(st), cause: '' };
    }
    raw = 'agent get returned no agent_status';
  }
  if (code) {
    const cause = sanitizeCause(`${code}: ${msg}`);
    return { state: 'unavailable', cause: cause || `herdr agent get failed (exit ${rc})` };
  }
  if (!raw) raw = `herdr agent get failed (exit ${rc})`;
  const cause = sanitizeCause(raw);
  return { state: 'unavailable', cause: cause || `herdr agent get failed (exit ${rc})` };
}

// pane report-metadata (operator decision: every worker pane shows its
// current task). The pane id goes BEFORE the options (herdr 0.9.1 rejects
// `--source` first). `title` null clears it. Best effort: a herdr without
// report-metadata (or any failure) changes nothing and never throws.
export function paneTitle(pane, title, env = process.env) {
  const args = ['pane', 'report-metadata', pane, '--source', 'herdr-agents'];
  if (title === null) args.push('--clear-title');
  else args.push('--title', title);
  runCli('herdr', args, { env, timeoutMs: HERDR_TIMEOUT_MS });
}
