// Golden (slice 9a-B; slice 7b scenario coverage): `setup --detect` runs
// only the JS and compares against the record in
// test/golden/parity-setup-detect.json (test/golden.mjs:
// HERDR_AGENTS_GOLDEN unset checks, =update overwrites the JS value for
// review). Scenarios: the test-detect-custom.sh cases (pi + opencode
// provider files with secrets that never leave the output, a malformed
// models.json, and no provider files at all), no agent CLI on the PATH,
// custom lanes, role.<r>.kind and model.<kind>.worker in different
// layers, and the $OPENCODE_CONFIG file. The recorded value holds, per
// step: the exit code, stdout and the prefix-normalized stderr.
// The PATH is fully controlled (as in test-detect-custom.sh): fake agent
// CLIs, symlinks to the host jq/git and a `timeout` shim — no host CLI can
// leak in. The fixture root becomes <ROOT> in every string of the recorded
// value; each scenario builds its own fixture from the same seed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeFixture, runImpl, normalizeErr } from './parity.mjs';
import { golden, normalizeRoots } from './golden.mjs';
import { findExecutable } from '../lib/platform.mjs';

// Check mode runs the JS against the record and is skipped solely on
// Windows: the fixture contract (the symlinks, the POSIX PATH) needs a
// POSIX host.
const SKIP =
  process.platform === 'win32'
    ? 'Windows: the POSIX fixture contract needs a POSIX host'
    : false;

const SUITE = 'parity-setup-detect';

// The provider files of test-detect-custom.sh, with the secrets that must
// never appear in the output.
const PI_JSON = `{
  "providers": {
    "my-provider": {
      "api": "openai-completions",
      "baseUrl": "https://api.my-provider.example/v1",
      "apiKey": "sk-live-PISECRET987654321",
      "headers": { "X-Auth": "header-secret-value" },
      "models": [
        {
          "id": "my-model",
          "name": "My Model",
          "reasoning": true,
          "contextWindow": 200000,
          "thinkingLevelMap": {
            "off": null, "minimal": null, "low": "low",
            "medium": null, "high": "high", "xhigh": "xhigh", "max": "max"
          }
        },
        { "id": "plain", "thinkingLevelMap": null }
      ]
    },
    "second": {
      "apiKey": "{env:SECOND_KEY}",
      "models": [ { "id": "cheap-fast" } ]
    }
  }
}
`;
const OC_PROJECT = `{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "proj-provider": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "apiKey": "{env:PROJ_KEY}", "baseURL": "https://proj.example/v1" },
      "models": { "proj-model": { "name": "Proj Model" } }
    },
    "shared": {
      "options": { "apiKey": "sk-test-OPENSECRET42" },
      "models": { "shared-model": { "name": "Shared" } }
    }
  }
}
`;
const OC_XDG = `{
  "provider": {
    "user-provider": {
      "options": { "apiKey": "sk-live-USERSECRET111" },
      "models": { "user-model": { "name": "User Model" } }
    }
  }
}
`;
const CODEX_JSON = JSON.stringify({
  models: [
    { slug: 'gpt-5', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'xhigh' }] },
    { slug: 'gpt-5.1', supported_reasoning_levels: [{ effort: 'medium' }] },
    { slug: 'codex-astra', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }] },
  ],
});

const SECRETS = ['PISECRET987654321', 'OPENSECRET42', 'USERSECRET111', 'header-secret-value'];

// Write the host jq/git symlinks, a `timeout` shim (inert fixture
// leftovers of the old two-sided layout; the JS run times out on its own)
// and the requested fake agent CLIs into <fixture>/fakes. Returns the
// fakes dir.
function seedFakes(fix, agents = []) {
  const fakes = path.join(fix.root, 'fakes');
  // The seed runs once per run (the fixture is fresh): start from a clean
  // directory.
  fs.rmSync(fakes, { recursive: true, force: true });
  fs.mkdirSync(fakes, { recursive: true });
  for (const name of ['jq', 'git']) {
    const real = findExecutable(name);
    if (real) fs.symlinkSync(real, path.join(fakes, name));
  }
  const fake = (name, lines) => fs.writeFileSync(path.join(fakes, name), lines.join('\n') + '\n', { mode: 0o755 });
  fake('timeout', ['#!/bin/sh', 'shift', 'exec "$@"']);
  for (const a of agents) {
    if (a === 'pi') fake('pi', ['#!/bin/sh', 'exit 0']);
    if (a === 'grok') fake('grok', [
      '#!/bin/sh',
      'if [ "$1" = "models" ]; then',
      '  printf "%s\\n" "Available models:" "grok-4.7 - xAI Grok 4.7 (default)" "grok-4.7-build-fast - quick variant" "grok-4.6 - older release"',
      'fi',
    ]);
    if (a === 'cursor-agent') fake('cursor-agent', [
      '#!/bin/sh',
      'if [ "$1" = "--list-models" ]; then',
      '  printf "%s\\n" "grok-4.7-max - xAI Grok 4.7 (max)" "grok-4.7-high - xAI Grok 4.7 (high)" "grok-4.6 - xAI Grok 4.6" "claude-opus-4-8-max - Anthropic Claude Opus 4.8 (max)"',
      'fi',
    ]);
    if (a === 'agy') fake('agy', [
      '#!/bin/sh',
      'if [ "$1" = "models" ]; then',
      '  printf "%s\\n" "gemini-3.8-flash  Google Gemini 3.8 Flash" "gemini-3.8-flash-high  Google Gemini 3.8 Flash (high)" "claude-opus-4-6  Anthropic Claude Opus 4.6" "gpt-oss-120b  OpenAI GPT-OSS 120B"',
      'fi',
    ]);
  }
  return fakes;
}

// The fully controlled PATH (test-detect-custom.sh pattern): the fakes dir
// (jq/git symlinks + timeout shim + the agent fakes) then the system dirs —
// no host agent CLI can leak in. The getter resolves after the seed ran.
// OPENCODE_CONFIG is pinned to "" (unset) so a host value can never point
// the runs at the operator's real config file. HERDR_AGENTS_MODELS_TIMEOUT
// is raised to 30 s so a fake CLI that answers slowly is not cut off by
// the 5 s detect default.
const ctrlPath = (st) => ({ get PATH() { return `${st.fakes}:/usr/bin:/bin`; }, OPENCODE_CONFIG: '', HERDR_AGENTS_MODELS_TIMEOUT: '30' });

// Run every step against the JS in a fresh fixture and return the golden
// value: rc, stdout and prefix-normalized stderr per step. The fixture
// root becomes <ROOT> in every string of the value.
function detectValue(opts) {
  const fix = makeFixture();
  try {
    fix.reset();
    if (opts.seed) opts.seed(fix);
    const results = [];
    for (const step of opts.steps) {
      const stepEnv = step.env ? { ...fix.env, ...step.env } : fix.env;
      const r = runImpl(step.args, { env: stepEnv, cwd: fix.repo });
      results.push({ args: step.args, rc: r.rc, out: r.out, err: normalizeErr(r.err) });
    }
    return normalizeRoots({ steps: results }, { '<ROOT>': fix.root });
  } finally {
    fix.cleanup();
  }
}

// Golden wrapper: the value is returned for the per-scenario assertions.
function detectScenario(name, opts) {
  let actValue;
  const actual = () => (actValue !== undefined ? actValue : (actValue = detectValue(opts)));
  golden(SUITE, name, actual);
  return actual();
}

test('parity: setup --detect with the custom provider files (test-detect-custom.sh)', { timeout: 120000, skip: SKIP }, () => {
  const st = { fakes: '' };
  const r = detectScenario('detect-custom', {
    seed: (fix) => {
      st.fakes = seedFakes(fix, ['pi', 'grok', 'cursor-agent', 'agy']);
      fs.mkdirSync(path.join(fix.home, '.pi', 'agent'), { recursive: true });
      fs.writeFileSync(path.join(fix.home, '.pi', 'agent', 'models.json'), PI_JSON);
      fs.mkdirSync(path.join(fix.home, '.codex'), { recursive: true });
      fs.writeFileSync(path.join(fix.home, '.codex', 'models_cache.json'), CODEX_JSON);
      fs.writeFileSync(path.join(fix.repo, 'opencode.json'), OC_PROJECT);
      fs.mkdirSync(path.join(fix.conf, 'opencode'), { recursive: true });
      fs.writeFileSync(path.join(fix.conf, 'opencode', 'opencode.json'), OC_XDG);
    },
    steps: [{ args: ['setup', '--detect'], env: ctrlPath(st) }],
  });
  const s = r.steps[0];
  assert.equal(s.rc, 0, 'detect exits 0');
  for (const secret of [...SECRETS, 'SECOND_KEY']) {
    assert.ok(!s.out.includes(secret), `the output must not contain ${secret}`);
  }
  const doc = JSON.parse(s.out);
  const kind = (k) => doc.kinds.find((x) => x.kind === k);
  assert.equal(kind('pi').installed, true);
  // Both providers carry a literal key by the pi rule (`{env:…}` is the
  // opencode reference form, not the pi `$…` one), so every custom model
  // gets the key warning; no maxTokens is declared, so no headroom
  // warning. The path is normalized to <ROOT> in the value.
  const piKeyWarn = (p) => `own provider '${p}' (pi) has a literal apiKey in <ROOT>/home/.pi/agent/models.json; use an environment reference (pi: "$MY_API_KEY", opencode: "{env:MY_API_KEY}")`;
  assert.deepEqual(kind('pi').custom_models, [
    { id: 'my-provider/my-model', max_effort: 'max', warnings: [piKeyWarn('my-provider')] },
    { id: 'my-provider/plain', max_effort: '', warnings: [piKeyWarn('my-provider')] },
    { id: 'second/cheap-fast', max_effort: '', warnings: [piKeyWarn('second')] },
  ]);
  assert.deepEqual(kind('opencode').custom_models.map((e) => e.id), [
    'proj-provider/proj-model', 'shared/shared-model', 'user-provider/user-model',
  ]);
  assert.deepEqual(kind('grok').custom_models, []);
  // Three newest models per CLI-backed kind (versionSortDesc, head 3,
  // the short timeout, no cache).
  assert.deepEqual(kind('grok').models, ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6']);
  assert.deepEqual(kind('cursor').models, ['claude-opus-4-8-max', 'grok-4.7-high', 'grok-4.7-max']);
  assert.deepEqual(kind('agy').models, ['gpt-oss-120b', 'claude-opus-4-6', 'gemini-3.8-flash']);
  // codex: no executable on the PATH (not installed) but the cache file lists.
  assert.equal(kind('codex').installed, false);
  assert.deepEqual(kind('codex').models, ['gpt-5.1', 'gpt-5', 'codex-astra']);
  // Reviewer suggestion: the build lane runs the implementer frontmatter
  // (grok, xai); codex/claude are not installed, grok is the build family —
  // agy (google) is the first installed other family.
  assert.deepEqual(doc.recommended_reviewer, { kind: 'agy', family: 'google', model: '' });
  assert.deepEqual(Object.keys(doc.config), ['max_workers', 'multi_role', 'reuse_workers', 'panes', 'lanes', 'effective_lanes', 'presets', 'role_kinds', 'worker_models']);
});

test('parity: setup --detect with a malformed pi models.json degrades to []', { timeout: 120000, skip: SKIP }, () => {
  const st = { fakes: '' };
  const r = detectScenario('detect-bad-pi', {
    seed: (fix) => {
      st.fakes = seedFakes(fix, ['pi', 'grok']);
      fs.mkdirSync(path.join(fix.home, '.pi', 'agent'), { recursive: true });
      fs.writeFileSync(path.join(fix.home, '.pi', 'agent', 'models.json'), 'not json');
      fs.writeFileSync(path.join(fix.repo, 'opencode.json'), OC_PROJECT);
      fs.mkdirSync(path.join(fix.conf, 'opencode'), { recursive: true });
      fs.writeFileSync(path.join(fix.conf, 'opencode', 'opencode.json'), OC_XDG);
    },
    steps: [{ args: ['setup', '--detect'], env: ctrlPath(st) }],
  });
  const s = r.steps[0];
  const doc = JSON.parse(s.out);
  assert.equal(s.rc, 0, 'a malformed file is not a failure');
  assert.deepEqual(doc.kinds.find((k) => k.kind === 'pi').custom_models, []);
  // The opencode files are fine: their models still show up.
  assert.deepEqual(doc.kinds.find((k) => k.kind === 'opencode').custom_models.map((e) => e.id), [
    'proj-provider/proj-model', 'shared/shared-model', 'user-provider/user-model',
  ]);
});

test('parity: setup --detect with no agent CLI on the PATH and no provider files', { timeout: 120000, skip: SKIP }, () => {
  const st = { fakes: '' };
  const r = detectScenario('detect-bare', {
    seed: (fix) => {
      st.fakes = seedFakes(fix);
      fs.rmSync(path.join(fix.home, '.pi'), { recursive: true, force: true });
      fs.rmSync(path.join(fix.repo, 'opencode.json'), { force: true });
      fs.rmSync(path.join(fix.conf, 'opencode'), { recursive: true, force: true });
    },
    steps: [{ args: ['setup', '--detect'], env: ctrlPath(st) }],
  });
  const s = r.steps[0];
  const doc = JSON.parse(s.out);
  assert.equal(s.rc, 0);
  for (const k of doc.kinds) {
    assert.equal(k.installed, false, `${k.kind} must not be installed`);
    assert.deepEqual(k.models, [], `${k.kind} has no model list`);
    assert.deepEqual(k.custom_models, [], `${k.kind} has no custom models`);
  }
  assert.equal(doc.recommended_reviewer, null, 'no installed kind: no reviewer');
});

test('parity: setup --detect with custom lanes', { timeout: 120000, skip: SKIP }, () => {
  const st = { fakes: '' };
  const r = detectScenario('detect-lanes', {
    seed: (fix) => {
      st.fakes = seedFakes(fix, ['pi', 'grok']);
      fs.mkdirSync(path.join(fix.repo, '.agents'), { recursive: true });
      fs.writeFileSync(path.join(fix.repo, '.agents', 'herdr-agents.conf'),
        'lane.build.roles=implementer,designer\nlane.build.kind=codex\nlane.review.roles=reviewer\n');
    },
    steps: [{ args: ['setup', '--detect'], env: ctrlPath(st) }],
  });
  const s = r.steps[0];
  const doc = JSON.parse(s.out);
  assert.deepEqual(doc.config.effective_lanes, [
    { name: 'build', roles: ['implementer', 'designer'], kind: 'codex', model: '', effort: '', approvals: '' },
    { name: 'review', roles: ['reviewer'], kind: '', model: '', effort: '', approvals: '' },
  ]);
  // The build lane pins codex (openai); grok (installed, xai) is the first
  // installed other family.
  assert.deepEqual(doc.recommended_reviewer, { kind: 'grok', family: 'xai', model: '' });
  // The preset tables are independent of the custom lanes.
  assert.deepEqual(doc.config.presets['4'].map((l) => l.name), ['build', 'explore', 'review']);
});

test('parity: setup --detect with role.<r>.kind and model.<kind>.worker in different layers', { timeout: 120000, skip: SKIP }, () => {
  const st = { fakes: '' };
  const r = detectScenario('detect-layers', {
    seed: (fix) => {
      st.fakes = seedFakes(fix, ['pi', 'grok']);
      fs.mkdirSync(path.join(fix.conf, 'herdr-agents'), { recursive: true });
      fs.writeFileSync(path.join(fix.conf, 'herdr-agents', 'config'), 'role.reviewer.kind=codex\n');
      fs.mkdirSync(path.join(fix.repo, '.agents'), { recursive: true });
      fs.writeFileSync(path.join(fix.repo, '.agents', 'herdr-agents.conf'),
        'role.implementer.kind=codex\nmodel.pi.worker=custom/pi-model\n');
    },
    steps: [{
      args: ['setup', '--detect'],
      // The getters resolve after the seed ran (st.fakes is set there); a
      // spread at step-definition time would capture the empty path.
      env: {
        get PATH() { return `${st.fakes}:/usr/bin:/bin`; },
        OPENCODE_CONFIG: '',
        HERDR_AGENTS_MODEL_GROK_WORKER: 'grok-4.7',
        HERDR_AGENTS_MODELS_TIMEOUT: '30',
      },
    }],
  });
  const s = r.steps[0];
  const doc = JSON.parse(s.out);
  const role = (k) => doc.config.role_kinds.find((e) => e.key === k);
  const model = (k) => doc.config.worker_models.find((e) => e.key === k);
  // User layer, project layer, the env layer and the role-file fallback.
  assert.deepEqual(role('role.reviewer.kind'), { key: 'role.reviewer.kind', value: 'codex', source: 'user' });
  assert.deepEqual(role('role.implementer.kind'), { key: 'role.implementer.kind', value: 'codex', source: 'project' });
  assert.deepEqual(role('role.scouter.kind'), { key: 'role.scouter.kind', value: 'grok', source: 'role' });
  assert.deepEqual(model('model.pi.worker'), { key: 'model.pi.worker', value: 'custom/pi-model', source: 'project' });
  assert.deepEqual(model('model.grok.worker'), { key: 'model.grok.worker', value: 'grok-4.7', source: 'env' });
  assert.deepEqual(model('model.claude.worker'), { key: 'model.claude.worker', value: 'opus', source: 'defaults' });
  assert.deepEqual(model('model.opencode.worker'), { key: 'model.opencode.worker', value: '', source: 'builtin' });
  // The implementer kind override (project layer) sets the build family to
  // openai; grok is the first installed other family.
  assert.deepEqual(doc.recommended_reviewer, { kind: 'grok', family: 'xai', model: '' });
});

test('parity: setup --detect with the $OPENCODE_CONFIG file between project and user', { timeout: 120000, skip: SKIP }, () => {
  const st = { fakes: '', ocFile: '' };
  const r = detectScenario('detect-oc-env', {
    seed: (fix) => {
      st.fakes = seedFakes(fix);
      st.ocFile = path.join(fix.root, 'oc-env.json');
      // The project file wins on the duplicate id "pp/dup"; the $OPENCODE_CONFIG
      // file is read next; the XDG user file last.
      fs.writeFileSync(path.join(fix.repo, 'opencode.json'), JSON.stringify({
        provider: {
          pp: { models: { pm: {}, dup: {} } },
          sp: { models: { sm: {} } },
        },
      }));
      fs.writeFileSync(st.ocFile, JSON.stringify({
        provider: { pp: { options: { apiKey: 'sk-live-ENVSECRET555' }, models: { dup: {}, em: {} } } },
      }));
      fs.mkdirSync(path.join(fix.conf, 'opencode'), { recursive: true });
      fs.writeFileSync(path.join(fix.conf, 'opencode', 'opencode.json'), JSON.stringify({
        provider: { pp: { models: { dup: {}, xm: {} } } },
      }));
    },
    steps: [{
      args: ['setup', '--detect'],
      env: {
        get PATH() { return `${st.fakes}:/usr/bin:/bin`; },
        get OPENCODE_CONFIG() { return st.ocFile; },
        HERDR_AGENTS_MODELS_TIMEOUT: '30',
      },
    }],
  });
  const s = r.steps[0];
  const doc = JSON.parse(s.out);
  assert.ok(!s.out.includes('ENVSECRET555'), 'the $OPENCODE_CONFIG file keeps its secret');
  assert.deepEqual(doc.kinds.find((k) => k.kind === 'opencode').custom_models.map((e) => e.id), [
    'pp/pm', 'pp/dup', 'sp/sm', 'pp/em', 'pp/xm',
  ]);
});
