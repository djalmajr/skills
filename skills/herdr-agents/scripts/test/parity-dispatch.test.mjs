// Golden (slice 9a-B; slice 6b scenario coverage): `dispatch` and `run` —
// the scenarios of test-quota.sh (dispatch quota; the pane-title
// dispatches), test-status.sh (dispatch on a denied worker — through the
// $TMPDIR routing) and test-multi-role.sh (column 4 role, the contract
// lines of the composed prompt, the strict lint, the reviewer family check
// 5 / --allow-same-family), plus `run` with --no-wait and with the wait
// (the fake herdr writes the report on `agent prompt`, like a worker) — now
// run only the JS and compare against the reference recorded once from the
// bash script in test/golden/parity-dispatch.json (test/golden.mjs:
// HERDR_AGENTS_GOLDEN=record records, unset checks, =update overwrites the
// JS value for review). The recorded value holds, per step: the exit code,
// the normalized stdout, the prefix-normalized stderr and the whole
// on-disk state after the step (herdr log, <state>/ws, the
// $TMPDIR/herdr-agents tree); the intermediate states matter (a refused
// family check leaves no task file, a done wait leaves the report and the
// ✓ title). Wall-clock values (the brief/report timestamps, the friction
// and approvals-log timestamps) are normalized before recording; the
// fixture root becomes <ROOT> in every string.
//
// The bash script runs only as the `reference` (record mode); the JS runs
// only as the `actual` (check/update mode). Each side builds its own
// fixture from the same seed and returns the same value shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeFixture, runImpl, normalizeErr } from './parity.mjs';
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

const SUITE = 'parity-dispatch';

// ---------- the fake herdr (bash, the only herdr both sides see) ----------

// Every call is logged as one "$*" line (herdr.log). `agent get` is answered
// by the per-target mode-<target> file (or the global mode file): denied →
// an unqueryable error, missing → agent_not_found, else the mode as
// agent_status. `agent read` prints screen-<target> (or the global screen
// file). `agent prompt` fails when the prompt-fail marker exists; it writes
// the report (path parsed from the prompt text, like a worker) when the
// prompt-writes marker exists.
function writeFakeHerdr(fix) {
  const bin = path.join(fix.root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const R = fix.root;
  fs.writeFileSync(path.join(bin, 'herdr'), [
    '#!/usr/bin/env bash',
    `printf '%s\\n' "$*" >> "${R}/herdr.log"`,
    'target="${3:-}"',
    `mode=$(cat "${R}/mode" 2>/dev/null || echo working)`,
    `[ -f "${R}/mode-$target" ] && mode=$(cat "${R}/mode-$target")`,
    'case "$1 $2" in',
    '  "agent get")',
    '    case "$mode" in',
    '      denied)',
    `        printf '%s\\n' 'Error: Os { code: 13, kind: PermissionDenied, message: "Permission denied" }' >&2`,
    '        exit 1 ;;',
    '      missing)',
    `        printf '%s\\n' '{"error":{"code":"agent_not_found","message":"agent target '"$target"' not found"},"id":"cli:agent:get"}' >&2`,
    '        exit 1 ;;',
    '      *)',
    `        printf '%s\\n' '{"result":{"agent":{"name":"'"$target"'","agent_status":"'"$mode"'"}}}' ;;`,
    '    esac ;;',
    '  "agent read")',
    `    if [ -f "${R}/screen-$target" ]; then cat "${R}/screen-$target"`,
    `    elif [ -f "${R}/screen" ]; then cat "${R}/screen"`,
    `    else printf 'terminal-fallback'; fi ;;`,
    '  "agent prompt")',
    `    if [ -f "${R}/prompt-fail" ]; then`,
    `      printf 'prompt failed: the fake refused\\n' >&2`,
    '      exit 1;',
    '    fi',
    `    if [ -f "${R}/prompt-writes" ]; then`,
    `      rep=$(printf '%s' "$4" | sed -n 's/.*write your report to \\(.*\\) and reply.*/\\1/p')`,
    `      [ -n "$rep" ] && printf 'done report\\n' > "$rep"`,
    '    fi',
    `    printf '%s\\n' '{"result":{"submitted":true}}' ;;`,
    '  "agent list")',
    `    cat "${R}/live.json" 2>/dev/null || printf '%s\\n' '{"result":{"agents":[]}}' ;;`,
    '  "agent start")',
    `    printf '%s\\n' '{"result":{"started":true}}' ;;`,
    '  "agent rename")',
    `    printf '%s\\n' '{"result":{}}' ;;`,
    '  "pane list")',
    `    printf '%s\\n' '{"result":{"panes":[]}}' ;;`,
    '  "tab create")',
    `    printf '%s\\n' '{"result":{"tab":{"tab_id":"t-herd","label":"herd"},"root_pane":{"pane_id":"p-new"}}}' ;;`,
    '  "tab get")',
    `    printf '%s\\n' '{"result":{"tab":{"tab_id":"t-herd","label":"herd"},"root_pane":{"pane_id":"p-root"}}}' ;;`,
    '  "tab rename")',
    `    printf '%s\\n' '{"result":{}}' ;;`,
    '  "pane report-metadata") ;;',
    '  "agent send-keys") ;;',
    '  "notification show") ;;',
    '  *)',
    `    printf 'unexpected: %s\\n' "$*" >&2`,
    '    exit 1 ;;',
    'esac',
  ].join('\n') + '\n', { mode: 0o755 });
  fs.writeFileSync(path.join(fix.root, 'herdr.log'), '');
}

// A fake `grok` so a fresh spawn finds the executable (no warning).
function writeFakeGrok(fix) {
  fs.writeFileSync(path.join(fix.root, 'bin', 'grok'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
}

// ---------- seeds ----------

const R12 = '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\tmodel\tapprovals\troles\tlane\n';
const R11 = '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\tmodel\tapprovals\troles\n';
const R8 = '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\n';
const WORKER8 = 'worker\tp1\tgrok\timplementer\txai\t1\t/work\tnow\n';

// The test-quota brief (contract sections, no expected result → the default
// warn lint fires, as in the bash scenario).
const BRIEF = `# Goal

Touch nothing.

# Owned files

skills/herdr-agents/scripts/herdr-agents

# Forbidden

Do not commit or push.

# Report

done.
`;
// The test-multi-role brief (same shape).
const BRIEF_MR = `# Goal

Confirm which role the composed prompt uses.

# Owned files

skills/herdr-agents/scripts/herdr-agents

# Forbidden

Do not commit or push.

# Report

done or skipped.
`;
// The test-multi-role full contract brief (passes the strict lint).
const FULL_BRIEF = BRIEF_MR + '\n# Expected result\n\nThe role is reported.\n\n# Acceptance criteria\n\n1. The composed prompt names the role.\n';

function baseWs(fix) {
  const ws = path.join(fix.state, 'ws');
  for (const d of [ws, path.join(ws, 'briefs'), path.join(ws, 'reports'), path.join(ws, 'wait')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  return ws;
}
function seedRoster(fix, header, rows, files = {}) {
  writeFakeHerdr(fix);
  const ws = baseWs(fix);
  const body = rows.map((r) => (r.endsWith('\n') ? r : `${r}\n`)).join('');
  fs.writeFileSync(path.join(ws, 'agents.tsv'), header + body);
  fs.writeFileSync(path.join(fix.root, 'mode'), `${files.mode ?? 'idle'}\n`);
  if (files.screen !== undefined) fs.writeFileSync(path.join(fix.root, 'screen'), files.screen);
  if (files.briefs) for (const [name, body] of Object.entries(files.briefs)) fs.writeFileSync(path.join(fix.repo, name), body);
}

// ---------- the scenario runner ----------

// The dispatch brief timestamps (nowStamp) differ between the two sides by
// construction; normalize them everywhere (stdout, stderr, logs, state
// files, file names).
const normTs = (s) => (s === null ? null : String(s).split(/\d{8}T\d{6}/).join('<TS>'));

function readRel(root, rel) {
  try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; }
}

// The fixture state: herdr.log + every file under <state>/ws and under
// $TMPDIR/herdr-agents (the TMPDIR routing), wall-clock values normalized.
// Two files that normalize to the same key (different dispatch timestamps
// in the same scenario) resolve to the one with the newest original name —
// the ts is zero-padded, so original-name order is chronological — never
// to the (unstable) readdir order.
function collectState(fix) {
  const out = {};
  const orig = {};
  const put = (rel, content) => {
    if (content === null) return;
    const normKey = normTs(rel);
    if (orig[normKey] !== undefined && orig[normKey] > rel) return;
    orig[normKey] = rel;
    const base = path.basename(rel);
    if (base.endsWith('.since')) { out[normKey] = 'EPOCH'; return; }
    if (base.endsWith('.approvals.log')) {
      out[normKey] = content.split('\n').map((l) => l.replace(/^\d{8}T\d{6}/, 'TS')).join('\n');
      return;
    }
    if (base === 'friction.log') {
      out[normKey] = content.split('\n').map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'TS')).join('\n');
      return;
    }
    out[normKey] = normTs(content);
  };
  put('herdr.log', readRel(fix.root, 'herdr.log'));
  const walk = (dir, prefix) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs, `${prefix}/${e.name}`);
      else put(prefix === '' ? e.name : `${prefix}/${e.name}`, readRel(fix.root, path.relative(fix.root, abs)));
    }
  };
  walk(path.join(fix.state, 'ws'), 'state/ws');
  walk(path.join(fix.tmp, 'herdr-agents'), 'tmp/herdr-agents');
  return out;
}

// Run every step against one implementation in a fresh fixture and return
// the golden value: rc, normalized stdout, prefix-normalized stderr per
// step, the state files after every step (the intermediate states matter)
// and the final state file set. The fixture root becomes <ROOT> in every
// string of the value.
function dispatchValue(impl, opts) {
  const fix = makeFixture();
  try {
    fix.reset();
    if (opts.seed) opts.seed(fix);
    const results = [];
    const stepFiles = [];
    for (const step of opts.steps) {
      const stepEnv = {
        ...fix.env,
        HERDR_ENV: '1',
        HERDR_AGENTS_REGRID: 'off',
        PATH: `${path.join(fix.root, 'bin')}${path.delimiter}${process.env.PATH}`,
        ...(step.env ?? {}),
      };
      const r = runImpl(impl, step.args, { env: stepEnv, cwd: fix.repo });
      results.push({ args: step.args, rc: r.rc, out: normTs(r.out), err: normalizeErr(normTs(r.err)) });
      stepFiles.push(collectState(fix));
    }
    return normalizeRoots({ steps: results, stepFiles, files: stepFiles.at(-1) }, { '<ROOT>': fix.root });
  } finally {
    fix.cleanup();
  }
}

// Golden wrapper: record runs the bash reference, check/update run the JS;
// the value is returned for the per-scenario assertions.
function dispatchScenario(name, opts) {
  let refValue;
  let actValue;
  const reference = () => (refValue !== undefined ? refValue : (refValue = dispatchValue('bash', opts))); // record only
  const actual = () => (actValue !== undefined ? actValue : (actValue = dispatchValue('node', opts))); // check/update
  golden(SUITE, name, actual, reference);
  return goldenMode() === 'record' ? reference() : actual();
}

// ---------- scenarios ----------
// The briefs are written into the repo by the seed (relative path args), so
// both sides see the same file from the same cwd.

const BUILD12 = (fix) => `build\tp1\tgrok\timplementer\txai\t1\t${fix.repo}\tnow\tgrok-4.7\tfull\timplementer\tbuild`;

// test-quota.sh:171 — an idle worker whose screen carries a provider line
// is a quota (rc 11, the lane fields in the JSON).
test('parity dispatch: quota (test-quota.sh)', { timeout: 180000, skip: SKIP }, () => {
  const seed = (fix) => seedRoster(fix, R12, [BUILD12(fix)], {
    screen: 'RESOURCE_EXHAUSTED\n',
    briefs: { 'brief.md': BRIEF },
  });
  const r = dispatchScenario('dispatch-quota', {
    seed,
    steps: [{ args: ['dispatch', 'build', 'brief.md', '--timeout', '5000'], env: { HERDR_AGENTS_BRIEF_LINT: 'off' } }],
  });
  assert.equal(r.steps[0].rc, 11);
  const q = JSON.parse(r.steps[0].out.trim());
  assert.equal(q.wait_status, 'quota');
  assert.equal(q.lane, 'build');
  assert.equal(q.kind, 'grok');
  assert.equal(q.model, 'grok-4.7');
  assert.match(q.match, /RESOURCE_EXHAUSTED/);
  assert.ok(r.files['state/ws/friction.log'].includes('quota:'), 'the friction log carries the quota warning');
});

// test-quota.sh:214 + 229 — the pane title: `# Brief — <task>` gives the
// task, a brief whose first H1 is a contract section falls back to the file
// name; last-report and the task file point at the effective paths.
test('parity dispatch: the pane title (test-quota.sh)', { timeout: 180000, skip: SKIP }, () => {
  const seed = (fix) => seedRoster(fix, R12, [BUILD12(fix)], {
    screen: '',
    briefs: {
      'tbrief.md': `# Brief — porte da config\n\n${BRIEF}`,
      'brief.md': BRIEF,
    },
  });
  const r = dispatchScenario('dispatch-titled', {
    seed,
    steps: [
      { args: ['dispatch', 'build', 'tbrief.md', '--no-wait'] },
      { args: ['dispatch', 'build', 'brief.md', '--no-wait'] },
    ],
  });
  for (const [i, title] of [[0, 'implementer: porte da config'], [1, 'implementer: brief']]) {
    const s = r.steps[i];
    assert.equal(s.rc, 0, `step ${i + 1}: ${s.err}`);
    const j = JSON.parse(s.out.trim());
    assert.equal(j.wait_status, 'submitted');
    assert.ok(j.composed_prompt.startsWith('<ROOT>/state/ws/briefs/build-'),
      `composed under the state briefs dir: ${j.composed_prompt}`);
    assert.equal(r.stepFiles[i]['state/ws/task-build'], `${title}\n`);
    assert.ok(r.stepFiles[i]['herdr.log'].includes(`pane report-metadata p1 --source herdr-agents --title ${title}`),
      `the title call: ${r.stepFiles[i]['herdr.log']}`);
    // The composed prompt names the role and the report path.
    const key = Object.keys(r.stepFiles[i]).find((k) => k === 'state/ws/briefs/build-<TS>.md');
    const composed = r.stepFiles[i][key];
    assert.ok(composed.includes('the `implementer` role, agent name `build`'), 'the role line');
    assert.ok(composed.includes(`- Write your report as Markdown to \`${j.report}\``), 'the report contract line');
  }
});

// test-status.sh:199 — a denied worker: the dispatch reports
// `unavailable` (rc 4), never `gone`; the worker cwd outside the repo
// routes the report and the composed prompt through
// $TMPDIR/herdr-agents/<ws>/reports/.
test('parity dispatch: denied, through the $TMPDIR routing (test-status.sh)', { timeout: 180000, skip: SKIP }, () => {
  const seed = (fix) => seedRoster(fix, R8, [WORKER8], { mode: 'denied', briefs: { 'brief.md': BRIEF } });
  const r = dispatchScenario('dispatch-denied', {
    seed,
    steps: [{ args: ['dispatch', 'worker', 'brief.md', '--timeout', '2000'], env: { HERDR_AGENTS_BRIEF_LINT: 'off' } }],
  });
  assert.equal(r.steps[0].rc, 4);
  const j = JSON.parse(r.steps[0].out.trim());
  assert.equal(j.wait_status, 'unavailable');
  assert.ok(!/gone/.test(r.steps[0].err), 'stderr never says gone');
  const tmpRel = 'tmp/herdr-agents/ws/reports/';
  const composedKey = Object.keys(r.files).find((k) => k === `${tmpRel}worker-<TS>.brief.md`);
  assert.ok(composedKey, `the composed prompt is under the tmp reports dir: ${Object.keys(r.files)}`);
  assert.ok(r.files['state/ws/last-report-worker'].endsWith(`${tmpRel}worker-<TS>.md\n`),
    `last-report points at the tmp report: ${r.files['state/ws/last-report-worker']}`);
  assert.ok(!Object.keys(r.files).some((k) => k.startsWith('state/ws/briefs/')), 'nothing landed in the state briefs dir');
});

// test-multi-role.sh — the reviewer family check: a strict conflict dies 5
// (after the default lint warn on the same brief), --allow-same-family and
// family_check=warn continue with a warning, family_check=off is silent;
// the strict lint on a brief without the expected result dies 2.
test('parity dispatch: the reviewer family check and the strict lint (test-multi-role.sh)', { timeout: 180000, skip: SKIP }, () => {
  const seed = (fix) => seedRoster(fix, R11, [
    'rev\tp9\tcodex\treviewer\topenai\t1\t/work\tnow\tgpt-5\ttask\treviewer',
    'ex\tp1\tcodex\tscouter\topenai\t1\t/work\tnow\tgpt-5\tfull\timplementer,scouter',
  ], { briefs: { 'brief.md': BRIEF_MR, 'full.md': FULL_BRIEF } });
  const r = dispatchScenario('dispatch-family', {
    seed,
    steps: [
      { args: ['dispatch', 'rev', 'brief.md', '--no-wait'] },
      { args: ['dispatch', 'rev', 'brief.md', '--allow-same-family', '--no-wait'] },
      { args: ['dispatch', 'rev', 'brief.md', '--no-wait'], env: { HERDR_AGENTS_BRIEF_LINT: 'strict' } },
      { args: ['dispatch', 'rev', 'full.md', '--allow-same-family', '--no-wait'] },
    ],
  });
  assert.equal(r.steps[0].rc, 5, r.steps[0].err);
  assert.match(r.steps[0].err, /reviewer 'rev' \(codex, openai\) shares a model family with edit agents: ex \(codex\)\./);
  assert.ok(r.steps[1].rc === 0 && /shares model family 'openai' with: ex \(codex\)/.test(r.steps[1].err));
  assert.equal(r.steps[2].rc, 2, r.steps[2].err);
  assert.match(r.steps[2].err, /is missing sections: \[Expected result\] \(brief_lint=strict\)/);
  assert.ok(r.steps[3].rc === 0 && /shares model family/.test(r.steps[3].err), 'the full contract brief passes the strict lint, the allow warning remains');
});

// test-multi-role.sh — the role of the composed prompt is column 4 of the
// roster; the composed prompt carries the standing contract lines.
test('parity dispatch: the role comes from column 4 (test-multi-role.sh)', { timeout: 180000, skip: SKIP }, () => {
  const seed = (fix) => seedRoster(fix, R11, ['res\tp3\tgrok\tresearcher\txai\t1\t/work\tnow\tgrok-4.7\task\tresearcher'],
    { briefs: { 'brief.md': BRIEF_MR } });
  const r = dispatchScenario('dispatch-col4', {
    seed,
    steps: [{ args: ['dispatch', 'res', 'brief.md', '--no-wait'], env: { HERDR_AGENTS_BRIEF_LINT: 'off' } }],
  });
  assert.equal(r.steps[0].rc, 0, r.steps[0].err);
  const j = JSON.parse(r.steps[0].out.trim());
  assert.equal(j.role, 'researcher');
  const composed = r.files['tmp/herdr-agents/ws/reports/res-<TS>.brief.md'];
  assert.ok(composed, `the worker cwd outside the repo routes the prompt to $TMPDIR: ${Object.keys(r.files)}`);
  assert.ok(composed.includes('the `researcher` role, agent name `res`'), 'the role line uses column 4');
  assert.ok(!composed.includes('the `scouter` role'));
  assert.ok(composed.includes('- Nobody watches this terminal: do not ask interactive questions or wait for a confirmation.'), 'the no-questions line');
  assert.ok(composed.includes('- Never invent names, endpoints, flags, credentials, URLs or requirements.'), 'the never-invent line');
});

// run — spawn (fresh, layout tab) + dispatch --no-wait. The spawn JSON is
// printed once, then the dispatch JSON; the pane is titled from the brief
// file name.
test('parity run: --no-wait (spawn + dispatch)', { timeout: 180000, skip: SKIP }, () => {
  const seed = (fix) => { seedRoster(fix, R12, [], { briefs: { 'brief.md': FULL_BRIEF } }); writeFakeGrok(fix); };
  const r = dispatchScenario('run-no-wait', {
    seed,
    steps: [{ args: ['run', 'implementer', 'brief.md', '--no-wait'], env: { HERDR_AGENTS_LAYOUT: 'tab' } }],
  });
  assert.equal(r.steps[0].rc, 0, r.steps[0].err);
  const out = r.steps[0].out;
  const at = out.indexOf('{\n  "agent":');
  assert.ok(at > 0, 'the dispatch JSON follows the spawn JSON');
  const spawnJson = JSON.parse(out.slice(0, out.indexOf('\n}\n') + 2));
  assert.equal(spawnJson.name, 'build');
  assert.equal(spawnJson.placement, 'herd');
  const dispatchJson = JSON.parse(out.slice(out.indexOf('{\n  "agent":')));
  assert.equal(dispatchJson.agent, 'build');
  assert.equal(dispatchJson.role, 'implementer');
  assert.equal(dispatchJson.wait_status, 'submitted');
  assert.ok(dispatchJson.composed_prompt.startsWith('<ROOT>/state/ws/briefs/build-'));
  const log = r.files['herdr.log'];
  assert.match(log, /^agent start build --kind grok --pane p-new --timeout \d+/m, 'the spawn happened');
  assert.ok(log.includes('pane report-metadata p-new --source herdr-agents --title implementer: brief'), `the title: ${log}`);
  assert.equal(r.files['state/ws/task-build'], 'implementer: brief\n');
  assert.match(r.files['state/ws/agents.tsv'], /^build\tp-new\tgrok\timplementer\txai\t1\t/m, 'the roster row');
});

// run with the wait — the fake herdr writes the report on `agent prompt`
// (like a worker); dispatch settles done (rc 0) and collect prints the
// report under its marker; the pane title gains the check mark.
test('parity run: with the wait, the report settles and collect prints it', { timeout: 180000, skip: SKIP }, () => {
  const seed = (fix) => {
    seedRoster(fix, R12, [], { briefs: { 'brief.md': FULL_BRIEF } });
    writeFakeGrok(fix);
    fs.writeFileSync(path.join(fix.root, 'prompt-writes'), '1\n');
  };
  const r = dispatchScenario('run-wait', {
    seed,
    steps: [{ args: ['run', 'implementer', 'brief.md', '--timeout', '5000'], env: { HERDR_AGENTS_LAYOUT: 'tab' } }],
  });
  assert.equal(r.steps[0].rc, 0, r.steps[0].err);
  const out = r.steps[0].out;
  const di = out.indexOf('{\n  "agent":');
  const dispatchJson = JSON.parse(out.slice(di, out.indexOf('\n}\n', di) + 2));
  assert.equal(dispatchJson.wait_status, 'done');
  assert.equal(dispatchJson.report_exists, true);
  assert.ok(out.includes('<!-- report: '), 'collect printed the report marker');
  assert.ok(out.includes('done report'), 'collect printed the report content');
  assert.ok(r.files['herdr.log'].includes('pane report-metadata p-new --source herdr-agents --title implementer: brief ✓'),
    `the report marked the title: ${r.files['herdr.log']}`);
});
