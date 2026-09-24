// Golden (slice 9a-C; slice 7a scenario coverage): the `setup` scenarios of
// test-setup.sh (block + hooks + idempotence, no absolute installer path)
// plus the acceptance matrix — fresh repo, existing AGENTS.md, block already
// present (second run idempotent), CLAUDE.md symlink, CLAUDE.md separately
// without the block (warning), --target relative, --no-hooks, --dry-run,
// --panes 3, --panes 4 --lane, --panes 5 (rc 2), unknown option (rc 2),
// settings.json with other hooks, settings.json with invalid JSON (rc 4) —
// run only the JS (`node scripts/herdr-agents.mjs`) and compare against the
// value stored once in test/golden/parity-setup.json (test/golden.mjs:
// HERDR_AGENTS_GOLDEN unset checks the JS value against the stored value,
// =update overwrites the stored value with the JS value for review). 19 scenarios.
//
// The stored value pins the exact shape of two edges instead of
// byte-comparing the affected bytes:
//   1. Append path: for a file without a trailing newline the JS writes the
//      intended "missing newline + one blank line" (brief decision 3).
//   2. Invalid settings.json: the JS prints only its own
//      `could not merge hooks into <file>` die line, exits 4 and leaves the
//      file untouched (jq is not a requirement, spec decision 5).
//
// The stored value holds, per step, the exit code, the stdout and the
// prefix-normalized stderr, plus the final content of the scenario files
// (the comparison's full field set). The fixture root becomes <ROOT> and
// the skill root <SKILL> in every string of the value.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFixture, runImpl, normalizeErr, nodeBin } from './parity.mjs';
import { golden, normalizeRoots } from './golden.mjs';
import { setupBlock } from '../lib/setuptext.mjs';

// The fixture contract is POSIX (temporary git repo, symlinks, POSIX path
// layout), so the scenarios are skipped on Windows.
const SKIP =
  process.platform === 'win32'
    ? 'Windows: the POSIX fixture contract needs a POSIX host'
    : false;

const SUITE = 'parity-setup';

// The skill root: the no-abs-path scenario symlinks it into the fixture,
// and the installer path must not leak into the stored value.
const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The instruction file after a first run in the intended transform: the
// seed, one blank line, the block. Replacing from this seed is a fixed
// point (the append path never fires on a file that already carries the
// block).
const SEED_AGENTS = '# Agent instructions\n';
const BLOCK_SEEDED = `${SEED_AGENTS}\n${setupBlock()}`;

function readRel(root, rel) {
  try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; }
}

// Run every step against the JS entry in a fresh fixture (the setup-owned
// files AGENTS.md/CLAUDE.md/.claude are reset before the seed) and return
// the golden value: per step the exit code, the stdout and the
// prefix-normalized stderr, plus the final content of opts.files (paths
// relative to the fixture root; `null` means "must not exist"). The fixture
// root becomes <ROOT> (and the skill root <SKILL>) in every string of the
// value.
function setupValue(opts) {
  const fix = makeFixture();
  try {
    fix.reset();
    fs.rmSync(path.join(fix.repo, 'AGENTS.md'), { force: true });
    fs.rmSync(path.join(fix.repo, 'CLAUDE.md'), { force: true });
    fs.rmSync(path.join(fix.repo, '.claude'), { recursive: true, force: true });
    if (opts.seed) opts.seed(fix);
    const steps = [];
    for (const step of opts.steps) {
      const stepEnv = step.env ? { ...fix.env, ...step.env } : fix.env;
      const r = runImpl(step.args, { env: stepEnv, cwd: fix.repo });
      steps.push({ args: step.args, rc: r.rc, out: r.out, err: normalizeErr(r.err) });
    }
    const files = (opts.files ?? []).map((rel) => ({ rel, content: readRel(fix.root, rel) }));
    return normalizeRoots({ steps, files }, { '<ROOT>': fix.root, '<SKILL>': SKILL_DIR });
  } finally {
    fix.cleanup();
  }
}

// Golden wrapper: check/update run the JS; the value is returned for the
// per-scenario assertions.
function setupScenario(name, opts) {
  let value;
  const actual = () => (value !== undefined ? value : (value = setupValue(opts))); // check/update
  golden(SUITE, name, actual);
  return actual();
}

// Seed helpers (relative to the fixture repo).
const seedAgents = (text = SEED_AGENTS) => (fix) => fs.writeFileSync(path.join(fix.repo, 'AGENTS.md'), text);
const seedSettings = (text) => (fix) => {
  fs.mkdirSync(path.join(fix.repo, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(fix.repo, '.claude', 'settings.json'), text);
};

test('parity: setup on a fresh repo writes AGENTS.md, hooks, no .gitignore outside the repo', { timeout: 120000, skip: SKIP }, () => {
  setupScenario('setup-fresh', {
    steps: [{ args: ['setup'] }],
    files: ['repo/AGENTS.md', 'repo/.claude/settings.json', 'repo/.gitignore', 'repo/.agents/herdr-agents.conf'],
  });
});

test('parity: setup appends to an existing AGENTS.md (one blank line before the block)', { timeout: 120000, skip: SKIP }, () => {
  setupScenario('setup-agents-existing', {
    seed: seedAgents(),
    steps: [{ args: ['setup'] }],
    files: ['repo/AGENTS.md', 'repo/.claude/settings.json'],
  });
});

test('parity: setup is idempotent on a block already present (second run replaces, same bytes)', { timeout: 120000, skip: SKIP }, () => {
  setupScenario('setup-idempotent', {
    seed: seedAgents(BLOCK_SEEDED),
    steps: [
      { args: ['setup'] },
      { args: ['setup'] },
    ],
    files: ['repo/AGENTS.md', 'repo/.claude/settings.json'],
  });
});

test('parity: CLAUDE.md as a symlink to AGENTS.md takes the block through the link, no warning', { timeout: 120000, skip: SKIP }, () => {
  setupScenario('setup-claude-symlink', {
    seed: (fix) => {
      fs.writeFileSync(path.join(fix.repo, 'AGENTS.md'), SEED_AGENTS);
      fs.symlinkSync(path.join(fix.repo, 'AGENTS.md'), path.join(fix.repo, 'CLAUDE.md'));
    },
    steps: [
      { args: ['setup'] },
      { args: ['setup'] },
    ],
    files: ['repo/AGENTS.md', 'repo/.claude/settings.json'],
  });
});

test('parity: a separate CLAUDE.md without the block warns, and is left alone', { timeout: 120000, skip: SKIP }, () => {
  setupScenario('setup-claude-separate', {
    seed: (fix) => {
      fs.writeFileSync(path.join(fix.repo, 'AGENTS.md'), SEED_AGENTS);
      fs.writeFileSync(path.join(fix.repo, 'CLAUDE.md'), 'claude-only content\n');
    },
    steps: [{ args: ['setup'] }],
    files: ['repo/AGENTS.md', 'repo/CLAUDE.md', 'repo/.claude/settings.json'],
  });
});

test('parity: --target with a relative path targets the repo file', { timeout: 120000, skip: SKIP }, () => {
  setupScenario('setup-target-relative', {
    steps: [{ args: ['setup', '--target', 'CLAUDE.md'] }],
    files: ['repo/CLAUDE.md', 'repo/AGENTS.md', 'repo/.claude/settings.json'],
  });
});

test('parity: --no-hooks leaves no settings.json and skips the hook lines', { timeout: 120000, skip: SKIP }, () => {
  setupScenario('setup-no-hooks', {
    seed: seedAgents(),
    steps: [{ args: ['setup', '--no-hooks'] }],
    files: ['repo/AGENTS.md', 'repo/.claude/settings.json'],
  });
});

test('parity: --dry-run prints the would-lines and writes nothing', { timeout: 120000, skip: SKIP }, () => {
  setupScenario('setup-dry-run', {
    seed: seedAgents(),
    steps: [
      { args: ['setup', '--dry-run'] },
      { args: ['setup', '--dry-run', '--panes', '3', '--lane', 'review=claude:opus:high'] },
    ],
    files: ['repo/AGENTS.md', 'repo/.claude/settings.json', 'repo/.gitignore', 'repo/.agents/herdr-agents.conf'],
  });
});

test('parity: --panes 3 applies the preset to the project config', { timeout: 120000, skip: SKIP }, () => {
  setupScenario('setup-panes-3', {
    steps: [{ args: ['setup', '--panes', '3'] }],
    files: ['repo/.agents/herdr-agents.conf', 'repo/AGENTS.md', 'repo/.claude/settings.json'],
  });
});

test('parity: --panes 4 with --lane writes the lane kind/model/effort', { timeout: 120000, skip: SKIP }, () => {
  setupScenario('setup-panes-4-lane', {
    steps: [{ args: ['setup', '--panes', '4', '--lane', 'review=claude:opus:high'] }],
    files: ['repo/.agents/herdr-agents.conf', 'repo/AGENTS.md', 'repo/.claude/settings.json'],
  });
});

test('parity: --panes 5 and an unknown option are usage errors (rc 2), nothing written', { timeout: 120000, skip: SKIP }, () => {
  setupScenario('setup-usage-errors', {
    steps: [
      { args: ['setup', '--panes', '5'] },
      { args: ['setup', '--bogus'] },
      { args: ['setup', '--target'] },
      { args: ['setup', '--panes', '--no-hooks'] },
    ],
    files: ['repo/AGENTS.md', 'repo/.claude/settings.json', 'repo/.agents/herdr-agents.conf'],
  });
});

test('parity: settings.json with other hooks is merged, other entries untouched', { timeout: 120000, skip: SKIP }, () => {
  const seed = seedSettings('{"other":{"x":1},"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"echo keep-me"}]}],"SessionStart":[{"hooks":[{"type":"command","command":"bash something-else.sh"}]}]}}\n');
  setupScenario('setup-settings-other', {
    seed,
    steps: [{ args: ['setup'] }],
    files: ['repo/.claude/settings.json', 'repo/AGENTS.md'],
  });
});

test('parity: an empty or blank settings.json gets the hooks (read as {})', { timeout: 120000, skip: SKIP }, () => {
  for (const [name, content] of [['empty', ''], ['blank', '\n\n']]) {
    setupScenario(`setup-settings-${name}`, {
      seed: seedSettings(content),
      steps: [{ args: ['setup'] }],
      files: ['repo/.claude/settings.json', 'repo/AGENTS.md'],
    });
  }
});

test('parity: false where jq expects a list is read as an empty list (`// []`)', { timeout: 120000, skip: SKIP }, () => {
  for (const [name, content] of [
    ['event-false', '{"hooks":{"UserPromptSubmit":false}}\n'],
    ['entry-hooks-false', '{"hooks":{"SessionStart":[{"hooks":false},{"hooks":[{"type":"command","command":"echo keep"}]}]}}\n'],
  ]) {
    setupScenario(`setup-settings-${name}`, {
      seed: seedSettings(content),
      steps: [{ args: ['setup'] }],
      files: ['repo/.claude/settings.json'],
    });
  }
});

test('parity: invalid settings.json refuses with rc 4, file untouched (jq error line not reproduced)', { timeout: 120000, skip: SKIP }, () => {
  setupScenario('setup-settings-invalid', {
    seed: seedSettings('{invalid\n'),
    steps: [{ args: ['setup'] }],
    files: ['repo/.claude/settings.json', 'repo/AGENTS.md'],
  });
});

test('parity: the state dir is git-ignored when it lives inside the repo (HERDR_AGENTS_DIR empty)', { timeout: 120000, skip: SKIP }, () => {
  setupScenario('setup-gitignore', {
    steps: [{ args: ['setup'], env: { HERDR_AGENTS_DIR: '' } }],
    files: ['repo/.gitignore', 'repo/AGENTS.md'],
  });
});

test('parity: test-setup.sh scenario — the block embeds no absolute installer path (project-local skill resolves the hook)', { timeout: 120000, skip: SKIP }, () => {
  const v = setupScenario('setup-no-abs-path', {
    seed: (fix) => {
      fs.mkdirSync(path.join(fix.repo, '.agents', 'skills'), { recursive: true });
      fs.symlinkSync(SKILL_DIR, path.join(fix.repo, '.agents', 'skills', 'herdr-agents'));
      fs.writeFileSync(path.join(fix.repo, 'AGENTS.md'), SEED_AGENTS);
      fs.mkdirSync(path.join(fix.repo, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(fix.repo, '.claude', 'settings.json'), '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"echo keep-me"}]}]}}\n');
    },
    steps: [
      { args: ['setup'] },
      { args: ['setup'] },
    ],
    files: ['repo/AGENTS.md', 'repo/.claude/settings.json'],
  });
  const content = Object.fromEntries(v.files.map((f) => [f.rel, f.content]));
  assert.ok(!content['repo/AGENTS.md'].includes('<SKILL>'), 'AGENTS.md embeds the installer path');
  assert.ok(!content['repo/.claude/settings.json'].includes('<SKILL>'), 'settings.json embeds the installer path');
});

// Node-only: --probe --plan is refused with the exclusivity message (the
// shared check in cmdSetup runs before either branch). The parity against
// the stored value is the golden's job; this guards the JS shape.
function runNode(args) {
  const fix = makeFixture();
  try {
    const r = runImpl(args, { env: fix.env, cwd: fix.repo });
    return { rc: r.rc, out: r.out, err: r.err };
  } finally {
    fix.cleanup();
  }
}

test('node: setup --probe --plan is exclusive (rc 2, the bash message)', { timeout: 120000, skip: SKIP }, () => {
  const r = runNode(['setup', '--probe', '--plan']);
  assert.equal(r.rc, 2);
  assert.equal(normalizeErr(r.err).trimEnd(), 'PROG: setup: --probe and --plan are exclusive');
});

// Touch `nodeBin()` so a missing node is a loud failure here rather than
// in every scenario.
void nodeBin();
