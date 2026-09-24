// Golden (slice 9a-B; slice 7d scenario coverage): `doctor`,
// `doctor --fix` and `explain` now run only the JS and compare against the
// reference recorded once from the bash script in
// test/golden/parity-doctor.json (test/golden.mjs:
// HERDR_AGENTS_GOLDEN=record records, unset checks, =update overwrites the
// JS value for review). Scenarios: the doctor/doctor --fix parts of
// test-doctor-fix.sh (the legacy preset writes, the divergent review lane,
// the controlled-PATH kinds checks, the setup --panes / --detect /
// setup --no-hooks steps) and the doctor/explain parts of
// test-friendly.sh (first-run detection, the idle and roster explain, the
// waiting-for-report and quota lines, the no-arguments die, the ambiguous
// workspaces and the header-only rosters). The recorded value holds, per
// step: the exit code, the normalized stdout, the prefix-normalized stderr,
// and the final config file.
//
// Steps may mutate the fixture between runs (`before(fix)`, like the bash
// suites write the roster/config between run_cmd calls); the whole sequence
// is replayed per side. Accepted differences, normalized here (decisions of
// the slice brief): the bash still has the jq line (decision 5) — dropped,
// and the final ok count lowered by one; the entry path where the bash
// prints `$0` (decision 2b) — both entries normalize to PROG; the
// doctor --fix diff header — the bash shows its process substitution path
// (/dev/fd/N) and a timestamp, the JS shows the unifiedDiff a/<file> /
// b/<file> labels; both normalize to FIXDIFF. The bash-side normalization
// is applied inside the reference, so the recorded value is already
// normalized. The PATH is fully controlled (fakes dir + system dirs) so no
// host CLI can leak in.
//
// The bash script runs only as the `reference` (record mode); the JS runs
// only as the `actual` (check/update mode). Each side builds its own
// fixture from the same seed and returns the same value shape; the fixture
// root becomes <ROOT> in every string of the recorded value.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BASH_ENTRY, JS_ENTRY, LAUNCHER_ENTRIES, makeFixture, runImpl, normalizeErr } from './parity.mjs';
import { golden, goldenMode, normalizeRoots } from './golden.mjs';
import { findExecutable } from '../lib/platform.mjs';

// Record mode runs the bash reference: it needs bash and jq. Check mode
// runs the JS against the record and is skipped solely on Windows.
const SKIP =
  process.platform === 'win32'
    ? 'Windows: the bash reference (record) and the POSIX fixture contract (check) need a POSIX host'
    : (goldenMode() === 'record' && (!findExecutable('bash') || !findExecutable('jq'))
      ? 'record mode needs bash and jq on PATH'
      : false);

const SUITE = 'parity-doctor';

const AGENTS_SEED = '# Agent instructions\n';
const TSV_HEADER = '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\tmodel\tapprovals\troles\tlane\n';

// The controlled herdr of test-friendly.sh (versions agree; the roster
// agents build/review/queued/capped; `pane` reports workspace ws).
const HERDR_FAKE = `#!/bin/sh
case "$1" in
  --version) printf 'herdr 9.9.9\\n' ;;
  status) printf 'server 9.9.9\\n' ;;
  --skill) exit 0 ;;
  agent)
    case "$2" in
      get)
        case "$3" in
          build) printf '%s\\n' '{"result":{"agent":{"name":"build","agent_status":"working"}}}' ;;
          review) printf '%s\\n' '{"result":{"agent":{"name":"review","agent_status":"idle"}}}' ;;
          queued) printf '%s\\n' '{"result":{"agent":{"name":"queued","agent_status":"idle"}}}' ;;
          capped) printf '%s\\n' '{"result":{"agent":{"name":"capped","agent_status":"idle"}}}' ;;
          *) printf '%s\\n' '{"error":{"code":"agent_not_found","message":"no"}}' >&2; exit 1 ;;
        esac
        ;;
      read)
        if [ "$3" = capped ]; then printf '%s\\n' 'Individual quota reached'; fi
        ;;
      list) printf '%s\\n' '{"result":{"agents":[]}}' ;;
    esac
    ;;
  pane) printf '%s\\n' '{"result":{"pane":{"workspace_id":"ws"}}}' ;;
  *) exit 0 ;;
esac
exit 0
`;

// A herdr that knows no current pane (the ambiguity scenarios).
const NOPANE_FAKE = `#!/bin/sh
exit 1
`;

const GROK_FAKE = `#!/bin/sh
if [ "$1" = models ]; then printf '%s\n' grok-4.7 grok-4 grok-3; fi
`;

// seedFakes: the jq/git symlinks, the timeout shim and the requested fakes
// into <fixture>/fakes. The seed runs once per golden side (the fixture is
// fresh per side): start from a clean dir.
function seedFakes(fix, { herdr = null, grok = false } = {}) {
  const fakes = path.join(fix.root, 'fakes');
  fs.rmSync(fakes, { recursive: true, force: true });
  fs.mkdirSync(fakes, { recursive: true });
  for (const name of ['jq', 'git']) {
    const real = findExecutable(name);
    if (real) fs.symlinkSync(real, path.join(fakes, name));
  }
  fs.writeFileSync(path.join(fakes, 'timeout'), '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o755 });
  if (herdr) fs.writeFileSync(path.join(fakes, 'herdr'), herdr, { mode: 0o755 });
  if (grok) fs.writeFileSync(path.join(fakes, 'grok'), GROK_FAKE, { mode: 0o755 });
  return fakes;
}

// The fully controlled PATH (the getter resolves after the seed ran).
const ctrlPath = (st) => ({ get PATH() { return `${st.fakes}:/usr/bin:/bin`; } });

// The legacy config of test-doctor-fix.sh (every laned role on grok).
const LEGACY = `# keep this comment
split_max_panes=6
role.implementer.kind=grok
role.designer.kind=grok
role.tasker.kind=grok
role.scouter.kind=grok
role.researcher.kind=grok
role.reviewer.kind=grok
role.security-reviewer.kind=grok
role.ui-reviewer.kind=grok
role.inspector.kind=grok
role.planner.model=fable
# tail comment
`;
const DIVERGENT = `# keep this comment
split_max_panes=6
role.reviewer.kind=codex
role.security-reviewer.kind=claude
role.planner.model=fable
# tail comment
`;

const PROJ_CONF = (fix) => path.join(fix.repo, '.agents', 'herdr-agents.conf');
const writeConf = (fix, text) => {
  fs.mkdirSync(path.dirname(PROJ_CONF(fix)), { recursive: true });
  fs.writeFileSync(PROJ_CONF(fix), text);
};
const TSV = (fix) => path.join(fix.state, 'ws', 'agents.tsv');
const writeTsv = (fix, text) => {
  fs.mkdirSync(path.dirname(TSV(fix)), { recursive: true });
  fs.writeFileSync(TSV(fix), text);
};

// normOut: the accepted doctor-output differences (jq line + count, the
// $0/entry path, the doctor --fix diff header). Applied to both sides —
// it is the normalization the parity comparison used — so the recorded
// (bash) value is already normalized and the JS value normalizes the same
// way.
function normOut(out) {
  const lines = out.split('\n');
  let dropOk = 0;
  const kept = lines.filter((l) => {
    if (/^(ok|warn)\s+jq /.test(l)) {
      if (l.startsWith('ok')) dropOk += 1;
      return false;
    }
    return true;
  });
  for (let i = kept.length - 1; i >= 0 && i >= kept.length - 3; i--) {
    const m = kept[i].match(/^(\d+) ok, (\d+) warning\(s\)$/);
    if (m) {
      if (dropOk > 0) kept[i] = `${Number(m[1]) - dropOk} ok, ${m[2]} warning(s)`;
      break;
    }
  }
  return kept.join('\n')
    .replaceAll(BASH_ENTRY, 'PROG')
    .replaceAll(JS_ENTRY, 'PROG')
    .replaceAll(LAUNCHER_ENTRIES[0], 'PROG')
    .replaceAll(LAUNCHER_ENTRIES[1], 'PROG')
    .replace(/^--- \/dev\/fd\/\d+\s.*$/m, '--- FIXDIFF')
    .replace(/^--- a\/.+$/m, '--- FIXDIFF')
    .replace(/^\+\+\+ \S+.*$/m, '+++ FIXDIFF');
}

// Run every step against one implementation in a fresh fixture (with the
// before-hooks), and return the golden value: rc, normalized stdout,
// prefix-normalized stderr per step and the final config file. The fixture
// root becomes <ROOT> in every string of the value.
function doctorValue(impl, opts) {
  const fix = makeFixture();
  try {
    fix.reset();
    fs.rmSync(path.join(fix.repo, 'AGENTS.md'), { force: true });
    fs.rmSync(path.join(fix.repo, 'CLAUDE.md'), { force: true });
    fs.rmSync(path.join(fix.repo, '.claude'), { recursive: true, force: true });
    fs.writeFileSync(path.join(fix.repo, 'AGENTS.md'), AGENTS_SEED);
    if (opts.seed) opts.seed(fix);
    const results = [];
    for (const step of opts.steps) {
      if (step.before) step.before(fix);
      const stepEnv = step.env ? { ...fix.env, ...step.env } : fix.env;
      const r = runImpl(impl, step.args, { env: stepEnv, cwd: fix.repo });
      results.push({ args: step.args, rc: r.rc, out: normOut(r.out), err: normalizeErr(r.err) });
    }
    const conf = fs.existsSync(PROJ_CONF(fix)) ? fs.readFileSync(PROJ_CONF(fix), 'utf8') : null;
    return normalizeRoots({ steps: results, conf }, { '<ROOT>': fix.root });
  } finally {
    fix.cleanup();
  }
}

// Golden wrapper: record runs the bash reference, check/update run the JS;
// the value is returned for the per-scenario assertions.
function doctorScenario(name, opts) {
  let refValue;
  let actValue;
  const reference = () => (refValue !== undefined ? refValue : (refValue = doctorValue('bash', opts))); // record only
  const actual = () => (actValue !== undefined ? actValue : (actValue = doctorValue('node', opts))); // check/update
  golden(SUITE, name, actual, reference);
  return goldenMode() === 'record' ? reference() : actual();
}

const stPath = (st) => ctrlPath(st);

// ---------- test-doctor-fix.sh scenarios ----------

test('parity: doctor --fix without panes dies 2 and leaves the file (test-doctor-fix.sh)', { timeout: 60000, skip: SKIP }, () => {
  const st = { fakes: '' };
  const r = doctorScenario('fix-nopanes', {
    seed: (fix) => {
      st.fakes = seedFakes(fix);
      writeConf(fix, LEGACY);
    },
    steps: [{ args: ['doctor', '--fix'], env: stPath(st) }],
  });
  const s = r.steps[0];
  assert.equal(s.rc, 2, s.err);
  assert.ok(s.err.includes('doctor --fix: panes is not set in'), s.err);
  assert.ok(s.err.includes('doctor --fix --panes 3'), s.err);
  assert.equal(s.out, '', 'nothing on stdout');
  assert.equal(r.conf, LEGACY, 'the file is untouched by the die');
});

test('parity: doctor on the legacy config warns about the missing panes and the cap (test-doctor-fix.sh)', { timeout: 60000, skip: SKIP }, () => {
  const st = { fakes: '' };
  const r = doctorScenario('doctor-legacy', {
    seed: (fix) => {
      st.fakes = seedFakes(fix);
      writeConf(fix, LEGACY);
    },
    steps: [{ args: ['doctor'], env: stPath(st) }],
  });
  const s = r.steps[0];
  assert.equal(s.rc, 0, s.err);
  assert.ok(s.out.includes('panes is not set'), s.out);
  assert.ok(s.out.includes('split_max_panes=6'), s.out);
  assert.ok(s.out.includes('role_planner_model is set (project)'), s.out);
});

test('parity: doctor --fix --panes 3 writes the preset 3 (test-doctor-fix.sh)', { timeout: 60000, skip: SKIP }, () => {
  const st = { fakes: '' };
  const r = doctorScenario('fix3', {
    seed: (fix) => {
      st.fakes = seedFakes(fix);
      writeConf(fix, LEGACY);
    },
    steps: [{ args: ['doctor', '--fix', '--panes', '3'], env: stPath(st) }],
  });
  const s = r.steps[0];
  assert.equal(s.rc, 0, s.err);
  assert.ok(s.out.includes('set panes=3'), s.out);
  assert.ok(s.out.includes('doctor --fix: updated'), s.out);
  assert.ok(s.out.includes('first_run:'), 'the check re-runs after the fix');
  const conf = r.conf;
  for (const line of ['panes=3', 'lane.build.roles=implementer,designer,tasker', 'lane.read.roles=scouter,researcher,reviewer,security-reviewer,ui-reviewer,inspector', 'max_workers=2', 'split_max_panes=3', 'reuse_workers=on', 'lane.build.kind=grok', 'lane.read.kind=grok', '# keep this comment', '# tail comment']) {
    assert.ok(conf.split('\n').includes(line), `missing ${line}:\n${conf}`);
  }
  assert.ok(!conf.includes('role.implementer.kind'), conf);
  assert.ok(!conf.includes('role.planner.model'), conf);
  assert.ok(!conf.includes('lane.explore.roles'), conf);
});

test('parity: doctor --fix --panes 4 writes the preset 4 (test-doctor-fix.sh)', { timeout: 60000, skip: SKIP }, () => {
  const st = { fakes: '' };
  const r = doctorScenario('fix4', {
    seed: (fix) => {
      st.fakes = seedFakes(fix);
      writeConf(fix, LEGACY);
    },
    steps: [{ args: ['doctor', '--fix', '--panes', '4'], env: stPath(st) }],
  });
  const s = r.steps[0];
  assert.equal(s.rc, 0, s.err);
  const conf = r.conf;
  for (const line of ['panes=4', 'lane.explore.roles=scouter,researcher', 'lane.review.roles=reviewer,security-reviewer,ui-reviewer,inspector', 'max_workers=3', 'split_max_panes=4', 'lane.build.kind=grok', 'lane.explore.kind=grok', 'lane.review.kind=grok']) {
    assert.ok(conf.split('\n').includes(line), `missing ${line}:\n${conf}`);
  }
  assert.ok(!conf.includes('role.reviewer.kind'), conf);
});

test('parity: doctor --fix --panes 4 on a divergent review lane keeps the per-role kinds (test-doctor-fix.sh)', { timeout: 60000, skip: SKIP }, () => {
  const st = { fakes: '' };
  const r = doctorScenario('fix4-divergent', {
    seed: (fix) => {
      st.fakes = seedFakes(fix);
      writeConf(fix, DIVERGENT);
    },
    steps: [{ args: ['doctor', '--fix', '--panes', '4'], env: stPath(st) }],
  });
  const s = r.steps[0];
  assert.equal(s.rc, 0, s.err);
  assert.ok(s.err.includes('reviewer=codex') && s.err.includes('security-reviewer=claude'), s.err);
  assert.ok(s.err.includes('setup --lane review='), s.err);
  assert.ok(!s.err.includes('models differ'), 'a frontmatter model is not a lane conflict');
  const conf = r.conf;
  assert.ok(conf.split('\n').includes('role.reviewer.kind=codex'), conf);
  assert.ok(conf.split('\n').includes('role.security-reviewer.kind=claude'), conf);
  assert.ok(!/^lane\.review\.kind=/m.test(conf), conf);
  assert.ok(!/^lane\.build\.kind=/m.test(conf), conf);
  assert.ok(!/^lane\.review\.model=/m.test(conf), conf);
  assert.ok(conf.split('\n').includes('lane.explore.kind=grok'), conf);
  assert.ok(!conf.includes('role.planner.model'), conf);
});

test('parity: doctor warns only about the kinds the effective config uses (test-doctor-fix.sh, controlled PATH)', { timeout: 90000, skip: SKIP }, () => {
  const st = { fakes: '' };
  const r = doctorScenario('kinds', {
    seed: (fix) => {
      st.fakes = seedFakes(fix, { grok: true });
      writeConf(fix, LEGACY);
    },
    steps: [
      // Every laned role on grok; the grok fake on PATH → only grok is in
      // use: no missing-kind warning at all.
      { args: ['doctor'], env: stPath(st) },
      // Every laned role on codex (absent from the controlled PATH): the
      // warning names codex and nothing else — unused kinds stay quiet.
      {
        before: (fix) => {
          const roles = ['implementer', 'designer', 'tasker', 'scouter', 'researcher', 'reviewer', 'security-reviewer', 'ui-reviewer', 'inspector'];
          writeConf(fix, roles.map((r) => `role.${r}.kind=codex`).join('\n') + '\n');
        },
        args: ['doctor'],
        env: stPath(st),
      },
    ],
  });
  const ok = r.steps[0];
  assert.equal(ok.rc, 0, ok.err);
  assert.ok(ok.out.includes('kinds installed: grok'), ok.out);
  assert.ok(!ok.out.includes('kinds in use but not in PATH'), ok.out);
  const missing = r.steps[1];
  assert.equal(missing.rc, 0, missing.err);
  const kline = missing.out.split('\n').find((l) => l.includes('kinds in use but not in PATH')) ?? '';
  assert.ok(kline.includes('codex'), kline);
  for (const unused of ['claude', 'agy', 'cursor', 'gemini', 'grok', 'opencode', 'pi']) {
    assert.ok(!kline.split(/\s+/).includes(unused), `the warning must not name ${unused}: ${kline}`);
  }
});

test('parity: doctor with lanes off counts no planner kind (test-doctor-fix.sh, controlled PATH)', { timeout: 60000, skip: SKIP }, () => {
  const st = { fakes: '' };
  const r = doctorScenario('kinds-lanes-off', {
    seed: (fix) => {
      st.fakes = seedFakes(fix, { grok: true });
      const roles = ['implementer', 'designer', 'tasker', 'scouter', 'researcher', 'reviewer', 'security-reviewer', 'ui-reviewer', 'inspector', 'sub-orchestrator'];
      writeConf(fix, ['lanes=off', ...roles.map((r) => `role.${r}.kind=grok`)].join('\n') + '\n');
    },
    steps: [{ args: ['doctor'], env: stPath(st) }],
  });
  const s = r.steps[0];
  assert.equal(s.rc, 0, s.err);
  assert.ok(s.out.includes('kinds installed: grok'), s.out);
  assert.ok(!s.out.includes('kinds in use but not in PATH'), s.out);
});

test('parity: setup --panes / --detect / the config-prompt steps (test-doctor-fix.sh tail, slices 7a/7b)', { timeout: 120000, skip: SKIP }, () => {
  const st = { fakes: '' };
  const r = doctorScenario('setup-tail', {
    seed: (fix) => {
      st.fakes = seedFakes(fix, { grok: true });
      writeConf(fix, LEGACY);
    },
    steps: [
      { args: ['setup', '--panes', '4', '--lane', 'build=grok:grok-4.7:high', '--no-hooks'], env: stPath(st) },
      {
        before: (fix) => {
          // the bash suite greps the conf right after the setup step
          assert.ok(fs.readFileSync(PROJ_CONF(fix), 'utf8').includes('lane.build.effort=high'), 'setup --panes must persist the lane effort');
        },
        args: ['setup', '--detect'],
        env: stPath(st),
      },
      // max_workers written by --fix is not "the user already chose".
      {
        before: (fix) => writeConf(fix, 'max_workers=3\n'),
        args: ['setup', '--no-hooks'],
        env: stPath(st),
      },
      {
        before: (fix) => writeConf(fix, 'lane.build.kind=grok\n'),
        args: ['setup', '--no-hooks'],
        env: stPath(st),
      },
    ],
  });
  assert.equal(r.steps[0].rc, 0, r.steps[0].err);
  assert.ok(r.steps[0].out.includes('set panes=4'), r.steps[0].out);
  assert.equal(r.steps[1].rc, 0, r.steps[1].err);
  assert.ok(r.steps[1].out.includes('effective_lanes'), r.steps[1].out);
  assert.equal(r.steps[2].rc, 0, r.steps[2].err);
  assert.ok(r.steps[2].err.includes('ask the user'), r.steps[2].err);
  assert.equal(r.steps[3].rc, 0, r.steps[3].err);
  assert.ok(!r.steps[3].err.includes('sets neither'), r.steps[3].err);
});

// ---------- test-friendly.sh doctor/explain scenarios ----------

test('parity: doctor first-run detection (test-friendly.sh)', { timeout: 120000, skip: SKIP }, () => {
  const st = { fakes: '' };
  const r = doctorScenario('first-run', {
    seed: (fix) => {
      st.fakes = seedFakes(fix); // no herdr fake: the doctor sees none on PATH
    },
    steps: [
      // No config, no roster → first run.
      { args: ['doctor'], env: stPath(st) },
      // The header the state dir writes is not a roster (the previous
      // doctor created it; a header-only roster is written too so the step
      // is deterministic).
      {
        before: (fix) => writeTsv(fix, TSV_HEADER),
        args: ['doctor'],
        env: stPath(st),
      },
      // A team choice in the config is not a first run.
      {
        before: (fix) => writeConf(fix, 'lane.build.kind=grok\n'),
        args: ['doctor'],
        env: stPath(st),
      },
      // A roster row without any config is not either.
      {
        before: (fix) => {
          fs.rmSync(PROJ_CONF(fix), { force: true });
          writeTsv(fix, TSV_HEADER + 'build\tp1\tgrok\timplementer\txai\t1\t/work\tt1\tgrok-4.7\tfull\timplementer\tbuild\n');
        },
        args: ['doctor'],
        env: stPath(st),
      },
      // Comments and max_workers are not a team choice.
      {
        before: (fix) => {
          writeConf(fix, '# note\nmax_workers=3\n');
          writeTsv(fix, TSV_HEADER);
        },
        args: ['doctor'],
        env: stPath(st),
      },
    ],
  });
  assert.ok(r.steps[0].out.includes('first_run: true'), r.steps[0].out);
  assert.ok(r.steps[1].out.includes('first_run: true'), 'header-only roster counts as agents: ' + r.steps[1].out);
  assert.ok(r.steps[2].out.includes('first_run: false'), 'config choice: ' + r.steps[2].out);
  assert.ok(r.steps[3].out.includes('first_run: false'), 'roster row: ' + r.steps[3].out);
  assert.ok(r.steps[4].out.includes('first_run: true'), 'max_workers alone: ' + r.steps[4].out);
});

test('parity: explain idle, roster, waiting-for-report and quota (test-friendly.sh)', { timeout: 120000, skip: SKIP }, () => {
  const st = { fakes: '' };
  const r = doctorScenario('explain', {
    seed: (fix) => {
      st.fakes = seedFakes(fix, { herdr: HERDR_FAKE, grok: true });
      fs.mkdirSync(path.join(fix.state, 'ws'), { recursive: true });
    },
    steps: [
      // No roster → the idle paragraph.
      { args: ['explain'], env: stPath(st) },
      // A roster with the fake herdr (build working, review idle).
      {
        before: (fix) => writeTsv(fix,
          'build\tp1\tgrok\timplementer\txai\t1\t/work\tt1\tgrok-4.7\tfull\timplementer\tbuild\n' +
          'review\tp2\tcodex\treviewer\topenai\t1\t/work\tt2\tgpt-5\task\treviewer\treview\n'),
        args: ['explain'],
        env: stPath(st),
      },
      // A recorded report whose file is missing: the worker waits on it.
      {
        before: (fix) => {
          writeTsv(fix, 'queued\tp1\tgrok\timplementer\txai\t1\t/work\tt1\tgrok-4.7\tfull\timplementer\tbuild\n');
          fs.mkdirSync(path.join(fix.state, 'ws', 'reports'), { recursive: true });
          fs.writeFileSync(path.join(fix.state, 'ws', 'last-report-queued'), path.join(fix.state, 'ws', 'reports', 'queued.md') + '\n');
          fs.rmSync(path.join(fix.state, 'ws', 'reports', 'queued.md'), { force: true });
        },
        args: ['explain'],
        env: stPath(st),
      },
      // An agent whose visible screen says the quota was reached.
      {
        before: (fix) => {
          writeTsv(fix, 'capped\tp2\tcodex\treviewer\topenai\t1\t/work\tt2\tgpt-5\task\treviewer\treview\n');
          fs.rmSync(path.join(fix.state, 'ws', 'last-report-capped'), { force: true });
        },
        args: ['explain'],
        env: stPath(st),
      },
    ],
  });
  const r0 = r.steps[0];
  assert.equal(r0.rc, 0, r0.err);
  assert.ok(r0.out.includes('Nothing is running yet.'), r0.out);
  assert.ok(r0.out.includes('never commit'), r0.out);
  assert.ok(r0.out.includes('Four panels are recommended'), r0.out);
  assert.ok(!/^\{/.test(r0.out), 'explain is never JSON');
  const r1 = r.steps[1];
  assert.equal(r1.rc, 0, r1.err);
  assert.ok(r1.out.includes('build: implementer, grok, model grok-4.7, working'), r1.out);
  assert.ok(r1.out.includes('review: reviewer, codex, model gpt-5, idle'), r1.out);
  assert.ok(r1.out.includes('Panels: 4.'), r1.out);
  assert.ok(r1.out.includes('Recommendation: 4 panels'), r1.out);
  assert.ok(r.steps[2].out.includes('build: implementer, grok, model grok-4.7, waiting for report'), r.steps[2].out);
  assert.ok(r.steps[3].out.includes('review: reviewer, codex, model gpt-5, out of quota'), r.steps[3].out);
});

test('parity: explain --json dies 2 (test-friendly.sh)', { timeout: 60000, skip: SKIP }, () => {
  const st = { fakes: '' };
  const r = doctorScenario('explain-args', {
    seed: (fix) => {
      st.fakes = seedFakes(fix, { herdr: HERDR_FAKE });
    },
    steps: [{ args: ['explain', '--json'], env: stPath(st) }],
  });
  const s = r.steps[0];
  assert.equal(s.rc, 2, s.err);
  assert.ok(s.err.includes('explain: takes no arguments'), s.err);
});

test('parity: explain with two rosters and no current workspace names the ambiguity (test-friendly.sh)', { timeout: 60000, skip: SKIP }, () => {
  const st = { fakes: '' };
  const r = doctorScenario('explain-ambiguous', {
    seed: (fix) => {
      st.fakes = seedFakes(fix, { herdr: NOPANE_FAKE });
      for (const w of ['ws-a', 'ws-b']) {
        fs.mkdirSync(path.join(fix.state, w), { recursive: true });
        fs.writeFileSync(path.join(fix.state, w, 'agents.tsv'),
          '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\n' +
          `build\tp-${w}\tgrok\timplementer\txai\t1\t${fix.repo}\tnow\n`);
      }
    },
    // The fixture env carries HERDR_WORKSPACE_ID=ws — clear it: the command
    // is not running inside one of the workspaces.
    steps: [{ args: ['explain'], env: { ...stPath(st), HERDR_WORKSPACE_ID: '' } }],
  });
  const s = r.steps[0];
  assert.equal(s.rc, 0, s.err);
  assert.ok(s.out.includes('more than one Herdr workspace'), s.out);
  assert.ok(s.out.includes('Run explain from a panel inside the workspace you are asking about.'), s.out);
  assert.ok(!s.out.includes('Nothing is running'), s.out);
});

test('parity: explain with two header-only rosters answers with the idle paragraph (test-friendly.sh)', { timeout: 60000, skip: SKIP }, () => {
  const st = { fakes: '' };
  const r = doctorScenario('explain-empty-workspaces', {
    seed: (fix) => {
      st.fakes = seedFakes(fix, { herdr: NOPANE_FAKE });
      for (const w of ['ws-c', 'ws-d']) {
        fs.mkdirSync(path.join(fix.state, w), { recursive: true });
        fs.writeFileSync(path.join(fix.state, w, 'agents.tsv'),
          '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\n');
      }
    },
    steps: [{ args: ['explain'], env: { ...stPath(st), HERDR_WORKSPACE_ID: '' } }],
  });
  const s = r.steps[0];
  assert.equal(s.rc, 0, s.err);
  assert.ok(!s.out.includes('more than one Herdr workspace'), s.out);
  assert.ok(s.out.includes('Nothing is running yet.'), s.out);
});
