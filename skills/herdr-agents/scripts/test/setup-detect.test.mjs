// setup --detect (slice 7b): unit tests for lib/commands/setup-detect.mjs —
// the custom-provider readers (pi ~/.pi/agent/models.json, opencode.json in
// project/$OPENCODE_CONFIG/user, secrets never in the output, malformed
// files and CRLF), the reviewer policy, the effective build family, the top
// models listing (short timeout, no cache) and the JSON document shape.
// Each test file builds its own temp root (mkdtemp) used as HOME,
// XDG_CONFIG_HOME, TMPDIR and HERDR_AGENTS_DIR, with a temporary git repo
// (brief decision); nothing here touches a real herdr or agent CLI — the
// fake CLIs come from scripts/test/fakes.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeFakeCli, listingFake } from './fakes.mjs';
import { loadConfig } from '../lib/config.mjs';
import {
  piCustomModelsJson, opencodeCustomModelsJson, effectiveBuildFamily,
  recommendReviewerJson, detectTopModels, detectKindJson,
  detectRoleKindsJson, detectWorkerModelsJson, setupDetectJson,
} from '../lib/commands/setup-detect.mjs';

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// Isolated root: temp HOME / XDG_CONFIG_HOME / TMPDIR / HERDR_AGENTS_DIR and
// a git repo as cwd. The env carries no PATH: no host CLI can leak in.
function isoRoot(prefix) {
  const root = tmp(prefix);
  for (const d of ['repo/.agents', 'home', 'conf', 'tmp', 'state']) fs.mkdirSync(path.join(root, d), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: path.join(root, 'repo'), stdio: 'ignore' });
  const env = {
    HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'conf'),
    TMPDIR: path.join(root, 'tmp'),
    HERDR_AGENTS_DIR: path.join(root, 'state'),
    HERDR_WORKSPACE_ID: 'ws-test',
    PATH: path.join(root, 'no-such-dir'),
  };
  return {
    root,
    repo: path.join(root, 'repo'),
    home: path.join(root, 'home'),
    conf: path.join(root, 'conf'),
    env,
    userConf: path.join(root, 'conf', 'herdr-agents', 'config'),
    projectConf: path.join(root, 'repo', '.agents', 'herdr-agents.conf'),
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

const write = (p, content) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };

// The pi models.json of test-detect-custom.sh: one provider with secrets
// that must never appear, one model that declares reasoning levels (with
// nulls among them), one that declares none, and a second provider with an
// {env:…} key.
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

const piModelsFile = (root) => path.join(root.home, '.pi', 'agent', 'models.json');

test('piCustomModelsJson: provider/model ids + max declared level, no secrets (test-detect-custom.sh)', () => {
  const r = isoRoot('ha-detect-pi-');
  try {
    write(piModelsFile(r), PI_JSON);
    const out = piCustomModelsJson(r.env);
    assert.deepEqual(out, [
      { id: 'my-provider/my-model', max_effort: 'max' },
      { id: 'my-provider/plain', max_effort: '' },
      { id: 'second/cheap-fast', max_effort: '' },
    ]);
    const s = JSON.stringify(out);
    for (const secret of ['PISECRET987654321', 'SECOND_KEY', 'header-secret-value', 'api.my-provider.example']) {
      assert.ok(!s.includes(secret), `output must not contain ${secret}`);
    }
  } finally { r.cleanup(); }
});

test('piCustomModelsJson: missing file, no thinkingLevelMap, partial map, CRLF', () => {
  const r = isoRoot('ha-detect-pi2-');
  try {
    assert.deepEqual(piCustomModelsJson(r.env), [], 'no file -> []');
    write(piModelsFile(r), JSON.stringify({
      providers: {
        p: {
          models: [
            { id: 'a' }, // no thinkingLevelMap
            { id: 'b', thinkingLevelMap: {} }, // empty map
            { id: 'c', thinkingLevelMap: { low: 'low', medium: null, high: 'high' } }, // partial
            { id: 'd', thinkingLevelMap: { weird: 'x', other: 'y' } }, // unknown keys: rank 0
            { id: 'e', thinkingLevelMap: { low: 'low', xhigh: null, max: 'max', minimal: 'minimal' } },
          ],
        },
      },
    }));
    assert.deepEqual(piCustomModelsJson(r.env), [
      { id: 'p/a', max_effort: '' },
      { id: 'p/b', max_effort: '' },
      { id: 'p/c', max_effort: 'high' },
      { id: 'p/d', max_effort: '' },
      { id: 'p/e', max_effort: 'max' },
    ]);
    // CRLF-normalized: the same document with \r\n line endings.
    const crlf = fs.readFileSync(piModelsFile(r), 'utf8').replace(/\n/g, '\r\n');
    fs.writeFileSync(piModelsFile(r), crlf);
    assert.deepEqual(piCustomModelsJson(r.env), [
      { id: 'p/a', max_effort: '' },
      { id: 'p/b', max_effort: '' },
      { id: 'p/c', max_effort: 'high' },
      { id: 'p/d', max_effort: '' },
      { id: 'p/e', max_effort: 'max' },
    ]);
  } finally { r.cleanup(); }
});

test('piCustomModelsJson: malformed files and bad shapes degrade to []', () => {
  const r = isoRoot('ha-detect-pi3-');
  try {
    const f = piModelsFile(r);
    write(f, 'not json');
    assert.deepEqual(piCustomModelsJson(r.env), [], 'not json -> []');
    write(f, JSON.stringify({ providers: { p: { models: 'nope' } } }));
    assert.deepEqual(piCustomModelsJson(r.env), [], 'models not an array -> []');
    write(f, JSON.stringify({ providers: { p: { models: [42] } } }));
    assert.deepEqual(piCustomModelsJson(r.env), [], 'non-object model entry -> []');
    write(f, JSON.stringify({ providers: { p: { models: [{ id: 7 }] } } }));
    assert.deepEqual(piCustomModelsJson(r.env), [], 'non-string id -> []');
    write(f, JSON.stringify({ providers: { p: { models: [{ id: 'a', thinkingLevelMap: [1, 2] }] } } }));
    assert.deepEqual(piCustomModelsJson(r.env), [], 'non-object thinkingLevelMap -> []');
    write(f, JSON.stringify({ providers: 'nope' }));
    assert.deepEqual(piCustomModelsJson(r.env), [], 'providers not an object -> []');
    write(f, JSON.stringify([1]));
    assert.deepEqual(piCustomModelsJson(r.env), [], 'root array -> []');
    // Empty ids are skipped, not a failure.
    write(f, JSON.stringify({ providers: { p: { models: [{ id: '' }, { id: 'ok' }] } } }));
    assert.deepEqual(piCustomModelsJson(r.env), [{ id: 'p/ok', max_effort: '' }]);
  } finally { r.cleanup(); }
});

// The opencode fixtures of test-detect-custom.sh (project wins on the shared
// id) plus a $OPENCODE_CONFIG file, all full of secrets.
const OC_PROJECT = `{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "proj-provider": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "apiKey": "{env:PROJ_KEY}", "baseURL": "https://proj.example/v1" },
      "models": { "proj-model": { "name": "Proj Model" }, "shared": { "name": "Proj shared" } }
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
      "models": { "user-model": { "name": "User Model" }, "shared": { "name": "User shared" } }
    }
  }
}
`;
const OC_ENVFILE = JSON.stringify({
  provider: { envp: { options: { apiKey: 'sk-live-ENVSECRET555' }, models: { 'env-model': {} } } },
});

const ocProjectFile = (r) => path.join(r.repo, 'opencode.json');
const ocXdgFile = (r) => path.join(r.conf, 'opencode', 'opencode.json');

test('opencodeCustomModelsJson: project + $OPENCODE_CONFIG + user, project wins, no secrets (test-detect-custom.sh)', () => {
  const r = isoRoot('ha-detect-oc-');
  try {
    write(ocProjectFile(r), OC_PROJECT);
    write(ocXdgFile(r), OC_XDG);
    const ocFile = path.join(r.root, 'oc-env.json');
    write(ocFile, OC_ENVFILE);
    const out = opencodeCustomModelsJson({ ...r.env, OPENCODE_CONFIG: ocFile }, r.repo);
    assert.deepEqual(out, [
      { id: 'proj-provider/proj-model', max_effort: '' },
      { id: 'proj-provider/shared', max_effort: '' },
      { id: 'shared/shared-model', max_effort: '' },
      { id: 'envp/env-model', max_effort: '' },
      { id: 'user-provider/user-model', max_effort: '' },
      { id: 'user-provider/shared', max_effort: '' },
    ]);
    // The $OPENCODE_CONFIG file sits between the project and the XDG file.
    const s = JSON.stringify(out);
    for (const secret of ['PROJ_KEY', 'OPENSECRET42', 'USERSECRET111', 'ENVSECRET555', 'proj.example']) {
      assert.ok(!s.includes(secret), `output must not contain ${secret}`);
    }
    // A true duplicate id: the same provider/model declared in the user file
    // is dropped — the project file (read first) wins.
    write(ocXdgFile(r), JSON.stringify({ provider: { 'proj-provider': { options: { apiKey: 'sk-live-DUP77' }, models: { shared: { name: 'Dup' } } } } }));
    const dup = opencodeCustomModelsJson(r.env, r.repo); // no OPENCODE_CONFIG
    assert.deepEqual(dup.map((e) => e.id), ['proj-provider/proj-model', 'proj-provider/shared', 'shared/shared-model'], 'project wins on duplicate id');
    assert.ok(!JSON.stringify(dup).includes('DUP77'));
  } finally { r.cleanup(); }
});

test('opencodeCustomModelsJson: no files, malformed files, CRLF, missing provider sections', () => {
  const r = isoRoot('ha-detect-oc2-');
  try {
    assert.deepEqual(opencodeCustomModelsJson(r.env, r.repo), [], 'no files -> []');
    const f = ocProjectFile(r);
    write(f, 'not json');
    write(ocXdgFile(r), OC_XDG);
    assert.deepEqual(opencodeCustomModelsJson(r.env, r.repo).map((e) => e.id), ['user-provider/user-model', 'user-provider/shared'], 'malformed project file is skipped, the user file still contributes');
    fs.rmSync(f);
    write(ocXdgFile(r), '{ broken');
    assert.deepEqual(opencodeCustomModelsJson(r.env, r.repo), [], 'all malformed -> []');
    // CRLF.
    write(f, OC_PROJECT.replace(/\n/g, '\r\n'));
    fs.rmSync(ocXdgFile(r));
    const crlf = opencodeCustomModelsJson(r.env, r.repo);
    assert.deepEqual(crlf.map((e) => e.id), ['proj-provider/proj-model', 'proj-provider/shared', 'shared/shared-model']);
    // No provider section / empty provider: valid, empty.
    write(f, JSON.stringify({ $schema: 'x' }));
    assert.deepEqual(opencodeCustomModelsJson(r.env, r.repo), []);
    // A provider without models keeps contributing nothing, no failure.
    write(f, JSON.stringify({ provider: { p: { options: { apiKey: 'sk-live-NOPE1' } } } }));
    const noModels = opencodeCustomModelsJson(r.env, r.repo);
    assert.deepEqual(noModels, []);
    assert.ok(!JSON.stringify(noModels).includes('NOPE1'));
  } finally { r.cleanup(); }
});

test('recommendReviewerJson: build of each family; not-installed kinds are not candidates', () => {
  const inst = {
    codex: { kind: 'codex', model: '' },
    claude: { kind: 'claude', model: '' },
    grok: { kind: 'grok', model: '' },
    agy: { kind: 'agy', model: '' },
    gemini: { kind: 'gemini', model: '' },
  };
  // Build family openai (codex build): codex is the same family, claude wins.
  assert.deepEqual(recommendReviewerJson('openai', [inst.codex, inst.claude, inst.grok]), { kind: 'claude', family: 'anthropic', model: '' });
  // Build family anthropic: claude same family, codex (policy order) wins.
  assert.deepEqual(recommendReviewerJson('anthropic', [inst.claude, inst.codex, inst.grok]), { kind: 'codex', family: 'openai', model: '' });
  // Build family xai (grok/cursor build): claude wins over grok/agy/gemini.
  assert.deepEqual(recommendReviewerJson('xai', [inst.grok, inst.agy, inst.gemini, inst.claude]), { kind: 'claude', family: 'anthropic', model: '' });
  // Build family google: codex first, then claude.
  assert.deepEqual(recommendReviewerJson('google', [inst.agy, inst.claude]), { kind: 'claude', family: 'anthropic', model: '' });
  // Policy order beats the eligible-list order: claude before grok.
  assert.deepEqual(recommendReviewerJson('xai', [inst.grok, inst.claude]), { kind: 'claude', family: 'anthropic', model: '' });
  // Unknown build family: the first eligible known kind.
  assert.deepEqual(recommendReviewerJson('unknown', [inst.grok]), { kind: 'grok', family: 'xai', model: '' });
  assert.deepEqual(recommendReviewerJson('', [inst.grok]), { kind: 'grok', family: 'xai', model: '' });
  // Nothing eligible, or only the build family: null.
  assert.equal(recommendReviewerJson('openai', []), null, 'no installed kind');
  assert.equal(recommendReviewerJson('xai', [inst.grok]), null, 'only the build family');
  assert.deepEqual(recommendReviewerJson('anthropic', [inst.agy, inst.gemini, inst.grok, inst.gemini]), { kind: 'grok', family: 'xai', model: '' }, 'duplicates deduped');
  // by-model kinds: the configured model decides the family.
  assert.deepEqual(recommendReviewerJson('openai', [{ kind: 'pi', model: 'openrouter/anthropic/claude-3' }]), { kind: 'pi', family: 'anthropic', model: 'openrouter/anthropic/claude-3' });
  // pi/cursor/opencode with no recognizable model stay unknown: not candidates.
  assert.equal(recommendReviewerJson('openai', [{ kind: 'pi', model: '' }, { kind: 'cursor', model: '' }, { kind: 'opencode', model: 'x' }]), null);
});

test('effectiveBuildFamily: lane kind+model, role config, frontmatter, layer rule', () => {
  const r = isoRoot('ha-detect-fam-');
  try {
    const env = r.env;
    const ctx = loadConfig(env, r.repo);
    // No config: the implementer role's frontmatter (kind: grok) decides.
    assert.equal(effectiveBuildFamily(ctx, env, r.repo), 'xai');
    // Role config (user layer) beats the frontmatter.
    write(r.userConf, 'role.implementer.kind=pi\nrole.implementer.model=custom/claude-x\n');
    const ctxUser = loadConfig(env, r.repo);
    assert.equal(effectiveBuildFamily(ctxUser, env, r.repo), 'anthropic');
    // Lane kind + lane model (same layer) win over the role chain.
    write(r.projectConf, 'lane.build.kind=pi\nlane.build.model=custom/gpt-5\n');
    const ctxLane = loadConfig(env, r.repo);
    assert.equal(effectiveBuildFamily(ctxLane, env, r.repo), 'openai');
    // The layer rule: a lane model from a layer BELOW the lane kind is
    // ignored; with a by-model kind and no role model, the family is
    // unknown.
    write(r.userConf, 'lane.build.model=custom/gpt-5\n');
    write(r.projectConf, 'lane.build.kind=pi\n');
    const ctxLower = loadConfig(env, r.repo);
    assert.equal(effectiveBuildFamily(ctxLower, env, r.repo), 'unknown');
    // The same model declared in the SAME layer as the kind is used.
    write(r.projectConf, 'lane.build.kind=pi\nlane.build.model=custom/gpt-5\n');
    write(r.userConf, '');
    const ctxSameLayer = loadConfig(env, r.repo);
    assert.equal(effectiveBuildFamily(ctxSameLayer, env, r.repo), 'openai');
    // lane.build.kind with the model from the same layer: codex + own model
    // family rule (a codex model id is openai by kind, not by model).
    write(r.userConf, '');
    write(r.projectConf, 'lane.build.kind=codex\nlane.build.model=my-lab/claude-mimic\n');
    const ctxSame = loadConfig(env, r.repo);
    assert.equal(effectiveBuildFamily(ctxSame, env, r.repo), 'openai');
  } finally { r.cleanup(); }
});

test('detectTopModels: three newest of a fake listing, short timeout, no cache written', () => {
  const r = isoRoot('ha-detect-top-');
  try {
    const fakes = path.join(r.root, 'fakes');
    fs.mkdirSync(fakes, { recursive: true });
    writeFakeCli(fakes, 'grok', listingFake('models', [
      'Available models:',
      'grok-4.7 - xAI Grok 4.7 (default)',
      'grok-4.6 - older release',
      'grok-4.10 - the newest',
      'grok-3.9 - old',
    ]));
    const env = { ...r.env, PATH: fakes };
    assert.deepEqual(detectTopModels('grok', env), ['grok-4.10', 'grok-4.7', 'grok-4.6']);
    // The short timeout must not write the model cache.
    assert.equal(fs.existsSync(path.join(r.env.TMPDIR, 'herdr-agents-models-grok.txt')), false, 'no cache file');
    // A missing CLI yields [].
    assert.deepEqual(detectTopModels('grok', r.env), []);
  } finally { r.cleanup(); }
});

test('detectKindJson: installed/executable/family/ceiling/custom_models per kind', () => {
  const r = isoRoot('ha-detect-kind-');
  try {
    const fakes = path.join(r.root, 'fakes');
    fs.mkdirSync(fakes, { recursive: true });
    writeFakeCli(fakes, 'pi', 'process.exit(0);\n');
    const env = { ...r.env, PATH: fakes };
    write(piModelsFile(r), PI_JSON);
    const pi = detectKindJson('pi', env, r.repo);
    assert.deepEqual(pi, {
      kind: 'pi',
      executable: 'pi',
      installed: true,
      family: 'by model',
      effort_ceiling: 'max',
      models: [],
      summary: pi.summary,
      custom_models: [
        { id: 'my-provider/my-model', max_effort: 'max' },
        { id: 'my-provider/plain', max_effort: '' },
        { id: 'second/cheap-fast', max_effort: '' },
      ],
    });
    const cursor = detectKindJson('cursor', env, r.repo);
    assert.equal(cursor.executable, 'cursor-agent');
    assert.equal(cursor.installed, false);
    assert.equal(cursor.effort_ceiling, 'xhigh');
    const opencode = detectKindJson('opencode', env, r.repo);
    assert.equal(opencode.effort_ceiling, '');
    assert.deepEqual(opencode.custom_models, []);
    // A stable kind always has an empty custom_models array.
    assert.deepEqual(detectKindJson('grok', env, r.repo).custom_models, []);
    assert.deepEqual(detectKindJson('claude', env, r.repo).custom_models, []);
    // No PATH at all: nothing installed.
    assert.equal(detectKindJson('pi', r.env, r.repo).installed, false);
  } finally { r.cleanup(); }
});

test('detectRoleKindsJson: frontmatter, config overrides per layer, first dir wins', () => {
  const r = isoRoot('ha-detect-roles-');
  try {
    const ctx = loadConfig(r.env, r.repo);
    // Skill role files only: every source is "role", values from the frontmatter.
    const base = detectRoleKindsJson(ctx, r.env, r.repo);
    const impl = base.find((e) => e.key === 'role.implementer.kind');
    assert.deepEqual(impl, { key: 'role.implementer.kind', value: 'grok', source: 'role' });
    const sec = base.find((e) => e.key === 'role.security-reviewer.kind');
    assert.ok(sec, 'hyphenated role key present');
    assert.equal(sec.source, 'role');
    // A user-layer override wins; its source is "user".
    write(r.userConf, 'role.reviewer.kind=codex\n');
    const ctxUser = loadConfig(r.env, r.repo);
    const withUser = detectRoleKindsJson(ctxUser, r.env, r.repo);
    assert.deepEqual(withUser.find((e) => e.key === 'role.reviewer.kind'), { key: 'role.reviewer.kind', value: 'codex', source: 'user' });
    // An env var beats the user layer; source "env".
    const envExt = { ...r.env, HERDR_AGENTS_ROLE_TASKER_KIND: 'claude' };
    const ctxEnv = loadConfig(envExt, r.repo);
    const withEnv = detectRoleKindsJson(ctxEnv, envExt, r.repo);
    assert.deepEqual(withEnv.find((e) => e.key === 'role.tasker.kind'), { key: 'role.tasker.kind', value: 'claude', source: 'env' });
    // A project role dir shadows the skill dir per name (first dir wins);
    // the other names keep the skill files.
    const projRoles = path.join(r.repo, '.agents', 'herdr-roles');
    write(path.join(projRoles, 'implementer.md'), '---\nname: implementer\nkind: claude\n---\nbody\n');
    const shadowed = detectRoleKindsJson(ctx, r.env, r.repo);
    assert.deepEqual(shadowed.find((e) => e.key === 'role.implementer.kind'), { key: 'role.implementer.kind', value: 'claude', source: 'role' });
    assert.deepEqual(shadowed.find((e) => e.key === 'role.reviewer.kind'), { key: 'role.reviewer.kind', value: 'codex', source: 'role' });
    // A role whose config value is empty falls back to the frontmatter.
    write(r.userConf, 'role.reviewer.kind=\n');
    const ctxEmpty = loadConfig(r.env, r.repo);
    assert.deepEqual(detectRoleKindsJson(ctxEmpty, r.env, r.repo).find((e) => e.key === 'role.reviewer.kind'), { key: 'role.reviewer.kind', value: 'codex', source: 'role' });
  } finally { r.cleanup(); }
});

test('detectWorkerModelsJson: defaults, project override, env override, unset key', () => {
  const r = isoRoot('ha-detect-wm-');
  try {
    const base = detectWorkerModelsJson(loadConfig(r.env, r.repo), r.env);
    assert.equal(base.length, 8);
    assert.deepEqual(base.find((e) => e.key === 'model.claude.worker'), { key: 'model.claude.worker', value: 'opus', source: 'defaults' });
    assert.deepEqual(base.find((e) => e.key === 'model.codex.worker'), { key: 'model.codex.worker', value: 'sol|gpt-5', source: 'defaults' });
    // pi has no worker model default: empty value, source "builtin".
    assert.deepEqual(base.find((e) => e.key === 'model.pi.worker'), { key: 'model.pi.worker', value: '', source: 'builtin' });
    write(r.projectConf, 'model.pi.worker=custom/pi-model\n');
    const withProj = detectWorkerModelsJson(loadConfig(r.env, r.repo), r.env);
    assert.deepEqual(withProj.find((e) => e.key === 'model.pi.worker'), { key: 'model.pi.worker', value: 'custom/pi-model', source: 'project' });
    const withEnv = detectWorkerModelsJson(loadConfig({ ...r.env, HERDR_AGENTS_MODEL_GROK_WORKER: 'grok-4.7' }, r.repo), { ...r.env, HERDR_AGENTS_MODEL_GROK_WORKER: 'grok-4.7' });
    assert.deepEqual(withEnv.find((e) => e.key === 'model.grok.worker'), { key: 'model.grok.worker', value: 'grok-4.7', source: 'env' });
  } finally { r.cleanup(); }
});

test('setupDetectJson: the bash key order and the preset/effective lanes defaults', () => {
  const r = isoRoot('ha-detect-shape-');
  try {
    const doc = setupDetectJson(loadConfig(r.env, r.repo), r.env, r.repo);
    assert.deepEqual(Object.keys(doc), ['kinds', 'recommended_reviewer', 'config']);
    assert.deepEqual(doc.kinds.map((k) => k.kind), ['claude', 'codex', 'grok', 'agy', 'gemini', 'cursor', 'pi', 'opencode']);
    for (const k of doc.kinds) {
      assert.deepEqual(Object.keys(k), ['kind', 'executable', 'installed', 'family', 'effort_ceiling', 'models', 'summary', 'custom_models']);
      assert.equal(k.installed, false, 'no CLI on PATH in the fixture');
      assert.deepEqual(k.models, []);
      assert.deepEqual(k.custom_models, []);
    }
    const c = doc.config;
    assert.deepEqual(Object.keys(c), ['max_workers', 'multi_role', 'reuse_workers', 'panes', 'lanes', 'effective_lanes', 'presets', 'role_kinds', 'worker_models']);
    assert.deepEqual(c.max_workers, { value: '3', source: 'defaults' });
    assert.deepEqual(c.multi_role, { value: 'on', source: 'defaults' });
    assert.deepEqual(c.reuse_workers, { value: 'on', source: 'defaults' });
    assert.deepEqual(c.panes, { value: '4', source: 'defaults' });
    assert.deepEqual(c.lanes, { value: 'on', source: 'defaults' });
    assert.equal(doc.recommended_reviewer, null, 'no installed kind, no candidate');
    assert.deepEqual(c.effective_lanes.map((l) => l.name), ['build', 'explore', 'review']);
    assert.deepEqual(c.effective_lanes[0].roles, ['implementer', 'designer', 'tasker']);
    assert.equal(c.effective_lanes[0].kind, '');
    assert.equal(c.effective_lanes[0].model, '');
    assert.equal(c.effective_lanes[0].effort, '');
    assert.equal(c.effective_lanes[0].approvals, '');
    assert.deepEqual(Object.keys(c.presets), ['3', '4']);
    assert.deepEqual(c.presets['3'], [
      { name: 'build', roles: ['implementer', 'designer', 'tasker'] },
      { name: 'read', roles: ['scouter', 'researcher', 'reviewer', 'security-reviewer', 'ui-reviewer', 'inspector'] },
    ]);
    assert.deepEqual(c.presets['4'].map((l) => l.name), ['build', 'explore', 'review']);
    // Custom lanes replace the preset effective lanes (panes still defaults).
    write(r.projectConf, 'lane.build.roles=implementer,designer\nlane.review.roles=reviewer\n');
    const doc2 = setupDetectJson(loadConfig(r.env, r.repo), r.env, r.repo);
    assert.deepEqual(doc2.config.effective_lanes.map((l) => l.name), ['build', 'review']);
    assert.deepEqual(doc2.config.effective_lanes[0].roles, ['implementer', 'designer']);
    // panes=3 (project layer) switches the preset lanes.
    write(r.projectConf, 'panes=3\n');
    const doc3 = setupDetectJson(loadConfig(r.env, r.repo), r.env, r.repo);
    assert.deepEqual(doc3.config.effective_lanes.map((l) => l.name), ['build', 'read']);
    assert.deepEqual(doc3.config.panes, { value: '3', source: 'project' });
    // The JSON round-trips and keeps the key order.
    const keys = Object.keys(JSON.parse(JSON.stringify(doc)));
    assert.deepEqual(keys, ['kinds', 'recommended_reviewer', 'config']);
  } finally { r.cleanup(); }
});

// ---------- review fixes (slice 7b) ----------

test('piCustomModelsJson: a thinkingLevelMap key named like an Object.prototype member is an unknown level', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ha-detect-proto-')));
  try {
    const dir = path.join(root, '.pi', 'agent');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({ providers: { p: { models: [
      { id: 'a', thinkingLevelMap: { constructor: 'x', toString: 'y' } },
      { id: 'b', thinkingLevelMap: { constructor: 'x', high: 'high' } },
    ] } } }));
    assert.deepEqual(piCustomModelsJson({ HOME: root, USERPROFILE: root }), [
      { id: 'p/a', max_effort: '' },
      { id: 'p/b', max_effort: 'high' },
    ]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
