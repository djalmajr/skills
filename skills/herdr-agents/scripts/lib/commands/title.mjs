// The `title` command: sets the
// orchestrator pane's title to `orchestrator: <objective>` (the literal
// `orchestrator` prefix, never the agent name). All positional arguments
// are joined with one space (`title porte JS` = `title "porte JS"`); the
// normalization turns newlines and tabs into a space, trims the edges, and
// cuts the objective at 60 code points after the prefix (no ellipsis).
// `--clear` clears the title (paneTitle null) and takes no objective. The pane id is
// HERDR_PANE_ID. A living command: the entry applies require_env and the
// friction log. Reuses paneTitle (herdr.mjs) for the write.
import { paneTitle } from '../herdr.mjs';
import { dieFriction } from '../state.mjs';

// Normalization (decision): newlines and tabs become a space, the edges are
// trimmed, then the objective is cut at 60 code points (Array.from counts
// code points, not UTF-16 units) without an ellipsis.
export function normalizeObjective(text) {
  const s = String(text).replace(/[\r\t\n]/g, ' ').trim();
  return Array.from(s).slice(0, 60).join('');
}

// `title <objective>… | --clear` → the JSON {"pane_id","title"} on stdout
// (same 2-space pretty as the other commands) and exit 0; 2 for a missing
// objective, an objective given with --clear, or an unknown option; 4 when
// `report-metadata` fails.
export function cmdTitle(argv, ctx, env = process.env) {
  let clear = false;
  const rest = [];
  for (const a of argv) {
    if (a === '--clear') clear = true;
    else if (a.startsWith('--')) dieFriction(`title: unknown option ${a}`, 2);
    else rest.push(a);
  }
  const pane = env.HERDR_PANE_ID ?? '';
  if (clear) {
    if (rest.length > 0) dieFriction('title: --clear takes no objective', 2);
    if (!paneTitle(pane, null, env)) dieFriction('title: herdr pane report-metadata failed', 4);
    process.stdout.write(`${JSON.stringify({ pane_id: pane, title: '' }, null, 2)}\n`);
    return;
  }
  const objective = normalizeObjective(rest.join(' '));
  if (objective === '') dieFriction('title: give the current objective, or --clear', 2);
  const title = `orchestrator: ${objective}`;
  if (!paneTitle(pane, title, env)) dieFriction('title: herdr pane report-metadata failed', 4);
  process.stdout.write(`${JSON.stringify({ pane_id: pane, title }, null, 2)}\n`);
}
