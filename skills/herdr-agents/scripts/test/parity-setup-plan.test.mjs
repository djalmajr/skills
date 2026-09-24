// Golden (slice 9a-B; slice 7c scenario coverage): the `setup --plan`
// scenarios — every scenario in scripts/test-setup-plan.sh plus the brief's
// extras (the combined --set/--user-set/--session-set, --target to a file
// already carrying the block, --no-hooks, and the --panes range die) —
// run only the JS and compare against the value stored once in
// test/golden/parity-setup-plan.json (test/golden.mjs: HERDR_AGENTS_GOLDEN
// unset checks the JS value against the stored value, =update overwrites the
// stored value with the JS value for review). The stored value holds, per
// scenario: the exit code, stdout (byte-identical) and the
// prefix-normalized stderr of every step, the whole repo / user-conf / state
// file trees before and after the scenario, and the leftover temp dir
// names. The defining property of --plan is kept as an invariant asserted
// on each run: nothing is written (the before and after trees are
// identical) and no temp dir is left behind.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { JS_ENTRY, makeFixture, nodeBin, normalizeErr } from './parity.mjs';
import { golden, normalizeRoots } from './golden.mjs';

// The fixture contract is POSIX (temporary git repo, POSIX path layout), so
// the scenarios are skipped on Windows.
const SKIP =
  process.platform === 'win32'
    ? 'Windows: the POSIX fixture contract needs a POSIX host'
    : false;

const SUITE = 'parity-setup-plan';

const AGENTS_SEED = '# Agent instructions\n';
const SETTINGS_SEED = '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"echo keep-me"}]}]}}\n';
const OLD_BLOCK = '<!-- herdr-agents:start -->\nold block line\n<!-- herdr-agents:end -->\n';

// The content of every file under `d` (excluding .git), plus dir names with
// a marker so an empty created dir is caught.
function tree(d) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out.push([r, '<dir>']); walk(p, r); }
      else if (e.isFile()) out.push([r, fs.readFileSync(p, 'utf8')]);
    }
  };
  walk(d, '');
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

// Run `steps` (each { args, env? }) in order with the JS entry, from a
// freshly seeded fixture, and return the golden value: the per-step rc /
// stdout / prefix-normalized stderr, the repo / user-conf / state trees
// before and after the scenario, and the leftover temp dir names. Asserts
// the nothing-is-written contract for the whole scenario. The fixture root
// becomes <ROOT> in every string of the value.
function planValue(seed, steps) {
  const fix = makeFixture();
  try {
    fix.reset();
    for (const [rel, text] of Object.entries(seed)) {
      if (rel === 'args' || rel === 'env') continue;
      // `user/...` seeds land in the isolated XDG config dir, not the repo.
      const p = rel.startsWith('user/') ? path.join(fix.conf, rel.slice(5)) : path.join(fix.repo, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      if (text === undefined) fs.mkdirSync(p, { recursive: true }); // a directory seed (trailing /)
      else fs.writeFileSync(p, text);
    }
    const before = { repo: tree(fix.repo), conf: tree(fix.conf), state: tree(fix.state) };
    const results = [];
    for (const step of steps) {
      const env = { ...fix.env, ...(step.env ?? {}) };
      const r = spawnSync(nodeBin(), [JS_ENTRY, ...step.args], { cwd: fix.repo, env, encoding: 'utf8', timeout: 60000 });
      results.push({ args: step.args, rc: r.status === null ? -1 : r.status, out: r.stdout ?? '', err: normalizeErr(r.stderr ?? '') });
    }
    const after = { repo: tree(fix.repo), conf: tree(fix.conf), state: tree(fix.state) };
    const leftovers = fs.readdirSync(fix.tmp).filter((n) => n.startsWith('herdr-agents-plan.'));
    assert.deepEqual(after, before, 'nothing is written');
    assert.deepEqual(leftovers, [], 'no temp dir leftovers');
    return normalizeRoots({ steps: results, before, after, leftovers }, { '<ROOT>': fix.root });
  } finally {
    fix.cleanup();
  }
}

// Golden wrapper: check/update run the JS; the value is returned for the
// per-scenario assertions.
function planScenario(name, seed, steps) {
  let value;
  const actual = () => (value !== undefined ? value : (value = planValue(seed, steps))); // check/update
  golden(SUITE, name, actual);
  return actual();
}

const BASE = { 'AGENTS.md': AGENTS_SEED, '.claude/settings.json': SETTINGS_SEED };

// scripts/test-setup-plan.sh, scenario 1: a fresh project with --panes 4.
test('parity: plan --panes 4 on a fresh project (nothing written)', { timeout: 60000, skip: SKIP }, () => {
  const v = planScenario('parity: plan --panes 4 on a fresh project (nothing written)', BASE, [
    { args: ['setup', '--plan', '--panes', '4'] },
  ]);
  const s = v.steps[0];
  assert.equal(s.rc, 0, s.err);
  assert.ok(s.out.startsWith('plan (nothing is written):\n\n'));
  assert.ok(s.out.includes('  panes                (unset) → 4'), s.out);
  assert.ok(s.out.includes('  lane.build.roles     (unset) → implementer,designer,tasker'), s.out);
  assert.ok(s.out.includes('--- a/<ROOT>/repo/AGENTS.md'), s.out);
  assert.ok(s.out.includes('+++ b/<ROOT>/repo/AGENTS.md'), s.out);
});

// scenario 2: an existing panes value shows the before → after line.
test('parity: plan shows the before value of a key being set', { timeout: 60000, skip: SKIP }, () => {
  const v = planScenario('parity: plan shows the before value of a key being set', {
    ...BASE, '.agents/herdr-agents.conf': 'panes=3\n',
  }, [
    { args: ['setup', '--plan', '--panes', '4'] },
  ]);
  const s = v.steps[0];
  assert.equal(s.rc, 0, s.err);
  assert.ok(s.out.includes('  panes                3 → 4'), s.out);
});

// scenario 3: an invalid lane spec dies 2 before anything is shown.
test('parity: plan with an invalid --lane dies 2', { timeout: 60000, skip: SKIP }, () => {
  const v = planScenario('parity: plan with an invalid --lane dies 2', BASE, [
    { args: ['setup', '--plan', '--panes', '4', '--lane', 'build=boguskind'] },
  ]);
  const s = v.steps[0];
  assert.equal(s.rc, 2, s.out);
  assert.ok(s.err.includes("setup: unknown kind 'boguskind'"), s.err);
  assert.equal(s.out, '', 'nothing on stdout');
});

// scenario 4: a valid --lane and --set are planned.
test('parity: plan a valid --lane and a --set', { timeout: 60000, skip: SKIP }, () => {
  const v = planScenario('parity: plan a valid --lane and a --set', BASE, [
    { args: ['setup', '--plan', '--panes', '4', '--lane', 'build=grok:grok-4.7:high', '--set', 'max_workers', '5'] },
  ]);
  const s = v.steps[0];
  assert.equal(s.rc, 0, s.err);
  assert.ok(s.out.includes('  lane.build.kind      (unset) → grok'), s.out);
  assert.ok(s.out.includes('  lane.build.model     (unset) → grok-4.7'), s.out);
  assert.ok(s.out.includes('  max_workers          (unset) → 5'), s.out);
});

// scenario 5: --user-set on an absent user file.
test('parity: plan --user-set with no user file yet', { timeout: 60000, skip: SKIP }, () => {
  const v = planScenario('parity: plan --user-set with no user file yet', BASE, [
    { args: ['setup', '--plan', '--user-set', 'model.pi.worker', 'my-provider/my-model'] },
  ]);
  const s = v.steps[0];
  assert.equal(s.rc, 0, s.err);
  assert.ok(s.out.includes('<ROOT>/conf/herdr-agents/config'), s.out);
  assert.ok(s.out.includes('  model.pi.worker      (unset) → my-provider/my-model'), s.out);
  assert.ok(!v.after.conf.some(([p]) => p === 'herdr-agents/config'), 'the user file is not created');
});

// scenario 6: --user-set over an existing user value.
test('parity: plan --user-set over an existing user value', { timeout: 60000, skip: SKIP }, () => {
  const v = planScenario('parity: plan --user-set over an existing user value', {
    ...BASE, 'user/herdr-agents/config': 'model.pi.worker=other/model\n',
  }, [
    { args: ['setup', '--plan', '--user-set', 'model.pi.worker', 'new/model'] },
  ]);
  const s = v.steps[0];
  assert.equal(s.rc, 0, s.err);
  assert.ok(s.out.includes('  model.pi.worker      other/model → new/model'), s.out);
});

// scenario 7: --session-set on an absent session file.
test('parity: plan --session-set with no session file yet', { timeout: 60000, skip: SKIP }, () => {
  const v = planScenario('parity: plan --session-set with no session file yet', BASE, [
    { args: ['setup', '--plan', '--session-set', 'lane.build.kind', 'pi'] },
  ]);
  const s = v.steps[0];
  assert.equal(s.rc, 0, s.err);
  assert.ok(s.out.includes('<ROOT>/state/ws/session.conf'), s.out);
  assert.ok(s.out.includes('  lane.build.kind      (unset) → pi'), s.out);
  assert.ok(!v.after.state.some(([p]) => p === 'ws/session.conf'), 'the session file is not created');
});

// scenario 8: a key the real setup would delete is shown as → (removed).
test('parity: plan a key the real setup would delete', { timeout: 60000, skip: SKIP }, () => {
  const v = planScenario('parity: plan a key the real setup would delete', {
    ...BASE, '.agents/herdr-agents.conf': 'role.planner.model=fable\n',
  }, [
    { args: ['setup', '--plan', '--panes', '4'] },
  ]);
  const s = v.steps[0];
  assert.equal(s.rc, 0, s.err);
  assert.ok(s.out.includes('  role.planner.model   fable → (removed)'), s.out);
});

// scenario 9: an invalid key or value dies 2.
test('parity: plan dies 2 on an invalid key or value', { timeout: 60000, skip: SKIP }, () => {
  const v = planScenario('parity: plan dies 2 on an invalid key or value', BASE, [
    { args: ['setup', '--plan', '--set', 'nope', '1'] },
    { args: ['setup', '--plan', '--set', 'max_workers', '-1'] },
    { args: ['setup', '--plan', '--panes', '5'] },
  ]);
  assert.equal(v.steps[0].rc, 2, v.steps[0].err);
  assert.ok(v.steps[0].err.includes("setup --plan: unknown key 'nope'"), v.steps[0].err);
  assert.equal(v.steps[1].rc, 2, v.steps[1].err);
  assert.ok(v.steps[1].err.includes("setup --plan: invalid value '-1' for max_workers"), v.steps[1].err);
  assert.equal(v.steps[2].rc, 2, v.steps[2].err);
  assert.ok(v.steps[2].err.includes('setup --plan: --panes must be 3 or 4'), v.steps[2].err);
  for (const s of v.steps) assert.equal(s.out, '', 'nothing on stdout');
});

// scenario 10: a bare setup --plan plans the block and the hooks.
test('parity: bare plan plans the block and the hooks', { timeout: 60000, skip: SKIP }, () => {
  const v = planScenario('parity: bare plan plans the block and the hooks', BASE, [
    { args: ['setup', '--plan'] },
  ]);
  const s = v.steps[0];
  assert.equal(s.rc, 0, s.err);
  assert.ok(s.out.startsWith('plan (nothing is written):\n\n'));
  assert.ok(s.out.includes('--- a/<ROOT>/repo/AGENTS.md'), s.out);
  assert.ok(s.out.includes('--- a/<ROOT>/repo/.claude/settings.json'), s.out);
  assert.ok(s.out.includes('+<!-- herdr-agents:start -->'), s.out);
  assert.ok(s.out.includes('UserPromptSubmit'), s.out);
  assert.ok(s.out.includes('SessionStart'), s.out);
  assert.ok(s.out.includes('echo keep-me'), s.out);
});

// scenario 11: the .gitignore entry is planned (not written) when the
// state dir would not be ignored (HERDR_AGENTS_DIR unset: the state dir
// falls back to the in-repo .herdr-agents).
test('parity: plan the .gitignore entry without writing it', { timeout: 60000, skip: SKIP }, () => {
  const v = planScenario('parity: plan the .gitignore entry without writing it', {
    ...BASE, '.gitignore': '*.log\n',
  }, [
    { args: ['setup', '--plan', '--session-set', 'lane.build.kind', 'pi'], env: { HERDR_AGENTS_DIR: '' } },
  ]);
  const s = v.steps[0];
  assert.equal(s.rc, 0, s.err);
  assert.ok(s.out.includes('--- a/<ROOT>/repo/.gitignore'), s.out);
  assert.ok(s.out.includes('+.herdr-agents/'), s.out);
  assert.deepEqual(v.after.repo.find(([p]) => p === '.gitignore')?.[1], '*.log\n', 'the .gitignore is untouched');
  assert.ok(!v.after.repo.some(([p]) => p === '.herdr-agents'), 'the state dir is not created');
});

// scenario 12: once the entry and the dir exist, the .gitignore write is a
// no-op: no section at all.
test('parity: no .gitignore section when the entry is already there', { timeout: 60000, skip: SKIP }, () => {
  const v = planScenario('parity: no .gitignore section when the entry is already there', {
    ...BASE, '.gitignore': '*.log\n.herdr-agents/\n', '.herdr-agents/': undefined,
  }, [
    { args: ['setup', '--plan', '--session-set', 'lane.build.kind', 'pi'], env: { HERDR_AGENTS_DIR: '' } },
  ]);
  const s = v.steps[0];
  assert.equal(s.rc, 0, s.err);
  assert.ok(!s.out.includes('.gitignore'), s.out);
});

// scenario 13: a flag given without (or with a flag as) its value dies 2.
test('parity: plan dies 2 when a flag is missing its value', { timeout: 60000, skip: SKIP }, () => {
  const v = planScenario('parity: plan dies 2 when a flag is missing its value', BASE, [
    { args: ['setup', '--plan', '--set', 'max_workers'] },
    { args: ['setup', '--plan', '--lane'] },
    { args: ['setup', '--plan', '--lane', '--panes', '4'] },
  ]);
  for (const s of v.steps) {
    assert.equal(s.rc, 2, s.err);
    assert.equal(s.out, '', 'nothing on stdout');
  }
  assert.ok(v.steps[0].err.includes('setup --plan: --set expects a value'), v.steps[0].err);
  assert.ok(v.steps[1].err.includes('setup --plan: --lane expects a value'), v.steps[1].err);
  assert.ok(v.steps[2].err.includes('setup --plan: --lane expects a value'), v.steps[2].err);
});

// scenario 14: settings.json the real setup would refuse: the plan dies 4,
// the file is untouched and no temp dir is left.
test('parity: plan dies 4 when the hooks merge would fail', { timeout: 60000, skip: SKIP }, () => {
  const v = planScenario('parity: plan dies 4 when the hooks merge would fail', {
    'AGENTS.md': AGENTS_SEED, '.claude/settings.json': 'not-json\n',
  }, [
    { args: ['setup', '--plan', '--panes', '4'] },
  ]);
  const s = v.steps[0];
  assert.equal(s.rc, 4, s.out);
  assert.ok(s.err.includes('setup --plan: could not merge hooks into'), s.err);
  assert.ok(s.out.includes('--- a/<ROOT>/repo/AGENTS.md'), 'the block section prints before the die');
  assert.ok(!s.out.includes('-not-json'), 'the unmergeable settings.json is never shown');
  assert.deepEqual(v.after.repo.find(([p]) => p === '.claude/settings.json')?.[1], 'not-json\n', 'the file is untouched');
});

// brief extra: --set, --user-set and --session-set together.
test('parity: plan with --set, --user-set and --session-set together', { timeout: 60000, skip: SKIP }, () => {
  const v = planScenario('parity: plan with --set, --user-set and --session-set together', {
    ...BASE,
    '.agents/herdr-agents.conf': 'max_workers=3\n',
    'AGENTS.md': AGENTS_SEED,
  }, [
    { args: ['setup', '--plan', '--set', 'max_workers', '5', '--user-set', 'model.pi.worker', 'p/m', '--session-set', 'lane.build.kind', 'pi'] },
  ]);
  const s = v.steps[0];
  assert.equal(s.rc, 0, s.err);
  assert.ok(s.out.includes('  max_workers          3 → 5'), s.out);
  assert.ok(s.out.includes('  model.pi.worker      (unset) → p/m'), s.out);
  assert.ok(s.out.includes('  lane.build.kind      (unset) → pi'), s.out);
});

// brief extra: --target on a file already carrying the block — the diff is
// the in-place replacement.
test('parity: plan --target on a file carrying the block', { timeout: 60000, skip: SKIP }, () => {
  const v = planScenario('parity: plan --target on a file carrying the block', {
    'AGENTS.md': `# head\n${OLD_BLOCK}# tail\n`,
    '.claude/settings.json': SETTINGS_SEED,
  }, [
    { args: ['setup', '--plan', '--target', 'AGENTS.md'] },
  ]);
  const s = v.steps[0];
  assert.equal(s.rc, 0, s.err);
  assert.ok(s.out.includes(' # head') && s.out.includes(' # tail'), 'surrounding lines are context');
  assert.ok(s.out.includes('-old block line'), s.out);
  assert.ok(s.out.includes('+## Multi-agent workflow (herdr-agents)'), s.out);
});

// brief extra: --no-hooks leaves the hooks out of the plan.
test('parity: plan --no-hooks skips the hooks section', { timeout: 60000, skip: SKIP }, () => {
  const v = planScenario('parity: plan --no-hooks skips the hooks section', BASE, [
    { args: ['setup', '--plan', '--no-hooks'] },
  ]);
  const s = v.steps[0];
  assert.equal(s.rc, 0, s.err);
  assert.ok(s.out.includes('--- a/<ROOT>/repo/AGENTS.md'), s.out);
  assert.ok(!s.out.includes('settings.json'), s.out);
});
