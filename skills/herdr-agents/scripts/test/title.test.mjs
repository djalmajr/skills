// title: unit tests for lib/commands/title.mjs — the orchestrator
// pane's title. `title <objective>…` joins the positionals with one space
// and stores `orchestrator: <objective>` (newlines/tabs → a space, edges
// trimmed, cut at 60 code points without an ellipsis) via
// `herdr pane report-metadata` on HERDR_PANE_ID, printing
// {"pane_id","title"} on stdout; `--clear` clears the title (and refuses
// an objective given with it, rc 2); no objective
// (or only spaces) dies 2, an unknown `--option` dies 2 naming it, and a
// failing `report-metadata` dies 4. The fake `herdr` (writeFakeCli)
// records every call and refuses a malformed report-metadata shape; it is
// the only herdr the code sees — no real herdr, no agent CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { JS_ENTRY, nodeBin, fixtureEnv } from './parity.mjs';
import { writeFakeCli } from './fakes.mjs';

let ROOT;
let HOME;
let CONF;
let STATE;
let TMP;
let BIN;
let CWD;
let ENV;
let LOG_FILE;
let METAFAIL_FILE;

// Fake herdr: logs every call (LOG_FILE); `pane report-metadata <pane>
// --source herdr-agents (--title <t> | --clear-title)` exits 1 when
// METAFAIL exists or the shape is malformed, 0 otherwise; anything else is
// a failure (the command under test never calls it).
const HERDR_FAKE = [
  "import fs from 'node:fs';",
  'const a = process.argv.slice(2);',
  "fs.appendFileSync(process.env.HERDR_LOG, a.join(' ') + '\\n');",
  "if (a[0] === 'pane' && a[1] === 'report-metadata') {",
  "  if (a.length < 5 || a[3] !== '--source' || a[4] !== 'herdr-agents') { process.stderr.write('bad shape\\n'); process.exit(1); }",
  "  const hasTitle = a[5] === '--title' && a.length === 7;",
  "  const hasClear = a[5] === '--clear-title' && a.length === 6;",
  "  if (!hasTitle && !hasClear) { process.stderr.write('bad flags\\n'); process.exit(1); }",
  "  if (fs.existsSync(process.env.HERDR_METAFAIL)) { process.stderr.write('meta boom\\n'); process.exit(1); }",
  '  process.exit(0);',
  '}',
  "process.stderr.write('unexpected: ' + a.join(' ') + '\\n');",
  'process.exit(1);',
].join('\n') + '\n';

test.before(() => {
  ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ha-title-unit-')));
  HOME = path.join(ROOT, 'home');
  CONF = path.join(ROOT, 'conf');
  STATE = path.join(ROOT, 'state');
  TMP = path.join(ROOT, 'tmp');
  BIN = path.join(ROOT, 'bin');
  CWD = path.join(ROOT, 'cwd');
  for (const d of [HOME, CONF, STATE, TMP, BIN, CWD]) fs.mkdirSync(d, { recursive: true });
  writeFakeCli(BIN, 'herdr', HERDR_FAKE);
  LOG_FILE = path.join(ROOT, 'herdr.log');
  METAFAIL_FILE = path.join(ROOT, 'metafail');
  ENV = fixtureEnv({
    HOME, XDG_CONFIG_HOME: CONF, HERDR_AGENTS_DIR: STATE, HERDR_WORKSPACE_ID: 'ws', TMPDIR: TMP,
    HERDR_ENV: '1', HERDR_PANE_ID: 'p1', HERDR_TAB_ID: 't1',
    HERDR_LOG: LOG_FILE, HERDR_METAFAIL: METAFAIL_FILE,
    PATH: `${BIN}${path.delimiter}/usr/bin${path.delimiter}/bin`,
  });
});
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

// Run `title <args…>` as a child process from a clean slate (state, herdr
// log); `metafail` makes the fake report-metadata exit 1.
function e2e(args, { env = {}, metafail = false } = {}) {
  fs.rmSync(STATE, { recursive: true, force: true });
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(LOG_FILE, '');
  if (metafail) fs.writeFileSync(METAFAIL_FILE, ''); else fs.rmSync(METAFAIL_FILE, { force: true });
  const r = spawnSync(nodeBin(), [JS_ENTRY, 'title', ...args], {
    cwd: CWD, env: { ...ENV, ...env }, encoding: 'utf8', timeout: 20000,
  });
  return {
    rc: r.status === null ? -1 : r.status,
    out: r.stdout ?? '',
    err: r.stderr ?? '',
    log: () => fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter((l) => l !== ''),
  };
}

// Mutation captured: title storing only the first positional (or joining
// the rest with anything other than one space).
test('title: the positionals are joined with one space and stored once', { timeout: 30000 }, () => {
  const r = e2e(['a', 'b']);
  assert.equal(r.rc, 0, `rc ${r.rc}: ${r.err}`);
  assert.equal(r.out, `${JSON.stringify({ pane_id: 'p1', title: 'orchestrator: a b' }, null, 2)}\n`);
  assert.deepEqual(r.log(), ['pane report-metadata p1 --source herdr-agents --title orchestrator: a b']);
});

// Mutation captured: cutting by UTF-16 units (String.prototype.slice)
// instead of code points.
test('title: a 70-code-point objective is cut at 60 (astral chars counted once)', { timeout: 30000 }, () => {
  const text = '\u{1D546}'.repeat(5) + 'x'.repeat(65); // 70 code points, 75 UTF-16 units
  const title = `orchestrator: ${'\u{1D546}'.repeat(5)}${'x'.repeat(55)}`;
  const r = e2e([text]);
  assert.equal(r.rc, 0, `rc ${r.rc}: ${r.err}`);
  assert.equal(r.out, `${JSON.stringify({ pane_id: 'p1', title }, null, 2)}\n`);
  assert.deepEqual(r.log(), [`pane report-metadata p1 --source herdr-agents --title ${title}`]);
});

// Mutation captured: --clear storing an empty title instead of clearing it
// (a --title flag instead of --clear-title).
test('title: --clear clears the pane title and prints the empty title', { timeout: 30000 }, () => {
  const r = e2e(['--clear']);
  assert.equal(r.rc, 0, `rc ${r.rc}: ${r.err}`);
  assert.equal(r.out, `${JSON.stringify({ pane_id: 'p1', title: '' }, null, 2)}\n`);
  assert.deepEqual(r.log(), ['pane report-metadata p1 --source herdr-agents --clear-title']);
});

// Mutation captured: an empty (or whitespace-only) objective exiting 0 or
// a different code instead of dieFriction 2.
test('title: no objective (or only spaces) dies 2 without touching herdr', { timeout: 30000 }, () => {
  for (const args of [[], ['   ']]) {
    const r = e2e(args);
    assert.equal(r.rc, 2, `rc ${r.rc} for ${JSON.stringify(args)}: ${r.err}`);
    assert.ok(r.err.includes('herdr-agents: title: give the current objective, or --clear'), r.err);
    assert.equal(r.out, '');
    assert.equal(r.log().length, 0, 'no herdr call');
    const friction = fs.readFileSync(path.join(STATE, 'ws', 'friction.log'), 'utf8');
    assert.ok(friction.includes('error(exit 2)'), friction);
  }
});

// Mutation captured: unknown --options silently accepted (or the option
// missing from the message).
test('title: an unknown option dies 2 naming it', { timeout: 30000 }, () => {
  const r = e2e(['--bogus', 'x']);
  assert.equal(r.rc, 2, `rc ${r.rc}: ${r.err}`);
  assert.ok(r.err.includes('herdr-agents: title: unknown option --bogus'), r.err);
  assert.equal(r.out, '');
  assert.equal(r.log().length, 0, 'no herdr call');
});

// Mutation captured: the report-metadata failure being swallowed (exit 0)
// in either branch.
test('title: a failing report-metadata dies 4 (objective and --clear)', { timeout: 30000 }, () => {
  const r1 = e2e(['migrar', 'presets'], { metafail: true });
  assert.equal(r1.rc, 4, `rc ${r1.rc}: ${r1.err}`);
  assert.ok(r1.err.includes('herdr-agents: title: herdr pane report-metadata failed'), r1.err);
  assert.equal(r1.out, '');
  const r2 = e2e(['--clear'], { metafail: true });
  assert.equal(r2.rc, 4, `rc ${r2.rc}: ${r2.err}`);
  assert.ok(r2.err.includes('herdr-agents: title: herdr pane report-metadata failed'), r2.err);
  assert.equal(r2.out, '');
});

// Mutation captured: separators (newlines/tabs) passing through verbatim
// or edge spaces surviving the trim.
test('title: newlines and tabs become a space, edges trimmed', { timeout: 30000 }, () => {
  const r = e2e(['a\tb\n c  ']);
  assert.equal(r.rc, 0, `rc ${r.rc}: ${r.err}`);
  assert.deepEqual(r.log(), ['pane report-metadata p1 --source herdr-agents --title orchestrator: a b  c']);
});

// Mutation captured: --clear silently winning over (or losing to) an
// objective given with it — the mix is a usage error and nothing is sent.
test('title: --clear with an objective dies 2 and changes nothing', { timeout: 30000 }, () => {
  const r = e2e(['x', '--clear']);
  assert.equal(r.rc, 2, `rc ${r.rc}: ${r.err}`);
  assert.ok(r.err.includes('title: --clear takes no objective'), r.err);
  assert.equal(r.out, '');
  assert.deepEqual(r.log(), []);
});

// Mutation captured: title dropping out of the LIVING set (no require_env,
// so it would run outside Herdr).
test('title: a living command — without HERDR_ENV it refuses with rc 2', { timeout: 30000 }, () => {
  const r = e2e(['x'], { env: { HERDR_ENV: '' } });
  assert.equal(r.rc, 2, `rc ${r.rc}`);
  assert.ok(r.err.includes('not running inside Herdr (HERDR_ENV != 1); refusing to control a session from outside'), r.err);
  assert.equal(r.out, '');
});
