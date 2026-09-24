// The `clean` command (port slice 6a). Port of
// the original bash implementation :4084-4099: drops the roster rows of agents that
// are no longer live in `herdr agent list` (and their last-report/wait
// files), then removes briefs/reports older than N days that no
// `last-report-*` file still points at. A failed `agent list` passes
// herdr's own output through and exits with herdr's code (liveAgents).
import fs from 'node:fs';
import path from 'node:path';
import { stateDir, rosterRows, rosterRemove, lastReportPath, dieFriction } from '../state.mjs';
import { liveAgents } from '../herdr.mjs';

// `clean [--older-than DAYS]` (default 7) → rc 0.
export function cmdClean(argv, ctx, env = process.env, cwd = process.cwd()) {
  let days = '7';
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--older-than') {
      const v = argv[i + 1];
      if (v === undefined) dieFriction('clean: --older-than expects a value', 2);
      days = v;
      i += 1;
    } else {
      dieFriction(`clean: unknown option ${a}`, 2);
    }
  }
  const sd = stateDir(ctx, env, cwd);
  const live = liveAgents(env);
  for (const l of rosterRows(sd)) {
    const f = l.split('\t');
    const name = f[0] ?? '';
    if (name === '') continue;
    const pane = f[1] ?? '';
    if (!live.some((x) => x && ((x.name ?? '') === name || x.pane_id === pane))) {
      rosterRemove(sd, name);
      fs.rmSync(lastReportPath(sd, name), { force: true });
      const waitDir = path.join(sd, 'wait');
      for (const w of fs.readdirSync(waitDir)) {
        if (w.startsWith(`${name}.`)) fs.rmSync(path.join(waitDir, w), { force: true });
      }
      process.stdout.write(`dropped gone agent ${name}\n`);
    }
  }
  // `keep`: the concatenation of every last-report-* file (sorted, like
  // the glob); a path it contains is never removed.
  let keep = '';
  try {
    for (const w of fs.readdirSync(sd).sort()) {
      if (!w.startsWith('last-report-')) continue;
      try { keep += fs.readFileSync(path.join(sd, w), 'utf8'); } catch { /* unreadable */ }
    }
  } catch { /* no state dir? stateDir created it */ }
  // Only a whole number of days selects files: `find -mtime +<bad>` (empty,
  // negative, fractional, text) errors out and deletes nothing.
  const daysNum = /^[0-9]+$/.test(String(days)) ? Number(days) : NaN;
  const now = Date.now();
  let removed = 0;
  const walk = (dir, out) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (e.isFile()) out.push(p);
    }
  };
  const files = [];
  walk(path.join(sd, 'briefs'), files);
  walk(path.join(sd, 'reports'), files);
  for (const p of files) {
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    // `find -mtime +N`: the file's age in whole 24-h periods (truncated)
    // must be strictly greater than N. A non-numeric N never matches
    // (find's error removed the files, leaving nothing to delete).
    if (!Number.isFinite(daysNum) || Math.floor((now - st.mtimeMs) / 86400000) <= daysNum) continue;
    if (keep.includes(p)) continue;
    fs.rmSync(p, { force: true });
    removed += 1;
  }
  process.stdout.write(`removed ${removed} files older than ${days} days under ${sd}\n`);
}
