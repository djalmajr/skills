// Golden (slice 9a-C; slice 8b scenario coverage): `setup --probe` and
// `init` now run only the JS (`node scripts/herdr-agents.mjs`) and compare
// against the reference recorded once from the bash script in
// test/golden/parity-setup-probe.json (test/golden.mjs:
// HERDR_AGENTS_GOLDEN=record records, unset checks, =update overwrites the
// JS value for review). Scenarios: the whole of test-probe.sh
// (the aggregate JSON shape and per-kind statuses, the flag pass-through,
// the single kind + explicit model, no-auth with and without a key that
// never leaks, the error code, quota with and without a renewal time, the
// timeout with a hung CLI, the recommended reviewer per build family, the
// usage errors 2 before any CLI runs, and the own-models cap 5 +
// skipped_custom) and the `init` part of test-friendly.sh (doctor on
// stderr, the JSON context, first_run true and false). 16 scenarios.
//
// The recorded value holds, per step: the exit code, the normalized stdout
// and the prefix-normalized stderr, plus the final files and the fixture
// state dir (the init JSON's state_dir is compared against it). The
// accepted doctor-output differences (parity-doctor normalization: the
// bash still has the jq line — decision 5 drops it from the JS — with its
// ok-count shift, and the $0/entry path) are normalized inside the value,
// applied to both sides, so the recorded (bash) value comes out already
// normalized.
//
// The bash script runs only as the `reference` (record mode); the JS runs
// only as the `actual` (check/update mode). Each side builds its own
// fixture from the same seed and returns the same value shape; the fixture
// root becomes <ROOT> in every string of the value. The PATH is fully
// controlled (as in test-probe.sh): sh fakes per CLI (the parity runs the
// bash script, so the fakes stay sh), symlinks to the host jq/git/timeout
// and no herdr for the probe (it must not need one), so no host CLI can
// leak in.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeFixture, runImpl, normalizeErr, nodeBin, BASH_ENTRY, JS_ENTRY, LAUNCHER_ENTRIES } from './parity.mjs';
import { golden, goldenMode, normalizeRoots } from './golden.mjs';
import { findExecutable } from '../lib/platform.mjs';

// Record mode runs the bash reference: it needs bash, jq and timeout (the
// bash probe runs every CLI under timeout). Check mode
// runs the JS against the record and needs the sh fakes, so it is skipped
// solely on Windows.
const SKIP =
  process.platform === 'win32'
    ? 'Windows: the bash reference (record) and the sh fakes (check) need a POSIX host'
    : (goldenMode() === 'record' && (!findExecutable('bash') || !findExecutable('jq') || !findExecutable('timeout'))
      ? 'record mode needs bash, jq and timeout on PATH'
      : false);

const SUITE = 'parity-setup-probe';

function readRel(root, rel) {
  try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; }
}

// The sh fakes of test-probe.sh's make_fake (log args, behave per the mode
// file ready|noauth|noauthkey|errkey|quota|error|quotatime|hang, default
// ready) plus the host jq/git/timeout symlinks. Returns the fakes dir.
// The fully controlled PATH is `<fakes>:/usr/bin:/bin` (the parity
// convention of this repo): the symlinks carry jq/git/timeout, so the
// host dirs of those tools — where the operator's real agent CLIs may
// live — never reach the runs.
function seedFakes(fix, agents = ['pi', 'codex', 'claude', 'grok']) {
  const fakes = path.join(fix.root, 'fakes');
  fs.rmSync(fakes, { recursive: true, force: true });
  seedSymlinks(fakes);
  for (const name of agents) {
    const lines = [
      '#!/usr/bin/env bash',
      `printf '%s\\n' "$*" >> "${fix.root}/args-${name}"`,
      `mode="$(cat "${fix.root}/mode-${name}" 2>/dev/null || echo ready)"`,
      'case "$mode" in',
      "  ready) printf 'ok\\n' ;;",
      `  noauth) printf 'Error: not logged in. Run "${name} login" first.\\n' >&2; exit 1 ;;`,
      "  noauthkey) printf 'Invalid API key provided: sk-proj-SENTINELA123456.\\n' >&2; exit 1 ;;",
      "  errkey) printf 'Error: api key sk-ant-api01SENTINELA rejected.\\n' >&2; exit 4 ;;",
      "  quota) printf 'Error: RESOURCE_EXHAUSTED - You have hit your usage limit. Try again in 5 minutes.\\n' >&2; exit 1 ;;",
      "  error) printf 'boom: connection refused\\n' >&2; exit 3 ;;",
      "  quotatime) printf 'Error: You have hit your usage limit. Try again at 14:30.\\n' >&2; exit 1 ;;",
      '  hang) sleep 30 ;;',
      "  *) printf 'ok\\n' ;;",
      'esac',
    ];
    fs.writeFileSync(path.join(fakes, name), lines.join('\n') + '\n', { mode: 0o755 });
  }
  return fakes;
}

// test-friendly.sh's herdr fake (version/status/skill + pane).
function seedHerdrFake(fakes) {
  const lines = [
    '#!/bin/sh',
    'case "$1" in',
    "  --version) printf 'herdr 9.9.9\\n' ;;",
    '  status) printf \'server 9.9.9\\n\' ;;',
    '  --skill) exit 0 ;;',
    '  agent)',
    '    case "$2" in',
    '      get) printf \'%s\\n\' \'{\"result\":{\"agent\":{\"name\":\"caller\",\"agent_status\":\"idle\"}}}\' ;;',
    '      list) printf \'%s\\n\' \'{\"result\":{\"agents\":[]}}\' ;;',
    '    esac ;;',
    '  pane) printf \'%s\\n\' \'{\"result\":{\"pane\":{\"workspace_id\":\"ws\"}}}\' ;;',
    '  *) exit 0 ;;',
    'esac',
    'exit 0',
  ];
  fs.writeFileSync(path.join(fakes, 'herdr'), lines.join('\n') + '\n', { mode: 0o755 });
}

// A dir with only the host jq/git/timeout symlinks (the doctor step sees
// no herdr and no agent CLI, like test-friendly.sh's BASE_PATH run).
function seedSymlinks(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['jq', 'git', 'timeout']) {
    const real = findExecutable(name);
    if (real) fs.symlinkSync(real, path.join(dir, name));
  }
}

// The accepted doctor-output differences (parity-doctor normalization):
// the bash still has the jq line (decision 5 drops it from the JS) with
// its ok-count shift, and the $0/entry path (both normalize to PROG).
// Applied to both sides — it is the normalization the parity comparison
// used — so the recorded (bash) value is already normalized and the JS
// value normalizes the same way.
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
    .replaceAll(LAUNCHER_ENTRIES[1], 'PROG');
}

// Run every step against one implementation in a fresh fixture and return
// the golden value: per step the exit code, the normalized stdout and the
// prefix-normalized stderr, the final content of opts.files (paths
// relative to the fixture root; missing = null) and the fixture state dir
// (the init JSON's state_dir is compared against it). The fixture root
// becomes <ROOT> in every string of the value.
function probeValue(impl, opts) {
  const fix = makeFixture();
  try {
    fix.reset();
    if (opts.seed) opts.seed(fix);
    const steps = [];
    for (const step of opts.steps) {
      const stepEnv = step.env ? { ...fix.env, ...step.env } : fix.env;
      const r = runImpl(impl, step.args, { env: stepEnv, cwd: fix.repo });
      steps.push({ args: step.args, rc: r.rc, out: normOut(r.out), err: normOut(normalizeErr(r.err)) });
    }
    const files = (opts.files ?? []).map((rel) => ({ rel, content: readRel(fix.root, rel) }));
    return normalizeRoots({ steps, files, stateWs: path.join(fix.state, 'ws') }, { '<ROOT>': fix.root });
  } finally {
    fix.cleanup();
  }
}

// Golden wrapper: record runs the bash reference, check/update run the JS;
// the value is returned for the per-scenario assertions.
function probeScenario(name, opts) {
  let refValue;
  let actValue;
  const reference = () => (refValue !== undefined ? refValue : (refValue = probeValue('bash', opts))); // record only
  const actual = () => (actValue !== undefined ? actValue : (actValue = probeValue('node', opts))); // check/update
  golden(SUITE, name, actual, reference);
  return goldenMode() === 'record' ? reference() : actual();
}

// The fully controlled PATH of the probe/init runs: the fakes dir then
// the system dirs (test-probe.sh's TEST_PATH) — no host agent CLI can
// leak in, and no herdr where the scenario must not see one. The getter
// must stay lazy: the seed (which sets st.fakes) runs after the step env
// objects are defined.
const probePath = (st) => ({ get PATH() { return `${st.fakes}:/usr/bin:/bin`; } });

test('parity: setup --probe aggregate — shape, statuses, reviewer, model spec', { timeout: 120000, skip: SKIP }, () => {
  const st = { fakes: '' };
  const v = probeScenario('probe-aggregate', {
    seed: (fix) => { st.fakes = seedFakes(fix); },
    steps: [{ args: ['setup', '--probe'], env: probePath(st) }],
    files: ['state/ws/agents.tsv'], // the probe opens no state
  });
  const r = v.steps[0];
  assert.equal(r.rc, 0, 'the probe exits 0');
  const doc = JSON.parse(r.out);
  assert.equal(doc.probes.length, 8);
  assert.ok(doc.probes.every((p) => p.source === 'configured'));
  assert.deepEqual(doc.skipped_custom, []);
  const statusOf = (k) => doc.probes.find((p) => p.kind === k).status;
  assert.equal(statusOf('pi'), 'ready');
  assert.equal(statusOf('codex'), 'ready');
  assert.equal(statusOf('claude'), 'ready');
  assert.equal(statusOf('grok'), 'ready');
  assert.equal(statusOf('agy'), 'error');
  assert.equal(doc.probes.find((p) => p.kind === 'agy').cause, 'not installed');
  assert.equal(statusOf('opencode'), 'error');
  assert.equal(doc.probes.find((p) => p.kind === 'codex').model, 'sol|gpt-5'); // the configured spec
  assert.equal(doc.recommended_reviewer.kind, 'codex'); // build family xai → another family
  assert.equal(doc.recommended_reviewer.family, 'openai');
});

test('parity: setup --probe single kind with an explicit model', { timeout: 120000, skip: SKIP }, () => {
  const st = { fakes: '' };
  const v = probeScenario('probe-one', {
    seed: (fix) => { st.fakes = seedFakes(fix); },
    steps: [{ args: ['setup', '--probe', '--kind', 'pi', '--model', 'my-provider/my-model'], env: probePath(st) }],
  });
  const doc = JSON.parse(v.steps[0].out);
  assert.equal(v.steps[0].rc, 0);
  assert.equal(doc.probes.length, 1);
  assert.equal(doc.probes[0].kind, 'pi');
  assert.equal(doc.probes[0].model, 'my-provider/my-model');
  assert.equal(doc.probes[0].status, 'ready');
});

test('parity: setup --probe no-auth — the fixed cause, never the CLI line or its key', { timeout: 120000, skip: SKIP }, () => {
  const st = { fakes: '' };
  for (const [mode, key] of [['noauth', ''], ['noauthkey', 'SENTINELA123456']]) {
    const v = probeScenario(`probe-${mode}`, {
      seed: (fix) => { st.fakes = seedFakes(fix); fs.writeFileSync(path.join(fix.root, 'mode-claude'), `${mode}\n`); },
      steps: [{ args: ['setup', '--probe', '--kind', 'claude'], env: probePath(st) }],
    });
    const r = v.steps[0];
    assert.equal(r.rc, 0, `${mode}: rc ${r.rc}`);
    const doc = JSON.parse(r.out);
    assert.equal(doc.probes[0].status, 'no-auth');
    assert.equal(doc.probes[0].cause, 'not authenticated');
    if (key) assert.ok(!r.out.includes(key), `${mode}: the key must not leak`);
  }
});

test('parity: setup --probe error — exit <code>, the printed key never reaches the JSON', { timeout: 120000, skip: SKIP }, () => {
  const st = { fakes: '' };
  for (const [mode, want] of [['errkey', 'exit 4'], ['error', 'exit 3']]) {
    const v = probeScenario(`probe-${mode}`, {
      seed: (fix) => { st.fakes = seedFakes(fix); fs.writeFileSync(path.join(fix.root, 'mode-codex'), `${mode}\n`); },
      steps: [{ args: ['setup', '--probe', '--kind', 'codex'], env: probePath(st) }],
    });
    const r = v.steps[0];
    assert.equal(r.rc, 0, `${mode}: rc ${r.rc}`);
    const doc = JSON.parse(r.out);
    assert.equal(doc.probes[0].status, 'error');
    assert.equal(doc.probes[0].cause, want);
    assert.ok(!r.out.includes('SENTINELA'), `${mode}: the key must not leak`);
    if (mode === 'error') assert.ok(!r.out.includes('boom'), 'the CLI text must not leak');
  }
});

test('parity: setup --probe quota — with and without a renewal time', { timeout: 120000, skip: SKIP }, () => {
  const st = { fakes: '' };
  for (const [mode, want] of [['quota', 'quota exhausted; renews 5 minutes'], ['quotatime', 'quota exhausted; renews 14:30']]) {
    const v = probeScenario(`probe-${mode}`, {
      seed: (fix) => { st.fakes = seedFakes(fix); fs.writeFileSync(path.join(fix.root, 'mode-grok'), `${mode}\n`); },
      steps: [{ args: ['setup', '--probe', '--kind', 'grok'], env: probePath(st) }],
    });
    const r = v.steps[0];
    assert.equal(r.rc, 0, `${mode}: rc ${r.rc}`);
    const doc = JSON.parse(r.out);
    assert.equal(doc.probes[0].status, 'quota');
    assert.equal(doc.probes[0].cause, want);
  }
});

test('parity: setup --probe a hung CLI is a timeout after the limit', { timeout: 120000, skip: SKIP }, () => {
  const st = { fakes: '' };
  const v = probeScenario('probe-timeout', {
    seed: (fix) => { st.fakes = seedFakes(fix); fs.writeFileSync(path.join(fix.root, 'mode-pi'), 'hang\n'); },
    steps: [{ args: ['setup', '--probe', '--kind', 'pi', '--timeout', '1'], env: probePath(st) }],
  });
  const r = v.steps[0];
  assert.equal(r.rc, 0, `timeout: rc ${r.rc}: ${r.err}`);
  const doc = JSON.parse(r.out);
  assert.equal(doc.probes[0].status, 'error');
  assert.equal(doc.probes[0].cause, 'timeout after 1s');
});

test('parity: the recommended reviewer follows the build family (claude, codex, null)', { timeout: 120000, skip: SKIP }, () => {
  const st = { fakes: '' };
  const cases = [
    { conf: 'lane.build.kind=claude\n', want: 'codex' },
    { conf: 'lane.build.kind=codex\n', want: 'claude' },
  ];
  for (const c of cases) {
    const v = probeScenario(`probe-rec-${c.want}`, {
      seed: (fix) => {
        st.fakes = seedFakes(fix);
        fs.mkdirSync(path.join(fix.repo, '.agents'), { recursive: true });
        fs.writeFileSync(path.join(fix.repo, '.agents', 'herdr-agents.conf'), c.conf);
      },
      steps: [{ args: ['setup', '--probe'], env: probePath(st) }],
    });
    assert.equal(JSON.parse(v.steps[0].out).recommended_reviewer.kind, c.want);
  }
  // Nothing else ready or in another family: pi + grok only, build grok
  // (xai; pi without a recognizable model is unknown) → null.
  const v = probeScenario('probe-rec-null', {
    seed: (fix) => { st.fakes = seedFakes(fix, ['pi', 'grok']); },
    steps: [{ args: ['setup', '--probe'], env: probePath(st) }],
  });
  assert.equal(JSON.parse(v.steps[0].out).recommended_reviewer, null);
});

test('parity: setup --probe usage errors (bad timeout, unknown kind, flag without a value) exit 2', { timeout: 120000, skip: SKIP }, () => {
  const st = { fakes: '' };
  const v = probeScenario('probe-usage', {
    seed: (fix) => { st.fakes = seedFakes(fix); },
    steps: [
      { args: ['setup', '--probe', '--kind', 'pi', '--timeout', '0'], env: probePath(st) },
      { args: ['setup', '--probe', '--kind', 'pi', '--timeout', 'abc'], env: probePath(st) },
      { args: ['setup', '--probe', '--kind', 'pi'], env: { get PATH() { return `${st.fakes}:/usr/bin:/bin`; }, HERDR_AGENTS_PROBE_TIMEOUT: '0' } },
      { args: ['setup', '--probe', '--kind', 'pi'], env: { get PATH() { return `${st.fakes}:/usr/bin:/bin`; }, HERDR_AGENTS_PROBE_TIMEOUT: '30' } },
      { args: ['setup', '--probe', '--kind', 'notepad'], env: probePath(st) },
      { args: ['setup', '--probe', '--kind', '--model', 'pi'], env: probePath(st) },
      { args: ['setup', '--probe', '--model', 'requested/only'], env: probePath(st) },
      { args: ['setup', '--probe', '--kind'], env: probePath(st) },
    ],
    files: ['state/ws/agents.tsv'], // no CLI ran, no state opened
  });
  const rcs = v.steps.map((r) => r.rc);
  assert.deepEqual(rcs, [2, 2, 2, 0, 2, 2, 2, 2], `rcs: ${JSON.stringify(rcs)}`);
  const bad = v.steps[0];
  assert.ok(bad.err.includes('setup --probe: timeout must be a whole number of seconds ≥ 1'), bad.err);
  assert.equal(bad.out, '', 'nothing on stdout on the usage errors');
  assert.ok(v.steps[4].err.includes("unknown kind 'notepad'"), v.steps[4].err);
  assert.ok(v.steps[5].err.includes('setup --probe: --kind expects a value'), v.steps[5].err);
  assert.ok(v.steps[6].err.includes('setup --probe: --model needs --kind'), v.steps[6].err);
  assert.ok(v.steps[7].err.includes('setup --probe: --kind expects a value'), v.steps[7].err);
});

test('parity: setup --probe aggregate covers the own models (5 probed, 2 skipped_custom, no key leak)', { timeout: 120000, skip: SKIP }, () => {
  const st = { fakes: '' };
  const v = probeScenario('probe-custom', {
    seed: (fix) => {
      st.fakes = seedFakes(fix);
      fs.mkdirSync(path.join(fix.home, '.pi', 'agent'), { recursive: true });
      fs.writeFileSync(path.join(fix.home, '.pi', 'agent', 'models.json'), JSON.stringify({
        providers: { own: { apiKey: 'sk-proj-CUSTOMSECRET99', models: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'].map((id) => ({ id })) } },
      }, null, 2));
    },
    steps: [{ args: ['setup', '--probe'], env: probePath(st) }],
  });
  const r = v.steps[0];
  assert.equal(r.rc, 0, `custom: rc ${r.rc}`);
  assert.ok(!r.out.includes('CUSTOMSECRET99'), 'the apiKey must not leak');
  const doc = JSON.parse(r.out);
  const pi = doc.probes.filter((p) => p.kind === 'pi');
  assert.equal(pi.length, 6);
  assert.deepEqual(pi.filter((p) => p.source === 'custom').map((p) => p.model),
    ['own/m1', 'own/m2', 'own/m3', 'own/m4', 'own/m5']);
  assert.deepEqual(doc.skipped_custom, [{ kind: 'pi', id: 'own/m6' }, { kind: 'pi', id: 'own/m7' }]);
});

// ---------- init (the init part of test-friendly.sh) ----------

test('parity: init — doctor on stderr, the JSON context, first_run true', { timeout: 120000, skip: SKIP }, () => {
  const st = { fakes: '', plain: '' };
  const v = probeScenario('init-first', {
    seed: (fix) => {
      st.fakes = seedFakes(fix, []);
      seedHerdrFake(st.fakes);
      st.plain = path.join(fix.root, 'plain');
      seedSymlinks(st.plain);
    },
    steps: [
      { args: ['doctor'], env: { get PATH() { return `${st.plain}:/usr/bin:/bin`; }, HERDR_ENV: '1' } },
      { args: ['init'], env: { get PATH() { return `${st.fakes}:/usr/bin:/bin`; }, HERDR_ENV: '1' } },
    ],
    files: ['state/ws/agents.tsv'],
  });
  const doc = JSON.parse(v.steps[1].out);
  assert.equal(v.steps[0].rc, 0, `doctor: rc ${v.steps[0].rc}`);
  assert.ok(v.steps[0].out.includes('first_run: true'), 'doctor marks the first run');
  assert.equal(v.steps[1].rc, 0, `init: rc ${v.steps[1].rc}: ${v.steps[1].err}`);
  assert.equal(doc.first_run, true);
  assert.equal(doc.orchestrator, ''); // no HERDR_PANE_ID: no caller agent to rename
  assert.equal(doc.pane_id, '');
  assert.equal(doc.workspace_id, 'ws');
  assert.equal(doc.layout, 'split');
  assert.equal(doc.state_dir, v.stateWs);
  // The doctor report is on stderr, not on stdout.
  assert.ok(v.steps[1].err.includes('first_run: true'), 'init doctor stderr');
  assert.ok(!v.steps[1].out.includes('warning(s)'), 'no doctor text on stdout');
});

test('parity: init with a project config that makes the team choice — first_run false', { timeout: 120000, skip: SKIP }, () => {
  const st = { fakes: '', plain: '' };
  const v = probeScenario('init-config', {
    seed: (fix) => {
      st.fakes = seedFakes(fix, []);
      seedHerdrFake(st.fakes);
      st.plain = path.join(fix.root, 'plain');
      seedSymlinks(st.plain);
      fs.mkdirSync(path.join(fix.repo, '.agents'), { recursive: true });
      fs.writeFileSync(path.join(fix.repo, '.agents', 'herdr-agents.conf'), 'lane.build.kind=grok\n');
    },
    steps: [
      { args: ['doctor'], env: { get PATH() { return `${st.plain}:/usr/bin:/bin`; }, HERDR_ENV: '1' } },
      { args: ['init'], env: { get PATH() { return `${st.fakes}:/usr/bin:/bin`; }, HERDR_ENV: '1' } },
    ],
    files: ['state/ws/agents.tsv'],
  });
  assert.ok(v.steps[0].out.includes('first_run: false'), 'doctor with the config');
  assert.equal(JSON.parse(v.steps[1].out).first_run, false);
});

// The `node` used for the node-side runs, referenced so a missing node is a
// loud failure here rather than in every scenario.
void nodeBin();
