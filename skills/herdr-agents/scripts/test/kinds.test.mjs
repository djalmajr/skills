// JS port of the kind-table scenarios in scripts/test-kinds.sh: effort
// ceilings + clamp, native flag translation (model/effort/approvals/context
// per kind), the cursor effort-suffix path (with a fake cursor-agent on
// PATH, like the bash `model_ids` override), agy's gemini-only --effort,
// the pi/opencode warnings, the shipped defaults, the role frontmatter,
// the `kinds` CLI, and the NEW agentFamily rule (orchestrator decision —
// deliberate divergence from bash `agent_family`, so it is tested here with
// the decision cases, not in parity).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { JS_ENTRY, nodeBin, fixtureEnv } from './parity.mjs';
import { loadConfig, cfg, KNOWN_KINDS, configValueOk } from '../lib/config.mjs';
import { fmGet, skillDir } from '../lib/roles.mjs';
import {
  DieError, agentFamily, clampTo, cursorModelWithEffort, effortRank,
  kindApprovalArgs, kindContextArgs, kindEffortArgs, kindExe,
  kindFamilyDisplay, kindModelArgs, kindSummary, kindEffortCeiling, cmdKinds,
} from '../lib/kinds.mjs';
import { resolveModel } from '../lib/models.mjs';

function setup() {
  let root = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-kinds-'));
  root = fs.realpathSync(root); // git reports the resolved path (macOS /var -> /private/var)
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const conf = path.join(root, 'conf');
  const state = path.join(root, 'state');
  const tmp = path.join(root, 'tmp');
  const fakes = path.join(root, 'fakes');
  for (const d of [repo, home, conf, state, tmp, fakes]) fs.mkdirSync(d, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
  const env = fixtureEnv({ HOME: home, XDG_CONFIG_HOME: conf, HERDR_AGENTS_DIR: state, TMPDIR: tmp });
  return {
    root, repo, home, conf, state, tmp, fakes, env,
    fakeEnv: () => ({ ...env, PATH: `${fakes}${path.delimiter}${process.env.PATH}` }),
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

function writeFakeCli(dir, name, lines) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, lines.join('\n') + '\n', { mode: 0o755 });
  return f;
}

test('kind effort ceilings and clamp_to', (t) => {
  // Ceilings (grok 4.7 has xhigh; verified 2026-09-21).
  assert.equal(kindEffortCeiling('grok'), 'xhigh');
  assert.equal(kindEffortCeiling('cursor'), 'xhigh');
  assert.equal(kindEffortCeiling('codex'), 'xhigh');
  assert.equal(kindEffortCeiling('claude'), 'max');
  assert.equal(kindEffortCeiling('agy'), 'high');
  assert.equal(kindEffortCeiling('gemini'), 'high');
  assert.equal(kindEffortCeiling('pi'), 'max');
  assert.equal(kindEffortCeiling('opencode'), ''); // TUI maps no effort
  assert.equal(kindEffortCeiling('nosuchkind'), '');
  assert.equal(clampTo('xhigh', kindEffortCeiling('grok')), 'xhigh');
  assert.equal(clampTo('max', kindEffortCeiling('grok')), 'xhigh');
  assert.equal(clampTo('xhigh', kindEffortCeiling('agy')), 'high');
  assert.equal(clampTo('max', ''), 'max'); // empty ceiling: no clamp
  assert.deepEqual([effortRank('low'), effortRank('medium'), effortRank('high'), effortRank('xhigh'), effortRank('max'), effortRank('bogus')], [1, 2, 3, 4, 5, 0]);
});

test('native flags: grok, codex, claude, pi, opencode', (t) => {
  assert.deepEqual(kindEffortArgs('grok', 'xhigh', 'grok-4.7'), ['--reasoning-effort', 'xhigh']);
  assert.deepEqual(kindModelArgs('grok', 'grok-4.7', 'xhigh'), ['--model', 'grok-4.7']);
  assert.deepEqual(kindEffortArgs('codex', 'xhigh', 'gpt-5'), ['-c', 'model_reasoning_effort="xhigh"']);
  assert.deepEqual(kindModelArgs('codex', 'gpt-5', 'xhigh'), ['-m', 'gpt-5']);
  assert.deepEqual(kindEffortArgs('claude', 'max', ''), ['--effort', 'max']);
  assert.deepEqual(kindModelArgs('claude', 'claude-opus-4-8', ''), ['--model', 'claude-opus-4-8']);
  assert.deepEqual(kindEffortArgs('pi', 'max', 'my-provider/my-model'), ['--thinking', 'max']);
  assert.deepEqual(kindModelArgs('pi', 'my-provider/my-model', 'high'), ['--model', 'my-provider/my-model']);
  assert.deepEqual(kindModelArgs('opencode', 'my-provider/my-model', 'high'), ['-m', 'my-provider/my-model']);
  // Empty effort/model produce nothing.
  assert.deepEqual(kindEffortArgs('grok', '', 'grok-4.7'), []);
  assert.deepEqual(kindModelArgs('grok', '', 'xhigh'), []);
  // Unmapped kind: warn, nothing.
  const warns = [];
  const w = (m) => warns.push(m);
  assert.deepEqual(kindEffortArgs('nosuch', 'high', 'm', process.env, w), []);
  assert.equal(warns[0], "no effort mapping for kind 'nosuch'; effort ignored (pass the native flag after --)");
  warns.length = 0;
  assert.deepEqual(kindModelArgs('nosuch', 'm', '', w), []);
  assert.equal(warns[0], "no model mapping for kind 'nosuch'; model ignored");
});

test('agy/gemini: --effort only on empty or gemini* ids; suffixed ids carry it', (t) => {
  const warns = [];
  const w = (m) => warns.push(m);
  assert.deepEqual(kindEffortArgs('agy', 'high', 'gemini-3.8-flash', process.env, w), ['--effort', 'high']);
  assert.deepEqual(kindEffortArgs('agy', 'high', 'gemini-3.8-flash-high', process.env, w), []); // suffix: silent
  assert.deepEqual(kindEffortArgs('agy', 'high', 'claude-opus-4-6-thinking', process.env, w), []);
  assert.equal(warns[0], "agy model 'claude-opus-4-6-thinking' takes no --effort; effort 'high' ignored");
  assert.deepEqual(kindEffortArgs('agy', 'high', 'gpt-oss-120b-medium', process.env, w), []); // suffix: silent
  assert.equal(warns.length, 1); // no new warning for a suffixed id
  assert.deepEqual(kindEffortArgs('agy', 'high', 'gpt-oss-120b', process.env, w), []);
  assert.equal(warns[1], "agy model 'gpt-oss-120b' takes no --effort; effort 'high' ignored");
  warns.length = 0;
  assert.deepEqual(kindEffortArgs('gemini', 'high', 'gemini-3.7-flash', process.env, w), ['--effort', 'high']);
  assert.deepEqual(kindEffortArgs('gemini', 'high', 'claude-opus-4-6', process.env, w), []);
  assert.equal(warns[0], "gemini model 'claude-opus-4-6' takes no --effort; effort 'high' ignored");
});

test('cursor: effort rides in the model id and --model is never doubled', (t) => {
  // Model flag is skipped when effort is set (the effort args carry --model).
  assert.deepEqual(kindModelArgs('cursor', 'grok-4.7-xhigh', 'xhigh'), []);
  assert.deepEqual(kindModelArgs('cursor', 'grok-4.7-xhigh', ''), ['--model', 'grok-4.7-xhigh']);
  const warns = [];
  const w = (m) => warns.push(m);
  // Model already carries the effort: used as-is, with the warning.
  assert.deepEqual(kindEffortArgs('cursor', 'xhigh', 'grok-4.7-xhigh', process.env, w), ['--model', 'grok-4.7-xhigh']);
  assert.equal(warns[0], "cursor model 'grok-4.7-xhigh' already encodes an effort; --effort ignored");
  // No model: warn, nothing.
  warns.length = 0;
  assert.deepEqual(kindEffortArgs('cursor', 'xhigh', '', process.env, w), []);
  assert.equal(warns[0], 'cursor ignores --effort without --model (pick an id from: cursor-agent --list-models)');
});

test('cursorModelWithEffort consults --list-models (fake cursor-agent)', { timeout: 120000 }, (t) => {
  const s = setup();
  try {
    writeFakeCli(s.fakes, 'cursor-agent', [
      '#!/bin/sh',
      'if [ "$1" = "--list-models" ]; then',
      '  printf "%s\\n" "grok-4.7-max - xAI Grok 4.7 (max)" "grok-4.7-high - xAI Grok 4.7 (high)" "grok-4.7 - xAI Grok 4.7" "grok-4.6 - xAI Grok 4.6"',
      'fi',
    ]);
    const env = s.fakeEnv();
    const warns = [];
    const w = (m) => warns.push(m);
    assert.equal(cursorModelWithEffort('grok-4.7', 'max', env, w), 'grok-4.7-max');
    assert.equal(cursorModelWithEffort('grok-4.7', 'high', env, w), 'grok-4.7-high');
    // No -low in the list and no bare id: fall back to the plain model.
    assert.equal(cursorModelWithEffort('grok-4.7', 'low', env, w), 'grok-4.7');
    assert.match(warns.at(-1), /cursor has no 'grok-4.7-low'; using 'grok-4.7' \(effort = model default\)/);
    // Unknown model: pass-through with warning.
    assert.equal(cursorModelWithEffort('muse', 'high', env, w), 'muse');
    assert.match(warns.at(-1), /cursor model 'muse' not in --list-models; passing it through unchanged/);
    warns.length = 0;
    assert.equal(cursorModelWithEffort('grok-4.7-high', 'low', env, w), 'grok-4.7-high');
    assert.match(warns[0], /already encodes an effort; --effort ignored/);
    // No cursor-agent on PATH (empty dir): empty list, pass-through with warning.
    warns.length = 0;
    const bare = { ...s.env, PATH: s.tmp };
    assert.equal(cursorModelWithEffort('grok-4.7', 'max', bare, w), 'grok-4.7');
    assert.match(warns[0], /not in --list-models/);
  } finally { s.cleanup(); }
});

test('approval args per kind/mode (pi and opencode warn, invalid dies 2)', (t) => {
  assert.deepEqual(kindApprovalArgs('claude', 'edits'), ['--permission-mode', 'acceptEdits']);
  assert.deepEqual(kindApprovalArgs('claude', 'full'), ['--permission-mode', 'bypassPermissions', '--settings', '{"enableAllProjectMcpServers":true}']);
  assert.deepEqual(kindApprovalArgs('codex', 'edits'), ['-s', 'workspace-write', '-a', 'on-request']);
  assert.deepEqual(kindApprovalArgs('codex', 'full'), ['-s', 'workspace-write', '-a', 'never']);
  assert.deepEqual(kindApprovalArgs('grok', 'edits'), ['--permission-mode', 'acceptEdits']);
  assert.deepEqual(kindApprovalArgs('grok', 'full'), ['--permission-mode', 'bypassPermissions', '--always-approve']);
  assert.deepEqual(kindApprovalArgs('agy', 'edits'), ['--mode', 'accept-edits']);
  assert.deepEqual(kindApprovalArgs('agy', 'full'), ['--dangerously-skip-permissions']);
  assert.deepEqual(kindApprovalArgs('gemini', 'full'), ['--dangerously-skip-permissions']);
  assert.deepEqual(kindApprovalArgs('cursor', 'edits'), ['--trust', '--auto-review']);
  assert.deepEqual(kindApprovalArgs('cursor', 'full'), ['--trust', '--force', '--approve-mcps']);
  assert.deepEqual(kindApprovalArgs('pi', 'full'), []); // nothing to bypass
  const warns = [];
  const w = (m) => warns.push(m);
  assert.deepEqual(kindApprovalArgs('pi', 'edits', w), []);
  assert.equal(warns[0], 'pi has no approval prompts (its tools run as-is); approvals=edits is a no-op (restrict tools with --tools/--exclude-tools after --)');
  assert.deepEqual(kindApprovalArgs('opencode', 'full'), ['--auto']);
  warns.length = 0;
  assert.deepEqual(kindApprovalArgs('opencode', 'edits', w), []);
  assert.equal(warns[0], 'opencode has no edits approvals flag; use approvals=full (--auto) or per-tool permissions in opencode.json');
  warns.length = 0;
  assert.deepEqual(kindApprovalArgs('nosuch', 'edits', w), []);
  assert.equal(warns[0], "no approvals mapping for kind 'nosuch'; pass the native flag after --");
  assert.deepEqual(kindApprovalArgs('claude', 'ask'), []);
  assert.deepEqual(kindApprovalArgs('claude', ''), []);
  assert.throws(() => kindApprovalArgs('claude', 'FULL'), (e) => e instanceof DieError && e.code === 2 && e.message === "invalid approvals 'FULL' (ask|edits|full)");
});

test('context args (worker_context=lean) per kind', (t) => {
  assert.deepEqual(kindContextArgs('codex', 'lean'), ['-c', 'project_doc_max_bytes=0']);
  assert.deepEqual(kindContextArgs('claude', 'lean'), ['--disable-slash-commands']);
  assert.deepEqual(kindContextArgs('grok', 'lean'), []);
  assert.deepEqual(kindContextArgs('codex', 'full'), []);
});

test('kindExe, family display and summaries', (t) => {
  assert.equal(kindExe('cursor'), 'cursor-agent');
  for (const k of ['claude', 'codex', 'grok', 'agy', 'gemini', 'pi', 'opencode']) assert.equal(kindExe(k), k);
  assert.equal(kindFamilyDisplay('pi'), 'by model');
  assert.equal(kindFamilyDisplay('opencode'), 'by model');
  assert.equal(kindFamilyDisplay('cursor'), 'by model');
  assert.equal(kindFamilyDisplay('claude'), 'anthropic');
  assert.equal(kindFamilyDisplay('codex'), 'openai');
  assert.equal(kindFamilyDisplay('grok'), 'xai');
  assert.equal(kindFamilyDisplay('agy'), 'google');
  assert.equal(kindFamilyDisplay('gemini'), 'google');
  for (const k of KNOWN_KINDS) assert.ok(kindSummary(k).length > 0, `summary for ${k}`);
});

test('KNOWN_KINDS exact set and kind config values (copilot rejected)', (t) => {
  assert.deepEqual(KNOWN_KINDS, ['claude', 'codex', 'grok', 'agy', 'gemini', 'cursor', 'pi', 'opencode']);
  assert.ok(configValueOk('role.build.kind', 'pi'));
  assert.ok(configValueOk('lane.build.kind', 'opencode'));
  assert.ok(!configValueOk('role.build.kind', 'copilot')); // decision 1: not a kind
});

test('shipped defaults (config.defaults and role frontmatter)', (t) => {
  const s = setup();
  try {
    const ctx = loadConfig(s.env, s.repo);
    assert.equal(cfg(ctx, 'effort_grok', '', s.env), 'xhigh');
    assert.equal(cfg(ctx, 'effort_cursor', '', s.env), 'xhigh');
    assert.equal(cfg(ctx, 'model_grok_worker', '', s.env), 'grok');
    assert.equal(cfg(ctx, 'model_pi_worker', '', s.env), '');
    assert.equal(cfg(ctx, 'model_opencode_worker', '', s.env), '');
    const defaults = fs.readFileSync(path.join(skillDir(), 'config.defaults'), 'utf8');
    assert.ok(!/^model\.(pi|opencode)\./m.test(defaults), 'generic kinds ship a default model in config.defaults');
    const roles = {
      implementer: { kind: 'grok', effort: 'xhigh' },
      reviewer: { kind: 'codex', alternatives: 'claude' },
      'security-reviewer': { kind: 'claude' },
      tasker: { kind: 'grok', effort: 'low' },
    };
    for (const [role, fm] of Object.entries(roles)) {
      const f = path.join(skillDir(), 'roles', `${role}.md`);
      for (const [k, v] of Object.entries(fm)) assert.equal(fmGet(f, k), v, `${role} ${k}`);
    }
  } finally { s.cleanup(); }
});

test('agentFamily: the NEW rule (decision cases) + fixed-family kinds', (t) => {
  // The five decision cases (multi-model kinds; provider segments are never
  // pattern-matched).
  assert.equal(agentFamily('cursor', 'custom-grok-gateway/my-model'), 'unknown');
  assert.equal(agentFamily('cursor', 'openrouter/anthropic/claude-x-1'), 'anthropic');
  assert.equal(agentFamily('pi', 'xai/grok-4.7'), 'xai');
  assert.equal(agentFamily('opencode', 'my-provider/gpt-5'), 'openai');
  assert.equal(agentFamily('pi', 'my-claude-proxy/my-model'), 'unknown');
  // A family name only counts as a whole segment: a provider that merely
  // starts with one is still a provider name.
  assert.equal(agentFamily('opencode', 'openai-compatible/my-model'), 'unknown');
  assert.equal(agentFamily('pi', 'xai-proxy/my-model'), 'unknown');
  assert.equal(agentFamily('opencode', 'google-vertex/my-model'), 'unknown');
  assert.equal(agentFamily('opencode', 'my-provider/openai/my-model'), 'openai');
  // Family-name prefix on any segment (not just the provider position).
  assert.equal(agentFamily('opencode', 'openrouter/anthropic/claude-x-1'), 'anthropic');
  assert.equal(agentFamily('pi', 'google-ai/gemini-x'), 'google');
  // Last-segment patterns.
  assert.equal(agentFamily('cursor', 'grok-4.7-xhigh'), 'xai');
  assert.equal(agentFamily('cursor', 'gpt-5.3-codex-xhigh'), 'openai');
  assert.equal(agentFamily('cursor', 'claude-opus-5-thinking-xhigh'), 'anthropic');
  assert.equal(agentFamily('cursor', 'gemini-3.7-flash-high'), 'google');
  assert.equal(agentFamily('cursor', 'auto'), 'unknown');
  // Fixed-family kinds keep the kind family; no model = unknown.
  assert.equal(agentFamily('claude', 'anything'), 'anthropic');
  assert.equal(agentFamily('codex', 'gpt-5'), 'openai');
  assert.equal(agentFamily('grok', 'grok-4.7'), 'xai');
  assert.equal(agentFamily('agy', 'gemini-3.8'), 'google');
  assert.equal(agentFamily('gemini', 'anything'), 'google');
  assert.equal(agentFamily('codex', 'grok-something'), 'openai'); // stable kinds ignore the model
  assert.equal(agentFamily('pi'), 'unknown');
  assert.equal(agentFamily('cursor'), 'unknown');
  assert.equal(agentFamily('pi', ''), 'unknown');
});

test('resolveModel cursor: exact id and early failure (fake cursor-agent)', { timeout: 120000 }, (t) => {
  const s = setup();
  try {
    // The bash test overrides model_ids locally with exactly these two ids.
    writeFakeCli(s.fakes, 'cursor-agent', [
      '#!/bin/sh',
      'if [ "$1" = "--list-models" ]; then',
      '  printf "%s\\n" "grok-4.7-xhigh - X" "claude-opus-4-8-xhigh - X"',
      'fi',
    ]);
    const env = s.fakeEnv();
    assert.equal(resolveModel('cursor', 'grok-4.7-xhigh', 'xhigh', env), 'grok-4.7-xhigh');
    // Unknown/parameterized ids die 2 before spawn (no id printed).
    assert.throws(() => resolveModel('cursor', 'grok-4.7-xhigh[context=500k]', 'xhigh', env), (e) =>
      e instanceof DieError && e.code === 2 && e.message.startsWith("no cursor model matches 'grok-4.7-xhigh[context=500k]';"));
  } finally { s.cleanup(); }
});

test('kinds CLI: table with fake CLIs on PATH (installed yes/no)', { timeout: 120000 }, (t) => {
  const s = setup();
  try {
    for (const n of ['grok', 'agy', 'cursor-agent']) writeFakeCli(s.fakes, n, ['#!/bin/sh', 'exit 0']);
    const r = spawnSync(nodeBin(), [JS_ENTRY, 'kinds'], { cwd: s.repo, env: s.fakeEnv(), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const rows = r.stdout.trim().split('\n').slice(1);
    assert.equal(rows.length, KNOWN_KINDS.length);
    // Fixed-width columns: %-8s %-13s %-10s %-8s %s.
    const cols = (row) => [row.slice(0, 8), row.slice(9, 22), row.slice(23, 33), row.slice(34, 42), row.slice(43)];
    const byKind = Object.fromEntries(rows.map((l) => [l.slice(0, 8).trim(), l]));
    assert.equal(cols(byKind['grok'])[4].trim(), 'yes');
    assert.equal(cols(byKind['agy'])[4].trim(), 'yes');
    assert.equal(cols(byKind['cursor'])[4].trim(), 'yes');
    assert.equal(cols(byKind['claude'])[1].trim(), 'claude');
    assert.equal(cols(byKind['cursor'])[1].trim(), 'cursor-agent');
    assert.equal(cols(byKind['opencode'])[2].trim(), 'by model');
    assert.equal(cols(byKind['opencode'])[3].trim(), ''); // empty effort ceiling column
    assert.equal(r.stdout.split('\n')[0], 'KIND     EXECUTABLE    FAMILY     EFFORT   INSTALLED');
    // Without any fake on PATH the installed column follows the real PATH
    // state; both values must be yes/no.
    for (const row of rows) assert.match(cols(row)[4].trim(), /^(yes|no)$/);
  } finally { s.cleanup(); }
});
