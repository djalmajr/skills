// friction: the no-argument `friction` prints the
// workspace log exactly as before, and `friction add "<text>"
// [--brief <path>]` records one line at level `note` with the command
// `friction` (plus the ` (brief: <path>)` suffix when given), prints
// `recorded` and exits 0. Empty text dies 2 with the usage message;
// every written line keeps the four TSV columns (\r, \n and \t are
// sanitized out of the message). Run as a child process against an
// isolated state dir; no herdr is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { nodeBin } from './parity.mjs';

const SCRIPTS = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const JS_ENTRY = path.join(SCRIPTS, 'herdr-agents.mjs');

function makeFix(prefix) {
  let root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  root = fs.realpathSync(root);
  const state = path.join(root, 'state');
  fs.mkdirSync(state, { recursive: true });
  const env = {
    HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'conf'),
    TMPDIR: path.join(root, 'tmp'),
    HERDR_AGENTS_DIR: state,
    HERDR_WORKSPACE_ID: 'ws',
    HERDR_ENV: '1',
    PATH: process.env.PATH,
  };
  const fix = {
    root,
    state,
    log: path.join(state, 'ws', 'friction.log'),
    cmd(args, extraEnv = {}) {
      return spawnSync(nodeBin(), [JS_ENTRY, ...args], { cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 30_000 });
    },
    logLines() {
      try { return fs.readFileSync(fix.log, 'utf8').split('\n').filter((l) => l !== ''); } catch { return []; }
    },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
  return fix;
}

test('friction: no argument prints the log as today (the no-friction line when empty)', () => {
  const fix = makeFix('ha-friction-cmd-');
  try {
    let r = fix.cmd(['friction']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `no friction recorded under ${fix.log}\n`, 'the no-friction line with the path');
    fs.mkdirSync(path.dirname(fix.log), { recursive: true });
    fs.writeFileSync(fix.log, '2026-09-25T10:00:00\twarning\twait\tseeded line\n');
    r = fix.cmd(['friction']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `friction log (${fix.log}): timestamp, level, command, message\n2026-09-25T10:00:00\twarning\twait\tseeded line\n`, 'the header and the log are printed verbatim');
  } finally { fix.cleanup(); }
});

test('friction add: records a note line with the command friction and prints recorded', () => {
  const fix = makeFix('ha-friction-add-');
  try {
    const r = fix.cmd(['friction', 'add', 'the lane review worker answered the question but never wrote the report']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'recorded\n');
    const lines = fix.logLines();
    assert.equal(lines.length, 1);
    const f = lines[0].split('\t');
    assert.equal(f.length, 4, 'the four TSV columns');
    assert.match(f[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, 'the date column');
    assert.equal(f[1], 'note', 'the level is note');
    assert.equal(f[2], 'friction', 'the command column is friction');
    assert.equal(f[3], 'the lane review worker answered the question but never wrote the report');
    // The next `friction` shows the new line (under the header).
    assert.equal(fix.cmd(['friction']).stdout, `friction log (${fix.log}): timestamp, level, command, message\n${lines[0]}\n`);
  } finally { fix.cleanup(); }
});

test('friction add: --brief appends the brief path to the message', () => {
  const fix = makeFix('ha-friction-brief-');
  try {
    const r = fix.cmd(['friction', 'add', 'scouter stalled on the pane read', '--brief', '.herdr-agents/ws/briefs/build-1.md']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'recorded\n');
    const f = fix.logLines()[0].split('\t');
    assert.equal(f[1], 'note');
    assert.equal(f[2], 'friction');
    assert.equal(f[3], 'scouter stalled on the pane read (brief: .herdr-agents/ws/briefs/build-1.md)');
  } finally { fix.cleanup(); }
});

test('friction add: an empty text dies 2 with the usage message', () => {
  const fix = makeFix('ha-friction-empty-');
  try {
    const r = fix.cmd(['friction', 'add']);
    assert.equal(r.status, 2, 'usage error is rc 2');
    assert.ok(r.stderr.includes('herdr-agents: friction add: give the text to record'), `the exact message: ${r.stderr}`);
    // No note is recorded; the usage error itself lands as an error line
    // (the living-command die path), never as a note.
    const lines = fix.logLines();
    assert.ok(lines.every((l) => l.split('\t')[1] !== 'note'), `no note line: ${JSON.stringify(lines)}`);
  } finally { fix.cleanup(); }
});

test('friction add: an unknown option or subcommand dies 2', () => {
  const fix = makeFix('ha-friction-usage-');
  try {
    const r1 = fix.cmd(['friction', 'add', 'text', '--nope']);
    assert.equal(r1.status, 2, r1.stderr);
    assert.ok(r1.stderr.includes("friction: unknown option --nope"), r1.stderr);
    const r2 = fix.cmd(['friction', 'frobnicate']);
    assert.equal(r2.status, 2, r2.stderr);
    assert.ok(r2.stderr.includes("friction: unknown subcommand 'frobnicate'"), r2.stderr);
    const r3 = fix.cmd(['friction', 'add', 'x', '--brief']);
    assert.equal(r3.status, 2, r3.stderr);
    assert.ok(r3.stderr.includes('friction add: --brief expects a path'), r3.stderr);
    assert.ok(fix.logLines().every((l) => l.split('\t')[1] !== 'note'), 'no note line for any of the usage errors');
  } finally { fix.cleanup(); }
});

// Mutation captured: a text whose newline is NOT sanitized before writing
// opens a second line without the date/level/command columns — the
// one-line and four-column asserts below break.
test('friction add: the text is sanitized into one four-column line', () => {
  const fix = makeFix('ha-friction-san-');
  try {
    const r = fix.cmd(['friction', 'add', 'first part', 'second part']);
    assert.equal(r.status, 0, r.stderr);
    const lines = fix.logLines();
    assert.equal(lines.length, 1, 'one physical line');
    const f = lines[0].split('\t');
    assert.equal(f.length, 4, 'four TSV columns');
    assert.equal(f[3], 'first part second part', 'the words are joined with a space');
  } finally { fix.cleanup(); }
});
