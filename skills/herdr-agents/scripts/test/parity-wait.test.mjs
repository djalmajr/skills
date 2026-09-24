// Golden (slice 9a-A; slice 6a scenario coverage): the `wait` scenarios of
// test-quota.sh (quota, a worker working until the timeout, quota on one
// lane against blocked on the other in both argument orders, the ✓ title
// and the `release` title clear) and the `wait`/`collect`/`release`
// scenarios of test-status.sh (denied/gone, the collect fallbacks, the
// release refusal paths), plus a `clean` with a dead worker and old files,
// now run only the JS and compare against the reference recorded once from
// the bash script in test/golden/parity-wait.json (test/golden.mjs:
// HERDR_AGENTS_GOLDEN=record records, unset checks, =update overwrites the
// JS value for record review). Same fixture as before (fake `herdr`
// logging every call). The recorded value holds, per step: stdout, the
// exit code, the prefix-normalized stderr and every file under <state>/ws
// (the intermediate states matter: a refused release leaves the roster
// row, a done wait leaves the task file with ✓), plus the task-* /
// last-report-* files and the fake herdr log. Wall-clock values (the
// .since epoch, the friction and approvals-log timestamps) are normalized
// before recording; the fixture root becomes <ROOT> in every string.
//
// The bash script runs only as the `reference` (record mode); the JS runs
// only as the `actual` (check/update mode).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeFixture, nodeBin, normalizeErr, BASH_ENTRY, JS_ENTRY } from './parity.mjs';
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

const SUITE = 'parity-wait';

// ---------- the fake herdr (bash, the only herdr both implementations see) ----------

// Every call is logged as one "$*" line (herdr.log). `agent get` is
// answered by the per-target mode-<target> file (or the global mode file):
// denied → an unqueryable error, missing → agent_not_found, else the mode
// as agent_status. `agent read` prints screen-<target> (or the global
// screen file), falling back to `terminal-fallback` like test-status.sh.
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
    '  "agent list")',
    `    cat "${R}/live.json" 2>/dev/null || printf '%s\\n' '{"result":{"agents":[]}}' ;;`,
    '  "pane list")',
    `    printf '%s\\n' '{"result":{"panes":[]}}' ;;`,
    '  "pane close")',
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

// ---------- seeds ----------

const R12 = '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\tmodel\tapprovals\troles\tlane\n';
const row12 = (fix, name, pane, kind, role, model, lane) =>
  `${name}\t${pane}\t${kind}\t${role}\txai\t1\t${fix.repo}\tnow\t${model}\tfull\t${role}\t${lane}\n`;
const R8 = '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\n';
const WORKER8 = 'worker\tp1\tgrok\timplementer\txai\t1\t/work\tnow\n';
const REVIEW8 = 'review\tp2\tcodex\treviewer\topenai\t1\t/work\tnow\n';

function baseWs(fix) {
  const ws = path.join(fix.state, 'ws');
  for (const d of [ws, path.join(ws, 'briefs'), path.join(ws, 'reports'), path.join(ws, 'wait')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  return ws;
}
function seedQuotaFix(fix, roster, extra = {}) {
  writeFakeHerdr(fix);
  const ws = baseWs(fix);
  fs.writeFileSync(path.join(ws, 'agents.tsv'), R12 + roster);
  fs.writeFileSync(path.join(fix.root, 'mode'), `${extra.mode ?? 'idle'}\n`);
  if (extra.screen !== undefined) fs.writeFileSync(path.join(fix.root, 'screen'), extra.screen);
  if (extra.perTarget) {
    for (const [agent, mode] of Object.entries(extra.perTarget.modes ?? {})) {
      fs.writeFileSync(path.join(fix.root, `mode-${agent}`), `${mode}\n`);
    }
    for (const [agent, screen] of Object.entries(extra.perTarget.screens ?? {})) {
      fs.writeFileSync(path.join(fix.root, `screen-${agent}`), screen);
    }
  }
  if (extra.waitFiles) {
    for (const [agent, name] of Object.entries(extra.waitFiles)) fs.writeFileSync(path.join(ws, 'wait', `${agent}.${name}`), '');
  }
  if (extra.lastReport) {
    fs.mkdirSync(path.join(ws, 'reports'), { recursive: true });
    const p = path.join(ws, 'reports', `${extra.lastReport.agent}.md`);
    fs.writeFileSync(p, extra.lastReport.body ?? 'done\n');
    fs.writeFileSync(path.join(ws, `last-report-${extra.lastReport.agent}`), p + '\n');
  }
  if (extra.task) {
    for (const [agent, title] of Object.entries(extra.task)) fs.writeFileSync(path.join(ws, `task-${agent}`), `${title}\n`);
  }
}
function seedStatusFix(fix, roster, mode) {
  writeFakeHerdr(fix);
  const ws = baseWs(fix);
  fs.writeFileSync(path.join(ws, 'agents.tsv'), R8 + roster);
  fs.writeFileSync(path.join(fix.root, 'mode'), `${mode}\n`);
}
function setMode(fix, mode) { fs.writeFileSync(path.join(fix.root, 'mode'), `${mode}\n`); }
function reseedWorker(fix) {
  const ws = path.join(fix.state, 'ws');
  fs.writeFileSync(path.join(ws, 'agents.tsv'), R8 + WORKER8);
}

// ---------- the scenario runner ----------

function readRel(root, rel) {
  try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; }
}

// The fixture state: herdr.log + every file under <state>/ws, with the
// wall-clock values normalized (they differ between runs by construction).
function collectState(fix) {
  const out = {};
  const put = (rel, content) => {
    if (content === null) return;
    const base = path.basename(rel);
    if (base.endsWith('.since')) { out[rel] = 'EPOCH'; return; }
    if (base.endsWith('.approvals.log')) {
      out[rel] = content.split('\n').map((l) => l.replace(/^\d{8}T\d{6}/, 'TS')).join('\n');
      return;
    }
    if (base === 'friction.log') {
      out[rel] = content.split('\n').map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'TS')).join('\n');
      return;
    }
    out[rel] = content;
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
  return out;
}

// Run every step against one implementation in a fresh fixture and return
// the golden value: rc, stdout, normalized stderr per step, the state
// files after every step (the intermediate states matter) and the final
// state file set. `entry` is [bin, ...binArgs]: the JS entry for the
// actual, the bash script for the reference. The fixture root becomes
// <ROOT> in every string of the value.
function waitValue(entry, name, opts) {
  const fix = makeFixture();
  try {
    fix.reset();
    if (opts.seed) opts.seed(fix);
    const results = [];
    const stepFiles = [];
    for (const step of opts.steps) {
      if (step.setup) step.setup(fix);
      const stepEnv = {
        ...fix.env,
        HERDR_ENV: '1',
        HERDR_AGENTS_REGRID: 'off',
        PATH: `${path.join(fix.root, 'bin')}${path.delimiter}${process.env.PATH}`,
        ...(step.env ?? {}),
      };
      const r = spawnSync(entry[0], [...entry.slice(1), ...step.args], { env: stepEnv, cwd: fix.repo, encoding: 'utf8', timeout: 60000 });
      results.push({ args: step.args, rc: r.status === null ? -1 : r.status, out: r.stdout ?? '', err: normalizeErr(r.stderr ?? '') });
      const state = collectState(fix);
      // pollInsensitive: how many polls fit before a timeout depends on the
      // clock, so the call log keeps each distinct call once, in first-seen
      // order (which calls happen, not how many times).
      if (opts.pollInsensitive && typeof state['herdr.log'] === 'string') {
        state['herdr.log'] = [...new Set(state['herdr.log'].split('\n').filter((l) => l !== ''))].map((l) => `${l}\n`).join('');
      }
      stepFiles.push(state);
    }
    return normalizeRoots({ steps: results, stepFiles, files: stepFiles.at(-1) }, { '<ROOT>': fix.root });
  } finally {
    fix.cleanup();
  }
}

// Golden wrapper: record runs the bash reference, check/update run the JS;
// the value is returned for the per-scenario assertions.
function waitScenario(name, opts) {
  let refValue;
  let actValue;
  const reference = () => (refValue !== undefined ? refValue : (refValue = waitValue(['bash', BASH_ENTRY], name, opts))); // record only
  const actual = () => (actValue !== undefined ? actValue : (actValue = waitValue([nodeBin(), JS_ENTRY], name, opts))); // check/update
  golden(SUITE, name, actual, reference);
  return goldenMode() === 'record' ? reference() : actual();
}

const lines = (out) => out.trim().split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));

// ---------- scenarios ----------

test('parity wait: quota (test-quota.sh)', { timeout: 120000, skip: SKIP }, () => {
  const r = waitScenario('wait-quota', {
    seed: (fix) => seedQuotaFix(fix, row12(fix, 'build', 'p1', 'grok', 'implementer', 'grok-4.7', 'build'), {
      screen: 'hit your usage limit\ntry again in 2 hours\n',
    }),
    steps: [{ args: ['wait', 'build', '--timeout', '5000'] }],
  });
  assert.equal(r.steps[0].rc, 11);
  const q = lines(r.steps[0].out)[0];
  assert.equal(q.status, 'quota');
  assert.equal(q.lane, 'build');
  assert.equal(q.kind, 'grok');
  assert.equal(q.model, 'grok-4.7');
  assert.match(q.match, /hit your usage limit/);
  assert.match(q.renewal, /try again in 2 hours/);
});

test('parity wait: a worker working until the timeout (test-quota.sh)', { timeout: 120000, skip: SKIP }, () => {
  const r = waitScenario('wait-working-timeout', {
    seed: (fix) => seedQuotaFix(fix, row12(fix, 'build', 'p1', 'grok', 'implementer', 'grok-4.7', 'build'), {
      mode: 'working',
      screen: '429 Too Many Requests\n',
    }),
    steps: [{ args: ['wait', 'build', '--timeout', '2000'] }],
    pollInsensitive: true,
  });
  assert.equal(r.steps[0].rc, 9);
  assert.deepEqual(lines(r.steps[0].out), [{ agent: 'build', status: 'timeout' }]);
  assert.ok(!r.steps[0].out.includes('"status":"quota"'), 'a working agent never becomes quota');
});

test('parity wait: quota on one lane outranks blocked on the other, both orders (test-quota.sh)', { timeout: 120000, skip: SKIP }, () => {
  const roster = (fix) => row12(fix, 'build', 'p1', 'grok', 'implementer', 'grok-4.7', 'build')
    + row12(fix, 'review', 'p2', 'codex', 'reviewer', 'gpt-5', 'review');
  const seed = (fix) => seedQuotaFix(fix, roster(fix), {
    perTarget: {
      modes: { build: 'idle', review: 'blocked' },
      screens: { build: 'You exceeded your current quota\n', review: 'approval dialog\n' },
    },
    waitFiles: { review: 'blocked' },
  });
  const r = waitScenario('wait-quota-vs-blocked', {
    seed,
    steps: [
      { args: ['wait', 'build', 'review', '--timeout', '8000'] },
      { args: ['wait', 'review', 'build', '--timeout', '8000'],
        setup: (fix) => fs.writeFileSync(path.join(fix.state, 'ws', 'wait', 'review.blocked'), '') },
    ],
  });
  for (const i of [0, 1]) {
    assert.equal(r.steps[i].rc, 11, `order ${i}: rc (quota outranks blocked)`);
    const l = lines(r.steps[i].out);
    assert.equal(l.length, 2);
    const build = l.find((x) => x.agent === 'build');
    const review = l.find((x) => x.agent === 'review');
    assert.equal(build.status, 'quota');
    assert.equal(build.lane, 'build');
    assert.equal(review.status, 'blocked', `argument order ${i} must not turn the blocked into anything else`);
  }
});

// The dispatch that titles the pane is slice 6b; here the `task-<agent>`
// file (dispatch's state) is seeded and the slice's half is checked: `wait`
// adds the check mark when the report lands, `release` (without --close)
// clears the title.
test('parity wait: the report marks the pane title ✓ (test-quota.sh)', { timeout: 120000, skip: SKIP }, () => {
  const r = waitScenario('wait-title-mark', {
    seed: (fix) => seedQuotaFix(fix, row12(fix, 'build', 'p1', 'grok', 'implementer', 'grok-4.7', 'build'), {
      screen: '',
      lastReport: { agent: 'build', body: 'done\n' },
      task: { build: 'implementer: porte da config' },
    }),
    steps: [{ args: ['wait', 'build', '--timeout', '5000'] }],
  });
  assert.equal(r.steps[0].rc, 0);
  assert.deepEqual(lines(r.steps[0].out), [
    { agent: 'build', status: 'done', report: '<ROOT>/state/ws/reports/build.md' },
  ]);
  assert.equal(r.files['state/ws/task-build'], 'implementer: porte da config ✓\n', 'the task file gains the check mark once');
  assert.equal(r.files['state/ws/wait/build.size'], '       5\n', 'the wc -c padded size is recorded');
  assert.ok(r.files['herdr.log'].includes('pane report-metadata p1 --source herdr-agents --title implementer: porte da config ✓'),
    `the report marks the title: ${r.files['herdr.log']}`);
});

test('parity release: the pane title is cleared without --close (test-quota.sh)', { timeout: 120000, skip: SKIP }, () => {
  const r = waitScenario('release-title-clear', {
    seed: (fix) => seedQuotaFix(fix, row12(fix, 'build', 'p1', 'grok', 'implementer', 'grok-4.7', 'build'), {
      screen: '',
      lastReport: { agent: 'build', body: 'done\n' },
      task: { build: 'implementer: porte da config ✓' },
    }),
    steps: [{ args: ['release', 'build'] }],
  });
  assert.equal(r.steps[0].rc, 0);
  assert.match(r.steps[0].out, /released build/);
  const log = r.files['herdr.log'];
  assert.ok(log.includes('pane report-metadata p1 --source herdr-agents --clear-title'),
    `release without --close clears the title: ${log}`);
  assert.ok(!/^build\t/m.test(r.files['state/ws/agents.tsv']), 'the roster row is gone');
  assert.equal(r.files['state/ws/last-report-build'], undefined);
  assert.equal(r.files['state/ws/task-build'], undefined);
});

test('parity wait: denied (unavailable) and gone (test-status.sh)', { timeout: 120000, skip: SKIP }, () => {
  const r = waitScenario('wait-denied-gone', {
    seed: (fix) => seedStatusFix(fix, WORKER8, 'denied'),
    steps: [
      { args: ['wait', 'worker', '--timeout', '2000'] },
      { args: ['wait', 'worker', '--timeout', '2000'], setup: (fix) => setMode(fix, 'missing') },
    ],
  });
  assert.equal(r.steps[0].rc, 4);
  const un = lines(r.steps[0].out)[0];
  assert.equal(un.status, 'unavailable');
  assert.match(un.error, /PermissionDenied/);
  assert.ok(!r.steps[0].out.includes('"status":"gone"'), 'never degraded to gone');
  assert.ok(!/gone/.test(r.steps[0].err), 'stderr never says gone');
  assert.equal(r.steps[1].rc, 6);
  assert.deepEqual(lines(r.steps[1].out), [{ agent: 'worker', status: 'gone', report: '' }]);
});

test('parity collect: query failure, the gone fallback, the ready report (test-status.sh)', { timeout: 120000, skip: SKIP }, () => {
  const r = waitScenario('collect', {
    seed: (fix) => seedStatusFix(fix, WORKER8, 'denied'),
    steps: [
      { args: ['collect', 'worker'] },
      { args: ['collect', 'worker'], setup: (fix) => setMode(fix, 'missing') },
      {
        args: ['collect', 'worker'],
        setup: (fix) => {
          setMode(fix, 'denied');
          const ws = path.join(fix.state, 'ws');
          fs.mkdirSync(path.join(ws, 'reports'), { recursive: true });
          fs.writeFileSync(path.join(ws, 'reports', 'worker.md'), 'report body\n');
          fs.writeFileSync(path.join(ws, 'last-report-worker'), path.join(ws, 'reports', 'worker.md') + '\n');
        },
      },
    ],
  });
  assert.equal(r.steps[0].rc, 4);
  assert.ok(!r.steps[0].out.includes('terminal-fallback'), 'no terminal fallback on a query failure');
  assert.ok(!/^agent read/m.test(r.stepFiles[0]['herdr.log']), 'no agent read before the failure');
  assert.match(r.steps[0].err, /PermissionDenied/);
  assert.equal(r.steps[1].rc, 6);
  assert.match(r.steps[1].out, /terminal-fallback/);
  assert.equal(r.steps[2].rc, 0);
  assert.match(r.steps[2].out, /report body/);
  assert.match(r.steps[2].out, /^<!-- report: .*worker\.md -->$/m);
});

test('parity release: the refusal paths and the finished close (test-status.sh)', { timeout: 120000, skip: SKIP }, () => {
  const r = waitScenario('release', {
    seed: (fix) => seedStatusFix(fix, WORKER8, 'denied'),
    steps: [
      { args: ['release', 'worker', '--close'] },
      { args: ['release', 'worker'] },
      { args: ['release', 'worker', '--close', '--force'] },
      { args: ['release', 'worker'], setup: (fix) => { reseedWorker(fix); setMode(fix, 'missing'); } },
      {
        args: ['release', 'worker', '--close'],
        setup: (fix) => {
          reseedWorker(fix);
          setMode(fix, 'working');
          const ws = path.join(fix.state, 'ws');
          fs.mkdirSync(path.join(ws, 'reports'), { recursive: true });
          fs.writeFileSync(path.join(ws, 'reports', 'worker.md'), '');
          fs.writeFileSync(path.join(ws, 'last-report-worker'), path.join(ws, 'reports', 'worker.md') + '\n');
        },
      },
      {
        args: ['release', 'worker', '--close'],
        setup: (fix) => {
          reseedWorker(fix);
          setMode(fix, 'denied');
          const ws = path.join(fix.state, 'ws');
          fs.writeFileSync(path.join(ws, 'reports', 'worker.md'), 'done\n');
          fs.writeFileSync(path.join(ws, 'last-report-worker'), path.join(ws, 'reports', 'worker.md') + '\n');
        },
      },
    ],
  });
  // denied: refused (rc 4), the pane is not closed, the row survives —
  // with and without --close.
  assert.equal(r.steps[0].rc, 4);
  assert.match(r.steps[0].err, /PermissionDenied/);
  assert.ok(/^worker\t/m.test(r.stepFiles[0]['state/ws/agents.tsv']), 'the row survives the refused --close');
  assert.equal(r.steps[1].rc, 4);
  assert.ok(/^worker\t/m.test(r.stepFiles[1]['state/ws/agents.tsv']), 'the row survives the refused no-close');
  // --force: the pane closes, the row goes.
  assert.equal(r.steps[2].rc, 0);
  assert.match(r.steps[2].out, /closed pane p1/);
  assert.match(r.steps[2].out, /released worker/);
  // gone: released.
  assert.equal(r.steps[3].rc, 0);
  assert.match(r.steps[3].out, /released worker/);
  // still working with a pending report: refused (rc 3), no pane close.
  assert.equal(r.steps[4].rc, 3);
  assert.match(r.steps[4].err, /closing now discards its work/);
  // finished: no agent get, the pane closes.
  assert.equal(r.steps[5].rc, 0);
  assert.match(r.steps[5].out, /released worker/);
  assert.ok(!/^worker\t/m.test(r.files['state/ws/agents.tsv']), 'the final release drops the row');
  // The accumulated herdr log pins what happened per step: the agent was
  // queried by the two denied steps, the gone step and the working step
  // (4), never by the --force or the finished step; the pane closed exactly
  // twice (--force and finished); the no-close release cleared the title.
  const log = r.files['herdr.log'];
  assert.equal((log.match(/^agent get worker$/gm) ?? []).length, 4, 'agent get count: \n' + log);
  assert.equal((log.match(/^pane close p1$/gm) ?? []).length, 2, 'pane close count: \n' + log);
  assert.equal((log.match(/^pane report-metadata p1 --source herdr-agents --clear-title$/gm) ?? []).length, 1, 'the no-close release cleared the title');
  assert.equal((log.match(/^pane list --workspace ws$/gm) ?? []).length, 3, 'the relabel ran on the three successful releases');
});

test('parity clean: a dead worker is dropped, old files go, pointed reports stay', { timeout: 120000, skip: SKIP }, () => {
  const seed = (fix) => {
    writeFakeHerdr(fix);
    const ws = baseWs(fix);
    fs.writeFileSync(path.join(ws, 'agents.tsv'), R8 + WORKER8 + 'live\tpl\tgrok\timplementer\txai\t1\t/work\tnow\n');
    fs.writeFileSync(path.join(fix.root, 'live.json'), JSON.stringify({ result: { agents: [{ name: 'live', pane_id: 'pl' }] } }) + '\n');
    fs.mkdirSync(path.join(ws, 'briefs'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'reports'), { recursive: true });
    const old = new Date(Date.now() - 10 * 86400000);
    const put = (rel, body) => {
      const p = path.join(ws, rel);
      fs.writeFileSync(p, body);
      fs.utimesSync(p, old, old);
    };
    put('briefs/old.md', 'old brief\n');
    put('reports/old.md', 'old report\n');
    put('reports/kept.md', 'old but pointed\n');
    fs.writeFileSync(path.join(ws, 'briefs', 'new.md'), 'new brief\n');
    fs.writeFileSync(path.join(ws, 'last-report-live'), path.join(ws, 'reports', 'kept.md') + '\n');
    fs.writeFileSync(path.join(ws, 'wait', 'worker.size'), '3\n');
  };
  const r = waitScenario('clean', {
    seed,
    steps: [{ args: ['clean'] }],
  });
  assert.equal(r.steps[0].rc, 0);
  assert.equal(r.steps[0].out, `dropped gone agent worker\nremoved 2 files older than 7 days under <ROOT>/state/ws\n`);
  assert.ok(!/^worker\t/m.test(r.files['state/ws/agents.tsv']), 'the dead worker is out of the roster');
  assert.equal(r.files['state/ws/last-report-worker'], undefined, 'its last-report pointer is gone');
  assert.equal(r.files['state/ws/wait/worker.size'], undefined, 'its wait files are gone');
  assert.equal(r.files['state/ws/briefs/old.md'], undefined, 'the old brief is removed');
  assert.equal(r.files['state/ws/reports/old.md'], undefined, 'the unpointed old report is removed');
  assert.equal(r.files['state/ws/reports/kept.md'], 'old but pointed\n', 'a pointed old report stays');
  assert.equal(r.files['state/ws/briefs/new.md'], 'new brief\n', 'a recent file stays');
});
