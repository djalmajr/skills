// The `roster` command (moved out of lib/state.mjs in slice 4). Port of
// the original bash implementation :3876-3902: the NAME/ROLE/KIND/PANE/TAB/STATE/
// REPORT/CWD table, the other live agents, and the config footer.
import fs from 'node:fs';
import { cfg } from '../config.mjs';
import { stateDir, rosterRows, lastReport, workspaceId } from '../state.mjs';
import { liveAgents, paneList, tabList } from '../herdr.mjs';

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
    const cwdCol = f[6] ?? '';
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
    process.stdout.write(`${pad(name, 20)} ${pad(roleCell, 18)} ${pad(kind, 8)} ${pad(pane, 8)} ${pad(tabOf(pane), 16)} ${pad(state, 9)} ${pad(rep, 16)} ${cwdCol}\n`);
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
