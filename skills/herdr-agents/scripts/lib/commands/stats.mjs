// The `stats` command: usage numbers of the workspace, computed from the
// state dir (the dispatch pairs and the roster) — no herdr needed.
//
// A task is one composed prompt: `briefs/<agent>-<ts>.md` in the state
// dir, or `<agent>-<ts>.brief.md` under the $TMPDIR routing; its pair is
// the report with the same `<agent>-<ts>` (the same-second collision
// suffix, when present, is part of the pair name).
//
// The attempt sidecar of a pair — the `.dispatch.json` next to its
// composed prompt (the state dir for a state pair or a mirror, the
// $TMPDIR routing for a tmp pair; the dir that won the dedupe supplies
// the sidecar) — records version 1, the roster kind and model and the
// session effort at dispatch, and the submission (attempted, accepted or
// failed). Only an accepted submission — or a legacy pair with no
// sidecar at all, which keeps today's behavior — counts as a task: an
// attempted or failed submission is not a task and must never become
// pending or lost. A malformed or unsupported sidecar fails
// conservatively (the pair is not counted as accepted) with a warning
// that names the file without its raw contents. The kind, model and
// effort of a pair are the sidecar's snapshot at dispatch: a missing
// historical value is (unknown), never filled from the current roster.
// A dispatch that ends `not-received` durably marks the same sidecar
// with `arrival: "not-received"` after the accepted submission; the mark
// never changes the submission, and stats counts one not_received per
// such accepted pair (a legacy pair carries no arrival proof).
//
// The role of a prompt is its `You are running as the `<role>` role`
// line; an amendment prompt (`# Amendment to your current brief`) has no
// such line and counts as an amendment of the role of the previous
// prompt of the same agent. A counted non-amendment is a reuse when the
// agent's immediately previous counted known role differs from its own
// known role (A, B, B is task, reuse, task; A, B, A is task, reuse,
// reuse); a rejected dispatch never changes the previous known role, an
// amendment never becomes a reuse, and each counted pair is a task, an
// amendment or a reuse — exactly one. The
// time of a task runs from the prompt mtime to the report mtime. A
// prompt without a report is `pending` when it is the last dispatch of
// an agent that is still in the roster (the report may still arrive),
// `lost` otherwise. A lost pair also exposes the path of its composed
// prompt (lost_briefs, per group, the exact stored path of the pair that
// won the dedupe — the source brief is never reconstructed).
//
// `stats [--since <date>] [--by <dim>] [--json]`:
//   --since AAAA-MM-DD or ISO — keep only the prompts whose mtime is at
//   or after the date (an invalid date dies 2);
//   --by role|kind|model|agent|effort — group the task and review tables
//   by the dimension (role is the no-`--by` default); kind/model/effort
//   come from the sidecar snapshot, and a missing value groups under
//   (unknown); a missing, empty or unknown dimension dies 2; with --by
//   the JSON is {by, groups, review} instead of {roles, review};
//   --json — one compact JSON object on stdout;
//   no dispatch pairs at all — `no dispatches recorded under <dir>`,
//   exit 0 (the message is printed even with --json).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stateDir, workspaceId, rosterRows, dieFriction, warn } from '../state.mjs';
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
// The --by dimensions: role (the no-`--by` default), the sidecar-snapshot
// dimensions kind/model/effort and the agent name.
const BY_DIMS = ['role', 'kind', 'model', 'agent', 'effort'];
// The group of a pair whose snapshot has no value for the dimension
// (legacy pair, empty snapshot field, or a roster without the column).
const UNKNOWN = '(unknown)';

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
// wins over the $TMPDIR original — and uses its own sidecar (the
// .dispatch.json next to the winning prompt), never the tmp original's.
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
        sidecarPath: path.join(dir, `${base}.dispatch.json`),
        sidecar: null,
        counted: true,
        reuse: false,
      });
    }
  };
  scan(path.join(sd, 'briefs'), 'state');
  scan(tmpDir, 'tmp');
  return pairs;
}

// The attempt sidecar of a pair (.dispatch.json, the same stem as the
// composed prompt, in the dir that won the dedupe). Absent (ENOENT): the
// legacy pair keeps today's behavior (counted, no snapshot). Present:
// parsed strictly — version 1, string kind/model/effort, one of the
// three submissions — and only an accepted submission counts as a task.
// A present sidecar that cannot be read (EISDIR, EACCES, …) is invalid,
// as is anything that fails the parse: the pair is not counted as
// accepted and a warning names the file without its raw contents.
function badSidecar(p) {
  p.counted = false;
  warn(`stats: ${path.basename(p.sidecarPath)} is not a valid attempt sidecar; the pair is not counted as accepted`);
}
function readSidecar(p) {
  let raw;
  try { raw = fs.readFileSync(p.sidecarPath, 'utf8'); }
  catch (e) {
    // Only ENOENT is the absent (legacy) sidecar: a present path that
    // cannot be read (a directory, an unreadable file, …) is an invalid
    // sidecar, not an absent one.
    if (e && e.code === 'ENOENT') return;
    badSidecar(p); return;
  }
  let o;
  try { o = JSON.parse(raw); } catch { badSidecar(p); return; }
  // A valid v1 carries string kind, model and effort: a missing required
  // field is malformed. The arrival mark is optional (a not-received
  // dispatch adds it after the accepted submission): present, it must be
  // a string; only the known value 'not-received' is counted.
  const bad = o === null || typeof o !== 'object' || Array.isArray(o) || o.version !== 1
    || typeof o.submission !== 'string' || !['attempted', 'accepted', 'failed'].includes(o.submission)
    || typeof o.kind !== 'string' || typeof o.model !== 'string' || typeof o.effort !== 'string'
    || ('arrival' in o && typeof o.arrival !== 'string');
  if (bad) { badSidecar(p); return; }
  p.sidecar = { submission: o.submission, kind: o.kind, model: o.model, effort: o.effort, arrival: typeof o.arrival === 'string' ? o.arrival : '' };
  p.counted = o.submission === 'accepted';
}

// The group key of a counted pair under the selected dimension: role and
// agent come from the pair itself; kind/model/effort are the sidecar's
// snapshot at dispatch (the current roster never fills in a missing
// historical value): a legacy pair or an empty field is (unknown).
function dimValue(p, dim) {
  if (dim === 'role') return p.roleResolved;
  if (dim === 'agent') return p.agent;
  const v = p.sidecar === null ? '' : p.sidecar[dim];
  return v !== '' ? v : UNKNOWN;
}

// Role, amendment flag, the attempt sidecar (submission and the
// kind/model/effort snapshot) and the paired report (mtime, [partial]
// count and the review header) of one prompt.
function promptMeta(p) {
  let text = '';
  try { text = readTextFile(p.prompt); } catch { text = ''; }
  p.amendment = text.split('\n')[0] === AMENDMENT_FIRST_LINE;
  const rm = ROLE_RE.exec(text);
  p.role = rm ? rm[1] : '';
  readSidecar(p);
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

// `stats [--since <date>] [--by <dim>] [--json]` → 0.
export function cmdStats(argv, ctx, env = process.env, cwd = process.cwd()) {
  let sinceRaw = '';
  let asJson = false;
  let by = null; // the --by value; null until the flag is present
  for (let i = 0; i < (argv ?? []).length; i += 1) {
    const a = String(argv[i]);
    if (a === '--since') {
      const v = argv[i + 1];
      if (v === undefined) dieFriction('stats: --since expects a date', 2);
      sinceRaw = String(v);
      i += 1;
    } else if (a === '--json') {
      asJson = true;
    } else if (a === '--by') {
      const v = argv[i + 1];
      if (v === undefined) dieFriction('stats: --by expects a dimension', 2);
      by = String(v);
      i += 1;
    } else {
      dieFriction(`stats: unknown option ${a}`, 2);
    }
  }
  if (by !== null && !BY_DIMS.includes(by)) {
    dieFriction(`stats: --by expects one of ${BY_DIMS.join(', ')} (got '${by}')`, 2);
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
  // The role an amendment inherits is the role of the previous COUNTED
  // prompt of the same agent: a rejected (attempted/failed/invalid)
  // dispatch is not an accepted one and must not be inherited. A counted
  // non-amendment is a REUSE when the agent's immediately previous
  // counted KNOWN role differs from its own known role: A, B, B is task,
  // reuse, task (the second B returns to the previous known role), and
  // A, B, A is task, reuse, reuse. A rejected dispatch never changes the
  // previous known role, an amendment never becomes a reuse, and a role
  // the agent never had (an unknown role) is not a previous known role.
  // Each counted pair is a task, an amendment or a reuse — exactly one.
  let prevAgent = '';
  let prevRole = '';
  const lastKnownRole = Object.create(null); // agent → the immediately previous counted known role ('' when none)
  for (const p of pairs) {
    if (p.agent !== prevAgent) { prevAgent = p.agent; prevRole = ''; }
    if (!p.counted) continue; // its roleResolved stays '' (never aggregated)
    if (!p.amendment) {
      p.roleResolved = p.role !== '' ? p.role : '(unknown)';
      const prev = lastKnownRole[p.agent] ?? '';
      p.reuse = p.role !== '' && prev !== '' && prev !== p.role;
      if (p.role !== '') lastKnownRole[p.agent] = p.role;
    } else {
      p.roleResolved = prevRole !== '' ? prevRole : '(unknown)';
    }
    prevRole = p.roleResolved;
  }
  // The last COUNTED (accepted or legacy) dispatch of each agent on the
  // FULL set (before the --since filter): "may still arrive" describes
  // the agent's real last accepted dispatch, not the filtered view — a
  // rejected dispatch must not supersede it, and a filtered-out accepted
  // one still is.
  const lastPerAgent = {};
  for (const p of pairs) if (p.counted) lastPerAgent[p.agent] = p;
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
    // An attempted or failed submission (or a malformed sidecar) is not a
    // task: it is neither pending nor lost, ever.
    if (!p.counted) continue;
    p.noReport = rosterNames.has(p.agent) && lastPerAgent[p.agent] === p ? 'pending' : 'lost';
  }
  // Group key under the selected dimension: the (resolved) role or the
  // agent name for the default / agent dimensions, the sidecar snapshot
  // for kind/model/effort.
  const byMode = by !== null;
  const keyOf = (p) => (byMode ? dimValue(p, by) : p.roleResolved);
  // Prototype-less accumulators: the group key is an arbitrary string
  // (a sidecar snapshot such as __proto__ or constructor), and a plain
  // object would resolve it against the prototype instead of bucketing.
  const groups = Object.create(null);
  for (const p of pairs) {
    if (!p.counted) continue; // not a task: an attempted/failed submission
    const a = groups[keyOf(p)] ??= { tasks: 0, amendments: 0, reuses: 0, pending: 0, lost: 0, notReceived: 0, minutes: [], partials: 0, lostBriefs: [] };
    if (p.amendment) a.amendments += 1;
    else if (p.reuse) a.reuses += 1;
    else a.tasks += 1;
    if (p.noReport === 'pending') a.pending += 1;
    else if (p.noReport === 'lost') { a.lost += 1; a.lostBriefs.push(p.prompt); }
    // The arrival mark of the winning sidecar: one accepted pair, one
    // count — a legacy pair (no sidecar) carries no arrival proof.
    if (p.sidecar !== null && p.sidecar.submission === 'accepted' && p.sidecar.arrival === 'not-received') a.notReceived += 1;
    if (p.minutes !== null) a.minutes.push(p.minutes);
    a.partials += p.partials;
  }
  // The lost pairs' composed-prompt paths, per group: the exact stored
  // path of the pair that won the dedupe (never a reconstructed source
  // brief), in the full-set order (the filter keeps the relative order);
  // the pending pairs stay out of it.
  const lostBriefs = Object.create(null);
  for (const [name, a] of Object.entries(groups)) if (a.lostBriefs.length > 0) lostBriefs[name] = a.lostBriefs;
  // The review groups the reviewer-role reports only: under the selected
  // dimension for an explicit --by, under the role otherwise (the order of
  // REVIEW_ROLES_ALL, as the no-`--by` output has always had it).
  const review = Object.create(null);
  const reviewRoles = REVIEW_ROLES_ALL.split(' ');
  const addReview = (r, p) => {
    if (p.header) {
      r.header += 1;
      if (p.header.verdict === 'pass') r.pass += 1; else r.fail += 1;
      for (const k of ['P0', 'P1', 'P2', 'P3']) r[k] += p.header.severity[k];
    } else {
      r.no_header += 1;
    }
  };
  if (byMode) {
    for (const p of pairs) {
      if (!p.counted || !reviewRoles.includes(p.roleResolved) || !p.hasReport) continue;
      addReview(review[keyOf(p)] ??= { header: 0, pass: 0, fail: 0, P0: 0, P1: 0, P2: 0, P3: 0, no_header: 0 }, p);
    }
  } else {
    for (const role of reviewRoles) {
      const list = pairs.filter((p) => p.roleResolved === role && p.counted);
      if (list.length === 0) continue;
      const r = { header: 0, pass: 0, fail: 0, P0: 0, P1: 0, P2: 0, P3: 0, no_header: 0 };
      for (const p of list) {
        if (!p.hasReport) continue;
        addReview(r, p);
      }
      review[role] = r;
    }
  }
  if (asJson) {
    if (byMode) {
      const sortEntries = (obj) => Object.entries(obj).sort(([a], [b]) => a.localeCompare(b));
      const byObj = {
        by,
        groups: Object.fromEntries(sortEntries(groups).map(([name, a]) => [name, {
          tasks: a.tasks,
          amendments: a.amendments,
          reuses: a.reuses,
          no_report: { pending: a.pending, lost: a.lost },
          not_received: a.notReceived,
          minutes: minutesStats(a.minutes),
          partials: a.partials,
        }])),
        lost_briefs: Object.fromEntries(sortEntries(lostBriefs)),
        review: Object.fromEntries(sortEntries(review).map(([name, r]) => [name, {
          header: r.header,
          pass: r.pass,
          fail: r.fail,
          severity: { P0: r.P0, P1: r.P1, P2: r.P2, P3: r.P3 },
          no_header: r.no_header,
        }])),
      };
      process.stdout.write(`${JSON.stringify(byObj)}\n`);
      return 0;
    }
    const obj = {
      roles: Object.fromEntries(Object.entries(groups).map(([role, a]) => [role, {
        tasks: a.tasks,
        amendments: a.amendments,
        reuses: a.reuses,
        no_report: { pending: a.pending, lost: a.lost },
        not_received: a.notReceived,
        minutes: minutesStats(a.minutes),
        partials: a.partials,
      }])),
      lost_briefs: Object.fromEntries(Object.entries(lostBriefs).sort(([a], [b]) => a.localeCompare(b))),
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
  const t1 = Object.keys(groups).sort((a, b) => a.localeCompare(b)).map((name) => {
    const a = groups[name];
    const m = minutesStats(a.minutes);
    return [
      name,
      String(a.tasks),
      String(a.amendments),
      String(a.reuses),
      `${a.pending + a.lost} (${a.pending}/${a.lost})`,
      String(a.notReceived),
      m === null ? '-' : m.avg.toFixed(1),
      m === null ? '-' : m.median.toFixed(1),
      m === null ? '-' : m.max.toFixed(1),
      String(a.partials),
    ];
  });
  const t1out = renderTable(
    [byMode ? by : 'role', 'tasks', 'amendments', 'reuses', 'no-report (pending/lost)', 'not-received', 'avg min', 'median min', 'max min', 'partials'],
    t1,
  );
  const t2 = (byMode
    ? Object.keys(review).sort((a, b) => a.localeCompare(b))
    : reviewRoles.filter((role) => review[role] !== undefined)
  ).map((name) => {
    const r = review[name];
    return [name, String(r.header), String(r.pass), String(r.fail), String(r.P0), String(r.P1), String(r.P2), String(r.P3), String(r.no_header)];
  });
  const t2out = renderTable(
    [byMode ? by : 'role', 'header', 'pass', 'fail', 'P0', 'P1', 'P2', 'P3', 'no-header'],
    t2,
  );
  process.stdout.write(`tasks by ${byMode ? by : 'role'}:\n${t1out}\n\nreviews by ${byMode ? by : 'role'}:\n${t2out}\n`);
  // The concise lost-briefs section: one line per lost pair, the group key
  // and the exact stored path of its composed prompt (the pair that won
  // the dedupe, in the full-set order; the pending pairs stay out). The
  // section is absent when nothing is lost.
  const lostLines = Object.keys(lostBriefs).sort((a, b) => a.localeCompare(b))
    .flatMap((name) => lostBriefs[name].map((p) => `${name}: ${p}`));
  if (lostLines.length > 0) process.stdout.write(`\nlost briefs by ${byMode ? by : 'role'}:\n${lostLines.join('\n')}\n`);
  return 0;
}
