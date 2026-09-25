// collect --verify: the sha256 lines of the agent's last report (the
// `shasum -a 256` format, also inside code blocks) are checked against
// the files — one line per file (`ok`/`changed`/`missing`, relative paths
// resolved against the worker's cwd, roster column 7), the summary
// `verified <n>: ok <a>, changed <b>, missing <c>`, exit 0 when all ok
// and 16 when any changed or missing. No hash lines → the message and
// exit 0; no report → the error collect already gives today. Without
// --verify the collect behavior is unchanged. Run as a child process
// against an isolated state dir; no herdr is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { nodeBin } from './parity.mjs';
import { writeFakeCli } from './fakes.mjs';

const SCRIPTS = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const JS_ENTRY = path.join(SCRIPTS, 'herdr-agents.mjs');

const H12 = '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\tmodel\tapprovals\troles\tlane\n';

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function makeFix(prefix) {
  let root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const state = path.join(root, 'state');
  const ws = path.join(state, 'ws');
  const reports = path.join(ws, 'reports');
  const workerCwd = path.join(root, 'work');
  for (const d of [reports, path.join(ws, 'wait'), workerCwd, path.join(root, 'home'), path.join(root, 'conf')]) {
    fs.mkdirSync(d, { recursive: true });
  }
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
    root, ws, workerCwd, env,
    // The worker's files: a.mjs and b.bin under the worker cwd (relative
    // paths in the report), plus an absolute file at the root.
    files: {
      a: path.join(workerCwd, 'src', 'a.mjs'),
      bin: path.join(workerCwd, 'src', 'b.bin'),
      abs: path.join(root, 'abs-file.txt'),
    },
    writeFiles() {
      fs.mkdirSync(path.dirname(fix.files.a), { recursive: true });
      fs.writeFileSync(fix.files.a, 'const a = 1;\n');
      fs.writeFileSync(fix.files.bin, 'BINARY\x00DATA');
      fs.writeFileSync(fix.files.abs, 'absolute\n');
    },
    roster() {
      fs.writeFileSync(path.join(ws, 'agents.tsv'),
        H12 + `b\tp-b\tgrok\timplementer\txai\t1\t${workerCwd}\tnow\t\tfull\t\t\n`);
    },
    report(body) {
      const p = path.join(reports, 'b-20260925T100000.md');
      fs.writeFileSync(p, body);
      fs.writeFileSync(path.join(ws, 'last-report-b'), `${p}\n`);
      return p;
    },
    // The report body with one sha256 line per file: a.mjs relative,
    // b.bin with the binary-mode `*`, abs-file absolute — all inside a
    // code block, the common shape.
    verifyBody() {
      return `# Report\n\nFiles touched (shasum -a 256):\n\n\`\`\`\n${sha256('const a = 1;\n')}  src/a.mjs\n${sha256('BINARY\x00DATA')}  *src/b.bin\n${sha256('absolute\n')}  ${fix.files.abs}\n\`\`\`\n\ndone.\n`;
    },
    collect(args) {
      return spawnSync(nodeBin(), [JS_ENTRY, 'collect', ...args], { cwd: root, env: fix.env, encoding: 'utf8', timeout: 30_000 });
    },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
  fix.writeFiles();
  fix.roster();
  return fix;
}

test('collect --verify: every file ok exits 0, relative paths use the worker cwd', { timeout: 60000 }, () => {
  const fix = makeFix('ha-collect-verify-ok-');
  try {
    fix.report(fix.verifyBody());
    // Mutation captured: a relative path resolved against the project
    // root (or the process cwd) instead of the worker's cwd turns the two
    // relative files into `missing` here.
    const r = fix.collect(['b', '--verify']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout,
      `ok ${fix.files.a}\nok ${fix.files.bin}\nok ${fix.files.abs}\nverified 3: ok 3, changed 0, missing 0\n`,
      'one line per file, the checked path, then the summary');
  } finally { fix.cleanup(); }
});

test('collect --verify: a changed file is reported and exits 16', { timeout: 60000 }, () => {
  const fix = makeFix('ha-collect-verify-changed-');
  try {
    fix.report(fix.verifyBody());
    fs.writeFileSync(fix.files.a, 'const a = 2; // edited after the report\n');
    // Mutation captured: an exit 0 despite a `changed` file (or a missing
    // summary) breaks the rc and the summary below.
    const r = fix.collect(['b', '--verify']);
    assert.equal(r.status, 16, `rc 16 on changed: ${r.stdout}${r.stderr}`);
    assert.equal(r.stdout,
      `changed ${fix.files.a}\nok ${fix.files.bin}\nok ${fix.files.abs}\nverified 3: ok 2, changed 1, missing 0\n`);
  } finally { fix.cleanup(); }
});

test('collect --verify: a missing file is reported and exits 16', { timeout: 60000 }, () => {
  const fix = makeFix('ha-collect-verify-missing-');
  try {
    fix.report(fix.verifyBody());
    fs.rmSync(fix.files.bin);
    const r = fix.collect(['b', '--verify']);
    assert.equal(r.status, 16, r.stderr);
    assert.equal(r.stdout,
      `ok ${fix.files.a}\nmissing ${fix.files.bin}\nok ${fix.files.abs}\nverified 3: ok 2, changed 0, missing 1\n`);
  } finally { fix.cleanup(); }
});

test('collect --verify: no sha256 lines prints the message and exits 0', { timeout: 60000 }, () => {
  const fix = makeFix('ha-collect-verify-none-');
  try {
    const p = fix.report('# Report\n\nnothing to verify here.\n');
    const r = fix.collect(['b', '--verify']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `no sha256 lines in ${p}\n`);
  } finally { fix.cleanup(); }
});

test('collect --verify: a relative worker cwd resolves against the project root, not the collector cwd', { timeout: 60000 }, () => {
  let root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ha-collect-relcwd-')));
  try {
    // A git repo at the root (projectRoot = git toplevel), the worker's
    // files under <root>/work/src and a directory the collect runs from.
    const elsewhere = path.join(root, 'elsewhere');
    const workSrc = path.join(root, 'work', 'src');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.mkdirSync(workSrc, { recursive: true });
    const aFile = path.join(workSrc, 'a.mjs');
    fs.writeFileSync(aFile, 'const a = 1;\n');
    spawnSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore', timeout: 30_000 });
    const state = path.join(root, 'state');
    const ws = path.join(state, 'ws');
    fs.mkdirSync(path.join(ws, 'reports'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'wait'), { recursive: true });
    const env = {
      HOME: path.join(root, 'home'),
      XDG_CONFIG_HOME: path.join(root, 'conf'),
      TMPDIR: path.join(root, 'tmp'),
      HERDR_AGENTS_DIR: state,
      HERDR_WORKSPACE_ID: 'ws',
      HERDR_ENV: '1',
      PATH: process.env.PATH,
    };
    // Column 7 (cwd) is RELATIVE, as spawn --cwd may store it.
    fs.writeFileSync(path.join(ws, 'agents.tsv'),
      H12 + `b\tp-b\tgrok\timplementer\txai\t1\twork\tnow\t\tfull\t\t\n`);
    const report = path.join(ws, 'reports', 'b-20260925T100000.md');
    fs.writeFileSync(report, `# Report\n\n\`\`\`\n${sha256('const a = 1;\n')}  src/a.mjs\n\`\`\`\n\ndone.\n`);
    fs.writeFileSync(path.join(ws, 'last-report-b'), `${report}\n`);
    // The collect runs from <root>/elsewhere: resolving the worker cwd
    // against the collector cwd would look in <root>/elsewhere/work/src
    // and report the file missing.
    // Mutation captured: a relative worker cwd resolved against the process
    // cwd (or left bare) turns the file into `missing` and the exit into 16
    // when the collect runs from anywhere but the project root.
    const r = spawnSync(nodeBin(), [JS_ENTRY, 'collect', 'b', '--verify'], {
      cwd: elsewhere, env, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout,
      `ok ${aFile}\nverified 1: ok 1, changed 0, missing 0\n`,
      'the relative path resolves under the project root, from any collector cwd');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('collect --verify: a report that exists but cannot be read is an error (exit 4)', { timeout: 60000 }, () => {
  const fix = makeFix('ha-collect-verify-unreadable-');
  try {
    const p = fix.report(fix.verifyBody());
    fs.chmodSync(p, 0o000); // exists, unreadable (the tests do not run as root)
    // A fake herdr on PATH: the friction log is only live with herdr on
    // PATH, and the verify error must land there as a collect entry.
    const bin = path.join(fix.root, 'bin');
    fs.mkdirSync(bin);
    writeFakeCli(bin, 'herdr', `process.stdout.write('{"result":{"agent":{"name":"b","agent_status":"working"}}}\\n');\n`);
    const env = { ...fix.env, PATH: `${bin}${path.delimiter}${fix.env.PATH}` };
    const r = spawnSync(nodeBin(), [JS_ENTRY, 'collect', 'b', '--verify'], { cwd: fix.root, env, encoding: 'utf8', timeout: 30_000 });
    // Mutation captured: treating the unreadable report as "no sha256
    // lines" (exit 0 with the message) or as a `missing` file (exit 16)
    // breaks the rc and the stderr message below.
    assert.equal(r.status, 4, `exit 4 on an unreadable report: ${r.stdout}${r.stderr}`);
    assert.equal(r.stdout, '', 'nothing is verified without the report content');
    assert.ok(r.stderr.includes(`collect --verify: cannot read ${p}`), r.stderr);
    // The verify error lands in the friction log as a collect entry.
    const friction = fs.readFileSync(path.join(fix.ws, 'friction.log'), 'utf8');
    assert.ok(friction.includes(`error(exit 4)\tcollect\tcollect --verify: cannot read ${p}`), friction);
  } finally { fix.cleanup(); }
});

// D54: the original report under the $TMPDIR routing dir may be gone
// (the system cleaned it): when the pointer path no longer exists and the
// mirror the wait made sits at <state>/reports/<same name>, collect reads
// the copy (with --verify too). No copy: today's behavior.
test('collect: a gone $TMPDIR original is read from the state-dir copy', { timeout: 60000 }, () => {
  const fix = makeFix('ha-collect-copy-');
  try {
    const tmpReports = path.join(fix.env.TMPDIR, 'herdr-agents', 'ws', 'reports');
    fs.mkdirSync(tmpReports, { recursive: true });
    const orig = path.join(tmpReports, 'b-20260925T100000.md');
    const copy = path.join(fix.ws, 'reports', 'b-20260925T100000.md');
    // (a) plain collect: the original is gone, the mirror stands — the
    // copy is printed under its own marker.
    fs.writeFileSync(orig, '# Report\n\ndone.\n');
    fs.writeFileSync(copy, '# Report\n\ndone.\n');
    fs.writeFileSync(path.join(fix.ws, 'last-report-b'), orig + '\n');
    fs.rmSync(orig);
    let r = fix.collect(['b']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `<!-- report: ${copy} -->\n# Report\n\ndone.\n`, 'the copy is printed under its marker');
    // (b) --verify: the sha lines are read from the copy; the project
    // files are checked as usual.
    const body = fix.verifyBody();
    fs.writeFileSync(orig, body);
    fs.writeFileSync(copy, body);
    fs.writeFileSync(path.join(fix.ws, 'last-report-b'), orig + '\n');
    fs.rmSync(orig);
    r = fix.collect(['b', '--verify']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout,
      `ok ${fix.files.a}\nok ${fix.files.bin}\nok ${fix.files.abs}\nverified 3: ok 3, changed 0, missing 0\n`,
      'verified from the copy: ' + r.stdout + r.stderr);
    // (c) no copy: today's behavior (the pointer stays, the fallback
    // error stands).
    fs.rmSync(copy);
    r = fix.collect(['b']);
    assert.equal(r.status, 4, r.stderr);
    assert.match(r.stderr, /no report file yet for 'b'/, 'no copy: the fallback error: ' + r.stderr);
    assert.equal(r.stdout, '', 'nothing is printed without the original or the copy');
    // Mutation captured: the fallback to <state>/reports/<same name>
    // missing (or matching by a different name) fails case (a) and the
    // --verify case; a fallback that fires while the original still
    // exists would change the marker of every tmp-routed collect.
  } finally { fix.cleanup(); }
});

test('collect --verify: no report keeps the error collect already gives', { timeout: 60000 }, () => {
  const fix = makeFix('ha-collect-verify-noreport-');
  try {
    // b is in the roster (a live worker) but has no report file: the
    // unqueryable-roster error (herdr absent here: exit 4 with the warn).
    const r = fix.collect(['b', '--verify']);
    assert.equal(r.status, 4, r.stderr);
    assert.match(r.stderr, /no report file yet for 'b'/);
    assert.equal(r.stdout, '', 'nothing is verified without a report');
  } finally { fix.cleanup(); }
});

// An agent still working (or blocked) with no report gets the short
// status line plus the wait pointer (exit 4) — never the terminal: the
// terminal only helps once the agent has stopped. An explicit --lines
// forces the terminal anyway; idle, done, gone and the not-in-roster
// cases keep the fallback.
test('collect: a working agent without a report gets the wait pointer, not the terminal', { timeout: 60000 }, () => {
  const fix = makeFix('ha-collect-working-');
  try {
    // The expected report path is recorded (as dispatch does) but the
    // file does not exist yet.
    const expected = path.join(fix.ws, 'reports', 'b-later.md');
    fs.writeFileSync(path.join(fix.ws, 'last-report-b'), `${expected}\n`);
    // A fake herdr: `agent get` reports the state from FAKE_STATE;
    // `agent read` prints a marker so a fallback is detectable.
    const bin = path.join(fix.root, 'bin');
    fs.mkdirSync(bin);
    writeFakeCli(bin, 'herdr', `const a = process.argv.slice(2).join(' ');
if (a.startsWith('agent get')) process.stdout.write(JSON.stringify({ result: { agent: { name: 'b', agent_status: process.env.FAKE_STATE || 'working' } } }) + '\\n');
else if (a.startsWith('agent read')) process.stdout.write('terminal-output\\n');
`);
    const run = (state, extra = []) => spawnSync(nodeBin(), [JS_ENTRY, 'collect', 'b', ...extra], {
      cwd: fix.root,
      env: { ...fix.env, PATH: `${bin}${path.delimiter}${fix.env.PATH}`, FAKE_STATE: state },
      encoding: 'utf8',
      timeout: 30_000,
    });
    // working: the short line, exit 4, no terminal on stdout.
    let r = run('working');
    assert.equal(r.status, 4, r.stderr);
    assert.equal(r.stdout, '', 'no terminal while the agent is working: ' + r.stdout);
    assert.ok(r.stderr.includes(`'b' is working and has no report yet (${expected}); wait for it: herdr-agents wait b`), r.stderr);
    // blocked: the same shape with its own state.
    r = run('blocked');
    assert.equal(r.status, 4, r.stderr);
    assert.equal(r.stdout, '', r.stdout);
    assert.ok(r.stderr.includes(`'b' is blocked and has no report yet (${expected}); wait for it: herdr-agents wait b`), r.stderr);
    // --lines forces the terminal fallback even while working.
    r = run('working', ['--lines', '10']);
    assert.equal(r.status, 6, r.stderr);
    assert.ok(r.stdout.includes('terminal-output'), 'the fallback ran: ' + r.stdout);
    assert.ok(r.stderr.includes('falling back to recent terminal output'), r.stderr);
    // A stopped agent (idle) keeps the terminal fallback.
    r = run('idle');
    assert.equal(r.status, 6, r.stderr);
    assert.ok(r.stdout.includes('terminal-output'), 'idle keeps the fallback: ' + r.stdout);
    // Mutation captured: the gate widened to every state (a warn instead
    // of the terminal for idle), the gate skipped the blocked state, the
    // --lines override ignored (no terminal with --lines), or the
    // parenthetical built from the raw file content (a stray newline in
    // the line).
  } finally { fix.cleanup(); }
});

test('collect: without --verify the behavior is unchanged', { timeout: 60000 }, () => {
  const fix = makeFix('ha-collect-plain-');
  try {
    const p = fix.report(fix.verifyBody());
    const r = fix.collect(['b']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.startsWith(`<!-- report: ${p} -->\n`), 'the report marker is kept');
    assert.ok(r.stdout.includes('shasum -a 256'), 'the report is printed verbatim');
    assert.equal(r.stdout.indexOf('verified'), -1, 'no verification output without --verify');
    // --verify and --lines together are accepted; an unknown option dies 2.
    assert.equal(fix.collect(['b', '--verify', '--lines', '10']).status, 0);
    const u = fix.collect(['b', '--nope']);
    assert.equal(u.status, 2, u.stderr);
    assert.match(u.stderr, /collect: unknown option --nope/);
  } finally { fix.cleanup(); }
});
