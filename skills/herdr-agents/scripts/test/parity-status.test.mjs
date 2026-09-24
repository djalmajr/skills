// Golden (slice 9a-A; slice 3 scenario coverage): the `status`, `roster`
// and `friction` scenarios of test-status.sh (plus the roster/table cases
// and the env error paths) now run only the JS and compare against the
// reference recorded once from the bash script in
// test/golden/parity-status.json (test/golden.mjs:
// HERDR_AGENTS_GOLDEN=record records, unset checks, =update overwrites the
// JS value for review). A fake `herdr` on PATH (mode-file driven, exactly
// like test-status.sh) is the only `herdr` the implementations see. The
// node-semantics test is unchanged: it never ran the bash reference.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeFixture, runImpl, goldenScenario } from './parity.mjs';
import { golden, goldenMode, normalizeRoots } from './golden.mjs';
import { findExecutable } from '../lib/platform.mjs';

// Record mode runs the bash reference: it needs bash and jq. Check mode
// runs the JS against the record and needs the sh fake `herdr`, so it is
// skipped solely on Windows.
const SKIP =
  process.platform === 'win32'
    ? 'Windows: the bash reference (record) and the sh fake herdr (check) need a POSIX host'
    : (goldenMode() === 'record' && (!findExecutable('bash') || !findExecutable('jq'))
      ? 'record mode needs bash and jq on PATH'
      : false);

const SUITE = 'parity-status';

const NL = '\\n'; // a literal \n in the generated bash (printf interprets it)
const ESC = '\\033'; // a literal \033 (bash printf octal escape)

// The seed stores the fakes dir; the step env's PATH getter resolves it at
// run time (per implementation), like parity-kinds.test.mjs.
const envState = { fakes: '' };
const withFakes = (extra = {}) => ({
  ...extra,
  get PATH() { return `${envState.fakes}${path.delimiter}${process.env.PATH}`; },
});

// The fake: every call logged as one "$*" line; `agent get` answered per
// target (stuck/dead) then per mode file — the same arrangement as
// test-status.sh, plus pane/tab list and agent read for roster/quota.
function writeFake(fix) {
  const bin = path.join(fix.root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'herdr'), [
    '#!/usr/bin/env bash',
    `printf '%s${NL}' "$*" >> "${fix.root}/herdr.log"`,
    `mode=$(cat "${fix.root}/mode" 2>/dev/null || echo working)`,
    'target="${3:-}"',
    'case "$1 $2" in',
    '  "agent get")',
    '    case "$target" in',
    '      stuck)',
    `        printf '%s${NL}' 'Error: Os { code: 13, kind: PermissionDenied, message: "Permission denied" }' >&2`,
    '        exit 1 ;;',
    '      dead)',
    `        printf '%s${NL}' '{"error":{"code":"agent_not_found","message":"agent target dead not found"},"id":"cli:agent:get"}' >&2`,
    '        exit 1 ;;',
    '    esac',
    '    case "$mode" in',
    '      denied)',
    `        printf '%s${NL}' 'Error: Os { code: 13, kind: PermissionDenied, message: "Permission denied" }' >&2`,
    '        exit 1 ;;',
    '      denied-multi)',
    `        printf 'Error: Os { code: 13, kind: PermissionDenied, message: "Permission denied" }${NL}second-line\\t${ESC}[31mred${NL}' >&2`,
    '        exit 1 ;;',
    '      missing)',
    `        printf '%s${NL}' '{"error":{"code":"agent_not_found","message":"agent target "$target" not found"},"id":"cli:agent:get"}' >&2`,
    '        exit 1 ;;',
    '      down)',
    `        printf '%s${NL}' '{"id":"cli:agent:get","error":{"code":"server_not_running","message":"no herdr server is running"}}' >&2`,
    '        exit 1 ;;',
    '      working)',
    `        printf '%s${NL}' '{"result":{"agent":{"name":"'$target'","agent_status":"working"}}}'`,
    '        exit 0 ;;',
    '      idle)',
    `        printf '%s${NL}' '{"result":{"agent":{"name":"'$target'","agent_status":"idle"}}}'`,
    '        exit 0 ;;',
    '      blocked)',
    `        printf '%s${NL}' '{"result":{"agent":{"name":"'$target'","agent_status":"blocked"}}}'`,
    '        exit 0 ;;',
    '      *)',
    `        printf 'unexpected mode %s${NL}' "$mode" >&2`,
    '        exit 1 ;;',
    '    esac ;;',
    '  "pane list")',
    `    cat "${fix.root}/panes.json" 2>/dev/null || printf '%s${NL}' '{"result":{"panes":[]}}' ;;`,
    '  "tab list")',
    `    cat "${fix.root}/tabs.json" 2>/dev/null || printf '%s${NL}' '{"result":{"tabs":[]}}' ;;`,
    '  "agent list")',
    `    cat "${fix.root}/live.json" 2>/dev/null || printf '%s${NL}' '{"result":{"agents":[]}}' ;;`,
    '  "agent read")',
    `    cat "${fix.root}/screen" 2>/dev/null || printf '%s${NL}' 'terminal-fallback' ;;`,
    '  "pane report-metadata")',
    '    exit 0 ;;',
    '  *)',
    `    printf 'unexpected: %s${NL}' "$*" >&2`,
    '    exit 1 ;;',
    'esac',
  ].join('\n') + '\n', { mode: 0o755 });
  fs.writeFileSync(path.join(fix.root, 'herdr.log'), '');
}

const R8 = '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\n';
const WORKER8 = 'worker\tp1\tgrok\timplementer\txai\t1\t/work\tnow\n';
const STUCK8 = 'stuck\tp2\tgrok\timplementer\txai\t1\t/work\tnow\n';
const DEAD8 = 'dead\tp3\tgrok\timplementer\txai\t1\t/work\tnow\n';
const R12 = '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\tmodel\tapprovals\troles\tlane\n';

// Common seed: fake herdr + ws state dir + mode file + optional roster /
// last-report / live/pane/tab JSON / screen / friction content.
function seed(fix, o = {}) {
  writeFake(fix);
  envState.fakes = path.join(fix.root, 'bin');
  const ws = path.join(fix.state, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(fix.root, 'mode'), `${o.mode ?? 'working'}\n`);
  if (o.roster) fs.writeFileSync(path.join(ws, 'agents.tsv'), o.roster);
  for (const lr of o.lastReports ?? (o.lastReport ? [o.lastReport] : [])) {
    fs.writeFileSync(path.join(ws, `last-report-${lr.agent}`), lr.path + '\n');
  }
  if (o.reportBody !== undefined) {
    fs.mkdirSync(path.join(ws, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'reports', `${o.lastReport.agent}.md`), o.reportBody);
  }
  if (o.reportBodies) {
    fs.mkdirSync(path.join(ws, 'reports'), { recursive: true });
    for (const [agent, body] of Object.entries(o.reportBodies)) {
      fs.writeFileSync(path.join(ws, 'reports', `${agent}.md`), body);
    }
  }
  if (o.live) fs.writeFileSync(path.join(fix.root, 'live.json'), o.live + '\n');
  if (o.panes) fs.writeFileSync(path.join(fix.root, 'panes.json'), o.panes + '\n');
  if (o.tabs) fs.writeFileSync(path.join(fix.root, 'tabs.json'), o.tabs + '\n');
  if (o.screen) fs.writeFileSync(path.join(fix.root, 'screen'), o.screen);
  if (o.friction) fs.writeFileSync(path.join(ws, 'friction.log'), o.friction);
}

const S = (args) => ({ args, env: withFakes({ HERDR_ENV: '1' }) });

// Direct runner for the node-only/shape checks: merges the fixture env
// (HERDR_WORKSPACE_ID, HERDR_AGENTS_DIR, HOME, …) with the fake PATH.
function run(fix, impl, args) {
  return runImpl(impl, args, { env: { ...fix.env, ...withFakes({ HERDR_ENV: '1' }) }, cwd: fix.repo });
}

test('parity: status agent get classification (test-status.sh scenarios)', { timeout: 120000, skip: SKIP }, () => {
  const ws = (fix) => path.join(fix.state, 'ws');
  // One scenario per mode, mirroring the suite's reset_roster + mode.
  const modes = [
    ['denied', { mode: 'denied' }],
    ['denied-multi', { mode: 'denied-multi' }],
    ['missing', { mode: 'missing' }],
    ['down', { mode: 'down' }],
    ['working', { mode: 'working' }],
    ['idle', { mode: 'idle' }],
    ['blocked', { mode: 'blocked' }],
  ];
  for (const [label, o] of modes) {
    goldenScenario(SUITE, `status-${label}`, {
      seed: (fix) => seed(fix, { ...o, roster: R8 + WORKER8 }),
      steps: [S(['status', 'worker'])],
    });
  }
  // A ready report wins: `done`, and herdr is never queried.
  goldenScenario(SUITE, 'status-report-wins', {
    seed: (fix) => seed(fix, {
      mode: 'denied',
      roster: R8 + WORKER8,
      lastReport: { agent: 'worker', path: path.join(ws(fix), 'reports', 'worker.md') },
      reportBody: 'report body\n',
    }),
    steps: [S(['status', 'worker'])],
  });
  // Batch: one unqueryable (stuck) and one really gone (dead) at once.
  goldenScenario(SUITE, 'status-batch', {
    seed: (fix) => seed(fix, { mode: 'denied', roster: R8 + WORKER8 + STUCK8 + DEAD8 }),
    steps: [S(['status', 'stuck', 'dead'])],
    files: ['state/ws/agents.tsv'],
  });
  // Unknown agent: no herdr query at all.
  goldenScenario(SUITE, 'status-unknown', {
    seed: (fix) => seed(fix, { mode: 'working', roster: R8 + WORKER8 }),
    steps: [S(['status', 'nosuch'])],
  });
  // Quota on an idle screen: JSON instead of TSV, exit 11.
  goldenScenario(SUITE, 'status-quota', {
    seed: (fix) => seed(fix, {
      mode: 'idle',
      roster: R12 + 'build\tp1\tgrok\timplementer\txai\t1\t/work\t20260101T000000\tgrok-4.7\tfull\timplementer\tbuild\n',
      screen: 'Error: quota exceeded for this account\n',
    }),
    steps: [S(['status', 'build'])],
  });
});

test('parity: roster table (rows, role history, tabs, other live agents)', { timeout: 120000, skip: SKIP }, () => {
  const ws = (fix) => path.join(fix.state, 'ws');
  goldenScenario(SUITE, 'roster-table', {
    seed: (fix) => seed(fix, {
      mode: 'working',
      roster: R12
        + 'build\tp1\tgrok\timplementer\txai\t1\t/work\t20260101T000000\tgrok-4.7\tfull\ttasker,implementer\tbuild\n'
        + 'task\tp5\tgrok\ttasker\txai\t1\t/work\t20260101T000000\tgrok-4.7\tfull\tdesigner\t\n'
        + 'old8\tp2\tagy\tdesigner\tgoogle\t1\t/work2\tnow\n',
      lastReports: [
        { agent: 'build', path: path.join(ws(fix), 'reports', 'build.md') },
        { agent: 'task', path: path.join(ws(fix), 'reports', 'task.md') },
      ],
      reportBodies: {
        build: 'ready report\n',
        task: '',
      },
      live: '{"result":{"agents":[{"name":"build","pane_id":"p1","agent_status":"working","agent":"grok"},{"name":"orchestrator","pane_id":"p0"},{"name":"old8","pane_id":"p2","agent_status":"idle","agent":"agy"},{"name":"stray","pane_id":"p9","agent_status":"blocked","agent":"claude"}]}}',
      panes: '{"result":{"panes":[{"pane_id":"p1","tab_id":"t1"},{"pane_id":"p2","tab_id":"t2"},{"pane_id":"p5","tab_id":"t1"}]}}',
      tabs: '{"result":{"tabs":[{"tab_id":"t1","label":"herd-build-123456789012"},{"tab_id":"t2"}]}}',
    }),
    steps: [
      S(['roster']),
      // last-report-task points at an empty file: `pending`, not `ready`.
      S(['status', 'task']),
    ],
    files: ['state/ws/agents.tsv'],
  });
  // Empty roster: header, the (empty) other-live section, the footer.
  goldenScenario(SUITE, 'roster-empty', {
    seed: (fix) => seed(fix, { roster: R12 }),
    steps: [S(['roster'])],
  });
});

test('parity: friction empty and seeded', { timeout: 120000, skip: SKIP }, () => {
  goldenScenario(SUITE, 'friction-empty', {
    seed: (fix) => seed(fix, {}),
    steps: [S(['friction'])],
  });
  goldenScenario(SUITE, 'friction-seeded', {
    seed: (fix) => seed(fix, {
      friction: '2026-01-02T03:04:05\twarning\tstatus\told warning\n2026-01-02T03:04:06\terror(exit 4)\tstatus\told error\n',
    }),
    steps: [S(['friction'])],
  });
});

test('parity: status env error paths (usage, outside Herdr, herdr missing)', { timeout: 120000, skip: SKIP }, () => {
  goldenScenario(SUITE, 'status-env-errors', {
    seed: (fix) => seed(fix, { roster: R8 + WORKER8 }),
    steps: [
      S(['status']), // no agent name: die 2
      { args: ['status', 'worker'], env: withFakes({}) }, // no HERDR_ENV: die 2
      { args: ['status', 'worker'], env: { HERDR_ENV: '1', PATH: '/usr/bin:/bin' } }, // no herdr in PATH: die 2
    ],
  });
});

// The friction line carries a timestamp, so it is recorded by shape: run
// the implementation (the bash reference to record, the JS to check) and
// normalize the timestamp to TS.
function frictionValue(impl) {
  const fix = makeFixture();
  try {
    seed(fix, { mode: 'denied', roster: R8 + WORKER8 });
    const r = runImpl(impl, ['status', 'worker'], { env: { ...fix.env, ...withFakes({ HERDR_ENV: '1' }) }, cwd: fix.repo });
    const raw = fs.readFileSync(path.join(fix.state, 'ws', 'friction.log'), 'utf8').trim();
    const friction = raw.split('\n').map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'TS')).join('\n');
    return normalizeRoots({ rc: r.rc, friction }, { '<ROOT>': fix.root });
  } finally {
    fix.cleanup();
  }
}

test('parity: status denied also logs a friction entry (both implementations)', { timeout: 120000, skip: SKIP }, () => {
  let refValue;
  let actValue;
  const reference = () => (refValue !== undefined ? refValue : (refValue = frictionValue('bash'))); // record only
  const actual = () => (actValue !== undefined ? actValue : (actValue = frictionValue('node'))); // check/update
  golden(SUITE, 'status-denied-friction', actual, reference);
  const v = goldenMode() === 'record' ? reference() : actual();
  assert.equal(v.rc, 4, 'rc');
  assert.match(v.friction, /^TS\twarning\tstatus\tagent 'worker': herdr agent get failed: Error: Os \{ code: 13, kind: PermissionDenied, message: "Permission denied" \}$/);
});

// Node-only semantics (parity against the record is the golden value's
// job; these guard the shape the bash suite asserts: column counts,
// sanitized cause, no `agent get` when it must not run, the quota JSON).
test('node semantics: status columns, cause, no stray herdr queries, quota JSON', { timeout: 120000, skip: SKIP }, () => {
  const fix = makeFixture();
  try {
    const ws = path.join(fix.state, 'ws');
    seed(fix, { mode: 'denied', roster: R8 + WORKER8 });
    let r = run(fix, 'node', ['status', 'worker']);
    assert.equal(r.rc, 4);
    const f = r.out.trim().split('\t');
    assert.equal(f.length, 4, 'four columns with a cause');
    assert.equal(f[1], 'unavailable');
    assert.match(f[3], /PermissionDenied/);
    assert.match(f[3], /Permission denied/);
    assert.ok(!r.err.includes('gone'), 'stderr must not classify the failure as gone');
    assert.ok(!r.err.includes('\u001b'), 'no control characters leaked');

    // Report wins: done, and no `agent get` in the herdr log.
    fs.rmSync(path.join(fix.root, 'herdr.log'), { force: true });
    fs.writeFileSync(path.join(ws, 'last-report-worker'), path.join(ws, 'reports', 'worker.md') + '\n');
    fs.mkdirSync(path.join(ws, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'reports', 'worker.md'), 'report body\n');
    r = run(fix, 'node', ['status', 'worker']);
    assert.equal(r.rc, 0);
    assert.equal(r.out.trim(), `worker\tdone\t${path.join(ws, 'reports', 'worker.md')}`);
    assert.equal(fs.existsSync(path.join(fix.root, 'herdr.log')), false, 'no herdr call with a ready report');

    // Quota: JSON line, rc 11.
    fs.rmSync(path.join(ws, 'last-report-worker'), { force: true });
    seed(fix, {
      mode: 'idle',
      roster: R12 + 'build\tp1\tgrok\timplementer\txai\t1\t/work\t20260101T000000\tgrok-4.7\tfull\timplementer\tbuild\n',
      screen: 'hit your usage limit\ntry again in 2 hours\n',
    });
    r = run(fix, 'node', ['status', 'build']);
    assert.equal(r.rc, 11);
    const q = JSON.parse(r.out.trim());
    assert.equal(q.status, 'quota');
    assert.equal(q.lane, 'build');
    assert.equal(q.kind, 'grok');
    assert.equal(q.model, 'grok-4.7');
    assert.match(q.match, /hit your usage limit/);
    assert.match(q.renewal, /try again in 2 hours/);
  } finally {
    fix.cleanup();
  }
});
