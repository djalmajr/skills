// JS port of the scenarios in scripts/test-config-set.sh (the
// `setup --detect` / `setup --no-hooks` scenarios belong to the setup slice
// and are not ported here). Drives the CLI exactly like the bash suite and
// keeps the same assertions: valid/invalid keys and values, --user, comment
// preservation, `#` in values, verbatim rewrite.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { JS_ENTRY, nodeBin, fixtureEnv } from './parity.mjs';
import { loadConfig, cfg, cfgSource, normalizeKey, configKeyOk, configValueOk, configFileFor, stateRoot, gitignoreAfter } from '../lib/config.mjs';

function setup() {
  let root = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-config-'));
  root = fs.realpathSync(root); // git reports the resolved path (macOS /var -> /private/var)
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const conf = path.join(root, 'conf');
  const state = path.join(root, 'state');
  const tmp = path.join(root, 'tmp');
  for (const d of [repo, home, conf, state, tmp]) fs.mkdirSync(d, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
  // Like test-config-set.sh: HOME/XDG/HERDR_AGENTS_DIR/TMPDIR isolated, no
  // Herdr workspace (the session layer does not participate).
  const env = fixtureEnv({ HOME: home, XDG_CONFIG_HOME: conf, HERDR_AGENTS_DIR: state, TMPDIR: tmp });
  const run = (...args) => {
    const r = spawnSync(nodeBin(), [JS_ENTRY, ...args], { cwd: repo, env, encoding: 'utf8' });
    return { rc: r.status === null ? -1 : r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
  };
  return {
    root, repo, home, conf, state, tmp, env, run,
    proj: path.join(repo, '.agents', 'herdr-agents.conf'),
    user: path.join(conf, 'herdr-agents', 'config'),
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

const SEED = [
  '# keep this comment',
  'max_workers=3 # live cap',
  '# tail comment',
  'reuse_workers=on',
  '',
  'max_workers=1',
  '',
].join('\n');

test('config shows defaults for unset keys (multi_role on defaults)', (t) => {
  const s = setup();
  try {
    const r = s.run('config');
    assert.equal(r.rc, 0, `rc ${r.rc}: ${r.err}`);
    const line = r.out.split('\n').find((l) => l.startsWith('multi_role'));
    assert.ok(line, 'multi_role row missing');
    const fields = line.split(/\s+/).filter(Boolean);
    assert.deepEqual(fields.slice(1), ['on', 'defaults'], `multi_role default: ${fields.slice(1).join(' ')}`);
  } finally { s.cleanup(); }
});

test('config set preserves whole-line and trailing comments, collapses duplicates', (t) => {
  const s = setup();
  try {
    fs.mkdirSync(path.dirname(s.proj), { recursive: true });
    fs.writeFileSync(s.proj, SEED);
    const r = s.run('config', 'set', 'max_workers', '5');
    assert.equal(r.rc, 0, r.err);
    const expected = [
      '# keep this comment',
      'max_workers=5 # live cap',
      '# tail comment',
      'reuse_workers=on',
      '',
      '',
    ].join('\n');
    assert.equal(fs.readFileSync(s.proj, 'utf8'), expected, 'set max_workers did not preserve comments');
  } finally { s.cleanup(); }
});

test('config set appends a missing key and does not duplicate existing ones', (t) => {
  const s = setup();
  try {
    fs.mkdirSync(path.dirname(s.proj), { recursive: true });
    fs.writeFileSync(s.proj, SEED);
    s.run('config', 'set', 'max_workers', '5');
    const r = s.run('config', 'set', 'multi_role', 'on');
    assert.equal(r.rc, 0, r.err);
    const content = fs.readFileSync(s.proj, 'utf8');
    assert.match(content, /^multi_role=on$/m, 'multi_role was not appended');
    const workers = content.split('\n').filter((l) => l.startsWith('max_workers='));
    assert.equal(workers.length, 1, `max_workers duplicated: ${workers}`);
    assert.match(content, /^# keep this comment$/m, 'leading comment lost');
    assert.match(content, /^# tail comment$/m, 'tail comment lost');
  } finally { s.cleanup(); }
});

test('config set writes dotted role/lane/model keys', (t) => {
  const s = setup();
  try {
    fs.mkdirSync(path.dirname(s.proj), { recursive: true });
    fs.writeFileSync(s.proj, SEED);
    let r = s.run('config', 'set', 'role.reviewer.kind', 'grok');
    assert.equal(r.rc, 0, r.err);
    let content = fs.readFileSync(s.proj, 'utf8');
    assert.match(content, /^role\.reviewer\.kind=grok$/m, 'kind was not written');
    assert.match(content, /^# keep this comment$/m, 'comment lost after kind set');
    // Generic kinds (pi/opencode) are valid kind values.
    r = s.run('config', 'set', 'role.build.kind', 'pi');
    assert.equal(r.rc, 0, r.err);
    r = s.run('config', 'set', 'lane.build.kind', 'opencode');
    assert.equal(r.rc, 0, r.err);
    r = s.run('config', 'set', 'model.opencode.worker', 'my-provider/my-model');
    assert.equal(r.rc, 0, r.err);
    content = fs.readFileSync(s.proj, 'utf8');
    assert.match(content, /^role\.build\.kind=pi$/m, 'role.build.kind=pi was not written');
    assert.match(content, /^lane\.build\.kind=opencode$/m, 'lane.build.kind=opencode was not written');
    assert.match(content, /^model\.opencode\.worker=my-provider\/my-model$/m, 'model.opencode.worker was not written');
  } finally { s.cleanup(); }
});

test('config set writes the role/lane/args keys with dash-led values', (t) => {
  const s = setup();
  try {
    fs.mkdirSync(path.dirname(s.proj), { recursive: true });
    fs.writeFileSync(s.proj, SEED);
    // A dash-led value as one argument (the shell keeps it quoted).
    let r = s.run('config', 'set', 'role.reviewer.args', '-c a=b');
    assert.equal(r.rc, 0, r.err);
    // Unquoted: the shell splits the value; the arguments after a dash-led
    // value join it instead of dying as unexpected arguments.
    r = s.run('config', 'set', 'lane.build.args', '-s', 'workspace-write');
    assert.equal(r.rc, 0, r.err);
    // key=value with a dash-led value: only the first = splits.
    r = s.run('config', 'set', 'args.codex=-c a=b');
    assert.equal(r.rc, 0, r.err);
    // Unquoted key=value: the shell delivers `lane.review.args=-c` and
    // `a=b` separately — the first `=` of the first argument splits the
    // key, the rest continues the dash-led value.
    r = s.run('config', 'set', 'lane.review.args=-c', 'a=b');
    assert.equal(r.rc, 0, r.err);
    const content = fs.readFileSync(s.proj, 'utf8');
    assert.match(content, /^role\.reviewer\.args=-c a=b$/m, 'role args were not written');
    assert.match(content, /^lane\.build\.args=-s workspace-write$/m, 'lane args were not written');
    assert.match(content, /^args\.codex=-c a=b$/m, 'kind args were not written');
    assert.match(content, /^lane\.review\.args=-c a=b$/m, 'the split key=value was not written');
    assert.match(content, /^# keep this comment$/m, 'comment lost after args set');
    // The config table lists the new keys like the other dotted keys.
    const c = s.run('config');
    assert.equal(c.rc, 0, c.err);
    const row = c.out.split('\n').find((l) => l.startsWith('role_reviewer_args'));
    assert.ok(row && row.includes('-c a=b') && row.trimEnd().endsWith('project'), `config row: ${row}`);
    // A value without a dash still refuses a third argument.
    const bad = s.run('config', 'set', 'args.codex', 'a', 'b');
    assert.equal(bad.rc, 2, bad.err);
    assert.match(bad.err, /unexpected argument 'b'/);
    // The where flags after a dash-led value stay flags: the value is
    // written whole to the selected file, the flag is not swallowed into
    // it.
    fs.mkdirSync(path.dirname(s.user), { recursive: true });
    fs.writeFileSync(s.user, '# user\n');
    const userBefore = fs.readFileSync(s.user, 'utf8');
    const pr = s.run('config', 'set', 'args.claude', '-c a=b', '--project');
    assert.equal(pr.rc, 0, pr.err);
    assert.match(fs.readFileSync(s.proj, 'utf8'), /^args\.claude=-c a=b$/m, '--project not swallowed into the value');
    assert.ok(!fs.readFileSync(s.proj, 'utf8').split('\n').some((l) => l.includes('--project')), 'the flag leaked into the value');
    assert.equal(fs.readFileSync(s.user, 'utf8'), userBefore, 'the user file is untouched by --project');
    const us = s.run('config', 'set', 'args.cursor', '-c a=b', '--user');
    assert.equal(us.rc, 0, us.err);
    assert.match(fs.readFileSync(s.user, 'utf8'), /^args\.cursor=-c a=b$/m, '--user not swallowed into the value');
    assert.ok(!fs.readFileSync(s.user, 'utf8').split('\n').some((l) => l.includes('--user')), 'the flag leaked into the user value');
    assert.match(fs.readFileSync(s.proj, 'utf8'), /^args\.claude=-c a=b$/m, 'the project file keeps its own key');
    // Mutation captured: the where flags consumed into the value after a
    // dash-led value (the written value would carry --project/--user, or
    // the wrong file would receive the key), or the unquoted `key=<part>
    // <rest>` not split at the first = of the first argument (the set
    // would die 2 as an unknown key).
  } finally { s.cleanup(); }
});

test('unknown key / invalid value / empty value refuse with rc 2 and leave the file', (t) => {
  const s = setup();
  try {
    fs.mkdirSync(path.dirname(s.proj), { recursive: true });
    fs.writeFileSync(s.proj, SEED);
    const before = fs.readFileSync(s.proj, 'utf8');
    const bad = [
      ['nope', '1'],
      ['max_workers', '-1'],
      ['multi_role', 'yes'],
      ['role.reviewer.kind', 'notepad'],
    ];
    for (const args of bad) {
      const r = s.run('config', 'set', ...args);
      assert.equal(r.rc, 2, `rc for ${args.join(' ')}: ${r.err}`);
    }
    // --user on the same bad set also refuses (approvals is an enum).
    const r = s.run('config', 'set', 'approvals', 'FULL');
    assert.equal(r.rc, 2, `rc for approvals FULL: ${r.err}`);
    // A `#` starts a comment for the loader, so a value with it is refused.
    const r2 = s.run('config', 'set', 'feedback_repo', 'org/repo#frag');
    assert.equal(r2.rc, 2, `rc for hash value: ${r2.err}`);
    assert.equal(fs.readFileSync(s.proj, 'utf8'), before, 'validation rewrote the file');
    // The user file was never touched either (no --user in the bad sets).
    assert.ok(!fs.existsSync(s.user), 'user file should not exist yet');
  } finally { s.cleanup(); }
});

test('config set --user writes the user file, not the project file', (t) => {
  const s = setup();
  try {
    fs.mkdirSync(path.dirname(s.proj), { recursive: true });
    fs.writeFileSync(s.proj, SEED);
    const r = s.run('config', 'set', 'reuse_workers', 'off', '--user');
    assert.equal(r.rc, 0, r.err);
    assert.match(fs.readFileSync(s.user, 'utf8'), /^reuse_workers=off$/m, 'user file missing the key');
    assert.match(fs.readFileSync(s.proj, 'utf8'), /^reuse_workers=on$/m, 'user set changed the project file');
  } finally { s.cleanup(); }
});

test('values reach the file verbatim: no escape processing, no key injection', (t) => {
  const s = setup();
  try {
    fs.mkdirSync(path.dirname(s.proj), { recursive: true });
    fs.writeFileSync(s.proj, '# seed\n');
    let r = s.run('config', 'set', 'model.claude.worker', 'claude-opus-4\\.[0-9]');
    assert.equal(r.rc, 0, r.err);
    let content = fs.readFileSync(s.proj, 'utf8');
    assert.ok(content.split('\n').includes('model.claude.worker=claude-opus-4\\.[0-9]'), `backslash lost: ${content}`);
    r = s.run('config', 'set', 'herd_label', 'ok\\nrole.reviewer.kind=grok');
    assert.equal(r.rc, 0, r.err);
    content = fs.readFileSync(s.proj, 'utf8');
    assert.ok(!content.split('\n').includes('role.reviewer.kind=grok'), `escape injected another key: ${content}`);
    assert.ok(content.split('\n').includes('herd_label=ok\\nrole.reviewer.kind=grok'), `value not kept verbatim: ${content}`);
  } finally { s.cleanup(); }
});

// ---- unit: loader / validation ---------------------------------------------

test('key normalization matches the bash sed/tr pipeline', (t) => {
  assert.equal(normalizeKey('role.implementer.kind'), 'role_implementer_kind');
  assert.equal(normalizeKey('model.claude.worker'), 'model_claude_worker');
  assert.equal(normalizeKey('lane.build-roles'), 'lane_build_roles');
  assert.equal(normalizeKey('args - codex'), 'args_codex');
  assert.equal(normalizeKey('a$b'), 'ab');
});

test('configKeyOk: scalar plus dotted patterns', (t) => {
  assert.ok(configKeyOk('max_workers'));
  assert.ok(configKeyOk('role.x.kind'));
  assert.ok(configKeyOk('role.x.model'));
  assert.ok(configKeyOk('role.x.effort'));
  assert.ok(configKeyOk('role.x.args'));
  assert.ok(configKeyOk('role.security-reviewer.args'));
  assert.ok(configKeyOk('lane.x.roles'));
  assert.ok(configKeyOk('lane.x.panes')); // the lane capacity key
  assert.ok(configKeyOk('lane.x.args'));
  assert.ok(configKeyOk('pane_mode'));
  assert.ok(configKeyOk('flex_extra'));
  assert.ok(configKeyOk('flex_roles'));
  assert.ok(configKeyOk('lane.x.approvals'));
  assert.ok(configKeyOk('model.pi.worker'));
  assert.ok(configKeyOk('effort.grok'));
  assert.ok(configKeyOk('args.codex'));
  assert.ok(!configKeyOk('nope'));
  assert.ok(!configKeyOk('role.x.timeout'));
  assert.ok(!configKeyOk('role.x.args.timeout')); // args is a value, not a prefix
  assert.ok(!configKeyOk('role.X.kind'));
  assert.ok(!configKeyOk('effort.x')); // needs at least two chars after the dot
  assert.ok(!configKeyOk('model.'));
  assert.ok(!configKeyOk('lane.x.pane')); // only lane.x.panes is a key
  // Mutation captured: the new keys not accepted by the pattern (the
  // config set calls in the test below would die 2).
});

test('configValueOk: the args keys take any one-line value, dash-led included', (t) => {
  assert.ok(configValueOk('role.reviewer.args', '-c sandbox_workspace_write.network_access=true'));
  assert.ok(configValueOk('lane.build.args', '-s workspace-write -a never'));
  assert.ok(configValueOk('args.codex', '-c a=b'));
  assert.ok(!configValueOk('role.reviewer.args', 'a\n b'));
  assert.ok(!configValueOk('lane.build.args', 'a#b'));
});

test('configValueOk: enums, ladders and role resolution', (t) => {
  assert.ok(configValueOk('max_workers', '3'));
  assert.ok(!configValueOk('max_workers', '-1'));
  assert.ok(!configValueOk('max_workers', '3.5'));
  assert.ok(configValueOk('panes', '4'));
  assert.ok(configValueOk('panes', '3'));
  assert.ok(configValueOk('panes', '2'));
  assert.ok(!configValueOk('panes', '5'));
  // lane.<name>.panes (the lane capacity): integer ≥ 1 only.
  assert.ok(configValueOk('lane.build.panes', '1'));
  assert.ok(configValueOk('lane.build.panes', '4'));
  assert.ok(!configValueOk('lane.build.panes', '0'));
  assert.ok(!configValueOk('lane.build.panes', '-1'));
  assert.ok(!configValueOk('lane.build.panes', '1.5'));
  // pane_mode: the strict|flex pane mode; flex_extra: integer ≥ 0;
  // flex_roles: a known-roles list (empty allowed).
  assert.ok(configValueOk('pane_mode', 'strict'));
  assert.ok(configValueOk('pane_mode', 'flex'));
  assert.ok(!configValueOk('pane_mode', 'flex2'));
  assert.ok(configValueOk('flex_extra', '0'));
  assert.ok(configValueOk('flex_extra', '3'));
  assert.ok(!configValueOk('flex_extra', '-1'));
  assert.ok(!configValueOk('flex_extra', '1.5'));
  assert.ok(configValueOk('flex_roles', 'reviewer,documenter'));
  assert.ok(!configValueOk('flex_roles', ''));
  assert.ok(!configValueOk('flex_roles', 'nosuchrole'));
  assert.ok(configValueOk('lanes', 'off'));
  assert.ok(!configValueOk('lanes', 'no'));
  assert.ok(configValueOk('approvals', 'edits'));
  assert.ok(!configValueOk('approvals', 'FULL'));
  assert.ok(configValueOk('lane.build.approvals', 'full'));
  assert.ok(!configValueOk('lane.build.approvals', 'ask-please'));
  assert.ok(configValueOk('role.x.kind', 'pi'));
  assert.ok(configValueOk('role.x.kind', 'opencode'));
  assert.ok(!configValueOk('role.x.kind', 'notepad'));
  assert.ok(configValueOk('lane.build.effort', 'xhigh'));
  assert.ok(!configValueOk('lane.build.effort', 'ultra'));
  assert.ok(!configValueOk('feedback_repo', 'org#frag'));
  assert.ok(!configValueOk('feedback_repo', 'a\nb'));
  assert.ok(!configValueOk('feedback_repo', 'a\tb'));
});

test('a CRLF config file loads the same as the same file with LF (decision 7)', (t) => {
  const s = setup();
  try {
    fs.mkdirSync(path.dirname(s.proj), { recursive: true });
    const lf = 'max_workers=7\n# comment\nreuse_workers=off\n';
    fs.writeFileSync(s.proj, lf);
    const ctxLf = loadConfig(s.env, s.repo);
    assert.equal(cfg(ctxLf, 'max_workers', '', s.env), '7');
    assert.equal(cfg(ctxLf, 'reuse_workers', '', s.env), 'off');
    assert.ok(!ctxLf.entries.get('max_workers').value.includes('\r'), 'CRLF leaked into the value');
    const crlf = lf.replace(/\n/g, '\r\n');
    fs.writeFileSync(s.proj, crlf);
    const ctxCrlf = loadConfig(s.env, s.repo);
    assert.equal(cfg(ctxCrlf, 'max_workers', '', s.env), '7');
    assert.equal(cfg(ctxCrlf, 'reuse_workers', '', s.env), 'off');
    assert.equal(ctxCrlf.sources.join(' '), ctxLf.sources.join(' '), 'layers differ between CRLF and LF');
  } finally { s.cleanup(); }
});

test('empty file values fall back but keep their layer as source', (t) => {
  const s = setup();
  try {
    fs.mkdirSync(path.dirname(s.user), { recursive: true });
    fs.writeFileSync(s.user, 'report_language=\n');
    const ctx = loadConfig(s.env, s.repo);
    // report_language= in defaults is empty; cfg uses the fallback...
    assert.equal(cfg(ctx, 'report_language', 'fallback', s.env), 'fallback');
    // ...but the user layer (which redefines it as empty) is the reported source.
    assert.equal(cfgSource(ctx, 'report_language', s.env), 'user');
    assert.ok(ctx.sources.includes('user'));
  } finally { s.cleanup(); }
});

test('surrounding double quotes are stripped once (no escape handling)', (t) => {
  const s = setup();
  try {
    fs.mkdirSync(path.dirname(s.user), { recursive: true });
    fs.writeFileSync(s.user, 'herd_label="impl rev"\n');
    const ctx = loadConfig(s.env, s.repo);
    assert.equal(cfg(ctx, 'herd_label', '', s.env), 'impl rev');
  } finally { s.cleanup(); }
});

test('configFileFor resolves user vs project', (t) => {
  const s = setup();
  try {
    assert.equal(configFileFor('user', s.env, s.repo), path.join(s.conf, 'herdr-agents', 'config'));
    assert.equal(configFileFor('project', s.env, s.repo), path.join(s.repo, '.agents', 'herdr-agents.conf'));
  } finally { s.cleanup(); }
});

// --- rewrites keep the file safe (review of slice 1) ------------------------
// Bash rewrites through mktemp (0600) + mv; the JS rewrite must keep the
// original mode, create new files 0600, leave no temp file behind, and never
// lose the file when the final rename fails.

const CONFIG_URL = new URL('../lib/config.mjs', import.meta.url).href;

// Runs the config command / configClearKey in a child whose fs.renameSync
// throws, so the command boundary must preserve die()'s exit contract.
function runWithFailingRename(fn, file, ...args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-rename-'));
  const home = path.join(dir, 'home');
  const conf = path.join(dir, 'conf');
  const state = path.join(dir, 'state');
  const tmp = path.join(dir, 'tmp');
  for (const d of [home, conf, state, tmp]) fs.mkdirSync(d, { recursive: true });
  const env = fixtureEnv({ HOME: home, XDG_CONFIG_HOME: conf, HERDR_AGENTS_DIR: state, TMPDIR: tmp });
  const script = path.join(dir, 'child.mjs');
  fs.writeFileSync(script, [
    "import fs from 'node:fs';",
    "fs.renameSync = () => { const e = new Error('injected rename failure'); e.code = 'EIO'; throw e; };",
    `const mod = await import(${JSON.stringify(CONFIG_URL)});`,
    fn === 'cmdConfigSet'
      ? 'const ctx = mod.loadConfig(process.env, process.cwd());\nmod.cmdConfigSet(["max_workers", "5"], ctx, process.env, process.cwd());'
      : `mod.${fn}(...process.argv.slice(2));`,
  ].join('\n'));
  const cwd = fn === 'cmdConfigSet' ? path.dirname(path.dirname(file)) : undefined;
  const r = spawnSync(nodeBin(), [script, file, ...args], { cwd, env, encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  return { rc: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

test('config set keeps the file mode and creates new files 0600', { skip: process.platform === 'win32' }, () => {
  const s = setup();
  try {
    const userFile = path.join(s.conf, 'herdr-agents', 'config');
    let r = s.run('config', 'set', '--user', 'max_workers', '5');
    assert.equal(r.rc, 0, r.err);
    assert.equal(fs.statSync(userFile).mode & 0o777, 0o600, 'new user file is not 0600');
    const proj = path.join(s.repo, '.agents', 'herdr-agents.conf');
    fs.mkdirSync(path.dirname(proj), { recursive: true });
    fs.writeFileSync(proj, 'max_workers=2\n');
    fs.chmodSync(proj, 0o640);
    r = s.run('config', 'set', 'max_workers', '3');
    assert.equal(r.rc, 0, r.err);
    assert.equal(fs.statSync(proj).mode & 0o777, 0o640, 'project file mode changed');
    assert.deepEqual(fs.readdirSync(path.dirname(proj)), ['herdr-agents.conf'], 'a temp file was left next to the config');
  } finally { s.cleanup(); }
});

test('a failed rename leaves the config and the session file untouched', () => {
  const s = setup();
  try {
    const file = s.proj;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '# keep\nmax_workers=2\n');
    let r = runWithFailingRename('cmdConfigSet', file);
    assert.equal(r.rc, 4, r.err);
    assert.equal(r.out, '');
    assert.equal(r.err, `herdr-agents: config set: could not rewrite ${file} (file left untouched)\n`);
    assert.equal(fs.readFileSync(file, 'utf8'), '# keep\nmax_workers=2\n');
    r = runWithFailingRename('configClearKey', file, 'max_workers');
    assert.equal(r.rc, 4, r.err);
    assert.equal(fs.readFileSync(file, 'utf8'), '# keep\nmax_workers=2\n');
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.includes('herdr-agents.conf')), ['herdr-agents.conf'], 'a temp file was left behind');
  } finally { s.cleanup(); }
});

test('gitignoreAfter: the entry always lands on a line of its own', () => {
  assert.equal(gitignoreAfter('', '.herdr-agents'), '.herdr-agents/\n');
  assert.equal(gitignoreAfter('node_modules\n', '.herdr-agents'), 'node_modules\n.herdr-agents/\n');
  assert.equal(gitignoreAfter('node_modules', '.herdr-agents'), 'node_modules\n.herdr-agents/\n');
});

test('stateRoot: the .gitignore entry is added once, only on a definite "not ignored"', {
  timeout: 30000,
  skip: process.platform === 'win32' ? 'uses an sh git wrapper and a symlink' : false,
}, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ha-config-gitignore-')));
  const newRepo = (name) => {
    const r = path.join(root, name);
    fs.mkdirSync(r, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: r, stdio: 'ignore', timeout: 30000 });
    return r;
  };
  const env = (extra = {}) => {
    const e = fixtureEnv({ HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'conf'), ...extra });
    delete e.HERDR_AGENTS_DIR;
    return e;
  };
  const run = (repo, e = env()) => stateRoot(loadConfig(e, repo), e, repo);
  try {
    // No final newline: the entry goes on its own line; a second run adds nothing.
    let r = newRepo('nofinal');
    fs.writeFileSync(path.join(r, '.gitignore'), 'node_modules');
    run(r);
    run(r);
    assert.equal(fs.readFileSync(path.join(r, '.gitignore'), 'utf8'), 'node_modules\n.herdr-agents/\n');
    // The line is there but a later rule un-ignores it (check-ignore exit 1): no duplicate.
    r = newRepo('negated');
    fs.writeFileSync(path.join(r, '.gitignore'), '.herdr-agents/\n!.herdr-agents/\n');
    run(r);
    assert.equal(fs.readFileSync(path.join(r, '.gitignore'), 'utf8'), '.herdr-agents/\n!.herdr-agents/\n');
    // check-ignore fails (exit 128, a git hiccup): nothing is written.
    r = newRepo('gitfail');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', timeout: 30000 }).stdout.trim();
    fs.writeFileSync(path.join(bin, 'git'),
      `#!/bin/sh\nfor a in "$@"; do [ "$a" = check-ignore ] && exit 128; done\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
    run(r, env({ PATH: `${bin}${path.delimiter}${process.env.PATH}` }));
    assert.equal(fs.existsSync(path.join(r, '.gitignore')), false, 'a git error must not write the .gitignore');
    // A symlinked .gitignore stays a link.
    r = newRepo('symlink');
    fs.writeFileSync(path.join(r, 'ignore-rules'), 'dist/\n');
    fs.symlinkSync('ignore-rules', path.join(r, '.gitignore'));
    run(r);
    assert.ok(fs.lstatSync(path.join(r, '.gitignore')).isSymbolicLink(), 'still a symlink');
    assert.equal(fs.readFileSync(path.join(r, 'ignore-rules'), 'utf8'), 'dist/\n.herdr-agents/\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
