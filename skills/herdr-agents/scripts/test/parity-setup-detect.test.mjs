// Parity (slice 7b): `setup --detect` run against
// `bash scripts/herdr-agents.sh` and `node scripts/herdr-agents.mjs` in an
// identical fixture must produce identical stdout, exit code and
// (prefix-normalized) stderr. Scenarios: the test-detect-custom.sh cases
// (pi + opencode provider files with secrets that never leave the output,
// a malformed models.json, and no provider files at all), no agent CLI on
// the PATH, custom lanes, role.<r>.kind and model.<kind>.worker in
// different layers, and the $OPENCODE_CONFIG file. The PATH is fully
// controlled (as in test-detect-custom.sh): fake agent CLIs, symlinks to
// the host jq/git and a `timeout` shim — no host CLI can leak in.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeFixture, runImpl, normalizeErr } from './parity.mjs';
import { findExecutable } from '../lib/platform.mjs';

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

const HAS_JQ = Boolean(findExecutable('jq'));
const SKIP = HAS_JQ ? false : 'jq is required for the bash parity run';

// Write the host jq/git symlinks, the `timeout` shim (bash pipelines
// `timeout <s> <cli>`; JS runCli times out on its own) and the requested
// fake agent CLIs into <fixture>/fakes. Returns the fakes dir.
function seedFakes(fix, agents = []) {
  const fakes = path.join(fix.root, 'fakes');
  // The seed runs once per implementation (the fixture reset does not touch
  // the fakes dir): start from a clean directory.
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

// Like parityScenario, but returns the per-implementation results so the
// caller can make extra assertions on the node output.
function parityDetect(name, opts) {
  const fix = makeFixture();
  let bashRes;
  let nodeRes;
  try {
    for (const impl of ['bash', 'node']) {
      fix.reset();
      if (opts.seed) opts.seed(fix);
      const results = [];
      for (const step of opts.steps) {
        const stepEnv = step.env ? { ...fix.env, ...step.env } : fix.env;
        results.push(runImpl(impl, step.args, { env: stepEnv, cwd: fix.repo }));
      }
      if (impl === 'bash') bashRes = results;
      else nodeRes = results;
    }
  } finally {
    fix.cleanup();
  }
  assert.equal(nodeRes.length, bashRes.length, `${name}: step count`);
  for (let i = 0; i < bashRes.length; i++) {
    const where = `${name}: step ${i + 1} (${opts.steps[i].args.join(' ')})`;
    assert.equal(nodeRes[i].rc, bashRes[i].rc, `${where}: exit code (bash=${bashRes[i].rc} node=${nodeRes[i].rc})`);
    assert.equal(nodeRes[i].out, bashRes[i].out, `${where}: stdout (node output first)`);
    assert.equal(normalizeErr(nodeRes[i].err), normalizeErr(bashRes[i].err), `${where}: stderr normalized`);
  }
  return { bash: bashRes, node: nodeRes };
}

// The fully controlled PATH (test-detect-custom.sh pattern): the fakes dir
// (jq/git symlinks + timeout shim + the agent fakes) then the system dirs —
// no host agent CLI can leak in. The getter resolves after the seed ran.
// OPENCODE_CONFIG is pinned to "" (unset in both implementations) so a host
// value can never point the runs at the operator's real config file.
const ctrlPath = (st) => ({ get PATH() { return `${st.fakes}:/usr/bin:/bin`; }, OPENCODE_CONFIG: '' });

test('parity: setup --detect with the custom provider files (test-detect-custom.sh)', { timeout: 120000, skip: SKIP }, (t) => {
  void t;
  const st = { fakes: '' };
  const res = parityDetect('detect-custom', {
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
  const r = res.node[0];
  assert.equal(r.rc, 0, 'detect exits 0');
  for (const secret of [...SECRETS, 'SECOND_KEY']) {
    assert.ok(!r.out.includes(secret), `the output must not contain ${secret}`);
  }
  const doc = JSON.parse(r.out);
  const kind = (k) => doc.kinds.find((x) => x.kind === k);
  assert.equal(kind('pi').installed, true);
  assert.deepEqual(kind('pi').custom_models, [
    { id: 'my-provider/my-model', max_effort: 'max' },
    { id: 'my-provider/plain', max_effort: '' },
    { id: 'second/cheap-fast', max_effort: '' },
  ]);
  assert.deepEqual(kind('opencode').custom_models.map((e) => e.id), [
    'proj-provider/proj-model', 'shared/shared-model', 'user-provider/user-model',
  ]);
  assert.deepEqual(kind('grok').custom_models, []);
  // Three newest models per CLI-backed kind (the bash version_sort_desc |
  // head -3, the short timeout, no cache).
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

test('parity: setup --detect with a malformed pi models.json degrades to []', { timeout: 120000, skip: SKIP }, (t) => {
  void t;
  const st = { fakes: '' };
  const res = parityDetect('detect-bad-pi', {
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
  const doc = JSON.parse(res.node[0].out);
  assert.equal(res.node[0].rc, 0, 'a malformed file is not a failure');
  assert.deepEqual(doc.kinds.find((k) => k.kind === 'pi').custom_models, []);
  // The opencode files are fine: their models still show up.
  assert.deepEqual(doc.kinds.find((k) => k.kind === 'opencode').custom_models.map((e) => e.id), [
    'proj-provider/proj-model', 'shared/shared-model', 'user-provider/user-model',
  ]);
});

test('parity: setup --detect with no agent CLI on the PATH and no provider files', { timeout: 120000, skip: SKIP }, (t) => {
  void t;
  const st = { fakes: '' };
  const res = parityDetect('detect-bare', {
    seed: (fix) => {
      st.fakes = seedFakes(fix);
      fs.rmSync(path.join(fix.home, '.pi'), { recursive: true, force: true });
      fs.rmSync(path.join(fix.repo, 'opencode.json'), { force: true });
      fs.rmSync(path.join(fix.conf, 'opencode'), { recursive: true, force: true });
    },
    steps: [{ args: ['setup', '--detect'], env: ctrlPath(st) }],
  });
  const doc = JSON.parse(res.node[0].out);
  assert.equal(res.node[0].rc, 0);
  for (const k of doc.kinds) {
    assert.equal(k.installed, false, `${k.kind} must not be installed`);
    assert.deepEqual(k.models, [], `${k.kind} has no model list`);
    assert.deepEqual(k.custom_models, [], `${k.kind} has no custom models`);
  }
  assert.equal(doc.recommended_reviewer, null, 'no installed kind: no reviewer');
});

test('parity: setup --detect with custom lanes', { timeout: 120000, skip: SKIP }, (t) => {
  void t;
  const st = { fakes: '' };
  const res = parityDetect('detect-lanes', {
    seed: (fix) => {
      st.fakes = seedFakes(fix, ['pi', 'grok']);
      fs.mkdirSync(path.join(fix.repo, '.agents'), { recursive: true });
      fs.writeFileSync(path.join(fix.repo, '.agents', 'herdr-agents.conf'),
        'lane.build.roles=implementer,designer\nlane.build.kind=codex\nlane.review.roles=reviewer\n');
    },
    steps: [{ args: ['setup', '--detect'], env: ctrlPath(st) }],
  });
  const doc = JSON.parse(res.node[0].out);
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

test('parity: setup --detect with role.<r>.kind and model.<kind>.worker in different layers', { timeout: 120000, skip: SKIP }, (t) => {
  void t;
  const st = { fakes: '' };
  const res = parityDetect('detect-layers', {
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
      },
    }],
  });
  const doc = JSON.parse(res.node[0].out);
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

test('parity: setup --detect with the $OPENCODE_CONFIG file between project and user', { timeout: 120000, skip: SKIP }, (t) => {
  void t;
  const st = { fakes: '', ocFile: '' };
  const res = parityDetect('detect-oc-env', {
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
      },
    }],
  });
  const doc = JSON.parse(res.node[0].out);
  assert.ok(!res.node[0].out.includes('ENVSECRET555'), 'the $OPENCODE_CONFIG file keeps its secret');
  assert.deepEqual(doc.kinds.find((k) => k.kind === 'opencode').custom_models.map((e) => e.id), [
    'pp/pm', 'pp/dup', 'sp/sm', 'pp/em', 'pp/xm',
  ]);
});
