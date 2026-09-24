// Parity tests for `setup --plan` (slice 7c): bash × JS for every scenario
// in scripts/test-setup-plan.sh, plus the brief's extras (the combined
// --set/--user-set/--session-set, --target to a file already carrying the
// block, --no-hooks, and the --panes range die). Each scenario runs the
// same steps with both implementations in an identically reset fixture;
// rc, stdout (byte-identical) and normalized stderr must match, and neither
// implementation may write anything: the repo / user-conf / state file
// trees are identical before and after the scenario and no temp dir is
// left behind (the defining property of --plan).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BASH_ENTRY, JS_ENTRY, nodeBin, makeFixture, normalizeErr } from './parity.mjs';

const AGENTS_SEED = '# Agent instructions\n';
const SETTINGS_SEED = '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"echo keep-me"}]}]}}\n';
const OLD_BLOCK = '<!-- herdr-agents:start -->\nold block line\n<!-- herdr-agents:end -->\n';

let FIX;
test.before(() => { FIX = makeFixture(); });
test.after(() => FIX.cleanup());

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

// Run `steps` (each { args, env? }) in order with one implementation, from
// the seeded fixture; returns the per-step results. Asserts the
// nothing-is-written contract for the whole scenario.
function runImpl(impl, seed, steps) {
  FIX.reset();
  for (const f of ['AGENTS.md', 'CLAUDE.md']) fs.rmSync(path.join(FIX.repo, f), { force: true });
  fs.rmSync(path.join(FIX.repo, '.claude'), { recursive: true, force: true });
  for (const [rel, text] of Object.entries(seed)) {
    if (rel === 'args' || rel === 'env') continue;
    // `user/...` seeds land in the isolated XDG config dir, not the repo.
    const p = rel.startsWith('user/') ? path.join(FIX.conf, rel.slice(5)) : path.join(FIX.repo, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (text === undefined) fs.mkdirSync(p, { recursive: true }); // a directory seed (trailing /)
    else fs.writeFileSync(p, text);
  }
  const before = { repo: tree(FIX.repo), conf: tree(FIX.conf), state: tree(FIX.state) };
  const results = [];
  for (const step of steps) {
    const env = { ...FIX.env, ...(step.env ?? {}) };
    const r = impl === 'bash'
      ? spawnSync('bash', [BASH_ENTRY, ...step.args], { cwd: FIX.repo, env, encoding: 'utf8' })
      : spawnSync(nodeBin(), [JS_ENTRY, ...step.args], { cwd: FIX.repo, env, encoding: 'utf8' });
    results.push({ rc: r.status === null ? -1 : r.status, out: r.stdout ?? '', err: r.stderr ?? '' });
  }
  const after = { repo: tree(FIX.repo), conf: tree(FIX.conf), state: tree(FIX.state) };
  const leftovers = fs.readdirSync(FIX.tmp).filter((n) => n.startsWith('herdr-agents-plan.'));
  assert.deepEqual(after, before, `nothing is written (${impl})`);
  assert.deepEqual(leftovers, [], `no temp dir leftovers (${impl})`);
  return results;
}

// One parity scenario: seed the fixture once per implementation and compare
// every step. `expect` (optional) is a sanity check on the bash side.
function parityPlan(name, seed, steps, expect) {
  test(name, { timeout: 60000 }, (t) => {
    const bashRes = runImpl('bash', seed, steps);
    const nodeRes = runImpl('node', seed, steps);
    for (let i = 0; i < steps.length; i++) {
      assert.equal(nodeRes[i].rc, bashRes[i].rc, `step ${i + 1}: rc (bash ${bashRes[i].rc} / node ${nodeRes[i].rc})`);
      assert.equal(nodeRes[i].out, bashRes[i].out, `step ${i + 1}: stdout:\n--- bash ---\n${bashRes[i].out}\n--- node ---\n${nodeRes[i].out}`);
      assert.equal(normalizeErr(nodeRes[i].err), normalizeErr(bashRes[i].err), `step ${i + 1}: stderr:\n--- bash ---\n${bashRes[i].err}\n--- node ---\n${nodeRes[i].err}`);
    }
    if (expect) expect(bashRes);
  });
}

const BASE = { 'AGENTS.md': AGENTS_SEED, '.claude/settings.json': SETTINGS_SEED };

// scripts/test-setup-plan.sh, scenario 1: a fresh project with --panes 4.
parityPlan('parity: plan --panes 4 on a fresh project (nothing written)', BASE, [
  { args: ['setup', '--plan', '--panes', '4'] },
], (res) => {
  assert.equal(res[0].rc, 0, res[0].err);
  assert.ok(res[0].out.startsWith('plan (nothing is written):\n\n'));
  assert.ok(res[0].out.includes(`  panes                (unset) → 4`), res[0].out);
  assert.ok(res[0].out.includes(`  lane.build.roles     (unset) → implementer,designer,tasker`), res[0].out);
  assert.ok(res[0].out.includes(`--- a/${FIX.repo}/AGENTS.md`), res[0].out);
  assert.ok(res[0].out.includes(`+++ b/${FIX.repo}/AGENTS.md`), res[0].out);
});

// scenario 2: an existing panes value shows the before → after line.
parityPlan('parity: plan shows the before value of a key being set', {
  ...BASE, '.agents/herdr-agents.conf': 'panes=3\n',
}, [
  { args: ['setup', '--plan', '--panes', '4'] },
], (res) => {
  assert.equal(res[0].rc, 0, res[0].err);
  assert.ok(res[0].out.includes(`  panes                3 → 4`), res[0].out);
});

// scenario 3: an invalid lane spec dies 2 before anything is shown.
parityPlan('parity: plan with an invalid --lane dies 2', BASE, [
  { args: ['setup', '--plan', '--panes', '4', '--lane', 'build=boguskind'] },
], (res) => {
  assert.equal(res[0].rc, 2, res[0].out);
  assert.ok(res[0].err.includes("setup: unknown kind 'boguskind'"), res[0].err);
  assert.equal(res[0].out, '', 'nothing on stdout');
});

// scenario 4: a valid --lane and --set are planned.
parityPlan('parity: plan a valid --lane and a --set', BASE, [
  { args: ['setup', '--plan', '--panes', '4', '--lane', 'build=grok:grok-4.7:high', '--set', 'max_workers', '5'] },
], (res) => {
  assert.equal(res[0].rc, 0, res[0].err);
  assert.ok(res[0].out.includes(`  lane.build.kind      (unset) → grok`), res[0].out);
  assert.ok(res[0].out.includes(`  lane.build.model     (unset) → grok-4.7`), res[0].out);
  assert.ok(res[0].out.includes(`  max_workers          (unset) → 5`), res[0].out);
});

// scenario 5: --user-set on an absent user file.
parityPlan('parity: plan --user-set with no user file yet', BASE, [
  { args: ['setup', '--plan', '--user-set', 'model.pi.worker', 'my-provider/my-model'] },
], (res) => {
  assert.equal(res[0].rc, 0, res[0].err);
  assert.ok(res[0].out.includes(`${FIX.conf}/herdr-agents/config`), res[0].out);
  assert.ok(res[0].out.includes(`  model.pi.worker      (unset) → my-provider/my-model`), res[0].out);
  assert.ok(!fs.existsSync(path.join(FIX.conf, 'herdr-agents', 'config')), 'the user file is not created');
});

// scenario 6: --user-set over an existing user value.
parityPlan('parity: plan --user-set over an existing user value', {
  ...BASE, 'user/herdr-agents/config': 'model.pi.worker=other/model\n',
}, [
  { args: ['setup', '--plan', '--user-set', 'model.pi.worker', 'new/model'] },
], (res) => {
  assert.equal(res[0].rc, 0, res[0].err);
  assert.ok(res[0].out.includes(`  model.pi.worker      other/model → new/model`), res[0].out);
});

// scenario 7: --session-set on an absent session file.
parityPlan('parity: plan --session-set with no session file yet', BASE, [
  { args: ['setup', '--plan', '--session-set', 'lane.build.kind', 'pi'] },
], (res) => {
  assert.equal(res[0].rc, 0, res[0].err);
  assert.ok(res[0].out.includes(`${FIX.state}/ws/session.conf`), res[0].out);
  assert.ok(res[0].out.includes(`  lane.build.kind      (unset) → pi`), res[0].out);
  assert.ok(!fs.existsSync(path.join(FIX.state, 'ws', 'session.conf')), 'the session file is not created');
});

// scenario 8: a key the real setup would delete is shown as → (removed).
parityPlan('parity: plan a key the real setup would delete', {
  ...BASE, '.agents/herdr-agents.conf': 'role.planner.model=fable\n',
}, [
  { args: ['setup', '--plan', '--panes', '4'] },
], (res) => {
  assert.equal(res[0].rc, 0, res[0].err);
  assert.ok(res[0].out.includes(`  role.planner.model   fable → (removed)`), res[0].out);
});

// scenario 9: an invalid key or value dies 2.
parityPlan('parity: plan dies 2 on an invalid key or value', BASE, [
  { args: ['setup', '--plan', '--set', 'nope', '1'] },
  { args: ['setup', '--plan', '--set', 'max_workers', '-1'] },
  { args: ['setup', '--plan', '--panes', '5'] },
], (res) => {
  assert.equal(res[0].rc, 2, res[0].err);
  assert.ok(res[0].err.includes("setup --plan: unknown key 'nope'"), res[0].err);
  assert.equal(res[1].rc, 2, res[1].err);
  assert.ok(res[1].err.includes("setup --plan: invalid value '-1' for max_workers"), res[1].err);
  assert.equal(res[2].rc, 2, res[2].err);
  assert.ok(res[2].err.includes('setup --plan: --panes must be 3 or 4'), res[2].err);
  for (const r of res) assert.equal(r.out, '', 'nothing on stdout');
});

// scenario 10: a bare setup --plan plans the block and the hooks.
parityPlan('parity: bare plan plans the block and the hooks', BASE, [
  { args: ['setup', '--plan'] },
], (res) => {
  assert.equal(res[0].rc, 0, res[0].err);
  assert.ok(res[0].out.startsWith('plan (nothing is written):\n\n'));
  assert.ok(res[0].out.includes(`--- a/${FIX.repo}/AGENTS.md`), res[0].out);
  assert.ok(res[0].out.includes(`--- a/${path.join(FIX.repo, '.claude', 'settings.json')}`), res[0].out);
  assert.ok(res[0].out.includes('+<!-- herdr-agents:start -->'), res[0].out);
  assert.ok(res[0].out.includes('UserPromptSubmit'), res[0].out);
  assert.ok(res[0].out.includes('SessionStart'), res[0].out);
  assert.ok(res[0].out.includes('echo keep-me'), res[0].out);
});

// scenario 11: the .gitignore entry is planned (not written) when the
// state dir would not be ignored (HERDR_AGENTS_DIR unset: the state dir
// falls back to the in-repo .herdr-agents).
parityPlan('parity: plan the .gitignore entry without writing it', {
  ...BASE, '.gitignore': '*.log\n',
}, [
  { args: ['setup', '--plan', '--session-set', 'lane.build.kind', 'pi'], env: { HERDR_AGENTS_DIR: '' } },
], (res) => {
  assert.equal(res[0].rc, 0, res[0].err);
  assert.ok(res[0].out.includes(`--- a/${FIX.repo}/.gitignore`), res[0].out);
  assert.ok(res[0].out.includes('+.herdr-agents/'), res[0].out);
  assert.equal(fs.readFileSync(path.join(FIX.repo, '.gitignore'), 'utf8'), '*.log\n', 'the .gitignore is untouched');
  assert.ok(!fs.existsSync(path.join(FIX.repo, '.herdr-agents')), 'the state dir is not created');
});

// scenario 12: once the entry and the dir exist, the .gitignore write is a
// no-op: no section at all.
parityPlan('parity: no .gitignore section when the entry is already there', {
  ...BASE, '.gitignore': '*.log\n.herdr-agents/\n', '.herdr-agents/': undefined,
}, [
  { args: ['setup', '--plan', '--session-set', 'lane.build.kind', 'pi'], env: { HERDR_AGENTS_DIR: '' } },
], (res) => {
  assert.equal(res[0].rc, 0, res[0].err);
  assert.ok(!res[0].out.includes('.gitignore'), res[0].out);
});

// scenario 13: a flag given without (or with a flag as) its value dies 2.
parityPlan('parity: plan dies 2 when a flag is missing its value', BASE, [
  { args: ['setup', '--plan', '--set', 'max_workers'] },
  { args: ['setup', '--plan', '--lane'] },
  { args: ['setup', '--plan', '--lane', '--panes', '4'] },
], (res) => {
  for (const r of res) {
    assert.equal(r.rc, 2, r.err);
    assert.equal(r.out, '', 'nothing on stdout');
  }
  assert.ok(res[0].err.includes('setup --plan: --set expects a value'), res[0].err);
  assert.ok(res[1].err.includes('setup --plan: --lane expects a value'), res[1].err);
  assert.ok(res[2].err.includes('setup --plan: --lane expects a value'), res[2].err);
});

// scenario 14: settings.json the real setup would refuse: the plan dies 4,
// the file is untouched and no temp dir is left.
parityPlan('parity: plan dies 4 when the hooks merge would fail', {
  'AGENTS.md': AGENTS_SEED, '.claude/settings.json': 'not-json\n',
}, [
  { args: ['setup', '--plan', '--panes', '4'] },
], (res) => {
  assert.equal(res[0].rc, 4, res[0].out);
  assert.ok(res[0].err.includes('setup --plan: could not merge hooks into'), res[0].err);
  assert.ok(res[0].out.includes(`--- a/${FIX.repo}/AGENTS.md`), 'the block section prints before the die');
  assert.ok(!res[0].out.includes('-not-json'), 'the unmergeable settings.json is never shown');
  assert.equal(fs.readFileSync(path.join(FIX.repo, '.claude', 'settings.json'), 'utf8'), 'not-json\n', 'the file is untouched');
});

// brief extra: --set, --user-set and --session-set together.
parityPlan('parity: plan with --set, --user-set and --session-set together', {
  ...BASE,
  '.agents/herdr-agents.conf': 'max_workers=3\n',
  'AGENTS.md': AGENTS_SEED,
}, [
  { args: ['setup', '--plan', '--set', 'max_workers', '5', '--user-set', 'model.pi.worker', 'p/m', '--session-set', 'lane.build.kind', 'pi'] },
], (res) => {
  assert.equal(res[0].rc, 0, res[0].err);
  assert.ok(res[0].out.includes(`  max_workers          3 → 5`), res[0].out);
  assert.ok(res[0].out.includes(`  model.pi.worker      (unset) → p/m`), res[0].out);
  assert.ok(res[0].out.includes(`  lane.build.kind      (unset) → pi`), res[0].out);
});

// brief extra: --target on a file already carrying the block — the diff is
// the in-place replacement.
parityPlan('parity: plan --target on a file carrying the block', {
  'AGENTS.md': `# head\n${OLD_BLOCK}# tail\n`,
  '.claude/settings.json': SETTINGS_SEED,
}, [
  { args: ['setup', '--plan', '--target', 'AGENTS.md'] },
], (res) => {
  assert.equal(res[0].rc, 0, res[0].err);
  assert.ok(res[0].out.includes(' # head') && res[0].out.includes(' # tail'), 'surrounding lines are context');
  assert.ok(res[0].out.includes('-old block line'), res[0].out);
  assert.ok(res[0].out.includes('+## Multi-agent workflow (herdr-agents)'), res[0].out);
});

// brief extra: --no-hooks leaves the hooks out of the plan.
parityPlan('parity: plan --no-hooks skips the hooks section', BASE, [
  { args: ['setup', '--plan', '--no-hooks'] },
], (res) => {
  assert.equal(res[0].rc, 0, res[0].err);
  assert.ok(res[0].out.includes(`--- a/${FIX.repo}/AGENTS.md`), res[0].out);
  assert.ok(!res[0].out.includes('settings.json'), res[0].out);
});
