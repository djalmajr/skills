// stats: the usage numbers of the state dir — one dispatch pair per
// composed prompt (state-dir briefs and the $TMPDIR routing), the role
// from the prompt's role line (an amendment counts under the role of the
// previous prompt of the same agent), prompt-to-report times with
// controlled mtimes, pending (last dispatch of a roster agent) vs lost
// reports, [partial] sums, the review section (header, pass/fail,
// severity, no header), --since (and an invalid date), --json, and the
// empty state dir. Run as a child process against an isolated state dir;
// no herdr is involved.
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
    assert.deepEqual(imp, ['implementer', '2', '0', '0 (0/0)', '7.5', '7.5', '9.0', '1'],
      `the implementer row (one decimal, partial sum): ${JSON.stringify(imp)}`);
    const rev = rowOf(r.stdout, 'reviewer');
    assert.deepEqual(rev, ['reviewer', '1', '0', '0 (0/0)', '5.0', '5.0', '5.0', '0']);
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
      tasks: 1, amendments: 1, no_report: { pending: 0, lost: 0 },
      minutes: { avg: 1.0, median: 1.0, max: 1.0 }, partials: 0,
    }, 'the amendment counts under the role of the previous prompt');
    assert.deepEqual(o.roles['(unknown)'], {
      tasks: 0, amendments: 1, no_report: { pending: 0, lost: 0 },
      minutes: { avg: 2.0, median: 2.0, max: 2.0 }, partials: 0,
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
      tasks: 2, amendments: 0, no_report: { pending: 0, lost: 0 },
      minutes: { avg: 4.5, median: 4.5, max: 6.0 }, partials: 0,
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
          tasks: 1, amendments: 0, no_report: { pending: 0, lost: 0 },
          minutes: { avg: 12.0, median: 12.0, max: 12.0 }, partials: 1,
        },
      },
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
