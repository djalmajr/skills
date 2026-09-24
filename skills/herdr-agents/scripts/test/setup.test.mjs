// setup (slice 7a): unit tests for the pure text/merge layer
// (lib/setuptext.mjs) and the file-level helpers of lib/commands/setup.mjs.
// Each test file builds its own temp root (mkdtemp) used as HOME,
// XDG_CONFIG_HOME, TMPDIR and HERDR_AGENTS_DIR, with a temporary git repo
// (brief decision 7); nothing here touches a real `herdr`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  SETUP_START,
  SETUP_END,
  setupBlock,
  setupHookReminder,
  setupHookDoctor,
  setupBlockResult,
  settingsHooksResult,
} from '../lib/setuptext.mjs';
import { setupTargetExisting, setupWriteBlock, setupWriteHooks, projectNeedsConfigPrompt } from '../lib/commands/setup.mjs';

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ha-setup-unit-')));
const REPO = path.join(ROOT, 'repo');
const HOME = path.join(ROOT, 'home');
const CONF = path.join(ROOT, 'conf');
const STATE = path.join(ROOT, 'state');
fs.mkdirSync(REPO, { recursive: true });
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(CONF, { recursive: true });
fs.mkdirSync(STATE, { recursive: true });
spawnSync('git', ['init', '-q'], { cwd: REPO, stdio: 'ignore' });
fs.mkdirSync(path.join(ROOT, 'tmp'), { recursive: true });
// The module points the process at the fixture; the originals come back
// after the file's tests, because Bun runs every test file in one process
// and a TMPDIR left pointing at the deleted fixture breaks the next files.
const ENV_KEYS = ['HOME', 'XDG_CONFIG_HOME', 'TMPDIR', 'HERDR_AGENTS_DIR'];
const SAVED_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
process.env.HOME = HOME;
process.env.XDG_CONFIG_HOME = CONF;
process.env.TMPDIR = path.join(ROOT, 'tmp');
process.env.HERDR_AGENTS_DIR = STATE;
test.after(() => {
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const BLOCK = setupBlock();
const OLD_BLOCK = `${SETUP_START}\nold block line\n${SETUP_END}\n`;

test('setupBlock: markers, heading, no absolute path (test-setup.sh rule)', () => {
  assert.ok(BLOCK.startsWith(`${SETUP_START}\n`), 'starts with the start marker');
  assert.ok(BLOCK.endsWith(`${SETUP_END}\n`), 'ends with the end marker and a newline');
  assert.ok(BLOCK.includes('## Multi-agent workflow (herdr-agents)\n'));
  assert.ok(!BLOCK.split('\n').some((l) => l.startsWith('/')), 'no absolute path is embedded');
  assert.ok(!BLOCK.includes('scripts/'), 'no script path is embedded');
});

test('setupHookReminder: exact text, no trailing newline', () => {
  assert.equal(setupHookReminder(), 'sh -c \'[ "${HERDR_ENV:-}" = 1 ] && echo "herdr-agents: this project routes non-trivial work through /herdr-agents — surveys go to a scouter, slices to workers; the orchestrator keeps only one-or-two-file changes."; true\'');
});

test('setupHookDoctor: exact text, no trailing newline (herdr-agents.sh paths kept for the slice-9 shim)', () => {
  assert.equal(setupHookDoctor(), 'sh -c \'[ "${HERDR_ENV:-}" = 1 ] || exit 0; for script in "${CLAUDE_PROJECT_DIR:-$PWD}/.agents/skills/herdr-agents/scripts/herdr-agents.sh" "${CLAUDE_PROJECT_DIR:-$PWD}/.claude/skills/herdr-agents/scripts/herdr-agents.sh" "$HOME/.agents/skills/herdr-agents/scripts/herdr-agents.sh" "$HOME/.claude/skills/herdr-agents/scripts/herdr-agents.sh"; do [ -f "$script" ] || continue; bash "$script" doctor 2>/dev/null | grep -E "^warn" | sed "s/^warn */herdr-agents doctor: /"; exit 0; done; echo "herdr-agents doctor: skill script not found"; true\'');
});

test('setupBlockResult: absent and empty files', () => {
  assert.equal(setupBlockResult(null), BLOCK);
  assert.equal(setupBlockResult(''), `\n${BLOCK}`);
});

test('setupBlockResult: append keeps one blank line before the block', () => {
  // The intended transform (brief decision 3): the missing final newline is
  // restored, then a blank line, then the block. (The bash `tail -c1 | od`
  // check is dead — it compares od's 2-char `\n` display against the 3-char
  // literal `\\n` — so real bash appends an extra blank line; that defect
  // is not ported, see the report.)
  assert.equal(setupBlockResult('hello'), `hello\n\n${BLOCK}`);
  assert.equal(setupBlockResult('hello\n'), `hello\n\n${BLOCK}`);
});

test('setupBlockResult: replaces the range between the markers (bash awk semantics)', () => {
  // block in the middle: surrounding lines kept, markers consumed
  assert.equal(setupBlockResult(`before\n${OLD_BLOCK}after\n`), `before\n${BLOCK}after\n`);
  // no trailing newline on the end marker line
  assert.equal(setupBlockResult(`before\n${SETUP_START}\nold\n${SETUP_END}`), `before\n${BLOCK}`);
  // only the block
  assert.equal(setupBlockResult(OLD_BLOCK), BLOCK);
});

test('setupBlockResult: no end marker truncates everything after the start line (bash behavior)', () => {
  // Confirmed against the bash script: the write succeeds (`block updated`),
  // the trailing content after the start line is dropped, and the new block
  // (which carries the end marker) replaces the range.
  assert.equal(setupBlockResult(`before\n${SETUP_START}\nold stuff\n`), `before\n${BLOCK}`);
});

test('setupBlockResult: end before start is consumed; a second start repeats the block; a line holding both counts as start', () => {
  assert.equal(setupBlockResult(`x\n${SETUP_END}\n${SETUP_START}\ny\n${SETUP_END}\n`), `x\n${BLOCK}`);
  assert.equal(setupBlockResult(`a\n${SETUP_START}\n1\n${SETUP_START}\n2\n${SETUP_END}\n`), `a\n${BLOCK}${BLOCK}`);
  assert.equal(setupBlockResult(`a\n${SETUP_START}${SETUP_END}\nb\n`), `a\n${BLOCK}`);
});

function parsedSettings(content) {
  const out = settingsHooksResult(content);
  assert.ok(out !== null, 'merge produced a document');
  assert.ok(out.startsWith('{\n'), 'jq formatting: top-level object on its own line');
  assert.ok(out.endsWith('}\n'), 'jq formatting: one trailing newline');
  return { text: out, doc: JSON.parse(out) };
}

test('settingsHooksResult: absent file and {} gain both hooks, nothing else', () => {
  const a = parsedSettings(null);
  const b = parsedSettings('{}');
  assert.equal(a.text, b.text, 'absent and {} are the same seed');
  assert.deepEqual(Object.keys(a.doc), ['hooks']);
  assert.deepEqual(Object.keys(a.doc.hooks), ['UserPromptSubmit', 'SessionStart']);
  assert.equal(a.doc.hooks.UserPromptSubmit[0].hooks[0].command, setupHookReminder());
  assert.equal(a.doc.hooks.SessionStart[0].hooks[0].command, setupHookDoctor());
  assert.equal(a.doc.hooks.UserPromptSubmit[0].hooks[0].type, 'command');
});

test('settingsHooksResult: other hooks and keys stay, same order; new events appended', () => {
  const seed = JSON.stringify({
    other: { x: 1 },
    hooks: {
      PreToolUse: [{ hooks: [{ type: 'command', command: 'echo keep-me' }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: 'bash something-else.sh' }] }],
    },
  });
  const { text, doc } = parsedSettings(seed);
  assert.deepEqual(Object.keys(doc), ['other', 'hooks'], 'top-level key order kept');
  assert.deepEqual(Object.keys(doc.hooks), ['PreToolUse', 'SessionStart', 'UserPromptSubmit'], 'existing events keep position, new one appended');
  assert.equal(doc.hooks.PreToolUse[0].hooks[0].command, 'echo keep-me');
  assert.equal(doc.hooks.SessionStart[0].hooks[0].command, 'bash something-else.sh', 'unrelated entry kept');
  assert.equal(doc.hooks.SessionStart[1].hooks[0].command, setupHookDoctor(), 'new entry at the end');
  assert.equal(text, JSON.stringify(doc, null, 2) + '\n', 'exactly the jq formatting');
});

test('settingsHooksResult: old skill hooks are replaced, never stacked', () => {
  const seed = JSON.stringify({
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command: setupHookReminder() }] },
        { hooks: [{ type: 'command', command: 'echo keep-me' }, { type: 'command', command: 'sh -c herdr-agents setup' }] },
      ],
      SessionStart: [{ hooks: [{ type: 'command', command: setupHookDoctor() }] }],
    },
  });
  const first = parsedSettings(seed);
  assert.equal(first.doc.hooks.UserPromptSubmit.length, 1, 'both old entries dropped (an entry with ANY herdr-agents command goes)');
  assert.equal(first.doc.hooks.UserPromptSubmit[0].hooks[0].command, setupHookReminder());
  assert.equal(first.doc.hooks.SessionStart.length, 1, 'old doctor replaced');
  const second = parsedSettings(first.text);
  assert.equal(second.text, first.text, 'a re-run is stable: no duplicates stack');
});

test('settingsHooksResult: invalid or wrong-shaped documents are refused (null → die 4)', () => {
  for (const bad of [
    'NOT-JSON',
    '42',
    '[1, 2]',
    '{"hooks": [1]}',
    '{"hooks": {"UserPromptSubmit": {}}}',
    '{"hooks": {"UserPromptSubmit": [{"hooks": [{"type": "command", "command": 123}]}]}}',
  ]) assert.equal(settingsHooksResult(bad), null, `refused: ${bad.slice(0, 40)}`);
});

test('projectNeedsConfigPrompt: the bash awk rule', () => {
  const dir = path.join(ROOT, 'prompt-cases');
  fs.mkdirSync(dir, { recursive: true });
  const f = (name, text) => {
    const p = path.join(dir, name);
    if (text !== null) fs.writeFileSync(p, text);
    return p;
  };
  assert.equal(projectNeedsConfigPrompt(f('absent', null)), true, 'absent file → prompt');
  assert.equal(projectNeedsConfigPrompt(f('max-only', 'max_workers=4\n')), true, 'max_workers alone is not the choice');
  assert.equal(projectNeedsConfigPrompt(f('multi', 'multi_role=on\n')), false);
  assert.equal(projectNeedsConfigPrompt(f('lane-kind', 'lane.build.kind=codex\n')), false);
  assert.equal(projectNeedsConfigPrompt(f('role-kind', 'role.implementer.kind=claude\n')), false);
  assert.equal(projectNeedsConfigPrompt(f('comment', '# multi_role=on\n')), true);
  assert.equal(projectNeedsConfigPrompt(f('indent', '   multi_role=on\n')), false, 'leading whitespace is stripped');
  assert.equal(projectNeedsConfigPrompt(f('inline', 'multi_role=on # inline comment\n')), false);
  assert.equal(projectNeedsConfigPrompt(f('lane-model', 'lane.build.model=some-model\n')), true, 'model does not count');
  assert.equal(projectNeedsConfigPrompt(f('crlf', 'max_workers=4\r\nmulti_role=on\r\n')), false, 'CRLF normalized on read (decision 7)');
  assert.equal(projectNeedsConfigPrompt(f('bad-name', 'role..kind=x\nlane..kind=x\n')), true, 'empty names do not match the pattern');
  assert.equal(projectNeedsConfigPrompt(f('anchored', 'xmulti_role=on\n')), true, 'keys are line-anchored');
});

test('setupTargetExisting: AGENTS.md first, then CLAUDE.md, else null', () => {
  const dir = path.join(ROOT, 'target-existing');
  fs.mkdirSync(path.join(dir, 'c'), { recursive: true });
  assert.equal(setupTargetExisting(dir), null, 'nothing there');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'no block\n');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `has ${SETUP_START} inside\n`);
  assert.equal(setupTargetExisting(dir), path.join(dir, 'CLAUDE.md'));
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), `now ${SETUP_START} too\n`);
  assert.equal(setupTargetExisting(dir), path.join(dir, 'AGENTS.md'), 'AGENTS.md wins when both carry the block');
});

test('setupWriteBlock: written vs updated verb, block replaced in place', () => {
  const dir = path.join(ROOT, 'write-block');
  fs.mkdirSync(dir, { recursive: true });
  const fresh = path.join(dir, 'AGENTS.md');
  assert.equal(setupWriteBlock(fresh), 'written');
  assert.equal(fs.readFileSync(fresh, 'utf8'), BLOCK);
  assert.equal(setupWriteBlock(fresh), 'updated', 'second run replaces');
  const seeded = path.join(dir, 'seeded.md');
  fs.writeFileSync(seeded, `intro\n${OLD_BLOCK}tail\n`);
  assert.equal(setupWriteBlock(seeded), 'updated');
  assert.equal(fs.readFileSync(seeded, 'utf8'), `intro\n${BLOCK}tail\n`);
});

test('setupWriteHooks: creates the directory and file; invalid settings is DieError 4, file untouched', () => {
  const dir = path.join(ROOT, 'write-hooks');
  fs.mkdirSync(dir, { recursive: true });
  const sj = path.join(dir, '.claude', 'settings.json');
  setupWriteHooks(sj);
  const merged = JSON.parse(fs.readFileSync(sj, 'utf8'));
  assert.equal(merged.hooks.UserPromptSubmit[0].hooks[0].command, setupHookReminder());
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{invalid');
  assert.throws(
    () => setupWriteHooks(bad),
    (e) => e.name === 'DieError' && e.code === 4 && e.message === `could not merge hooks into ${bad}`,
  );
  assert.equal(fs.readFileSync(bad, 'utf8'), '{invalid', 'file left untouched');
});
