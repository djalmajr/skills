// The `stats` command: usage numbers of the workspace, computed from the
// state dir (the dispatch pairs and the roster) — no herdr needed.
//
// A task is one composed prompt: `briefs/<agent>-<ts>.md` in the state
// dir, or `<agent>-<ts>.brief.md` under the $TMPDIR routing; its pair is
// the report with the same `<agent>-<ts>` (the same-second collision
// suffix, when present, is part of the pair name).
//
// The role of a prompt is its `You are running as the `<role>` role`
// line; an amendment prompt (`# Amendment to your current brief`) has no
// such line and counts as an amendment of the role of the previous
// prompt of the same agent. The time of a task runs from the prompt
// mtime to the report mtime. A prompt without a report is `pending` when
// it is the last dispatch of an agent that is still in the roster (the
// report may still arrive), `lost` otherwise.
//
// `stats [--since <date>] [--json]`:
//   --since AAAA-MM-DD or ISO — keep only the prompts whose mtime is at
//   or after the date (an invalid date dies 2);
//   --json — one compact JSON object on stdout;
//   no dispatch pairs at all — `no dispatches recorded under <dir>`,
//   exit 0 (the message is printed even with --json).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stateDir, workspaceId, rosterRows, dieFriction } from '../state.mjs';
import { readTextFile } from '../platform.mjs';
import { partialCount, reviewHeader } from '../reportscan.mjs';
import { REVIEW_ROLES_ALL } from '../roles.mjs';

// The `<agent>-<ts>` pair of a prompt basename: the ts is the 15-char
// nowStamp (YYYYMMDDTHHMMSS), an optional same-second collision suffix
// (-2, -3…) comes after it, and the agent name — which may contain
// dashes — takes the rest (greedy, so the last ts wins).
const PAIR_RE = /^(.+)-(\d{8}T\d{6})(-\d+)?$/;
const ROLE_RE = /You are running as the `([^`]+)` role/;
const AMENDMENT_FIRST_LINE = '# Amendment to your current brief';

// `--since`: AAAA-MM-DD as local midnight, or a strict ISO 8601 — a date,
// `T`, a time with minutes and optional seconds, an optional fraction, an
// optional `Z` or ±HH(:MM) offset. The date, the time and the offset are
// range-checked by hand (the Date constructor rolls an out-of-range day
// over, e.g. 2026-02-30 → 2026-03-02). Anything else — a Date-constructor
// fallback format such as `DD/MM/YYYY` — is invalid. null otherwise.
const SINCE_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SINCE_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/;
// True when the UTC y/m/d is a real calendar date (no rollover).
function validYmd(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function parseSince(value) {
  const v = String(value);
  const dm = SINCE_DATE_RE.exec(v);
  if (dm) {
    const [y, m, d] = [Number(dm[1]), Number(dm[2]), Number(dm[3])];
    if (!validYmd(y, m, d)) return null;
    return new Date(y, m - 1, d);
  }
  const im = SINCE_ISO_RE.exec(v);
  if (im === null) return null;
  const [, y, mo, d, hh, mi, ss, , off] = im.map((g) => g ?? '');
  if (!validYmd(Number(y), Number(mo), Number(d))) return null;
  if (Number(hh) > 23 || Number(mi) > 59) return null;
  if (ss !== '' && Number(ss) > 59) return null;
  if (off !== '' && off !== 'Z') {
    const oh = Number(off.slice(1, 3));
    const om = Number(off.slice(off.length - 2));
    if (oh > 23 || om > 59) return null;
  }
  const dt = new Date(v);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

// Every dispatch pair of the workspace: the state-dir briefs and the
// $TMPDIR routing (where the prompt and its report sit together). Once the
// wait has mirrored a tmp pair into the state dir, both scans see the same
// <agent>-<ts> pair: it is counted once, the state-dir copy (scanned first)
// wins over the $TMPDIR original.
function collectPrompts(sd, tmpDir) {
  const pairs = [];
  const seen = new Set();
  const scan = (dir, kind) => {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { return; } // absent dir
    for (const f of entries) {
      if (kind === 'tmp' ? !f.endsWith('.brief.md') : !f.endsWith('.md')) continue;
      const base = kind === 'tmp' ? f.slice(0, -'.brief.md'.length) : f.slice(0, -'.md'.length);
      const m = PAIR_RE.exec(base);
      if (!m) continue;
      const key = `${m[1]}\t${m[2]}\t${m[3] ?? ''}`;
      if (seen.has(key)) continue; // the mirrored pair: the state-dir copy wins
      seen.add(key);
      let promptM = 0;
      try { promptM = fs.statSync(path.join(dir, f)).mtimeMs; } catch { continue; }
      pairs.push({
        agent: m[1],
        ts: m[2],
        suf: m[3] === undefined ? 1 : Number(m[3].slice(1)),
        prompt: path.join(dir, f),
        report: kind === 'tmp' ? path.join(dir, `${base}.md`) : path.join(sd, 'reports', `${base}.md`),
        promptM,
        amendment: false,
        role: '',
        roleResolved: '',
        hasReport: false,
        reportM: 0,
        minutes: null,
        partials: 0,
        header: null,
        noReport: '',
      });
    }
  };
  scan(path.join(sd, 'briefs'), 'state');
  scan(tmpDir, 'tmp');
  return pairs;
}

// Role, amendment flag, the paired report (mtime, [partial] count and the
// review header) of one prompt.
function promptMeta(p) {
  let text = '';
  try { text = readTextFile(p.prompt); } catch { text = ''; }
  p.amendment = text.split('\n')[0] === AMENDMENT_FIRST_LINE;
  const rm = ROLE_RE.exec(text);
  p.role = rm ? rm[1] : '';
  let st = null;
  try { st = fs.statSync(p.report); } catch { /* absent */ }
  p.hasReport = st !== null && st.size > 0;
  if (!p.hasReport) return;
  p.reportM = st.mtimeMs;
  p.minutes = (p.reportM - p.promptM) / 60000;
  let rt = '';
  try { rt = readTextFile(p.report); } catch { rt = ''; }
  p.partials = partialCount(rt);
  p.header = reviewHeader(rt);
}

function round1(n) {
  return Number(n.toFixed(1));
}

function median(list) {
  const s = [...list].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function minutesStats(list) {
  if (list.length === 0) return null;
  return {
    avg: round1(list.reduce((a, b) => a + b, 0) / list.length),
    median: round1(median(list)),
    max: round1(Math.max(...list)),
  };
}

function renderTable(headers, rows) {
  const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (cells) => cells.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ');
  return [fmt(headers), ...rows.map(fmt)].join('\n');
}

// `stats [--since <date>] [--json]` → 0.
export function cmdStats(argv, ctx, env = process.env, cwd = process.cwd()) {
  let sinceRaw = '';
  let asJson = false;
  for (let i = 0; i < (argv ?? []).length; i += 1) {
    const a = String(argv[i]);
    if (a === '--since') {
      const v = argv[i + 1];
      if (v === undefined) dieFriction('stats: --since expects a date', 2);
      sinceRaw = String(v);
      i += 1;
    } else if (a === '--json') {
      asJson = true;
    } else {
      dieFriction(`stats: unknown option ${a}`, 2);
    }
  }
  let since = null;
  if (sinceRaw !== '') {
    since = parseSince(sinceRaw);
    if (since === null) dieFriction(`stats: --since expects AAAA-MM-DD or an ISO date (got '${sinceRaw}')`, 2);
  }
  const sd = stateDir(ctx, env, cwd);
  const tmpDir = path.join(env.TMPDIR || os.tmpdir(), 'herdr-agents', workspaceId(ctx, env, cwd), 'reports');
  const pairs = collectPrompts(sd, tmpDir);
  if (pairs.length === 0) {
    process.stdout.write(`no dispatches recorded under ${path.join(sd, 'briefs')}\n`);
    return 0;
  }
  pairs.forEach(promptMeta);
  // Agent ascending, then dispatch order (the ts is fixed-width, the
  // collision suffix breaks the same-second ties): the last pair of an
  // agent is its last dispatch.
  pairs.sort((a, b) => a.agent.localeCompare(b.agent) || a.ts.localeCompare(b.ts) || a.suf - b.suf);
  let prevAgent = '';
  let prevRole = '';
  for (const p of pairs) {
    if (p.agent !== prevAgent) { prevAgent = p.agent; prevRole = ''; }
    if (!p.amendment) {
      p.roleResolved = p.role !== '' ? p.role : '(unknown)';
    } else {
      p.roleResolved = prevRole !== '' ? prevRole : '(unknown)';
    }
    prevRole = p.roleResolved;
  }
  // The last dispatch of each agent on the FULL set (before the --since
  // filter): "may still arrive" describes the agent's real last dispatch,
  // not the filtered view.
  const lastPerAgent = {};
  for (const p of pairs) lastPerAgent[p.agent] = p;
  if (since !== null) {
    const cut = since.getTime();
    for (let i = pairs.length - 1; i >= 0; i -= 1) if (pairs[i].promptM < cut) pairs.splice(i, 1);
  }
  const rosterNames = new Set(rosterRows(sd).map((l) => l.split('\t')[0]).filter((n) => n !== ''));
  // The map stays on the FULL set's last dispatch: the filtered view must
  // never overwrite it (an agent whose real last dispatch fell outside the
  // window would otherwise classify an older included pair as pending).
  for (const p of pairs) {
    if (p.hasReport) continue;
    p.noReport = rosterNames.has(p.agent) && lastPerAgent[p.agent] === p ? 'pending' : 'lost';
  }
  const roles = {};
  for (const p of pairs) {
    const a = roles[p.roleResolved] ??= { tasks: 0, amendments: 0, pending: 0, lost: 0, minutes: [], partials: 0 };
    if (p.amendment) a.amendments += 1; else a.tasks += 1;
    if (p.noReport === 'pending') a.pending += 1;
    else if (p.noReport === 'lost') a.lost += 1;
    if (p.minutes !== null) a.minutes.push(p.minutes);
    a.partials += p.partials;
  }
  const review = {};
  for (const role of REVIEW_ROLES_ALL.split(' ')) {
    const list = pairs.filter((p) => p.roleResolved === role);
    if (list.length === 0) continue;
    const r = { header: 0, pass: 0, fail: 0, P0: 0, P1: 0, P2: 0, P3: 0, no_header: 0 };
    for (const p of list) {
      if (!p.hasReport) continue;
      if (p.header) {
        r.header += 1;
        if (p.header.verdict === 'pass') r.pass += 1; else r.fail += 1;
        for (const k of ['P0', 'P1', 'P2', 'P3']) r[k] += p.header.severity[k];
      } else {
        r.no_header += 1;
      }
    }
    review[role] = r;
  }
  if (asJson) {
    const obj = {
      roles: Object.fromEntries(Object.entries(roles).map(([role, a]) => [role, {
        tasks: a.tasks,
        amendments: a.amendments,
        no_report: { pending: a.pending, lost: a.lost },
        minutes: minutesStats(a.minutes),
        partials: a.partials,
      }])),
      review: Object.fromEntries(Object.entries(review).map(([role, r]) => [role, {
        header: r.header,
        pass: r.pass,
        fail: r.fail,
        severity: { P0: r.P0, P1: r.P1, P2: r.P2, P3: r.P3 },
        no_header: r.no_header,
      }])),
    };
    process.stdout.write(`${JSON.stringify(obj)}\n`);
    return 0;
  }
  const t1 = Object.keys(roles).sort((a, b) => a.localeCompare(b)).map((role) => {
    const a = roles[role];
    const m = minutesStats(a.minutes);
    return [
      role,
      String(a.tasks),
      String(a.amendments),
      `${a.pending + a.lost} (${a.pending}/${a.lost})`,
      m === null ? '-' : m.avg.toFixed(1),
      m === null ? '-' : m.median.toFixed(1),
      m === null ? '-' : m.max.toFixed(1),
      String(a.partials),
    ];
  });
  const t1out = renderTable(
    ['role', 'tasks', 'amendments', 'no-report (pending/lost)', 'avg min', 'median min', 'max min', 'partials'],
    t1,
  );
  const t2 = REVIEW_ROLES_ALL.split(' ').filter((role) => review[role] !== undefined).map((role) => {
    const r = review[role];
    return [role, String(r.header), String(r.pass), String(r.fail), String(r.P0), String(r.P1), String(r.P2), String(r.P3), String(r.no_header)];
  });
  const t2out = renderTable(
    ['role', 'header', 'pass', 'fail', 'P0', 'P1', 'P2', 'P3', 'no-header'],
    t2,
  );
  process.stdout.write(`tasks by role:\n${t1out}\n\nreviews by role:\n${t2out}\n`);
  return 0;
}
