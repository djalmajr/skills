// stats: the usage numbers of the state dir — one dispatch pair per
// composed prompt (state-dir briefs and the $TMPDIR routing), the role
// from the prompt's role line (an amendment counts under the role of the
// previous prompt of the same agent), prompt-to-report times with
// controlled mtimes, pending (last dispatch of a roster agent) vs lost
// reports, [partial] sums, the review section (header, pass/fail,
// severity, no header), --since (and an invalid date), --json, the
// attempt sidecar (an accepted submission is the only counted task;
// attempted/failed never count and never become lost; malformed or
// unsupported sidecars warn without their raw contents; kind/model/effort
// are the sidecar's snapshot at dispatch, never the current roster; the
// sidecar is read from the dir that won the dedupe), --by
// role|kind|model|agent|effort (the (unknown) group for a missing
// snapshot value, the grouped review of the reviewer-role reports only,
// and the missing/empty/invalid flag dying 2), a rejected dispatch never
// superseding the last counted one (pending/lost and the amendment's
// inherited role), the reuse classification (a non-amendment is a reuse
// when the immediately previous counted known role of the same agent
// differs — A, B, B is task, reuse, task, and A, B, A is task, reuse,
// reuse; a failed dispatch never changes the previous known role; an
// unknown legacy role never makes a reuse),
// lost_briefs (the exact composed-prompt path of every lost pair, per
// group, in the full-set order across the --since boundary and the
// $TMPDIR routing/mirror; the pending pairs stay out), the not_received
// count (the accepted sidecar's arrival mark, counted once per pair,
// stable across repeated queries; a legacy pair carries no arrival
// proof), only-ENOENT legacy sidecars (a present-but-unreadable
// one is invalid, as is a v1 missing a required field), and
// prototype-safe group keys (__proto__, constructor) preserved exactly,
// and the empty state dir. Run as a child process against an isolated
// state dir; no herdr is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { nodeBin } from './parity.mjs';

const SCRIPTS = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const JS_ENTRY = path.join(SCRIPTS, 'herdr-agents.mjs');

// A controlled epoch (seconds) and minute offsets for the mtimes.
const T0 = 1_761_422_400;
const MIN = 60;

const roleBody = (role, agent) => `# Role: ${role}\n\nYou are running as the \`${role}\` role, agent name \`${agent}\`, inside a multi-agent run coordinated by an orchestrator that cannot see your terminal.\n\n# Brief\n\ndo the thing\n`;
const amendmentBody = () => `# Amendment to your current brief\n\ndo it differently\n`;

const H12 = '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\tmodel\tapprovals\troles\tlane\n';

function makeFix(prefix) {
  let root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const state = path.join(root, 'state');
  const ws = path.join(state, 'ws');
  const briefs = path.join(ws, 'briefs');
  const reports = path.join(ws, 'reports');
  const tmp = path.join(root, 'tmp');
  const tmpReports = path.join(tmp, 'herdr-agents', 'ws', 'reports');
  for (const d of [briefs, reports, path.join(ws, 'wait'), tmpReports, path.join(root, 'home'), path.join(root, 'conf')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  const env = {
    HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'conf'),
    TMPDIR: tmp,
    HERDR_AGENTS_DIR: state,
    HERDR_WORKSPACE_ID: 'ws',
    PATH: process.env.PATH,
  };
  const fix = {
    root, ws, briefs, reports, tmpReports, env,
    prompt(agent, ts, role, opts = {}) {
      const p = path.join(briefs, `${agent}-${ts}.md`);
      fs.writeFileSync(p, roleBody(role, agent));
      if (opts.mtime !== undefined) fs.utimesSync(p, opts.mtime, opts.mtime);
      return p;
    },
    report(agent, ts, body, opts = {}) {
      const p = path.join(reports, `${agent}-${ts}.md`);
      fs.writeFileSync(p, body);
      if (opts.mtime !== undefined) fs.utimesSync(p, opts.mtime, opts.mtime);
      return p;
    },
    amendment(agent, ts, opts = {}) {
      const p = path.join(briefs, `${agent}-${ts}.md`);
      fs.writeFileSync(p, amendmentBody());
      if (opts.mtime !== undefined) fs.utimesSync(p, opts.mtime, opts.mtime);
      return p;
    },
    // A non-amendment prompt without the role line (a legacy shape): its
    // role is unknown.
    plainPrompt(agent, ts, opts = {}) {
      const p = path.join(briefs, `${agent}-${ts}.md`);
      fs.writeFileSync(p, '# Role: implementer\n\n(no role line)\n\n# Brief\n\ndo it\n');
      if (opts.mtime !== undefined) fs.utimesSync(p, opts.mtime, opts.mtime);
      return p;
    },
    tmpPrompt(agent, ts, role, opts = {}) {
      const p = path.join(tmpReports, `${agent}-${ts}.brief.md`);
      fs.writeFileSync(p, roleBody(role, agent));
      if (opts.mtime !== undefined) fs.utimesSync(p, opts.mtime, opts.mtime);
      return p;
    },
    tmpReport(agent, ts, body, opts = {}) {
      const p = path.join(tmpReports, `${agent}-${ts}.md`);
      fs.writeFileSync(p, body);
      if (opts.mtime !== undefined) fs.utimesSync(p, opts.mtime, opts.mtime);
      return p;
    },
    roster(...rows) { fs.writeFileSync(path.join(ws, 'agents.tsv'), H12 + rows.join('\n') + '\n'); },
    row(name, role = 'implementer') { return `${name}\tp-${name}\tgrok\t${role}\txai\t1\t/tmp/work\tnow\t\tfull\t\t`; },
    rowModel(name, model, role = 'implementer') { return [name, `p-${name}`, 'grok', role, 'xai', '1', '/tmp/work', 'now', model, 'full', '', ''].join('\t'); },
    sidecar(agent, ts, obj) {
      const p = path.join(briefs, `${agent}-${ts}.dispatch.json`);
      fs.writeFileSync(p, typeof obj === 'string' ? obj : `${JSON.stringify(obj)}\n`);
      return p;
    },
    tmpSidecar(agent, ts, obj) {
      const p = path.join(tmpReports, `${agent}-${ts}.dispatch.json`);
      fs.writeFileSync(p, typeof obj === 'string' ? obj : `${JSON.stringify(obj)}\n`);
      return p;
    },
    stats(args) {
      return spawnSync(nodeBin(), [JS_ENTRY, 'stats', ...args], { cwd: root, env: fix.env, encoding: 'utf8', timeout: 30_000 });
    },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
  fix.roster();
  return fix;
}

// The table rows: the first cell is left-aligned, the rest right-aligned,
// cells separated by two spaces — split on the double spaces. The section
// is chosen explicitly: a role row exists in BOTH tables.
function rowOf(out, role, section = 'tasks by role:\n') {
  const body = out.split(section)[1];
  assert.ok(body !== undefined, `the '${section.trim()}' section:\n${out}`);
  const line = body.split('\n').find((l) => l.startsWith(`${role} `) || l === role);
  assert.ok(line !== undefined, `the table row for '${role}':\n${out}`);
  return line.trim().split(/\s{2,}/);
}

test('stats: roles, prompt-to-report times and [partial] per role', { timeout: 30000 }, () => {
  const fix = makeFix('ha-stats-roles-');
  try {
    // implementer: two tasks, 6 and 9 minutes, one [partial] item total.
    fix.prompt('b1', '20260925T100000', 'implementer', { mtime: T0 });
    fix.report('b1', '20260925T100000', '# Report\n\n| item | state |\n| --- | --- |\n| fact A | [partial] | because the build was skipped\n', { mtime: T0 + 6 * MIN });
    fix.prompt('b2', '20260925T110000', 'implementer', { mtime: T0 });
    fix.report('b2', '20260925T110000', '# Report\n\ndone.\n', { mtime: T0 + 9 * MIN });
    // reviewer: one task, 5 minutes, no partials.
    fix.prompt('rev', '20260925T120000', 'reviewer', { mtime: T0 });
    fix.report('rev', '20260925T120000', 'findings: 1 (P0 0, P1 1, P2 0, P3 0) | verdict: pass\n\n# Report\n', { mtime: T0 + 5 * MIN });
    const r = fix.stats([]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^tasks by role:\n/);
    assert.match(r.stdout, /reviews by role:\n/);
    const imp = rowOf(r.stdout, 'implementer');
    // Mutation captured: a role read from anywhere else in the prompt (or
    // a broken role regex) lands the tasks on the wrong role row.
    assert.deepEqual(imp, ['implementer', '2', '0', '0', '0 (0/0)', '0', '7.5', '7.5', '9.0', '1'],
      `the implementer row (one decimal, partial sum): ${JSON.stringify(imp)}`);
    const rev = rowOf(r.stdout, 'reviewer');
    assert.deepEqual(rev, ['reviewer', '1', '0', '0', '0 (0/0)', '0', '5.0', '5.0', '5.0', '0']);
  } finally { fix.cleanup(); }
});

test('stats: an amendment counts under the role of the previous prompt of the same agent', { timeout: 30000 }, () => {
  const fix = makeFix('ha-stats-amend-');
  try {
    // b: a task and its amendment (same agent, the amendment has no role
    // line); c: an amendment with no previous prompt at all.
    fix.prompt('b', '20260925T100000', 'implementer', { mtime: T0 });
    fix.report('b', '20260925T100000', '# Report\n\ndone.\n', { mtime: T0 + MIN });
    fix.amendment('b', '20260925T110000', { mtime: T0 + 10 * MIN });
    fix.report('b', '20260925T110000', '# Report\n\namendment done.\n', { mtime: T0 + 11 * MIN });
    fix.amendment('c', '20260925T100000', { mtime: T0 });
    fix.report('c', '20260925T100000', '# Report\n\ndone.\n', { mtime: T0 + 2 * MIN });
    // Mutation captured: an amendment counted as a NEW task (or ignored)
    // breaks the tasks/amendments split below.
    const r = fix.stats(['--json']);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.deepEqual(o.roles.implementer, {
      tasks: 1, amendments: 1, reuses: 0, no_report: { pending: 0, lost: 0 },
      not_received: 0, minutes: { avg: 1.0, median: 1.0, max: 1.0 }, partials: 0,
    }, 'the amendment counts under the role of the previous prompt');
    assert.deepEqual(o.roles['(unknown)'], {
      tasks: 0, amendments: 1, reuses: 0, no_report: { pending: 0, lost: 0 },
      not_received: 0, minutes: { avg: 2.0, median: 2.0, max: 2.0 }, partials: 0,
    }, 'an amendment with no previous prompt of its own has no resolvable role');
  } finally { fix.cleanup(); }
});

test('stats: a report-less prompt is pending for the live last dispatch, lost otherwise', { timeout: 30000 }, () => {
  const fix = makeFix('ha-stats-pending-');
  try {
    fix.roster(fix.row('a'), fix.row('g'));
    // a: the last (and only) dispatch of a live agent: pending.
    fix.prompt('a', '20260925T100000', 'implementer', { mtime: T0 });
    // g: an older dispatch without a report (lost) and a later one that
    // has its report.
    fix.prompt('g', '20260925T090000', 'implementer', { mtime: T0 - 60 * MIN });
    fix.prompt('g', '20260925T100000', 'implementer', { mtime: T0 });
    fix.report('g', '20260925T100000', '# Report\n\ndone.\n', { mtime: T0 + MIN });
    // x: released (not in the roster) with its last dispatch missing the
    // report: lost.
    fix.prompt('x', '20260925T100000', 'implementer', { mtime: T0 });
    // Mutation captured: a pending counted as lost (or the roster
    // ignored) flips the pending/lost split below.
    const r = fix.stats(['--json']);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.deepEqual(o.roles.implementer.no_report, { pending: 1, lost: 2 },
      'a is pending; the old g and the released x are lost');
  } finally { fix.cleanup(); }
});

test('stats: the review section counts header, pass, fail, severity and no-header', { timeout: 30000 }, () => {
  const fix = makeFix('ha-stats-review-');
  try {
    fix.roster(fix.row('rev', 'reviewer'), fix.row('sec', 'security-reviewer'));
    fix.prompt('rev', '20260925T100000', 'reviewer', { mtime: T0 });
    fix.report('rev', '20260925T100000', 'findings: 2 (P0 0, P1 1, P2 1, P3 0) | verdict: pass\n\n# Report\n', { mtime: T0 + MIN });
    fix.prompt('rev', '20260925T110000', 'reviewer', { mtime: T0 });
    fix.report('rev', '20260925T110000', 'findings: 2 (P0 1, P1 1, P2 0, P3 0) | verdict: fail\n\n# Report\n', { mtime: T0 + MIN });
    fix.prompt('rev', '20260925T120000', 'reviewer', { mtime: T0 });
    fix.report('rev', '20260925T120000', '# Report\n\nno header here\n', { mtime: T0 + MIN });
    fix.prompt('sec', '20260925T100000', 'security-reviewer', { mtime: T0 });
    fix.report('sec', '20260925T100000', 'findings: 1 (P0 0, P1 0, P2 0, P3 1) | verdict: fail\n\n# Report\n', { mtime: T0 + MIN });
    const r = fix.stats([]);
    assert.equal(r.status, 0, r.stderr);
    const rev = rowOf(r.stdout, 'reviewer', 'reviews by role:\n');
    assert.deepEqual(rev, ['reviewer', '2', '1', '1', '1', '2', '1', '0', '1'],
      `the reviewer review row: ${JSON.stringify(rev)}`);
    const sec = rowOf(r.stdout, 'security-reviewer', 'reviews by role:\n');
    assert.deepEqual(sec, ['security-reviewer', '1', '0', '1', '0', '0', '0', '1', '0']);
    // Mutation captured: the header read from the wrong line (or the
    // verdict/severity dropped) breaks the review counts above.
  } finally { fix.cleanup(); }
});

test('stats: the $TMPDIR routing is counted alongside the state dir', { timeout: 30000 }, () => {
  const fix = makeFix('ha-stats-tmp-');
  try {
    fix.roster(fix.row('t'));
    // t lives under the $TMPDIR routing (prompt AND report there); s under
    // the state dir.
    fix.tmpPrompt('t', '20260925T100000', 'implementer', { mtime: T0 });
    fix.tmpReport('t', '20260925T100000', '# Report\n\ndone.\n', { mtime: T0 + 3 * MIN });
    fix.prompt('s', '20260925T100000', 'implementer', { mtime: T0 });
    fix.report('s', '20260925T100000', '# Report\n\ndone.\n', { mtime: T0 + 6 * MIN });
    const r = fix.stats(['--json']);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    // Mutation captured: the tmp routing not scanned (or scanned as
    // reports) drops the task or doubles it.
    assert.deepEqual(o.roles.implementer, {
      tasks: 2, amendments: 0, reuses: 0, no_report: { pending: 0, lost: 0 },
      not_received: 0, minutes: { avg: 4.5, median: 4.5, max: 6.0 }, partials: 0,
    });
  } finally { fix.cleanup(); }
});

test('stats: a mirrored $TMPDIR pair is counted once (the state-dir copy wins)', { timeout: 30000 }, () => {
  const fix = makeFix('ha-stats-mirror-');
  try {
    fix.roster(fix.row('t'));
    // The wait mirrored the tmp pair into the state dir (prompt under
    // <state>/briefs, report under <state>/reports); the originals still
    // sit in the $TMPDIR routing.
    fix.tmpPrompt('t', '20260925T100000', 'implementer', { mtime: T0 });
    fix.tmpReport('t', '20260925T100000', '# Report\n\ndone.\n', { mtime: T0 + 3 * MIN });
    fix.prompt('t', '20260925T100000', 'implementer', { mtime: T0 });
    fix.report('t', '20260925T100000', '# Report\n\ndone.\n', { mtime: T0 + 3 * MIN });
    const r = fix.stats(['--json']);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    // Mutation captured: the pair not deduped by <agent>-<ts> counts the
    // task twice; the tmp original winning the dedupe would read its
    // prompt mtime from the tmp file (same mtime here, so the count is
    // what the dedupe proves).
    assert.deepEqual(o.roles.implementer, {
      tasks: 1, amendments: 0, reuses: 0, no_report: { pending: 0, lost: 0 },
      not_received: 0, minutes: { avg: 3.0, median: 3.0, max: 3.0 }, partials: 0,
    });
  } finally { fix.cleanup(); }
});

test('stats: --since filters by the prompt mtime; an invalid date dies 2', { timeout: 30000 }, () => {
  const fix = makeFix('ha-stats-since-');
  try {
    fix.prompt('old', '20260925T100000', 'implementer', { mtime: T0 });
    fix.report('old', '20260925T100000', '# Report\n\ndone.\n', { mtime: T0 + MIN });
    fix.prompt('new', '20260925T130000', 'implementer', { mtime: T0 + 3 * 60 * MIN });
    fix.report('new', '20260925T130000', '# Report\n\ndone.\n', { mtime: T0 + 4 * 60 * MIN });
    // ISO: before both.
    let r = fix.stats(['--since', new Date(T0 * 1000).toISOString(), '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).roles.implementer.tasks, 2);
    // ISO: between the two prompts — only the newer one.
    r = fix.stats(['--since', new Date((T0 + 2 * 60 * MIN) * 1000).toISOString(), '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).roles.implementer.tasks, 1, 'the older prompt is filtered out');
    // Date-only form (local midnight of the day of T0): both.
    const iso = new Date(T0 * 1000).toISOString();
    const day = `${iso.slice(0, 4)}-${iso.slice(5, 7)}-${iso.slice(8, 10)}`;
    r = fix.stats(['--since', day, '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).roles.implementer.tasks, 2, 'AAAA-MM-DD is accepted');
    // An invalid date dies 2.
    r = fix.stats(['--since', 'banana']);
    assert.equal(r.status, 2, 'an invalid date is rc 2');
    assert.match(r.stderr, /stats: --since expects AAAA-MM-DD or an ISO date/);
    r = fix.stats(['--since']);
    assert.equal(r.status, 2, '--sans value is rc 2');
  } finally { fix.cleanup(); }
});

test('stats: --since accepts only AAAA-MM-DD or a strict ISO 8601 shape', { timeout: 30000 }, () => {
  const fix = makeFix('ha-stats-since-strict-');
  try {
    fix.prompt('b', '20260925T100000', 'implementer', { mtime: T0 });
    fix.report('b', '20260925T100000', '# Report\n\ndone.\n', { mtime: T0 + MIN });
    // Accepted (rc 0): the date, the date+T+minutes (local), with seconds,
    // with a fraction, with Z and with an offset (colon and basic forms).
    // All of them are after the task's mtime, so the filter applies and
    // the roles object comes back empty — the acceptance itself is the rc.
    const ok = [
      '2026-09-25',
      '2026-09-25T10:00',
      '2026-09-25T10:00:30',
      '2026-09-25T10:00:30.123',
      '2026-09-25T10:00:30.123Z',
      '2026-09-25T10:00:30Z',
      '2026-09-25T10:00+02:00',
      '2026-09-25T10:00+0200',
    ];
    for (const v of ok) {
      const r = fix.stats(['--since', v, '--json']);
      assert.equal(r.status, 0, `${v} must be accepted: ${r.stderr}`);
      assert.deepEqual(JSON.parse(r.stdout).roles, {}, `${v} is applied as a filter (everything before it is out)`);
    }
    // Rejected: the Date-constructor fallback formats are not ISO here —
    // rc 2 with the same invalid-date message (and a calendar-invalid date
    // that the constructor would reject too).
    for (const v of ['25/09/2026', '2026-09-25 10:00', '09/25/2026 10:00', '10/09/2026', '2026-13-01T00:00:00Z', '2026-09-25T25:00']) {
      const r = fix.stats(['--since', v]);
      assert.equal(r.status, 2, `${v} must be rejected`);
      assert.ok(r.stderr.includes(`stats: --since expects AAAA-MM-DD or an ISO date (got '${v}')`), v);
    }
    // Mutation captured: a parseSince that falls back to `new Date(value)`
    // for anything non-AAAA-MM-DD accepts the rejected formats above (rc 0
    // instead of rc 2).
  } finally { fix.cleanup(); }
});

test('stats: --since never overwrites the last dispatch of the full set', { timeout: 30000 }, () => {
  const fix = makeFix('ha-stats-since-last-');
  try {
    fix.roster(fix.row('a'));
    // a (in the roster): the older dispatch (no report) and a NEWER one by
    // dispatch order whose mtime predates the window — the agent's real
    // last dispatch is outside the --since interval.
    fix.prompt('a', '20260925T100000', 'implementer', { mtime: T0 });
    fix.prompt('a', '20260925T110000', 'implementer', { mtime: T0 - 120 * MIN });
    // Without --since: the T110000 pair (the agent's real last dispatch,
    // no report, agent still in the roster) is pending; the older T100000
    // pair without a report is lost.
    let r = fix.stats(['--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).roles.implementer.no_report, { pending: 1, lost: 1 });
    // With --since T0 the T110000 pair (mtime T0-120m) is filtered out; the
    // T100000 pair stays and is STILL lost — the full set's last dispatch
    // (T110000) must not be replaced by the filtered view's last pair.
    r = fix.stats(['--since', new Date(T0 * 1000).toISOString(), '--json']);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(o.roles.implementer.tasks, 1, 'the filtered view keeps one pair');
    // Mutation captured: rebuilding lastPerAgent from the FILTERED set
    // classifies the included pair as pending (the agent's last dispatch
    // is the newer one outside the window, so this pair is lost).
    assert.deepEqual(o.roles.implementer.no_report, { pending: 0, lost: 1 },
      'the included pair is lost: the last dispatch of the FULL set is outside the window');
  } finally { fix.cleanup(); }
});

test('stats: the review table covers ui-reviewer and inspector too', { timeout: 30000 }, () => {
  const fix = makeFix('ha-stats-review-all-');
  try {
    fix.roster(fix.row('ui', 'ui-reviewer'), fix.row('insp', 'inspector'));
    fix.prompt('ui', '20260925T100000', 'ui-reviewer', { mtime: T0 });
    fix.report('ui', '20260925T100000', 'findings: 2 (P0 0, P1 1, P2 1, P3 0) | verdict: fail\n\n# Report\n', { mtime: T0 + MIN });
    fix.prompt('ui', '20260925T110000', 'ui-reviewer', { mtime: T0 });
    fix.report('ui', '20260925T110000', '# Report\n\nno header here\n', { mtime: T0 + MIN });
    fix.prompt('insp', '20260925T100000', 'inspector', { mtime: T0 });
    fix.report('insp', '20260925T100000', 'findings: 1 (P0 1, P1 0, P2 0, P3 0) | verdict: fail\n\n# Report\n', { mtime: T0 + MIN });
    const r = fix.stats([]);
    assert.equal(r.status, 0, r.stderr);
    const ui = rowOf(r.stdout, 'ui-reviewer', 'reviews by role:\n');
    assert.deepEqual(ui, ['ui-reviewer', '1', '0', '1', '0', '1', '1', '0', '1'],
      `the ui-reviewer review row: ${JSON.stringify(ui)}`);
    const insp = rowOf(r.stdout, 'inspector', 'reviews by role:\n');
    assert.deepEqual(insp, ['inspector', '1', '0', '1', '1', '0', '0', '0', '0'],
      `the inspector review row: ${JSON.stringify(insp)}`);
    // The JSON review object carries the four roles the same way.
    const rj = fix.stats(['--json']);
    assert.equal(JSON.parse(rj.stdout).review['ui-reviewer'].fail, 1);
    assert.equal(JSON.parse(rj.stdout).review.inspector.no_header, 0);
    // Mutation captured: the review table still built from REVIEW_ROLES
    // (the two code reviewers) drops the ui-reviewer and inspector rows.
  } finally { fix.cleanup(); }
});

test('stats: --json prints one compact object with the stable shape', { timeout: 30000 }, () => {
  const fix = makeFix('ha-stats-json-');
  try {
    fix.roster(fix.row('rev', 'reviewer'));
    fix.prompt('b', '20260925T100000', 'implementer', { mtime: T0 });
    fix.report('b', '20260925T100000', 'findings: 1 (P0 1, P1 0, P2 0, P3 0) | verdict: fail\n\n# Report\n\n| i | s |\n| --- | --- |\n| a | [partial] | r\n', { mtime: T0 + 12 * MIN });
    const r = fix.stats(['--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trimEnd().split('\n').length, 1, 'one line');
    const o = JSON.parse(r.stdout);
    assert.deepEqual(o, {
      roles: {
        implementer: {
          tasks: 1, amendments: 0, reuses: 0, no_report: { pending: 0, lost: 0 },
          not_received: 0, minutes: { avg: 12.0, median: 12.0, max: 12.0 }, partials: 1,
        },
      },
      lost_briefs: {},
      review: {},
    }, 'the exact object (the report header is not a review role report)');
  } finally { fix.cleanup(); }
});

test('stats: an empty state dir prints the no-dispatches message and exits 0', { timeout: 30000 }, () => {
  const fix = makeFix('ha-stats-empty-');
  try {
    const r = fix.stats([]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `no dispatches recorded under ${fix.briefs}\n`);
    // The message is printed even with --json.
    assert.equal(fix.stats(['--json']).stdout, `no dispatches recorded under ${fix.briefs}\n`);
  } finally { fix.cleanup(); }
});

test('stats: --by kind|model|effort uses the sidecar snapshot, not the current roster', { timeout: 30000 }, () => {
  const fix = makeFix('ha-stats-snap-');
  try {
    // The roster's model changed after the dispatch (m-roster); the
    // sidecar's snapshot (k-snap/m-snap/e-snap) is what stats must group
    // by — a missing historical value is never filled from the roster.
    fix.roster(fix.rowModel('b', 'm-roster'));
    fix.prompt('b', '20260925T100000', 'implementer', { mtime: T0 });
    fix.report('b', '20260925T100000', '# Report\n\ndone.\n', { mtime: T0 + MIN });
    fix.sidecar('b', '20260925T100000', { version: 1, kind: 'k-snap', model: 'm-snap', effort: 'e-snap', submission: 'accepted' });
    for (const [dim, want] of [['kind', 'k-snap'], ['model', 'm-snap'], ['effort', 'e-snap']]) {
      const r = fix.stats(['--by', dim, '--json']);
      assert.equal(r.status, 0, r.stderr);
      const o = JSON.parse(r.stdout);
      assert.equal(o.by, dim, 'the JSON says the selected dimension');
      assert.deepEqual(Object.keys(o.groups), [want],
        `${dim} groups under the sidecar snapshot, not the roster: ${JSON.stringify(o.groups)}`);
      assert.equal(o.groups[want].tasks, 1);
    }
    // Mutation captured: grouping by the current roster row (grok/
    // m-roster) instead of the sidecar snapshot lands the task under a
    // different key.
  } finally { fix.cleanup(); }
});

test('stats: a legacy pair (no sidecar) keeps today\'s behavior and groups under (unknown)', { timeout: 30000 }, () => {
  const fix = makeFix('ha-stats-legacy-');
  try {
    // b has no sidecar at all (predates the sidecar): it is still a task,
    // and its kind/model/effort are unknown.
    fix.prompt('b', '20260925T100000', 'implementer', { mtime: T0 });
    fix.report('b', '20260925T100000', '# Report\n\ndone.\n', { mtime: T0 + MIN });
    for (const dim of ['kind', 'model', 'effort']) {
      const r = fix.stats(['--by', dim, '--json']);
      assert.equal(r.status, 0, r.stderr);
      const o = JSON.parse(r.stdout);
      assert.deepEqual(o.groups, { '(unknown)': {
        tasks: 1, amendments: 0, reuses: 0, no_report: { pending: 0, lost: 0 },
        not_received: 0, minutes: { avg: 1.0, median: 1.0, max: 1.0 }, partials: 0,
      }}, `the legacy pair groups under (unknown) for ${dim}: ${JSON.stringify(o.groups)}`);
    }
    // The no-`--by` output is unchanged by the sidecar work: the pair is
    // still counted under its role.
    const r = fix.stats(['--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).roles.implementer.tasks, 1, 'the legacy pair keeps today\'s behavior');
  } finally { fix.cleanup(); }
});

test('stats: only an accepted sidecar is a task; attempted/failed never count and never become lost', { timeout: 30000 }, () => {
  const fix = makeFix('ha-stats-sub-');
  try {
    fix.roster(fix.row('a'), fix.row('f'));
    // a: accepted with its report: the only task.
    fix.prompt('a', '20260925T100000', 'implementer', { mtime: T0 });
    fix.report('a', '20260925T100000', '# Report\n\ndone.\n', { mtime: T0 + MIN });
    fix.sidecar('a', '20260925T100000', { version: 1, kind: 'grok', model: 'm-a', effort: 'full', submission: 'accepted' });
    // f: a failed submission with no report (f is still in the roster and
    // this is f\'s last dispatch): not counted as a task NOR as
    // pending/lost.
    fix.prompt('f', '20260925T100000', 'implementer', { mtime: T0 });
    fix.sidecar('f', '20260925T100000', { version: 1, kind: 'grok', model: 'm-f', effort: 'full', submission: 'failed' });
    // t: an attempted submission (a crash stuck in attempted) with no
    // report and t not in the roster: not a task, not lost.
    fix.prompt('t', '20260925T100000', 'implementer', { mtime: T0 });
    fix.sidecar('t', '20260925T100000', { version: 1, kind: 'grok', model: 'm-t', effort: 'full', submission: 'attempted' });
    const r = fix.stats(['--json']);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    // Mutation captured: an attempted/failed submission counted as a task
    // (or a failed one classified as pending/lost) breaks the counts
    // below.
    assert.deepEqual(o.roles.implementer, {
      tasks: 1, amendments: 0, reuses: 0, no_report: { pending: 0, lost: 0 },
      not_received: 0, minutes: { avg: 1.0, median: 1.0, max: 1.0 }, partials: 0,
    }, 'the no-by counts: ' + JSON.stringify(o.roles));
    // --by model: only the accepted pair\'s snapshot bucket exists.
    const rb = fix.stats(['--by', 'model', '--json']);
    assert.equal(rb.status, 0, rb.stderr);
    assert.deepEqual(JSON.parse(rb.stdout).groups, {
      'm-a': { tasks: 1, amendments: 0, reuses: 0, no_report: { pending: 0, lost: 0 },
        not_received: 0, minutes: { avg: 1.0, median: 1.0, max: 1.0 }, partials: 0 },
    }, 'the failed and the attempted pairs do not group anywhere');
  } finally { fix.cleanup(); }
});

test('stats: a malformed or unsupported sidecar is not accepted and warns without its raw contents', { timeout: 30000 }, () => {
  const fix = makeFix('ha-stats-badside-');
  try {
    fix.roster(fix.row('m1'), fix.row('m2'));
    // m1: not JSON at all (a distinctive token the warning must not echo);
    // no report and m1 in the roster: the pair must not become pending or
    // lost either.
    fix.prompt('m1', '20260925T100000', 'implementer', { mtime: T0 });
    fix.sidecar('m1', '20260925T100000', '{oops RAW-MARKER-NOT-JSON');
    // m2: valid JSON but an unsupported version (still a roster agent
    // whose last dispatch would be pending if it counted).
    fix.prompt('m2', '20260925T100000', 'implementer', { mtime: T0 });
    fix.sidecar('m2', '20260925T100000', { version: 2, kind: 'grok', model: 'm2', effort: 'full', submission: 'accepted' });
    const r = fix.stats(['--json']);
    assert.equal(r.status, 0, 'a malformed sidecar never dies the stats run');
    assert.match(r.stderr, /m1-20260925T100000\.dispatch\.json is not a valid attempt sidecar/, 'a warning names the sidecar file');
    assert.match(r.stderr, /m2-20260925T100000\.dispatch\.json is not a valid attempt sidecar/, 'an unsupported version warns too');
    assert.ok(!r.stderr.includes('RAW-MARKER-NOT-JSON'), 'the raw contents are never printed');
    const o = JSON.parse(r.stdout);
    // Mutation captured: a malformed/unsupported sidecar counted as
    // accepted (or the pair classified as pending) appears in the groups
    // below.
    assert.deepEqual(o, { roles: {}, lost_briefs: {}, review: {} }, 'neither pair is counted: no task, no pending/lost');
  } finally { fix.cleanup(); }
});

test('stats: the sidecar is read from the winning side of the pair (tmp routing and mirror)', { timeout: 30000 }, () => {
  const fix = makeFix('ha-stats-side-route-');
  try {
    fix.roster(fix.row('t'), fix.row('w'));
    // t: the pair lives only under the $TMPDIR routing; its sidecar does
    // too.
    fix.tmpPrompt('t', '20260925T100000', 'implementer', { mtime: T0 });
    fix.tmpReport('t', '20260925T100000', '# Report\n\ndone.\n', { mtime: T0 + 2 * MIN });
    fix.tmpSidecar('t', '20260925T100000', { version: 1, kind: 'grok', model: 'm-tmp', effort: 'full', submission: 'accepted' });
    // w: mirrored into the state dir; the state-dir copy wins the dedupe
    // and must use the STATE-DIR sidecar (m-state), not the tmp
    // original\'s (m-tmp-orig).
    fix.tmpPrompt('w', '20260925T100000', 'implementer', { mtime: T0 });
    fix.tmpReport('w', '20260925T100000', '# Report\n\ndone.\n', { mtime: T0 + 3 * MIN });
    fix.tmpSidecar('w', '20260925T100000', { version: 1, kind: 'grok', model: 'm-tmp-orig', effort: 'full', submission: 'accepted' });
    fix.prompt('w', '20260925T100000', 'implementer', { mtime: T0 });
    fix.report('w', '20260925T100000', '# Report\n\ndone.\n', { mtime: T0 + 3 * MIN });
    fix.sidecar('w', '20260925T100000', { version: 1, kind: 'grok', model: 'm-state', effort: 'full', submission: 'accepted' });
    const r = fix.stats(['--by', 'model', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    // Mutation captured: the sidecar read from the wrong dir (the state
    // dir for the tmp-only pair, or the tmp original for the mirrored
    // pair) breaks the buckets below.
    assert.deepEqual(Object.keys(o.groups).sort(), ['m-state', 'm-tmp'], `the buckets: ${JSON.stringify(o.groups)}`);
    assert.equal(o.groups['m-state'].tasks, 1, 'the mirrored pair uses the state-dir sidecar');
    assert.equal(o.groups['m-tmp'].tasks, 1, 'the tmp pair uses the tmp-routing sidecar');
  } finally { fix.cleanup(); }
});

test('stats: --by groups the review of the reviewer-role reports only', { timeout: 30000 }, () => {
  const fix = makeFix('ha-stats-review-by-');
  try {
    fix.roster(fix.row('r1', 'reviewer'), fix.row('r2', 'reviewer'), fix.row('r3', 'reviewer'), fix.row('imp'));
    // r1/r2: reviewer reports with a header, one sidecar kind each; r3:
    // a reviewer with no sidecar at all (legacy); imp: an implementer
    // report with a header line (it must never enter the review).
    fix.prompt('r1', '20260925T100000', 'reviewer', { mtime: T0 });
    fix.report('r1', '20260925T100000', 'findings: 1 (P0 0, P1 1, P2 0, P3 0) | verdict: pass\n\n# Report\n', { mtime: T0 + MIN });
    fix.sidecar('r1', '20260925T100000', { version: 1, kind: 'k1', model: 'm1', effort: 'full', submission: 'accepted' });
    fix.prompt('r2', '20260925T100000', 'reviewer', { mtime: T0 });
    fix.report('r2', '20260925T100000', 'findings: 1 (P0 1, P1 0, P2 0, P3 0) | verdict: fail\n\n# Report\n', { mtime: T0 + MIN });
    fix.sidecar('r2', '20260925T100000', { version: 1, kind: 'k2', model: 'm2', effort: 'full', submission: 'accepted' });
    fix.prompt('r3', '20260925T100000', 'reviewer', { mtime: T0 });
    fix.report('r3', '20260925T100000', '# Report\n\nno header\n', { mtime: T0 + MIN });
    fix.prompt('imp', '20260925T100000', 'implementer', { mtime: T0 });
    fix.report('imp', '20260925T100000', 'findings: 1 (P0 1, P1 0, P2 0, P3 0) | verdict: fail\n\n# Report\n', { mtime: T0 + MIN });
    fix.sidecar('imp', '20260925T100000', { version: 1, kind: 'k1', model: 'm1', effort: 'full', submission: 'accepted' });
    // --by kind: the review is grouped under the sidecar\'s kind, the
    // legacy reviewer under (unknown), the implementer nowhere.
    const r = fix.stats(['--by', 'kind', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    // Mutation captured: the review built from ALL pairs (the
    // implementer\'s report leaks in), or grouped under the role instead
    // of the kind, breaks the object below.
    assert.deepEqual(o.review, {
      k1: { header: 1, pass: 1, fail: 0, severity: { P0: 0, P1: 1, P2: 0, P3: 0 }, no_header: 0 },
      k2: { header: 1, pass: 0, fail: 1, severity: { P0: 1, P1: 0, P2: 0, P3: 0 }, no_header: 0 },
      '(unknown)': { header: 0, pass: 0, fail: 0, severity: { P0: 0, P1: 0, P2: 0, P3: 0 }, no_header: 1 },
    }, `the review grouped by kind: ${JSON.stringify(o.review)}`);
    // The text headings follow the selected dimension.
    const rt = fix.stats(['--by', 'kind']);
    assert.equal(rt.status, 0, rt.stderr);
    assert.match(rt.stdout, /^tasks by kind:\n/);
    assert.match(rt.stdout, /reviews by kind:\n/);
    // --by agent: one bucket per reviewer agent (the implementer is
    // still not there).
    const ra = fix.stats(['--by', 'agent', '--json']);
    assert.equal(ra.status, 0, ra.stderr);
    const oa = JSON.parse(ra.stdout);
    assert.deepEqual(Object.keys(oa.review).sort(), ['r1', 'r2', 'r3'], `the review is grouped per agent: ${JSON.stringify(Object.keys(oa.review))}`);
  } finally { fix.cleanup(); }
});

test('stats: --by requires a known dimension (missing or invalid dies 2)', { timeout: 30000 }, () => {
  const fix = makeFix('ha-stats-by-arg-');
  try {
    fix.prompt('b', '20260925T100000', 'implementer', { mtime: T0 });
    fix.report('b', '20260925T100000', '# Report\n\ndone.\n', { mtime: T0 + MIN });
    let r = fix.stats(['--by']);
    assert.equal(r.status, 2, '--by without a value is rc 2');
    assert.match(r.stderr, /stats: --by expects a dimension/);
    r = fix.stats(['--by', 'banana']);
    assert.equal(r.status, 2, 'an unknown dimension is rc 2');
    assert.match(r.stderr, /stats: --by expects one of role, kind, model, agent, effort \(got 'banana'\)/);
    // An EXPLICITLY empty value is invalid too (the flag was provided):
    // it must not fall back to the default shape.
    r = fix.stats(['--by', '']);
    assert.equal(r.status, 2, 'an explicit empty --by is rc 2');
    assert.match(r.stderr, /stats: --by expects one of role, kind, model, agent, effort \(got ''\)/);
    // The ABSENCE of --by keeps the default shape (roles/review keys).
    r = fix.stats(['--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(Object.keys(JSON.parse(r.stdout)).sort(), ['lost_briefs', 'review', 'roles'], 'no --by keeps the default shape');
    // --by role is the dimension default: the role grouping, in the new
    // explicit shape in JSON.
    r = fix.stats(['--by', 'role', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(o.by, 'role');
    assert.deepEqual(o.groups.implementer, {
      tasks: 1, amendments: 0, reuses: 0, no_report: { pending: 0, lost: 0 },
      not_received: 0, minutes: { avg: 1.0, median: 1.0, max: 1.0 }, partials: 0,
    }, 'the per-group metric shape is the existing one');
  } finally { fix.cleanup(); }
});

test('stats: a rejected dispatch does not supersede the last counted dispatch for pending/lost', { timeout: 30000 }, () => {
  const fix = makeFix('ha-stats-last-counted-');
  try {
    fix.roster(fix.row('a'));
    // a (in the roster): an accepted prompt with no report, then a failed
    // and an attempted prompt (both report-less, dispatched later). The
    // rejected dispatches are not accepted ones: the accepted prompt is
    // still the agent's last accepted dispatch → pending, not lost.
    fix.prompt('a', '20260925T100000', 'implementer', { mtime: T0 });
    fix.sidecar('a', '20260925T100000', { version: 1, kind: 'grok', model: 'm1', effort: 'full', submission: 'accepted' });
    fix.prompt('a', '20260925T110000', 'implementer', { mtime: T0 + MIN });
    fix.sidecar('a', '20260925T110000', { version: 1, kind: 'grok', model: 'm2', effort: 'full', submission: 'failed' });
    fix.prompt('a', '20260925T120000', 'implementer', { mtime: T0 + 2 * MIN });
    fix.sidecar('a', '20260925T120000', { version: 1, kind: 'grok', model: 'm3', effort: 'full', submission: 'attempted' });
    const r = fix.stats(['--json']);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    // Mutation captured: a lastPerAgent built over ALL pairs (or only the
    // filtered rows) classifies the accepted reportless task as lost.
    assert.deepEqual(o.roles.implementer, {
      tasks: 1, amendments: 0, reuses: 0, no_report: { pending: 1, lost: 0 },
      not_received: 0, minutes: null, partials: 0,
    }, `the accepted reportless task stays pending: ${JSON.stringify(o.roles)}`);
    // The rejected dispatches still do not group anywhere.
    const rb = fix.stats(['--by', 'model', '--json']);
    assert.equal(rb.status, 0, rb.stderr);
    assert.deepEqual(Object.keys(JSON.parse(rb.stdout).groups), ['m1'], 'only the accepted sidecar groups');
  } finally { fix.cleanup(); }
});

test('stats: a failed dispatch does not change the role inherited by a later accepted amendment', { timeout: 30000 }, () => {
  const fix = makeFix('ha-stats-amend-failed-');
  try {
    fix.roster(fix.row('a'));
    // a: an accepted implementer task (with report), then a FAILED
    // reviewer prompt (the roster role had changed), then an accepted
    // amendment (no role line): it must count under the last ACCEPTED
    // prompt's role — implementer, not the failed reviewer.
    fix.prompt('a', '20260925T100000', 'implementer', { mtime: T0 });
    fix.report('a', '20260925T100000', '# Report\n\ndone.\n', { mtime: T0 + MIN });
    fix.sidecar('a', '20260925T100000', { version: 1, kind: 'grok', model: 'm1', effort: 'full', submission: 'accepted' });
    fix.prompt('a', '20260925T110000', 'reviewer', { mtime: T0 + 5 * MIN });
    fix.sidecar('a', '20260925T110000', { version: 1, kind: 'grok', model: 'm1', effort: 'full', submission: 'failed' });
    fix.amendment('a', '20260925T120000', { mtime: T0 + 10 * MIN });
    fix.report('a', '20260925T120000', '# Report\n\namended.\n', { mtime: T0 + 11 * MIN });
    fix.sidecar('a', '20260925T120000', { version: 1, kind: 'grok', model: 'm1', effort: 'full', submission: 'accepted' });
    const r = fix.stats(['--json']);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    // Mutation captured: a role chain fed by the failed reviewer prompt
    // (or the failed prompt counted at all) lands the amendment under
    // reviewer or adds a reviewer row.
    assert.deepEqual(o.roles, {
      implementer: {
        tasks: 1, amendments: 1, reuses: 0, no_report: { pending: 0, lost: 0 },
        not_received: 0, minutes: { avg: 1.0, median: 1.0, max: 1.0 }, partials: 0,
      },
    }, `the amendment counts under the last accepted role: ${JSON.stringify(o.roles)}`);
    assert.equal(r.stdout.includes('reviewer'), false, 'the failed reviewer prompt is not counted anywhere');
  } finally { fix.cleanup(); }
});

test('stats: only an ENOENT sidecar is legacy; present-but-unreadable or field-less sidecars are invalid', { timeout: 30000 }, () => {
  const fix = makeFix('ha-stats-unreadable-');
  try {
    fix.roster(fix.row('d'), fix.row('e'), fix.row('g'), fix.row('l'));
    // d: a DIRECTORY at the sidecar path (EISDIR): present but not a
    // readable file → invalid, warned, not counted.
    fix.prompt('d', '20260925T100000', 'implementer', { mtime: T0 });
    fs.mkdirSync(path.join(fix.briefs, 'd-20260925T100000.dispatch.json'));
    // e: an unreadable file (EACCES); the content the warning must never
    // echo sits inside. As root, chmod 000 does not hide the file: the
    // case is then not enforceable and the readable sidecar counts.
    const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    fix.prompt('e', '20260925T100000', 'implementer', { mtime: T0 });
    const eSide = fix.sidecar('e', '20260925T100000', { version: 1, kind: 'grok', model: 'RAW-EAC-SECRET', effort: 'full', submission: 'accepted' });
    if (!asRoot) fs.chmodSync(eSide, 0);
    // g: a v1 sidecar missing a required field (no effort): malformed.
    fix.prompt('g', '20260925T100000', 'implementer', { mtime: T0 });
    fix.sidecar('g', '20260925T100000', { version: 1, kind: 'grok', model: 'm-g', submission: 'accepted' });
    // l: a genuinely absent sidecar: the legacy pair still counts.
    fix.prompt('l', '20260925T100000', 'implementer', { mtime: T0 });
    const r = fix.stats(['--json']);
    assert.equal(r.status, 0, 'an unreadable sidecar never dies the stats run');
    assert.match(r.stderr, /d-20260925T100000\.dispatch\.json is not a valid attempt sidecar/, 'the directory sidecar warns');
    if (!asRoot) {
      assert.match(r.stderr, /e-20260925T100000\.dispatch\.json is not a valid attempt sidecar/, 'the unreadable file warns');
      assert.ok(!r.stderr.includes('RAW-EAC-SECRET'), 'the unreadable contents are never printed');
    }
    assert.match(r.stderr, /g-20260925T100000\.dispatch\.json is not a valid attempt sidecar/, 'the field-less v1 warns');
    const o = JSON.parse(r.stdout);
    // Mutation captured: a non-ENOENT read error treated as absent (or a
    // field-less v1 accepted) counts the pair below (and, as a reportless
    // last dispatch of a live agent, makes it pending).
    assert.deepEqual(o.roles.implementer, {
      tasks: asRoot ? 2 : 1, amendments: 0, reuses: 0,
      no_report: { pending: asRoot ? 2 : 1, lost: 0 },
      not_received: 0, minutes: null, partials: 0,
    }, `only the legacy pair l counts (root: e's sidecar is readable too): ${JSON.stringify(o.roles)}`);
  } finally { fix.cleanup(); }
});

test('stats: --by keeps prototype-ish dimension keys (__proto__, constructor) in JSON and text', { timeout: 30000 }, () => {
  const fix = makeFix('ha-stats-proto-');
  try {
    fix.roster(fix.row('b1'), fix.row('b2'));
    // Valid dimension values that hit the object prototype: __proto__ and
    // constructor. A plain-object bucket would resolve them against the
    // prototype and crash (or silently misplace the pair).
    fix.prompt('b1', '20260925T100000', 'implementer', { mtime: T0 });
    fix.report('b1', '20260925T100000', '# Report\n\ndone.\n', { mtime: T0 + MIN });
    fix.sidecar('b1', '20260925T100000', { version: 1, kind: 'grok', model: '__proto__', effort: 'full', submission: 'accepted' });
    fix.prompt('b2', '20260925T100000', 'implementer', { mtime: T0 });
    fix.report('b2', '20260925T100000', '# Report\n\ndone.\n', { mtime: T0 + MIN });
    fix.sidecar('b2', '20260925T100000', { version: 1, kind: 'grok', model: 'constructor', effort: 'full', submission: 'accepted' });
    const r = fix.stats(['--by', 'model', '--json']);
    assert.equal(r.status, 0, `the prototype-ish keys must not crash stats: ${r.stderr}`);
    const o = JSON.parse(r.stdout);
    // Mutation captured: a plain-object accumulator (or the keys
    // sanitized away) loses or misplaces one of the exact keys.
    assert.deepEqual(new Set(Object.keys(o.groups)), new Set(['__proto__', 'constructor']),
      `the exact keys are preserved: ${JSON.stringify(Object.keys(o.groups))}`);
    assert.equal(o.groups['__proto__'].tasks, 1);
    assert.equal(o.groups['constructor'].tasks, 1);
    // The text tables carry them too.
    const rt = fix.stats(['--by', 'model']);
    assert.equal(rt.status, 0, rt.stderr);
    assert.match(rt.stdout, /^__proto__/m);
    assert.match(rt.stdout, /^constructor/m);
  } finally { fix.cleanup(); }
});

test('stats: a non-amendment is a reuse when the immediately previous counted known role differs', { timeout: 30000 }, () => {
  const fix = makeFix('ha-stats-reuse-');
  try {
    // b: A, B, B (implementer, reviewer, reviewer) plus the amendment
    // after the switch (an amendment of the switched role): task, reuse,
    // task, amendment.
    fix.prompt('b', '20260925T100000', 'implementer', { mtime: T0 });
    fix.report('b', '20260925T100000', '# Report\n\ndone.\n', { mtime: T0 + MIN });
    fix.prompt('b', '20260925T110000', 'reviewer', { mtime: T0 + 10 * MIN });
    fix.report('b', '20260925T110000', 'findings: 0 (P0 0, P1 0, P2 0, P3 0) | verdict: pass\n\n# Report\n', { mtime: T0 + 11 * MIN });
    fix.prompt('b', '20260925T120000', 'reviewer', { mtime: T0 + 20 * MIN });
    fix.report('b', '20260925T120000', 'findings: 0 (P0 0, P1 0, P2 0, P3 0) | verdict: pass\n\n# Report\n', { mtime: T0 + 21 * MIN });
    fix.amendment('b', '20260925T130000', { mtime: T0 + 30 * MIN });
    fix.report('b', '20260925T130000', '# Report\n\namended.\n', { mtime: T0 + 31 * MIN });
    // c: A, B, A (implementer, reviewer, implementer): task, reuse, reuse.
    fix.prompt('c', '20260925T100000', 'implementer', { mtime: T0 });
    fix.report('c', '20260925T100000', '# Report\n\ndone.\n', { mtime: T0 + MIN });
    fix.prompt('c', '20260925T110000', 'reviewer', { mtime: T0 + 10 * MIN });
    fix.report('c', '20260925T110000', 'findings: 0 (P0 0, P1 0, P2 0, P3 0) | verdict: pass\n\n# Report\n', { mtime: T0 + 11 * MIN });
    fix.prompt('c', '20260925T120000', 'implementer', { mtime: T0 + 20 * MIN });
    fix.report('c', '20260925T120000', '# Report\n\ndone.\n', { mtime: T0 + 21 * MIN });
    // d: a legacy pair without a role line, then a known role: the
    // previous counted role is unknown, so the later dispatch is a task,
    // not a reuse.
    fix.plainPrompt('d', '20260925T100000', { mtime: T0 });
    fix.report('d', '20260925T100000', '# Report\n\ndone.\n', { mtime: T0 + MIN });
    fix.prompt('d', '20260925T110000', 'implementer', { mtime: T0 + 10 * MIN });
    fix.report('d', '20260925T110000', '# Report\n\ndone.\n', { mtime: T0 + 11 * MIN });
    // e: a known role, then a prompt without a role line: the current
    // role is unknown, so it is a task, not a reuse.
    fix.prompt('e', '20260925T100000', 'implementer', { mtime: T0 });
    fix.report('e', '20260925T100000', '# Report\n\ndone.\n', { mtime: T0 + MIN });
    fix.plainPrompt('e', '20260925T110000', { mtime: T0 + 10 * MIN });
    fix.report('e', '20260925T110000', '# Report\n\ndone.\n', { mtime: T0 + 11 * MIN });
    // f: implementer (accepted), reviewer (FAILED, never counted),
    // implementer (accepted): the failed reviewer never changes the
    // previous known role, so the second implementer is a task.
    fix.prompt('f', '20260925T100000', 'implementer', { mtime: T0 });
    fix.report('f', '20260925T100000', '# Report\n\ndone.\n', { mtime: T0 + MIN });
    fix.sidecar('f', '20260925T100000', { version: 1, kind: 'grok', model: 'm-f1', effort: 'full', submission: 'accepted' });
    fix.prompt('f', '20260925T110000', 'reviewer', { mtime: T0 + 10 * MIN });
    fix.sidecar('f', '20260925T110000', { version: 1, kind: 'grok', model: 'm-f2', effort: 'full', submission: 'failed' });
    fix.prompt('f', '20260925T120000', 'implementer', { mtime: T0 + 20 * MIN });
    fix.report('f', '20260925T120000', '# Report\n\ndone.\n', { mtime: T0 + 21 * MIN });
    fix.sidecar('f', '20260925T120000', { version: 1, kind: 'grok', model: 'm-f3', effort: 'full', submission: 'accepted' });
    const r = fix.stats(['--json']);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    // Mutation captured: a reuse compared against ANY earlier known role
    // (the second B of A, B, B counted as a reuse, or f's second
    // implementer as a reuse after the failed reviewer), or a failed
    // dispatch changing the previous role, breaks the split below —
    // every counted pair is exactly one of the three categories (9 tasks
    // + 3 reuses + 1 amendment = 13 counted pairs).
    assert.deepEqual(o.roles.implementer, {
      tasks: 6, amendments: 0, reuses: 1, no_report: { pending: 0, lost: 0 },
      not_received: 0, minutes: { avg: 1.0, median: 1.0, max: 1.0 }, partials: 0,
    }, 'b: task + task (the second B), c: task + reuse (the return to A), d/e/f: tasks');
    assert.deepEqual(o.roles.reviewer, {
      tasks: 1, amendments: 1, reuses: 2, no_report: { pending: 0, lost: 0 },
      not_received: 0, minutes: { avg: 1.0, median: 1.0, max: 1.0 }, partials: 0,
    }, 'b: reuse + the second B as a task + the amendment under the switched role, c: reuse');
    assert.deepEqual(o.roles['(unknown)'], {
      tasks: 2, amendments: 0, reuses: 0, no_report: { pending: 0, lost: 0 },
      not_received: 0, minutes: { avg: 1.0, median: 1.0, max: 1.0 }, partials: 0,
    }, 'the legacy prompts without a role line group under (unknown)');
    // The text table carries the reuses column.
    const rt = fix.stats([]);
    assert.equal(rt.status, 0, rt.stderr);
    assert.deepEqual(rowOf(rt.stdout, 'reviewer'),
      ['reviewer', '1', '1', '2', '0 (0/0)', '0', '1.0', '1.0', '1.0', '0'],
      `the reviewer row with the reuses column: ${JSON.stringify(rowOf(rt.stdout, 'reviewer'))}`);
  } finally { fix.cleanup(); }
});

test('stats: a lost pair exposes its composed prompt path; pending, tmp and mirror keep their exact paths', { timeout: 30000 }, () => {
  const fix = makeFix('ha-stats-lostbriefs-');
  try {
    // a: the live last dispatch without a report: pending, never listed.
    fix.roster(fix.row('a'));
    fix.prompt('a', '20260925T100000', 'implementer', { mtime: T0 });
    // m: a mirrored pair (the state-dir copy won the dedupe; the tmp
    // original still sits under the $TMPDIR routing) without a report:
    // lost, and its exposed path is the STATE-DIR one.
    fix.tmpPrompt('m', '20260925T100000', 'implementer', { mtime: T0 });
    fix.prompt('m', '20260925T100000', 'implementer', { mtime: T0 });
    // t: a pair that lives only under the $TMPDIR routing: lost, and its
    // exposed path is the exact tmp .brief.md path.
    fix.tmpPrompt('t', '20260925T100000', 'implementer', { mtime: T0 });
    // x: an older lost pair of a released agent.
    fix.prompt('x', '20260925T090000', 'implementer', { mtime: T0 - 60 * MIN });
    const r = fix.stats(['--json']);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.deepEqual(o.roles.implementer.no_report, { pending: 1, lost: 3 });
    // Mutation captured: the pending pair listed, the tmp original's path
    // reported for the mirrored pair (or the state path for the tmp pair),
    // or a reconstructed source-brief path, breaks the object below.
    assert.deepEqual(o.lost_briefs, {
      implementer: [
        path.join(fix.briefs, 'm-20260925T100000.md'),
        path.join(fix.tmpReports, 't-20260925T100000.brief.md'),
        path.join(fix.briefs, 'x-20260925T090000.md'),
      ],
    }, 'the exact stored path of each lost pair, in the full-set order (agent, then ts)');
    // The concise text section: one line per lost pair, same order; the
    // pending pair is not there.
    const rt = fix.stats([]);
    assert.equal(rt.status, 0, rt.stderr);
    const section = rt.stdout.split('lost briefs by role:\n')[1];
    assert.ok(section !== undefined, `the text section:\n${rt.stdout}`);
    assert.deepEqual(section.split('\n').filter((l) => l !== ''), [
      `implementer: ${path.join(fix.briefs, 'm-20260925T100000.md')}`,
      `implementer: ${path.join(fix.tmpReports, 't-20260925T100000.brief.md')}`,
      `implementer: ${path.join(fix.briefs, 'x-20260925T090000.md')}`,
    ], `the text lines: ${JSON.stringify(section)}`);
  } finally { fix.cleanup(); }
});

test('stats: lost_briefs keeps the full-set order and the inclusive --since boundary', { timeout: 30000 }, () => {
  const fix = makeFix('ha-stats-lostsince-');
  try {
    // a and g are released (not in the roster): both pairs are lost. The
    // later dispatch (a, T110000) has a NEWER mtime than the older one
    // (g, T100000): the mtime order would be g then a, the full-set
    // (dispatch) order is a then g.
    fix.prompt('a', '20260925T110000', 'implementer', { mtime: T0 });
    fix.prompt('g', '20260925T100000', 'implementer', { mtime: T0 - 120 * MIN });
    const aPath = path.join(fix.briefs, 'a-20260925T110000.md');
    const gPath = path.join(fix.briefs, 'g-20260925T100000.md');
    let r = fix.stats(['--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).lost_briefs.implementer, [aPath, gPath],
      'the full-set order, not the mtime order');
    // --since at T0: g (mtime T0-120m) is filtered out, a (mtime exactly
    // T0) stays — the boundary pair is kept (the filter is inclusive) and
    // the ordering of what is left is unchanged.
    r = fix.stats(['--since', new Date(T0 * 1000).toISOString(), '--json']);
    assert.equal(r.status, 0, r.stderr);
    const o2 = JSON.parse(r.stdout);
    assert.deepEqual(o2.lost_briefs.implementer, [aPath], 'only the boundary pair is listed');
    assert.equal(o2.roles.implementer.no_report.lost, 1, 'the boundary pair is still lost');
    // --since before both: both back, in the full-set order.
    r = fix.stats(['--since', new Date((T0 - 180 * MIN) * 1000).toISOString(), '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).lost_briefs.implementer, [aPath, gPath]);
    // Mutation captured: a lost_briefs rebuilt from the mtime (or the
    // alphabetical path) order, or a --since cut that drops the boundary
    // pair (strict <), breaks the asserts above.
  } finally { fix.cleanup(); }
});

test('stats: an accepted pair with the not-received arrival mark counts once, per query', { timeout: 30000 }, () => {
  const fix = makeFix('ha-stats-notrecv-');
  try {
    fix.roster(fix.row('a'), fix.row('b'), fix.row('c'));
    // a: accepted with the arrival mark: a task AND one not_received.
    fix.prompt('a', '20260925T100000', 'implementer', { mtime: T0 });
    fix.report('a', '20260925T100000', '# Report\n\ndone.\n', { mtime: T0 + MIN });
    const aSide = fix.sidecar('a', '20260925T100000', { version: 1, kind: 'grok', model: 'm-a', effort: 'full', submission: 'accepted', arrival: 'not-received' });
    // b: accepted without the mark: a task, no not_received.
    fix.prompt('b', '20260925T100000', 'implementer', { mtime: T0 });
    fix.report('b', '20260925T100000', '# Report\n\ndone.\n', { mtime: T0 + MIN });
    fix.sidecar('b', '20260925T100000', { version: 1, kind: 'grok', model: 'm-b', effort: 'full', submission: 'accepted' });
    // c: a legacy pair (no sidecar): no historical arrival proof.
    fix.prompt('c', '20260925T100000', 'implementer', { mtime: T0 });
    fix.report('c', '20260925T100000', '# Report\n\ndone.\n', { mtime: T0 + MIN });
    const before = fs.readFileSync(aSide, 'utf8');
    let r = fix.stats(['--json']);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    // Mutation captured: the mark counted per query (or the legacy pair
    // counted, or the unmarked pair counted) breaks the count below.
    assert.deepEqual(o.roles.implementer, {
      tasks: 3, amendments: 0, reuses: 0, no_report: { pending: 0, lost: 0 },
      not_received: 1, minutes: { avg: 1.0, median: 1.0, max: 1.0 }, partials: 0,
    }, 'one not_received for the marked accepted pair, once');
    // Repeated queries: the same count (stats never writes the sidecar).
    r = fix.stats(['--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).roles.implementer, o.roles.implementer, 'the repeated query is stable');
    assert.equal(fs.readFileSync(aSide, 'utf8'), before, 'stats leaves the sidecar untouched');
    // The text table carries the not-received column, and the
    // lost-briefs section is absent when nothing is lost.
    const rt = fix.stats([]);
    assert.equal(rt.status, 0, rt.stderr);
    assert.deepEqual(rowOf(rt.stdout, 'implementer'),
      ['implementer', '3', '0', '0', '0 (0/0)', '1', '1.0', '1.0', '1.0', '0'],
      `the implementer row with the not-received column: ${JSON.stringify(rowOf(rt.stdout, 'implementer'))}`);
    assert.ok(!rt.stdout.includes('lost briefs'), 'no lost pairs, no section');
  } finally { fix.cleanup(); }
});
