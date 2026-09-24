// Parity (slice 7a): the `setup` scenarios of test-setup.sh (block + hooks +
// idempotence, no absolute installer path) plus the acceptance matrix —
// fresh repo, existing AGENTS.md, block already present (second run
// idempotent), CLAUDE.md symlink, CLAUDE.md separately without the block
// (warning), --target relative, --no-hooks, --dry-run, --panes 3,
// --panes 4 --lane, --panes 5 (rc 2), unknown option (rc 2), settings.json
// with other hooks, settings.json with invalid JSON (rc 4) — each run
// against `bash scripts/herdr-agents.sh` and `node scripts/herdr-agents.mjs`
// in an identical fixture must produce identical stdout, exit code and
// (prefix-normalized) stderr, and byte-identical written files.
//
// Two known bash defects are NOT ported (brief decision 6); the test pins
// the exact shape of each divergence instead of byte-comparing the affected
// bytes:
//   1. Append path: the `tail -c1 | od -An -c | tr -d ' '` last-newline check
//      is dead code — it compares od's 2-char display of a newline against
//      the 3-char literal `\\n` — so bash appends an extra `\n` (a second
//      blank line) after any non-empty file. JS writes the intended
//      "missing newline + one blank line" (brief decision 3).
//   2. Invalid settings.json: bash's stderr also carries jq's parse-error
//      line; JS (jq is not a requirement, spec decision 5) prints only its
//      own `could not merge hooks into <file>` die line. Both exit 4 and
//      leave the file untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeFixture, runImpl, normalizeErr, nodeBin } from './parity.mjs';
import { setupBlock } from '../lib/setuptext.mjs';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The instruction file after a first run in the intended transform: the
// seed, one blank line, the block. Replacing from this seed is a fixed
// point for both implementations (the bash append defect never fires on a
// file that already carries the block).
const SEED_AGENTS = '# Agent instructions\n';
const BLOCK_SEEDED = `${SEED_AGENTS}\n${setupBlock()}`;

// Like parity.mjs' parityScenario, plus: an extended reset (the setup-owned
// files AGENTS.md/CLAUDE.md/.claude must not leak between the bash and node
// runs) and a per-step `stderr: 'strip-jq'` mode (the jq error line). Returns
// the final files per implementation for extra assertions.
function paritySetup(t, name, opts) {
  void t;
  const fix = makeFixture();
  let bashRes, bashFiles, nodeRes, nodeFiles;
  try {
    for (const impl of ['bash', 'node']) {
      fix.reset();
      fs.rmSync(path.join(fix.repo, 'AGENTS.md'), { force: true });
      fs.rmSync(path.join(fix.repo, 'CLAUDE.md'), { force: true });
      fs.rmSync(path.join(fix.repo, '.claude'), { recursive: true, force: true });
      if (opts.seed) opts.seed(fix);
      const results = [];
      for (const step of opts.steps) {
        const stepEnv = step.env ? { ...fix.env, ...step.env } : fix.env;
        results.push(runImpl(impl, step.args, { env: stepEnv, cwd: fix.repo }));
      }
      const files = (opts.files ?? []).map((rel) => ({
        rel,
        content: (() => { try { return fs.readFileSync(path.join(fix.root, rel), 'utf8'); } catch { return null; } })(),
      }));
      if (impl === 'bash') { bashRes = results; bashFiles = files; } else { nodeRes = results; nodeFiles = files; }
    }
  } finally {
    fix.cleanup();
  }
  assert.equal(nodeRes.length, bashRes.length, `${name}: step count`);
  for (let i = 0; i < bashRes.length; i++) {
    const where = `${name}: step ${i + 1} (${opts.steps[i].args.join(' ')})`;
    assert.equal(nodeRes[i].rc, bashRes[i].rc, `${where}: exit code (bash=${bashRes[i].rc} node=${nodeRes[i].rc})`);
    assert.equal(nodeRes[i].out, bashRes[i].out, `${where}: stdout (node output first)`);
    let bashErr = bashRes[i].err;
    if (opts.steps[i].stderr === 'strip-jq') {
      // The jq parse-error line(s) are bash's jq dependency (spec decision 5
      // drops it); the die line and the exit code are the contract.
      bashErr = bashErr.split('\n').filter((l) => !l.startsWith('jq:')).join('\n');
    }
    assert.equal(normalizeErr(nodeRes[i].err), normalizeErr(bashErr), `${where}: stderr normalized`);
  }
  const bashByRel = Object.fromEntries(bashFiles.map((f) => [f.rel, f.content]));
  const nodeByRel = Object.fromEntries(nodeFiles.map((f) => [f.rel, f.content]));
  for (let i = 0; i < (opts.files ?? []).length; i++) {
    const rel = opts.files[i];
    const where = `${name}: file ${rel} after the run (node content first)`;
    assert.equal(nodeByRel[rel], bashByRel[rel], where);
  }
  return { bash: bashByRel, node: nodeByRel };
}

// Seed helpers (relative to the fixture repo).
const seedAgents = (text = SEED_AGENTS) => (fix) => fs.writeFileSync(path.join(fix.repo, 'AGENTS.md'), text);
const seedSettings = (text) => (fix) => {
  fs.mkdirSync(path.join(fix.repo, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(fix.repo, '.claude', 'settings.json'), text);
};

test('parity: setup on a fresh repo writes AGENTS.md, hooks, no .gitignore outside the repo', { timeout: 120000 }, (t) => {
  paritySetup(t, 'setup-fresh', {
    steps: [{ args: ['setup'] }],
    files: ['repo/AGENTS.md', 'repo/.claude/settings.json', 'repo/.gitignore', 'repo/.agents/herdr-agents.conf'],
  });
});

test('parity: setup appends to an existing AGENTS.md (one blank line before the block)', { timeout: 120000 }, (t) => {
  paritySetup(t, 'setup-agents-existing', {
    seed: seedAgents(),
    steps: [{ args: ['setup'] }],
    files: ['repo/AGENTS.md', 'repo/.claude/settings.json'],
  });
});

test('parity: setup is idempotent on a block already present (second run replaces, same bytes)', { timeout: 120000 }, (t) => {
  paritySetup(t, 'setup-idempotent', {
    seed: seedAgents(BLOCK_SEEDED),
    steps: [
      { args: ['setup'] },
      { args: ['setup'] },
    ],
    files: ['repo/AGENTS.md', 'repo/.claude/settings.json'],
  });
});

test('parity: CLAUDE.md as a symlink to AGENTS.md takes the block through the link, no warning', { timeout: 120000 }, (t) => {
  paritySetup(t, 'setup-claude-symlink', {
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

test('parity: a separate CLAUDE.md without the block warns, and is left alone', { timeout: 120000 }, (t) => {
  paritySetup(t, 'setup-claude-separate', {
    seed: (fix) => {
      fs.writeFileSync(path.join(fix.repo, 'AGENTS.md'), SEED_AGENTS);
      fs.writeFileSync(path.join(fix.repo, 'CLAUDE.md'), 'claude-only content\n');
    },
    steps: [{ args: ['setup'] }],
    files: ['repo/AGENTS.md', 'repo/CLAUDE.md', 'repo/.claude/settings.json'],
  });
});

test('parity: --target with a relative path targets the repo file', { timeout: 120000 }, (t) => {
  paritySetup(t, 'setup-target-relative', {
    steps: [{ args: ['setup', '--target', 'CLAUDE.md'] }],
    files: ['repo/CLAUDE.md', 'repo/AGENTS.md', 'repo/.claude/settings.json'],
  });
});

test('parity: --no-hooks leaves no settings.json and skips the hook lines', { timeout: 120000 }, (t) => {
  paritySetup(t, 'setup-no-hooks', {
    seed: seedAgents(),
    steps: [{ args: ['setup', '--no-hooks'] }],
    files: ['repo/AGENTS.md', 'repo/.claude/settings.json'],
  });
});

test('parity: --dry-run prints the would-lines and writes nothing', { timeout: 120000 }, (t) => {
  paritySetup(t, 'setup-dry-run', {
    seed: seedAgents(),
    steps: [
      { args: ['setup', '--dry-run'] },
      { args: ['setup', '--dry-run', '--panes', '3', '--lane', 'review=claude:opus:high'] },
    ],
    files: ['repo/AGENTS.md', 'repo/.claude/settings.json', 'repo/.gitignore', 'repo/.agents/herdr-agents.conf'],
  });
});

test('parity: --panes 3 applies the preset to the project config', { timeout: 120000 }, (t) => {
  paritySetup(t, 'setup-panes-3', {
    steps: [{ args: ['setup', '--panes', '3'] }],
    files: ['repo/.agents/herdr-agents.conf', 'repo/AGENTS.md', 'repo/.claude/settings.json'],
  });
});

test('parity: --panes 4 with --lane writes the lane kind/model/effort', { timeout: 120000 }, (t) => {
  paritySetup(t, 'setup-panes-4-lane', {
    steps: [{ args: ['setup', '--panes', '4', '--lane', 'review=claude:opus:high'] }],
    files: ['repo/.agents/herdr-agents.conf', 'repo/AGENTS.md', 'repo/.claude/settings.json'],
  });
});

test('parity: --panes 5 and an unknown option are usage errors (rc 2), nothing written', { timeout: 120000 }, (t) => {
  paritySetup(t, 'setup-usage-errors', {
    steps: [
      { args: ['setup', '--panes', '5'] },
      { args: ['setup', '--bogus'] },
      { args: ['setup', '--target'] },
      { args: ['setup', '--panes', '--no-hooks'] },
    ],
    files: ['repo/AGENTS.md', 'repo/.claude/settings.json', 'repo/.agents/herdr-agents.conf'],
  });
});

test('parity: settings.json with other hooks is merged, other entries untouched', { timeout: 120000 }, (t) => {
  const seed = seedSettings('{"other":{"x":1},"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"echo keep-me"}]}],"SessionStart":[{"hooks":[{"type":"command","command":"bash something-else.sh"}]}]}}\n');
  paritySetup(t, 'setup-settings-other', {
    seed,
    steps: [{ args: ['setup'] }],
    files: ['repo/.claude/settings.json', 'repo/AGENTS.md'],
  });
});

test('parity: an empty or blank settings.json gets the hooks (read as {})', { timeout: 120000 }, (t) => {
  for (const [name, content] of [['empty', ''], ['blank', '\n\n']]) {
    paritySetup(t, `setup-settings-${name}`, {
      seed: seedSettings(content),
      steps: [{ args: ['setup'] }],
      files: ['repo/.claude/settings.json', 'repo/AGENTS.md'],
    });
  }
});

test('parity: false where jq expects a list is read as an empty list (`// []`)', { timeout: 120000 }, (t) => {
  for (const [name, content] of [
    ['event-false', '{"hooks":{"UserPromptSubmit":false}}\n'],
    ['entry-hooks-false', '{"hooks":{"SessionStart":[{"hooks":false},{"hooks":[{"type":"command","command":"echo keep"}]}]}}\n'],
  ]) {
    paritySetup(t, `setup-settings-${name}`, {
      seed: seedSettings(content),
      steps: [{ args: ['setup'] }],
      files: ['repo/.claude/settings.json'],
    });
  }
});

test('parity: invalid settings.json refuses with rc 4, file untouched (jq error line not reproduced)', { timeout: 120000 }, (t) => {
  paritySetup(t, 'setup-settings-invalid', {
    seed: seedSettings('{invalid\n'),
    steps: [{ args: ['setup'], stderr: 'strip-jq' }],
    files: ['repo/.claude/settings.json', 'repo/AGENTS.md'],
  });
});

test('parity: the state dir is git-ignored when it lives inside the repo (HERDR_AGENTS_DIR empty)', { timeout: 120000 }, (t) => {
  paritySetup(t, 'setup-gitignore', {
    steps: [{ args: ['setup'], env: { HERDR_AGENTS_DIR: '' } }],
    files: ['repo/.gitignore', 'repo/AGENTS.md'],
  });
});

test('parity: test-setup.sh scenario — the block embeds no absolute installer path (project-local skill resolves the hook)', { timeout: 120000 }, (t) => {
  const files = paritySetup(t, 'setup-no-abs-path', {
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
  for (const impl of ['bash', 'node']) {
    assert.ok(!files[impl]['repo/AGENTS.md'].includes(SKILL_DIR), `${impl}: AGENTS.md embeds the installer path`);
    assert.ok(!files[impl]['repo/.claude/settings.json'].includes(SKILL_DIR), `${impl}: settings.json embeds the installer path`);
  }
});

// Node-only: the unported forms exit 2 (entry message), and --probe --plan is
// refused with the bash exclusivity message. The bash side of these is the
// 7b/8 work, so no bash run here.
function runNode(args) {
  const fix = makeFixture();
  try {
    const r = runImpl('node', args, { env: fix.env, cwd: fix.repo });
    return { rc: r.rc, out: r.out, err: r.err };
  } finally {
    fix.cleanup();
  }
}

test('node: setup --detect/--plan/--probe are not ported yet (rc 2, citing the option)', () => {
  for (const opt of ['--detect', '--plan', '--probe']) {
    const r = runNode(['setup', opt]);
    assert.equal(r.rc, 2, `${opt}: exit code`);
    assert.equal(r.out, '', `${opt}: nothing on stdout`);
    assert.equal(normalizeErr(r.err).trimEnd(), `PROG: 'setup ${opt}' is not ported yet; use scripts/herdr-agents.sh`, `${opt}: message`);
  }
});

test('node: setup --probe --plan is exclusive (rc 2, the bash message)', () => {
  const r = runNode(['setup', '--probe', '--plan']);
  assert.equal(r.rc, 2);
  assert.equal(normalizeErr(r.err).trimEnd(), 'PROG: setup: --probe and --plan are exclusive');
});

// The `node` used for the node-side runs, referenced so a missing node is a
// loud failure here rather than in every scenario.
void nodeBin();
