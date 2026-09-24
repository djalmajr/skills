// Parity: the same CLI scenario run against `bash scripts/herdr-agents.sh`
// and `node scripts/herdr-agents.mjs` must produce identical stdout, exit
// code and (prefix-normalized) stderr. Covers `kinds`, `models <kind>`
// (three kinds with fake CLIs, codex from the models cache, and kinds
// without a list) and `model <kind> <spec> [effort]` (exact/regex
// resolution, effort ceilings including codex's per-model ceiling, a|b
// alternates, cursor strict failure, usage errors) — 24 CLI invocations
// over 8 scenarios.
//
// The fake CLIs live in <fixture>/fakes; each scenario's steps prepend that
// dir to PATH through a lazy getter (the fakes path only exists once the
// scenario's seed ran, per implementation).
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { parityScenario } from './parity.mjs';

const CODEX_JSON = JSON.stringify({
  models: [
    { slug: 'gpt-5', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'xhigh' }] },
    { slug: 'gpt-5.1', supported_reasoning_levels: [{ effort: 'medium' }] },
    { slug: 'codex-astra', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }] },
  ],
}, null, 2);

// The seed stores the fakes dir; the step env's PATH getter resolves it at
// run time (after the seed ran for the current implementation).
const envState = { fakes: '' };
const fakePathEnv = () => ({
  get PATH() { return `${envState.fakes}${path.delimiter}${process.env.PATH}`; },
});

function seed(fix) {
  const fakes = path.join(fix.root, 'fakes');
  fs.mkdirSync(fakes, { recursive: true });
  envState.fakes = fakes;
  const fake = (name, lines) => {
    const f = path.join(fakes, name);
    fs.writeFileSync(f, lines.join('\n') + '\n', { mode: 0o755 });
  };
  fake('grok', [
    '#!/bin/sh',
    'if [ "$1" = "models" ]; then',
    '  printf "%s\\n" "Available models:" "grok-4.7 - xAI Grok 4.7 (default)" "grok-4.7-build-fast - quick variant" "grok-4.6 - older release"',
    'fi',
  ]);
  fake('agy', [
    '#!/bin/sh',
    'if [ "$1" = "models" ]; then',
    '  printf "%s\\n" "gemini-3.8-flash  Google Gemini 3.8 Flash" "gemini-3.8-flash-high  Google Gemini 3.8 Flash (high)" "claude-opus-4-6  Anthropic Claude Opus 4.6" "gpt-oss-120b  OpenAI GPT-OSS 120B"',
    'fi',
  ]);
  fake('cursor-agent', [
    '#!/bin/sh',
    'if [ "$1" = "--list-models" ]; then',
    '  printf "%s\\n" "grok-4.7-max - xAI Grok 4.7 (max)" "grok-4.7-high - xAI Grok 4.7 (high)" "grok-4.6 - xAI Grok 4.6" "claude-opus-4-8-max - Anthropic Claude Opus 4.8 (max)"',
    'fi',
  ]);
  // `timeout` shim for the bash `timeout <s> <cli>` pipelines: the fake CLIs
  // never hang, so the shim just execs the command. The JS runCli has its
  // own timeout and never calls this file.
  fake('timeout', ['#!/bin/sh', 'shift', 'exec "$@"']);
  const codexDir = path.join(fix.home, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, 'models_cache.json'), CODEX_JSON);
}

const steps = (list) => list.map((args) => ({ args, env: fakePathEnv() }));

test('parity: kinds table with fake CLIs on PATH', { timeout: 120000 }, (t) => {
  parityScenario(t, 'kinds-table', {
    seed,
    steps: steps([['kinds']]),
  });
});

test('parity: models <kind> (grok, cursor, agy with fakes; codex, pi; errors)', { timeout: 120000 }, (t) => {
  parityScenario(t, 'models-listing', {
    seed,
    steps: steps([
      ['models', 'grok'],
      ['models', 'cursor'],
      ['models', 'agy'],
      ['models', 'codex'],
      ['models', 'pi'],
      ['models', 'unknownkind'],
      ['models'], // no kind: bash parameter error, rc 1
    ]),
  });
});

test('parity: model exact and regex (grok, codex with per-model ceiling)', { timeout: 120000 }, (t) => {
  parityScenario(t, 'model-exact-regex', {
    seed,
    steps: steps([
      ['model', 'grok', 'grok', 'xhigh'],
      ['model', 'grok', 'grok-4.7'],
      ['model', 'codex', 'gpt', 'xhigh'], // regex -> gpt-5.1, ceiling medium
      ['model', 'codex', 'astra'], // ceiling max
    ]),
  });
});

test('parity: model cursor effort suffixes (rank ceiling, pass-through suffix)', { timeout: 120000 }, (t) => {
  parityScenario(t, 'model-cursor', {
    seed,
    steps: steps([
      ['model', 'cursor', 'grok', 'xhigh'], // skip max (rank), take high
      ['model', 'cursor', 'grok'], // no effort: first suffix in max..minimal order
      ['model', 'cursor', 'claude', 'max'],
      ['model', 'cursor', 'grok', 'low'], // nothing qualifies: first base-<...> id
    ]),
  });
});

test('parity: model cursor with no match dies 2 (strict CLI)', { timeout: 120000 }, (t) => {
  parityScenario(t, 'model-cursor-die', {
    seed,
    steps: steps([['model', 'cursor', 'nosuchmodel']]),
  });
});

test('parity: model generic kinds (pi, opencode — no list, by-model family)', { timeout: 120000 }, (t) => {
  parityScenario(t, 'model-generic', {
    seed,
    steps: steps([
      ['model', 'pi', 'my-provider/my-model', 'high'],
      ['model', 'opencode', 'my-provider/gpt-5', 'high'],
    ]),
  });
});

test('parity: model usage errors (missing kind/spec) are rc 1', { timeout: 120000 }, (t) => {
  parityScenario(t, 'model-usage', {
    seed,
    steps: steps([
      ['model'],
      ['model', 'grok'],
    ]),
  });
});

test('parity: model agy alternates a|b and gemini effort suffix', { timeout: 120000 }, (t) => {
  parityScenario(t, 'model-agy-alternates', {
    seed,
    steps: steps([
      ['model', 'agy', 'gemini|opus', 'low'],
      ['model', 'agy', 'opus'],
      ['model', 'agy', 'gemini', 'high'],
    ]),
  });
});
