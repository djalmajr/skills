// The `release` command (port slice 6a): the roster guard (rc 3), the
// unqueryable-worker guard (rc 4, --force bypass), the still-working report
// guard (rc 3) — which also covers the pane of a temporary (burst) worker,
// whose pane closes on release without --close and prints `closed pane <p>
// (temporary)` — closing only the panes this skill created, clearing the
// pane title when the pane stays open, removing the roster row and the
// report/task/wait files, and the regrid-vs-relabel decision (regrid off:
// the relabel).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeFakeCli } from './fakes.mjs';
import { nodeBin, JS_ENTRY } from './parity.mjs';

const HERDR_FAKE = `
import fs from 'node:fs';
const argv = process.argv.slice(2);
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, argv.join(' ') + '\\n');
const live = () => {
  try { return (JSON.parse(fs.readFileSync(process.env.FAKE_LIVE, 'utf8')).agents) ?? []; } catch { return []; }
};
const cmd = (argv[0] ?? '') + ' ' + (argv[1] ?? '');
if (cmd === 'agent get') {
  const t = argv[2] ?? '';
  if (t === 'unq') {
    process.stderr.write('Error: Os { code: 13, kind: PermissionDenied, message: "Permission denied" }\\n');
    process.exit(1);
  }
  if (t === 'gone') {
    process.stderr.write('{"error":{"code":"agent_not_found","message":"gone"}}\\n');
    process.exit(1);
  }
  const a = live().find((x) => x && ((x.name ?? '') === t || x.pane_id === t));
  const out = a
    ? { name: a.name, agent_status: a.agent_status ?? 'idle' }
    : { name: t, agent_status: 'idle' };
  process.stdout.write(JSON.stringify({ result: { agent: out } }) + '\\n');
} else if (cmd === 'agent list') {
  process.stdout.write(JSON.stringify({ result: { agents: live() } }) + '\\n');
} else if (cmd === 'pane list') {
  process.stdout.write('{"result":{"panes":[]}}\\n');
} else if (cmd === 'pane close') {
  if (process.env.FAKE_PANECLOSE_FAIL) { process.stderr.write('close failed\\n'); process.exit(1); }
  process.stdout.write('{"result":{}}\\n');
} else if (cmd === 'pane report-metadata') {
  process.stdout.write('{"result":{}}\\n');
} else {
  process.stderr.write('unexpected: ' + argv.join(' ') + '\\n');
  process.exit(1);
}
`;

// A roster row for the fixtures: 12 columns by default, or 13 with the
// `burst` marker (a temporary worker); created_pane defaults to 1.
const ROW = (name, role, opts = {}) => {
  const created = opts.created === undefined ? '1' : opts.created;
  const burst = opts.burst ? 'burst' : '';
  return `${name}\tp-${name}\tgrok\t${role}\txai\t${created}\t/tmp/work\tnow\tgrok-4.7\tfull\t${role}\tbuild${burst ? `\t${burst}` : ''}`;
};

function makeFix(prefix) {
  let root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  root = fs.realpathSync(root);
  const bin = path.join(root, 'bin');
  const repo = path.join(root, 'repo');
  const state = path.join(root, 'state');
  const ws = path.join(state, 'ws');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(path.join(ws, 'reports'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'wait'), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
  writeFakeCli(bin, 'herdr', HERDR_FAKE);
  const env = {
    HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'conf'),
    TMPDIR: path.join(root, 'tmp'),
    HERDR_AGENTS_DIR: state,
    HERDR_WORKSPACE_ID: 'ws',
    HERDR_ENV: '1',
    HERDR_AGENTS_REGRID: 'off',
    FAKE_LIVE: path.join(root, 'live.json'),
    FAKE_LOG: path.join(root, 'herdr.log'),
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  };
  fs.mkdirSync(path.join(root, 'home'), { recursive: true });
  fs.mkdirSync(path.join(root, 'conf'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  fs.writeFileSync(env.FAKE_LIVE, JSON.stringify({ agents: [] }));
  const fix = {
    root, repo, state, ws, env,
    writeRoster(...rows) {
      fs.writeFileSync(path.join(ws, 'agents.tsv'),
        '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\tmodel\tapprovals\troles\tlane\n' + rows.join('\n') + '\n');
    },
    row(name) {
      try {
        const lines = fs.readFileSync(path.join(ws, 'agents.tsv'), 'utf8').trim().split('\n');
        return lines.filter((l) => l.split('\t')[0] === name).at(-1) ?? '';
      } catch { return ''; }
    },
    live(agents) { fs.writeFileSync(env.FAKE_LIVE, JSON.stringify({ agents })); },
    reportPointer(agent, p) {
      fs.writeFileSync(path.join(ws, `last-report-${agent}`), p + '\n');
      return p;
    },
    reportFile(agent, content) {
      const p = path.join(ws, 'reports', `${agent}.md`);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
      return fix.reportPointer(agent, p);
    },
    logLines() { try { return fs.readFileSync(env.FAKE_LOG, 'utf8').trim().split('\n'); } catch { return []; } },
    clearLog() { fs.writeFileSync(env.FAKE_LOG, ''); },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
  fix.writeRoster();
  return fix;
}

function runRelease(fix, args) {
  return spawnSync(nodeBin(), [JS_ENTRY, 'release', ...args], { env: fix.env, cwd: fix.repo, encoding: 'utf8', timeout: 30000 });
}

test('release: a plain worker keeps its pane, the title is cleared, the row is gone', () => {
  const fix = makeFix('ha-release-1-');
  try {
    fix.writeRoster(ROW('w1', 'implementer'));
    fix.live([{ name: 'w1', pane_id: 'p-w1', agent_status: 'idle' }]);
    fix.reportFile('w1', 'done');
    fix.clearLog();
    const r = runRelease(fix, ['w1']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('released w1'), r.stdout);
    assert.ok(fix.logLines().some((l) => l === 'pane close p-w1') === false, 'no pane close');
    assert.ok(fix.logLines().some((l) => l.startsWith('pane report-metadata p-w1 ') && l.includes('--clear-title')), fix.logLines().join('\n'));
    assert.equal(fix.row('w1'), '', 'the roster row is removed');
    assert.ok(!fs.existsSync(path.join(fix.ws, 'last-report-w1')), 'the report pointer is removed');
    // Mutation captured: closing the pane without --close, keeping the row,
    // or skipping the title clear.
  } finally { fix.cleanup(); }
});

test('release --close closes the pane this skill created (plain message)', () => {
  const fix = makeFix('ha-release-2-');
  try {
    fix.writeRoster(ROW('w1', 'implementer'));
    fix.live([{ name: 'w1', pane_id: 'p-w1', agent_status: 'idle' }]);
    fix.reportFile('w1', 'done');
    fix.clearLog();
    const r = runRelease(fix, ['w1', '--close']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('closed pane p-w1\n'), r.stdout);
    assert.ok(!r.stdout.includes('(temporary)'), 'no suffix for a plain worker');
    assert.ok(r.stdout.includes('released w1'), r.stdout);
    assert.ok(fix.logLines().some((l) => l === 'pane close p-w1'), fix.logLines().join('\n'));
    assert.ok(fix.logLines().some((l) => l.includes('--clear-title')) === false, 'no title clear when the pane closes');
    assert.equal(fix.row('w1'), '');
  } finally { fix.cleanup(); }
});

test('release: a temporary (burst) worker closes its pane without --close, (temporary) suffix', () => {
  const fix = makeFix('ha-release-3-');
  try {
    fix.writeRoster(ROW('docs', 'documenter', { burst: true }));
    fix.live([{ name: 'docs', pane_id: 'p-docs', agent_status: 'idle' }]);
    fix.reportFile('docs', 'done');
    fix.clearLog();
    const r = runRelease(fix, ['docs']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('closed pane p-docs (temporary)\n'), r.stdout);
    assert.ok(fix.logLines().some((l) => l === 'pane close p-docs'), fix.logLines().join('\n'));
    assert.equal(fix.row('docs'), '');
    // With --close the same (temporary) message: the pane is a burst pane.
    fix.writeRoster(ROW('docs', 'documenter', { burst: true }));
    fix.clearLog();
    const r2 = runRelease(fix, ['docs', '--close']);
    assert.equal(r2.status, 0, r2.stderr);
    assert.ok(r2.stdout.includes('closed pane p-docs (temporary)\n'), r2.stdout);
    // Mutation captured: not closing the burst pane without --close, a plain
    // (no-suffix) message for a burst pane, or keeping the row.
  } finally { fix.cleanup(); }
});

test('release: a working burst worker with a pending report dies 3, --force releases it', () => {
  const fix = makeFix('ha-release-4-');
  try {
    fix.writeRoster(ROW('docs', 'documenter', { burst: true }));
    fix.live([{ name: 'docs', pane_id: 'p-docs', agent_status: 'working' }]);
    // The pointer exists, the report does not (the worker has not written).
    fix.reportPointer('docs', path.join(fix.ws, 'reports', 'docs.md'));
    fix.clearLog();
    const r = runRelease(fix, ['docs']);
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /agent 'docs' is still working and has not written .*; closing now discards its work/);
    assert.ok(fix.logLines().some((l) => l === 'pane close p-docs') === false, 'no pane close on the refusal');
    assert.equal(fix.row('docs') !== '', true, 'the row stays');
    // --force bypasses the guard: the pane closes (temporary).
    fix.clearLog();
    const r2 = runRelease(fix, ['docs', '--force']);
    assert.equal(r2.status, 0, r2.stderr);
    assert.ok(r2.stdout.includes('closed pane p-docs (temporary)\n'), r2.stdout);
    // The same guard for a plain --close release (behavior unchanged).
    fix.writeRoster(ROW('w1', 'implementer'));
    fix.live([{ name: 'w1', pane_id: 'p-w1', agent_status: 'working' }]);
    fix.reportPointer('w1', path.join(fix.ws, 'reports', 'w1.md'));
    const r3 = runRelease(fix, ['w1', '--close']);
    assert.equal(r3.status, 3, r3.stderr);
    assert.match(r3.stderr, /closing now discards its work/);
    // Mutation captured: the burst pane released while working without the
    // guard (or with --force ignored), or the refusal closing the pane.
  } finally { fix.cleanup(); }
});

test('release: guards — not in roster (3), unqueryable without --force (4), not-created pane never closes', () => {
  const fix = makeFix('ha-release-5-');
  try {
    // Not in the roster.
    const r = runRelease(fix, ['nobody']);
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /agent 'nobody' is not in the roster/);
    // Unqueryable (herdr agent get fails) with no report: 4; --force passes.
    fix.writeRoster(ROW('unq', 'implementer'));
    let r2 = runRelease(fix, ['unq']);
    assert.equal(r2.status, 4, r2.stderr);
    assert.match(r2.stderr, /herdr agent get failed/);
    fix.reportFile('unq', 'done');
    const r3 = runRelease(fix, ['unq', '--close', '--force']);
    assert.equal(r3.status, 0, r3.stderr);
    assert.ok(r3.stdout.includes('closed pane p-unq\n'), r3.stdout);
    // A pane not created by this skill is never closed (warn, row removed).
    fix.writeRoster(ROW('ext', 'implementer', { created: '0' }));
    fix.live([{ name: 'ext', pane_id: 'p-ext', agent_status: 'idle' }]);
    fix.reportFile('ext', 'done');
    fix.clearLog();
    const r4 = runRelease(fix, ['ext', '--close']);
    assert.equal(r4.status, 0, r4.stderr);
    assert.match(r4.stderr, /pane p-ext was not created by this skill; not closing it/);
    assert.ok(fix.logLines().some((l) => l === 'pane close p-ext') === false, 'no pane close');
    assert.equal(fix.row('ext'), '');
    // A burst worker in a not-created pane: closes is false (created 0), the
    // pane stays open and the title is cleared.
    fix.writeRoster(ROW('extb', 'documenter', { created: '0', burst: true }));
    fix.live([{ name: 'extb', pane_id: 'p-extb', agent_status: 'idle' }]);
    fix.reportFile('extb', 'done');
    fix.clearLog();
    const r5 = runRelease(fix, ['extb']);
    assert.equal(r5.status, 0, r5.stderr);
    assert.ok(fix.logLines().some((l) => l === 'pane close p-extb') === false, 'no pane close (created 0)');
    assert.ok(fix.logLines().some((l) => l.startsWith('pane report-metadata p-extb ') && l.includes('--clear-title')), fix.logLines().join('\n'));
    // Mutation captured: closing a not-created pane, skipping the roster
    // guard, or --force not bypassing the unqueryable refusal.
  } finally { fix.cleanup(); }
});

test('release: an unknown option is a usage error (2)', () => {
  const fix = makeFix('ha-release-6-');
  try {
    fix.writeRoster(ROW('w1', 'implementer'));
    const r = runRelease(fix, ['w1', '--bogus']);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /release: unknown option --bogus/);
  } finally { fix.cleanup(); }
});
