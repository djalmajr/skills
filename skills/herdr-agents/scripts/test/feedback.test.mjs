// feedback send (feedback=local): the orchestrator's friction report is
// filed as <feedback_dir>/from-<project>-<YYYY-MM-DD>.md (wx, never
// overwritten; -b, -c, … for a second file of the day) and, when
// feedback_to is set, one line is prompted to it (a fake `herdr` records
// the agent prompt; the dispatch fake pattern). One JSON line out:
// {"status":"sent","file":…,"notified":…} (exit 0, note in the friction
// log) or {"status":"filed","file":…,"notified":null,"error":<raw>} when
// the prompt fails (exit 4, the file stays, a warn in the friction log).
// Preconditions die 2: policy not local, feedback_dir empty or not a
// directory, report missing or empty, summary empty. \r, \n and \t in the
// summary become spaces. Run as a child process against an isolated state
// dir; no real herdr is ever called.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeFakeCli } from './fakes.mjs';
import { nodeBin } from './parity.mjs';

const SCRIPTS = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const JS_ENTRY = path.join(SCRIPTS, 'herdr-agents.mjs');

// The fake herdr the code sees: `agent prompt <agent> <text>` appends
// "agent\ttext" to $FAKE_PROMPTS and fails (exit 1, stderr line) when the
// $FAKE_PROMPT_FAIL file exists. Every other call is a silent success.
const HERDR_FAKE = `
import fs from 'node:fs';
const argv = process.argv.slice(2);
if (argv[0] === 'agent' && argv[1] === 'prompt') {
  const agent = argv[2] ?? '';
  const text = argv.slice(3).join(' ');
  if (process.env.FAKE_PROMPT_FAIL && fs.existsSync(process.env.FAKE_PROMPT_FAIL)) {
    process.stderr.write('prompt failed: the fake refused\\n');
    process.exit(1);
  }
  if (process.env.FAKE_PROMPTS) fs.appendFileSync(process.env.FAKE_PROMPTS, agent + '\\t' + text + '\\n');
  process.stdout.write('{"result":{"submitted":true}}\\n');
}
process.stdout.write('{"result":{}}\\n');
`;

function makeFix(prefix) {
  let root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  root = fs.realpathSync(root); // git reports the resolved path (macOS /var -> /private/var)
  spawnSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore', timeout: 30_000 });
  const state = path.join(root, 'state');
  const fakes = path.join(root, 'fakes');
  const fdir = path.join(root, 'feedback');
  const tmp = path.join(root, 'tmp');
  for (const d of [state, fakes, fdir, tmp]) fs.mkdirSync(d, { recursive: true });
  writeFakeCli(fakes, 'herdr', HERDR_FAKE);
  const env = {
    HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'conf'),
    TMPDIR: path.join(root, 'tmp'),
    HERDR_AGENTS_DIR: state,
    HERDR_WORKSPACE_ID: 'ws',
    HERDR_ENV: '1',
    PATH: `${fakes}${path.delimiter}${process.env.PATH}`,
    FAKE_PROMPTS: path.join(root, 'prompts.tsv'),
    FAKE_PROMPT_FAIL: path.join(root, 'prompt-fail'),
  };
  const fix = {
    root,
    fdir,
    prompts: path.join(root, 'prompts.tsv'),
    promptFail: path.join(root, 'prompt-fail'),
    project: path.basename(root),
    cmd(args, extraEnv = {}) {
      return spawnSync(nodeBin(), [JS_ENTRY, ...args], { cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 30_000 });
    },
    logLines() {
      const log = path.join(state, 'ws', 'friction.log');
      try { return fs.readFileSync(log, 'utf8').split('\n').filter((l) => l !== ''); } catch { return []; }
    },
    promptLines() {
      try { return fs.readFileSync(fix.prompts, 'utf8').split('\n').filter((l) => l !== ''); } catch { return []; }
    },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
  return fix;
}

// A non-empty report at <root>/report.md; the policy-local env.
function seed(fix, text = 'dispatch waited 900s and the pane was stuck on the same screen\n') {
  fs.writeFileSync(path.join(fix.root, 'report.md'), text);
  return { HERDR_AGENTS_FEEDBACK: 'local', HERDR_AGENTS_FEEDBACK_DIR: fix.fdir };
}
const REPORT = 'report.md';

test('feedback send: a policy other than local dies 2 with the exact message', () => {
  const fix = makeFix('ha-feedback-policy-');
  try {
    seed(fix);
    for (const policy of ['ask', 'on', 'off']) {
      const r = fix.cmd(['feedback', 'send', REPORT, 'stuck pane'], { ...seed(fix), HERDR_AGENTS_FEEDBACK: policy });
      assert.equal(r.status, 2, `policy ${policy}: rc 2, stderr ${r.stderr}`);
      assert.ok(r.stderr.includes(`herdr-agents: feedback send: feedback=${policy}, not local; file an issue instead (see "Improving this skill")`),
        `the exact message (policy ${policy}): ${r.stderr}`);
    }
    assert.equal(fs.readdirSync(fix.fdir).length, 0, 'no file was written');
  } finally { fix.cleanup(); }
});

test('feedback send: feedback_dir empty or not a directory dies 2 naming the key', () => {
  const fix = makeFix('ha-feedback-dir-');
  try {
    seed(fix);
    // Empty feedback_dir (unset).
    const r1 = fix.cmd(['feedback', 'send', REPORT, 'stuck pane'], { HERDR_AGENTS_FEEDBACK: 'local' });
    assert.equal(r1.status, 2, r1.stderr);
    assert.ok(r1.stderr.includes('feedback send: feedback_dir is empty, relative or not a directory; set feedback_dir'), `names the key: ${r1.stderr}`);
    // feedback_dir pointing at a file, not a directory.
    const notDir = path.join(fix.root, 'a-file');
    fs.writeFileSync(notDir, 'x\n');
    const r2 = fix.cmd(['feedback', 'send', REPORT, 'stuck pane'], { HERDR_AGENTS_FEEDBACK: 'local', HERDR_AGENTS_FEEDBACK_DIR: notDir });
    assert.equal(r2.status, 2, r2.stderr);
    assert.ok(r2.stderr.includes('set feedback_dir'), `names the key: ${r2.stderr}`);
    // A relative feedback_dir dies 2 even when it exists under the working
    // directory: it would point elsewhere from another directory.
    fs.mkdirSync(path.join(fix.root, 'rel-inbox'), { recursive: true });
    const r3 = fix.cmd(['feedback', 'send', REPORT, 'stuck pane'], { HERDR_AGENTS_FEEDBACK: 'local', HERDR_AGENTS_FEEDBACK_DIR: 'rel-inbox' });
    assert.equal(r3.status, 2, r3.stderr);
    assert.ok(r3.stderr.includes('relative'), `says relative: ${r3.stderr}`);
    assert.equal(fs.readdirSync(path.join(fix.root, 'rel-inbox')).length, 0, 'nothing written under the relative dir');
    assert.equal(fs.readdirSync(fix.fdir).length, 0, 'no file was written');
  } finally { fix.cleanup(); }
});

test('feedback send: a missing or empty report dies 2', () => {
  const fix = makeFix('ha-feedback-report-');
  try {
    seed(fix);
    const r1 = fix.cmd(['feedback', 'send', 'nope.md', 'stuck pane'], seed(fix));
    assert.equal(r1.status, 2, r1.stderr);
    assert.ok(r1.stderr.includes(`feedback send: the report must be a non-empty file: nope.md`), r1.stderr);
    fs.writeFileSync(path.join(fix.root, 'empty.md'), '');
    const r2 = fix.cmd(['feedback', 'send', 'empty.md', 'stuck pane'], seed(fix));
    assert.equal(r2.status, 2, r2.stderr);
    assert.ok(r2.stderr.includes('feedback send: the report must be a non-empty file: empty.md'), r2.stderr);
    assert.equal(fs.readdirSync(fix.fdir).length, 0, 'no file was written');
  } finally { fix.cleanup(); }
});

test('feedback send: an empty summary dies 2', () => {
  const fix = makeFix('ha-feedback-summary-');
  try {
    seed(fix);
    const r1 = fix.cmd(['feedback', 'send', REPORT, ''], seed(fix));
    assert.equal(r1.status, 2, r1.stderr);
    assert.ok(r1.stderr.includes('feedback send: the one-line summary is required'), r1.stderr);
    assert.equal(fs.readdirSync(fix.fdir).length, 0, 'no file was written');
  } finally { fix.cleanup(); }
});

// The file name the send is allowed to produce: from-<project>-<date>.md
// (the date is the child's local date — the test process and the child
// can sit on different time zones, e.g. bun test runs UTC — so the test
// parses the date out of the output instead of comparing it). The suffix
// is '' for the first file of the day, '-b', '-c', … after.
function assertName(fix, file, suffix = '') {
  const prefix = path.join(fix.fdir, `from-${fix.project}-`);
  assert.ok(file.startsWith(prefix), `under feedback_dir, from-<project>-: ${file}`);
  assert.match(file.slice(prefix.length), new RegExp(`^\\d{4}-\\d{2}-\\d{2}${suffix}\\.md$`), `local date + ${suffix || ''} suffix: ${file}`);
}

test('feedback send: without feedback_to it files the report and prints the sent JSON', () => {
  const fix = makeFix('ha-feedback-noto-');
  try {
    const body = 'dispatch waited 900s and the pane was stuck on the same screen\n';
    seed(fix, body);
    const r = fix.cmd(['feedback', 'send', REPORT, 'stuck pane'], seed(fix));
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assertName(fix, j.file);
    assert.equal(r.stdout, `{"status":"sent","file":"${j.file}","notified":null}\n`, 'one JSON line, the exact field order, notified null');
    assert.equal(fs.readFileSync(j.file, 'utf8'), body, 'the report content, verbatim');
    assert.equal(fix.promptLines().length, 0, 'no prompt without feedback_to');
    const note = fix.logLines().filter((l) => l.split('\t')[1] === 'note');
    assert.equal(note.length, 1, 'one note line');
    const f = note[0].split('\t');
    assert.equal(f[2], 'feedback', 'the command column is feedback');
    assert.equal(f[3], `feedback sent: ${j.file}`, 'the note message');
  } finally { fix.cleanup(); }
});

test('feedback send: with feedback_to it prompts the one line to that pane', () => {
  const fix = makeFix('ha-feedback-to-');
  try {
    seed(fix);
    const env = { ...seed(fix), HERDR_AGENTS_FEEDBACK_TO: 'w9:p2' };
    const r = fix.cmd(['feedback', 'send', REPORT, 'the lane review worker never wrote the report'], env);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assertName(fix, j.file);
    assert.equal(r.stdout, `{"status":"sent","file":"${j.file}","notified":"w9:p2"}\n`);
    assert.ok(fs.existsSync(j.file), 'the file was written');
    const lines = fix.promptLines();
    assert.equal(lines.length, 1, 'one prompt');
    const f = lines[0].split('\t');
    assert.equal(f[0], 'w9:p2', 'the pane from feedback_to');
    assert.equal(f[1], `herdr-agents feedback from ${fix.project} (ws): the lane review worker never wrote the report — ${j.file}`,
      'the exact one-line text (workspace in parentheses, em dash, destination)');
    const note = fix.logLines().filter((l) => l.split('\t')[1] === 'note');
    assert.equal(note.length, 1, 'the note line is still recorded on success');
  } finally { fix.cleanup(); }
});

test('feedback send: a second send the same day takes -b and the first file stays intact', () => {
  const fix = makeFix('ha-feedback-suffix-');
  try {
    seed(fix);
    const env = seed(fix);
    const r1 = fix.cmd(['feedback', 'send', REPORT, 'first friction'], env);
    assert.equal(r1.status, 0, r1.stderr);
    const file1 = JSON.parse(r1.stdout).file;
    assertName(fix, file1);
    const r2 = fix.cmd(['feedback', 'send', REPORT, 'second friction'], env);
    assert.equal(r2.status, 0, r2.stderr);
    const file2 = JSON.parse(r2.stdout).file;
    assert.equal(file2, `${file1.slice(0, -3)}-b.md`, 'the -b name of the first file of the day');
    assert.equal(fs.readFileSync(file1, 'utf8'), 'dispatch waited 900s and the pane was stuck on the same screen\n', 'the first file is intact');
    assert.ok(fs.existsSync(file2), 'the second file exists');
    const notes = fix.logLines().filter((l) => l.split('\t')[1] === 'note');
    assert.equal(notes.length, 2, 'one note per send');
  } finally { fix.cleanup(); }
});

// Mutation captured: a summary whose \n is NOT replaced by a space opens a
// second line in the prompt (the one-line and the exact-text asserts break).
test('feedback send: \\r, \\n and \\t in the summary become spaces (one prompt line)', () => {
  const fix = makeFix('ha-feedback-san-');
  try {
    seed(fix);
    const env = { ...seed(fix), HERDR_AGENTS_FEEDBACK_TO: 'w9:p2' };
    const r = fix.cmd(['feedback', 'send', REPORT, 'first\r\nsecond\tthird'], env);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assertName(fix, j.file);
    assert.equal(r.stdout, `{"status":"sent","file":"${j.file}","notified":"w9:p2"}\n`, 'the JSON line carries no raw newline');
    const lines = fix.promptLines();
    assert.equal(lines.length, 1, 'one physical prompt line');
    const f = lines[0].split('\t');
    assert.equal(f[1], `herdr-agents feedback from ${fix.project} (ws): first second third — ${j.file}`, 'the sanitized summary');
  } finally { fix.cleanup(); }
});

// Mutation captured: the prompt-failure path that overwrites nothing but
// reports `sent` (or drops the file) breaks the exit 4 / filed-JSON /
// file-stays / warn-line asserts below.
test('feedback send: a failed prompt keeps the file, prints filed JSON and warns (exit 4)', () => {
  const fix = makeFix('ha-feedback-fail-');
  try {
    seed(fix);
    fs.writeFileSync(fix.promptFail, '1\n');
    const env = { ...seed(fix), HERDR_AGENTS_FEEDBACK_TO: 'w9:p2' };
    const r = fix.cmd(['feedback', 'send', REPORT, 'stuck pane'], env);
    assert.equal(r.status, 4, `exit 4, stderr ${r.stderr}`);
    const j = JSON.parse(r.stdout);
    assertName(fix, j.file);
    assert.equal(r.stdout, `{"status":"filed","file":"${j.file}","notified":null,"error":"prompt failed: the fake refused"}\n`);
    assert.ok(fs.existsSync(j.file), 'the file stays on a failed notice');
    const warns = fix.logLines().filter((l) => l.split('\t')[1] === 'warning');
    assert.equal(warns.length, 1, 'one warn line');
    assert.ok(warns[0].includes('feedback send: the notice to w9:p2 failed: prompt failed: the fake refused'), warns.join('\n'));
    const notes = fix.logLines().filter((l) => l.split('\t')[1] === 'note');
    assert.equal(notes.length, 0, 'no note line on the failed send');
    // The notice failure is a herdr failure, not a usage error: the warn
    // message keeps the four TSV columns.
    assert.equal(warns[0].split('\t').length, 4, 'four TSV columns');
  } finally { fix.cleanup(); }
});

test('feedback send: feedback_dir and feedback_to written by config set in a layer are read', () => {
  const fix = makeFix('ha-feedback-configset-');
  try {
    seed(fix);
    // The project layer gets the two keys from config set (the keys are
    // registered scalar keys, so config set accepts them).
    const s1 = fix.cmd(['config', 'set', 'feedback_dir', fix.fdir]);
    assert.equal(s1.status, 0, `config set feedback_dir: ${s1.stderr}`);
    assert.ok(s1.stdout.includes(`set feedback_dir=${fix.fdir}`), s1.stdout);
    const s2 = fix.cmd(['config', 'set', 'feedback_to', 'w9:p2']);
    assert.equal(s2.status, 0, `config set feedback_to: ${s2.stderr}`);
    assert.ok(s2.stdout.includes('set feedback_to=w9:p2'), s2.stdout);
    // No HERDR_AGENTS_* env for the keys: feedback send reads them from
    // the project file (the policy still comes from the env).
    const r = fix.cmd(['feedback', 'send', REPORT, 'stuck pane'], { HERDR_AGENTS_FEEDBACK: 'local' });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assertName(fix, j.file);
    assert.equal(r.stdout, `{"status":"sent","file":"${j.file}","notified":"w9:p2"}\n`);
    assert.ok(fs.existsSync(j.file), 'the file was written under the config-set feedback_dir');
    const lines = fix.promptLines();
    assert.equal(lines.length, 1, 'one prompt');
    const f = lines[0].split('\t');
    assert.equal(f[0], 'w9:p2', 'the pane from the config-set feedback_to');
    assert.equal(f[1], `herdr-agents feedback from ${fix.project} (ws): stuck pane — ${j.file}`, 'the prompt text');
  } finally { fix.cleanup(); }
});
