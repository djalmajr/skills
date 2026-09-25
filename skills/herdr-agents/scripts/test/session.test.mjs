// JS port of scripts/test-session.sh: session set/clear/show writes
// <state>/session.conf, sits above the project and user files and below flags
// and HERDR_AGENTS_*, `config` shows its source as `session`, and outside a
// workspace `set` refuses while `config` keeps working.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { JS_ENTRY, nodeBin, fixtureEnv } from './parity.mjs';

function setup() {
  let root = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-session-'));
  root = fs.realpathSync(root); // git reports the resolved path (macOS /var -> /private/var)
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const conf = path.join(root, 'conf');
  const state = path.join(root, 'state');
  const tmp = path.join(root, 'tmp');
  for (const d of [repo, home, conf, state, tmp]) fs.mkdirSync(d, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
  const env = fixtureEnv({
    HOME: home, XDG_CONFIG_HOME: conf, HERDR_AGENTS_DIR: state,
    HERDR_WORKSPACE_ID: 'ws', TMPDIR: tmp,
  });
  // Herdr-free environment for a variant that has no workspace at all.
  const envNoWs = { ...env };
  delete envNoWs.HERDR_WORKSPACE_ID;
  delete envNoWs.HERDR_ENV;
  let currentEnv = env;
  const useEnv = (e) => { currentEnv = e; };
  const run = (...args) => {
    const r = spawnSync(nodeBin(), [JS_ENTRY, ...args], { cwd: repo, env: currentEnv, encoding: 'utf8' });
    return { rc: r.status === null ? -1 : r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
  };
  return {
    root, repo, state, env, envNoWs, useEnv, run,
    proj: path.join(repo, '.agents', 'herdr-agents.conf'),
    sess: path.join(state, 'ws', 'session.conf'),
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

// Find the `config` table row for a (normalized) key; returns the
// value/source fields like the bash suite's awk.
function tableRow(out, key) {
  const line = out.split('\n').find((l) => l.startsWith(key));
  if (!line) return null;
  const rest = line.slice(key.length).replace(/^\s+/, '');
  const sp = rest.indexOf(' ');
  return { value: rest.slice(0, sp === -1 ? undefined : sp), source: rest.slice(sp === -1 ? 0 : sp + 1).trim() };
}

test('session set writes the session file in the state dir', (t) => {
  const s = setup();
  try {
    const r = s.run('session', 'set', 'lane.build.kind', 'pi');
    assert.equal(r.rc, 0, r.err);
    assert.ok(fs.existsSync(s.sess), `session.conf not written at ${s.sess}`);
    assert.match(fs.readFileSync(s.sess, 'utf8'), /^lane\.build\.kind=pi$/m, 'session.conf content');
    assert.match(r.out, /session/, 'session set did not say it is a session write');
  } finally { s.cleanup(); }
});

test('config shows the session value with source `session`', (t) => {
  const s = setup();
  try {
    s.run('session', 'set', 'lane.build.kind', 'pi');
    const r = s.run('config');
    assert.equal(r.rc, 0, r.err);
    const row = tableRow(r.out, 'lane_build_kind');
    assert.ok(row, 'lane_build_kind row missing');
    assert.equal(`${row.value} ${row.source}`, 'pi session', 'config session source');
    assert.match(r.out, /layers read:.*session/, 'config did not list the session layer');
    assert.ok(r.out.includes(s.sess), 'config did not name the session file');
  } finally { s.cleanup(); }
});

test('precedence: session > project, env > session', (t) => {
  const s = setup();
  try {
    fs.mkdirSync(path.dirname(s.proj), { recursive: true });
    fs.writeFileSync(s.proj, 'lane.build.kind=codex\n');
    s.run('session', 'set', 'lane.build.kind', 'pi');
    let r = s.run('config');
    let row = tableRow(r.out, 'lane_build_kind');
    assert.equal(`${row.value} ${row.source}`, 'pi session', 'session must beat project');
    const envGrok = { ...s.env, HERDR_AGENTS_LANE_BUILD_KIND: 'grok' };
    s.useEnv(envGrok);
    r = s.run('config');
    s.useEnv(s.env);
    row = tableRow(r.out, 'lane_build_kind');
    assert.equal(`${row.value} ${row.source}`, 'grok env', 'env must beat session');
  } finally { s.cleanup(); }
});

test('validation: unknown key / bad value refuse and leave the file', (t) => {
  const s = setup();
  try {
    s.run('session', 'set', 'lane.build.kind', 'pi');
    const before = fs.readFileSync(s.sess, 'utf8');
    assert.equal(s.run('session', 'set', 'nope', '1').rc, 2, 'bad key rc');
    assert.equal(s.run('session', 'set', 'max_workers', '-1').rc, 2, 'bad value rc');
    assert.equal(fs.readFileSync(s.sess, 'utf8'), before, 'validation rewrote the session file');
  } finally { s.cleanup(); }
});

test('session show lists the session entries', (t) => {
  const s = setup();
  try {
    s.run('session', 'set', 'lane.build.kind', 'pi');
    const r = s.run('session', 'show');
    assert.equal(r.rc, 0, r.err);
    assert.match(r.out, /^lane\.build\.kind=pi$/m, 'session show content');
    assert.ok(r.out.includes(`session file: ${s.sess}`), 'session show must name the file');
  } finally { s.cleanup(); }
});

test('session clear <key> drops one key only', (t) => {
  const s = setup();
  try {
    s.run('session', 'set', 'lane.build.kind', 'pi');
    s.run('session', 'set', 'lane.review.kind', 'codex');
    const r = s.run('session', 'clear', 'lane.build.kind');
    assert.equal(r.rc, 0, r.err);
    const content = fs.readFileSync(s.sess, 'utf8');
    assert.ok(!content.includes('lane.build.kind'), `clear did not drop the key: ${content}`);
    assert.match(content, /^lane\.review\.kind=codex$/m, 'clear dropped other keys');
  } finally { s.cleanup(); }
});

test('session clear (no key) removes the layer; config falls back to project', (t) => {
  const s = setup();
  try {
    fs.mkdirSync(path.dirname(s.proj), { recursive: true });
    fs.writeFileSync(s.proj, 'lane.build.kind=codex\n');
    s.run('session', 'set', 'lane.build.kind', 'pi');
    const r = s.run('session', 'clear');
    assert.equal(r.rc, 0, r.err);
    assert.ok(!fs.existsSync(s.sess), `clear left the session file: ${fs.existsSync(s.sess) ? fs.readFileSync(s.sess, 'utf8') : ''}`);
    const c = s.run('config');
    const row = tableRow(c.out, 'lane_build_kind');
    assert.equal(`${row.value} ${row.source}`, 'codex project', 'after clear, project value must win');
    const sh = s.run('session', 'show');
    assert.equal(sh.rc, 0, 'empty session show rc');
    assert.match(sh.out, /empty/i, 'empty session show');
    // Clearing again reports the empty session (file is gone).
    const r2 = s.run('session', 'clear');
    assert.equal(r2.rc, 0, 'second clear rc');
    assert.match(r2.out, /empty/i, 'second clear output');
  } finally { s.cleanup(); }
});

test('unknown subcommand and bad usage refuse with rc 2', (t) => {
  const s = setup();
  try {
    assert.equal(s.run('session', 'bogus').rc, 2, 'bad subcommand rc');
    assert.equal(s.run('session', 'set').rc, 2, 'set without value rc');
    assert.equal(s.run('session', 'set', 'k', 'v', 'w').rc, 2, 'set with extra arg rc');
    assert.equal(s.run('session', 'set', '--user', 'k', 'v').rc, 2, 'set with unknown option rc');
    assert.equal(s.run('session', 'clear', 'a', 'b').rc, 2, 'clear with two keys rc');
  } finally { s.cleanup(); }
});

test('without a resolvable workspace, set refuses; config still works', (t) => {
  const s = setup();
  try {
    s.useEnv(s.envNoWs);
    const r = s.run('session', 'set', 'lane.build.kind', 'pi');
    assert.equal(r.rc, 2, `no workspace rc: ${r.err}`);
    assert.ok(!fs.existsSync(s.sess), 'no workspace still wrote the session file');
    const c = s.run('config');
    s.useEnv(s.env);
    assert.equal(c.rc, 0, `config without session layer rc: ${c.err}`);
    assert.match(c.out, /session file: \(no workspace here\)/, 'config must show no session file');
  } finally { s.cleanup(); }
});

// Inside Herdr without HERDR_WORKSPACE_ID, the workspace comes from
// `herdr pane current --current` (resolved through PATH/PATHEXT by runCli).
test('session path falls back to the workspace herdr reports', { skip: process.platform === 'win32' }, async () => {
  const { sessionConfPath } = await import('../lib/session.mjs');
  const { loadConfig } = await import('../lib/config.mjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ha-session-herdr-')));
  try {
    const repo = path.join(root, 'repo');
    const bin = path.join(root, 'bin');
    const state = path.join(root, 'state');
    for (const d of [repo, bin, state]) fs.mkdirSync(d, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
    fs.writeFileSync(path.join(bin, 'herdr'), '#!/bin/sh\necho \'{"result":{"pane":{"workspace_id":"ws-from-herdr"}}}\'\n');
    fs.chmodSync(path.join(bin, 'herdr'), 0o755);
    const env = { PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`, HOME: root, XDG_CONFIG_HOME: path.join(root, 'conf'), HERDR_AGENTS_DIR: state, HERDR_ENV: '1' };
    const ctx = loadConfig(env, repo);
    assert.equal(sessionConfPath(ctx, env, repo), path.join(state, 'ws-from-herdr', 'session.conf'));
    // No herdr on PATH: no session layer, no crash.
    const noHerdr = { ...env, PATH: `/usr/bin${path.delimiter}/bin` };
    assert.equal(sessionConfPath(loadConfig(noHerdr, repo), noHerdr, repo), '');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Mutation captured: dropping the key=value split makes `session set
// lanes=off` a usage error (exit 2) instead of writing lanes=off.
test('session set and config set take one key=value argument', () => {
  const s = setup();
  try {
    const r = s.run('session', 'set', 'lanes=off');
    assert.equal(r.rc, 0, r.err);
    assert.ok(fs.readFileSync(s.sess, 'utf8').includes('lanes=off'), 'session.conf has lanes=off');
    const c = s.run('config', 'set', 'max_workers=2');
    assert.equal(c.rc, 0, c.err);
    assert.ok(fs.readFileSync(s.proj, 'utf8').includes('max_workers=2'), 'project file has max_workers=2');
    // The value may itself hold '=': only the first one splits.
    const a = s.run('session', 'set', 'args.codex=-c sandbox_workspace_write.network_access=true');
    assert.equal(a.rc, 0, a.err);
    assert.ok(fs.readFileSync(s.sess, 'utf8').includes('args.codex=-c sandbox_workspace_write.network_access=true'));
  } finally { s.cleanup(); }
});

// Mutation captured: without the whitespace check a zsh-unsplit "lanes off"
// ends in the bare usage line, which hides the cause.
test('session set with "key value" in one argument names the shell mistake', () => {
  const s = setup();
  try {
    const r = s.run('session', 'set', 'lanes off');
    assert.equal(r.rc, 2);
    assert.match(r.err, /'lanes off' arrived as one argument; pass the key and the value as two arguments or as key=value \(zsh does not split "\$var": use \$\{=var\}\)/);
    assert.ok(!fs.existsSync(s.sess), 'nothing written');
  } finally { s.cleanup(); }
});

// The args keys (args.<kind>, role.<role>.args, lane.<name>.args) hold
// native CLI flags: the value starts with `-` and, unquoted, arrives split
// across several arguments — the following arguments join a dash-led value
// instead of dying as unexpected arguments.
test('session set writes the args keys with dash-led values', () => {
  const s = setup();
  try {
    // A dash-led value as one argument (the shell keeps it quoted).
    const r = s.run('session', 'set', 'role.reviewer.args', '-c a=b');
    assert.equal(r.rc, 0, r.err);
    assert.match(fs.readFileSync(s.sess, 'utf8'), /^role\.reviewer\.args=-c a=b$/m, 'role args content');
    // Unquoted: the value continues in the following arguments.
    const r2 = s.run('session', 'set', 'lane.build.args', '-s', 'workspace-write');
    assert.equal(r2.rc, 0, r2.err);
    assert.match(fs.readFileSync(s.sess, 'utf8'), /^lane\.build\.args=-s workspace-write$/m, 'lane args content');
    // key=value with a dash-led value: only the first = splits (the value
    // may itself hold '=').
    const r3 = s.run('session', 'set', 'role.scouter.args=-c a=b');
    assert.equal(r3.rc, 0, r3.err);
    assert.match(fs.readFileSync(s.sess, 'utf8'), /^role\.scouter\.args=-c a=b$/m, 'role args via key=value');
    // Unquoted key=value: the shell delivers `lane.review.args=-c` and
    // `a=b` separately — the first `=` of the first argument splits the
    // key, the rest continues the dash-led value.
    const r5 = s.run('session', 'set', 'lane.review.args=-c', 'a=b');
    assert.equal(r5.rc, 0, r5.err);
    assert.match(fs.readFileSync(s.sess, 'utf8'), /^lane\.review\.args=-c a=b$/m, 'the split key=value was not written');
    // A value without a dash still refuses a third argument.
    const r4 = s.run('session', 'set', 'args.codex', 'a', 'b');
    assert.equal(r4.rc, 2, r4.err);
    assert.match(r4.err, /unexpected argument 'b'/);
    // Mutation captured: the new keys refused by the key pattern (the sets
    // would die 2 as unknown keys), a dash-led value not joining the
    // following argument (the unquoted lane args set would die on the
    // unexpected argument), or the unquoted `key=<part> <rest>` not split
    // at the first = of the first argument (the set would die 2 as an
    // unknown key).
  } finally { s.cleanup(); }
});

// Mutation captured: splitting key=value after the file selector is read
// wrongly (or dropping the selector) writes the pair to the other file.
test('config set key=value honors --user and --project', () => {
  const s = setup();
  try {
    const userFile = path.join(s.root, 'conf', 'herdr-agents', 'config');
    const snap = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
    fs.mkdirSync(path.dirname(s.proj), { recursive: true });
    fs.writeFileSync(s.proj, '# project\nlanes=on\n');
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    fs.writeFileSync(userFile, '# user\nlayout=split\n');
    let projBefore = snap(s.proj);
    const u = s.run('config', 'set', 'max_workers=5', '--user');
    assert.equal(u.rc, 0, u.err);
    assert.ok(snap(userFile).includes('max_workers=5'), 'user file has the pair');
    assert.equal(snap(s.proj), projBefore, 'project file byte-identical');
    const userBefore = snap(userFile);
    projBefore = snap(s.proj);
    const p = s.run('config', 'set', '--project', 'max_workers=6');
    assert.equal(p.rc, 0, p.err);
    assert.ok(snap(s.proj).includes('max_workers=6'), 'project file has the pair');
    assert.notEqual(snap(s.proj), projBefore);
    assert.equal(snap(userFile), userBefore, 'user file byte-identical');
  } finally { s.cleanup(); }
});
