// Platform behavior: user config path per platform (orchestrator decision 4,
// with platform and environment injectable for testing) and CRLF -> LF text
// reads (decision 7), including at the `config` CLI level.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { JS_ENTRY, nodeBin, fixtureEnv } from './parity.mjs';
import { userConfigPath, homeDir, readTextFile, findExecutable, atomicWrite } from '../lib/platform.mjs';

test('userConfigPath: XDG_CONFIG_HOME wins on every platform (decision 4)', (t) => {
  const xdg = '/cfg/home';
  assert.equal(userConfigPath('linux', { XDG_CONFIG_HOME: xdg }), path.join(xdg, 'herdr-agents', 'config'));
  assert.equal(userConfigPath('darwin', { XDG_CONFIG_HOME: xdg }), path.join(xdg, 'herdr-agents', 'config'));
  assert.equal(userConfigPath('win32', { XDG_CONFIG_HOME: xdg }), path.join(xdg, 'herdr-agents', 'config'));
});

test('userConfigPath: win32 without XDG uses %APPDATA%\\herdr-agents\\config', (t) => {
  const appdata = 'C:\\Users\\dev\\AppData\\Roaming';
  assert.equal(userConfigPath('win32', { APPDATA: appdata }), path.join(appdata, 'herdr-agents', 'config'));
  // No APPDATA: fall back under the user profile.
  const p = userConfigPath('win32', { USERPROFILE: 'C:\\Users\\dev' });
  assert.equal(p, path.join('C:\\Users\\dev', 'AppData', 'Roaming', 'herdr-agents', 'config'));
});

test('userConfigPath: Unix without XDG uses ~/.config/herdr-agents/config', (t) => {
  assert.equal(userConfigPath('linux', { HOME: '/home/dev' }), '/home/dev/.config/herdr-agents/config');
  assert.equal(userConfigPath('darwin', { HOME: '/Users/dev' }), '/Users/dev/.config/herdr-agents/config');
  // An empty XDG_CONFIG_HOME behaves like unset (bash ${:-} semantics).
  assert.equal(userConfigPath('linux', { XDG_CONFIG_HOME: '', HOME: '/home/dev' }), '/home/dev/.config/herdr-agents/config');
});

test('homeDir: USERPROFILE on win32, HOME elsewhere', (t) => {
  assert.equal(homeDir('win32', { USERPROFILE: 'C:\\Users\\dev' }), 'C:\\Users\\dev');
  assert.equal(homeDir('linux', { HOME: '/home/dev' }), '/home/dev');
});

test('readTextFile: CRLF lines are normalized to LF (decision 7)', (t) => {
  const f = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-crlf-'));
  const file = path.join(f, 'a.txt');
  try {
    fs.writeFileSync(file, 'a=1\r\nb=2 # c\r\n');
    assert.equal(readTextFile(file), 'a=1\nb=2 # c\n');
    // LF-only files pass through untouched.
    fs.writeFileSync(file, 'x=1\ny=2\n');
    assert.equal(readTextFile(file), 'x=1\ny=2\n');
  } finally { fs.rmSync(f, { recursive: true, force: true }); }
});

test('config CLI: a CRLF config file behaves like the same file with LF', (t) => {
  let root = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-crlf-cli-'));
  root = fs.realpathSync(root); // git reports the resolved path (macOS /var -> /private/var)
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const conf = path.join(root, 'conf');
  const state = path.join(root, 'state');
  const tmp = path.join(root, 'tmp');
  for (const d of [repo, home, conf, state, tmp]) fs.mkdirSync(d, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
  const env = fixtureEnv({ HOME: home, XDG_CONFIG_HOME: conf, HERDR_AGENTS_DIR: state, TMPDIR: tmp });
  const userFile = path.join(conf, 'herdr-agents', 'config');
  try {
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    const lf = 'max_workers=9\nlanes=off\n';
    const crlf = lf.replace(/\n/g, '\r\n');
    const run = () => {
      const r = spawnSync(nodeBin(), [JS_ENTRY, 'config'], { cwd: repo, env, encoding: 'utf8' });
      return { rc: r.status, out: r.stdout ?? '' };
    };
    const row = (out, key) => out.split('\n').find((l) => l.startsWith(key));
    const fields = (line) => line.trim().split(/\s+/);
    fs.writeFileSync(userFile, lf);
    const a = run();
    assert.equal(a.rc, 0, a.out);
    assert.deepEqual(fields(row(a.out, 'max_workers')).slice(1), ['9', 'user'], 'LF user layer: ' + row(a.out, 'max_workers'));
    fs.writeFileSync(userFile, crlf);
    const b = run();
    assert.equal(b.rc, 0, b.out);
    assert.equal(row(b.out, 'max_workers'), row(a.out, 'max_workers'), 'CRLF value differs from LF value');
    assert.equal(row(b.out, 'lanes'), row(a.out, 'lanes'), 'CRLF layer differs from LF layer');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('findExecutable: finds node on PATH, returns null for unknown names', (t) => {
  const found = findExecutable('node');
  assert.ok(found, 'node should be on PATH');
  assert.equal(findExecutable('definitely-not-a-real-command-xyz'), null);
});

// atomicWrite (backlog 12): a symlinked dest is written through to the
// final target of the chain and the link stays a link; nothing is removed
// before the rename, so an error leaves the links and no temp behind.
const SYMLINK_SKIP = process.platform === 'win32'
  ? 'symlink creation needs elevated privileges on Windows; POSIX fixture contract'
  : false;

// Mutation captured: renaming over the unresolved `dest` replaces the link with a plain file.
test('atomicWrite: a symlink to an existing file writes through, keeps the link and the target mode', { skip: SYMLINK_SKIP }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-aw-symlink-'));
  try {
    const target = path.join(root, 'CLAUDE.md');
    fs.writeFileSync(target, 'seed\n', { mode: 0o640 });
    const link = path.join(root, 'AGENTS.md');
    fs.symlinkSync(target, link);
    atomicWrite(link, 'through\n');
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link stays a link');
    assert.equal(fs.readFileSync(target, 'utf8'), 'through\n', 'the content lands on the target');
    assert.equal(fs.readFileSync(link, 'utf8'), 'through\n', 'the link still reads the target');
    assert.equal(fs.statSync(target).mode & 0o777, 0o640, 'the target mode is kept');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Mutation captured: resolving the temp against the link's folder and renaming over `dest` would replace the link.
test('atomicWrite: a relative link to a file in another directory resolves to that file', { skip: SYMLINK_SKIP }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-aw-symlink2-'));
  const other = path.join(root, 'other');
  fs.mkdirSync(other);
  try {
    const target = path.join(other, 'CLAUDE.md');
    fs.writeFileSync(target, 'seed\n');
    const link = path.join(root, 'AGENTS.md');
    fs.symlinkSync(path.join('other', 'CLAUDE.md'), link);
    atomicWrite(link, 'relative\n');
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link stays a link');
    assert.equal(fs.readFileSync(target, 'utf8'), 'relative\n', 'the target in the other folder is written');
    assert.deepEqual(fs.readdirSync(root).sort(), ['AGENTS.md', 'other'], 'no temp left next to the link');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Mutation captured: a rename over the unresolved `dest` would replace the (broken) link with a plain file instead of creating the missing end.
test('atomicWrite: a broken chain creates the file at its missing end, links stay links', { skip: SYMLINK_SKIP }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-aw-broken-'));
  try {
    const a = path.join(root, 'a.md');
    const b = path.join(root, 'b.md');
    const missing = path.join(root, 'missing.txt');
    fs.symlinkSync('b.md', a);
    fs.symlinkSync('./missing.txt', b);
    atomicWrite(a, 'created\n');
    assert.ok(fs.lstatSync(a).isSymbolicLink(), 'a stays a link');
    assert.ok(fs.lstatSync(b).isSymbolicLink(), 'b stays a link');
    assert.equal(fs.readFileSync(missing, 'utf8'), 'created\n', 'the file is created at the missing end');
    assert.equal(fs.statSync(missing).mode & 0o777, 0o600, 'a new file is 0600');
    assert.equal(fs.readFileSync(a, 'utf8'), 'created\n', 'the chain now resolves');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Mutation captured: a rename over the unresolved `dest` would turn the link into a plain file instead of failing.
test('atomicWrite: a symlink cycle throws the realpath ELOOP error, leaves the links and no temp behind', { skip: SYMLINK_SKIP }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-aw-loop-'));
  try {
    const a = path.join(root, 'a.md');
    const b = path.join(root, 'b.md');
    fs.symlinkSync('b.md', a);
    fs.symlinkSync('a.md', b);
    assert.throws(() => atomicWrite(a, 'x\n'), (e) => e.code === 'ELOOP', 'ELOOP like a failed realpath');
    assert.ok(fs.lstatSync(a).isSymbolicLink(), 'a is still a link');
    assert.ok(fs.lstatSync(b).isSymbolicLink(), 'b is still a link');
    assert.deepEqual(fs.readdirSync(root).sort(), ['a.md', 'b.md'], 'no temp file left behind');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
