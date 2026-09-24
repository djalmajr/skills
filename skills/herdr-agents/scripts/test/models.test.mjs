// JS port of the model-resolution scenarios (slice 2): per-kind model
// listing through fake CLIs on PATH (the fakes pattern of the bash suites),
// version ordering (newest first), resolveModel (exact id, alias, regex,
// a|b alternates, cursor/agy effort suffixes), the codex ceiling coming
// from the cached model, the 1-hour model cache (same location and format
// as bash), and the runCli/findExecutable Windows path (simulated win32 +
// a PATHEXT with .CMD — the functions take platform and env as parameters).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixtureEnv } from './parity.mjs';
import { writeFakeCli, listingFake, sleepingFake, ECHO_FAKE } from './fakes.mjs';
import { cmdInvocation, findExecutable, runCli } from '../lib/platform.mjs';
import {
  EFFORT_SUFFIX_RE, codexEffortCeiling, codexModelCeiling, modelIds, modelsCacheFile,
  ereRegExp, parseAgyModels, parseCursorModels, parseGrokModels, resolveModel,
  versionSortDesc,
} from '../lib/models.mjs';

function setup() {
  let root = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-models-'));
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

// Fakes in the style of the bash suites (one subcommand per CLI), as Node
// scripts so they also run on Windows (test/fakes.mjs).
const GROK_LIST = listingFake('models', [
  'Available models:',
  'grok-4.7 - xAI Grok 4.7 (default)',
  'grok-4.7-build-fast - quick variant',
  'grok-4.6 - older release',
]);
const CURSOR_LIST = listingFake('--list-models', [
  'grok-4.7-max - xAI Grok 4.7 (max)',
  'grok-4.7-high - xAI Grok 4.7 (high)',
  'grok-4.6 - xAI Grok 4.6',
  'claude-opus-4-8-max - Anthropic Claude Opus 4.8 (max)',
]);
const AGY_LIST = listingFake('models', [
  'gemini-3.8-flash  Google Gemini 3.8 Flash',
  'gemini-3.8-flash-high  Google Gemini 3.8 Flash (high)',
  'claude-opus-4-6  Anthropic Claude Opus 4.6',
  'gpt-oss-120b  OpenAI GPT-OSS 120B',
]);
const AGY_FAST_LIST = listingFake('models', [
  'muse-9-fast  Muse 9 fast variant',
  'muse-8  Muse 8',
]);
const CODEX_JSON = JSON.stringify({
  models: [
    { slug: 'gpt-5', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'xhigh' }] },
    { slug: 'gpt-5.1', supported_reasoning_levels: [{ effort: 'medium' }] },
    { slug: 'codex-astra', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }] },
  ],
}, null, 2);

function seedCodex(s) {
  fs.mkdirSync(path.join(s.home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(s.home, '.codex', 'models_cache.json'), CODEX_JSON);
}

test('list parsers mirror the bash awk/grep pipelines', (t) => {
  assert.deepEqual(parseCursorModels('grok-4.7-max - xAI Grok 4.7 (max)\n  indented - x\nfoo bar\nplain\n'), ['grok-4.7-max']);
  // cursor-agent colors its listing even when piped (verified 2026-09-24).
  const colored = '\x1b[2mAvailable models\x1b[22m\n\n\x1b[36mauto\x1b[39m \x1b[2m- Auto\x1b[22m\x1b[2m (default)\x1b[22m\n'
    + '\x1b[36mgrok-4.7-xhigh\x1b[39m \x1b[2m- Grok 4.7  Extra High\x1b[22m\n';
  assert.deepEqual(parseCursorModels(colored), ['auto', 'grok-4.7-xhigh']);
  assert.deepEqual(parseAgyModels('\x1b[36mmuse-9\x1b[39m  Muse 9\n'), ['muse-9']);
  assert.deepEqual(parseGrokModels('\x1b[1mgrok-4.7\x1b[0m (default)\n'), ['grok-4.7']);
  assert.deepEqual(parseAgyModels('gemini-3.8-flash  Google Gemini\none-word\nclaude-opus-4-6  Anthropic\n'), ['gemini-3.8-flash', 'claude-opus-4-6']);
  // grep -oE | sort -u: every grok-N token, deduped, sorted.
  assert.deepEqual(parseGrokModels('Available:\ngrok-4.7 - default\nxgrok-4.7-extended - extra\ngrok-4.6\ngrok-4.7\n'), ['grok-4.6', 'grok-4.7', 'grok-4.7-extended']);
  // EFFORT_SUFFIX_RE: -(effort)(-fast)? at the end.
  assert.equal('grok-4.7-low-fast'.replace(EFFORT_SUFFIX_RE, ''), 'grok-4.7');
  assert.equal('grok-4.7-max'.replace(EFFORT_SUFFIX_RE, ''), 'grok-4.7');
  assert.equal('grok-4.7'.replace(EFFORT_SUFFIX_RE, ''), 'grok-4.7');
  assert.equal('muse-9-fast'.replace(EFFORT_SUFFIX_RE, ''), 'muse-9-fast'); // -fast alone is not an effort suffix
});

test('versionSortDesc: newest first, numeric fields, lexicographic tie-break', (t) => {
  assert.deepEqual(
    versionSortDesc(['grok-4.6', 'grok-4.7', 'claude-opus-4-8', 'claude-opus-4-8-max', 'grok-4.7-build-fast']),
    ['claude-opus-4-8', 'claude-opus-4-8-max', 'grok-4.7', 'grok-4.7-build-fast', 'grok-4.6']);
  assert.deepEqual(versionSortDesc(['codex-astra', 'gpt-5']), ['gpt-5', 'codex-astra']);
  assert.deepEqual(versionSortDesc(['model-9', 'model-10']), ['model-10', 'model-9']);
  assert.deepEqual(versionSortDesc(['gpt-5.1', 'gpt-5', 'gpt-5.0']), ['gpt-5.1', 'gpt-5.0', 'gpt-5']);
  assert.deepEqual(versionSortDesc([]), []);
});

test('modelIds per kind via fake CLIs (grok, cursor, agy, codex, pi)', { timeout: 120000 }, (t) => {
  const s = setup();
  try {
    writeFakeCli(s.fakes, 'grok', GROK_LIST);
    writeFakeCli(s.fakes, 'cursor-agent', CURSOR_LIST);
    writeFakeCli(s.fakes, 'agy', AGY_LIST);
    seedCodex(s);
    const env = s.fakeEnv();
    assert.deepEqual(modelIds('grok', env), ['grok-4.6', 'grok-4.7', 'grok-4.7-build-fast']);
    assert.deepEqual(modelIds('cursor', env), ['grok-4.7-max', 'grok-4.7-high', 'grok-4.6', 'claude-opus-4-8-max']);
    assert.deepEqual(modelIds('agy', env), ['gemini-3.8-flash', 'gemini-3.8-flash-high', 'claude-opus-4-6', 'gpt-oss-120b']);
    assert.deepEqual(modelIds('codex', env), ['gpt-5', 'gpt-5.1', 'codex-astra']); // file order (jq)
    assert.deepEqual(modelIds('pi', env), []);
    assert.deepEqual(modelIds('nosuchkind', env), []);
  } finally { s.cleanup(); }
});

test('model cache: bash location/format, fresh for 60 minutes, short mode skips the write', { timeout: 120000 }, (t) => {
  const s = setup();
  try {
    writeFakeCli(s.fakes, 'grok', GROK_LIST);
    const env = s.fakeEnv();
    assert.deepEqual(modelIds('grok', env), ['grok-4.6', 'grok-4.7', 'grok-4.7-build-fast']);
    const f = modelsCacheFile('grok', env);
    assert.equal(f, path.join(env.TMPDIR, 'herdr-agents-models-grok.txt'));
    assert.equal(fs.readFileSync(f, 'utf8'), 'grok-4.6\ngrok-4.7\ngrok-4.7-build-fast\n');
    // Second call with the CLI gone from PATH is served from the fresh cache.
    const env2 = { ...env, PATH: s.tmp };
    assert.deepEqual(modelIds('grok', env2), ['grok-4.6', 'grok-4.7', 'grok-4.7-build-fast']);
    // Stale cache (older than 60 minutes) is refetched from the CLI.
    const old = Date.now() / 1000 - 61 * 60;
    fs.utimesSync(f, old, old);
    assert.deepEqual(modelIds('grok', env), ['grok-4.6', 'grok-4.7', 'grok-4.7-build-fast']);
  } finally { s.cleanup(); }

  const s2 = setup();
  try {
    writeFakeCli(s2.fakes, 'grok', GROK_LIST);
    // HERDR_AGENTS_MODELS_TIMEOUT shortens the calls and does not write the
    // cache, so a quick `setup --detect` cannot pin a partial list. 5 s leaves
    // room for a loaded machine; the expiry itself is the next test.
    const env3 = { ...s2.fakeEnv(), HERDR_AGENTS_MODELS_TIMEOUT: '5' };
    assert.deepEqual(modelIds('grok', env3), ['grok-4.6', 'grok-4.7', 'grok-4.7-build-fast']);
    assert.ok(!fs.existsSync(modelsCacheFile('grok', env3)), 'short mode must not write the cache');
  } finally { s2.cleanup(); }
});

test('model listing: a CLI slower than HERDR_AGENTS_MODELS_TIMEOUT yields no list and no cache', { timeout: 120000 }, () => {
  const s = setup();
  try {
    writeFakeCli(s.fakes, 'grok', sleepingFake(5000));
    const env = { ...s.fakeEnv(), HERDR_AGENTS_MODELS_TIMEOUT: '1' };
    assert.deepEqual(modelIds('grok', env), []);
    assert.ok(!fs.existsSync(modelsCacheFile('grok', env)), 'a timed-out listing must not write the cache');
  } finally { s.cleanup(); }
});

test('resolveModel: exact id, alias, regex and a|b alternates', { timeout: 120000 }, (t) => {
  const s = setup();
  try {
    writeFakeCli(s.fakes, 'grok', GROK_LIST);
    writeFakeCli(s.fakes, 'agy', AGY_LIST);
    writeFakeCli(s.fakes, 'cursor-agent', CURSOR_LIST);
    seedCodex(s);
    const env = s.fakeEnv();
    // Exact ids win before any pattern.
    assert.equal(resolveModel('grok', 'grok-4.7', '', env), 'grok-4.7');
    assert.equal(resolveModel('codex', 'codex-astra', '', env), 'codex-astra');
    // Alias/regex resolve to the NEWEST match (case-insensitive).
    assert.equal(resolveModel('grok', 'grok-4', '', env), 'grok-4.7');
    assert.equal(resolveModel('grok', 'GROK-4.6', '', env), 'grok-4.6');
    assert.equal(resolveModel('codex', 'astra', '', env), 'codex-astra');
    assert.equal(resolveModel('agy', 'gemini', '', env), 'gemini-3.8-flash');
    // Alternates are tried in order.
    assert.equal(resolveModel('agy', 'opus|gemini', '', env), 'claude-opus-4-6');
    assert.equal(resolveModel('agy', 'nosuch|gemini', '', env), 'gemini-3.8-flash');
    // No list for the kind: the spec passes through untouched.
    assert.equal(resolveModel('pi', 'my-provider/my-model', '', env), 'my-provider/my-model');
    assert.equal(resolveModel('pi', '', '', env), '');
    // No match: warning + spec unchanged (non-cursor kinds).
    const warns = [];
    const w = (m) => warns.push(m);
    assert.equal(resolveModel('grok', 'muse', '', env, w), 'muse');
    assert.equal(warns[0], "no grok model matches 'muse'; passing it through unchanged");
  } finally { s.cleanup(); }
});

test('resolveModel cursor/agy: effort suffix, rank ceiling, -fast exclusion', { timeout: 120000 }, (t) => {
  const s = setup();
  try {
    writeFakeCli(s.fakes, 'cursor-agent', CURSOR_LIST);
    writeFakeCli(s.fakes, 'agy', AGY_LIST);
    const env = s.fakeEnv();
    // base-effort when it exists in the list.
    assert.equal(resolveModel('cursor', 'grok', 'high', env), 'grok-4.7-high');
    // The suffix rank must not exceed the requested effort (xhigh: skip max, take high).
    assert.equal(resolveModel('cursor', 'grok', 'xhigh', env), 'grok-4.7-high');
    // No effort: first existing suffix in the max..minimal order.
    assert.equal(resolveModel('cursor', 'grok', '', env), 'grok-4.7-max');
    assert.equal(resolveModel('cursor', 'claude', 'max', env), 'claude-opus-4-8-max');
    // low effort: no suffix qualifies, fall back to the first base-<...> id.
    assert.equal(resolveModel('cursor', 'grok', 'low', env), 'grok-4.7-max');
    // agy behaves like cursor for the suffix dance.
    assert.equal(resolveModel('agy', 'gemini', 'high', env), 'gemini-3.8-flash-high');
    assert.equal(resolveModel('agy', 'gemini', 'low', env), 'gemini-3.8-flash');
  } finally { s.cleanup(); }

  const s2 = setup();
  try {
    // muse-9-fast is a -fast id: excluded from the base selection, so the
    // base must come from muse-8.
    writeFakeCli(s2.fakes, 'agy', AGY_FAST_LIST);
    const env2 = s2.fakeEnv();
    assert.equal(resolveModel('agy', 'muse', '', env2), 'muse-8');
  } finally { s2.cleanup(); }
});

test('codexModelCeiling comes from the cached model', (t) => {
  const s = setup();
  try {
    seedCodex(s);
    assert.equal(codexModelCeiling('gpt-5', s.env), 'xhigh');
    assert.equal(codexModelCeiling('gpt-5.1', s.env), 'medium');
    assert.equal(codexModelCeiling('codex-astra', s.env), 'max');
    assert.equal(codexModelCeiling('nope', s.env), '');
    // The ceiling that applies: the model's, else the conservative xhigh.
    assert.equal(codexEffortCeiling('codex-astra', s.env), 'max');
    assert.equal(codexEffortCeiling('gpt-5.1', s.env), 'medium');
    assert.equal(codexEffortCeiling('nope', s.env), 'xhigh');
    assert.equal(codexEffortCeiling('', s.env), 'xhigh');
    fs.rmSync(path.join(s.home, '.codex', 'models_cache.json'));
    assert.equal(codexModelCeiling('gpt-5', s.env), ''); // missing file: empty
    assert.equal(codexEffortCeiling('gpt-5', s.env), 'xhigh');
  } finally { s.cleanup(); }
});

// The exact slugs and cache of scripts/test-kinds.sh (retired in slice
// 9b): the ceiling that applies is the model's own; xhigh when the model
// is outside the cache, there is no model, or the file is missing.
test('codexEffortCeiling: the test-kinds.sh slugs (ported)', () => {
  const s = setup();
  try {
    fs.mkdirSync(path.join(s.home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(s.home, '.codex', 'models_cache.json'), JSON.stringify({
      models: [
        { slug: 'big', supported_reasoning_levels: [{ effort: 'high' }, { effort: 'max' }] },
        { slug: 'small', supported_reasoning_levels: [{ effort: 'xhigh' }] },
      ],
    }));
    assert.equal(codexEffortCeiling('big', s.env), 'max', 'model that advertises max');
    assert.equal(codexEffortCeiling('small', s.env), 'xhigh', 'model that stops at xhigh');
    assert.equal(codexEffortCeiling('not-listed', s.env), 'xhigh', 'model outside the cache');
    assert.equal(codexEffortCeiling('', s.env), 'xhigh', 'no model (CLI default)');
    fs.rmSync(path.join(s.home, '.codex', 'models_cache.json'));
    assert.equal(codexEffortCeiling('big', s.env), 'xhigh', 'no cache file');
  } finally { s.cleanup(); }
});

test('findExecutable: simulated win32 honors PATHEXT (.CMD); darwin does not', (t) => {
  const s = setup();
  try {
    fs.writeFileSync(path.join(s.fakes, 'grok.CMD'), '@echo fake-grok %1\r\n');
    const winEnv = { PATH: s.fakes, PATHEXT: '.CMD' };
    assert.equal(findExecutable('grok', winEnv, 'win32'), path.join(s.fakes, 'grok.CMD'));
    assert.equal(findExecutable('grok', { PATH: s.fakes }, 'darwin'), null); // no bare `grok` file
  } finally { s.cleanup(); }
});

test('runCli: a win32 .cmd/.bat target runs through cmd.exe with every argument escaped; notFound and timeout', { timeout: 120000 }, (t) => {
  // cmd.exe cannot run here, so the invocation is checked, not executed.
  const env = { PATHEXT: '.CMD', COMSPEC: 'C:\\Windows\\system32\\cmd.exe' };
  const inv = cmdInvocation('C:\\tools\\grok.CMD', ['models', 'has space', 'x& echo INJECTED', '50%', 'a"b'], env);
  assert.equal(inv.command, 'C:\\Windows\\system32\\cmd.exe');
  assert.equal(inv.windowsVerbatimArguments, true);
  assert.deepEqual(inv.args.slice(0, 3), ['/d', '/s', '/c']);
  const line = inv.args[3];
  assert.ok(line.startsWith('"') && line.endsWith('"'), line);
  assert.ok(line.includes('^"models^"'), line);
  assert.ok(line.includes('^"has^ space^"'), 'a space stays inside one argument: ' + line);
  assert.ok(line.includes('^"x^&^ echo^ INJECTED^"'), '& is escaped, not a command separator: ' + line);
  assert.ok(line.includes('^"50^%^"'), '% is escaped: ' + line);
  assert.ok(line.includes('^"a\\^"b^"'), 'an embedded quote is escaped: ' + line);
  assert.ok(!/[^^]&/.test(line), 'no unescaped &: ' + line);
  // npm shims under node_modules/.bin re-parse %*: metacharacters are escaped twice.
  const shim = cmdInvocation('C:\\p\\node_modules\\.bin\\tool.cmd', ['a&b'], env);
  assert.ok(shim.args[3].includes('^^^"a^^^&b^^^"'), shim.args[3]);
  // Without COMSPEC the command is cmd.exe; a non-batch target is not wrapped.
  assert.equal(cmdInvocation('C:\\tools\\x.cmd', [], {}).command, 'cmd.exe');

  const missing = runCli('definitely-not-a-real-cli-xyz', ['a']);
  assert.deepEqual(missing, { notFound: true, resolved: null, status: null, signal: null, stdout: '', stderr: '', timedOut: false, error: null });

  const s = setup();
  try {
    writeFakeCli(s.fakes, 'slowcli', sleepingFake(10000));
    writeFakeCli(s.fakes, 'echocli', ECHO_FAKE);
    const env2 = s.fakeEnv();
    const to = runCli('slowcli', [], { env: env2, timeoutMs: 300 });
    assert.equal(to.notFound, false);
    assert.equal(to.timedOut, true);
    assert.equal(to.status, null);

    const ok = runCli('echocli', ['hi', 'has space'], { env: env2 });
    assert.equal(ok.status, 0);
    assert.equal(ok.stdout, 'hi has space\n');
  } finally { s.cleanup(); }
});

// Model-spec dialect (defined, not "whatever grep is installed"): a
// case-insensitive regex where `(?…` groups (lookarounds, named or
// non-capturing groups) match nothing — no grep accepts them, so the spec
// passes through unresolved — POSIX bracket classes are translated, and the
// common escapes \d \w \s \b \xHH work.
test('model specs: defined regex dialect', { timeout: 120000 }, () => {
  assert.equal(ereRegExp('grok-(?=5)'), null);
  assert.equal(ereRegExp('(?:grok)'), null);
  assert.ok(ereRegExp('grok-\\d').test('grok-4.7'));
  assert.ok(ereRegExp('grok-\\x35').test('grok-5.2'));
  assert.ok(!ereRegExp('grok-\\x35').test('grok-4.7'));
  assert.ok(ereRegExp('grok-[[:digit:]]').test('grok-4.7'));
  assert.ok(!ereRegExp('grok-[[:digit:]]').test('grok-x'));
  assert.ok(ereRegExp('GROK-4').test('grok-4.7'), 'case-insensitive like grep -iE');
  const s = setup();
  try {
    writeFakeCli(s.fakes, 'grok', GROK_LIST);
    const env = s.fakeEnv();
    assert.equal(resolveModel('grok', 'grok-(?=4)', '', env), 'grok-(?=4)', 'lookahead passes through like bash');
    assert.equal(resolveModel('grok', 'grok-[[:digit:]]', '', env), resolveModel('grok', 'grok-4', '', env));
    assert.equal(resolveModel('grok', 'grok-\\d', '', env), resolveModel('grok', 'grok-4', '', env));
    // An escaped dot resolves to the real id (bash returns the pattern with
    // its backslash, which is not a model id: intentional divergence).
    assert.equal(resolveModel('grok', 'grok-4\\.7', '', env), 'grok-4.7');
  } finally { s.cleanup(); }
});
