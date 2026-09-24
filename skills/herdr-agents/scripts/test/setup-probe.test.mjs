// setup --probe (slice 8b): unit tests for lib/commands/setup-probe.mjs —
// probeTimeout (env validation, default 20 s), probeDefaultModel (the
// worker-model chain, the listing kinds' resolution, the cursor die
// swallowed to an empty model), probeCmd (the exact argv per kind: the
// minimal prompt, the native model flag, empty stdin), probeNoauthLine,
// probeKind (ready, no-auth with and without a key, quota with and without
// a renewal time, error by code, timeout with a live child, not installed)
// and cmdSetupProbe through the entry (the aggregate JSON shape, the
// recommended reviewer, the flag pass-through, the usage errors 2 before
// any CLI runs, and the own-models cap 5 + skipped_custom). Each test file
// builds its own temp root (mkdtemp) used as HOME, XDG_CONFIG_HOME, TMPDIR
// and HERDR_AGENTS_DIR, with a temporary git repo (brief decision 7); the
// agent CLIs are Node fakes (writeFakeCli) on a controlled PATH — nothing
// here touches a real `herdr` or a real agent CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { JS_ENTRY, nodeBin, fixtureEnv } from './parity.mjs';
import { writeFakeCli } from './fakes.mjs';
import { findExecutable } from '../lib/platform.mjs';
import { loadConfig } from '../lib/config.mjs';
import {
  PROBE_PROMPT, probeCmd, probeDefaultModel, probeKind, probeNoauthLine,
  probeTimeout,
} from '../lib/commands/setup-probe.mjs';

let ROOT;
let REPO;
let HOME;
let CONF;
let STATE;
let TMP;
let BIN;
let ARGS;
let MODES;
let ENV;

// The probe fake (Node source, per CLI name): logs its args + the stdin
// byte count (0 = /dev/null), then behaves per the mode file
// (ready|noauth|noauthkey|errkey|quota|quotatime|error|hang), default
// ready — the same table as test-probe.sh's make_fake. The hang mode
// leaves a live child (sleep) holding the output, like a CLI that forks.
function probeFakeSource(name) {
  const L = [];
  L.push("import fs from 'node:fs';");
  L.push("import { spawn } from 'node:child_process';");
  L.push('const args = process.argv.slice(2);');
  L.push("let stdin = '';");
  L.push("try { stdin = fs.readFileSync(0, 'utf8'); } catch { stdin = null; }");
  L.push(`fs.appendFileSync(process.env.PROBE_ARGS_DIR + '/args-${name}', JSON.stringify({ a: args, s: stdin === null ? -1 : Buffer.byteLength(stdin) }) + '\\n');`);
  L.push("let mode = 'ready';");
  L.push(`try { mode = fs.readFileSync(process.env.PROBE_MODE_DIR + '/mode-${name}', 'utf8').trim(); } catch {}`);
  L.push('switch (mode) {');
  L.push("  case 'ready': process.stdout.write('ok\\n'); break;");
  L.push(`  case 'noauth': process.stderr.write('Error: not logged in. Run "${name} login" first.\\n'); process.exit(1); break;`);
  L.push("  case 'noauthkey': process.stderr.write('Invalid API key provided: sk-proj-SENTINELA123456.\\n'); process.exit(1); break;");
  L.push("  case 'errkey': process.stderr.write('Error: api key sk-ant-api01SENTINELA rejected.\\n'); process.exit(4); break;");
  L.push("  case 'quota': process.stderr.write('Error: RESOURCE_EXHAUSTED - You have hit your usage limit. Try again in 5 minutes.\\n'); process.exit(1); break;");
  L.push("  case 'error': process.stderr.write('boom: connection refused\\n'); process.exit(3); break;");
  // Two renewals: stderr is written first, stdout second.
  L.push("  case 'quota2': process.stderr.write('Error: You have hit your usage limit. Try again in 10 minutes.\\n'); process.stdout.write('Error: You have hit your usage limit. Try again in 5 minutes.\\n'); process.exit(1); break;");
  L.push("  case 'quotatime': process.stderr.write('Error: You have hit your usage limit. Try again at 14:30.\\n'); process.exit(1); break;");
  L.push('  case \'hang\': {');
  L.push("    spawn('sleep', ['10'], { stdio: ['ignore', 'inherit', 'inherit'] });");
  L.push('    setTimeout(() => {}, 30000);');
  L.push('    break;');
  L.push('  }');
  L.push("  default: process.stdout.write('ok\\n');");
  L.push('}');
  return L.join('\n') + '\n';
}

const setMode = (name, mode) => fs.writeFileSync(path.join(MODES, `mode-${name}`), `${mode}\n`);
const clearModes = () => {
  for (const f of fs.readdirSync(MODES)) if (f.startsWith('mode-')) fs.rmSync(path.join(MODES, f));
};
const argsLog = (name) => {
  try { return fs.readFileSync(path.join(ARGS, `args-${name}`), 'utf8').trim().split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)); } catch { return []; }
};
const clearArgs = () => {
  for (const f of fs.readdirSync(ARGS)) if (f.startsWith('args-')) fs.rmSync(path.join(ARGS, f));
};

test.before(() => {
  ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ha-setup-probe-unit-')));
  REPO = path.join(ROOT, 'repo');
  HOME = path.join(ROOT, 'home');
  CONF = path.join(ROOT, 'conf');
  STATE = path.join(ROOT, 'state');
  TMP = path.join(ROOT, 'tmp');
  BIN = path.join(ROOT, 'bin');
  ARGS = path.join(ROOT, 'args');
  MODES = path.join(ROOT, 'modes');
  for (const d of [REPO, HOME, CONF, STATE, TMP, BIN, ARGS, MODES]) fs.mkdirSync(d, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: REPO, stdio: 'ignore', timeout: 20000 });
  // git on the controlled PATH (the config loader and the state root shell
  // out to git); the four probe fakes of test-probe.sh — agy/opencode stay
  // absent for the not-installed cases.
  const git = findExecutable('git');
  if (git) fs.symlinkSync(git, path.join(BIN, 'git'));
  for (const name of ['pi', 'codex', 'claude', 'grok']) writeFakeCli(BIN, name, probeFakeSource(name));
  ENV = fixtureEnv({
    HOME, XDG_CONFIG_HOME: CONF, HERDR_AGENTS_DIR: STATE, HERDR_WORKSPACE_ID: 'ws', TMPDIR: TMP,
    PATH: `${BIN}${path.delimiter}/usr/bin${path.delimiter}/bin`,
    PROBE_ARGS_DIR: ARGS, PROBE_MODE_DIR: MODES,
  });
});
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

// Run the entry as a child process (the e2e half); clears the args logs
// first so "no CLI ran" is provable from their absence.
function e2e(args, over = {}) {
  clearArgs();
  const t0 = Date.now();
  const r = spawnSync(nodeBin(), [JS_ENTRY, ...args], {
    cwd: REPO, env: { ...ENV, ...over }, encoding: 'utf8', timeout: 20000,
  });
  return {
    rc: r.status === null ? -1 : r.status,
    out: r.stdout ?? '',
    err: r.stderr ?? '',
    ms: Date.now() - t0,
  };
}

const ctxOf = () => loadConfig(ENV, REPO);

// ---------- probeTimeout ----------

test('probeTimeout: the env value wins, the default is 20 s', () => {
  assert.equal(probeTimeout({}), '20');
  assert.equal(probeTimeout({ HERDR_AGENTS_PROBE_TIMEOUT: '30' }), '30');
});

test('probeTimeout: an invalid env value is a usage error 2, not a fallback', () => {
  for (const bad of ['0', 'abc', '-3', '1.5', ' 5']) {
    let threw = null;
    try { probeTimeout({ HERDR_AGENTS_PROBE_TIMEOUT: bad }); } catch (e) { threw = e; }
    assert.ok(threw && threw.name === 'DieError' && threw.code === 2, `env ${bad}: expected DieError 2, got ${threw}`);
    assert.equal(threw.message, 'setup --probe: timeout must be a whole number of seconds ≥ 1');
  }
});

// ---------- probeDefaultModel ----------

test('probeDefaultModel: the worker-model chain and the pass-through kinds', () => {
  const ctx = ctxOf();
  assert.equal(probeDefaultModel(ctx, 'claude', ENV, REPO), 'opus'); // model.claude.worker
  assert.equal(probeDefaultModel(ctx, 'codex', ENV, REPO), 'sol|gpt-5'); // model.codex.worker, no cache → unchanged
  assert.equal(probeDefaultModel(ctx, 'grok', ENV, REPO), 'grok'); // model.grok.worker, resolves to itself
  assert.equal(probeDefaultModel(ctx, 'pi', ENV, REPO), ''); // no model.pi.* default
  assert.equal(probeDefaultModel(ctx, 'opencode', ENV, REPO), '');
});

test('probeDefaultModel: a project-layer model.<kind>.worker wins, a listing kind resolves it', () => {
  fs.mkdirSync(path.join(REPO, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(REPO, '.agents', 'herdr-agents.conf'), 'model.pi.worker=custom/pi-model\nmodel.claude.worker=opus-4\n');
  try {
    const ctx = ctxOf();
    assert.equal(probeDefaultModel(ctx, 'pi', ENV, REPO), 'custom/pi-model'); // generic kind: unchanged
    assert.equal(probeDefaultModel(ctx, 'claude', ENV, REPO), 'opus-4'); // claude has no listing: unchanged
  } finally {
    fs.rmSync(path.join(REPO, '.agents'), { recursive: true, force: true });
  }
});

// ---------- probeCmd ----------

test('probeCmd: the exact argv per kind (prompt, model flag order, empty model)', () => {
  assert.equal(PROBE_PROMPT, 'Reply with exactly ok');
  assert.deepEqual(probeCmd('claude', 'opus'), ['claude', '-p', 'Reply with exactly ok', '--model', 'opus']);
  assert.deepEqual(probeCmd('codex', 'sol'), ['codex', 'exec', '-m', 'sol', 'Reply with exactly ok']);
  assert.deepEqual(probeCmd('grok', 'g'), ['grok', '-p', 'Reply with exactly ok', '--model', 'g']);
  assert.deepEqual(probeCmd('agy', 'a'), ['agy', '-p', 'Reply with exactly ok', '--model', 'a']);
  assert.deepEqual(probeCmd('gemini', 'x'), ['gemini', '-p', 'Reply with exactly ok', '--model', 'x']);
  assert.deepEqual(probeCmd('cursor', 'c'), ['cursor-agent', '-p', 'Reply with exactly ok', '--model', 'c']);
  assert.deepEqual(probeCmd('pi', 'p/m'), ['pi', '-p', '--no-session', 'Reply with exactly ok', '--model', 'p/m']);
  assert.deepEqual(probeCmd('opencode', 'o'), ['opencode', 'run', 'Reply with exactly ok', '-m', 'o']);
  assert.deepEqual(probeCmd('notepad', ''), ['notepad', 'Reply with exactly ok']);
  assert.deepEqual(probeCmd('claude', ''), ['claude', '-p', 'Reply with exactly ok']);
  assert.deepEqual(probeCmd('codex', ''), ['codex', 'exec', 'Reply with exactly ok']);
});

// ---------- probeNoauthLine ----------

test('probeNoauthLine: the first login line wins, case-insensitive, empty otherwise', () => {
  assert.equal(probeNoauthLine('Error: not logged in. Run "claude login" first.\n'), 'Error: not logged in. Run "claude login" first.');
  assert.equal(probeNoauthLine('first line\nInvalid API key provided: sk-proj-X.\nplease sign in\n'), 'Invalid API key provided: sk-proj-X.');
  assert.equal(probeNoauthLine('PLEASE LOG IN TO CONTINUE\n'), 'PLEASE LOG IN TO CONTINUE');
  assert.equal(probeNoauthLine('boom: connection refused\n'), '');
  assert.equal(probeNoauthLine(''), '');
  // a quota line is not a login line (the classification order handles it)
  assert.equal(probeNoauthLine('Error: You have hit your usage limit.\n'), '');
});

// ---------- probeKind (in-process) ----------

test('probeKind: ready', { timeout: 20000 }, () => {
  clearModes();
  const r = probeKind(ctxOf(), 'pi', '', 'configured', '5', ENV, REPO);
  assert.deepEqual(r, { kind: 'pi', model: '', status: 'ready', cause: '', source: 'configured' });
});

test('probeKind: not installed (no CLI on the PATH)', { timeout: 20000 }, () => {
  const r = probeKind(ctxOf(), 'agy', '', 'configured', '5', ENV, REPO);
  assert.deepEqual(r, { kind: 'agy', model: '', status: 'error', cause: 'not installed', source: 'configured' });
  // nothing was run: no args log for the absent CLI
  assert.deepEqual(argsLog('agy'), []);
});

test('probeKind: no-auth — the fixed cause, never the CLI line', { timeout: 20000 }, () => {
  clearModes();
  setMode('claude', 'noauthkey');
  try {
    const r = probeKind(ctxOf(), 'claude', 'opus', 'configured', '5', ENV, REPO);
    assert.deepEqual(r, { kind: 'claude', model: 'opus', status: 'no-auth', cause: 'not authenticated', source: 'configured' });
    assert.ok(!JSON.stringify(r).includes('SENTINELA123456'), 'the key the CLI prints never reaches the result');
  } finally { clearModes(); }
});

test('probeKind: quota — with and without a renewal time (redacted value)', { timeout: 20000 }, () => {
  clearModes();
  setMode('grok', 'quota');
  let r = probeKind(ctxOf(), 'grok', 'grok', 'configured', '5', ENV, REPO);
  assert.equal(r.status, 'quota');
  assert.equal(r.cause, 'quota exhausted; renews 5 minutes');
  setMode('grok', 'quotatime');
  r = probeKind(ctxOf(), 'grok', 'grok', 'configured', '5', ENV, REPO);
  assert.equal(r.status, 'quota');
  assert.equal(r.cause, 'quota exhausted; renews 14:30');
  // Renewals in both streams: stdout is read first whatever the write
  // order (bash `cat "$outf"; cat "$errf"`), so its renewal wins.
  setMode('grok', 'quota2');
  r = probeKind(ctxOf(), 'grok', 'grok', 'configured', '5', ENV, REPO);
  assert.equal(r.cause, 'quota exhausted; renews 5 minutes');
  clearModes();
});

test('probeKind: a CLI that cannot be run is exit 127, never exit null', {
  timeout: 20000,
  skip: process.platform === 'win32' ? 'uses a shebang' : false,
}, () => {
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-probe-badexe-'));
  try {
    fs.writeFileSync(path.join(bad, 'pi'), '#!/nonexistent/interpreter\n', { mode: 0o755 });
    const env = { ...ENV, PATH: `${bad}${path.delimiter}/usr/bin${path.delimiter}/bin` };
    const r = probeKind(ctxOf(), 'pi', 'm', 'configured', '5', env, REPO);
    assert.deepEqual({ status: r.status, cause: r.cause }, { status: 'error', cause: 'exit 127' });
  } finally { fs.rmSync(bad, { recursive: true, force: true }); }
});

test('probeKind: error by code — the fixed cause, never the CLI text', { timeout: 20000 }, () => {
  clearModes();
  setMode('codex', 'errkey');
  try {
    const r = probeKind(ctxOf(), 'codex', 'sol', 'configured', '5', ENV, REPO);
    assert.deepEqual(r, { kind: 'codex', model: 'sol', status: 'error', cause: 'exit 4', source: 'configured' });
    assert.ok(!JSON.stringify(r).includes('SENTINELA'), 'the key the CLI prints never reaches the result');
  } finally { clearModes(); }
});

test('probeKind: a hang with a live child is a timeout after the limit, not later', { timeout: 20000 }, () => {
  clearModes();
  setMode('pi', 'hang');
  try {
    const t0 = Date.now();
    const r = probeKind(ctxOf(), 'pi', '', 'configured', '1', ENV, REPO);
    const ms = Date.now() - t0;
    assert.deepEqual(r, { kind: 'pi', model: '', status: 'error', cause: 'timeout after 1s', source: 'configured' });
    // the fake left a live `sleep` child holding the output file: the
    // probe must return at the timeout plus a short grace, not at the child's.
    assert.ok(ms < 5000, `took ${ms} ms (timeout 1 s + a short grace)`);
  } finally { clearModes(); }
});

// ---------- cmdSetupProbe through the entry ----------

test('e2e: the aggregate probe — shape, statuses, reviewer, flags, empty stdin, no state', { timeout: 30000 }, () => {
  clearModes();
  const r = e2e(['setup', '--probe']);
  assert.equal(r.rc, 0, `rc ${r.rc}: ${r.err}`);
  const doc = JSON.parse(r.out);
  assert.deepEqual(Object.keys(doc), ['probes', 'recommended_reviewer', 'skipped_custom']);
  assert.equal(doc.probes.length, 8);
  assert.deepEqual(doc.probes.map((p) => p.kind), ['claude', 'codex', 'grok', 'agy', 'gemini', 'cursor', 'pi', 'opencode']);
  for (const p of doc.probes) {
    assert.deepEqual(Object.keys(p), ['kind', 'model', 'status', 'cause', 'source']);
    assert.equal(p.source, 'configured');
  }
  const statusOf = (k) => doc.probes.find((p) => p.kind === k).status;
  assert.equal(statusOf('pi'), 'ready');
  assert.equal(statusOf('codex'), 'ready');
  assert.equal(statusOf('claude'), 'ready');
  assert.equal(statusOf('grok'), 'ready');
  assert.equal(statusOf('agy'), 'error');
  assert.equal(statusOf('opencode'), 'error');
  const agy = doc.probes.find((p) => p.kind === 'agy');
  assert.equal(agy.cause, 'not installed');
  // Build family defaults to the implementer frontmatter (grok → xai): the
  // reviewer must be another family — codex (openai), the probe's model spec.
  assert.deepEqual(doc.recommended_reviewer, { kind: 'codex', family: 'openai', model: 'sol|gpt-5' });
  assert.deepEqual(doc.skipped_custom, []);
  // Flag pass-through: the non-interactive subcommand, the model flag and
  // the exact minimal prompt (the codex default model is the configured spec).
  const codex = argsLog('codex');
  assert.ok(codex.some((e) => e.a[0] === 'exec' && e.a.includes('-m') && e.a.includes('sol|gpt-5') && e.a.includes('Reply with exactly ok')), JSON.stringify(codex));
  const pi = argsLog('pi');
  assert.ok(pi.some((e) => e.a.includes('-p') && e.a.includes('--no-session') && e.a.includes('Reply with exactly ok')), JSON.stringify(pi));
  // stdin is /dev/null: every invocation saw zero bytes.
  for (const e of [...argsLog('pi'), ...argsLog('codex')]) assert.equal(e.s, 0, 'stdin must be empty');
  // The probe needs no workspace and opens no state.
  assert.ok(!fs.existsSync(path.join(STATE, 'ws')), 'the probe must not create the workspace state');
});

test('e2e: a single kind with an explicit model', { timeout: 30000 }, () => {
  const r = e2e(['setup', '--probe', '--kind', 'pi', '--model', 'my-provider/my-model']);
  assert.equal(r.rc, 0, `rc ${r.rc}: ${r.err}`);
  const doc = JSON.parse(r.out);
  assert.deepEqual(doc.probes, [{ kind: 'pi', model: 'my-provider/my-model', status: 'ready', cause: '', source: 'configured' }]);
  assert.ok(argsLog('pi').some((e) => e.a.includes('--model') && e.a.includes('my-provider/my-model')), 'the model flag must carry the id');
});

test('e2e: --timeout and the env timeout — valid values work, invalid values die 2 before any CLI', { timeout: 30000 }, () => {
  for (const bad of ['0', 'abc']) {
    const r = e2e(['setup', '--probe', '--kind', 'pi', '--timeout', bad]);
    assert.equal(r.rc, 2, `--timeout ${bad}: rc ${r.rc}`);
    assert.ok(r.err.includes('setup --probe: timeout must be a whole number of seconds ≥ 1'), r.err);
    assert.equal(r.out, '', 'nothing on stdout');
    assert.deepEqual(argsLog('pi'), [], `--timeout ${bad}: no CLI ran`);
  }
  clearArgs();
  const envBad = e2e(['setup', '--probe', '--kind', 'pi'], { HERDR_AGENTS_PROBE_TIMEOUT: '0' });
  assert.equal(envBad.rc, 2, `env 0: rc ${envBad.rc}`);
  assert.ok(envBad.err.includes('setup --probe: timeout must be a whole number of seconds ≥ 1'), envBad.err);
  assert.deepEqual(argsLog('pi'), [], 'env 0: no CLI ran');
  const envOk = e2e(['setup', '--probe', '--kind', 'pi', '--timeout', '2'], { HERDR_AGENTS_PROBE_TIMEOUT: '30' });
  assert.equal(envOk.rc, 0, `valid timeout: rc ${envOk.rc}: ${envOk.err}`);
  assert.deepEqual(JSON.parse(envOk.out).probes, [{ kind: 'pi', model: '', status: 'ready', cause: '', source: 'configured' }]);
});

test('e2e: --model without --kind, an unknown kind and a flag without a value are usage errors 2', { timeout: 30000 }, () => {
  const cases = [
    [['setup', '--probe', '--model', 'requested/only'], 'setup --probe: --model needs --kind'],
    [['setup', '--probe', '--kind', 'notepad'], "setup --probe: unknown kind 'notepad' (see: kinds)"],
    [['setup', '--probe', '--kind', '--model', 'pi'], 'setup --probe: --kind expects a value'],
    [['setup', '--probe', '--kind'], 'setup --probe: --kind expects a value'],
    [['setup', '--probe', '--timeout'], 'setup --probe: --timeout expects a value'],
    [['setup', '--probe', '--bogus'], "setup --probe: unknown option '--bogus'"],
  ];
  for (const [args, frag] of cases) {
    const r = e2e(args);
    assert.equal(r.rc, 2, `${args.join(' ')}: rc ${r.rc}`);
    assert.ok(r.err.includes(frag), `${args.join(' ')}: stderr: ${r.err}`);
    assert.equal(r.out, '', `${args.join(' ')}: nothing on stdout`);
    assert.deepEqual(argsLog('pi'), [], `${args.join(' ')}: no CLI ran`);
  }
});

test('e2e: no-auth and error statuses end-to-end — the keys never reach the JSON', { timeout: 30000 }, () => {
  setMode('claude', 'noauth');
  let r = e2e(['setup', '--probe', '--kind', 'claude']);
  assert.equal(r.rc, 0, `noauth: rc ${r.rc}`);
  assert.deepEqual(JSON.parse(r.out).probes, [{ kind: 'claude', model: 'opus', status: 'no-auth', cause: 'not authenticated', source: 'configured' }]);
  assert.ok(!r.out.includes('SENTINELA'), r.out);

  setMode('claude', 'noauthkey');
  r = e2e(['setup', '--probe', '--kind', 'claude']);
  assert.equal(r.rc, 0);
  assert.deepEqual(JSON.parse(r.out).probes, [{ kind: 'claude', model: 'opus', status: 'no-auth', cause: 'not authenticated', source: 'configured' }]);
  assert.ok(!r.out.includes('SENTINELA123456'), `the key must not leak: ${r.out}`);
  clearModes();

  setMode('codex', 'errkey');
  r = e2e(['setup', '--probe', '--kind', 'codex']);
  assert.equal(r.rc, 0, `errkey: rc ${r.rc}`);
  assert.deepEqual(JSON.parse(r.out).probes, [{ kind: 'codex', model: 'sol|gpt-5', status: 'error', cause: 'exit 4', source: 'configured' }]);
  assert.ok(!r.out.includes('SENTINELA'), `the key must not leak: ${r.out}`);
  clearModes();

  setMode('codex', 'error');
  r = e2e(['setup', '--probe', '--kind', 'codex']);
  assert.equal(r.rc, 0, `error: rc ${r.rc}`);
  assert.deepEqual(JSON.parse(r.out).probes, [{ kind: 'codex', model: 'sol|gpt-5', status: 'error', cause: 'exit 3', source: 'configured' }]);
  assert.ok(!r.out.includes('boom'), `the CLI text must not leak: ${r.out}`);
  clearModes();

  setMode('grok', 'quota');
  r = e2e(['setup', '--probe', '--kind', 'grok']);
  assert.equal(r.rc, 0, `quota: rc ${r.rc}`);
  assert.deepEqual(JSON.parse(r.out).probes, [{ kind: 'grok', model: 'grok', status: 'quota', cause: 'quota exhausted; renews 5 minutes', source: 'configured' }]);
  clearModes();
});

test('e2e: the timeout classifies as error with the fixed cause, not later than limit + grace', { timeout: 30000 }, () => {
  setMode('pi', 'hang');
  const t0 = Date.now();
  const r = e2e(['setup', '--probe', '--kind', 'pi', '--timeout', '1']);
  const ms = Date.now() - t0;
  clearModes();
  assert.equal(r.rc, 0, `timeout: rc ${r.rc}: ${r.err}`);
  assert.deepEqual(JSON.parse(r.out).probes, [{ kind: 'pi', model: '', status: 'error', cause: 'timeout after 1s', source: 'configured' }]);
  // the hang fake leaves a live child holding the output: the whole command
  // must come back at the 1 s limit plus a short grace (and the node start).
  assert.ok(ms < 8000, `took ${ms} ms`);
});

test('e2e: the aggregate probe covers the user own models (5 probed, the rest skipped_custom)', { timeout: 30000 }, () => {
  fs.mkdirSync(path.join(HOME, '.pi', 'agent'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.pi', 'agent', 'models.json'), JSON.stringify({
    providers: { own: { apiKey: 'sk-proj-CUSTOMSECRET99', models: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'].map((id) => ({ id })) } },
  }));
  try {
    const r = e2e(['setup', '--probe']);
    assert.equal(r.rc, 0, `custom: rc ${r.rc}: ${r.err}`);
    assert.ok(!r.out.includes('CUSTOMSECRET99'), 'the apiKey must not leak');
    const doc = JSON.parse(r.out);
    const pi = doc.probes.filter((p) => p.kind === 'pi');
    assert.equal(pi.length, 6); // 1 configured + 5 custom
    assert.equal(pi.filter((p) => p.source === 'configured').length, 1);
    const custom = pi.filter((p) => p.source === 'custom');
    assert.deepEqual(custom.map((p) => p.model), ['own/m1', 'own/m2', 'own/m3', 'own/m4', 'own/m5']);
    assert.ok(custom.every((p) => p.status === 'ready'));
    assert.deepEqual(doc.skipped_custom, [{ kind: 'pi', id: 'own/m6' }, { kind: 'pi', id: 'own/m7' }]);
    assert.ok(argsLog('pi').some((e) => e.a.includes('--model') && e.a.includes('own/m1')), 'the custom probe must carry the model id');
  } finally {
    fs.rmSync(path.join(HOME, '.pi'), { recursive: true, force: true });
  }
});
