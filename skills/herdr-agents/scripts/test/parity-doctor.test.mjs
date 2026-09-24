// Parity (slice 7d): `doctor`, `doctor --fix` and `explain` run against
// `bash scripts/herdr-agents.sh` and `node scripts/herdr-agents.mjs` in an
// identical fixture must produce identical stdout, exit code and
// (prefix-normalized) stderr, and leave the same config file. Scenarios:
// the doctor/doctor --fix parts of test-doctor-fix.sh (the legacy preset
// writes, the divergent review lane, the controlled-PATH kinds checks, the
// setup --panes / --detect / setup --no-hooks steps) and the
// doctor/explain parts of test-friendly.sh (first-run detection, the idle
// and roster explain, the waiting-for-report and quota lines, the
// no-arguments die, the ambiguous workspaces and the header-only rosters).
//
// Steps may mutate the fixture between runs (`before(fix)`, like the bash
// suites write the roster/config between run_cmd calls); the whole sequence
// is replayed per implementation. Accepted differences, normalized here
// (decisions of the slice brief): the bash still has the jq line
// (decision 5) — dropped, and the final ok count lowered by one; the entry
// path where the bash prints `$0` (decision 2b) — both entries normalize to
// PROG; the doctor --fix diff header — the bash shows its process
// substitution path (/dev/fd/N) and a timestamp, the JS shows the
// unifiedDiff a/<file> / b/<file> labels; both normalize to FIXDIFF. The
// PATH is fully controlled (fakes dir + system dirs) so no host CLI can
// leak in.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BASH_ENTRY, JS_ENTRY, makeFixture, runImpl, normalizeErr } from './parity.mjs';
import { findExecutable } from '../lib/platform.mjs';

const HAS_JQ = Boolean(findExecutable('jq'));
const SKIP_JQ = HAS_JQ ? false : 'jq is required for the bash parity run';

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
// into <fixture>/fakes. The seed runs once per implementation (the
// harness resets the fixture, not the fakes dir): start from a clean dir.
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
// $0/entry path, the doctor --fix diff header).
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
    .replace(/^--- \/dev\/fd\/\d+\s.*$/m, '--- FIXDIFF')
    .replace(/^--- a\/.+$/m, '--- FIXDIFF')
    .replace(/^\+\+\+ \S+.*$/m, '+++ FIXDIFF');
}

// One parity scenario: seed the fixture once per implementation, replay
// every step (with its before-hook) with both, compare rc / normalized
// stdout / normalized stderr per step, and compare the final config file.
function parityDoctor(name, opts) {
  const fix = makeFixture();
  let bashRes;
  let nodeRes;
  let bashConf;
  let nodeConf;
  try {
    for (const impl of ['bash', 'node']) {
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
        results.push(runImpl(impl, step.args, { env: stepEnv, cwd: fix.repo }));
      }
      const conf = fs.existsSync(PROJ_CONF(fix)) ? fs.readFileSync(PROJ_CONF(fix), 'utf8') : null;
      if (impl === 'bash') { bashRes = results; bashConf = conf; }
      else { nodeRes = results; nodeConf = conf; }
    }
  } finally {
    fix.cleanup();
  }
  assert.equal(nodeRes.length, bashRes.length, `${name}: step count`);
  for (let i = 0; i < bashRes.length; i++) {
    const where = `${name}: step ${i + 1} (${opts.steps[i].args.join(' ')})`;
    assert.equal(nodeRes[i].rc, bashRes[i].rc, `${where}: exit code (bash=${bashRes[i].rc} node=${nodeRes[i].rc})`);
    assert.equal(normOut(nodeRes[i].out), normOut(bashRes[i].out), `${where}: stdout (normalized) — node:\n${nodeRes[i].out}\n--- bash:\n${bashRes[i].out}`);
    assert.equal(normalizeErr(nodeRes[i].err), normalizeErr(bashRes[i].err), `${where}: stderr normalized — node:\n${nodeRes[i].err}\n--- bash:\n${bashRes[i].err}`);
  }
  assert.equal(nodeConf, bashConf, `${name}: the final config file must be identical`);
  return { bash: bashRes, node: nodeRes, conf: nodeConf };
}

const stPath = (st) => ctrlPath(st);

// ---------- test-doctor-fix.sh scenarios ----------

test('parity: doctor --fix without panes dies 2 and leaves the file (test-doctor-fix.sh)', { timeout: 60000 }, (t) => {
  void t;
  const st = { fakes: '' };
  const res = parityDoctor('fix-nopanes', {
    seed: (fix) => {
      st.fakes = seedFakes(fix);
      writeConf(fix, LEGACY);
    },
    steps: [{ args: ['doctor', '--fix'], env: stPath(st) }],
  });
  const r = res.node[0];
  assert.equal(r.rc, 2, r.err);
  assert.ok(r.err.includes('doctor --fix: panes is not set in'), r.err);
  assert.ok(r.err.includes('doctor --fix --panes 3'), r.err);
  assert.equal(r.out, '', 'nothing on stdout');
  assert.equal(res.conf, LEGACY, 'the file is untouched by the die');
});

test('parity: doctor on the legacy config warns about the missing panes and the cap (test-doctor-fix.sh)', { timeout: 60000 }, (t) => {
  void t;
  const st = { fakes: '' };
  const res = parityDoctor('doctor-legacy', {
    seed: (fix) => {
      st.fakes = seedFakes(fix);
      writeConf(fix, LEGACY);
    },
    steps: [{ args: ['doctor'], env: stPath(st) }],
  });
  const r = res.node[0];
  assert.equal(r.rc, 0, r.err);
  assert.ok(r.out.includes('panes is not set'), r.out);
  assert.ok(r.out.includes('split_max_panes=6'), r.out);
  assert.ok(r.out.includes('role_planner_model is set (project)'), r.out);
});

test('parity: doctor --fix --panes 3 writes the preset 3 (test-doctor-fix.sh)', { timeout: 60000 }, (t) => {
  void t;
  const st = { fakes: '' };
  const res = parityDoctor('fix3', {
    seed: (fix) => {
      st.fakes = seedFakes(fix);
      writeConf(fix, LEGACY);
    },
    steps: [{ args: ['doctor', '--fix', '--panes', '3'], env: stPath(st) }],
  });
  const r = res.node[0];
  assert.equal(r.rc, 0, r.err);
  assert.ok(r.out.includes('set panes=3'), r.out);
  assert.ok(r.out.includes('doctor --fix: updated'), r.out);
  assert.ok(r.out.includes('first_run:'), 'the check re-runs after the fix');
  const conf = res.conf;
  for (const line of ['panes=3', 'lane.build.roles=implementer,designer,tasker', 'lane.read.roles=scouter,researcher,reviewer,security-reviewer,ui-reviewer,inspector', 'max_workers=2', 'split_max_panes=3', 'reuse_workers=on', 'lane.build.kind=grok', 'lane.read.kind=grok', '# keep this comment', '# tail comment']) {
    assert.ok(conf.split('\n').includes(line), `missing ${line}:\n${conf}`);
  }
  assert.ok(!conf.includes('role.implementer.kind'), conf);
  assert.ok(!conf.includes('role.planner.model'), conf);
  assert.ok(!conf.includes('lane.explore.roles'), conf);
});

test('parity: doctor --fix --panes 4 writes the preset 4 (test-doctor-fix.sh)', { timeout: 60000 }, (t) => {
  void t;
  const st = { fakes: '' };
  const res = parityDoctor('fix4', {
    seed: (fix) => {
      st.fakes = seedFakes(fix);
      writeConf(fix, LEGACY);
    },
    steps: [{ args: ['doctor', '--fix', '--panes', '4'], env: stPath(st) }],
  });
  const r = res.node[0];
  assert.equal(r.rc, 0, r.err);
  const conf = res.conf;
  for (const line of ['panes=4', 'lane.explore.roles=scouter,researcher', 'lane.review.roles=reviewer,security-reviewer,ui-reviewer,inspector', 'max_workers=3', 'split_max_panes=4', 'lane.build.kind=grok', 'lane.explore.kind=grok', 'lane.review.kind=grok']) {
    assert.ok(conf.split('\n').includes(line), `missing ${line}:\n${conf}`);
  }
  assert.ok(!conf.includes('role.reviewer.kind'), conf);
});

test('parity: doctor --fix --panes 4 on a divergent review lane keeps the per-role kinds (test-doctor-fix.sh)', { timeout: 60000 }, (t) => {
  void t;
  const st = { fakes: '' };
  const res = parityDoctor('fix4-divergent', {
    seed: (fix) => {
      st.fakes = seedFakes(fix);
      writeConf(fix, DIVERGENT);
    },
    steps: [{ args: ['doctor', '--fix', '--panes', '4'], env: stPath(st) }],
  });
  const r = res.node[0];
  assert.equal(r.rc, 0, r.err);
  assert.ok(r.err.includes('reviewer=codex') && r.err.includes('security-reviewer=claude'), r.err);
  assert.ok(r.err.includes('setup --lane review='), r.err);
  assert.ok(!r.err.includes('models differ'), 'a frontmatter model is not a lane conflict');
  const conf = res.conf;
  assert.ok(conf.split('\n').includes('role.reviewer.kind=codex'), conf);
  assert.ok(conf.split('\n').includes('role.security-reviewer.kind=claude'), conf);
  assert.ok(!/^lane\.review\.kind=/m.test(conf), conf);
  assert.ok(!/^lane\.build\.kind=/m.test(conf), conf);
  assert.ok(!/^lane\.review\.model=/m.test(conf), conf);
  assert.ok(conf.split('\n').includes('lane.explore.kind=grok'), conf);
  assert.ok(!conf.includes('role.planner.model'), conf);
});

test('parity: doctor warns only about the kinds the effective config uses (test-doctor-fix.sh, controlled PATH)', { timeout: 90000 }, (t) => {
  void t;
  const st = { fakes: '' };
  const res = parityDoctor('kinds', {
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
  const ok = res.node[0];
  assert.equal(ok.rc, 0, ok.err);
  assert.ok(ok.out.includes('kinds installed: grok'), ok.out);
  assert.ok(!ok.out.includes('kinds in use but not in PATH'), ok.out);
  const missing = res.node[1];
  assert.equal(missing.rc, 0, missing.err);
  const kline = missing.out.split('\n').find((l) => l.includes('kinds in use but not in PATH')) ?? '';
  assert.ok(kline.includes('codex'), kline);
  for (const unused of ['claude', 'agy', 'cursor', 'gemini', 'grok', 'opencode', 'pi']) {
    assert.ok(!kline.split(/\s+/).includes(unused), `the warning must not name ${unused}: ${kline}`);
  }
});

test('parity: doctor with lanes off counts no planner kind (test-doctor-fix.sh, controlled PATH)', { timeout: 60000 }, (t) => {
  void t;
  const st = { fakes: '' };
  const res = parityDoctor('kinds-lanes-off', {
    seed: (fix) => {
      st.fakes = seedFakes(fix, { grok: true });
      const roles = ['implementer', 'designer', 'tasker', 'scouter', 'researcher', 'reviewer', 'security-reviewer', 'ui-reviewer', 'inspector', 'sub-orchestrator'];
      writeConf(fix, ['lanes=off', ...roles.map((r) => `role.${r}.kind=grok`)].join('\n') + '\n');
    },
    steps: [{ args: ['doctor'], env: stPath(st) }],
  });
  const r = res.node[0];
  assert.equal(r.rc, 0, r.err);
  assert.ok(r.out.includes('kinds installed: grok'), r.out);
  assert.ok(!r.out.includes('kinds in use but not in PATH'), r.out);
});

test('parity: setup --panes / --detect / the config-prompt steps (test-doctor-fix.sh tail, slices 7a/7b)', { timeout: 120000, skip: SKIP_JQ }, (t) => {
  void t;
  const st = { fakes: '' };
  const res = parityDoctor('setup-tail', {
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
  assert.equal(res.node[0].rc, 0, res.node[0].err);
  assert.ok(res.node[0].out.includes('set panes=4'), res.node[0].out);
  assert.equal(res.node[1].rc, 0, res.node[1].err);
  assert.ok(res.node[1].out.includes('effective_lanes'), res.node[1].out);
  assert.equal(res.node[2].rc, 0, res.node[2].err);
  assert.ok(res.node[2].err.includes('ask the user'), res.node[2].err);
  assert.equal(res.node[3].rc, 0, res.node[3].err);
  assert.ok(!res.node[3].err.includes('sets neither'), res.node[3].err);
});

// ---------- test-friendly.sh doctor/explain scenarios ----------

test('parity: doctor first-run detection (test-friendly.sh)', { timeout: 120000 }, (t) => {
  void t;
  const st = { fakes: '' };
  const res = parityDoctor('first-run', {
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
          writeTsv(fix, TSV_HEADER + 'build\tp1\tgrok\timplementer\txai\t1\t/tmp/work\tt1\tgrok-4.7\tfull\timplementer\tbuild\n');
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
  assert.ok(res.node[0].out.includes('first_run: true'), res.node[0].out);
  assert.ok(res.node[1].out.includes('first_run: true'), 'header-only roster counts as agents: ' + res.node[1].out);
  assert.ok(res.node[2].out.includes('first_run: false'), 'config choice: ' + res.node[2].out);
  assert.ok(res.node[3].out.includes('first_run: false'), 'roster row: ' + res.node[3].out);
  assert.ok(res.node[4].out.includes('first_run: true'), 'max_workers alone: ' + res.node[4].out);
});

test('parity: explain idle, roster, waiting-for-report and quota (test-friendly.sh)', { timeout: 120000 }, (t) => {
  void t;
  const st = { fakes: '' };
  const res = parityDoctor('explain', {
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
          'build\tp1\tgrok\timplementer\txai\t1\t/tmp/work\tt1\tgrok-4.7\tfull\timplementer\tbuild\n' +
          'review\tp2\tcodex\treviewer\topenai\t1\t/tmp/work\tt2\tgpt-5\task\treviewer\treview\n'),
        args: ['explain'],
        env: stPath(st),
      },
      // A recorded report whose file is missing: the worker waits on it.
      {
        before: (fix) => {
          writeTsv(fix, 'queued\tp1\tgrok\timplementer\txai\t1\t/tmp/work\tt1\tgrok-4.7\tfull\timplementer\tbuild\n');
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
          writeTsv(fix, 'capped\tp2\tcodex\treviewer\topenai\t1\t/tmp/work\tt2\tgpt-5\task\treviewer\treview\n');
          fs.rmSync(path.join(fix.state, 'ws', 'last-report-capped'), { force: true });
        },
        args: ['explain'],
        env: stPath(st),
      },
    ],
  });
  const r0 = res.node[0];
  assert.equal(r0.rc, 0, r0.err);
  assert.ok(r0.out.includes('Nothing is running yet.'), r0.out);
  assert.ok(r0.out.includes('never commit'), r0.out);
  assert.ok(r0.out.includes('Four panels are recommended'), r0.out);
  assert.ok(!/^\{/.test(r0.out), 'explain is never JSON');
  const r1 = res.node[1];
  assert.equal(r1.rc, 0, r1.err);
  assert.ok(r1.out.includes('build: implementer, grok, model grok-4.7, working'), r1.out);
  assert.ok(r1.out.includes('review: reviewer, codex, model gpt-5, idle'), r1.out);
  assert.ok(r1.out.includes('Panels: 4.'), r1.out);
  assert.ok(r1.out.includes('Recommendation: 4 panels'), r1.out);
  assert.ok(res.node[2].out.includes('build: implementer, grok, model grok-4.7, waiting for report'), res.node[2].out);
  assert.ok(res.node[3].out.includes('review: reviewer, codex, model gpt-5, out of quota'), res.node[3].out);
});

test('parity: explain --json dies 2 (test-friendly.sh)', { timeout: 60000 }, (t) => {
  void t;
  const st = { fakes: '' };
  const res = parityDoctor('explain-args', {
    seed: (fix) => {
      st.fakes = seedFakes(fix, { herdr: HERDR_FAKE });
    },
    steps: [{ args: ['explain', '--json'], env: stPath(st) }],
  });
  const r = res.node[0];
  assert.equal(r.rc, 2, r.err);
  assert.ok(r.err.includes('explain: takes no arguments'), r.err);
});

test('parity: explain with two rosters and no current workspace names the ambiguity (test-friendly.sh)', { timeout: 60000 }, (t) => {
  void t;
  const st = { fakes: '' };
  const res = parityDoctor('explain-ambiguous', {
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
  const r = res.node[0];
  assert.equal(r.rc, 0, r.err);
  assert.ok(r.out.includes('more than one Herdr workspace'), r.out);
  assert.ok(r.out.includes('Run explain from a panel inside the workspace you are asking about.'), r.out);
  assert.ok(!r.out.includes('Nothing is running'), r.out);
});

test('parity: explain with two header-only rosters answers with the idle paragraph (test-friendly.sh)', { timeout: 60000 }, (t) => {
  void t;
  const st = { fakes: '' };
  const res = parityDoctor('explain-empty-workspaces', {
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
  const r = res.node[0];
  assert.equal(r.rc, 0, r.err);
  assert.ok(!r.out.includes('more than one Herdr workspace'), r.out);
  assert.ok(r.out.includes('Nothing is running yet.'), r.out);
});
