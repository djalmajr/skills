// Golden (slice 9a-A): the `config` scenarios run only the JS
// (`node scripts/herdr-agents.mjs`) and compare against the value stored
// once in test/golden/parity-config.json (test/golden.mjs:
// HERDR_AGENTS_GOLDEN unset checks the JS value against the stored value, =update
// overwrites the stored value with the JS value for review). Covers `config`,
// `config set` (valid/invalid, --user, verbatim values, lane.roles),
// `session set/show/clear`, `roles`, `role` — 17 scenarios.
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFixture, normalizeErr, goldenScenario, runImpl } from './parity.mjs';
import { golden, normalizeRoots } from './golden.mjs';

// The fixture contract is POSIX (temporary git repo, POSIX path layout),
// so the scenarios are skipped on Windows.
const SKIP =
  process.platform === 'win32'
    ? 'Windows: the POSIX fixture contract needs a POSIX host'
    : false;

const SUITE = 'parity-config';

// The bundled skill root: the `roles`/`role` output points at the bundled
// role files, whose absolute path must not leak into the stored value.
const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Same value shape as goldenScenario (steps + files), but normalizes the
// skill root as well: only the roles scenarios point at it.
function configValue(opts) {
  const fix = makeFixture();
  try {
    fix.reset();
    if (opts.seed) opts.seed(fix);
    const steps = [];
    for (const step of opts.steps) {
      const stepEnv = step.env ? { ...fix.env, ...step.env } : fix.env;
      const r = runImpl(step.args, { env: stepEnv, cwd: fix.repo });
      steps.push({ args: step.args, rc: r.rc, out: r.out, err: normalizeErr(r.err) });
    }
    const readRel = (root, rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; } };
    const files = (opts.files ?? []).map((rel) => ({ rel, content: readRel(fix.root, rel) }));
    return normalizeRoots({ steps, files }, { '<ROOT>': fix.root, '<SKILL>': SKILL_ROOT });
  } finally {
    fix.cleanup();
  }
}

function configScenario(name, opts) {
  let value;
  const actual = () => (value !== undefined ? value : (value = configValue(opts))); // check/update
  golden(SUITE, name, actual);
  return actual();
}

function seedProj(text) {
  return (fix) => {
    fs.mkdirSync(path.join(fix.repo, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(fix.repo, '.agents', 'herdr-agents.conf'), text);
  };
}

const SEED_PROJ = [
  '# keep this comment',
  'max_workers=3 # live cap',
  '# tail comment',
  'reuse_workers=on',
  '',
  'max_workers=1',
  '',
].join('\n');

test('parity: config on a fresh repo', { timeout: 120000, skip: SKIP }, () => {
  goldenScenario(SUITE, 'config-fresh', {
    steps: [{ args: ['config'] }],
  });
});

test('parity: config set creates the project file', { timeout: 120000, skip: SKIP }, () => {
  goldenScenario(SUITE, 'config-set-fresh', {
    steps: [{ args: ['config', 'set', 'max_workers', '5'] }],
    files: ['repo/.agents/herdr-agents.conf'],
  });
});

test('parity: config set preserves comments, collapses duplicates, appends', { timeout: 120000, skip: SKIP }, () => {
  goldenScenario(SUITE, 'config-set-rewrite', {
    seed: seedProj(SEED_PROJ),
    steps: [
      { args: ['config', 'set', 'max_workers', '7'] },
      { args: ['config', 'set', 'multi_role', 'on'] },
      { args: ['config'] },
    ],
    files: ['repo/.agents/herdr-agents.conf'],
  });
});

test('parity: dotted keys (role/lane/model) are written', { timeout: 120000, skip: SKIP }, () => {
  goldenScenario(SUITE, 'config-set-dotted', {
    seed: seedProj('# seed\n'),
    steps: [
      { args: ['config', 'set', 'role.reviewer.kind', 'grok'] },
      { args: ['config', 'set', 'role.build.kind', 'pi'] },
      { args: ['config', 'set', 'lane.build.kind', 'opencode'] },
      { args: ['config', 'set', 'model.opencode.worker', 'my-provider/my-model'] },
      { args: ['config'] },
    ],
    files: ['repo/.agents/herdr-agents.conf'],
  });
});

test('parity: invalid keys/values refuse with rc 2 and leave the file alone', { timeout: 120000, skip: SKIP }, () => {
  goldenScenario(SUITE, 'config-set-invalid', {
    seed: seedProj(SEED_PROJ),
    steps: [
      { args: ['config', 'set', 'nope', '1'] },
      { args: ['config', 'set', 'max_workers', '-1'] },
      { args: ['config', 'set', 'multi_role', 'yes'] },
      { args: ['config', 'set', 'role.reviewer.kind', 'notepad'] },
      { args: ['config', 'set', 'feedback_repo', 'org/repo#frag'] },
      { args: ['config', 'set', 'approvals', 'FULL'] },
      { args: ['config', 'set'] },
      { args: ['config', 'set', 'a', 'b', 'c'] },
      { args: ['config', 'set', 'max_workers', '5', '--bogus'] },
    ],
    files: ['repo/.agents/herdr-agents.conf'],
  });
});

test('parity: --user writes the user file, not the project file', { timeout: 120000, skip: SKIP }, () => {
  goldenScenario(SUITE, 'config-set-user', {
    seed: seedProj(SEED_PROJ),
    steps: [
      { args: ['config', 'set', 'reuse_workers', 'off', '--user'] },
      { args: ['config'] },
    ],
    files: ['conf/herdr-agents/config', 'repo/.agents/herdr-agents.conf'],
  });
});

test('parity: values reach the file verbatim (backslashes, no key injection)', { timeout: 120000, skip: SKIP }, () => {
  goldenScenario(SUITE, 'config-set-verbatim', {
    seed: seedProj('# seed\n'),
    steps: [
      { args: ['config', 'set', 'model.claude.worker', 'claude-opus-4\\.[0-9]'] },
      { args: ['config', 'set', 'herd_label', 'ok\\nrole.reviewer.kind=grok'] },
      { args: ['config'] },
    ],
    files: ['repo/.agents/herdr-agents.conf'],
  });
});

test('parity: lane.<name>.roles validates the roles', { timeout: 120000, skip: SKIP }, () => {
  goldenScenario(SUITE, 'config-set-lane-roles', {
    seed: seedProj('# seed\n'),
    steps: [
      { args: ['config', 'set', 'lane.build.roles', 'implementer,designer'] },
      { args: ['config', 'set', 'lane.build.roles', 'nosuchrole'] },
    ],
    files: ['repo/.agents/herdr-agents.conf'],
  });
});

test('parity: session set writes the layer and config shows source session', { timeout: 120000, skip: SKIP }, () => {
  goldenScenario(SUITE, 'session-set', {
    steps: [
      { args: ['session', 'set', 'lane.build.kind', 'pi'] },
      { args: ['config'] },
      { args: ['session', 'show'] },
    ],
    files: ['state/ws/session.conf'],
  });
});

test('parity: session clear drops one key, then removes the layer', { timeout: 120000, skip: SKIP }, () => {
  goldenScenario(SUITE, 'session-clear', {
    seed: (fix) => {
      fs.mkdirSync(path.join(fix.repo, '.agents'), { recursive: true });
      fs.writeFileSync(path.join(fix.repo, '.agents', 'herdr-agents.conf'), 'lane.build.kind=codex\n');
    },
    steps: [
      { args: ['session', 'set', 'lane.build.kind', 'pi'] },
      { args: ['session', 'set', 'lane.review.kind', 'codex'] },
      { args: ['session', 'clear', 'lane.build.kind'] },
      { args: ['config'] },
      { args: ['session', 'clear'] },
      { args: ['config'] },
      { args: ['session', 'show'] },
    ],
    files: ['state/ws/session.conf'],
  });
});

test('parity: session errors (bad subcommand/key/value, usage) leave the file alone', { timeout: 120000, skip: SKIP }, () => {
  goldenScenario(SUITE, 'session-errors-seeded', {
    seed: (fix) => {
      fs.mkdirSync(path.join(fix.state, 'ws'), { recursive: true });
      fs.writeFileSync(path.join(fix.state, 'ws', 'session.conf'), 'lane.build.kind=pi\n');
    },
    steps: [
      { args: ['session', 'bogus'] },
      { args: ['session', 'set', 'nope', '1'] },
      { args: ['session', 'set', 'max_workers', '-1'] },
      { args: ['session', 'clear', 'a', 'b'] },
      { args: ['session', 'clear', 'nope'] },
    ],
    files: ['state/ws/session.conf'],
  });
});

test('parity: env beats session; session beats project', { timeout: 120000, skip: SKIP }, () => {
  goldenScenario(SUITE, 'precedence', {
    seed: (fix) => {
      fs.mkdirSync(path.join(fix.repo, '.agents'), { recursive: true });
      fs.writeFileSync(path.join(fix.repo, '.agents', 'herdr-agents.conf'), 'lane.build.kind=codex\n');
    },
    steps: [
      { args: ['session', 'set', 'lane.build.kind', 'pi'] },
      { args: ['config'] },
      { args: ['config'], env: { HERDR_AGENTS_LANE_BUILD_KIND: 'grok' } },
    ],
  });
});

test('parity: without a resolvable workspace set refuses, config still works', { timeout: 120000, skip: SKIP }, () => {
  goldenScenario(SUITE, 'no-workspace', {
    steps: [
      { args: ['session', 'set', 'lane.build.kind', 'pi'], env: { HERDR_WORKSPACE_ID: '' } },
      { args: ['config'], env: { HERDR_WORKSPACE_ID: '' } },
    ],
    files: ['state/ws/session.conf'],
  });
});

test('parity: roles table and role JSON (including errors)', { timeout: 120000, skip: SKIP }, () => {
  configScenario('roles-role', {
    steps: [
      { args: ['roles'] },
      { args: ['role', 'implementer'] },
      { args: ['role', 'ui-reviewer'] },
      { args: ['role', 'nosuchrole'] },
      { args: ['role'] },
    ],
  });
});

test('parity: a project role dir shadows the skill role', { timeout: 120000, skip: SKIP }, () => {
  configScenario('project-roles', {
    seed: (fix) => {
      const d = path.join(fix.repo, '.agents', 'herdr-roles');
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'implementer.md'), [
        '---',
        'name: implementer',
        'kind: claude',
        'effort: low',
        'mode: edit',
        '---',
        'project override',
        '',
      ].join('\n'));
    },
    steps: [
      { args: ['roles'] },
      { args: ['role', 'implementer'] },
    ],
  });
});

test('parity: relative state dir keeps the .gitignore entry current (state_root side effect)', { timeout: 120000, skip: SKIP }, () => {
  goldenScenario(SUITE, 'state-gitignore', {
    steps: [
      // HERDR_AGENTS_DIR emptied: the state dir resolves relative (cfg state_dir .herdr-agents).
      { args: ['session', 'set', 'max_workers', '7'], env: { HERDR_AGENTS_DIR: '' } },
      { args: ['session', 'show'], env: { HERDR_AGENTS_DIR: '' } },
      { args: ['session', 'set', 'max_workers', '8'], env: { HERDR_AGENTS_DIR: '' } },
    ],
    files: ['repo/.gitignore', 'repo/.herdr-agents/ws/session.conf'],
  });
});

test('parity: bare `session` shows the empty-session message', { timeout: 120000, skip: SKIP }, () => {
  goldenScenario(SUITE, 'session-bare-show', {
    steps: [{ args: ['session'] }],
  });
});
