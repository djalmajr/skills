// JS port of the roles units: resolveRole (project dir before the skill
// roles, $HERDR_AGENTS_ROLES between them), fmGet (including frontmatter with
// CRLF lines — decision 7), roleBody, and the `roles` / `role` commands.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { JS_ENTRY, nodeBin, fixtureEnv } from './parity.mjs';
import { roleDirs, roleFile, resolveRole, fmGet, roleBody } from '../lib/roles.mjs';

function setup() {
  let root = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-roles-'));
  root = fs.realpathSync(root); // git reports the resolved path (macOS /var -> /private/var)
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const conf = path.join(root, 'conf');
  const state = path.join(root, 'state');
  const tmp = path.join(root, 'tmp');
  for (const d of [repo, home, conf, state, tmp]) fs.mkdirSync(d, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
  const env = fixtureEnv({ HOME: home, XDG_CONFIG_HOME: conf, HERDR_AGENTS_DIR: state, TMPDIR: tmp });
  const run = (...args) => {
    const r = spawnSync(nodeBin(), [JS_ENTRY, ...args], { cwd: repo, env, encoding: 'utf8' });
    return { rc: r.status === null ? -1 : r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
  };
  return {
    root, repo, env, run,
    projRoles: path.join(repo, '.agents', 'herdr-roles'),
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

const PROJ_ROLE = [
  '---',
  'name: implementer',
  'description: project override',
  'kind: claude',
  'alternatives: [codex, grok]',
  'effort: low',
  'mode: edit',
  '---',
  'Project implementer body.',
  '',
].join('\n');

test('roleDirs: project dir first, $HERDR_AGENTS_ROLES, then the skill roles', (t) => {
  const s = setup();
  try {
    fs.mkdirSync(s.projRoles, { recursive: true });
    fs.writeFileSync(path.join(s.projRoles, 'implementer.md'), PROJ_ROLE);
    const extra = path.join(s.root, 'extra-roles');
    fs.mkdirSync(extra, { recursive: true });
    const base = roleDirs(s.env, s.repo);
    assert.equal(base[0], s.projRoles, 'project dir wins the first slot');
    const withExtra = { ...s.env, HERDR_AGENTS_ROLES: extra };
    assert.deepEqual(roleDirs(withExtra, s.repo), [base[0], extra, ...base.slice(1)], 'HERDR_AGENTS_ROLES sits between project and skill');
    // A non-directory HERDR_AGENTS_ROLES is ignored.
    const withMissing = { ...s.env, HERDR_AGENTS_ROLES: path.join(s.root, 'nope') };
    assert.deepEqual(roleDirs(withMissing, s.repo), base, 'missing HERDR_AGENTS_ROLES dir ignored');
  } finally { s.cleanup(); }
});

test('resolveRole: project role shadows the skill role', (t) => {
  const s = setup();
  try {
    fs.mkdirSync(s.projRoles, { recursive: true });
    fs.writeFileSync(path.join(s.projRoles, 'implementer.md'), PROJ_ROLE);
    const resolved = resolveRole('implementer', s.env, s.repo);
    assert.equal(resolved, path.join(s.projRoles, 'implementer.md'), 'project role must win over the skill role');
    // A role that exists only in the skill resolves there.
    assert.ok(roleFile('scouter', s.env, s.repo).endsWith(path.join('roles', 'scouter.md')), 'skill role fallback');
    assert.equal(roleFile('nosuchrole', s.env, s.repo), null, 'unknown role -> null');
    // Unknown role via the CLI: die 3 with the bash message.
    const r = s.run('role', 'nosuchrole');
    assert.equal(r.rc, 3, `rc: ${r.err}`);
    assert.equal(r.err, "herdr-agents: unknown role 'nosuchrole' (run: herdr-agents.sh roles)\n");
  } finally { s.cleanup(); }
});

test('fmGet: scalar, list, quoted, missing key, no frontmatter', (t) => {
  const s = setup();
  try {
    const f = path.join(s.root, 'role.md');
    fs.writeFileSync(f, [
      '---',
      'name: test',
      'kind: grok',
      'alternatives: [cursor, codex, claude]',
      'model: "a|b"',
      'timeout: 1800000',
      '---',
      'body',
      '',
    ].join('\n'));
    assert.equal(fmGet(f, 'name'), 'test');
    assert.equal(fmGet(f, 'kind'), 'grok');
    assert.equal(fmGet(f, 'alternatives'), 'cursor codex claude');
    assert.equal(fmGet(f, 'model'), 'a|b');
    assert.equal(fmGet(f, 'timeout'), '1800000');
    assert.equal(fmGet(f, 'approvals'), '');
    assert.equal(fmGet(f, 'missing'), '');
    const nofm = path.join(s.root, 'nofm.md');
    fs.writeFileSync(nofm, 'just a body\n');
    assert.equal(fmGet(nofm, 'name'), '', 'no frontmatter -> empty');
    const unclosed = path.join(s.root, 'unclosed.md');
    fs.writeFileSync(unclosed, '---\nname: x\nkind: grok\n');
    // No closing ---: the awk port parses until EOF (it only stops at ---).
    assert.equal(fmGet(unclosed, 'kind'), 'grok', 'unclosed frontmatter parsed until EOF');
  } finally { s.cleanup(); }
});

test('fmGet: frontmatter with CRLF lines parses like LF (decision 7)', (t) => {
  const s = setup();
  try {
    const f = path.join(s.root, 'crlf.md');
    fs.writeFileSync(f, '---\r\nname: crlf\r\nkind: grok\r\nalternatives: [a, b]\r\ntimeout: 42\r\n---\r\nbody\r\n');
    assert.equal(fmGet(f, 'name'), 'crlf');
    assert.equal(fmGet(f, 'kind'), 'grok');
    assert.equal(fmGet(f, 'alternatives'), 'a b');
    assert.equal(fmGet(f, 'timeout'), '42');
    assert.equal(roleBody(f), 'body\n');
  } finally { s.cleanup(); }
});

test('roleBody: after the closing ---, whole file without frontmatter, empty when unclosed', (t) => {
  const s = setup();
  try {
    const withFm = path.join(s.root, 'withfm.md');
    fs.writeFileSync(withFm, '---\nname: x\n---\nline1\nline2\n');
    assert.equal(roleBody(withFm), 'line1\nline2\n');
    const plain = path.join(s.root, 'plain.md');
    fs.writeFileSync(plain, 'whole\nfile\n');
    assert.equal(roleBody(plain), 'whole\nfile\n');
    const unclosed = path.join(s.root, 'unclosed2.md');
    fs.writeFileSync(unclosed, '---\nname: x\nbody never\n');
    assert.equal(roleBody(unclosed), '', 'unclosed frontmatter -> empty body');
  } finally { s.cleanup(); }
});

test('roles command: table lists project roles first with the project file as source', (t) => {
  const s = setup();
  try {
    fs.mkdirSync(s.projRoles, { recursive: true });
    fs.writeFileSync(path.join(s.projRoles, 'implementer.md'), PROJ_ROLE);
    const r = s.run('roles');
    assert.equal(r.rc, 0, r.err);
    const lines = r.out.trim().split('\n');
    assert.equal(lines[0].replace(/\s+/g, ' '), 'ROLE KIND EFFORT MODE SOURCE');
    const impl = lines.find((l) => l.startsWith('implementer'));
    assert.ok(impl, 'implementer row missing');
    assert.ok(impl.includes('claude'), `kind must come from the project frontmatter: ${impl}`);
    assert.ok(impl.endsWith(path.join(s.projRoles, 'implementer.md')), `source must be the project file: ${impl}`);
    // A skill-only role still shows the skill file.
    const scout = lines.find((l) => l.startsWith('scouter'));
    assert.ok(scout, 'scouter row missing');
    assert.ok(scout.endsWith(path.join('roles', 'scouter.md')), `scouter source: ${scout}`);
  } finally { s.cleanup(); }
});

test('role command: JSON shape and values, pretty-printed like jq', (t) => {
  const s = setup();
  try {
    fs.mkdirSync(s.projRoles, { recursive: true });
    fs.writeFileSync(path.join(s.projRoles, 'implementer.md'), PROJ_ROLE);
    const r = s.run('role', 'implementer');
    assert.equal(r.rc, 0, r.err);
    const j = JSON.parse(r.out);
    assert.equal(j.file, path.join(s.projRoles, 'implementer.md'));
    assert.equal(j.name, 'implementer');
    assert.equal(j.kind, 'claude');
    assert.deepEqual(j.alternatives, ['codex', 'grok']);
    assert.equal(j.mode, 'edit');
    assert.equal(j.timeout, '');
    assert.equal(j.effort, 'low');
    assert.equal(j.model, '');
    assert.equal(j.approvals, '');
    assert.equal(j.description, 'project override');
    // Same key order and 2-space pretty layout as `jq -n`.
    const keys = [...r.out.matchAll(/^  "([a-z_]+)":/gm)].map((m) => m[1]);
    assert.deepEqual(keys, ['file', 'name', 'kind', 'alternatives', 'mode', 'timeout', 'effort', 'model', 'approvals', 'description']);
    assert.ok(r.out.startsWith('{\n  "file":'), 'pretty JSON layout');
  } finally { s.cleanup(); }
});

test('role command: skill role resolves the skill file and its frontmatter', (t) => {
  const s = setup();
  try {
    const r = s.run('role', 'implementer');
    assert.equal(r.rc, 0, r.err);
    const j = JSON.parse(r.out);
    assert.equal(j.name, 'implementer');
    assert.equal(j.kind, 'grok');
    assert.deepEqual(j.alternatives, ['cursor', 'codex', 'claude']);
    assert.equal(j.effort, 'xhigh');
    assert.equal(j.mode, 'edit');
    assert.equal(j.timeout, '1800000');
    assert.ok(j.file.endsWith(path.join('roles', 'implementer.md')), j.file);
  } finally { s.cleanup(); }
});
