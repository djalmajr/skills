// JS port of the roles units: resolveRole (project dir before the skill
// roles, $HERDR_AGENTS_ROLES between them), fmGet (including frontmatter with
// CRLF lines — decision 7), roleBody, and the `roles` / `role` commands.
// The `roles` table also shows the settings a flagless spawn would use
// (resolveRoleSettings) with the source of each (FROM), per the
// frontmatter-only, role.<r>.* (config layer), lane.<l>.* and effort.<kind>
// cases.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { JS_ENTRY, nodeBin, fixtureEnv } from './parity.mjs';
import { roleDirs, roleFile, resolveRole, fmGet, roleBody, skillDir } from '../lib/roles.mjs';

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
    assert.equal(r.err, "herdr-agents: unknown role 'nosuchrole' (run: herdr-agents roles)\n");
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
    assert.equal(lines[0].replace(/\s+/g, ' '), 'ROLE KIND MODEL EFFORT MODE FROM');
    const impl = lines.find((l) => l.startsWith('implementer'));
    assert.ok(impl, 'implementer row missing');
    assert.ok(impl.includes('claude'), `kind must come from the project frontmatter: ${impl}`);
    assert.ok(impl.endsWith(`file: ${path.join(s.projRoles, 'implementer.md')}`), `source must be the project file: ${impl}`);
    // A skill-only role still shows the skill file.
    const scout = lines.find((l) => l.startsWith('scouter'));
    assert.ok(scout, 'scouter row missing');
    assert.ok(scout.endsWith(path.join('roles', 'scouter.md')), `scouter source: ${scout}`);
  } finally { s.cleanup(); }
});

// ---------- the `roles` table: resolved settings and their sources ----------

// Run `roles` (optionally with a project conf and/or project role) and
// return row(name) → the fixed-width columns KIND/MODEL/EFFORT/MODE/FROM.
function rolesTable(s, conf, projRole) {
  if (projRole !== undefined) {
    fs.mkdirSync(s.projRoles, { recursive: true });
    fs.writeFileSync(path.join(s.projRoles, 'implementer.md'), projRole);
  }
  if (conf !== undefined) {
    fs.mkdirSync(path.join(s.repo, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(s.repo, '.agents', 'herdr-agents.conf'), conf);
  }
  const r = s.run('roles');
  assert.equal(r.rc, 0, r.err);
  const lines = r.out.trim().split('\n');
  assert.equal(lines[0].replace(/\s+/g, ' '), 'ROLE KIND MODEL EFFORT MODE FROM');
  const row = (name) => {
    const l = lines.find((x) => x.slice(0, 18).trim() === name);
    assert.ok(l, `row for '${name}' missing`);
    // Fixed widths: ROLE(18) KIND(8) MODEL(24) EFFORT(8) MODE(10) FROM.
    return {
      kind: l.slice(19, 27).trim(),
      model: l.slice(28, 52).trim(),
      effort: l.slice(53, 61).trim(),
      mode: l.slice(62, 72).trim(),
      from: l.slice(73),
    };
  };
  return { lines, row };
}

test('roles: frontmatter-only role — values from the role file and the config defaults', (t) => {
  const s = setup();
  try {
    const { row } = rolesTable(s);
    // scouter: kind and mode from the frontmatter; model and effort from
    // config.defaults (model.grok.worker, effort.grok).
    let x = row('scouter');
    assert.deepEqual([x.kind, x.model, x.effort, x.mode], ['grok', 'grok', 'xhigh', 'read-only']);
    assert.equal(x.from,
      `kind: role file; model: model.grok.worker (defaults); effort: effort.grok (defaults); file: ${path.join(skillDir(), 'roles', 'scouter.md')}`);
    // planner: the model is a defaults-layer role config (role.planner.model).
    x = row('planner');
    assert.deepEqual([x.kind, x.model, x.effort, x.mode], ['claude', 'fable', 'high', 'read-only']);
    assert.equal(x.from,
      `kind: role file; model: role config (defaults); effort: role file; file: ${path.join(skillDir(), 'roles', 'planner.md')}`);
    // sub-orchestrator: model.<kind>.orchestrator (not the worker position).
    x = row('sub-orchestrator');
    assert.equal(x.model, 'fable');
    assert.equal(x.from,
      `kind: role file; model: model.claude.orchestrator (defaults); effort: role file; file: ${path.join(skillDir(), 'roles', 'sub-orchestrator.md')}`);
    // Mutation captured: a FROM that names a wrong source for the defaults
    // (e.g. 'role file' for model.grok.worker) or shows the frontmatter
    // model instead of the configured spec.
  } finally { s.cleanup(); }
});

test('roles: role.<r>.* in a config layer beats the frontmatter', (t) => {
  const s = setup();
  try {
    const conf = 'role.implementer.kind=pi\nrole.implementer.model=my-provider/my-model\nrole.implementer.effort=low\n';
    const { row } = rolesTable(s, conf);
    const x = row('implementer');
    assert.deepEqual([x.kind, x.model, x.effort, x.mode], ['pi', 'my-provider/my-model', 'low', 'edit']);
    assert.equal(x.from,
      `kind: role config (project); model: role config (project); effort: role config (project); file: ${path.join(skillDir(), 'roles', 'implementer.md')}`);
    // A role without config keys still resolves as before.
    const y = row('scouter');
    assert.deepEqual([y.kind, y.model, y.effort], ['grok', 'grok', 'xhigh']);
    assert.equal(y.from,
      `kind: role file; model: model.grok.worker (defaults); effort: effort.grok (defaults); file: ${path.join(skillDir(), 'roles', 'scouter.md')}`);
    // Mutation captured: reading the KIND/MODEL/EFFORT columns from the
    // frontmatter (the old table) instead of the resolution, or a FROM that
    // loses the layer of the deciding key.
  } finally { s.cleanup(); }
});

test('roles: lane.<l>.kind/model/effort decide for the roles of the lane', (t) => {
  const s = setup();
  try {
    const conf = 'lane.build.kind=pi\nlane.build.model=lane-model\nlane.build.effort=medium\n';
    const { row } = rolesTable(s, conf);
    // implementer sits in the build lane: all three from the lane (project).
    const x = row('implementer');
    assert.deepEqual([x.kind, x.model, x.effort], ['pi', 'lane-model', 'medium']);
    assert.equal(x.from,
      `kind: lane build (project); model: lane build (project); effort: lane build (project); file: ${path.join(skillDir(), 'roles', 'implementer.md')}`);
    // scouter sits in the explore lane (no lane keys): unchanged sources.
    const y = row('scouter');
    assert.deepEqual([y.kind, y.model, y.effort], ['grok', 'grok', 'xhigh']);
    assert.equal(y.from,
      `kind: role file; model: model.grok.worker (defaults); effort: effort.grok (defaults); file: ${path.join(skillDir(), 'roles', 'scouter.md')}`);
    // Mutation captured: skipping the lane steps in the resolution (kind
    // 'grok'/'lane-model' absent) or a lane FROM without the layer.
  } finally { s.cleanup(); }
});

test('roles: effort.<kind> and empty values (dashes, default sources)', (t) => {
  const s = setup();
  try {
    fs.mkdirSync(s.projRoles, { recursive: true });
    // A pi-kind role with no model and no effort anywhere.
    fs.writeFileSync(path.join(s.projRoles, 'pilot.md'), '---\nname: pilot\nkind: pi\n---\n\nBody.\n');
    const { row } = rolesTable(s, 'effort.grok=low\n');
    // effort.grok (project) beats the scouter/implementer frontmatter.
    assert.equal(row('scouter').effort, 'low');
    assert.equal(row('scouter').from,
      `kind: role file; model: model.grok.worker (defaults); effort: effort.grok (project); file: ${path.join(skillDir(), 'roles', 'scouter.md')}`);
    assert.equal(row('implementer').effort, 'low');
    // Nothing set for pi: dashes and the 'default' sources (the CLI decides).
    const p = row('pilot');
    assert.deepEqual([p.kind, p.model, p.effort, p.mode], ['pi', '-', '-', '-']);
    assert.equal(p.from,
      `kind: role file; model: default; effort: default; file: ${path.join(s.projRoles, 'pilot.md')}`);
    // Mutation captured: clamping/validating the effort in the resolution
    // (the table must show the raw setting), a missing '- ' for an empty
    // value, or a FROM that omits the model/effort clauses.
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
