// setup --plan: unit tests for lib/commands/setup-plan.mjs —
// unifiedDiff (own Myers implementation in the `diff -u` format: new file,
// equal, append at the end, change in the middle, no final newline on both
// sides and on one only, several hunks near and far), confKeys and
// planDiffFile (new/changed/removed keys, comments, CRLF), and the
// nothing-is-written contract of cmdSetupPlan, including when the
// simulation fails. Each test file builds its own temp root (mkdtemp) used
// as HOME, XDG_CONFIG_HOME, TMPDIR and HERDR_AGENTS_DIR, with a temporary
// git repo (brief decision 7); nothing here touches a real `herdr`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { JS_ENTRY, nodeBin, fixtureEnv } from './parity.mjs';
import { confKeys, planDiffFile, planFileDiff, unifiedDiff, cmdSetupPlan } from '../lib/commands/setup-plan.mjs';
import { loadConfig } from '../lib/config.mjs';

let ROOT;
let REPO;
let HOME;
let CONF;
let STATE;
let TMP;
let ENV;

test.before(() => {
  let root = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-setup-plan-unit-'));
  root = fs.realpathSync(root); // git reports the resolved path (macOS /var -> /private/var)
  ROOT = root;
  REPO = path.join(root, 'repo');
  HOME = path.join(root, 'home');
  CONF = path.join(root, 'conf');
  STATE = path.join(root, 'state');
  TMP = path.join(root, 'tmp');
  for (const d of [REPO, HOME, CONF, STATE, TMP]) fs.mkdirSync(d, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: REPO, stdio: 'ignore', timeout: 30000 });
  ENV = fixtureEnv({ HOME, XDG_CONFIG_HOME: CONF, HERDR_AGENTS_DIR: STATE, HERDR_WORKSPACE_ID: 'ws', TMPDIR: TMP });
});
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

// ---------- unifiedDiff ----------

const D = (before, after) => unifiedDiff(before, after, 'f');

test('unifiedDiff: equal contents produce no diff', () => {
  assert.equal(D('a\nb\n', 'a\nb\n'), '');
  assert.equal(D('', ''), '');
});

test('unifiedDiff: a new file is one insertion hunk (old side 0,0)', () => {
  assert.equal(D('', 'x\ny\n'),
    '--- a/f\n' +
    '+++ b/f\n' +
    '@@ -0,0 +1,2 @@\n' +
    '+x\n' +
    '+y\n');
  assert.equal(D('', 'x'),
    '--- a/f\n' +
    '+++ b/f\n' +
    '@@ -0,0 +1 @@\n' +
    '+x\n' +
    '\\ No newline at end of file\n');
});

test('unifiedDiff: an emptied file is one deletion hunk (new side 0,0)', () => {
  assert.equal(D('a\nb\n', ''),
    '--- a/f\n' +
    '+++ b/f\n' +
    '@@ -1,2 +0,0 @@\n' +
    '-a\n' +
    '-b\n');
});

test('unifiedDiff: an append at the end keeps the context and adds the lines', () => {
  assert.equal(D('a\nb\nc\n', 'a\nb\nc\nd\n'),
    '--- a/f\n' +
    '+++ b/f\n' +
    '@@ -1,3 +1,4 @@\n' +
    ' a\n' +
    ' b\n' +
    ' c\n' +
    '+d\n');
  // the context is capped at three lines before and after
  const base = Array.from({ length: 12 }, (_, i) => `l${i + 1}`).join('\n') + '\n';
  const out = base.replace('l9\n', 'CHANGED9\n');
  const want = D(base, out);
  assert.equal(want,
    '--- a/f\n' +
    '+++ b/f\n' +
    '@@ -6,7 +6,7 @@\n' +
    ' l6\n' +
    ' l7\n' +
    ' l8\n' +
    '-l9\n' +
    '+CHANGED9\n' +
    ' l10\n' +
    ' l11\n' +
    ' l12\n');
});

test('unifiedDiff: a change in the middle, deletion before insertion within the block', () => {
  assert.equal(D('a\nb\nc\n', 'a\nB\nc\n'),
    '--- a/f\n' +
    '+++ b/f\n' +
    '@@ -1,3 +1,3 @@\n' +
    ' a\n' +
    '-b\n' +
    '+B\n' +
    ' c\n');
  assert.equal(D('p\n', 'q\n'),
    '--- a/f\n' +
    '+++ b/f\n' +
    '@@ -1 +1 @@\n' +
    '-p\n' +
    '+q\n');
});

test('unifiedDiff: no final newline — markers on the affected ends, once per line', () => {
  // both sides end without a newline: one marker after the deleted old line
  // and one after the inserted new line
  assert.equal(D('a\nb', 'a\nc'),
    '--- a/f\n' +
    '+++ b/f\n' +
    '@@ -1,2 +1,2 @@\n' +
    ' a\n' +
    '-b\n' +
    '\\ No newline at end of file\n' +
    '+c\n' +
    '\\ No newline at end of file\n');
  // only the new side ends without a newline
  assert.equal(D('a\nb\n', 'a\nc'),
    '--- a/f\n' +
    '+++ b/f\n' +
    '@@ -1,2 +1,2 @@\n' +
    ' a\n' +
    '-b\n' +
    '+c\n' +
    '\\ No newline at end of file\n');
  // only the old side ends without a newline
  assert.equal(D('a\nb', 'a\nc\n'),
    '--- a/f\n' +
    '+++ b/f\n' +
    '@@ -1,2 +1,2 @@\n' +
    ' a\n' +
    '-b\n' +
    '\\ No newline at end of file\n' +
    '+c\n');
  // a shared last context line without a newline marks once; the same text
  // with/without the final newline is a different line (replace, not no-op)
  assert.equal(D('a\nb', 'c\nb'),
    '--- a/f\n' +
    '+++ b/f\n' +
    '@@ -1,2 +1,2 @@\n' +
    '-a\n' +
    '+c\n' +
    ' b\n' +
    '\\ No newline at end of file\n');
  assert.equal(D('a\nb', 'a\nb\n'),
    '--- a/f\n' +
    '+++ b/f\n' +
    '@@ -1,2 +1,2 @@\n' +
    ' a\n' +
    '-b\n' +
    '\\ No newline at end of file\n' +
    '+b\n');
});

test('unifiedDiff: several hunks — close edits merge, far edits split', () => {
  const base = Array.from({ length: 14 }, (_, i) => `l${i + 1}`).join('\n') + '\n';
  // 4 kept lines between the edits: one hunk
  const near = base.replace('l3\n', 'CHANGED3\n').replace('l8\n', 'CHANGED8\n');
  assert.equal(D(base, near),
    '--- a/f\n' +
    '+++ b/f\n' +
    '@@ -1,11 +1,11 @@\n' +
    ' l1\n' +
    ' l2\n' +
    '-l3\n' +
    '+CHANGED3\n' +
    ' l4\n' +
    ' l5\n' +
    ' l6\n' +
    ' l7\n' +
    '-l8\n' +
    '+CHANGED8\n' +
    ' l9\n' +
    ' l10\n' +
    ' l11\n');
  // 7 kept lines between the edits: two hunks
  const far = base.replace('l3\n', 'CHANGED3\n').replace('l11\n', 'CHANGED11\n');
  assert.equal(D(base, far),
    '--- a/f\n' +
    '+++ b/f\n' +
    '@@ -1,6 +1,6 @@\n' +
    ' l1\n' +
    ' l2\n' +
    '-l3\n' +
    '+CHANGED3\n' +
    ' l4\n' +
    ' l5\n' +
    ' l6\n' +
    '@@ -8,7 +8,7 @@\n' +
    ' l8\n' +
    ' l9\n' +
    ' l10\n' +
    '-l11\n' +
    '+CHANGED11\n' +
    ' l12\n' +
    ' l13\n' +
    ' l14\n');
  // exactly 6 kept lines between (2 × context): still one hunk (adjacent);
  // the 12-line base ends inside the trailing context, like the macOS diff
  const base12 = Array.from({ length: 12 }, (_, i) => `l${i + 1}`).join('\n') + '\n';
  const six = base12.replace('l3\n', 'CHANGED3\n').replace('l10\n', 'CHANGED10\n');
  const want = D(base12, six);
  assert.equal(want,
    '--- a/f\n' +
    '+++ b/f\n' +
    '@@ -1,12 +1,12 @@\n' +
    ' l1\n' +
    ' l2\n' +
    '-l3\n' +
    '+CHANGED3\n' +
    ' l4\n' +
    ' l5\n' +
    ' l6\n' +
    ' l7\n' +
    ' l8\n' +
    ' l9\n' +
    '-l10\n' +
    '+CHANGED10\n' +
    ' l11\n' +
    ' l12\n');
});

// ---------- confKeys / planDiffFile ----------

let dir = 0;
function fileDir() {
  const d = path.join(ROOT, `plan-files-${dir++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const write = (d, name, text) => {
  const p = path.join(d, name);
  fs.writeFileSync(p, text);
  return p;
};

test('confKeys: distinct keys in file order, comments and odd lines skipped', () => {
  const d = fileDir();
  const f = write(d, 'c.conf', [
    '# whole line comment',
    'panes=3 # inline comment',
    'max_workers = 2',
    'no-equals-line',
    '=value-without-key',
    '  spaced.key = value  ',
    'panes=4',
    'a#b=1',
    '',
    'role.planner.model=fable',
  ].join('\n'));
  assert.deepEqual(confKeys(f), ['panes', 'max_workers', 'spaced.key', 'a#b', 'role.planner.model']);
  assert.deepEqual(confKeys(path.join(d, 'absent.conf')), [], 'absent file: no keys');
  // CRLF is normalized on read (decision 7): same keys as the LF file
  const crlf = write(d, 'crlf.conf', 'panes=3\r\nmax_workers=2\r\n');
  assert.deepEqual(confKeys(crlf), ['panes', 'max_workers']);
});

test('planDiffFile: new, changed, removed and unchanged keys, with the before file absent', () => {
  const d = fileDir();
  const before = write(d, 'before.conf', [
    'panes=3',
    'max_workers=2 # keep',
    'obsolete=1',
    'model.grok.worker=grok',
  ].join('\n'));
  const after = write(d, 'after.conf', [
    'panes=4',
    'max_workers=5 # keep',
    'model.grok.worker=grok',
    'lane.build.kind=pi',
    'new.key=v # new',
  ].join('\n'));
  const line = (k, b, a) => `  ${k.padEnd(20)} ${b} → ${a}\n`;
  assert.equal(planDiffFile(before, after),
    line('panes', '3', '4') +
    line('max_workers', '2', '5') +
    line('obsolete', '1', '(removed)') +
    line('lane.build.kind', '(unset)', 'pi') +
    line('new.key', '(unset)', 'v'));
  // nothing changed: no lines (the caller still prints the path and the
  // blank line)
  assert.equal(planDiffFile(before, before), '');
  // the before file may be absent: every key is (unset); a key only in the
  // absent before is not listed at all
  const absent = planDiffFile(path.join(d, 'absent.conf'), after);
  assert.ok(absent.startsWith(line('panes', '(unset)', '4')), absent);
  assert.ok(absent.includes(line('lane.build.kind', '(unset)', 'pi')), absent);
  assert.ok(!absent.includes('obsolete'), 'absent before: the missing key is not listed');
});

test('planDiffFile: comments do not create keys; the last assignment wins; keys keep their dotted form', () => {
  const d = fileDir();
  const before = write(d, 'b.conf', [
    '# panes=9 is a comment',
    'panes=3',
    'panes=4',
    'role.planner.model=fable',
  ].join('\n'));
  const after = write(d, 'a.conf', [
    '# panes=9 is a comment',
    'panes=2',
    'panes=3',
  ].join('\n'));
  const line = (k, b, a) => `  ${k.padEnd(20)} ${b} → ${a}\n`;
  assert.equal(planDiffFile(before, after),
    line('panes', '4', '3') +
    line('role.planner.model', 'fable', '(removed)'));
});

// ---------- planFileDiff ----------

test('planFileDiff: the path, "(no change)" or the labeled diff, and the blank line', () => {
  const same = 'a\nb\n';
  assert.equal(planFileDiff('/p/file', same, same),
    '/p/file\n' +
    '  (no change)\n' +
    '\n');
  assert.equal(planFileDiff('/p/file', 'a\nb\n', 'a\nc\n'),
    '/p/file\n' +
    '--- a//p/file\n' +
    '+++ b//p/file\n' +
    '@@ -1,2 +1,2 @@\n' +
    ' a\n' +
    '-b\n' +
    '+c\n' +
    '\n');
});

// ---------- cmdSetupPlan: nothing is written ----------

// The content of every file under `d` (excluding .git), plus the dir names,
// sorted by path (dirs get a marker so an empty created dir is caught).
function tree(d) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out.push([r, '<dir>']); walk(p, r); }
      else if (e.isFile()) out.push([r, fs.readFileSync(p, 'utf8')]);
    }
  };
  walk(d, '');
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
const planLeftovers = () =>
  fs.readdirSync(TMP).filter((n) => n.startsWith('herdr-agents-plan.'));

// A full fixture for one e2e run: the repo seed (AGENTS.md, settings.json,
// project config), isolated HOME/XDG/HERDR_AGENTS_DIR/TMPDIR and the node
// entry. `run` captures the trees of repo, user conf and state before and
// after and returns { rc, out, err, unchanged, clean }.
function e2e(seed = {}) {
  fs.rmSync(path.join(REPO, 'AGENTS.md'), { force: true });
  fs.rmSync(path.join(REPO, 'CLAUDE.md'), { force: true });
  fs.rmSync(path.join(REPO, '.claude'), { recursive: true, force: true });
  fs.rmSync(path.join(REPO, '.gitignore'), { force: true });
  fs.rmSync(path.join(REPO, '.agents'), { recursive: true, force: true });
  fs.rmSync(path.join(REPO, '.herdr-agents'), { recursive: true, force: true });
  fs.rmSync(STATE, { recursive: true, force: true });
  fs.mkdirSync(STATE, { recursive: true });
  fs.rmSync(path.join(CONF, 'herdr-agents'), { recursive: true, force: true });
  for (const [rel, text] of Object.entries(seed)) {
    if (rel === 'args' || rel === 'env') continue;
    const p = path.join(REPO, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (text === undefined) fs.mkdirSync(p, { recursive: true }); // a directory seed (trailing /)
    else fs.writeFileSync(p, text);
  }
  const before = {
    repo: tree(REPO), conf: tree(CONF), state: tree(STATE), tmp: planLeftovers(),
  };
  const r = spawnSync(nodeBin(), [JS_ENTRY, ...(seed.args ?? [])], {
    cwd: REPO, env: seed.env ? { ...ENV, ...seed.env } : ENV, encoding: 'utf8', timeout: 60000,
  });
  const after = {
    repo: tree(REPO), conf: tree(CONF), state: tree(STATE), tmp: planLeftovers(),
  };
  return {
    rc: r.status === null ? -1 : r.status,
    out: r.stdout ?? '',
    err: r.stderr ?? '',
    unchanged: JSON.stringify(before.repo) === JSON.stringify(after.repo)
      && JSON.stringify(before.conf) === JSON.stringify(after.conf)
      && JSON.stringify(before.state) === JSON.stringify(after.state),
    clean: after.tmp.length === 0 && before.tmp.length === 0,
  };
}

const AGENTS_SEED = '# Agent instructions\n';
const SETTINGS_SEED = '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"echo keep-me"}]}]}}\n';

test('e2e: setup --plan --panes prints the plan and writes nothing', { timeout: 30000 }, () => {
  const r = e2e({
    args: ['setup', '--plan', '--panes', '4'],
    '.agents/herdr-agents.conf': 'panes=3\n',
    'AGENTS.md': AGENTS_SEED,
    '.claude/settings.json': SETTINGS_SEED,
  });
  assert.equal(r.rc, 0, `rc ${r.rc}: ${r.err}`);
  assert.ok(r.out.startsWith('plan (nothing is written):\n\n'), r.out.slice(0, 80));
  assert.ok(r.out.includes(path.join(REPO, '.agents', 'herdr-agents.conf')), 'project file path');
  assert.ok(r.out.includes('  panes                3 → 4'), r.out);
  assert.ok(r.out.includes('  reuse_workers        (unset) → on'), r.out);
  // The preset file freezes no roles or limits: no lane roles, no
  // max_workers, no split_max_panes in the plan.
  assert.ok(!r.out.includes('lane.build.roles'), r.out);
  assert.ok(!r.out.includes('max_workers'), r.out);
  assert.ok(!r.out.includes('split_max_panes'), r.out);
  assert.ok(r.out.includes(`--- a/${path.join(REPO, 'AGENTS.md')}`), 'block diff label');
  assert.ok(r.out.includes(`+++ b/${path.join(REPO, 'AGENTS.md')}`), 'block diff label');
  assert.ok(r.out.includes('+<!-- herdr-agents:start -->'), 'block marker in the diff');
  assert.ok(r.out.includes(`--- a/${path.join(REPO, '.claude', 'settings.json')}`), 'hooks diff label');
  assert.ok(r.out.includes('UserPromptSubmit') && r.out.includes('SessionStart') && r.out.includes('echo keep-me'), 'hooks diff');
  assert.ok(!fs.existsSync(path.join(STATE, 'ws')), 'the state dir is not created');
  assert.ok(r.unchanged, 'repo, user conf and state trees changed');
  assert.ok(r.clean, 'temp dir leftovers or pre-existing leftovers');
});

test('e2e: --panes 2 plans the 2-pane preset (nothing written)', { timeout: 30000 }, () => {
  const r = e2e({
    args: ['setup', '--plan', '--panes', '2'],
    'AGENTS.md': AGENTS_SEED,
    '.claude/settings.json': SETTINGS_SEED,
  });
  assert.equal(r.rc, 0, `rc ${r.rc}: ${r.err}`);
  assert.ok(r.out.includes('  panes                (unset) → 2'), r.out);
  assert.ok(r.out.includes('  reuse_workers        (unset) → on'), r.out);
  assert.ok(!r.out.includes('lane.build.roles'), r.out);
  assert.ok(r.unchanged && r.clean, 'nothing written, no leftovers');
});

test('e2e: --set, --user-set and --session-set together — the three sections, nothing written', { timeout: 30000 }, () => {
  const r = e2e({
    args: ['setup', '--plan', '--set', 'max_workers', '5', '--user-set', 'model.pi.worker', 'my-provider/my-model', '--session-set', 'lane.build.kind', 'pi'],
    'AGENTS.md': AGENTS_SEED,
    '.claude/settings.json': SETTINGS_SEED,
  });
  assert.equal(r.rc, 0, `rc ${r.rc}: ${r.err}`);
  const projAt = r.out.indexOf(path.join(REPO, '.agents', 'herdr-agents.conf'));
  const userAt = r.out.indexOf(path.join(CONF, 'herdr-agents', 'config'));
  const sessAt = r.out.indexOf(path.join(STATE, 'ws', 'session.conf'));
  assert.ok(projAt >= 0 && userAt > projAt && sessAt > userAt, `section order proj < user < session:\n${r.out}`);
  assert.ok(r.out.includes('  max_workers          (unset) → 5'), r.out);
  assert.ok(r.out.includes('  model.pi.worker      (unset) → my-provider/my-model'), r.out);
  assert.ok(r.out.includes('  lane.build.kind      (unset) → pi'), r.out);
  assert.ok(!fs.existsSync(path.join(CONF, 'herdr-agents', 'config')), 'the user file is not created');
  assert.ok(!fs.existsSync(path.join(STATE, 'ws', 'session.conf')), 'the session file is not created');
  assert.ok(r.unchanged && r.clean, 'nothing written, no leftovers');
});

test('e2e: invalid keys/values and a missing flag value die 2 before anything is shown or written', { timeout: 30000 }, () => {
  for (const [args, frag] of [
    [['setup', '--plan', '--set', 'nope', '1'], "setup --plan: unknown key 'nope'"],
    [['setup', '--plan', '--set', 'max_workers', '-1'], "setup --plan: invalid value '-1' for max_workers"],
    [['setup', '--plan', '--panes', '5'], 'setup --plan: --panes must be 2, 3 or 4'],
    [['setup', '--plan', '--lane', 'build=boguskind'], "setup: unknown kind 'boguskind'"],
    [['setup', '--plan', '--set', 'max_workers'], 'setup --plan: --set expects a value'],
    [['setup', '--plan', '--lane'], 'setup --plan: --lane expects a value'],
    [['setup', '--plan', '--lane', '--panes', '4'], 'setup --plan: --lane expects a value'],
    [['setup', '--plan', '--target'], 'setup --plan: --target expects a value'],
    [['setup', '--plan', '--bogus'], "setup --plan: unknown option '--bogus'"],
  ]) {
    const r = e2e({ args, '.agents/herdr-agents.conf': 'panes=3\n', 'AGENTS.md': AGENTS_SEED, '.claude/settings.json': SETTINGS_SEED });
    assert.equal(r.rc, 2, `${args.join(' ')}: rc ${r.rc}`);
    assert.ok(r.err.includes(frag), `${args.join(' ')}: stderr: ${r.err}`);
    assert.equal(r.out, '', `${args.join(' ')}: nothing on stdout`);
    assert.ok(r.unchanged && r.clean, `${args.join(' ')}: nothing written, no leftovers`);
  }
});

test('e2e: a write the real setup would refuse is refused by the plan (rc 4), file untouched', { timeout: 30000 }, () => {
  const r = e2e({
    args: ['setup', '--plan', '--panes', '4'],
    'AGENTS.md': AGENTS_SEED,
    '.claude/settings.json': 'not-json\n',
  });
  assert.equal(r.rc, 4, `rc ${r.rc}: ${r.out} ${r.err}`);
  assert.ok(r.err.includes('setup --plan: could not merge hooks into'), r.err);
  // the block section is printed before the hooks simulation dies (like the
  // bash); the unmergeable settings.json is never shown as deleted
  assert.ok(r.out.includes(`--- a/${path.join(REPO, 'AGENTS.md')}`), r.out);
  assert.ok(!r.out.includes('.claude/settings.json'), r.out);
  assert.ok(!r.out.includes('-not-json'), r.out);
  assert.equal(fs.readFileSync(path.join(REPO, '.claude', 'settings.json'), 'utf8'), 'not-json\n', 'the settings.json is untouched');
  assert.ok(r.unchanged && r.clean, 'nothing written, temp dir removed');
});

test('e2e: --target on a file with the block plans the in-place replacement; --no-hooks skips the hooks', { timeout: 30000 }, () => {
  const oldBlock = '<!-- herdr-agents:start -->\nold block line\n<!-- herdr-agents:end -->\n';
  const withBlock = `# head\n${oldBlock}# tail\n`;
  let r = e2e({
    args: ['setup', '--plan', '--target', 'AGENTS.md'],
    'AGENTS.md': withBlock,
    '.claude/settings.json': SETTINGS_SEED,
  });
  assert.equal(r.rc, 0, `rc ${r.rc}: ${r.err}`);
  assert.ok(r.out.includes('<!-- herdr-agents:start -->'), r.out);
  assert.ok(r.out.includes('-old block line'), 'the old block line is removed in the diff');
  assert.ok(r.out.includes('+## Multi-agent workflow (herdr-agents)'), 'the new block is added');
  assert.ok(r.out.includes(' # head') && r.out.includes(' # tail'), 'the surrounding lines stay as context');
  assert.ok(r.unchanged && r.clean, 'nothing written, no leftovers');
  r = e2e({
    args: ['setup', '--plan', '--no-hooks'],
    'AGENTS.md': withBlock,
    '.claude/settings.json': SETTINGS_SEED,
  });
  assert.equal(r.rc, 0, `rc ${r.rc}: ${r.err}`);
  assert.ok(!r.out.includes('settings.json'), `the hooks are not planned with --no-hooks:\n${r.out}`);
  assert.ok(r.unchanged && r.clean, 'nothing written, no leftovers');
});

test('e2e: the .gitignore entry is planned (not written) when the state dir would not be ignored', { timeout: 30000 }, () => {
  const r = e2e({
    args: ['setup', '--plan', '--session-set', 'lane.build.kind', 'pi'],
    '.gitignore': '*.log\n',
    'AGENTS.md': AGENTS_SEED,
    '.claude/settings.json': SETTINGS_SEED,
    env: { HERDR_AGENTS_DIR: '' }, // the state dir falls back to the in-repo .herdr-agents
  });
  assert.equal(r.rc, 0, `rc ${r.rc}: ${r.err}`);
  assert.ok(r.out.includes(`--- a/${path.join(REPO, '.gitignore')}`), r.out);
  assert.ok(r.out.includes('+.herdr-agents/'), r.out);
  assert.equal(fs.readFileSync(path.join(REPO, '.gitignore'), 'utf8'), '*.log\n', 'the .gitignore is untouched');
  assert.ok(!fs.existsSync(path.join(REPO, '.herdr-agents')), 'the state dir is not created');
  assert.ok(r.unchanged && r.clean, 'nothing written, no leftovers');
  // Once the entry is there (and the dir exists, as after a real write),
  // the write would be a no-op: no .gitignore diff.
  const r2 = e2e({
    args: ['setup', '--plan', '--session-set', 'lane.build.kind', 'pi'],
    '.gitignore': '*.log\n.herdr-agents/\n',
    '.herdr-agents/': undefined,
    'AGENTS.md': AGENTS_SEED,
    '.claude/settings.json': SETTINGS_SEED,
    env: { HERDR_AGENTS_DIR: '' },
  });
  assert.equal(r2.rc, 0, `rc ${r2.rc}: ${r2.err}`);
  assert.ok(!r2.out.includes('.gitignore'), `already ignored: no .gitignore diff:\n${r2.out}`);
  assert.ok(r2.unchanged && r2.clean, 'nothing written, no leftovers');
});

test('e2e: --session-set without a resolvable workspace dies 2', { timeout: 30000 }, () => {
  const r = e2e({
    args: ['setup', '--plan', '--session-set', 'lane.build.kind', 'pi'],
    'AGENTS.md': AGENTS_SEED,
    env: { HERDR_WORKSPACE_ID: '', HERDR_ENV: '' },
  });
  assert.equal(r.rc, 2, `rc ${r.rc}: ${r.err}`);
  assert.ok(r.err.includes('setup --plan: --session-set needs a Herdr workspace (none resolvable here)'), r.err);
  assert.ok(r.unchanged && r.clean, 'nothing written, no leftovers');
});

// ---------- cmdSetupPlan in-process (the library half) ----------

test('cmdSetupPlan: in-process — DieError 2 for a bad lane spec, stdout untouched', { timeout: 30000 }, () => {
  fs.rmSync(path.join(REPO, 'AGENTS.md'), { force: true });
  fs.rmSync(path.join(REPO, '.claude'), { recursive: true, force: true });
  fs.rmSync(path.join(REPO, '.agents'), { recursive: true, force: true });
  fs.writeFileSync(path.join(REPO, 'AGENTS.md'), AGENTS_SEED);
  const ctx = loadConfig(ENV, REPO);
  let threw = null;
  const keep = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => {};
  try {
    cmdSetupPlan(['--lane', 'build=boguskind'], ctx, ENV, REPO);
  } catch (e) {
    threw = e;
  } finally {
    process.stdout.write = keep;
  }
  assert.ok(threw && threw.name === 'DieError' && threw.code === 2, `expected DieError 2, got: ${threw}`);
  assert.equal(threw.message, "setup: unknown kind 'boguskind'");
});
