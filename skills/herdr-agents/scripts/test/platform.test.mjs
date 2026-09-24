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
import { userConfigPath, homeDir, readTextFile, findExecutable } from '../lib/platform.mjs';

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
