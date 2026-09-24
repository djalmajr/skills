// dispatch (slice 6b): the units the acceptance criterion lists —
// briefMissingSections (each section absent, each alternative accepted, a
// word mid-paragraph does not count, header level 1-3, case-insensitive,
// the no-git line), lintBrief (warn message, off silent; strict dies 2 via
// the entry), familyConflicts (unknown family, edit history, an old
// 8-column line, a project role with mode: edit, the 12-column intended
// semantics), composePrompt (report_language, worker_context=lean, a
// project role under .agents/herdr-roles/), the $TMPDIR routing, the pane
// task title, the prompt-failure JSON, and the wait status codes
// (timeout 9, quota 11, family 5). The exit-code paths run through the real
// entry (child process); the pure functions run in-process. A fake `herdr`
// (writeFakeCli) is the only herdr the code sees.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeFakeCli } from './fakes.mjs';
import { nodeBin } from './parity.mjs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import {
  briefMissingSections, lintBrief, composePrompt, familyConflicts,
} from '../lib/dispatch.mjs';
import { splitRunArgs } from '../lib/commands/run.mjs';
import { roleBody } from '../lib/roles.mjs';

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS_ENTRY = path.join(SCRIPTS, 'herdr-agents.mjs');

// ---------- fake herdr (Node) ----------

// `agent get` per target (mode-<t> file) else the global mode file
// (denied → an unqueryable error, missing → agent_not_found, else the mode
// as agent_status); `agent read` prints screen-<t> (or the global screen
// file); `agent prompt` fails when FAKE_PROMPT_FAIL exists (one line of
// stderr, exit 1) and logs the prompt text as a call; `agent list` from
// FAKE_LIVE. Every call is logged as one "$*" line (FAKE_LOG).
const HERDR_FAKE = `
import fs from 'node:fs';
const argv = process.argv.slice(2);
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, argv.join(' ') + '\\n');
const t = argv[2] ?? '';
const cmd = (argv[0] ?? '') + ' ' + (argv[1] ?? '');
const modeOf = (t) => {
  let per = '';
  if (process.env.FAKE_MODE_DIR) {
    try { per = fs.readFileSync(process.env.FAKE_MODE_DIR + '/mode-' + t, 'utf8').trim(); } catch {}
  }
  if (per) return per;
  try { return fs.readFileSync(process.env.FAKE_MODE, 'utf8').trim(); } catch { return 'working'; }
};
const screenOf = (t) => {
  try { return fs.readFileSync(process.env.FAKE_SCREEN_DIR + '/screen-' + t, 'utf8'); }
  catch { try { return fs.readFileSync(process.env.FAKE_SCREEN, 'utf8'); } catch { return ''; } }
};
if (cmd === 'agent get') {
  const m = modeOf(t);
  if (m === 'denied') {
    process.stderr.write('Error: Os { code: 13, kind: PermissionDenied, message: "Permission denied" }\\n');
    process.exit(1);
  }
  if (m === 'missing') {
    process.stderr.write('{"error":{"code":"agent_not_found","message":"agent target ' + t + ' not found"}}\\n');
    process.exit(1);
  }
  process.stdout.write('{"result":{"agent":{"name":"' + t + '","agent_status":"' + m + '"}}}\\n');
} else if (cmd === 'agent read') {
  process.stdout.write(screenOf(t));
} else if (cmd === 'agent prompt') {
  if (process.env.FAKE_PROMPT_FAIL && fs.existsSync(process.env.FAKE_PROMPT_FAIL)) {
    process.stderr.write('prompt failed: the fake refused\\n');
    process.exit(1);
  }
  process.stdout.write('{"result":{"submitted":true}}\\n');
} else if (cmd === 'agent list') {
  let agents = [];
  try { agents = (JSON.parse(fs.readFileSync(process.env.FAKE_LIVE, 'utf8')).agents) ?? []; } catch {}
  process.stdout.write(JSON.stringify({ result: { agents } }) + '\\n');
} else if (cmd === 'pane list') {
  process.stdout.write('{"result":{"panes":[]}}\\n');
} else {
  process.stderr.write('unexpected: ' + argv.join(' ') + '\\n');
  process.exit(1);
}
`;

// ---------- fixture plumbing ----------

function makeFix(prefix) {
  let root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  root = fs.realpathSync(root);
  const bin = path.join(root, 'bin');
  const repo = path.join(root, 'repo');
  const state = path.join(root, 'state');
  const ws = path.join(state, 'ws');
  const modeDir = path.join(root, 'modes');
  const screenDir = path.join(root, 'screens');
  for (const d of [bin, repo, ws, path.join(ws, 'briefs'), path.join(ws, 'reports'), path.join(ws, 'wait'),
    modeDir, screenDir, path.join(root, 'home'), path.join(root, 'conf'), path.join(root, 'tmp')]) {
    fs.mkdirSync(d, { recursive: true });
  }
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
    HERDR_AGENTS_WAIT_POLL_MS: '20',
    FAKE_MODE: path.join(root, 'mode'),
    FAKE_MODE_DIR: modeDir,
    FAKE_SCREEN: path.join(root, 'screen'),
    FAKE_SCREEN_DIR: screenDir,
    FAKE_LIVE: path.join(root, 'live.json'),
    FAKE_LOG: path.join(root, 'herdr.log'),
    FAKE_PROMPT_FAIL: path.join(root, 'prompt-fail'),
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  };
  fs.writeFileSync(env.FAKE_MODE, 'idle\n');
  fs.writeFileSync(env.FAKE_SCREEN, '');
  fs.writeFileSync(env.FAKE_LIVE, JSON.stringify({ agents: [] }));
  const H12 = '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\tmodel\tapprovals\troles\tlane\n';
  const fix = {
    root, repo, state, ws, env, ctx: loadConfig(env, repo),
    mode(m) { fs.writeFileSync(env.FAKE_MODE, `${m}\n`); },
    screen(s) { fs.writeFileSync(env.FAKE_SCREEN, s); },
    screenOf(agent, s) { fs.writeFileSync(path.join(screenDir, `screen-${agent}`), s); },
    writeRoster(header, ...rows) {
      fs.writeFileSync(path.join(ws, 'agents.tsv'), (header ?? H12) + rows.join('\n') + '\n');
    },
    promptFail(on = true) {
      if (on) fs.writeFileSync(env.FAKE_PROMPT_FAIL, '1\n');
      else fs.rmSync(env.FAKE_PROMPT_FAIL, { force: true });
    },
    brief(name, body) {
      const p = path.join(root, name);
      fs.writeFileSync(p, body);
      return p;
    },
    log() {
      try { return fs.readFileSync(env.FAKE_LOG, 'utf8'); } catch { return ''; }
    },
    clearLog() { fs.writeFileSync(env.FAKE_LOG, ''); },
    tmpReports() { return path.join(env.TMPDIR, 'herdr-agents', 'ws', 'reports'); },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
  fix.writeRoster();
  return fix;
}

function cmd(fix, args, extraEnv = {}) {
  return spawnSync(nodeBin(), [JS_ENTRY, ...args], {
    cwd: fix.repo,
    env: { ...fix.env, ...extraEnv },
    encoding: 'utf8',
    timeout: 60_000,
  });
}

// A full contract brief (passes the strict lint): all sections plus the
// no-git line.
const FULL_BRIEF = `# Goal

Do the slice.

# Expected result

The slice is done.

# Owned files

scripts/x.mjs

# Forbidden

Do not commit or push.

# Report

Done.
`;

// The test-multi-role brief: contract sections but no expected result
// (the lint asks for it).
const NO_EXPECTED_BRIEF = `# Goal

Confirm which role the composed prompt uses.

# Owned files

skills/herdr-agents/scripts/herdr-agents

# Forbidden

Do not commit or push.

# Report

done or skipped.
`;

// 12-column row (cwd /tmp/work unless overridden).
const ROW12 = (name, pane, kind, role, family, cwd, model, lane) =>
  `${name}\t${pane}\t${kind}\t${role}\t${family}\t1\t${cwd ?? '/tmp/work'}\tnow\t${model}\tfull\t${role}\t${lane}`;
// 11-column row (no lane).
const ROW11 = (name, pane, kind, role, family, cwd, model, hist) =>
  `${name}\t${pane}\t${kind}\t${role}\t${family}\t1\t${cwd ?? '/tmp/work'}\tnow\t${model}\tfull\t${hist}`;
// 8-column row (old).
const ROW8 = (name, pane, kind, role, family, cwd) =>
  `${name}\t${pane}\t${kind}\t${role}\t${family}\t1\t${cwd ?? '/tmp/work'}\tnow`;

function parsePretty(out) {
  return JSON.parse(out.trim());
}

// ---------- briefMissingSections ----------

test('lint: a full contract brief passes', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-lint-full-');
  try {
    const f = fix.brief('brief.md', FULL_BRIEF);
    assert.equal(briefMissingSections(f), '');
  } finally { fix.cleanup(); }
});

test('lint: each section absent, each alternative accepted', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-lint-each-');
  try {
    const noGoal = FULL_BRIEF.replace('# Goal\n', '');
    const noExpected = FULL_BRIEF.replace('# Expected result\n', '');
    const noOwned = FULL_BRIEF.replace('# Owned files\n', '');
    const noForbidden = FULL_BRIEF.replace('# Forbidden\n', '');
    const noReport = FULL_BRIEF.replace('# Report\n', '');
    const noGit = FULL_BRIEF.replace('Do not commit or push.', 'Do nothing.');
    const checks = [
      [noGoal, ' [Goal]'],
      [noExpected, ' [Expected result]'],
      [noOwned, ' [Owned files]'],
      [noForbidden, ' [Forbidden]'],
      [noReport, ' [Report]'],
      [noGit, " [no-git line: say 'no commit/push']"],
    ];
    for (const [body, want] of checks) {
      const f = fix.brief('brief.md', body);
      assert.equal(briefMissingSections(f), want, `brief missing: ${body.split('\n')[0]}`);
    }
    // Every accepted alternative of the multi-name sections is enough.
    for (const alt of ['Acceptance', 'Definition of done']) {
      const f = fix.brief('brief.md', FULL_BRIEF.replace('# Expected result', `# ${alt}`));
      assert.equal(briefMissingSections(f), '', `alt ${alt}`);
    }
    for (const alt of ['Owned', 'Scope']) {
      const f = fix.brief('brief.md', FULL_BRIEF.replace('# Owned files', `# ${alt}`));
      assert.equal(briefMissingSections(f), '', `alt ${alt}`);
    }
    for (const alt of ['Non-goals', 'Constraints']) {
      const f = fix.brief('brief.md', FULL_BRIEF.replace('# Forbidden', `# ${alt}`));
      assert.equal(briefMissingSections(f), '', `alt ${alt}`);
    }
  } finally { fix.cleanup(); }
});

test('lint: header level 1-3 only, case-insensitive, a word mid-paragraph does not count', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-lint-level-');
  try {
    const noGoal = FULL_BRIEF.replace('# Goal\n', '');
    const f = (name, body) => { const p = path.join(fix.root, name); fs.writeFileSync(p, body); return p; };
    // Levels 2 and 3 count; level 4 and a missing space do not.
    assert.equal(briefMissingSections(f('a.md', noGoal.replace('# Expected result', '## Goal\n# Expected result'))), '');
    assert.equal(briefMissingSections(f('b.md', noGoal.replace('# Expected result', '### Goal\n# Expected result'))), '');
    assert.equal(briefMissingSections(f('c.md', noGoal.replace('# Expected result', '#### Goal\n# Expected result'))), ' [Goal]');
    assert.equal(briefMissingSections(f('d.md', noGoal.replace('# Expected result', '#Goal\n# Expected result'))), ' [Goal]');
    // Case-insensitive (grep -qiE).
    assert.equal(briefMissingSections(f('e.md', FULL_BRIEF.replace('# Goal', '## gOaL'))), '');
    // A paragraph word is not a section.
    assert.equal(briefMissingSections(f('g.md', noGoal.replace('# Expected result', 'Goal: do it.\n# Expected result'))), ' [Goal]');
    // The no-git line: any case, commit or push.
    assert.equal(briefMissingSections(f('h.md', FULL_BRIEF.replace('Do not commit or push.', 'NO PUSH at all.'))), '');
  } finally { fix.cleanup(); }
});

test('lint: every missing section in order', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-lint-all-');
  try {
    const f = fix.brief('brief.md', 'Just do it.\n');
    assert.equal(briefMissingSections(f),
      " [Goal] [Expected result] [Owned files] [Forbidden] [Report] [no-git line: say 'no commit/push']");
  } finally { fix.cleanup(); }
});

// ---------- lintBrief (warn / off; strict through the entry) ----------

test('lint: warn prints the message and continues; off is silent', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-lint-warn-');
  try {
    fix.writeRoster(undefined, ROW12('build', 'p1', 'grok', 'implementer', 'xai', fix.repo, 'grok-4.7', 'build'));
    const f = fix.brief('brief.md', NO_EXPECTED_BRIEF);
    const orig = process.stderr.write;
    let captured = '';
    process.stderr.write = (s) => { captured += s; return true; };
    let threw = null;
    try { lintBrief(f, fix.ctx, fix.env); } catch (e) { threw = e; }
    process.stderr.write = orig;
    assert.equal(threw, null, 'warn does not throw');
    assert.equal(captured,
      'herdr-agents: warning: brief ' + f + ' is missing sections: [Expected result] — workers without owned/forbidden files collide, without a report section never finish\n');
    // off: no output at all.
    captured = '';
    process.stderr.write = (s) => { captured += s; return true; };
    try { lintBrief(f, fix.ctx, { ...fix.env, HERDR_AGENTS_BRIEF_LINT: 'off' }); }
    finally { process.stderr.write = orig; }
    assert.equal(captured, '', 'off is silent');
    // strict dies 2 (through the entry, where the friction log is live):
    const r = cmd(fix, ['dispatch', 'build', f, '--no-wait'], { HERDR_AGENTS_BRIEF_LINT: 'strict' });
    assert.equal(r.status, 2, r.stderr);
    assert.ok(r.stderr.includes(`herdr-agents: brief ${f} is missing sections: [Expected result] (brief_lint=strict)\n`), r.stderr);
    // A full contract brief passes strict.
    const full = fix.brief('full.md', FULL_BRIEF);
    const ok = cmd(fix, ['dispatch', 'build', full, '--no-wait'], { HERDR_AGENTS_BRIEF_LINT: 'strict' });
    assert.equal(ok.status, 0, ok.stderr);
  } finally { fix.cleanup(); }
});

// ---------- familyConflicts ----------

test('family: unknown and empty families never conflict', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-fam-unknown-');
  try {
    fix.writeRoster(undefined,
      ROW11('ex', 'p1', 'grok', 'scouter', 'xai', '/tmp/work', 'grok-4.7', 'implementer,scouter'));
    assert.deepEqual(familyConflicts(fix.ws, 'unknown', fix.env, fix.repo), []);
    assert.deepEqual(familyConflicts(fix.ws, '', fix.env, fix.repo), []);
    // test-multi-role.sh: only xai edit agents in the roster → openai is free.
    assert.deepEqual(familyConflicts(fix.ws, 'openai', fix.env, fix.repo), []);
  } finally { fix.cleanup(); }
});

test('family: edit history counts, the wrong family does not, a plain worker never does', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-fam-hist-');
  try {
    fix.writeRoster(undefined,
      ROW11('ex', 'p1', 'grok', 'scouter', 'xai', '/tmp/work', 'grok-4.7', 'implementer,scouter'),
      ROW11('other', 'p2', 'codex', 'implementer', 'openai', '/tmp/work', 'gpt-5', 'implementer'),
      ROW11('plain', 'p3', 'grok', 'scouter', 'xai', '/tmp/work', 'grok-4.7', 'scouter'));
    assert.deepEqual(familyConflicts(fix.ws, 'xai', fix.env, fix.repo), ['ex (grok)']);
    assert.deepEqual(familyConflicts(fix.ws, 'openai', fix.env, fix.repo), ['other (codex)']);
    fix.writeRoster(undefined,
      ROW11('plain', 'p3', 'grok', 'scouter', 'xai', '/tmp/work', 'grok-4.7', 'scouter'));
    assert.deepEqual(familyConflicts(fix.ws, 'xai', fix.env, fix.repo), []);
  } finally { fix.cleanup(); }
});

test('family: an old 8-column line is counted by its role', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-fam-old-');
  try {
    fix.writeRoster(undefined,
      ROW8('impl', 'p1', 'grok', 'implementer', 'xai'));
    assert.deepEqual(familyConflicts(fix.ws, 'xai', fix.env, fix.repo), ['impl (grok)']);
    // test-kinds.sh: the same roster leaves the openai reviewer free.
    assert.deepEqual(familyConflicts(fix.ws, 'openai', fix.env, fix.repo), []);
  } finally { fix.cleanup(); }
});

test('family: a project role with mode: edit counts via the history', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-fam-migrator-');
  try {
    const dir = path.join(fix.repo, '.agents', 'herdr-roles');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'migrator.md'), '---\nname: migrator\nkind: grok\nmode: edit\n---\n\nMigrate.\n');
    fix.writeRoster(undefined,
      ROW11('mig', 'p1', 'grok', 'scouter', 'xai', '/tmp/work', 'grok-4.7', 'migrator'));
    assert.deepEqual(familyConflicts(fix.ws, 'xai', fix.env, fix.repo), ['mig (grok)']);
  } finally { fix.cleanup(); }
});

test('family: the 12-column history is column 11 (lane not folded in)', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-fam-col12-');
  try {
    // Bash folds column 12 into the last `read` variable, missing a
    // single-token history on a 12-column line; the port keeps the intended
    // semantics (column 11 only) — the defect is not ported.
    fix.writeRoster(undefined,
      'ex\tp1\tgrok\tscouter\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\timplementer\texplore');
    assert.deepEqual(familyConflicts(fix.ws, 'xai', fix.env, fix.repo), ['ex (grok)']);
  } finally { fix.cleanup(); }
});

// ---------- composePrompt ----------

test('compose: role header, brief verbatim, the report contract in order', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-compose-');
  try {
    const dir = path.join(fix.repo, '.agents', 'herdr-roles');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'alpha.md'), [
      '---', 'name: alpha role', 'kind: grok', 'mode: edit', '---', '',
      'Alpha body line one.', 'Alpha body line two.', '',
    ].join('\n'));
    const roleFile = path.join(dir, 'alpha.md');
    const brief = '# Brief — alpha\n\n# Goal\nDo it.\n';
    const report = '/some/state/ws/reports/alpha-20260101T000000.md';
    const text = composePrompt(roleFile, 'alpha', 'w1', brief, report, fix.ctx, fix.env);
    // The exact units, in the bash printf order (the role body comes from
    // roleBody, pinned by roles.test.mjs).
    const header = '# Role: alpha role\n\n'
      + 'You are running as the `alpha` role, agent name `w1`, inside a multi-agent run coordinated by an orchestrator that cannot see your terminal.\n\n';
    const body = roleBody(roleFile);
    const contract = [
      '- Write your report as Markdown to `' + report + '` (create parent directories if needed) following the `<report>` section of your role and the per-item states done / partial / skipped + reason.\n',
      '- Write the report in one go, as the last action of your work; the orchestrator treats its existence as completion.\n',
      '- Nobody watches this terminal: do not ask interactive questions or wait for a confirmation. When the brief does not decide something, follow its "When the brief does not decide" section, or mark the item partial and list the gap and the options under open questions.\n',
      '- Never invent names, endpoints, flags, credentials, URLs or requirements.\n',
      '- Do not commit, push, tag, or open pull requests.\n',
      '- When finished, reply in the terminal with exactly the report path and nothing else.\n',
    ].join('');
    assert.equal(text, header + body + '\n\n# Brief\n\n' + brief + '\n\n# Report contract\n\n' + contract);
    assert.equal(body, '\nAlpha body line one.\nAlpha body line two.\n');
  } finally { fix.cleanup(); }
});

test('compose: report_language and worker_context=lean add their lines', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-compose-lean-');
  try {
    const dir = path.join(fix.repo, '.agents', 'herdr-roles');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'alpha.md'), '---\nname: alpha\n---\n\nBody.\n');
    const roleFile = path.join(dir, 'alpha.md');
    const report = '/r.md';
    const env = { ...fix.env, HERDR_AGENTS_REPORT_LANGUAGE: 'pt-BR', HERDR_AGENTS_WORKER_CONTEXT: 'lean' };
    const text = composePrompt(roleFile, 'alpha', 'w1', '# Goal\nGo.\n', report, fix.ctx, env);
    assert.ok(text.includes('- Write the report in pt-BR.\n'), 'language line');
    const idxLang = text.indexOf('- Write the report in pt-BR.\n');
    const idxOneGo = text.indexOf('- Write the report in one go');
    const idxLean = text.indexOf('- This brief is self-contained. Do NOT read CLAUDE.md, AGENTS.md, ai-memory rules, wiki pages or other project instruction files unless the brief names them explicitly; the rules that apply are quoted in the brief. Start on the task immediately.\n');
    assert.ok(idxLang !== -1 && idxOneGo !== -1 && idxLean !== -1);
    assert.ok(idxLang < idxOneGo && idxOneGo < idxLean, 'order: language, one-go, lean');
    // Default context full / empty language: the lines are absent.
    const plain = composePrompt(roleFile, 'alpha', 'w1', '# Goal\nGo.\n', report, fix.ctx, fix.env);
    assert.ok(!plain.includes('Write the report in pt-BR'));
    assert.ok(!plain.includes('This brief is self-contained'));
  } finally { fix.cleanup(); }
});

// ---------- cmdDispatch through the entry ----------

test('dispatch: --no-wait happy path, task title, prompt text, state files', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-ok-');
  try {
    fix.writeRoster(undefined, ROW12('build', 'p1', 'grok', 'implementer', 'xai', fix.repo, 'grok-4.7', 'build'));
    const brief = fix.brief('brief.md', FULL_BRIEF.replace('# Goal\n', '# Brief — porte da config\n# Goal\n'));
    const r = cmd(fix, ['dispatch', 'build', brief, '--no-wait']);
    assert.equal(r.status, 0, r.stderr);
    const j = parsePretty(r.stdout);
    assert.equal(j.agent, 'build');
    assert.equal(j.role, 'implementer');
    assert.equal(j.kind, 'grok');
    assert.equal(j.wait_status, 'submitted');
    assert.equal(j.report_exists, false);
    assert.equal(j.auto_approved, 0);
    assert.ok(!('lane' in j) && !('match' in j), 'quota keys only on a quota');
    const composed = j.composed_prompt;
    assert.match(composed, new RegExp(`^${fix.state.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/ws/briefs/build-\\d{8}T\\d{6}\\.md$`));
    assert.equal(j.report, composed.replace('/briefs/', '/reports/'));
    // The state files.
    assert.equal(fs.readFileSync(path.join(fix.ws, 'task-build'), 'utf8'), 'implementer: porte da config\n');
    assert.equal(fs.readFileSync(path.join(fix.ws, 'last-report-build'), 'utf8'), j.report + '\n');
    assert.ok(!fs.existsSync(j.report), '--no-wait: the worker has not written the report');
    const composedText = fs.readFileSync(composed, 'utf8');
    assert.ok(composedText.includes('the `implementer` role, agent name `build`'));
    assert.ok(composedText.includes(`- Write your report as Markdown to \`${j.report}\``));
    // The herdr calls: the prompt with the exact text, then the pane title.
    const log = fix.log();
    const promptLine = log.split('\n').find((l) => l.startsWith('agent prompt build '));
    assert.equal(promptLine,
      `agent prompt build Read the file ${composed} in full and execute it. It contains your role, your brief, and your report contract. When finished, write your report to ${j.report} and reply with exactly that path and nothing else.`);
    assert.ok(log.split('\n').includes('pane report-metadata p1 --source herdr-agents --title implementer: porte da config'),
      `title call: ${log}`);
  } finally { fix.cleanup(); }
});

test('dispatch: an untitled brief is titled by its file name', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-untitled-');
  try {
    fix.writeRoster(undefined, ROW12('build', 'p1', 'grok', 'implementer', 'xai', fix.repo, 'grok-4.7', 'build'));
    const brief = fix.brief('brief.md', NO_EXPECTED_BRIEF); // first H1 is `# Goal`
    const r = cmd(fix, ['dispatch', 'build', brief, '--no-wait']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(fix.ws, 'task-build'), 'utf8'), 'implementer: brief\n');
    assert.ok(fix.log().split('\n').includes('pane report-metadata p1 --source herdr-agents --title implementer: brief'));
  } finally { fix.cleanup(); }
});

test('dispatch: the role comes from column 4 of the roster', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-col4-');
  try {
    fix.writeRoster(undefined,
      `${'res'}\tp3\tgrok\tresearcher\txai\t1\t/tmp/work\tnow\tgrok-4.7\tfull\tresearcher`);
    const brief = fix.brief('brief.md', FULL_BRIEF);
    const r = cmd(fix, ['dispatch', 'res', brief, '--no-wait']);
    assert.equal(r.status, 0, r.stderr);
    const j = parsePretty(r.stdout);
    assert.equal(j.role, 'researcher');
    const composedText = fs.readFileSync(j.composed_prompt, 'utf8');
    assert.ok(composedText.includes('the `researcher` role, agent name `res`'));
    assert.ok(!composedText.includes('the `scouter` role'));
  } finally { fix.cleanup(); }
});

test('dispatch: a worker outside the repo root routes the report through $TMPDIR', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-tmpdir-');
  try {
    fix.writeRoster(undefined, ROW12('worker', 'p1', 'grok', 'implementer', 'xai', '/tmp/work', 'grok-4.7', 'build'));
    const brief = fix.brief('brief.md', FULL_BRIEF);
    const r = cmd(fix, ['dispatch', 'worker', brief, '--no-wait']);
    assert.equal(r.status, 0, r.stderr);
    const j = parsePretty(r.stdout);
    const want = path.join(fix.tmpReports(), path.basename(j.report));
    assert.equal(j.report, want);
    assert.equal(j.composed_prompt, want.replace(/\.md$/, '.brief.md'));
    assert.ok(fs.existsSync(j.composed_prompt), 'the composed prompt is under the tmp reports dir');
    assert.equal(fs.readFileSync(path.join(fix.ws, 'last-report-worker'), 'utf8'), j.report + '\n');
    // Nothing landed in the state briefs/reports of this workspace.
    assert.deepEqual(fs.readdirSync(path.join(fix.ws, 'briefs')), []);
    assert.deepEqual(fs.readdirSync(path.join(fix.ws, 'reports')), []);
  } finally { fix.cleanup(); }
});

test('dispatch: a prompt failure prints the error JSON and exits 4', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-promptfail-');
  try {
    fix.writeRoster(undefined, ROW12('build', 'p1', 'grok', 'implementer', 'xai', fix.repo, 'grok-4.7', 'build'));
    const brief = fix.brief('brief.md', FULL_BRIEF);
    fix.promptFail();
    const r = cmd(fix, ['dispatch', 'build', brief, '--no-wait']);
    assert.equal(r.status, 4, r.stdout);
    const j = parsePretty(r.stdout);
    assert.equal(j.wait_status, 'error');
    assert.equal(j.report_exists, false);
    // bash `"$(… 2>&1)"` drops the trailing newline.
    assert.equal(j.raw, 'prompt failed: the fake refused');
    assert.match(r.stderr, /prompt submission failed; inspect with: herdr agent get build && herdr agent read build\. Do not resend blindly\./);
  } finally { fix.cleanup(); }
});

test('dispatch: the family check (strict 5, warn and --allow-same-family continue, off silent)', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-family-');
  try {
    fix.writeRoster(undefined,
      ROW11('rev', 'p9', 'codex', 'reviewer', 'openai', '/tmp/work', 'gpt-5', 'reviewer'),
      ROW11('ex', 'p1', 'codex', 'scouter', 'openai', '/tmp/work', 'gpt-5', 'implementer,scouter'));
    const brief = fix.brief('brief.md', FULL_BRIEF);
    const strict = cmd(fix, ['dispatch', 'rev', brief, '--no-wait']);
    assert.equal(strict.status, 5, strict.stderr);
    assert.match(strict.stderr, /reviewer 'rev' \(codex, openai\) shares a model family with edit agents: ex \(codex\)\. Spawn the reviewer with another --kind, pass --allow-same-family, or set family_check=warn\./);
    const allowed = cmd(fix, ['dispatch', 'rev', brief, '--allow-same-family', '--no-wait']);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.match(allowed.stderr, /reviewer 'rev' shares model family 'openai' with: ex \(codex\)/);
    const warnMode = cmd(fix, ['dispatch', 'rev', brief, '--no-wait'], { HERDR_AGENTS_FAMILY_CHECK: 'warn' });
    assert.equal(warnMode.status, 0, warnMode.stderr);
    assert.match(warnMode.stderr, /shares model family 'openai' with: ex \(codex\)/);
    const off = cmd(fix, ['dispatch', 'rev', brief, '--no-wait'], { HERDR_AGENTS_FAMILY_CHECK: 'off' });
    assert.equal(off.status, 0, off.stderr);
    assert.ok(!/shares model family/.test(off.stderr), 'off: no family warning');
  } finally { fix.cleanup(); }
});

test('dispatch: timeout 9 with a working agent, quota 11 with the lane fields', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-timeout-quota-');
  try {
    fix.writeRoster(undefined, ROW12('build', 'p1', 'grok', 'implementer', 'xai', fix.repo, 'grok-4.7', 'build'));
    const brief = fix.brief('brief.md', FULL_BRIEF);
    fix.mode('working');
    const t = cmd(fix, ['dispatch', 'build', brief, '--timeout', '1500']);
    assert.equal(t.status, 9, t.stderr);
    const tj = parsePretty(t.stdout);
    assert.equal(tj.wait_status, 'timeout');
    assert.match(t.stderr, /timeout waiting for the report of 'build'; it may still be working\. Run: herdr-agents wait build/);
    fix.mode('idle');
    fix.screen('hit your usage limit\ntry again in 2 hours\n');
    const q = cmd(fix, ['dispatch', 'build', brief, '--timeout', '5000']);
    assert.equal(q.status, 11, q.stderr);
    const qj = parsePretty(q.stdout);
    assert.equal(qj.wait_status, 'quota');
    assert.equal(qj.lane, 'build');
    assert.equal(qj.kind, 'grok');
    assert.equal(qj.model, 'grok-4.7');
    assert.match(qj.match, /hit your usage limit/);
    assert.match(qj.renewal, /try again in 2 hours/);
    assert.match(q.stderr, /Ask the user: switch the lane kind\/model, wait for renewal, take the slice, or pause\./);
  } finally { fix.cleanup(); }
});

test('dispatch: usage errors (missing args, unknown option, brief not found, not in roster)', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-usage-');
  try {
    const noAgent = cmd(fix, ['dispatch']);
    assert.equal(noAgent.status, 1, noAgent.stderr);
    assert.match(noAgent.stderr, /1: agent/);
    const noBrief = cmd(fix, ['dispatch', 'build']);
    assert.equal(noBrief.status, 1, noBrief.stderr);
    assert.match(noBrief.stderr, /2: brief\.md/);
    const unknown = cmd(fix, ['dispatch', 'build', 'x.md', '--bogus']);
    assert.equal(unknown.status, 2, unknown.stderr);
    assert.match(unknown.stderr, /dispatch: unknown option --bogus/);
    // A stray positional goes to bash's `*` branch too.
    const stray = cmd(fix, ['dispatch', 'build', 'x.md', 'extra']);
    assert.equal(stray.status, 2, stray.stderr);
    assert.match(stray.stderr, /dispatch: unknown option extra/);
    // A directory is not a brief (bash `[ -f ]`).
    const dirBrief = path.join(fix.root, 'bdir');
    fs.mkdirSync(dirBrief);
    const dirRc = cmd(fix, ['dispatch', 'build', dirBrief]);
    assert.equal(dirRc.status, 2, dirRc.stderr);
    assert.match(dirRc.stderr, /brief not found: /);
    const missing = cmd(fix, ['dispatch', 'build', path.join(fix.root, 'nope.md')]);
    assert.equal(missing.status, 2, missing.stderr);
    assert.match(missing.stderr, /brief not found: /);
    const notInRoster = cmd(fix, ['dispatch', 'ghost', fix.brief('b.md', FULL_BRIEF)]);
    assert.equal(notInRoster.status, 3, notInRoster.stderr);
    assert.match(notInRoster.stderr, /agent 'ghost' is not in this skill's roster \(spawn it first, or pass a name you spawned\)/);
  } finally { fix.cleanup(); }
});

// ---------- review fixes (slice 6b) ----------

test('agentPrompt: stdout and stderr in write order, trailing newlines dropped (bash "$(… 2>&1)")', { timeout: 30000 }, async () => {
  const { agentPrompt } = await import('../lib/herdr.mjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ha-prompt-merge-')));
  try {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    writeFakeCli(bin, 'herdr', [
      "process.stderr.write('first on stderr\\n');",
      "process.stdout.write('then stdout\\n');",
      "process.stderr.write('last on stderr\\n\\n');",
      'process.exitCode = 1;',
    ].join('\n') + '\n');
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, TMPDIR: root };
    const r = agentPrompt('w', 'text', env);
    assert.equal(r.ok, false);
    assert.equal(r.raw, 'first on stderr\nthen stdout\nlast on stderr');
    assert.deepEqual(fs.readdirSync(root).filter((f) => f.startsWith('.herdr-agents-out-')), [], 'no temp file left');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('run: a value flag without its value exits 2 before any spawn', { timeout: 30000 }, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ha-run-novalue-')));
  try {
    const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'herdr-agents.mjs');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const log = path.join(root, 'herdr.log');
    writeFakeCli(bin, 'herdr', `require('node:fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');\n`.replace("require('node:fs')", "(await import('node:fs'))"));
    const env = {
      ...process.env, HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'ws', HERDR_AGENTS_DIR: path.join(root, 'state'),
      HOME: root, XDG_CONFIG_HOME: path.join(root, 'conf'), TMPDIR: root,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    };
    const brief = path.join(root, 'b.md');
    fs.writeFileSync(brief, '# Goal\n');
    for (const flag of ['--kind', '--name', '--timeout']) {
      const r = spawnSync(nodeBin(), [entry, 'run', 'implementer', brief, flag], { env, cwd: root, encoding: 'utf8' });
      assert.equal(r.status, 2, `${flag}: ${r.stderr}`);
      assert.equal(r.stderr, `herdr-agents: run: ${flag} expects a value\n`);
    }
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    assert.ok(!calls.includes('agent start'), 'no agent started');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// scripts/test-tab-labels.sh: the cmd_run flag split — --no-wait goes to
// dispatch and skips the collect (run returns after dispatch), without it
// the collect runs; --tab-label is a spawn flag and is forwarded to spawn.
test('run: --no-wait routes to dispatch and skips collect; --tab-label goes to spawn (test-tab-labels.sh)', () => {
  // With --no-wait: dispatch receives the agent name + --no-wait, no collect.
  let s = splitRunArgs(['--no-wait']);
  assert.deepEqual(s.dispatchArgs, ['--no-wait'], '--no-wait goes to dispatch');
  assert.equal(s.noWait, 1, 'the collect is skipped');
  assert.deepEqual(s.spawnArgs, []);
  // Without it: the collect runs after the dispatch.
  s = splitRunArgs([]);
  assert.equal(s.noWait, 0, 'a waiting run collects');
  assert.deepEqual(s.dispatchArgs, []);
  // --tab-label is parsed as a spawn value flag and forwarded unchanged.
  s = splitRunArgs(['--tab-label', 'paridade']);
  assert.deepEqual(s.spawnArgs, ['--tab-label', 'paridade'], '--tab-label is forwarded to spawn');
  assert.equal(s.noWait, 0);
});
