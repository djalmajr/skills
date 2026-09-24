// Client for the `herdr` CLI (port slice 3). Every call goes through
// runCli (never `shell: true`) with a timeout. The JSON read and the
// `agent_state` classification follow spec section 4.1 exactly:
// `gone` only for `agent_not_found`; every other failed `herdr agent get`
// is `unavailable` with a sanitized cause — never `gone`. `agentState`
// never throws, so command substitutions stay safe.
import { die, runCli, findExecutable } from './platform.mjs';
import { sanitizeCause } from './text.mjs';

// A ceiling for every `herdr` call (decision: the bash script left these
// calls untimed and hung with a stuck server; 30 s is generous for a local
// CLI). A timed-out call is a herdr failure: liveAgents dies 4 with a
// message, agentState is `unavailable` with a timeout cause, the best-effort
// reads fall back as on any other failure. The parameter exists for tests.
export const HERDR_TIMEOUT_MS = 30_000;
const timedOutMsg = (what, ms) => `herdr ${what} timed out after ${ms / 1000}s`;

// jq `// empty` for a string field: null/false/absent → '', else String.
function strOrEmpty(v) {
  return v === undefined || v === null || v === false ? '' : String(v);
}

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

// ---------- slice 5a: pane layout, tabs, split and focus (spec 4.1) ----------

// herdr pane layout (--current or --pane <id>) → the raw runCli result.
// Best-effort callers read `r.stdout ?? ''` (the bash call sites discard
// stderr and ignore the exit code); cmd_layout_plan checks the status and
// dies 4 `pane layout failed`.
export function paneLayout(env = process.env, paneId = '') {
  const args = paneId ? ['pane', 'layout', '--pane', paneId] : ['pane', 'layout', '--current'];
  return runCli('herdr', args, { env, timeoutMs: HERDR_TIMEOUT_MS });
}

// herdr tab get <tab> → { ok, label, root }: ok = rc 0 (the callers prune
// the dead tabs); label = .result.tab.label ('' when null/absent, like jq
// `.result.tab.label // empty`); root = .result.root_pane.pane_id — the
// split anchor stand-in when the tab shows no pane in the list.
export function tabGet(tab, env = process.env) {
  const r = runCli('herdr', ['tab', 'get', tab], { env, timeoutMs: HERDR_TIMEOUT_MS });
  const ok = !r.notFound && r.status === 0;
  let out = null;
  try { out = JSON.parse(r.stdout ?? ''); } catch { out = null; }
  const res = out && typeof out === 'object' ? out.result : undefined;
  return {
    ok,
    label: strOrEmpty(res?.tab?.label),
    root: strOrEmpty(res?.root_pane?.pane_id),
  };
}

// herdr tab rename <tab> <label> → true on rc 0 (the caller decides warn
// vs die, exactly as the bash call sites do).
export function tabRename(tab, label, env = process.env) {
  const r = runCli('herdr', ['tab', 'rename', tab, label], { env, timeoutMs: HERDR_TIMEOUT_MS });
  return !r.notFound && r.status === 0;
}

// herdr tab create --workspace <ws> --cwd <cwd> --label <label> --no-focus
// → { ok, tab, root } (tab = .result.tab.tab_id, root =
// .result.root_pane.pane_id, '' when absent from the JSON).
export function tabCreate(env, ws, cwd, label) {
  const r = runCli('herdr', ['tab', 'create', '--workspace', ws, '--cwd', cwd, '--label', label, '--no-focus'], { env, timeoutMs: HERDR_TIMEOUT_MS });
  let out = null;
  try { out = JSON.parse(r.stdout ?? ''); } catch { out = null; }
  const res = out && typeof out === 'object' ? out.result : {};
  return { ok: !r.notFound && r.status === 0, tab: strOrEmpty(res?.tab?.tab_id), root: strOrEmpty(res?.root_pane?.pane_id) };
}

// herdr pane split <anchor> --direction <d> --cwd <cwd> --no-focus
// [--ratio <f>] → { ok, pane } (the new pane id, '' when absent from the
// JSON). The ratio is only passed when given (spawn's `--ratio`).
export function paneSplit(anchor, direction, cwd, env = process.env, ratio) {
  const args = ['pane', 'split', anchor, '--direction', direction, '--cwd', cwd, '--no-focus'];
  if (ratio !== undefined && ratio !== null && ratio !== '') args.push('--ratio', String(ratio));
  const r = runCli('herdr', args, { env, timeoutMs: HERDR_TIMEOUT_MS });
  let out = null;
  try { out = JSON.parse(r.stdout ?? ''); } catch { out = null; }
  const pane = out && typeof out === 'object' ? out?.result?.pane : undefined;
  return { ok: !r.notFound && r.status === 0, pane: strOrEmpty(pane?.pane_id) };
}

// herdr agent get <caller pane> → the agent name of the pane (the bash
// caller_agent_name, :1507): '' on any failure or a missing field.
export function callerAgentName(env = process.env) {
  const r = runCli('herdr', ['agent', 'get', env.HERDR_PANE_ID ?? ''], { env, timeoutMs: HERDR_TIMEOUT_MS });
  if (r.notFound || r.status !== 0) return '';
  let out = null;
  try { out = JSON.parse(r.stdout ?? ''); } catch { out = null; }
  return strOrEmpty(out && typeof out === 'object' ? out?.result?.agent?.name : undefined);
}

// herdr agent focus <agent> / herdr pane focus --direction <d> --pane <p>
// — the best-effort focus returns of restore_focus_if_stolen.
export function agentFocus(agent, env = process.env) {
  const r = runCli('herdr', ['agent', 'focus', agent], { env, timeoutMs: HERDR_TIMEOUT_MS });
  return !r.notFound && r.status === 0;
}

export function paneFocusBack(direction, pane, env = process.env) {
  const r = runCli('herdr', ['pane', 'focus', '--direction', direction, '--pane', pane], { env, timeoutMs: HERDR_TIMEOUT_MS });
  return !r.notFound && r.status === 0;
}
