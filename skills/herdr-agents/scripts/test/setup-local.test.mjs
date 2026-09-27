// setup --local (R28/D71): the local instruction target for forks whose
// tracked AGENTS.md/CLAUDE.md belong to an upstream. Unit tests for the
// shared helper (lib/setuplocal.mjs) and end-to-end runs through the real
// entry in a disposable git fixture with an upstream-tracked CLAUDE.md and
// .gitignore: only the local block and the hooks are written, the tracked
// files stay byte-for-byte, the block and the state dir ride info/exclude,
// plan is read-only, a tracked CLAUDE.local.md is refused, and doctor
// recognizes the local block. Nothing touches a real project.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig, configKeyOk, configValueOk } from '../lib/config.mjs';
import { SETUP_START } from '../lib/setuptext.mjs';
import {
  LOCAL_INSTRUCTION_FILE, assertSafeLocalRels, classifyStateDir, excludeAfterText, excludeEntry, excludePathFor, gitCommonDirFor, gitDirFor,
  localRels, localTarget, missingExcludeEntries, resolveSetupMode, stateDirShown,
} from '../lib/setuplocal.mjs';
import { cmdSetup, setupTargetExisting } from '../lib/commands/setup.mjs';
import { cmdSetupPlan } from '../lib/commands/setup-plan.mjs';
import { ENTRY_SCRIPT } from '../lib/commands/doctor.mjs';
import { fixtureEnv, nodeBin, JS_ENTRY } from './parity.mjs';

const git = (repo, ...args) => spawnSync('git', args, { cwd: repo, env: process.env, encoding: 'utf8', timeout: 30000 });

// A disposable fork fixture: git repo with an upstream-tracked CLAUDE.md
// and .gitignore (committed, so ls-files sees them), plus isolated
// HOME/config/state/tmp. Returns { dir, repo, env }.
function forkFixture() {
  let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-setup-local-'));
  dir = fs.realpathSync(dir);
  const repo = path.join(dir, 'repo');
  const home = path.join(dir, 'home');
  const conf = path.join(dir, 'conf');
  const state = path.join(dir, 'state');
  const tmp = path.join(dir, 'tmp');
  for (const d of [repo, home, conf, state, tmp]) fs.mkdirSync(d, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'user.email', 'test@example.com');
  const env = fixtureEnv({ HOME: home, XDG_CONFIG_HOME: conf, HERDR_AGENTS_DIR: state, TMPDIR: tmp });
  return { dir, repo, home, conf, state, tmp, env };
}

const UPSTREAM_CLAUDE = '# Upstream instructions\n\nDo it the upstream way.\n';
const UPSTREAM_GITIGNORE = 'node_modules/\n.env\n';

function seedUpstream(repo, gitignore = UPSTREAM_GITIGNORE) {
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), UPSTREAM_CLAUDE);
  fs.writeFileSync(path.join(repo, '.gitignore'), gitignore);
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'upstream');
}

function run(repo, env, args, extraEnv = {}) {
  return spawnSync(nodeBin(), [JS_ENTRY, ...args], {
    cwd: repo, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 60000,
  });
}

function excludeOf(repo) {
  const gd = gitDirFor(repo, process.env);
  return fs.readFileSync(path.join(gd, 'info', 'exclude'), 'utf8');
}

// ---------- resolveSetupMode ----------

test('local mode: --local, --target override, setup_target default and exclusivity', () => {
  const ctx = loadConfig(process.env, process.cwd());
  const mode = (local, target, setupTarget) => resolveSetupMode({
    local, target, ctx, env: { ...process.env, HERDR_AGENTS_SETUP_TARGET: setupTarget ?? '' }, cmd: 'setup',
  });
  assert.equal(mode(false, '', ''), 'canonical', 'default is canonical');
  assert.equal(mode(true, '', ''), 'local', 'explicit --local');
  assert.equal(mode(false, '', 'local'), 'local', 'setup_target=local without --target');
  assert.equal(mode(false, 'OTHER.md', 'local'), 'canonical', 'explicit --target overrides setup_target=local');
  assert.equal(mode(true, '', 'local'), 'local', '--local with setup_target=local');
  assert.equal(mode(false, '', 'bogus'), 'canonical', 'an invalid setup_target reads as canonical');
  assert.throws(
    () => resolveSetupMode({ local: true, target: 'X.md', ctx, env: process.env, cmd: 'setup' }),
    (e) => e.name === 'DieError' && e.code === 2 && e.message === 'setup: --local and --target are exclusive',
  );
  assert.throws(
    () => resolveSetupMode({ local: true, target: 'X.md', ctx, env: process.env, cmd: 'setup --plan' }),
    (e) => e.name === 'DieError' && e.code === 2 && e.message === 'setup --plan: --local and --target are exclusive',
  );
  // Mutation captured: --target losing to setup_target=local, or the
  // exclusivity dying anywhere but 2, breaks the asserts above.
});

// ---------- config validity ----------

test('config: setup_target is a scalar key with canonical|local values only', () => {
  assert.equal(configKeyOk('setup_target'), true);
  assert.equal(configValueOk('setup_target', 'canonical'), true);
  assert.equal(configValueOk('setup_target', 'local'), true);
  for (const bad of ['', 'remote', 'LOCAL', 'canonical local']) {
    assert.equal(configValueOk('setup_target', bad), false, `rejected: '${bad}'`);
  }
  // Mutation captured: the key missing from the scalar list, or the enum
  // accepting anything else, fails the asserts above.
});

// ---------- exclude text + git resolution ----------

test('exclude entries: root-anchored, no trailing slash so a missing dir still matches', () => {
  assert.equal(excludeEntry('CLAUDE.local.md'), '/CLAUDE.local.md');
  assert.equal(excludeEntry('.herdr-agents'), '/.herdr-agents');
  assert.equal(excludeEntry('.herdr-agents/'), '/.herdr-agents', 'a stray slash is trimmed, never kept');
  assert.deepEqual(missingExcludeEntries('# sample\n', ['/CLAUDE.local.md']), ['/CLAUDE.local.md']);
  assert.deepEqual(missingExcludeEntries('/CLAUDE.local.md\n', ['/CLAUDE.local.md']), [], 'an exact line is enough');
  assert.equal(
    excludeAfterText('# sample', ['/CLAUDE.local.md', '/.herdr-agents']),
    '# sample\n/CLAUDE.local.md\n/.herdr-agents\n',
    'missing final newline added once, prior content byte-identical',
  );
  assert.equal(excludeAfterText('/CLAUDE.local.md\n', ['/CLAUDE.local.md']), '/CLAUDE.local.md\n', 'nothing duplicated');
});

test('gitDirFor: real git dir, .git-as-file, and outside git', () => {
  const { dir, repo } = forkFixture();
  try {
    assert.equal(gitDirFor(repo, process.env), path.join(repo, '.git'), 'plain repo');
    // A worktree-style .git file: resolution follows it, never assumes .git/.
    const real = path.join(dir, 'real.git');
    fs.renameSync(path.join(repo, '.git'), real);
    fs.writeFileSync(path.join(repo, '.git'), `gitdir: ${real}\n`);
    assert.equal(gitDirFor(repo, process.env), real, 'the .git file is followed');
    assert.equal(gitDirFor(path.join(dir, 'home'), process.env), '', 'outside git: empty');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('excludePathFor: the file git reads — plain repo and linked worktree', () => {
  const { dir, repo } = forkFixture();
  try {
    seedUpstream(repo);
    assert.equal(excludePathFor(repo, process.env), path.join(repo, '.git', 'info', 'exclude'), 'plain repo');
    const wt = path.join(dir, 'wt');
    git(repo, 'worktree', 'add', wt);
    try {
      assert.equal(
        excludePathFor(wt, process.env),
        path.join(repo, '.git', 'info', 'exclude'),
        'linked worktree: the common exclude, not the worktree git dir',
      );
    } finally { git(repo, 'worktree', 'remove', '--force', wt); }
    // Mutation captured: building <absolute-git-dir>/info/exclude returns
    // the worktree git dir's file here, which git never reads.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('gitCommonDirFor: the plain git dir, and the common dir of a linked worktree', () => {
  const { dir, repo } = forkFixture();
  try {
    seedUpstream(repo);
    assert.equal(gitCommonDirFor(repo, process.env), path.join(repo, '.git'), 'plain repo: the git dir itself');
    const wt = path.join(dir, 'wt');
    git(repo, 'worktree', 'add', wt);
    try {
      assert.notEqual(gitDirFor(wt, process.env), path.join(repo, '.git'), 'the worktree git dir is its own dir');
      assert.equal(
        gitCommonDirFor(wt, process.env),
        path.join(repo, '.git'),
        'linked worktree: the common dir via the commondir file',
      );
    } finally { git(repo, 'worktree', 'remove', '--force', wt); }
    // Mutation captured: anchoring the exclusion chain at the worktree's
    // own git dir (or missing the commondir file) fails the assert above.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('linked worktree: plan shows the common exclude path; setup --local ignores the block and state dir there', { timeout: 120000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    const wt = path.join(dir, 'wt');
    git(repo, 'worktree', 'add', wt);
    try {
      const beforeClaude = fs.readFileSync(path.join(wt, 'CLAUDE.md'), 'utf8');
      const beforeIgnore = fs.readFileSync(path.join(wt, '.gitignore'), 'utf8');
      const commonExclude = path.join(repo, '.git', 'info', 'exclude');
      const beforeExclude = fs.readFileSync(commonExclude, 'utf8');
      // Plan first: read-only, and it names the common exclude file.
      const plan = run(wt, env, ['setup', '--plan', '--local']);
      assert.equal(plan.status, 0, `plan failed: ${plan.stderr}`);
      assert.ok(plan.stdout.includes(commonExclude), `plan shows the common exclude path: ${plan.stdout}`);
      assert.ok(plan.stdout.includes(path.join(wt, 'CLAUDE.local.md')), 'the local block diff is shown');
      assert.equal(fs.readFileSync(commonExclude, 'utf8'), beforeExclude, 'plan writes nothing to the exclude');
      assert.ok(!fs.existsSync(path.join(wt, 'CLAUDE.local.md')), 'plan writes no block');
      // Then the real run with the state dir inside the worktree.
      const r = run(wt, env, ['setup', '--local'], { HERDR_AGENTS_DIR: '' });
      assert.equal(r.status, 0, `setup --local failed: ${r.stderr}`);
      assert.ok(r.stdout.includes(`block written: ${path.join(wt, 'CLAUDE.local.md')}`), r.stdout);
      assert.ok(r.stdout.includes('only Claude Code reads CLAUDE.local.md'), `the corrected note: ${r.stdout}`);
      assert.equal(fs.readFileSync(path.join(wt, 'CLAUDE.md'), 'utf8'), beforeClaude, 'worktree CLAUDE.md byte-identical');
      assert.equal(fs.readFileSync(path.join(wt, '.gitignore'), 'utf8'), beforeIgnore, 'worktree .gitignore byte-identical');
      const excl = fs.readFileSync(commonExclude, 'utf8');
      assert.ok(excl.includes('/CLAUDE.local.md') && excl.includes('/.herdr-agents'), `entries in the common exclude: ${excl}`);
      assert.equal(git(wt, 'check-ignore', '-q', 'CLAUDE.local.md').status, 0, 'block ignored in the worktree');
      assert.equal(git(wt, 'check-ignore', '-q', '.herdr-agents').status, 0, 'state dir ignored in the worktree');
      assert.notEqual(git(wt, 'ls-files', '--error-unmatch', '--', 'CLAUDE.local.md').status, 0, 'block untracked');
      // Mutation captured: the worktree git dir's exclude written instead
      // of the common one leaves both check-ignores at 1 above.
    } finally { git(repo, 'worktree', 'remove', '--force', wt); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- end to end: setup --local on the fork ----------

test('setup --local: only the local block and hooks are written; tracked files stay byte-for-byte', { timeout: 120000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    const beforeClaude = fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8');
    const beforeIgnore = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8');
    const beforeExclude = excludeOf(repo);
    const r = run(repo, env, ['setup', '--local']);
    assert.equal(r.status, 0, `setup --local failed: ${r.stderr}`);
    assert.ok(r.stdout.includes(`block written: ${path.join(repo, 'CLAUDE.local.md')}`), r.stdout);
    const local = fs.readFileSync(path.join(repo, 'CLAUDE.local.md'), 'utf8');
    assert.ok(local.includes(SETUP_START), 'the marked block landed in CLAUDE.local.md');
    assert.ok(!fs.existsSync(path.join(repo, 'AGENTS.md')), 'AGENTS.md never written');
    assert.equal(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8'), beforeClaude, 'upstream CLAUDE.md byte-identical');
    assert.equal(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8'), beforeIgnore, 'tracked .gitignore byte-identical');
    const hooks = JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf8'));
    assert.ok(Array.isArray(hooks.hooks.UserPromptSubmit) && Array.isArray(hooks.hooks.SessionStart), 'hooks merged');
    assert.ok(excludeOf(repo).includes('/CLAUDE.local.md'), 'the local file rides info/exclude');
    assert.ok(excludeOf(repo).startsWith(beforeExclude), 'prior exclude content preserved');
    assert.equal(git(repo, 'check-ignore', '-q', 'CLAUDE.local.md').status, 0, 'git ignores the local file');
    assert.notEqual(git(repo, 'ls-files', '--error-unmatch', '--', 'CLAUDE.local.md').status, 0, 'untracked: the block is unversioned');
    // Second run replaces in place (same bytes shape as canonical idempotence).
    const second = run(repo, env, ['setup', '--local']);
    assert.equal(second.status, 0, second.stderr);
    assert.ok(second.stdout.includes(`block updated: ${path.join(repo, 'CLAUDE.local.md')}`), second.stdout);
    // Mutation captured: a write to AGENTS.md/CLAUDE.md/.gitignore, a
    // missing exclude entry, or a non-idempotent second run fails above.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setup --local with the state dir inside the repo ignores it via exclude, not .gitignore', { timeout: 120000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo, '.herdr-agents/\n');
    // The dir exists, so the .gitignore dir-pattern matches (a trailing-
    // slash pattern never matches a path missing from disk): the state dir
    // is already ignored and gains no duplicate exclude entry.
    fs.mkdirSync(path.join(repo, '.herdr-agents'));
    assert.equal(git(repo, 'check-ignore', '-q', '.herdr-agents').status, 0, 'precondition: gitignore covers it');
    const beforeIgnore = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8');
    const r = run(repo, env, ['setup', '--local'], { HERDR_AGENTS_DIR: '' });
    assert.equal(r.status, 0, `setup --local failed: ${r.stderr}`);
    assert.equal(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8'), beforeIgnore, 'tracked .gitignore untouched');
    const excl = excludeOf(repo);
    assert.ok(excl.includes('/CLAUDE.local.md'), 'local file entry');
    assert.ok(!excl.includes('.herdr-agents'), 'state dir already ignored via .gitignore: no duplicate entry');
    assert.equal(git(repo, 'check-ignore', '-q', '.herdr-agents').status, 0, 'state dir ignored');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setup --local adds the state dir entry when it is not ignored yet', { timeout: 120000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    const r = run(repo, env, ['setup', '--local'], { HERDR_AGENTS_DIR: '' });
    assert.equal(r.status, 0, `setup --local failed: ${r.stderr}`);
    const excl = excludeOf(repo);
    assert.ok(excl.includes('/CLAUDE.local.md'), excl);
    assert.ok(excl.includes('/.herdr-agents'), `the state dir entry: ${excl}`);
    assert.equal(git(repo, 'check-ignore', '-q', '.herdr-agents').status, 0, 'state dir ignored');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setup --local --dry-run prints the would-lines and writes nothing', { timeout: 120000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    const beforeExclude = excludeOf(repo);
    const r = run(repo, env, ['setup', '--local', '--dry-run']);
    assert.equal(r.status, 0, `dry run failed: ${r.stderr}`);
    assert.ok(r.stdout.includes(`# would write to ${path.join(repo, 'CLAUDE.local.md')}`), r.stdout);
    assert.ok(r.stdout.includes(SETUP_START), 'the block is shown');
    assert.ok(r.stdout.includes('# would ensure ') && r.stdout.includes('ignores: /CLAUDE.local.md'), `the exclude would-line: ${r.stdout}`);
    assert.ok(!fs.existsSync(path.join(repo, 'CLAUDE.local.md')), 'nothing written');
    assert.ok(!fs.existsSync(path.join(repo, '.claude')), 'no hooks dir');
    assert.equal(excludeOf(repo), beforeExclude, 'exclude untouched');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setup --local refuses a tracked CLAUDE.local.md before any mutation (rc 4)', { timeout: 120000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    fs.writeFileSync(path.join(repo, 'CLAUDE.local.md'), '# mine\n');
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'track local');
    const beforeExclude = excludeOf(repo);
    const r = run(repo, env, ['setup', '--local']);
    assert.equal(r.status, 4, `must refuse with 4: ${r.stdout} ${r.stderr}`);
    assert.ok(r.stderr.includes('is tracked by git; refusing to overwrite it with local instructions'), r.stderr);
    assert.equal(fs.readFileSync(path.join(repo, 'CLAUDE.local.md'), 'utf8'), '# mine\n', 'file left untouched');
    assert.ok(!fs.existsSync(path.join(repo, '.claude')), 'no hooks written either');
    assert.equal(excludeOf(repo), beforeExclude, 'no exclude write either');
    // Mutation captured: hooks or excludes landing before the refusal, or
    // any code but 4, fails the asserts above.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setup --local --target is a usage error (rc 2) before any write', { timeout: 120000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    const r = run(repo, env, ['setup', '--local', '--target', 'OTHER.md']);
    assert.equal(r.status, 2, `must die 2: ${r.stderr}`);
    assert.ok(r.stderr.includes('setup: --local and --target are exclusive'), r.stderr);
    assert.ok(!fs.existsSync(path.join(repo, 'CLAUDE.local.md')), 'nothing written');
    assert.ok(!fs.existsSync(path.join(repo, 'OTHER.md')), 'the target untouched');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setup_target=local makes plain setup and plan choose local; --target still overrides', { timeout: 120000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    fs.mkdirSync(path.join(repo, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.agents', 'herdr-agents.conf'), 'setup_target=local\n');
    const r = run(repo, env, ['setup']);
    assert.equal(r.status, 0, `plain setup failed: ${r.stderr}`);
    assert.ok(r.stdout.includes(`block written: ${path.join(repo, 'CLAUDE.local.md')}`), r.stdout);
    assert.ok(!fs.existsSync(path.join(repo, 'AGENTS.md')), 'no canonical file from the config default');
    const over = run(repo, env, ['setup', '--target', 'OTHER.md']);
    assert.equal(over.status, 0, over.stderr);
    assert.ok(over.stdout.includes(`block written: ${path.join(repo, 'OTHER.md')}`), over.stdout);
    // setup --plan with the config default also simulates local.
    const plan = run(repo, env, ['setup', '--plan']);
    assert.equal(plan.status, 0, plan.stderr);
    assert.ok(plan.stdout.includes(path.join(repo, 'CLAUDE.local.md')), `plan targets the local file: ${plan.stdout}`);
    const planTarget = run(repo, env, ['setup', '--plan', '--target', 'OTHER.md']);
    assert.equal(planTarget.status, 0, planTarget.stderr);
    assert.ok(planTarget.stdout.includes(path.join(repo, 'OTHER.md')), 'plan --target overrides too');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('canonical setup never switches to a local block it finds (doctor recognition stays advisory)', { timeout: 120000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    const localSeed = `# notes\n\n${SETUP_START}\nold\n`;
    fs.writeFileSync(path.join(repo, 'CLAUDE.local.md'), localSeed);
    const t = setupTargetExisting(repo);
    assert.equal(t, null, 'setupTargetExisting ignores CLAUDE.local.md');
    // The fork's canonical default still targets the existing CLAUDE.md —
    // the local block never switches it.
    const r = run(repo, env, ['setup']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(`block written: ${path.join(repo, 'CLAUDE.md')}`), `canonical default kept: ${r.stdout}`);
    assert.ok(!r.stdout.includes('CLAUDE.local.md'), 'the local file is not the target');
    assert.equal(fs.readFileSync(path.join(repo, 'CLAUDE.local.md'), 'utf8'), localSeed, 'the local file is left alone');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- setup --plan --local ----------

function snapshot(repo) {
  const out = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.set(path.relative(repo, p), fs.readFileSync(p));
    }
  };
  walk(repo);
  return out;
}

test('setup --plan --local simulates the block, hooks and excludes without modifying the repo', { timeout: 120000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    const before = snapshot(repo);
    const beforeExclude = excludeOf(repo);
    const r = run(repo, env, ['setup', '--plan', '--local']);
    assert.equal(r.status, 0, `plan failed: ${r.stderr}`);
    assert.ok(r.stdout.includes(path.join(repo, 'CLAUDE.local.md')), 'the local block diff is shown');
    assert.ok(r.stdout.includes(SETUP_START), r.stdout);
    assert.ok(r.stdout.includes(path.join(repo, '.claude', 'settings.json')), 'the hooks diff is shown');
    const exclPath = path.join(gitDirFor(repo, process.env), 'info', 'exclude');
    assert.ok(r.stdout.includes(exclPath), `the exclude diff is shown: ${r.stdout}`);
    assert.ok(!r.stdout.includes(path.join(repo, '.gitignore')), 'the tracked .gitignore is never shown');
    const after = snapshot(repo);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'no file added or removed');
    for (const [rel, content] of before) assert.ok(after.get(rel).equals(content), `byte-identical: ${rel}`);
    assert.equal(excludeOf(repo), beforeExclude, 'exclude untouched');
    const both = run(repo, env, ['setup', '--plan', '--local', '--target', 'X.md']);
    assert.equal(both.status, 2, 'plan --local --target dies 2');
    assert.ok(both.stderr.includes('setup --plan: --local and --target are exclusive'), both.stderr);
    // Mutation captured: a write anywhere under the repo (or a .gitignore
    // diff in the output) fails the snapshot asserts above.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- doctor ----------

test('doctor: a valid local block is enough; setup_target=local without one points at setup --local', { timeout: 120000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    // Neither block: the canonical warning stands (default behavior kept).
    const missing = run(repo, env, ['doctor']);
    assert.equal(missing.status, 0, missing.stderr);
    assert.ok(missing.stdout.includes('no herdr-agents block in AGENTS.md/CLAUDE.md'), missing.stdout);
    // setup_target=local without a local block: the warning names setup --local.
    fs.mkdirSync(path.join(repo, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.agents', 'herdr-agents.conf'), 'setup_target=local\n');
    const localMissing = run(repo, env, ['doctor']);
    assert.equal(localMissing.status, 0, localMissing.stderr);
    assert.ok(localMissing.stdout.includes(`no herdr-agents block in ${LOCAL_INSTRUCTION_FILE}`), localMissing.stdout);
    assert.ok(localMissing.stdout.includes('setup --local'), localMissing.stdout);
    assert.ok(!localMissing.stdout.includes('no herdr-agents block in AGENTS.md/CLAUDE.md'), 'no canonical-required claim');
    // A valid local block: no missing-block warning at all.
    const setup = run(repo, env, ['setup', '--local']);
    assert.equal(setup.status, 0, setup.stderr);
    const ok = run(repo, env, ['doctor']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(ok.stdout.includes(`instruction block present in ${LOCAL_INSTRUCTION_FILE}`), ok.stdout);
    assert.ok(!ok.stdout.includes('no herdr-agents block'), 'no missing-block warning');
    // Mutation captured: the local ok missing (or the setup_target warning
    // still claiming canonical setup) fails the asserts above.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- local config follow-up keeps --local ----------

test('setup --local: the config follow-up advises setup --local --panes; following it leaves upstream instructions untouched', { timeout: 120000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    const conf = path.join(repo, '.agents', 'herdr-agents.conf');
    const advice = (local) => `herdr-agents: warning: project config ${conf} sets neither multi_role, any lane.<name>.kind, nor any role.<role>.kind. max_workers alone is not that choice. Orchestrator: run 'setup --detect', ask the user in their language how many agents at once (4 recommended, 3, or 2) and which detected assistant should implement, review, and research — do not say lane, kind, or panes to them — then run 'setup ${local}--panes 2|3|4 [--lane name=kind:model:effort]'. If doctor reports a missing or legacy config, finish with 'doctor --fix --panes 2|3|4'.`;
    const warnLine = (err) => err.split('\n').find((l) => l.includes('sets neither multi_role'));
    // Local mode names the local follow-up, exactly.
    const r = run(repo, env, ['setup', '--local']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(warnLine(r.stderr), advice('--local '), 'exact local advice');
    // Following it: the preset lands in project config, the upstream
    // tracked instructions stay byte-identical, no canonical file appears.
    const follow = run(repo, env, ['setup', '--local', '--panes', '3']);
    assert.equal(follow.status, 0, `follow-up failed: ${follow.stderr}`);
    assert.ok(fs.readFileSync(conf, 'utf8').split('\n').includes('panes=3'), 'the preset was applied');
    assert.equal(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8'), UPSTREAM_CLAUDE, 'upstream CLAUDE.md untouched');
    assert.equal(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8'), UPSTREAM_GITIGNORE, 'tracked .gitignore untouched');
    assert.ok(!fs.existsSync(path.join(repo, 'AGENTS.md')), 'no canonical file from the follow-up');
    // Mutation captured: the local advice without --local (the canonical
    // text leaking into the local branch) fails the exact compare above.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setup: the canonical config follow-up is byte-for-byte unchanged', { timeout: 120000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    const conf = path.join(repo, '.agents', 'herdr-agents.conf');
    const r = run(repo, env, ['setup', '--target', 'OTHER.md']);
    assert.equal(r.status, 0, r.stderr);
    const line = r.stderr.split('\n').find((l) => l.includes('sets neither multi_role'));
    assert.ok(line.includes("then run 'setup --panes 2|3|4 [--lane name=kind:model:effort]'"), `canonical advice: ${line}`);
    assert.ok(!line.includes('--local'), 'no local flag leaks into the canonical branch');
    // Mutation captured: --local leaking into the canonical text fails above.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- doctor missing-hooks warning keeps the local target ----------

test('doctor: missing hooks point at setup --local for local setups, canonical otherwise (exact text, no tracked mutation)', { timeout: 120000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    const hooksLine = (out) => out.split('\n').find((l) => /no herdr-agents hooks/.test(l));
    const warnHooks = (cmd) => `${'warn'.padEnd(6)} no herdr-agents hooks in .claude/settings.json: run '${ENTRY_SCRIPT} ${cmd}' (UserPromptSubmit reminder + SessionStart doctor)`;
    const snap = () => snapshot(repo);
    // Case A: valid local block, missing hooks, canonical config.
    fs.writeFileSync(path.join(repo, 'CLAUDE.local.md'), `# notes\n\n${SETUP_START}\nold\n`);
    const beforeA = snap();
    const a = run(repo, env, ['doctor']);
    assert.equal(a.status, 0, a.stderr);
    assert.equal(
      hooksLine(a.stdout),
      warnHooks('setup --local'),
      'exact local warning text',
    );
    assert.deepEqual([...snap().keys()].sort(), [...beforeA.keys()].sort(), 'doctor adds/removes nothing');
    for (const [rel, content] of beforeA) assert.ok(snap().get(rel).equals(content), `byte-identical: ${rel}`);
    // Following that warning is safe: the tracked fork files stay identical.
    const follow = run(repo, env, ['setup', '--local']);
    assert.equal(follow.status, 0, follow.stderr);
    assert.equal(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8'), UPSTREAM_CLAUDE, 'upstream CLAUDE.md untouched');
    assert.equal(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8'), UPSTREAM_GITIGNORE, 'tracked .gitignore untouched');
    assert.ok(!fs.existsSync(path.join(repo, 'AGENTS.md')), 'no canonical file from the follow-up');
    // Case B: setup_target=local with no block at all (drop the hooks the
    // follow-up just wrote, to restore the missing-hooks state).
    fs.rmSync(path.join(repo, 'CLAUDE.local.md'));
    fs.rmSync(path.join(repo, '.claude'), { recursive: true, force: true });
    fs.mkdirSync(path.join(repo, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.agents', 'herdr-agents.conf'), 'setup_target=local\n');
    const b = run(repo, env, ['doctor']);
    assert.equal(b.status, 0, b.stderr);
    assert.ok(hooksLine(b.stdout).includes('setup --local'), `config-local warning: ${hooksLine(b.stdout)}`);
    assert.ok(!hooksLine(b.stdout).includes('setup --local --local'), 'no doubled flag');
    // Case C: canonical default, no blocks — the old text stands.
    fs.writeFileSync(path.join(repo, '.agents', 'herdr-agents.conf'), '# empty\n');
    const c = run(repo, env, ['doctor']);
    assert.equal(c.status, 0, c.stderr);
    assert.equal(
      hooksLine(c.stdout),
      warnHooks('setup'),
      'exact canonical warning text',
    );
    // Mutation captured: the local branch reusing the canonical text (or
    // vice versa), or doctor writing under the repo, fails the asserts.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- localRels ----------

test('localRels: the instruction file plus the state dir only when it lives under the root', () => {
  const ctx = loadConfig(process.env, process.cwd());
  const root = '/repo';
  const outside = localRels(root, ctx, { ...process.env, HERDR_AGENTS_DIR: '/tmp/state' }, root);
  assert.deepEqual(outside, [LOCAL_INSTRUCTION_FILE], 'outside state: file only');
  assert.equal(localTarget(root), path.join(root, LOCAL_INSTRUCTION_FILE));
  // A trailing separator names the same directory (R28 review P2): the rel
  // reaches the exclude validation normalized, plain names unchanged.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ha-localrels-')));
  try {
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q');
    for (const [value, rel] of [['cache/', 'cache'], ['cache//', 'cache'], ['deep/cache/', 'deep/cache']]) {
      assert.deepEqual(
        localRels(repo, ctx, { ...process.env, HERDR_AGENTS_DIR: value }, repo),
        [LOCAL_INSTRUCTION_FILE, rel],
        `normalized: '${value}'`,
      );
    }
    assert.deepEqual(
      localRels(repo, ctx, { ...process.env, HERDR_AGENTS_DIR: 'plain' }, repo),
      [LOCAL_INSTRUCTION_FILE, 'plain'],
      'plain name unchanged',
    );
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- symlinked local target (R28 review P1) ----------

test('setup --local refuses a symlinked CLAUDE.local.md (rc 4) before any mutation', { timeout: 120000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    const beforeClaude = fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8');
    const beforeExclude = excludeOf(repo);
    fs.symlinkSync('CLAUDE.md', path.join(repo, 'CLAUDE.local.md'));
    const r = run(repo, env, ['setup', '--local']);
    assert.equal(r.status, 4, `must refuse with 4: ${r.stdout} ${r.stderr}`);
    assert.ok(r.stderr.includes('is a symlink; refusing to write local instructions through it'), r.stderr);
    assert.equal(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8'), beforeClaude, 'upstream CLAUDE.md byte-identical');
    assert.ok(fs.lstatSync(path.join(repo, 'CLAUDE.local.md')).isSymbolicLink(), 'the link itself is untouched');
    assert.equal(fs.readlinkSync(path.join(repo, 'CLAUDE.local.md')), 'CLAUDE.md', 'the link still points at CLAUDE.md');
    assert.ok(!fs.existsSync(path.join(repo, '.claude')), 'no hooks written either');
    assert.equal(excludeOf(repo), beforeExclude, 'no exclude write either');
    // Mutation captured: any write through the link onto CLAUDE.md, or any
    // code but 4, fails the asserts above.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setup --plan --local refuses a symlinked CLAUDE.local.md (rc 4) with no output or mutation', { timeout: 120000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    const beforeExclude = excludeOf(repo);
    fs.symlinkSync('CLAUDE.md', path.join(repo, 'CLAUDE.local.md'));
    const before = snapshot(repo);
    const r = run(repo, env, ['setup', '--plan', '--local']);
    assert.equal(r.status, 4, `must refuse with 4: ${r.stdout} ${r.stderr}`);
    assert.ok(r.stderr.includes('is a symlink; refusing to write local instructions through it'), r.stderr);
    assert.ok(!r.stdout.includes(SETUP_START), 'no plan diff is shown before the refusal');
    const after = snapshot(repo);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'no file added or removed');
    for (const [rel, content] of before) assert.ok(after.get(rel).equals(content), `byte-identical: ${rel}`);
    assert.ok(fs.lstatSync(path.join(repo, 'CLAUDE.local.md')).isSymbolicLink(), 'the link itself is untouched');
    assert.equal(excludeOf(repo), beforeExclude, 'exclude untouched');
    // Mutation captured: the refusal landing after the plan header (a diff
    // shown) or any mutation fails the asserts above.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- unsafe state-dir exclude patterns (R28 review P2) ----------

test('assertSafeLocalRels: glob metas, injection and traversal die 4; plain, !/#-leading and trailing-slash names pass', () => {
  for (const bad of ['*', '?', '[ab]', 'a[b', 'a]b', 'back\\slash', '../evil', 'a/../b', './x', 'a//b', 'x\n/y', 'x\ry']) {
    assert.throws(
      () => assertSafeLocalRels([LOCAL_INSTRUCTION_FILE, bad], 'setup'),
      (e) => e.name === 'DieError' && e.code === 4,
      `rejected: '${bad}'`,
    );
  }
  assert.doesNotThrow(() => assertSafeLocalRels(
    [LOCAL_INSTRUCTION_FILE, '.herdr-agents', 'foo/bar', 'my state', '!bang', '#hash'], 'setup',
  ), 'ordinary names and !/#-leading names pass');
  // Trailing-separator normalization (R28 review P2): `cache/` names the
  // same directory as `cache` and must pass; interior empties and traversal
  // keep dying even with a trailing slash.
  assert.doesNotThrow(() => assertSafeLocalRels(
    [LOCAL_INSTRUCTION_FILE, 'cache/', 'cache//', 'deep/cache/'], 'setup',
  ), 'trailing separators normalize to the plain name');
  for (const bad of ['../evil/', 'a//b/', './/', 'ca*/']) {
    assert.throws(
      () => assertSafeLocalRels([LOCAL_INSTRUCTION_FILE, bad], 'setup'),
      (e) => e.name === 'DieError' && e.code === 4,
      `still rejected with a trailing slash: '${bad}'`,
    );
  }
  // Mutation captured: an unsafe rel slipping through, or a plain name
  // rejected, fails the asserts above.
});

test('setup --local refuses unsafe HERDR_AGENTS_DIR values (rc 4) before any mutation', { timeout: 180000 }, () => {
  // `../evil` is not in this list any more: it resolves outside the repo and
  // is then a relative-external state dir (no entry, success) per the
  // resolve-before-containment contract — see the path-spelling tests below.
  for (const bad of ['*', '?', '[ab]']) {
    const { dir, repo, env } = forkFixture();
    try {
      seedUpstream(repo);
      const before = snapshot(repo);
      const beforeExclude = excludeOf(repo);
      const r = run(repo, env, ['setup', '--local'], { HERDR_AGENTS_DIR: bad });
      assert.equal(r.status, 4, `must refuse '${bad}' with 4: ${r.stdout} ${r.stderr}`);
      assert.ok(r.stderr.includes('refusing to ignore state path'), `actionable message for '${bad}': ${r.stderr}`);
      assert.ok(!fs.existsSync(path.join(repo, 'CLAUDE.local.md')), `no block for '${bad}'`);
      assert.ok(!fs.existsSync(path.join(repo, '.claude')), `no hooks for '${bad}'`);
      const after = snapshot(repo);
      assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), `no file added or removed for '${bad}'`);
      for (const [rel, content] of before) assert.ok(after.get(rel).equals(content), `byte-identical ${rel} for '${bad}'`);
      assert.equal(excludeOf(repo), beforeExclude, `exclude untouched for '${bad}'`);
      // Mutation captured: a `/*`-style entry landing in the exclude, or any
      // code but 4, fails the asserts above.
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('setup --plan --local refuses an unsafe HERDR_AGENTS_DIR (rc 4) with no output or mutation', { timeout: 120000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    const before = snapshot(repo);
    const beforeExclude = excludeOf(repo);
    const r = run(repo, env, ['setup', '--plan', '--local'], { HERDR_AGENTS_DIR: '*' });
    assert.equal(r.status, 4, `must refuse with 4: ${r.stdout} ${r.stderr}`);
    assert.ok(r.stderr.includes('refusing to ignore state path'), r.stderr);
    assert.ok(!r.stdout.includes(SETUP_START), 'no plan diff is shown before the refusal');
    const after = snapshot(repo);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'no file added or removed');
    for (const [rel, content] of before) assert.ok(after.get(rel).equals(content), `byte-identical: ${rel}`);
    assert.equal(excludeOf(repo), beforeExclude, 'exclude untouched');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setup --local accepts ordinary and !/#-leading state dirs; unrelated untracked files stay visible', { timeout: 180000 }, () => {
  for (const name of ['.my-state', '!bang', '#hash']) {
    const { dir, repo, env } = forkFixture();
    try {
      seedUpstream(repo);
      fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'do not hide me\n');
      const r = run(repo, env, ['setup', '--local'], { HERDR_AGENTS_DIR: name });
      assert.equal(r.status, 0, `setup --local failed for '${name}': ${r.stderr}`);
      const excl = excludeOf(repo);
      assert.ok(excl.includes(`/${name}`), `the state entry for '${name}': ${excl}`);
      assert.equal(git(repo, 'check-ignore', '-q', name).status, 0, `the '${name}' path is ignored`);
      assert.notEqual(git(repo, 'check-ignore', '-q', 'unrelated.txt').status, 0, 'the unrelated file stays visible');
      const st = git(repo, 'status', '--porcelain', '--', 'unrelated.txt').stdout;
      assert.ok(st.includes('unrelated.txt'), `status still shows it: ${st}`);
      // Mutation captured: the entry missing (state unignored) or the
      // unrelated file hidden (broad pattern) fails the asserts above.
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

// ---------- unreadable exclude file (R28 review: ENOENT-only absence) ----------

test('setup --local fails rc 4 on an unreadable exclude file, preserving bytes and writing nothing', { timeout: 120000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    const exclPath = path.join(repo, '.git', 'info', 'exclude');
    const beforeExclude = fs.readFileSync(exclPath, 'utf8');
    fs.chmodSync(exclPath, 0o000);
    let r;
    try {
      r = run(repo, env, ['setup', '--local']);
    } finally { fs.chmodSync(exclPath, 0o600); }
    assert.equal(r.status, 4, `must refuse with 4: ${r.stdout} ${r.stderr}`);
    assert.ok(r.stderr.includes('cannot read the git exclude file'), r.stderr);
    assert.equal(fs.readFileSync(exclPath, 'utf8'), beforeExclude, 'existing exclude bytes preserved');
    assert.ok(!fs.existsSync(path.join(repo, 'CLAUDE.local.md')), 'no block written');
    assert.ok(!fs.existsSync(path.join(repo, '.claude')), 'no hooks written');
    // Mutation captured: treating every read error as absent (overwriting
    // the file) or writing the block/hooks first fails the asserts above.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setup --local and --plan both fail rc 4 when the exclude path is a directory', { timeout: 180000 }, () => {
  for (const args of [['setup', '--local'], ['setup', '--plan', '--local']]) {
    const { dir, repo, env } = forkFixture();
    try {
      seedUpstream(repo);
      const exclPath = path.join(repo, '.git', 'info', 'exclude');
      fs.rmSync(exclPath);
      fs.mkdirSync(exclPath);
      const before = snapshot(repo);
      const r = run(repo, env, args);
      assert.equal(r.status, 4, `must refuse with 4 (${args.join(' ')}): ${r.stdout} ${r.stderr}`);
      assert.ok(r.stderr.includes('cannot read the git exclude file'), r.stderr);
      assert.ok(!r.stdout.includes('info/exclude'), `no successful exclude diff (${args.join(' ')})`);
      assert.ok(fs.statSync(exclPath).isDirectory(), 'the directory is left alone');
      assert.ok(!fs.existsSync(path.join(repo, 'CLAUDE.local.md')), `no block written (${args.join(' ')})`);
      assert.ok(!fs.existsSync(path.join(repo, '.claude')), `no hooks written (${args.join(' ')})`);
      const after = snapshot(repo);
      assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'no file added or removed');
      for (const [rel, content] of before) assert.ok(after.get(rel).equals(content), `byte-identical: ${rel}`);
      // Mutation captured: the plan reporting success (rc 0 with a diff)
      // while the real setup fails, or either side writing, fails above.
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

// ---------- exclude preflight before the panes preset (R28 review P2) ----------

test('setup --local --panes refuses an unreadable exclude (rc 4) before the panes preset lands in the tracked config', { timeout: 180000 }, () => {
  // The project config is tracked upstream, so the refusal must leave it
  // byte-identical: the panes write used to land before the exclude read
  // failed.
  for (const kind of ['directory', 'unreadable']) {
    const { dir, repo, env } = forkFixture();
    try {
      fs.mkdirSync(path.join(repo, '.agents'), { recursive: true });
      fs.writeFileSync(path.join(repo, '.agents', 'herdr-agents.conf'), 'max_workers=2\n');
      seedUpstream(repo); // commits the tracked config
      const conf = path.join(repo, '.agents', 'herdr-agents.conf');
      const confBefore = fs.readFileSync(conf);
      const exclPath = path.join(repo, '.git', 'info', 'exclude');
      if (kind === 'directory') { fs.rmSync(exclPath); fs.mkdirSync(exclPath); }
      else fs.chmodSync(exclPath, 0o000);
      let r;
      try {
        r = run(repo, env, ['setup', '--local', '--panes', '3']);
      } finally {
        if (kind === 'unreadable') fs.chmodSync(exclPath, 0o600);
      }
      assert.equal(r.status, 4, `must refuse with 4 (${kind}): ${r.stdout} ${r.stderr}`);
      assert.ok(r.stderr.includes('cannot read the git exclude file'), r.stderr);
      assert.ok(!r.stdout.includes('panes=3'), `no panes success line (${kind}): ${r.stdout}`);
      assert.ok(fs.readFileSync(conf).equals(confBefore), `tracked config byte-identical (${kind})`);
      assert.ok(!fs.existsSync(path.join(repo, 'CLAUDE.local.md')), `no block (${kind})`);
      assert.ok(!fs.existsSync(path.join(repo, '.claude')), `no hooks (${kind})`);
      // Mutation captured: the panes preset written before the exclude
      // failure, or any block/hooks write, fails the asserts above.
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('setup --plan --local --panes refuses an unreadable exclude (rc 4) before showing a plan', { timeout: 180000 }, () => {
  for (const kind of ['directory', 'unreadable']) {
    const { dir, repo, env } = forkFixture();
    try {
      seedUpstream(repo);
      const before = snapshot(repo);
      const exclPath = path.join(repo, '.git', 'info', 'exclude');
      if (kind === 'directory') { fs.rmSync(exclPath); fs.mkdirSync(exclPath); }
      else fs.chmodSync(exclPath, 0o000);
      let r;
      try {
        r = run(repo, env, ['setup', '--plan', '--local', '--panes', '3']);
      } finally {
        if (kind === 'unreadable') fs.chmodSync(exclPath, 0o600);
      }
      assert.equal(r.status, 4, `must refuse with 4 (${kind}): ${r.stdout} ${r.stderr}`);
      assert.ok(r.stderr.includes('cannot read the git exclude file'), r.stderr);
      assert.equal(r.stdout, '', `no plan output before the refusal (${kind}): ${r.stdout}`);
      const after = snapshot(repo);
      assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'no file added or removed');
      for (const [rel, content] of before) assert.ok(after.get(rel).equals(content), `byte-identical (${kind}): ${rel}`);
      // Mutation captured: the panes diff shown as a successful plan, or
      // any mutation, fails the asserts above.
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('setup --plan --local --panes on a healthy exclude still shows the panes and exclude diffs', { timeout: 120000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    const conf = path.join(repo, '.agents', 'herdr-agents.conf');
    const before = snapshot(repo);
    const beforeExclude = excludeOf(repo);
    const r = run(repo, env, ['setup', '--plan', '--local', '--panes', '3']);
    assert.equal(r.status, 0, `plan failed: ${r.stderr}`);
    assert.ok(r.stdout.includes('plan (nothing is written)'), r.stdout);
    assert.ok(r.stdout.includes(conf), 'the project config is in the plan');
    assert.ok(
      r.stdout.split('\n').some((l) => l.includes('panes') && l.includes('(unset) → 3')),
      `the panes key diff: ${r.stdout}`,
    );
    assert.ok(r.stdout.includes('+/CLAUDE.local.md'), `the exclude entry diff: ${r.stdout}`);
    assert.ok(!fs.existsSync(conf), 'plan wrote no config');
    const after = snapshot(repo);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'no file added or removed');
    for (const [rel, content] of before) assert.ok(after.get(rel).equals(content), `byte-identical: ${rel}`);
    assert.equal(excludeOf(repo), beforeExclude, 'exclude untouched');
    // Mutation captured: the preflight dying on a healthy exclude, or any
    // write, fails the asserts above.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- missing exclude under an unwritable parent (R28 review P2) ----------

test('setup --local --panes refuses a missing exclude under an unwritable parent (rc 4) before the tracked config changes', { timeout: 180000 }, () => {
  // The exclude is absent and its parent directory is read-only: the write
  // itself could never land, so the panes preset must not reach the tracked
  // config (it used to land before the atomicWrite failed with EACCES).
  const { dir, repo, env } = forkFixture();
  try {
    fs.mkdirSync(path.join(repo, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.agents', 'herdr-agents.conf'), 'max_workers=2\n');
    seedUpstream(repo); // commits the tracked config
    const conf = path.join(repo, '.agents', 'herdr-agents.conf');
    const confBefore = fs.readFileSync(conf);
    const info = path.join(repo, '.git', 'info');
    const exclPath = path.join(info, 'exclude');
    fs.rmSync(exclPath);
    fs.chmodSync(info, 0o555); // the parent is unwritable
    let r;
    try {
      r = run(repo, env, ['setup', '--local', '--panes', '3']);
    } finally { fs.chmodSync(info, 0o755); }
    assert.equal(r.status, 4, `must refuse with 4: ${r.stdout} ${r.stderr}`);
    assert.ok(r.stderr.includes('cannot write the git exclude file'), r.stderr);
    assert.ok(!r.stdout.includes('panes=3'), `no panes success line: ${r.stdout}`);
    assert.ok(fs.readFileSync(conf).equals(confBefore), 'tracked config byte-identical');
    assert.ok(!fs.existsSync(exclPath), 'no exclude created');
    assert.ok(!fs.existsSync(path.join(repo, 'CLAUDE.local.md')), 'no block');
    assert.ok(!fs.existsSync(path.join(repo, '.claude')), 'no hooks');
    // Mutation captured: the panes preset written before the writeability
    // refusal, or any block/hooks write, fails the asserts above.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setup --plan --local --panes refuses a missing exclude under an unwritable parent (rc 4) with no plan output', { timeout: 120000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    const before = snapshot(repo);
    const info = path.join(repo, '.git', 'info');
    const exclPath = path.join(info, 'exclude');
    fs.rmSync(exclPath);
    fs.chmodSync(info, 0o555);
    let r;
    try {
      r = run(repo, env, ['setup', '--plan', '--local', '--panes', '3']);
    } finally { fs.chmodSync(info, 0o755); }
    assert.equal(r.status, 4, `must refuse with 4: ${r.stdout} ${r.stderr}`);
    assert.ok(r.stderr.includes('cannot write the git exclude file'), r.stderr);
    assert.equal(r.stdout, '', `no plan output before the refusal: ${r.stdout}`);
    const after = snapshot(repo);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'no file added or removed');
    for (const [rel, content] of before) assert.ok(after.get(rel).equals(content), `byte-identical: ${rel}`);
    assert.ok(!fs.existsSync(exclPath), 'no exclude created');
    // Mutation captured: the panes diff shown as a successful plan, or any
    // mutation, fails the asserts above.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('control: a missing exclude under a writable parent still succeeds for plan and setup', { timeout: 180000 }, () => {
  // The healthy twin of the unwritable-parent fixture: the writeability
  // probe must not misfire on a writable directory.
  const { dir, repo, env } = forkFixture();
  try {
    fs.mkdirSync(path.join(repo, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.agents', 'herdr-agents.conf'), 'max_workers=2\n');
    seedUpstream(repo);
    const info = path.join(repo, '.git', 'info');
    const exclPath = path.join(info, 'exclude');
    fs.rmSync(exclPath);
    const plan = run(repo, env, ['setup', '--plan', '--local', '--panes', '3']);
    assert.equal(plan.status, 0, `plan failed: ${plan.stderr}`);
    assert.ok(plan.stdout.includes('plan (nothing is written)'), plan.stdout);
    assert.ok(plan.stdout.includes('+/CLAUDE.local.md'), `the exclude entry diff: ${plan.stdout}`);
    assert.ok(!fs.existsSync(exclPath), 'plan wrote no exclude');
    const r = run(repo, env, ['setup', '--local', '--panes', '3']);
    assert.equal(r.status, 0, `setup failed: ${r.stderr}`);
    assert.ok(r.stdout.includes('panes=3'), `the preset applied: ${r.stdout}`);
    assert.ok(fs.readFileSync(exclPath, 'utf8').includes('/CLAUDE.local.md'), 'the exclude was created');
    assert.ok(fs.readFileSync(path.join(repo, '.agents', 'herdr-agents.conf'), 'utf8').split('\n').includes('panes=3'), 'tracked config updated');
    // Mutation captured: the probe dying on a writable parent (rc 4 here)
    // fails the status asserts above.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- trailing-slash state dir (R28 review P2) ----------

test('setup --local accepts a trailing-slash state dir; exact entry, unrelated files stay visible', { timeout: 180000 }, () => {
  for (const value of ['cache/', 'cache//', 'deep/cache/']) {
    const { dir, repo, env } = forkFixture();
    try {
      seedUpstream(repo);
      fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'do not hide me\n');
      const r = run(repo, env, ['setup', '--local'], { HERDR_AGENTS_DIR: value });
      assert.equal(r.status, 0, `setup --local failed for '${value}': ${r.stderr}`);
      assert.ok(r.stdout.includes(`block written: ${path.join(repo, 'CLAUDE.local.md')}`), `the block is written for '${value}'`);
      const rel = value.replace(/\/+$/, '');
      const exclLines = excludeOf(repo).split('\n');
      assert.ok(exclLines.includes(`/${rel}`), `exact entry '/${rel}' for '${value}': ${exclLines.join('|')}`);
      assert.ok(!exclLines.includes(`/${rel}/`), `no trailing-slash entry for '${value}'`);
      assert.equal(git(repo, 'check-ignore', '-q', rel).status, 0, `the '${rel}' path is ignored`);
      assert.notEqual(git(repo, 'check-ignore', '-q', 'unrelated.txt').status, 0, 'the unrelated file is not hidden');
      const st = git(repo, 'status', '--porcelain', '--', 'unrelated.txt').stdout;
      assert.ok(st.includes('unrelated.txt'), `status still shows it: ${st}`);
      // Mutation captured: the rc-4 rejection of the valid spelling, the
      // entry missing (state unignored), a trailing-slash entry, or a
      // broad pattern hiding the unrelated file, fails the asserts above.
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('setup --plan --local accepts a trailing-slash state dir; the diff shows the exact entry, nothing is written', { timeout: 120000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'do not hide me\n');
    const before = snapshot(repo);
    const beforeExclude = excludeOf(repo);
    const r = run(repo, env, ['setup', '--plan', '--local'], { HERDR_AGENTS_DIR: 'cache/' });
    assert.equal(r.status, 0, `plan failed: ${r.stderr}`);
    assert.ok(r.stdout.includes('plan (nothing is written)'), r.stdout);
    const exclLines = r.stdout.split('\n');
    assert.ok(exclLines.includes('+/cache'), `the exact entry in the diff: ${r.stdout}`);
    assert.ok(!exclLines.includes('+/cache/'), 'no trailing-slash entry in the diff');
    const after = snapshot(repo);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'no file added or removed');
    for (const [rel, content] of before) assert.ok(after.get(rel).equals(content), `byte-identical: ${rel}`);
    assert.equal(excludeOf(repo), beforeExclude, 'exclude untouched');
    const st = git(repo, 'status', '--porcelain', '--', 'unrelated.txt').stdout;
    assert.ok(st.includes('unrelated.txt'), `status still shows it: ${st}`);
    // Mutation captured: the rc-4 rejection of the valid spelling, a
    // trailing-slash entry, or any write, fails the asserts above.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- trailing-whitespace state dir (R28 review P2) ----------

test('assertSafeLocalRels: any segment with trailing whitespace dies 4; interior spaces and trailing separators pass', () => {
  for (const bad of ['cache ', 'cache\t', 'my cache ', 'a /b', 'deep/cache ', 'cache /', 'cache //', 'a b /']) {
    assert.throws(
      () => assertSafeLocalRels([LOCAL_INSTRUCTION_FILE, bad], 'setup'),
      (e) => e.name === 'DieError' && e.code === 4,
      `rejected: '${bad}'`,
    );
  }
  assert.doesNotThrow(() => assertSafeLocalRels(
    [LOCAL_INSTRUCTION_FILE, 'my cache', 'deep/my cache', 'cache/'], 'setup',
  ), 'interior spaces and a trailing separator pass');
  // Mutation captured: a trailing-whitespace segment slipping through, or an
  // interior-space name rejected, fails the asserts above.
});

test('setup --local refuses a state dir with a trailing-whitespace segment (rc 4) before any mutation', { timeout: 180000 }, () => {
  for (const bad of ['cache ', 'my cache ', 'a /b']) {
    const { dir, repo, env } = forkFixture();
    try {
      seedUpstream(repo);
      fs.mkdirSync(path.join(repo, bad), { recursive: true });
      fs.writeFileSync(path.join(repo, bad, 'state.txt'), 'state\n');
      const before = snapshot(repo);
      const beforeExclude = excludeOf(repo);
      const r = run(repo, env, ['setup', '--local'], { HERDR_AGENTS_DIR: bad });
      assert.equal(r.status, 4, `must refuse '${bad}' with 4: ${r.stdout} ${r.stderr}`);
      assert.ok(r.stderr.includes('refusing to ignore state path'), `actionable message for '${bad}': ${r.stderr}`);
      assert.ok(r.stderr.includes('whitespace'), `the trailing-whitespace reason for '${bad}': ${r.stderr}`);
      assert.ok(!fs.existsSync(path.join(repo, 'CLAUDE.local.md')), `no block for '${bad}'`);
      assert.ok(!fs.existsSync(path.join(repo, '.claude')), `no hooks for '${bad}'`);
      const after = snapshot(repo);
      assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), `no file added or removed for '${bad}'`);
      for (const [rel, content] of before) assert.ok(after.get(rel).equals(content), `byte-identical ${rel} for '${bad}'`);
      assert.equal(excludeOf(repo), beforeExclude, `exclude untouched for '${bad}'`);
      // Real git confirms the refusal left the directory untracked and
      // visible: nothing was excluded, so check-ignore misses it and status
      // still shows it (the state the old code papered over with rc 0).
      assert.notEqual(git(repo, 'check-ignore', '-q', bad).status, 0, `the '${bad}' dir is not ignored`);
      const st = git(repo, 'status', '--porcelain').stdout;
      assert.ok(st.includes('??'), `git status still shows the untracked state dir: ${st}`);
      // Mutation captured: a `/cache `-style entry landing in the exclude,
      // any code but 4, or a mutation before the refusal, fails above.
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('setup --plan --local refuses a trailing-whitespace state dir (rc 4) with no output or mutation', { timeout: 120000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    const before = snapshot(repo);
    const beforeExclude = excludeOf(repo);
    const r = run(repo, env, ['setup', '--plan', '--local'], { HERDR_AGENTS_DIR: 'cache ' });
    assert.equal(r.status, 4, `must refuse with 4: ${r.stdout} ${r.stderr}`);
    assert.ok(r.stderr.includes('refusing to ignore state path'), r.stderr);
    assert.equal(r.stdout, '', `no output before the refusal: ${JSON.stringify(r.stdout)}`);
    assert.ok(!r.stdout.includes(SETUP_START), 'no plan diff is shown before the refusal');
    const after = snapshot(repo);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'no file added or removed');
    for (const [rel, content] of before) assert.ok(after.get(rel).equals(content), `byte-identical: ${rel}`);
    assert.equal(excludeOf(repo), beforeExclude, 'exclude untouched');
    // Mutation captured: a plan line printed before the refusal, a code but
    // 4, or any write, fails the asserts above.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setup --local accepts an interior-space state dir; real git ignores it and unrelated files stay visible', { timeout: 120000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'do not hide me\n');
    fs.mkdirSync(path.join(repo, 'my cache'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'my cache', 'state.txt'), 'state\n');
    const r = run(repo, env, ['setup', '--local'], { HERDR_AGENTS_DIR: 'my cache' });
    assert.equal(r.status, 0, `setup --local failed: ${r.stderr}`);
    const exclLines = excludeOf(repo).split('\n');
    assert.ok(exclLines.includes('/my cache'), `the exact entry: ${exclLines.join('|')}`);
    assert.equal(git(repo, 'check-ignore', '-q', 'my cache').status, 0, 'real git: the state dir is ignored');
    const st = git(repo, 'status', '--porcelain').stdout;
    assert.ok(!st.includes('my cache'), `status does not show the state dir: ${st}`);
    assert.ok(st.includes('unrelated.txt'), 'the unrelated file stays visible');
    // Mutation captured: rejecting the interior-space name, a wrong entry,
    // or hiding the unrelated file, fails the asserts above.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- state-dir path spellings: resolve before the containment test
// (R28 review P2) ----------

test('localRels + stateDirShown: ./, interior . and relative-external spellings resolve before the containment test', () => {
  const { dir, repo } = forkFixture();
  try {
    const ctx = loadConfig(process.env, process.cwd());
    const envOf = (v) => ({ HERDR_AGENTS_DIR: v });
    assert.deepEqual(localRels(repo, ctx, envOf('./cache'), repo), [LOCAL_INSTRUCTION_FILE, 'cache'], './cache resolves under the root');
    assert.deepEqual(localRels(repo, ctx, envOf('a/./b'), repo), [LOCAL_INSTRUCTION_FILE, 'a/b'], 'interior dot resolves');
    assert.deepEqual(localRels(repo, ctx, envOf('../outside-state'), repo), [LOCAL_INSTRUCTION_FILE], 'a relative external adds no state entry');
    assert.deepEqual(localRels(repo, ctx, envOf('cache/'), repo), [LOCAL_INSTRUCTION_FILE, 'cache'], 'trailing separator still normalizes');
    assert.equal(stateDirShown(repo, ctx, envOf('./cache'), repo), 'cache/', 'shown: ./cache reads cache/');
    assert.equal(stateDirShown(repo, ctx, envOf('a/./b'), repo), 'a/b/', 'shown: interior dot resolves');
    assert.equal(stateDirShown(repo, ctx, envOf('../outside-state'), repo), path.resolve(repo, '../outside-state'), 'shown: external is the resolved absolute path');
    // path.resolve is lexical: it cannot erase the actual-name risks, which
    // assertSafeLocalRels still refuses on the resolved name (explicit per
    // the brief — test the erased spellings, not only the raw input).
    for (const bad of ['./cache ', 'a/./b ', './ca*', 'a/./b\nc', 'a/../b ']) {
      assert.throws(
        () => assertSafeLocalRels(localRels(repo, ctx, envOf(bad), repo), 'setup'),
        (e) => e.name === 'DieError' && e.code === 4,
        `still refused after resolution: '${bad}'`,
      );
    }
    // Mutation captured: the raw (unresolved) rel reaching the segment
    // check dies 4 for the valid spellings above; dropping the refusal of
    // the resolved actual-name risks fails the throws above.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setup --local accepts ./ and a/./b state dir spellings; real git ignores the resolved dir', { timeout: 180000 }, () => {
  for (const [value, rel] of [['./cache', 'cache'], ['a/./b', 'a/b']]) {
    const { dir, repo, env } = forkFixture();
    try {
      seedUpstream(repo);
      fs.mkdirSync(path.join(repo, rel), { recursive: true });
      fs.writeFileSync(path.join(repo, rel, 'state.txt'), 'state\n');
      const r = run(repo, env, ['setup', '--local'], { HERDR_AGENTS_DIR: value });
      assert.equal(r.status, 0, `setup --local failed for '${value}': ${r.stderr}`);
      const exclLines = excludeOf(repo).split('\n');
      assert.ok(exclLines.includes(`/${rel}`), `the exact resolved entry for '${value}': ${exclLines.join('|')}`);
      assert.ok(!exclLines.includes(`/${value.replace(/\/+$/, '')}`), `no unresolved-spelling entry for '${value}'`);
      assert.equal(git(repo, 'check-ignore', '-q', rel).status, 0, `real git: '${rel}' is ignored`);
      assert.ok(r.stdout.split('\n').includes(`state dir ignored: ${rel}/`), `the exact message for '${value}': ${r.stdout}`);
      const st = git(repo, 'status', '--porcelain').stdout;
      assert.ok(!st.includes(rel), `status hides the state dir: ${st}`);
      // Mutation captured: the rc-4 traversal refusal of the valid
      // spelling, an unresolved-spelling entry, or the state dir still
      // visible to git, fails the asserts above.
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('setup --local with a relative external state dir adds no state entry and reports it outside the repository', { timeout: 120000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    const external = path.resolve(repo, '../outside-state');
    fs.mkdirSync(external, { recursive: true });
    fs.writeFileSync(path.join(external, 'state.txt'), 'state\n');
    const r = run(repo, env, ['setup', '--local'], { HERDR_AGENTS_DIR: '../outside-state' });
    assert.equal(r.status, 0, `setup --local failed: ${r.stderr}`);
    const exclLines = excludeOf(repo).split('\n');
    assert.ok(exclLines.includes('/CLAUDE.local.md'), 'the instruction file is still excluded');
    assert.ok(!exclLines.some((l) => l.includes('outside-state')), `no state entry: ${exclLines.join('|')}`);
    assert.ok(r.stdout.split('\n').includes(`state dir outside the repository: ${external} (no repository Git exclusion is needed)`), `the exact external line: ${r.stdout}`);
    assert.ok(!r.stdout.includes('state dir ignored'), `no ignore claim for the external dir: ${r.stdout}`);
    // Mutation captured: a traversal refusal (rc 4), a state entry for the
    // external path, or the old `state dir ignored` claim, fails above.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setup --plan --local and --dry-run accept the ./cache spelling without writing anything', { timeout: 120000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    const before = snapshot(repo);
    const beforeExclude = excludeOf(repo);
    const plan = run(repo, env, ['setup', '--plan', '--local'], { HERDR_AGENTS_DIR: './cache' });
    assert.equal(plan.status, 0, `plan failed: ${plan.stderr}`);
    const planLines = plan.stdout.split('\n');
    assert.ok(planLines.includes('+/cache'), `the resolved entry in the diff: ${plan.stdout}`);
    assert.ok(!planLines.includes('+/./cache'), 'no unresolved spelling in the diff');
    const dry = run(repo, env, ['setup', '--local', '--dry-run'], { HERDR_AGENTS_DIR: './cache' });
    assert.equal(dry.status, 0, `dry-run failed: ${dry.stderr}`);
    assert.ok(dry.stdout.includes('/CLAUDE.local.md, /cache'), `the would-ensure line shows the resolved entry: ${dry.stdout}`);
    assert.ok(!fs.existsSync(path.join(repo, 'CLAUDE.local.md')), 'no block written');
    assert.ok(!fs.existsSync(path.join(repo, '.claude')), 'no hooks written');
    const after = snapshot(repo);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'no file added or removed');
    for (const [rel, content] of before) assert.ok(after.get(rel).equals(content), `byte-identical: ${rel}`);
    assert.equal(excludeOf(repo), beforeExclude, 'exclude untouched');
    // Mutation captured: a plan/dry-run refusal (rc 4) of the spelling, an
    // unresolved-spelling entry, or any write, fails the asserts above.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- symlinked root aliases, sibling work trees and worktree-root
// state dirs (R28 review P1/P2) ----------

test('classifyStateDir: ancestor symlink alias inside, sibling and nested work trees, root, symlink refusal and external', () => {
  const { dir, repo } = forkFixture();
  try {
    seedUpstream(repo);
    const ctx = loadConfig(process.env, process.cwd());
    // PATH so classifyStateDir can ask git for the worktree list.
    const envOf = (v) => ({ HERDR_AGENTS_DIR: v, PATH: process.env.PATH });
    // A symlink alias in the parent path before the worktree root (the
    // /tmp -> /private/tmp shape): dir/alias/repo spells dir/repo and
    // classifies inside with the plain rel — the state dir need not exist.
    const alias = path.join(dir, 'alias');
    fs.symlinkSync(dir, alias);
    assert.deepEqual(classifyStateDir(repo, ctx, envOf(path.join(alias, 'repo', 'cache')), repo), { kind: 'inside', rel: 'cache', shown: 'cache/' }, 'ancestor symlink alias resolves inside');
    // A direct outside alias to the root (parent/link -> repo): the
    // alias sits before the worktree root, so the state dir is inside
    // with the plain rel — even before the tail exists.
    const link = path.join(dir, 'link');
    fs.symlinkSync(repo, link);
    assert.deepEqual(classifyStateDir(repo, ctx, envOf(path.join(link, 'cache')), repo), { kind: 'inside', rel: 'cache', shown: 'cache/' }, 'a direct outside alias to the root resolves inside');
    // A symlink component below the matched root is never the directory it
    // points at: loop -> this worktree root classifies by target, and a
    // path through it fails closed.
    fs.symlinkSync(repo, path.join(repo, 'loop'));
    assert.deepEqual(classifyStateDir(repo, ctx, envOf('loop'), repo), { kind: 'symlink', shown: path.join(repo, 'loop'), rootTarget: true }, 'a final symlink to the root is the root');
    assert.deepEqual(classifyStateDir(repo, ctx, envOf('loop/cache'), repo), { kind: 'symlink', shown: path.join(repo, 'loop/cache'), link: path.join(repo, 'loop') }, 'a path through the symlink is refused');
    // An in-repo symlink reached THROUGH an outside alias (parent/link
    // -> repo, repo/loop -> repo): physically under the root, lexically
    // outside the checkout — still refused, not external.
    const loopAlias = path.join(link, 'loop');
    assert.deepEqual(classifyStateDir(repo, ctx, envOf(path.join(loopAlias, 'cache')), repo), { kind: 'symlink', shown: path.join(loopAlias, 'cache'), link: loopAlias }, 'an in-repo symlink through an outside alias is refused');
    // … and through an alias to an INTERIOR directory (sublink ->
    // repo/sub, repo/sub/loop -> repo): the parent's physical path
    // (repo/sub) is under the root — refused.
    fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
    fs.symlinkSync(path.join(repo, 'sub'), path.join(dir, 'sublink'));
    fs.symlinkSync(repo, path.join(repo, 'sub', 'loop'));
    const interiorLoop = path.join(dir, 'sublink', 'loop');
    assert.deepEqual(classifyStateDir(repo, ctx, envOf(path.join(interiorLoop, 'cache')), repo), { kind: 'symlink', shown: path.join(interiorLoop, 'cache'), link: interiorLoop }, 'an in-repo symlink through an interior alias is refused');
    // The benign counterpart: the interior alias alone (no in-repo
    // symlink in the path) reads inside with the root-relative physical
    // rel — even before the tail exists.
    assert.deepEqual(classifyStateDir(repo, ctx, envOf(path.join(dir, 'sublink', 'newstate')), repo), { kind: 'inside', rel: 'sub/newstate', shown: 'sub/newstate/' }, 'an interior alias reads inside with the physical rel');
    // A final symlink to another in-repo directory: the entry would name a
    // different path than the one the state lands in.
    fs.mkdirSync(path.join(repo, '.herdr-agents'), { recursive: true });
    fs.symlinkSync(path.join(repo, '.herdr-agents'), path.join(repo, 's'));
    assert.deepEqual(classifyStateDir(repo, ctx, envOf('s'), repo), { kind: 'symlink', shown: path.join(repo, 's') }, 'a final symlink to an in-repo dir is refused');
    // An in-repo symlink entry pointing OUTSIDE stays 'inside' as its own
    // name (git must hide that repository entry) — never external.
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(repo, 'link2'));
    assert.deepEqual(classifyStateDir(repo, ctx, envOf('link2'), repo), { kind: 'inside', rel: 'link2', shown: 'link2/' }, 'an external-target symlink entry is ignored lexically');
    // The current work tree root: `.` and `sub/..` spellings.
    for (const v of ['.', 'sub/..']) {
      assert.deepEqual(classifyStateDir(repo, ctx, envOf(v), repo), { kind: 'root', shown: repo }, `root: ${v}`);
    }
    // A sibling work tree of the same repo — from either side.
    const wt = path.join(dir, 'wt');
    git(repo, 'worktree', 'add', '-q', wt);
    try {
      assert.deepEqual(classifyStateDir(repo, ctx, envOf(path.join(wt, 'state')), repo), { kind: 'sibling', rel: 'state', worktreeRoot: wt, shown: path.join(wt, 'state') }, 'sibling work tree');
      assert.deepEqual(classifyStateDir(repo, ctx, envOf(wt), repo), { kind: 'root', shown: wt }, 'sibling work tree root');
      assert.deepEqual(classifyStateDir(wt, ctx, envOf(path.join(repo, 'state')), wt), { kind: 'sibling', rel: 'state', worktreeRoot: repo, shown: path.join(repo, 'state') }, 'sibling from the other side');
      // A work tree of another repository is not listed here: external.
      const other = path.join(dir, 'other');
      fs.mkdirSync(other, { recursive: true });
      git(other, 'init', '-q');
      assert.deepEqual(classifyStateDir(repo, ctx, envOf(path.join(other, 'state')), repo), { kind: 'external', shown: path.join(other, 'state') }, 'another repo is external');
    } finally { git(repo, 'worktree', 'remove', '--force', wt); }
    // A nested linked work tree: the most specific listed root wins, from
    // either side.
    const nested = path.join(repo, 'nested');
    git(repo, 'worktree', 'add', '-q', nested);
    try {
      assert.deepEqual(classifyStateDir(repo, ctx, envOf(path.join(nested, 'state')), repo), { kind: 'sibling', rel: 'state', worktreeRoot: nested, shown: path.join(nested, 'state') }, 'nested work tree from the enclosing root');
      assert.deepEqual(classifyStateDir(nested, ctx, envOf(path.join(nested, 'state')), nested), { kind: 'inside', rel: 'state', shown: 'state/' }, 'nested work tree from its own root');
      assert.deepEqual(classifyStateDir(repo, ctx, envOf(nested), repo), { kind: 'root', shown: nested }, 'nested work tree root');
    } finally { git(repo, 'worktree', 'remove', '--force', nested); }
    // A plain external path and a missing in-repo tail.
    assert.deepEqual(classifyStateDir(repo, ctx, envOf(path.join(dir, 'elsewhere')), repo), { kind: 'external', shown: path.join(dir, 'elsewhere') }, 'plain external');
    assert.deepEqual(classifyStateDir(repo, ctx, envOf('deep/cache'), repo), { kind: 'inside', rel: 'deep/cache', shown: 'deep/cache/' }, 'missing tail is walked past');
    // Mutation captured: following a symlink below the root (loop/cache
    // reads cache/), classifying a direct outside alias as external (no
    // entry), accepting an in-repo symlink reached through an outside
    // alias (lexical-only outside test), refusing the ancestor alias
    // (rc 4), or picking the enclosing root for a nested work tree
    // (/nested/state) fails the asserts above.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setup --local with a symlinked spelling of the in-repo state dir writes the root-anchored entry and says ignored', { timeout: 180000 }, () => {
  const { dir, repo, env } = forkFixture();
  const link = path.join(dir, 'link');
  fs.symlinkSync(repo, link);
  try {
    seedUpstream(repo);
    // The alias is real: git reports the physical root, not the link
    // spelling, so the containment test must bridge the two.
    assert.equal(git(link, 'rev-parse', '--show-toplevel').stdout.trim(), repo, 'git resolves the link to the physical root');
    fs.mkdirSync(path.join(repo, '.herdr-agents'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.herdr-agents', 'secret.txt'), 'secret\n');
    const r = run(link, env, ['setup', '--local'], { HERDR_AGENTS_DIR: path.join(link, '.herdr-agents') });
    assert.equal(r.status, 0, `setup --local failed: ${r.stderr}`);
    const exclLines = excludeOf(repo).split('\n');
    assert.ok(exclLines.includes('/.herdr-agents'), `the root-anchored entry: ${exclLines.join('|')}`);
    assert.equal(git(repo, 'check-ignore', '-q', '.herdr-agents').status, 0, 'real git: the state dir is ignored');
    const st = git(repo, 'status', '--porcelain').stdout;
    assert.ok(!st.includes('.herdr-agents'), `status hides the state dir: ${st}`);
    assert.ok(r.stdout.split('\n').includes('state dir ignored: .herdr-agents/'), `the exact line: ${r.stdout}`);
    // The state dir need not exist yet: a fresh fixture, a link-spelled
    // path with a missing tail.
    const fx2 = forkFixture();
    const link2 = path.join(fx2.dir, 'link');
    fs.symlinkSync(fx2.repo, link2);
    try {
      seedUpstream(fx2.repo);
      const r2 = run(link2, fx2.env, ['setup', '--local'], { HERDR_AGENTS_DIR: path.join(link2, 'newstate') });
      assert.equal(r2.status, 0, `a missing state dir must still work: ${r2.stderr}`);
      assert.ok(excludeOf(fx2.repo).split('\n').includes('/newstate'), `the entry for the missing dir: ${excludeOf(fx2.repo)}`);
      assert.ok(r2.stdout.split('\n').includes('state dir ignored: newstate/'), `the exact line: ${r2.stdout}`);
    } finally { fs.rmSync(fx2.dir, { recursive: true, force: true }); }
    // Mutation captured: the lexical-prefix-only miss (outside-repository
    // message, no entry, visible state dir) or the whole-path realpath
    // miss leaves the asserts above failing.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setup --local, --plan and --dry-run refuse an in-repo symlink state path (rc 4) before any mutation; an external-target link still works', { timeout: 240000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    // loop -> this worktree root (untracked, inside the checkout), plus
    // an unrelated cache/ dir: the old whole-path realpath miss wrote
    // /cache, hiding cache while ?? loop stayed visible.
    fs.symlinkSync(repo, path.join(repo, 'loop'));
    fs.mkdirSync(path.join(repo, 'cache'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'cache', 'keep.txt'), 'keep\n');
    const beforeExclude = excludeOf(repo);
    const snapshotFiles = () => {
      const acc = new Map();
      const walk = (p) => {
        for (const e of fs.readdirSync(p, { withFileTypes: true })) {
          const q = path.join(p, e.name);
          if (e.name === '.git') continue;
          if (e.isDirectory()) walk(q);
          else if (e.isFile()) acc.set(q, fs.readFileSync(q));
        }
      };
      walk(repo);
      return acc;
    };
    const before = snapshotFiles();
    for (const value of ['loop', 'loop/cache']) {
      const r = run(repo, env, ['setup', '--local', '--no-hooks'], { HERDR_AGENTS_DIR: value });
      assert.equal(r.status, 4, `${value}: rc 4: ${r.stderr}`);
      assert.ok(r.stderr.includes(`refusing to use state path '${path.join(repo, value)}'`), `${value}: names the path: ${r.stderr}`);
      if (value === 'loop') assert.ok(r.stderr.includes('symlink to the root of a git work tree'), `${value}: the root reason: ${r.stderr}`);
      else assert.ok(r.stderr.includes(`the path traverses the symlink '${path.join(repo, 'loop')}'`), `${value}: the traversal reason: ${r.stderr}`);
    }
    // plan: the same refusal before a single output line.
    const rp = run(repo, env, ['setup', '--plan', '--local'], { HERDR_AGENTS_DIR: 'loop/cache' });
    assert.equal(rp.status, 4, `plan rc 4: ${rp.stderr}`);
    assert.equal(rp.stdout, '', 'plan: no output line precedes the refusal');
    assert.ok(rp.stderr.includes('refusing to use state path'), `plan names the refusal: ${rp.stderr}`);
    // dry-run: the same refusal, write-free.
    const rd = run(repo, env, ['setup', '--local', '--dry-run', '--no-hooks'], { HERDR_AGENTS_DIR: 'loop' });
    assert.equal(rd.status, 4, `dry-run rc 4: ${rd.stderr}`);
    assert.equal(rd.stdout, '', 'dry-run: no output line precedes the refusal');
    // No mutation: no files created, the exclude untouched, the fixture
    // byte-identical — and nothing hidden: both loop and the unrelated
    // cache stay visible to git.
    assert.ok(!fs.existsSync(path.join(repo, 'CLAUDE.local.md')), 'no local instructions file');
    assert.ok(!fs.existsSync(path.join(repo, '.claude')), 'no .claude dir');
    assert.equal(excludeOf(repo), beforeExclude, 'the exclude file is untouched');
    const after = snapshotFiles();
    assert.equal(after.size, before.size, 'no file added, removed or rewritten');
    for (const [k, v] of after) assert.ok(before.has(k) && before.get(k).equals(v), `fixture file changed: ${k}`);
    const st = git(repo, 'status', '--porcelain').stdout;
    assert.ok(st.includes('?? loop'), `the symlink stays visible: ${st}`);
    assert.ok(st.includes('?? cache'), `the unrelated dir stays visible: ${st}`);
    // The supported case is preserved: an in-repo symlink whose target
    // is outside the repo is ignored as its own entry.
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(repo, 'link2'));
    const rl = run(repo, env, ['setup', '--local', '--no-hooks'], { HERDR_AGENTS_DIR: 'link2' });
    assert.equal(rl.status, 0, `the external-target link still works: ${rl.stderr}`);
    assert.ok(excludeOf(repo).split('\n').includes('/link2'), `the entry for the link itself: ${excludeOf(repo)}`);
    assert.ok(rl.stdout.split('\n').includes('state dir ignored: link2/'), `the exact line: ${rl.stdout}`);
    const stl = git(repo, 'status', '--porcelain').stdout;
    assert.ok(!stl.includes('link2'), `the link entry is hidden: ${stl}`);
    assert.ok(stl.includes('?? cache'), `but the unrelated dir is not: ${stl}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setup --local, --plan and --dry-run refuse an in-repo symlink reached through an outside alias (rc 4) before any mutation', { timeout: 240000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    // parent/link -> repo (outside the checkout) plus repo/loop -> repo
    // (inside the checkout): the state path dir/link/loop/cache reaches
    // the in-repo symlink through the outside alias — physically under
    // the root, lexically outside it.
    fs.symlinkSync(repo, path.join(dir, 'link'));
    fs.symlinkSync(repo, path.join(repo, 'loop'));
    fs.mkdirSync(path.join(repo, 'cache'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'cache', 'keep.txt'), 'keep\n');
    const aliasLoop = path.join(dir, 'link', 'loop');
    const value = path.join(aliasLoop, 'cache');
    const beforeExclude = excludeOf(repo);
    for (const args of [
      ['setup', '--local', '--no-hooks'],
      ['setup', '--plan', '--local'],
      ['setup', '--local', '--dry-run', '--no-hooks'],
    ]) {
      const r = run(repo, env, args, { HERDR_AGENTS_DIR: value });
      assert.equal(r.status, 4, `${args[0]}: rc 4: ${r.stderr}`);
      assert.equal(r.stdout, '', `${args[0]}: no output line precedes the refusal`);
      assert.ok(r.stderr.includes(`refusing to use state path '${value}'`), `${args[0]}: names the path: ${r.stderr}`);
      assert.ok(r.stderr.includes(`the path traverses the symlink '${aliasLoop}'`), `${args[0]}: the alias-spelled symlink is the reason: ${r.stderr}`);
    }
    // No mutation and nothing hidden: the in-repo symlink and the
    // unrelated cache both stay visible (the old lexical-only test
    // exited 0 here with /cache, hiding cache while ?? loop remained).
    assert.equal(excludeOf(repo), beforeExclude, 'the exclude file is untouched');
    const st = git(repo, 'status', '--porcelain').stdout;
    assert.ok(st.includes('?? loop'), `the in-repo symlink stays visible: ${st}`);
    assert.ok(st.includes('?? cache'), `the unrelated dir stays visible: ${st}`);
    // Control: the outside alias alone (no in-repo symlink in the path)
    // still works — /state2, and real git ignores it after creation.
    const r2 = run(repo, env, ['setup', '--local', '--no-hooks'], { HERDR_AGENTS_DIR: path.join(dir, 'link', 'state2') });
    assert.equal(r2.status, 0, `the outside alias control still works: ${r2.stderr}`);
    assert.ok(excludeOf(repo).split('\n').includes('/state2'), `the entry: ${excludeOf(repo)}`);
    fs.mkdirSync(path.join(dir, 'link', 'state2'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'link', 'state2', 'keep.txt'), 'via-alias\n');
    assert.equal(git(repo, 'check-ignore', '-q', 'state2').status, 0, 'real git: check-ignore 0 after creation');
    const st2 = git(repo, 'status', '--porcelain').stdout;
    assert.ok(!st2.includes('state2'), `status hides the physical state dir: ${st2}`);
    assert.ok(st2.includes('?? cache'), `the unrelated dir is still visible: ${st2}`);
    // Mutation captured: a lexical-only outside test
    // (v.startsWith(root + '/')) exits 0 here with /cache, failing the
    // rc-4, empty-stdout and visibility asserts above.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setup --local, --plan and --dry-run refuse an in-repo symlink reached through an alias to an interior directory (rc 4) before any mutation', { timeout: 240000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    // sublink -> repo/sub (an alias to an INTERIOR directory) plus
    // repo/sub/loop -> repo (inside the checkout): the state path
    // dir/sublink/loop/cache reaches the in-repo symlink through the
    // interior alias — physically under the root, lexically outside.
    fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
    fs.symlinkSync(path.join(repo, 'sub'), path.join(dir, 'sublink'));
    fs.symlinkSync(repo, path.join(repo, 'sub', 'loop'));
    fs.mkdirSync(path.join(repo, 'cache'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'cache', 'keep.txt'), 'keep\n');
    const aliasLoop = path.join(dir, 'sublink', 'loop');
    const value = path.join(aliasLoop, 'cache');
    const beforeExclude = excludeOf(repo);
    for (const args of [
      ['setup', '--local', '--no-hooks'],
      ['setup', '--plan', '--local'],
      ['setup', '--local', '--dry-run', '--no-hooks'],
    ]) {
      const r = run(repo, env, args, { HERDR_AGENTS_DIR: value });
      assert.equal(r.status, 4, `${args[0]}: rc 4: ${r.stderr}`);
      assert.equal(r.stdout, '', `${args[0]}: no output line precedes the refusal`);
      assert.ok(r.stderr.includes(`refusing to use state path '${value}'`), `${args[0]}: names the path: ${r.stderr}`);
      assert.ok(r.stderr.includes(`the path traverses the symlink '${aliasLoop}'`), `${args[0]}: the alias-spelled symlink is the reason: ${r.stderr}`);
    }
    // No mutation and nothing hidden: no block/hooks/config files, the
    // exclude untouched, the unrelated cache/keep.txt NOT check-ignored,
    // and both the in-repo symlink (under sub/) and the unrelated cache
    // stay visible.
    assert.ok(!fs.existsSync(path.join(repo, 'CLAUDE.local.md')), 'no local instructions file');
    assert.ok(!fs.existsSync(path.join(repo, '.claude')), 'no .claude dir');
    assert.equal(excludeOf(repo), beforeExclude, 'the exclude file is untouched');
    assert.equal(git(repo, 'check-ignore', 'cache/keep.txt').status, 1, 'real git: cache/keep.txt is not ignored');
    const st = git(repo, 'status', '--porcelain').stdout;
    assert.ok(st.includes('sub/'), `the in-repo symlink stays visible: ${st}`);
    assert.ok(st.includes('?? cache'), `the unrelated dir stays visible: ${st}`);
    // The benign counterpart: the interior alias alone (no in-repo
    // symlink in the path) is physically inside the checkout — not
    // external. The entry is the root-relative physical location and
    // real git ignores it after creation.
    const r2 = run(repo, env, ['setup', '--local', '--no-hooks'], { HERDR_AGENTS_DIR: path.join(dir, 'sublink', 'newstate') });
    assert.equal(r2.status, 0, `the interior alias reads inside, not external: ${r2.stderr}`);
    assert.ok(excludeOf(repo).split('\n').includes('/sub/newstate'), `the entry for the physical location: ${excludeOf(repo)}`);
    assert.ok(r2.stdout.split('\n').includes('state dir ignored: sub/newstate/'), `the exact line: ${r2.stdout}`);
    fs.mkdirSync(path.join(repo, 'sub', 'newstate'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'sub', 'newstate', 'file'), 'state\n');
    assert.equal(git(repo, 'check-ignore', '-q', 'sub/newstate/file').status, 0, 'real git: check-ignore matches after creation');
    const st2 = git(repo, 'status', '--short').stdout;
    assert.ok(!st2.includes('newstate'), `status --short omits the state dir: ${st2}`);
    // Mutation captured: a parent test that only compares against the
    // worktree roots (insideVia(parent, rc, true)) accepts this case and
    // exits 0 with /cache, failing the rc-4, check-ignore and visibility
    // asserts above.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setup --local from the enclosing work tree with the state dir in a nested linked work tree uses the nested work tree root', { timeout: 240000 }, () => {
  const { dir, repo, env } = forkFixture();
  // A linked work tree nested inside the main work tree — git lists it
  // for this repository, and its root is the most specific match for a
  // state dir under it.
  let nestedOk = false;
  try {
    seedUpstream(repo);
    const nested = path.join(repo, 'nested');
    git(repo, 'worktree', 'add', '-q', nested);
    nestedOk = true;
    fs.mkdirSync(path.join(nested, 'state'), { recursive: true });
    fs.writeFileSync(path.join(nested, 'state', 'secret.txt'), 'secret\n');
    const r = run(repo, env, ['setup', '--local', '--no-hooks'], { HERDR_AGENTS_DIR: path.join(nested, 'state') });
    assert.equal(r.status, 0, `setup --local failed: ${r.stderr}`);
    const exclLines = excludeOf(repo).split('\n');
    assert.ok(exclLines.includes('/state'), `the entry relative to the nested root: ${exclLines.join('|')}`);
    assert.ok(!exclLines.includes('/nested/state'), `not the enclosing-relative spelling: ${exclLines.join('|')}`);
    assert.ok(r.stdout.split('\n').includes(`state dir ignored: ${path.join(nested, 'state')}`), `the exact line: ${r.stdout}`);
    // Real git from the nested work tree: its own state dir is ignored
    // and stays out of status.
    assert.equal(git(nested, 'check-ignore', '-q', 'state').status, 0, 'real git from the nested root: state is ignored');
    const st = git(nested, 'status', '--porcelain').stdout;
    assert.ok(!st.includes('state'), `status from the nested root hides the state dir: ${st}`);
    // Mutation captured: classifying against the enclosing root
    // (/nested/state) would fail the entry, check-ignore and status
    // asserts above.
  } finally {
    if (nestedOk) git(repo, 'worktree', 'remove', '--force', path.join(repo, 'nested'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('setup --local from a linked work tree with the state dir in the main work tree uses the common exclude relative to that work tree', { timeout: 180000 }, () => {
  const { dir, repo, env } = forkFixture();
  const wt = path.join(dir, 'wt');
  try {
    seedUpstream(repo);
    git(repo, 'worktree', 'add', '-q', wt);
    fs.mkdirSync(path.join(repo, '.herdr-agents'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.herdr-agents', 'secret.txt'), 'secret\n');
    const state = path.join(repo, '.herdr-agents');
    const r = run(wt, env, ['setup', '--local', '--no-hooks'], { HERDR_AGENTS_DIR: state });
    assert.equal(r.status, 0, `setup --local failed: ${r.stderr}`);
    const exclLines = excludeOf(repo).split('\n');
    assert.ok(exclLines.includes('/.herdr-agents'), `the entry relative to the main work tree: ${exclLines.join('|')}`);
    assert.ok(r.stdout.split('\n').includes(`state dir ignored: ${state}`), `the exact line names the actual path: ${r.stdout}`);
    // Proof in the other work tree — the main one, where the state dir
    // physically lives: real git must hide it there.
    assert.equal(git(repo, 'check-ignore', '-q', '.herdr-agents').status, 0, 'real git: ignored in the main work tree');
    const st = git(repo, 'status', '--porcelain').stdout;
    assert.ok(!st.includes('.herdr-agents'), `git status in the main work tree hides it: ${st}`);
    // The local block landed in the work tree that was set up, not the
    // main one.
    assert.ok(fs.existsSync(path.join(wt, 'CLAUDE.local.md')), 'the block is in the linked work tree');
    assert.ok(!fs.existsSync(path.join(repo, 'CLAUDE.local.md')), 'the main work tree got no local block');
    // Mutation captured: the outside-repository message, a missing entry,
    // or the state dir still visible in the main work tree, fails above.
  } finally {
    git(repo, 'worktree', 'remove', '--force', wt);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('setup --local from a linked work tree treats a state dir in another repository as external (true external control)', { timeout: 180000 }, () => {
  const { dir, repo, env } = forkFixture();
  const wt = path.join(dir, 'wt');
  const other = path.join(dir, 'other');
  try {
    seedUpstream(repo);
    git(repo, 'worktree', 'add', '-q', wt);
    fs.mkdirSync(other, { recursive: true });
    git(other, 'init', '-q');
    git(other, 'commit', '-qm', 'empty', '--allow-empty');
    fs.mkdirSync(path.join(other, 'state'), { recursive: true });
    const r = run(wt, env, ['setup', '--local', '--no-hooks'], { HERDR_AGENTS_DIR: path.join(other, 'state') });
    assert.equal(r.status, 0, `setup --local failed: ${r.stderr}`);
    const exclLines = excludeOf(repo).split('\n');
    assert.ok(exclLines.includes('/CLAUDE.local.md'), 'the instruction file is still excluded');
    assert.ok(!exclLines.some((l) => l.includes('state')), `no entry for the other repo's dir: ${exclLines.join('|')}`);
    assert.ok(r.stdout.split('\n').includes(`state dir outside the repository: ${path.join(other, 'state')} (no repository Git exclusion is needed)`), `the exact external line: ${r.stdout}`);
    assert.ok(!r.stdout.includes('state dir ignored'), `no ignore claim: ${r.stdout}`);
    // Mutation captured: matching the other repository's dir (an entry or
    // an ignore claim) fails the asserts above.
  } finally {
    git(repo, 'worktree', 'remove', '--force', wt);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('setup --local and --plan refuse a worktree-root state dir (rc 4) before any mutation', { timeout: 180000 }, () => {
  for (const value of ['.', 'sub/..']) {
    const { dir, repo, env } = forkFixture();
    try {
      seedUpstream(repo);
      const before = snapshot(repo);
      const beforeExclude = excludeOf(repo);
      const r = run(repo, env, ['setup', '--local'], { HERDR_AGENTS_DIR: value });
      assert.equal(r.status, 4, `must refuse '${value}' with 4: ${r.stdout} ${r.stderr}`);
      assert.ok(r.stderr.includes('root of a git work tree'), `the reason for '${value}': ${r.stderr}`);
      assert.ok(!fs.existsSync(path.join(repo, 'CLAUDE.local.md')), `no block for '${value}'`);
      assert.ok(!fs.existsSync(path.join(repo, '.claude')), `no hooks for '${value}'`);
      const after = snapshot(repo);
      assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), `no file added or removed for '${value}'`);
      for (const [rel, content] of before) assert.ok(after.get(rel).equals(content), `byte-identical: ${rel} for '${value}'`);
      assert.equal(excludeOf(repo), beforeExclude, `exclude untouched for '${value}'`);
      // Mutation captured: the old behavior (rc 0, block written and the
      // work tree root reported as outside the repository) fails the
      // status and absence asserts above.
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  // A sibling work tree's root, seen from the linked work tree: the plan
  // refuses before any output or mutation too.
  {
    const { dir, repo, env } = forkFixture();
    const wt = path.join(dir, 'wt');
    try {
      seedUpstream(repo);
      git(repo, 'worktree', 'add', '-q', wt);
      const beforeExclude = excludeOf(repo);
      const r = run(wt, env, ['setup', '--plan', '--local'], { HERDR_AGENTS_DIR: repo });
      assert.equal(r.status, 4, `must refuse the sibling root with 4: ${r.stdout} ${r.stderr}`);
      assert.ok(r.stderr.includes('root of a git work tree'), r.stderr);
      assert.equal(r.stdout, '', 'no plan output before the refusal');
      assert.equal(excludeOf(repo), beforeExclude, 'exclude untouched');
      assert.ok(!fs.existsSync(path.join(wt, 'CLAUDE.local.md')), 'no block in the linked work tree');
    } finally {
      git(repo, 'worktree', 'remove', '--force', wt);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ---------- dry-run hooks preview (R28 review: --no-hooks honored) ----------

test('setup --local --dry-run shows the hooks would-line; --no-hooks omits it', { timeout: 120000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    const beforeExclude = excludeOf(repo);
    const hooksLine = '# would merge into ';
    const withHooks = run(repo, env, ['setup', '--local', '--dry-run']);
    assert.equal(withHooks.status, 0, withHooks.stderr);
    assert.ok(withHooks.stdout.includes(hooksLine) && withHooks.stdout.includes('UserPromptSubmit + SessionStart hooks'), `the hooks preview: ${withHooks.stdout}`);
    const noHooks = run(repo, env, ['setup', '--local', '--dry-run', '--no-hooks']);
    assert.equal(noHooks.status, 0, noHooks.stderr);
    assert.ok(!noHooks.stdout.includes(hooksLine), `no hooks preview with --no-hooks: ${noHooks.stdout}`);
    assert.ok(noHooks.stdout.includes(`# would write to ${path.join(repo, 'CLAUDE.local.md')}`), 'the block preview stays');
    assert.ok(noHooks.stdout.includes(SETUP_START), 'the block is still shown');
    assert.ok(!fs.existsSync(path.join(repo, 'CLAUDE.local.md')), 'nothing written');
    assert.ok(!fs.existsSync(path.join(repo, '.claude')), 'no hooks dir');
    assert.equal(excludeOf(repo), beforeExclude, 'exclude untouched');
    // Mutation captured: the unconditional hooks preview line fails the
    // --no-hooks assert above.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- outside a git work tree (R28 review: no false ignore claim) ----------

test('setup --local outside a git work tree writes the block but never claims the state dir is ignored', { timeout: 120000 }, () => {
  const { dir, env } = forkFixture();
  try {
    const plain = path.join(dir, 'plain');
    fs.mkdirSync(plain, { recursive: true });
    const r = run(plain, env, ['setup', '--local']);
    assert.equal(r.status, 0, `setup --local failed: ${r.stderr}`);
    const local = fs.readFileSync(path.join(plain, 'CLAUDE.local.md'), 'utf8');
    assert.ok(local.includes(SETUP_START), 'the block is still written');
    assert.ok(fs.existsSync(path.join(plain, '.claude', 'settings.json')), 'hooks still written');
    assert.ok(!r.stdout.includes('state dir ignored'), `no false ignore claim: ${r.stdout}`);
    assert.ok(r.stdout.includes('state dir not ignored'), `the accurate report: ${r.stdout}`);
    // Mutation captured: the old unconditional `state dir ignored` line
    // fails the absence assert above.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- effective state dir in the status message (R28 review P3) ----------

test('stateDirShown: relative and trailing-slash overrides, external absolute, default preserved', () => {
  const { dir, repo, env } = forkFixture();
  try {
    const ctx = loadConfig(env, repo);
    assert.equal(stateDirShown(repo, ctx, { ...env, HERDR_AGENTS_DIR: 'cache' }, repo), 'cache/', 'relative override');
    assert.equal(stateDirShown(repo, ctx, { ...env, HERDR_AGENTS_DIR: 'cache/' }, repo), 'cache/', 'trailing separator reads the same');
    assert.equal(stateDirShown(repo, ctx, { ...env, HERDR_AGENTS_DIR: 'deep/my cache' }, repo), 'deep/my cache/', 'nested interior space');
    assert.equal(stateDirShown(repo, ctx, { ...env, HERDR_AGENTS_DIR: '/abs/elsewhere/state' }, repo), '/abs/elsewhere/state', 'external: the actual absolute path');
    // Mutation captured: formatting the cfg default instead of the effective
    // path fails the override asserts above.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setup --local: the final message names the effective state dir, not the default (relative and external)', { timeout: 180000 }, () => {
  const { dir, repo, env, state } = forkFixture();
  try {
    seedUpstream(repo);
    const lines = (r) => r.stdout.split('\n');
    // Relative override (in-repo): the exact line with one trailing
    // separator, for both the plain and the trailing-slash spelling.
    const rel = run(repo, env, ['setup', '--local', '--no-hooks'], { HERDR_AGENTS_DIR: 'cache' });
    assert.equal(rel.status, 0, rel.stderr);
    assert.ok(lines(rel).includes('state dir ignored: cache/'), `exact relative line: ${JSON.stringify(rel.stdout)}`);
    const relSlash = run(repo, env, ['setup', '--local', '--no-hooks'], { HERDR_AGENTS_DIR: 'cache/' });
    assert.equal(relSlash.status, 0, relSlash.stderr);
    assert.ok(lines(relSlash).includes('state dir ignored: cache/'), `trailing slash reads the same: ${JSON.stringify(relSlash.stdout)}`);
    // External override: reported as outside the repository — no
    // repository Git exclusion is installed or needed for it (R28 review
    // P3), and it is never claimed as ignored.
    const ext = run(repo, env, ['setup', '--local', '--no-hooks'], { HERDR_AGENTS_DIR: state });
    assert.equal(ext.status, 0, ext.stderr);
    assert.ok(lines(ext).includes(`state dir outside the repository: ${state} (no repository Git exclusion is needed)`), `exact external line: ${JSON.stringify(ext.stdout)}`);
    assert.ok(!lines(ext).some((l) => l.startsWith('state dir ignored:')), `no ignore claim for the external dir: ${JSON.stringify(ext.stdout)}`);
    assert.ok(!excludeOf(repo).split('\n').some((l) => l.includes(state)), `no exclude entry for the external dir: ${excludeOf(repo)}`);
    // Default: the pre-existing message stays byte-for-byte.
    const def = run(repo, env, ['setup', '--local', '--no-hooks'], { HERDR_AGENTS_DIR: '' });
    assert.equal(def.status, 0, def.stderr);
    assert.ok(lines(def).includes('state dir ignored: .herdr-agents/'), `default preserved: ${JSON.stringify(def.stdout)}`);
    // Outside a work tree the not-ignored line names the effective dir too.
    const plain = path.join(dir, 'plain');
    fs.mkdirSync(plain, { recursive: true });
    const out = run(plain, env, ['setup', '--local', '--no-hooks'], { HERDR_AGENTS_DIR: 'cache' });
    assert.equal(out.status, 0, out.stderr);
    assert.ok(lines(out).includes('state dir not ignored: outside a git work tree, no git exclusion was installed for cache/'), `exact not-ignored line: ${JSON.stringify(out.stdout)}`);
    // Mutation captured: formatting the cfg default instead of the effective
    // state dir fails the override lines above.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- --lane spec validation before any local write (R28 review P3) ----------

test('setup --local --panes with a bad --lane kind dies 2 before any local write or config change', { timeout: 120000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    fs.mkdirSync(path.join(repo, '.agents'), { recursive: true });
    const conf = path.join(repo, '.agents', 'herdr-agents.conf');
    fs.writeFileSync(conf, 'max_workers=2\n');
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'conf');
    const before = snapshot(repo);
    const beforeExclude = excludeOf(repo);
    const r = run(repo, env, ['setup', '--local', '--panes', '3', '--lane', 'x=bogus']);
    assert.equal(r.status, 2, `must die 2: ${r.stdout} ${r.stderr}`);
    assert.ok(r.stderr.includes("setup: unknown kind 'bogus'"), `the usage error: ${r.stderr}`);
    assert.ok(!fs.existsSync(path.join(repo, 'CLAUDE.local.md')), 'no local block');
    assert.ok(!fs.existsSync(path.join(repo, '.claude')), 'no hooks');
    assert.ok(!fs.existsSync(path.join(repo, 'AGENTS.md')), 'no canonical target');
    assert.equal(excludeOf(repo), beforeExclude, 'exclude untouched');
    const after = snapshot(repo);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'no file added or removed');
    for (const [rel, content] of before) assert.ok(after.get(rel).equals(content), `byte-identical: ${rel}`);
    // Mutation captured: the lane spec parsed only inside the late preset
    // write (block, hooks, exclude and the partial tracked config already
    // written before the die 2) fails the snapshot and absence asserts.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setup --local --panes with a valid --lane reuses the parsed spec in the preset write', { timeout: 120000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    const r = run(repo, env, ['setup', '--local', '--panes', '3', '--lane', 'build=grok']);
    assert.equal(r.status, 0, `setup --local failed: ${r.stderr}`);
    assert.ok(r.stdout.includes('set lane.build.kind=grok'), `the parsed spec is applied: ${r.stdout}`);
    const conf = path.join(repo, '.agents', 'herdr-agents.conf');
    assert.ok(fs.readFileSync(conf, 'utf8').includes('lane.build.kind=grok'), 'the tracked config carries the lane');
    assert.ok(fs.existsSync(path.join(repo, 'CLAUDE.local.md')), 'the local block is written');
    // Mutation captured: a spec that is not re-parsed (config missing the
    // lane, or re-parsed twice with divergent output) fails the asserts.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setup --plan --local, --dry-run and canonical setup refuse a bad --lane kind before any output or write', { timeout: 180000 }, () => {
  // plan: die 2 with no plan output.
  {
    const { dir, repo, env } = forkFixture();
    try {
      seedUpstream(repo);
      const r = run(repo, env, ['setup', '--plan', '--local', '--lane', 'x=bogus']);
      assert.equal(r.status, 2, `plan must die 2: ${r.stdout} ${r.stderr}`);
      assert.ok(r.stderr.includes("unknown kind 'bogus'"), r.stderr);
      assert.equal(r.stdout, '', 'no plan output before the refusal');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  // dry-run: die 2 with no would-lines and no writes.
  {
    const { dir, repo, env } = forkFixture();
    try {
      seedUpstream(repo);
      const before = snapshot(repo);
      const r = run(repo, env, ['setup', '--local', '--dry-run', '--panes', '3', '--lane', 'x=bogus']);
      assert.equal(r.status, 2, `dry-run must die 2: ${r.stdout} ${r.stderr}`);
      assert.ok(r.stderr.includes("unknown kind 'bogus'"), r.stderr);
      assert.equal(r.stdout, '', 'no would-lines before the refusal');
      const after = snapshot(repo);
      assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'no file added or removed');
      for (const [rel, content] of before) assert.ok(after.get(rel).equals(content), `byte-identical: ${rel}`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  // canonical: the die 2 now lands before the applyLaneFile preset write —
  // the tracked config stays byte-identical (the partial write predates the
  // early validation).
  {
    const { dir, repo, env } = forkFixture();
    try {
      seedUpstream(repo);
      fs.mkdirSync(path.join(repo, '.agents'), { recursive: true });
      const conf = path.join(repo, '.agents', 'herdr-agents.conf');
      fs.writeFileSync(conf, 'max_workers=2\n');
      git(repo, 'add', '-A');
      git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'conf');
      const r = run(repo, env, ['setup', '--panes', '3', '--lane', 'x=bogus']);
      assert.equal(r.status, 2, `canonical must die 2: ${r.stdout} ${r.stderr}`);
      assert.ok(r.stderr.includes("unknown kind 'bogus'"), r.stderr);
      assert.equal(r.stdout, '', 'no preset lines before the refusal');
      assert.equal(fs.readFileSync(conf, 'utf8'), 'max_workers=2\n', 'tracked config byte-identical');
      assert.equal(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8'), UPSTREAM_CLAUDE, 'tracked instruction byte-identical');
      assert.ok(!fs.existsSync(path.join(repo, 'CLAUDE.local.md')), 'no local block');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  // Mutation captured: parsing the spec only inside the (late) preset write
  // leaves writes/output before the die 2 and fails the asserts above.
});

// ---------- symlinked git exclude (write-through onto tracked .gitignore) ----------

test('setup --local refuses a symlinked git exclude (rc 4) before any mutation', { timeout: 120000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    const beforeIgnore = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8');
    const exclPath = path.join(repo, '.git', 'info', 'exclude');
    fs.rmSync(exclPath);
    fs.symlinkSync(path.join(repo, '.gitignore'), exclPath);
    const r = run(repo, env, ['setup', '--local']);
    assert.equal(r.status, 4, `must refuse with 4: ${r.stdout} ${r.stderr}`);
    assert.ok(r.stderr.includes('is a symlink; refusing to write local excludes through it'), r.stderr);
    assert.equal(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8'), beforeIgnore, 'tracked .gitignore byte-identical');
    assert.ok(fs.lstatSync(exclPath).isSymbolicLink(), 'the exclude link itself is untouched');
    assert.equal(fs.readlinkSync(exclPath), path.join(repo, '.gitignore'), 'the link still points at .gitignore');
    assert.ok(!fs.existsSync(path.join(repo, 'CLAUDE.local.md')), 'no block written');
    assert.ok(!fs.existsSync(path.join(repo, '.claude')), 'no hooks written');
    // Mutation captured: atomicWrite following the link onto the tracked
    // .gitignore (exit 0 with the entry appended there) fails above.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setup --plan --local refuses a symlinked git exclude (rc 4) with no output or mutation', { timeout: 120000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    const beforeIgnore = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8');
    const exclPath = path.join(repo, '.git', 'info', 'exclude');
    fs.rmSync(exclPath);
    fs.symlinkSync(path.join(repo, '.gitignore'), exclPath);
    const before = snapshot(repo);
    const r = run(repo, env, ['setup', '--plan', '--local']);
    assert.equal(r.status, 4, `must refuse with 4: ${r.stdout} ${r.stderr}`);
    assert.ok(r.stderr.includes('is a symlink; refusing to write local excludes through it'), r.stderr);
    assert.ok(!r.stdout.includes(SETUP_START), 'no plan diff is shown before the refusal');
    assert.ok(!r.stdout.includes('info/exclude'), 'no exclude diff is shown either');
    const after = snapshot(repo);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'no file added or removed');
    for (const [rel, content] of before) assert.ok(after.get(rel).equals(content), `byte-identical: ${rel}`);
    assert.equal(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8'), beforeIgnore, 'tracked .gitignore byte-identical');
    assert.ok(fs.lstatSync(exclPath).isSymbolicLink(), 'the exclude link itself is untouched');
    // Mutation captured: the refusal landing after plan output (a diff
    // shown) or any mutation fails the asserts above.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('control: an ordinary (non-symlinked) git exclude keeps working with a tracked .gitignore present', { timeout: 120000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    const beforeIgnore = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8');
    const r = run(repo, env, ['setup', '--local']);
    assert.equal(r.status, 0, `setup --local failed: ${r.stderr}`);
    assert.ok(r.stdout.includes(`block written: ${path.join(repo, 'CLAUDE.local.md')}`), r.stdout);
    assert.equal(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8'), beforeIgnore, 'tracked .gitignore byte-identical');
    const excl = excludeOf(repo);
    assert.ok(excl.includes('/CLAUDE.local.md'), `the local entry: ${excl}`);
    assert.equal(git(repo, 'check-ignore', '-q', 'CLAUDE.local.md').status, 0, 'block ignored');
    // Mutation captured: the symlink refusal misfiring on a regular exclude
    // file fails the status assert above.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- symlinked .git/info ancestor (R28 review P1) ----------
// The concrete hostile layout: a tracked root `exclude` file and a
// `.git/info` symlinked to the repo root, so the effective exclude path
// resolves onto the tracked file. Both commands must refuse before any
// output or mutation and leave the tracked file byte-identical.

function seedSymlinkedInfo(repo) {
  const tracked = path.join(repo, 'exclude');
  fs.writeFileSync(tracked, 'tracked root file; preserve me\n');
  git(repo, 'add', 'exclude');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'tracked exclude');
  const info = path.join(repo, '.git', 'info');
  fs.rmSync(info, { recursive: true });
  fs.symlinkSync('..', info); // .git/info -> the repo root
}

test('setup --local refuses a symlinked .git/info ancestor (rc 4) with the tracked exclude byte-identical', { timeout: 120000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    seedSymlinkedInfo(repo);
    const tracked = path.join(repo, 'exclude');
    const info = path.join(repo, '.git', 'info');
    const before = snapshot(repo);
    const r = run(repo, env, ['setup', '--local']);
    assert.equal(r.status, 4, `must refuse with 4: ${r.stdout} ${r.stderr}`);
    assert.ok(r.stderr.includes('redirected through a symlink at'), r.stderr);
    assert.ok(!r.stdout.includes('info/exclude'), `no successful exclude line: ${r.stdout}`);
    assert.equal(fs.readFileSync(tracked, 'utf8'), 'tracked root file; preserve me\n', 'tracked root exclude byte-identical');
    assert.ok(fs.lstatSync(info).isSymbolicLink(), 'the symlink is left intact');
    assert.equal(fs.readlinkSync(info), '..', 'the symlink still points at the repo root');
    assert.ok(!fs.existsSync(path.join(repo, 'CLAUDE.local.md')), 'no local block');
    assert.ok(!fs.existsSync(path.join(repo, '.claude')), 'no hooks');
    const after = snapshot(repo);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'no file added or removed');
    for (const [rel, content] of before) assert.ok(after.get(rel).equals(content), `byte-identical: ${rel}`);
    // Mutation captured: a write through the symlinked info dir onto the
    // tracked root file (exit 0 with the entry appended there), or any
    // code but 4, fails the asserts above.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setup --plan --local refuses a symlinked .git/info ancestor (rc 4) with no output or mutation', { timeout: 120000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    seedSymlinkedInfo(repo);
    const tracked = path.join(repo, 'exclude');
    const info = path.join(repo, '.git', 'info');
    const before = snapshot(repo);
    const r = run(repo, env, ['setup', '--plan', '--local']);
    assert.equal(r.status, 4, `must refuse with 4: ${r.stdout} ${r.stderr}`);
    assert.ok(r.stderr.includes('redirected through a symlink at'), r.stderr);
    assert.equal(r.stdout, '', `no plan output before the refusal: ${r.stdout}`);
    assert.equal(fs.readFileSync(tracked, 'utf8'), 'tracked root file; preserve me\n', 'tracked root exclude byte-identical');
    assert.ok(fs.lstatSync(info).isSymbolicLink(), 'the symlink is left intact');
    assert.ok(!fs.existsSync(path.join(repo, 'CLAUDE.local.md')), 'no local block');
    const after = snapshot(repo);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'no file added or removed');
    for (const [rel, content] of before) assert.ok(after.get(rel).equals(content), `byte-identical: ${rel}`);
    // Mutation captured: the refusal landing after plan output (a diff
    // shown), a write onto the tracked file, or any code but 4, fails the
    // asserts above.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('control: a tracked root exclude file without a symlinked ancestor keeps working', { timeout: 120000 }, () => {
  // The ancestor walk must not misfire on an ordinary repo that merely
  // happens to track a root file named `exclude`.
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    const tracked = path.join(repo, 'exclude');
    fs.writeFileSync(tracked, 'tracked root file; preserve me\n');
    git(repo, 'add', 'exclude');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'tracked exclude');
    const r = run(repo, env, ['setup', '--local']);
    assert.equal(r.status, 0, `setup --local failed: ${r.stderr}`);
    assert.ok(r.stdout.includes(`block written: ${path.join(repo, 'CLAUDE.local.md')}`), r.stdout);
    const excl = excludeOf(repo);
    assert.ok(excl.includes('/CLAUDE.local.md'), `the local entry: ${excl}`);
    assert.equal(git(repo, 'check-ignore', '-q', 'CLAUDE.local.md').status, 0, 'block ignored');
    assert.equal(fs.readFileSync(tracked, 'utf8'), 'tracked root file; preserve me\n', 'the tracked file is not the exclude');
    // Mutation captured: the ancestor refusal misfiring on the ordinary
    // layout fails the status assert above.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- late final exclude write failure / write-free plan and dry-run
// (R28 review P2) ----------
// The preflights can pass and the final exclude write can still fail (an
// EIO on the atomicWrite rename, or permissions changing after the
// check): the tracked project config must stay byte-identical (the --panes
// preset is staged until the local writes succeed), and the exclude and
// the block must not claim success. Plan and dry-run must stay write-free
// at the syscall level — not just in the before/after snapshot — so a
// transient probe under the git metadata is caught by instrumenting the
// fs calls, in-process.

test('setup --local --panes: a final exclude rename failure dies 4 with the tracked config byte-identical and no success claimed', { timeout: 120000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    fs.mkdirSync(path.join(repo, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.agents', 'herdr-agents.conf'), 'max_workers=2\n');
    seedUpstream(repo); // commits the tracked config
    const conf = path.join(repo, '.agents', 'herdr-agents.conf');
    const confBefore = fs.readFileSync(conf);
    const exclPath = path.join(repo, '.git', 'info', 'exclude');
    const exclBefore = fs.readFileSync(exclPath, 'utf8');
    const realRename = fs.renameSync;
    const realStdout = process.stdout.write;
    let out = '';
    process.stdout.write = (s) => { out += String(s); return true; };
    let failure = null;
    try {
      fs.renameSync = (src, dst, ...rest) => {
        if (path.resolve(String(dst)) === exclPath) {
          const err = new Error('EIO: injected failure at the final exclude rename');
          err.code = 'EIO';
          throw err;
        }
        return realRename(src, dst, ...rest);
      };
      const ctx = loadConfig(env, repo);
      cmdSetup(['--local', '--panes', '3'], ctx, env, repo);
    } catch (err) { failure = err; }
    finally {
      fs.renameSync = realRename;
      process.stdout.write = realStdout;
    }
    assert.ok(failure, 'the final exclude write must fail');
    assert.equal(failure.name, 'DieError');
    assert.equal(failure.code, 4, `rc 4: ${failure.message}`);
    assert.ok(String(failure.message).includes('could not write local excludes'), failure.message);
    assert.ok(fs.readFileSync(conf).equals(confBefore), 'tracked config byte-identical');
    assert.equal(fs.readFileSync(exclPath, 'utf8'), exclBefore, 'existing exclude bytes preserved');
    assert.ok(!fs.existsSync(path.join(repo, 'CLAUDE.local.md')), 'no block written');
    assert.ok(!fs.existsSync(path.join(repo, '.claude')), 'no hooks written');
    assert.ok(!out.includes('panes=3'), `no panes success line: ${out}`);
    assert.ok(!out.includes('block written'), `no block claim: ${out}`);
    assert.ok(!out.includes('local excludes updated'), `no exclude claim: ${out}`);
    assert.deepEqual(
      fs.readdirSync(path.join(repo, '.git', 'info')).filter((f) => f.startsWith('.exclude.')),
      [],
      'no temp file leaked by the failed atomicWrite',
    );
    // Mutation captured: the panes preset written before the final exclude
    // write (the old ordering) fails the byte-identical and no-panes-line
    // asserts above.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setup --plan --local and setup --local --dry-run: no writeFileSync/unlinkSync (nor rename/rm) under git metadata', { timeout: 120000 }, () => {
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    const gitMeta = path.join(repo, '.git');
    const ops = [];
    const real = {
      write: fs.writeFileSync,
      unlink: fs.unlinkSync,
      rename: fs.renameSync,
      rm: fs.rmSync,
    };
    const record = (name) => (p, ...rest) => {
      ops.push(`${name}:${p}`);
      return real[name](p, ...rest);
    };
    fs.writeFileSync = record('write');
    fs.unlinkSync = record('unlink');
    fs.renameSync = record('rename');
    fs.rmSync = record('rm');
    const underGitMeta = (p) => {
      const r = path.resolve(String(p));
      return r === gitMeta || r.startsWith(gitMeta + path.sep);
    };
    let planErr = null;
    let dryErr = null;
    try {
      const ctx = loadConfig(env, repo);
      try { cmdSetupPlan(['--local', '--panes', '3'], ctx, env, repo); } catch (e) { planErr = e; }
      try { cmdSetup(['--local', '--dry-run', '--panes', '3'], ctx, env, repo); } catch (e) { dryErr = e; }
    } finally {
      fs.writeFileSync = real.write;
      fs.unlinkSync = real.unlink;
      fs.renameSync = real.rename;
      fs.rmSync = real.rm;
    }
    assert.equal(planErr, null, `plan must succeed on a healthy parent: ${planErr && planErr.message}`);
    assert.equal(dryErr, null, `dry-run must succeed on a healthy parent: ${dryErr && dryErr.message}`);
    const underGit = ops.filter((op) => underGitMeta(op.slice(op.indexOf(':') + 1)));
    assert.deepEqual(underGit, [], `no mutation call under git metadata: ${ops.join('\n')}`);
    assert.ok(!ops.some((op) => op.includes('.herdr-agents-probe-')), `no transient write probe anywhere: ${ops.join('\n')}`);
    // Mutation captured: the active probe in the plan/dry-run preflight
    // records a write+unlink under .git/info and fails the asserts above.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setup --local --dry-run refuses a missing exclude under an unwritable parent (rc 4) with no output', { timeout: 120000 }, () => {
  // The dry-run preflight is read-only (no write probe) but must refuse the
  // same unwritable parent the plan and the real setup refuse, with empty
  // stdout — the would-lines are printed only after the refusal passes.
  const { dir, repo, env } = forkFixture();
  try {
    seedUpstream(repo);
    const before = snapshot(repo);
    const info = path.join(repo, '.git', 'info');
    const exclPath = path.join(info, 'exclude');
    fs.rmSync(exclPath);
    fs.chmodSync(info, 0o555);
    let r;
    try {
      r = run(repo, env, ['setup', '--local', '--dry-run', '--panes', '3']);
    } finally { fs.chmodSync(info, 0o755); }
    assert.equal(r.status, 4, `must refuse with 4: ${r.stdout} ${r.stderr}`);
    assert.ok(r.stderr.includes('cannot write the git exclude file'), r.stderr);
    assert.equal(r.stdout, '', `no would-lines before the refusal: ${r.stdout}`);
    const after = snapshot(repo);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'no file added or removed');
    for (const [rel, content] of before) assert.ok(after.get(rel).equals(content), `byte-identical: ${rel}`);
    assert.ok(!fs.existsSync(exclPath), 'no exclude created');
    // Mutation captured: a write probe surviving the refusal, a would-line
    // shown before it, or any code but 4, fails the asserts above.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
