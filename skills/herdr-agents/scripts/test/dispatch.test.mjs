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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import {
  briefMissingSections, lintBrief, composePrompt, composeAmendment, dispatchPairSuffix, familyConflicts,
  parseBriefLintAliases, missingSectionsReasons, emptyCodeLines, ownedPaths, pathsCross,
  pendingBriefPath, composedBriefSection, sandboxNotes, pendingBriefSection, globMatches,
} from '../lib/dispatch.mjs';
import { splitRunArgs } from '../lib/commands/run.mjs';
import { roleBody } from '../lib/roles.mjs';

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS_ENTRY = path.join(SCRIPTS, 'herdr-agents.mjs');

// ---------- fake herdr (Node) ----------

// `agent get` per target (mode-<t> file) else the global mode file
// (denied → an unqueryable error, missing → agent_not_found, else the mode
// as agent_status; the state_change_seq is read from the FAKE_SEQ file
// when it exists); `agent read` prints screen-<t> (or the global screen
// file); `agent prompt` fails when FAKE_PROMPT_FAIL exists, is a silent
// no-op when the FAKE_PROMPT_SKIP file exists (consumed on the call),
// leaves the prompt text in the input box (FAKE_PROMPT_INPUT), turns the
// worker to working (FAKE_PROMPT_ARRIVE), writes the report named in the
// prompt text with the FAKE_REPORT_TEXT body, or is accepted into the
// scrollback (default: the screen moves, the state stays); `agent
// send-keys` turns the worker to working when the FAKE_SENDKEYS_WORK file
// exists; `agent list` from FAKE_LIVE. Every call is logged as one "$*"
// line (FAKE_LOG).
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
const modeFileOf = (t) => {
  const per = process.env.FAKE_MODE_DIR + '/mode-' + t;
  try { fs.accessSync(per); return per; } catch { return process.env.FAKE_MODE; }
};
const screenTargetOf = (t) => {
  const per = process.env.FAKE_SCREEN_DIR + '/screen-' + t;
  try { fs.accessSync(per); return per; } catch { return process.env.FAKE_SCREEN; }
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
  let seqVal = '';
  try { seqVal = fs.readFileSync(process.env.FAKE_SEQ, 'utf8').trim(); } catch {}
  const seqJson = seqVal !== '' ? ', "state_change_seq": ' + seqVal + '' : '';
  process.stdout.write('{"result":{"agent":{"name":"' + t + '","agent_status":"' + m + '"' + seqJson + '}}}\\n');
} else if (cmd === 'agent read') {
  process.stdout.write(screenOf(t));
} else if (cmd === 'agent prompt') {
  if (process.env.FAKE_PROMPT_SKIP && fs.existsSync(process.env.FAKE_PROMPT_SKIP)) {
    // Item 15: a silent no-op — the pane is left exactly where it was.
    fs.rmSync(process.env.FAKE_PROMPT_SKIP, { force: true });
    process.stdout.write('{"result":{}}\\n');
  } else if (process.env.FAKE_PROMPT_FAIL && fs.existsSync(process.env.FAKE_PROMPT_FAIL)) {
    process.stderr.write('prompt failed: the fake refused\\n');
    process.exit(1);
  } else if (process.env.FAKE_PROMPT_INPUT) {
    // S5 amendment: the text sits in the input box (screen only).
    try { fs.appendFileSync(screenTargetOf(t), '> Read the file /x/brief.md in full and execute it.\\n'); } catch {}
    process.stdout.write('{"result":{}}\\n');
  } else if (process.env.FAKE_PROMPT_ARRIVE) {
    try { fs.writeFileSync(modeFileOf(t), 'working\\n'); } catch {}
    try { fs.writeFileSync(screenTargetOf(t), 'thinking…\\n'); } catch {}
    process.stdout.write('{"result":{"submitted":true}}\\n');
  } else if (process.env.FAKE_REPORT_TEXT !== undefined) {
    // The fake worker writes the report in answer to the prompt: the
    // report path is the last "write your report to <path> and reply" of
    // the prompt text, the body is the FAKE_REPORT_TEXT value.
    const promptText = argv[3] ?? '';
    const rm = promptText.match(/write your report to (.+) and reply with exactly that path and nothing else\.$/);
    if (rm) { try { fs.writeFileSync(rm[1], process.env.FAKE_REPORT_TEXT); } catch {} }
    process.stdout.write('{"result":{"submitted":true}}\\n');
  } else {
    // Accepted into the scrollback: the screen moves, the state stays.
    try { fs.appendFileSync(screenTargetOf(t), 'prompt received: ok\\n'); } catch {}
    process.stdout.write('{"result":{"submitted":true}}\\n');
  }
} else if (cmd === 'agent send-keys') {
  // S5 input-box case: the Enter starts the worker only when the
  // FAKE_SENDKEYS_WORK file exists; otherwise the key is swallowed.
  if (process.env.FAKE_SENDKEYS_WORK && fs.existsSync(process.env.FAKE_SENDKEYS_WORK)) {
    try { fs.writeFileSync(modeFileOf(t), 'working\\n'); } catch {}
  }
  process.stdout.write('{"result":{}}\\n');
} else if (cmd === 'agent list') {
  let agents = [];
  try { agents = (JSON.parse(fs.readFileSync(process.env.FAKE_LIVE, 'utf8')).agents) ?? []; } catch {}
  process.stdout.write(JSON.stringify({ result: { agents } }) + '\\n');
} else if (cmd === 'agent start') {
  // spawn path (run tests): a fresh pane starts fine.
  process.stdout.write('{"result":{"started":true}}\\n');
} else if (cmd === 'agent rename') {
  process.stdout.write('{"result":{}}\\n');
} else if (cmd === 'tab create') {
  process.stdout.write('{"result":{"tab":{"tab_id":"t-herd","label":"herd"},"root_pane":{"pane_id":"p-new"}}}\\n');
} else if (cmd === 'tab get') {
  process.stdout.write('{"result":{"tab":{"tab_id":"t-herd","label":"herd"},"root_pane":{"pane_id":"p-root"}}}\\n');
} else if (cmd === 'tab rename') {
  process.stdout.write('{"result":{}}\\n');
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
    HERDR_AGENTS_PROMPT_CHECK_SECONDS: '1',
    FAKE_MODE: path.join(root, 'mode'),
    FAKE_MODE_DIR: modeDir,
    FAKE_SCREEN: path.join(root, 'screen'),
    FAKE_SCREEN_DIR: screenDir,
    FAKE_LIVE: path.join(root, 'live.json'),
    FAKE_LOG: path.join(root, 'herdr.log'),
    FAKE_PROMPT_FAIL: path.join(root, 'prompt-fail'),
    FAKE_PROMPT_SKIP: path.join(root, 'prompt-skip'),
    FAKE_SENDKEYS_WORK: path.join(root, 'sendkeys-work'),
    FAKE_SEQ: path.join(root, 'seq'),
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
    // Item 15: the next `agent prompt` is a silent no-op (file consumed).
    promptSkip() { fs.writeFileSync(env.FAKE_PROMPT_SKIP, '1\n'); },
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
      'herdr-agents: warning: brief ' + f + ' is missing sections: [Expected result] — nothing says when the slice is done\n');
    // off: no output at all.
    captured = '';
    process.stderr.write = (s) => { captured += s; return true; };
    try { lintBrief(f, fix.ctx, { ...fix.env, HERDR_AGENTS_BRIEF_LINT: 'off' }); }
    finally { process.stderr.write = orig; }
    assert.equal(captured, '', 'off is silent');
    // strict dies 2 (through the entry, where the friction log is live):
    const r = cmd(fix, ['dispatch', 'build', f, '--no-wait'], { HERDR_AGENTS_BRIEF_LINT: 'strict' });
    assert.equal(r.status, 2, r.stderr);
    assert.ok(r.stderr.includes(`herdr-agents: brief ${f} is missing sections: [Expected result] — nothing says when the slice is done (brief_lint=strict)\n`), r.stderr);
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

test('family: a documenter session is an edit agent only when it edited before', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-fam-documenter-');
  try {
    // The documenter is a mode-edit role: an edit role in the history
    // (before the documentation) counts as an edit agent.
    fix.writeRoster(undefined,
      ROW11('doc', 'p1', 'codex', 'documenter', 'openai', '/tmp/work', 'gpt-5', 'implementer,documenter'));
    assert.deepEqual(familyConflicts(fix.ws, 'openai', fix.env, fix.repo), ['doc (codex)'], 'an edit before the documentation counts');
    // A worker that only documented (current role documenter, a roles
    // history holding nothing but documenter) is not an edit agent.
    fix.writeRoster(undefined,
      ROW11('doc', 'p1', 'codex', 'documenter', 'openai', '/tmp/work', 'gpt-5', 'documenter'));
    assert.deepEqual(familyConflicts(fix.ws, 'openai', fix.env, fix.repo), [], 'only documented: free for the reviewer');
    // An empty history holds nothing but documenter: it qualifies.
    fix.writeRoster(undefined,
      ROW11('doc', 'p1', 'codex', 'documenter', 'openai', '/tmp/work', 'gpt-5', ''));
    assert.deepEqual(familyConflicts(fix.ws, 'openai', fix.env, fix.repo), [], 'empty history qualifies');
    // An old 8-column documenter line (no history) does not block.
    fix.writeRoster(undefined,
      ROW8('doc', 'p1', 'codex', 'documenter', 'openai'));
    assert.deepEqual(familyConflicts(fix.ws, 'openai', fix.env, fix.repo), [], '8-column line: no history');
    // Another edit role in the history also counts (historyHasEdit).
    fix.writeRoster(undefined,
      ROW11('doc', 'p1', 'codex', 'documenter', 'openai', '/tmp/work', 'gpt-5', 'designer,documenter'));
    assert.deepEqual(familyConflicts(fix.ws, 'openai', fix.env, fix.repo), ['doc (codex)']);
    // Mutation captured: the documenter-only history counted as an edit
    // (a reviewer blocked by a pure documentation session), or the edit
    // before the documentation not counted (a reviewer let through a
    // session that edited the code).
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
      '- Write your report as Markdown to `' + report + '` (create parent directories if needed) following the `<report>` section of your role. Give every item its state as `[done]`, `[partial]` or `[skipped]`, followed by the reason.\n',
      '- Write the report in one go, as the last action of your work; the orchestrator treats its existence as completion.\n',
      '- Only you write this report, once all of the brief is done, including any part you handed to subagents or background tasks; a subagent never writes it. Report every item as it stands in the files, not as a subagent summarized it.\n',
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

test('dispatch: a provider-error worker exits 14 with the lane, model and cause', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-provider-');
  try {
    fix.writeRoster(undefined, ROW12('build', 'p1', 'grok', 'implementer', 'xai', fix.repo, 'grok-4.7', 'build'));
    const brief = fix.brief('brief.md', FULL_BRIEF);
    fix.mode('idle');
    fix.screen('Error: connect ECONNREFUSED\n');
    // Mutation captured: missing exit 14, or a JSON without lane/model/
    // cause (or with kind/retries keys), fails the asserts below.
    const r = cmd(fix, ['dispatch', 'build', brief, '--timeout', '5000']);
    assert.equal(r.status, 14, r.stderr);
    const j = parsePretty(r.stdout);
    assert.equal(j.wait_status, 'provider-error');
    assert.equal(j.lane, 'build');
    assert.equal(j.model, 'grok-4.7');
    assert.equal(j.cause, 'Error: connect ECONNREFUSED');
    assert.equal(j.kind, 'grok', 'the base kind key stays');
    assert.ok(!('retries' in j) && !('match' in j) && !('renewal' in j),
      'provider-error adds lane, model, cause only (no retries)');
    assert.match(r.stderr, /agent 'build' stopped on a provider error: Error: connect ECONNREFUSED\. It is idle without a report; ask the user whether to resend the brief, switch the assistant, or wait\./);
  } finally { fix.cleanup(); }
});

test('dispatch: capacity after one continue exits 14 with the retries', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-capacity-');
  try {
    fix.writeRoster(undefined, ROW12('build', 'p1', 'grok', 'implementer', 'xai', fix.repo, 'grok-4.7', 'build'));
    const brief = fix.brief('brief.md', FULL_BRIEF);
    fix.mode('idle');
    fix.screen('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n');
    // Mutation captured: ignoring provider_retries (or the wait_status
    // branches) leaves the JSON/exit code on the wrong path.
    const r = cmd(fix, ['dispatch', 'build', brief, '--timeout', '5000'],
      { HERDR_AGENTS_PROVIDER_RETRIES: '1', HERDR_AGENTS_PROVIDER_RETRY_DELAY: '0' });
    assert.equal(r.status, 14, r.stderr);
    const j = parsePretty(r.stdout);
    assert.equal(j.wait_status, 'capacity');
    assert.equal(j.lane, 'build');
    assert.equal(j.model, 'grok-4.7');
    assert.equal(j.retries, 1);
    assert.match(j.cause, /529/);
    assert.match(r.stderr, /agent 'build' is still at provider capacity after 1 continue\(s\): .*529.* Ask the user whether to wait and resend, switch the assistant, or pause\./);
  } finally { fix.cleanup(); }
});

// ---------- item 15: the prompt-arrival check (S5 + amendment) ----------

// The state turning to working right after the send is an arrival: no
// resend, no keys, the JSON stays on the plain submitted shape.
test('dispatch: arrival confirmed by the state turning working → no resend', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-arrive-');
  try {
    fix.writeRoster(undefined, ROW12('build', 'p1', 'grok', 'implementer', 'xai', fix.repo, 'grok-4.7', 'build'));
    const brief = fix.brief('brief.md', FULL_BRIEF);
    fix.mode('idle');
    // Mutation captured: not checking the arrival (or checking the old
    // screen-change rule) would skip or mis-time this fake's state turn
    // and the log counts below fail.
    const r = cmd(fix, ['dispatch', 'build', brief, '--no-wait'],
      { HERDR_AGENTS_PROMPT_CHECK_SECONDS: '3', FAKE_PROMPT_ARRIVE: '1' });
    assert.equal(r.status, 0, r.stderr);
    const j = parsePretty(r.stdout);
    assert.equal(j.wait_status, 'submitted');
    assert.ok(!('resent' in j) && !('enter_sent' in j), 'no arrival keys on a plain arrival');
    const log = fix.log().split('\n').filter((l) => l !== '');
    assert.equal(log.filter((l) => l.startsWith('agent prompt build ')).length, 1, 'one prompt only');
    assert.equal(log.filter((l) => l.startsWith('agent send-keys')).length, 0, 'no keys sent');
  } finally { fix.cleanup(); }
});

// The pane never moved (screen == H0, state idle): the single resend is
// sent, it arrives, and the JSON carries resent after auto_approved.
test('dispatch: an ignored prompt is resent once and the JSON carries resent', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-resent-');
  try {
    fix.writeRoster(undefined, ROW12('build', 'p1', 'grok', 'implementer', 'xai', fix.repo, 'grok-4.7', 'build'));
    const brief = fix.brief('brief.md', FULL_BRIEF);
    fix.mode('idle');
    fix.screen('Welcome to the worker\n');
    fix.promptSkip(); // the first prompt is a silent no-op; the second arrives
    // Mutation captured: never resending (or resending twice) changes the
    // prompt count below or drops the resent key / the resend warn.
    const r = cmd(fix, ['dispatch', 'build', brief, '--no-wait'],
      { HERDR_AGENTS_PROMPT_CHECK_SECONDS: '2', FAKE_PROMPT_ARRIVE: '1' });
    assert.equal(r.status, 0, r.stderr);
    const j = parsePretty(r.stdout);
    assert.equal(j.wait_status, 'submitted');
    assert.equal(j.resent, true, 'the resend is reported');
    assert.deepEqual(Object.keys(j),
      ['wait_status', 'agent', 'role', 'kind', 'composed_prompt', 'report', 'report_exists', 'auto_approved', 'resent']);
    const log = fix.log().split('\n').filter((l) => l !== '');
    assert.equal(log.filter((l) => l.startsWith('agent prompt build ')).length, 2, 'exactly two prompts');
    assert.match(r.stderr, /prompt to 'build' did not arrive \(screen unchanged, agent not working\); sending it once more/);
  } finally { fix.cleanup(); }
});

// Swallowed twice (the resend lands in the scrollback but the state stays
// idle and there is no report): not-received, exit 15, the error-case keys
// without raw.
test('dispatch: a prompt ignored twice ends not-received with exit 15', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-notreceived-');
  try {
    fix.writeRoster(undefined, ROW12('build', 'p1', 'grok', 'implementer', 'xai', fix.repo, 'grok-4.7', 'build'));
    const brief = fix.brief('brief.md', FULL_BRIEF);
    fix.mode('idle');
    fix.screen('Welcome to the worker\n');
    fix.promptSkip(); // the first prompt is swallowed; the resend hits the
    // default "accepted into the scrollback" fake (state stays idle)
    // Mutation captured: exiting 0 instead of 15, or a JSON with the raw
    // key (or missing wait_status), fails the asserts below.
    fs.writeFileSync(fix.env.FAKE_SEQ, '7\n'); // the marker carries the seq read at not-received
    const r = cmd(fix, ['dispatch', 'build', brief, '--no-wait'],
      { HERDR_AGENTS_PROMPT_CHECK_SECONDS: '2' });
    assert.equal(r.status, 15, r.stderr);
    const j = parsePretty(r.stdout);
    assert.equal(j.wait_status, 'not-received');
    assert.deepEqual(Object.keys(j),
      ['wait_status', 'agent', 'role', 'kind', 'composed_prompt', 'report', 'report_exists'],
      'the error-case keys without raw');
    assert.equal(j.report_exists, false);
    // Mutation captured: not recording the not-received moment (or writing
    // it on a received dispatch) leaves the wait unable to retry the
    // Enter; the marker holds the epoch and the state_change_seq read at
    // the moment.
    assert.match(fs.readFileSync(path.join(fix.ws, 'wait', 'build.not-received'), 'utf8'),
      /^\d{10} 7\n$/, 'the marker holds the epoch and the seq');
    assert.equal(fs.existsSync(path.join(fix.ws, 'wait', 'build.enter-retry')), false,
      'no Enter was attempted, so no retry counter');
    const log = fix.log().split('\n').filter((l) => l !== '');
    assert.equal(log.filter((l) => l.startsWith('agent prompt build ')).length, 2, 'one prompt + one resend');
    assert.match(r.stderr, /prompt to 'build' was not received after one resend; read the pane \(herdr agent read build --source visible\) before sending anything else/);
  } finally { fix.cleanup(); }
});

// 0 turns the check off: one prompt and nothing else — no H0 screen read,
// no arrival probes, no resend — even for an idle pane.
test('dispatch: prompt_check_seconds=0 sends one prompt and probes nothing', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-nocheck-');
  try {
    fix.writeRoster(undefined, ROW12('build', 'p1', 'grok', 'implementer', 'xai', fix.repo, 'grok-4.7', 'build'));
    const brief = fix.brief('brief.md', FULL_BRIEF);
    fix.mode('idle'); // an idle pane would be `not-received` if the check ran
    // Mutation captured: running the arrival check anyway (or resending)
    // adds agent get/read lines or a second prompt to the log below.
    const r = cmd(fix, ['dispatch', 'build', brief, '--no-wait'],
      { HERDR_AGENTS_PROMPT_CHECK_SECONDS: '0' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(parsePretty(r.stdout).wait_status, 'submitted');
    const log = fix.log().split('\n').filter((l) => l !== '');
    assert.equal(log.filter((l) => l.startsWith('agent prompt build ')).length, 1, 'one prompt only');
    assert.equal(log.filter((l) => l.startsWith('agent get ')).length, 0, 'no arrival probes');
    assert.equal(log.filter((l) => l.startsWith('agent read ')).length, 0, 'no screen reads (not even the H0)');
    // With the check off the dispatch never records a not-received moment.
    assert.equal(fs.existsSync(path.join(fix.ws, 'wait', 'build.not-received')), false, 'no marker with the check off');
  } finally { fix.cleanup(); }
});

// The prompt text is visible in the input box and the state stays idle:
// one Enter key, no second prompt, the JSON carries enter_sent.
test('dispatch: a prompt sitting in the input box gets one Enter (enter_sent)', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-enter-');
  try {
    fix.writeRoster(undefined, ROW12('build', 'p1', 'grok', 'implementer', 'xai', fix.repo, 'grok-4.7', 'build'));
    const brief = fix.brief('brief.md', FULL_BRIEF);
    fix.mode('idle');
    fix.screen('Welcome to the worker\n');
    fs.writeFileSync(fix.env.FAKE_SENDKEYS_WORK, '1\n'); // the Enter starts the worker
    // Mutation captured: not detecting the input box (or resending instead
    // of the Enter, or sending the key before the window) changes the log
    // and the enter_sent key below.
    const r = cmd(fix, ['dispatch', 'build', brief, '--no-wait'],
      { HERDR_AGENTS_PROMPT_CHECK_SECONDS: '2', FAKE_PROMPT_INPUT: '1' });
    assert.equal(r.status, 0, r.stderr);
    const j = parsePretty(r.stdout);
    assert.equal(j.wait_status, 'submitted');
    assert.equal(j.enter_sent, true, 'the Enter is reported');
    assert.ok(!('resent' in j), 'no resend in the input-box case');
    assert.deepEqual(Object.keys(j),
      ['wait_status', 'agent', 'role', 'kind', 'composed_prompt', 'report', 'report_exists', 'auto_approved', 'enter_sent']);
    const log = fix.log().split('\n').filter((l) => l !== '');
    assert.equal(log.filter((l) => l.startsWith('agent prompt build ')).length, 1, 'no second prompt');
    assert.deepEqual(log.filter((l) => l.startsWith('agent send-keys')),
      ['agent send-keys build enter'], 'exactly one Enter');
    assert.match(r.stderr, /prompt to 'build' sat in the input box; sent Enter/);
  } finally { fix.cleanup(); }
});

// The same input-box case, but the fake swallows the Enter (state stays
// idle, no report): not-received, exit 15, and still no second prompt —
// the input-box case never resends.
test('dispatch: an input-box prompt that ignores the Enter ends not-received (exit 15)', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-enter-ignored-');
  try {
    fix.writeRoster(undefined, ROW12('build', 'p1', 'grok', 'implementer', 'xai', fix.repo, 'grok-4.7', 'build'));
    const brief = fix.brief('brief.md', FULL_BRIEF);
    fix.mode('idle');
    fix.screen('Welcome to the worker\n');
    // No FAKE_SENDKEYS_WORK: the fake swallows the Enter.
    // Mutation captured: resending after the ignored Enter (a second
    // agent prompt) or reporting `submitted` instead of 15 fails the
    // asserts below.
    const r = cmd(fix, ['dispatch', 'build', brief, '--no-wait'],
      { HERDR_AGENTS_PROMPT_CHECK_SECONDS: '2', FAKE_PROMPT_INPUT: '1' });
    assert.equal(r.status, 15, r.stderr);
    const j = parsePretty(r.stdout);
    assert.equal(j.wait_status, 'not-received');
    assert.deepEqual(Object.keys(j),
      ['wait_status', 'agent', 'role', 'kind', 'composed_prompt', 'report', 'report_exists']);
    // The same marker as the resend path: the wait retries the Enter from
    // this moment. No FAKE_SEQ file here: the fake returns no seq, so the
    // marker stays epoch-only (the older format, still valid).
    assert.match(fs.readFileSync(path.join(fix.ws, 'wait', 'build.not-received'), 'utf8'),
      /^\d{10}\n$/, 'epoch-only marker without a seq');
    assert.equal(fs.existsSync(path.join(fix.ws, 'wait', 'build.enter-retry')), false,
      'the dispatch Enter is not counted as a wait retry');
    const log = fix.log().split('\n').filter((l) => l !== '');
    assert.equal(log.filter((l) => l.startsWith('agent prompt build ')).length, 1, 'no second prompt after the Enter');
    assert.deepEqual(log.filter((l) => l.startsWith('agent send-keys')),
      ['agent send-keys build enter'], 'the Enter was still sent once');
    assert.match(r.stderr, /prompt to 'build' sat in the input box; sent Enter/);
    assert.match(r.stderr, /prompt to 'build' was not received after an Enter on the text left in its input box/);
    assert.ok(!r.stderr.includes('after one resend'), 'no resend happened, so the message does not claim one');
  } finally { fix.cleanup(); }
});

// The not-received marker is the dispatch's hand-off to the wait: a new
// dispatch clears it (as it clears every other wait marker), so a fresh
// prompt starts with a clean retry budget.
test('dispatch: a new dispatch clears the not-received and enter-retry markers', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-clearnr-');
  try {
    fix.writeRoster(undefined, ROW12('build', 'p1', 'grok', 'implementer', 'xai', fix.repo, 'grok-4.7', 'build'));
    const brief = fix.brief('brief.md', FULL_BRIEF);
    fs.writeFileSync(path.join(fix.ws, 'wait', 'build.not-received'), '1700000000\n');
    fs.writeFileSync(path.join(fix.ws, 'wait', 'build.enter-retry'), '2 1700000015\n');
    const r = cmd(fix, ['dispatch', 'build', brief, '--no-wait'], { HERDR_AGENTS_PROMPT_CHECK_SECONDS: '0' });
    assert.equal(r.status, 0, r.stderr);
    // Mutation captured: the markers missing from the dispatch's clear
    // list let the next wait retry an Enter for a stale not-received.
    assert.equal(fs.existsSync(path.join(fix.ws, 'wait', 'build.not-received')), false, 'not-received cleared');
    assert.equal(fs.existsSync(path.join(fix.ws, 'wait', 'build.enter-retry')), false, 'enter-retry cleared');
  } finally { fix.cleanup(); }
});

// The report-writer line is the first standing rule of every composed
// prompt (brief and amendment): only the worker writes the report, once
// the whole brief is done, and a subagent never writes it.
test('compose: the report-writer line leads the standing rules in brief and amendment', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-rulereport-');
  try {
    const line = '- Only you write this report, once all of the brief is done, including any part you handed to subagents or background tasks; a subagent never writes it. Report every item as it stands in the files, not as a subagent summarized it.\n';
    const roleFile = path.join(fix.repo, 'alpha.md');
    fs.writeFileSync(roleFile, '---\nname: alpha\n---\n\nBody.\n');
    const report = '/r.md';
    const briefPrompt = composePrompt(roleFile, 'alpha', 'w1', '# Goal\nGo.\n', report, fix.ctx, fix.env);
    const amendPrompt = composeAmendment('# Amend\nDo X.\n', report, fix.ctx, fix.env);
    // Mutation captured: the line dropped from one of the two composed
    // prompts (or duplicated) fails one of the indexOf asserts below.
    for (const [name, text] of [['brief', briefPrompt], ['amendment', amendPrompt]]) {
      assert.equal(text.indexOf(line), text.lastIndexOf(line), `${name}: exactly one`);
      assert.ok(text.indexOf(line) !== -1, `${name}: the line is present`);
      // The line leads the standing rules: it sits before the no-questions
      // line and after the one-go rule.
      assert.ok(text.indexOf('- Write the report in one go') < text.indexOf(line), `${name}: after the one-go rule`);
      assert.ok(text.indexOf(line) < text.indexOf('- Nobody watches this terminal'), `${name}: before the no-questions line`);
    }
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

// A worker that ends on a question screen (with the wait): the final JSON
// carries wait_status `question` and the question key after auto_approved,
// exit 7; the .question file lands under <state>/wait/ (dispatch clears it
// on the next dispatch).
test('dispatch: a worker that ends in a question exits 7 with the question in the JSON', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-question-');
  try {
    fix.writeRoster(undefined, ROW12('build', 'p1', 'codex', 'implementer', 'xai', fix.repo, 'gpt-5', 'build'));
    const brief = fix.brief('brief.md', FULL_BRIEF);
    fix.mode('blocked');
    fix.screen('  1. Use the local cache\n  2. Fetch from remote\n\nEnter to submit answer, esc to cancel\n');
    fix.promptSkip(); // silent no-op: the screen stays exactly the question screen
    // Mutation captured: a `question` wait falling through to the default
    // case (or a JSON without the question key after auto_approved)
    // changes the rc and the key set below.
    const r = cmd(fix, ['dispatch', 'build', brief, '--timeout', '10000'],
      { HERDR_AGENTS_PROMPT_CHECK_SECONDS: '3' });
    assert.equal(r.status, 7, r.stderr);
    const j = parsePretty(r.stdout);
    assert.equal(j.wait_status, 'question');
    assert.equal(j.question, '  1. Use the local cache\n  2. Fetch from remote\nEnter to submit answer, esc to cancel');
    assert.deepEqual(Object.keys(j),
      ['wait_status', 'agent', 'role', 'kind', 'composed_prompt', 'report', 'report_exists', 'auto_approved', 'question']);
    assert.ok(fs.existsSync(path.join(fix.ws, 'wait', 'build.question')), 'the .question file is kept for the next wait');
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

// ---------- lint by role mode (read-only needs no Owned files) ----------

test('lint: a read-only brief needs no Owned files; the other sections still hold', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-lint-ro-');
  try {
    const noOwned = FULL_BRIEF.replace('# Owned files\n\nscripts/x.mjs\n', '');
    const f = fix.brief('brief.md', noOwned);
    assert.equal(briefMissingSections(f), ' [Owned files]');
    assert.equal(briefMissingSections(f, { readOnly: true }), '');
    const noForbidden = noOwned.replace('# Forbidden\n', '');
    const g = fix.brief('g.md', noForbidden);
    assert.equal(briefMissingSections(g, { readOnly: true }), ' [Forbidden]');
    const noGit = noOwned.replace('Do not commit or push.', 'Do nothing.');
    const h = fix.brief('h.md', noGit);
    assert.equal(briefMissingSections(h, { readOnly: true }), " [no-git line: say 'no commit/push']");
    // Mutation captured: the readOnly flag not skipping the Owned files
    // check (a read-only brief flagged) or skipping another section (a
    // read-only brief without Forbidden or without the no-git line passed)
    // fails one of the asserts above.
  } finally { fix.cleanup(); }
});

test('dispatch: warn mode — an edit role without Owned files warns, a read-only role does not', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-lint-ro-entry-');
  try {
    fix.writeRoster(undefined,
      ROW12('build', 'p1', 'grok', 'implementer', 'xai', fix.repo, 'grok-4.7', 'build'),
      ROW12('rev', 'p2', 'codex', 'reviewer', 'openai', fix.repo, 'gpt-5', 'build'));
    const f = fix.brief('brief.md', FULL_BRIEF.replace('# Owned files\n\nscripts/x.mjs\n', ''));
    const e1 = cmd(fix, ['dispatch', 'build', f, '--no-wait']);
    assert.equal(e1.status, 0, e1.stderr);
    assert.match(e1.stderr, /warning: brief .* is missing sections: \[Owned files\] — workers without owned files collide/);
    const e2 = cmd(fix, ['dispatch', 'rev', f, '--no-wait']);
    assert.equal(e2.status, 0, e2.stderr);
    assert.ok(!e2.stderr.includes('missing sections'), 'a read-only role needs no Owned files section');
    // Mutation captured: the lint not reading the role's mode (the
    // reviewer warned too) or the edit role not warned fails the asserts.
  } finally { fix.cleanup(); }
});

test('dispatch: lint runs after the role (error order 2 → 3 → 3 → 2; read-only strict passes)', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-lint-order-');
  try {
    const noOwned = FULL_BRIEF.replace('# Owned files\n\nscripts/x.mjs\n', '');
    const strict = { HERDR_AGENTS_BRIEF_LINT: 'strict' };
    // 1. a missing brief dies 2 before the roster, the role and the lint.
    const r1 = cmd(fix, ['dispatch', 'build', path.join(fix.root, 'missing.md'), '--no-wait'], strict);
    assert.equal(r1.status, 2, r1.stderr);
    assert.match(r1.stderr, /brief not found: /);
    // 2. an agent outside the roster dies 3 before the lint.
    const r2 = cmd(fix, ['dispatch', 'ghost', fix.brief('a.md', noOwned), '--no-wait'], strict);
    assert.equal(r2.status, 3, r2.stderr);
    assert.match(r2.stderr, /agent 'ghost' is not in this skill's roster/);
    // 3. an unknown role dies 3 before the lint.
    fix.writeRoster(undefined, ROW12('odd', 'p1', 'grok', 'nosuchrole', 'xai', fix.repo, 'grok-4.7', 'build'));
    const r3 = cmd(fix, ['dispatch', 'odd', fix.brief('b.md', noOwned), '--no-wait'], strict);
    assert.equal(r3.status, 3, r3.stderr);
    assert.match(r3.stderr, /unknown role 'nosuchrole'/);
    // 4. only then the strict lint dies 2 — for an edit role without
    // Owned files.
    fix.writeRoster(undefined, ROW12('build', 'p1', 'grok', 'implementer', 'xai', fix.repo, 'grok-4.7', 'build'));
    const cBrief = fix.brief('c.md', noOwned);
    const r4 = cmd(fix, ['dispatch', 'build', cBrief, '--no-wait'], strict);
    assert.equal(r4.status, 2, r4.stderr);
    assert.ok(r4.stderr.includes(`brief ${cBrief} is missing sections: [Owned files] — workers without owned files collide (brief_lint=strict)`), r4.stderr);
    // 5. a read-only role without Owned files passes strict.
    fix.writeRoster(undefined, ROW12('rev', 'p1', 'codex', 'reviewer', 'openai', fix.repo, 'gpt-5', 'build'));
    const r5 = cmd(fix, ['dispatch', 'rev', fix.brief('d.md', noOwned), '--no-wait'], strict);
    assert.equal(r5.status, 0, r5.stderr);
    assert.ok(!r5.stderr.includes('missing sections'), 'read-only: no lint warning');
    // Mutation captured: the lint running before the role resolution (a
    // strict brief dying 2 before the roster/role 3) or the read-only
    // exemption missing (the reviewer dying 2) fails the rc asserts.
  } finally { fix.cleanup(); }
});

// ---------- --amend ----------

test('dispatch --amend: new report, wait markers cleared, title keeps the task without the check mark, no lint', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-amend-');
  try {
    fix.writeRoster(undefined, ROW12('build', 'p1', 'grok', 'implementer', 'xai', fix.repo, 'grok-4.7', 'build'));
    const brief = fix.brief('brief.md', FULL_BRIEF.replace('# Goal\n', '# Brief — fix the config\n# Goal\n'));
    const first = cmd(fix, ['dispatch', 'build', brief, '--no-wait']);
    assert.equal(first.status, 0, first.stderr);
    const j1 = parsePretty(first.stdout);
    // The worker finished: the report exists and the pane title is marked.
    fs.writeFileSync(j1.report, 'first report\n');
    fs.writeFileSync(path.join(fix.ws, 'task-build'), 'implementer: fix the config ✓\n');
    fs.writeFileSync(path.join(fix.ws, 'wait', 'build.size'), '12\n');
    fs.writeFileSync(path.join(fix.ws, 'wait', 'build.question'), 'a question\n');
    // The amendment is a delta: no contract sections of its own.
    const amend = fix.brief('amend.md', '# Amend — use the right flag\n\nDo X with `--flag` instead.\n');
    // No pause: the amendment goes out in the same second as the first
    // dispatch, so the pair must be taken with a suffixed name.
    const r = cmd(fix, ['dispatch', 'build', amend, '--amend', '--no-wait']);
    assert.equal(r.status, 0, r.stderr);
    const j = parsePretty(r.stdout);
    assert.equal(j.wait_status, 'submitted');
    assert.deepEqual(Object.keys(j),
      ['wait_status', 'agent', 'role', 'kind', 'composed_prompt', 'report', 'report_exists', 'amend', 'auto_approved'],
      'the amend key sits right after report_exists');
    assert.equal(j.amend, true);
    assert.equal(j.report_exists, false, '--no-wait: the amendment report is not written yet');
    assert.notEqual(j.report, j1.report, 'the amendment gets a new report, even in the same second');
    assert.equal(fs.readFileSync(path.join(fix.ws, 'last-report-build'), 'utf8'), j.report + '\n',
      'last-report points at the amendment report');
    // The wait markers of the finished brief are cleared: the wait starts
    // clean and watches the new report.
    assert.ok(!fs.existsSync(path.join(fix.ws, 'wait', 'build.size')));
    assert.ok(!fs.existsSync(path.join(fix.ws, 'wait', 'build.question')));
    // The pane keeps the current task, without the check mark.
    assert.equal(fs.readFileSync(path.join(fix.ws, 'task-build'), 'utf8'), 'implementer: fix the config\n');
    const titleLine = 'pane report-metadata p1 --source herdr-agents --title implementer: fix the config';
    assert.equal(fix.log().split('\n').filter((l) => l === titleLine).length, 2,
      `the first dispatch + the amendment reapplying the task: ${fix.log()}`);
    // No section lint: the amendment is a delta, not a brief.
    assert.ok(!r.stderr.includes('missing sections'), 'no lint warning on the amendment');
    // The sent text: the marker plus the amendment wording.
    const promptLine = fix.log().split('\n').find((l) => l.startsWith(`agent prompt build Read the file ${j.composed_prompt} `));
    assert.equal(promptLine,
      `agent prompt build Read the file ${j.composed_prompt} in full and execute it. It amends the brief you are working on. When finished, write your report to ${j.report} and reply with exactly that path and nothing else.`);
    // The composed amendment prompt, byte for byte.
    const amendRaw = fs.readFileSync(amend, 'utf8');
    const contract = [
      '- This amendment overrides your current brief where they differ; the rest of that brief still holds.\n',
      `- Write your report as Markdown to \`${j.report}\` (create parent directories if needed). If you have not written the report of your current brief yet, write one report there that covers the brief and this amendment; otherwise report only on the amendment.\n`,
      '- Give every item its state as `[done]`, `[partial]` or `[skipped]`, followed by the reason.\n',
      '- Write the report in one go, as the last action of your work; the orchestrator treats its existence as completion.\n',
      '- Only you write this report, once all of the brief is done, including any part you handed to subagents or background tasks; a subagent never writes it. Report every item as it stands in the files, not as a subagent summarized it.\n',
      '- Nobody watches this terminal: do not ask interactive questions or wait for a confirmation. When the brief does not decide something, follow its "When the brief does not decide" section, or mark the item partial and list the gap and the options under open questions.\n',
      '- Never invent names, endpoints, flags, credentials, URLs or requirements.\n',
      '- Do not commit, push, tag, or open pull requests.\n',
      '- When finished, reply in the terminal with exactly the report path and nothing else.\n',
    ].join('');
    assert.equal(fs.readFileSync(j.composed_prompt, 'utf8'),
      `# Amendment to your current brief\n\n${amendRaw}\n\n# Report contract\n\n${contract}`,
      'the composed amendment prompt');
    // Mutation captured: the wait markers not cleared (the wait kept the
    // finished brief's state), last-report not updated (the wait kept
    // watching the old report), the check mark not dropped from the task
    // (the pane stayed "done" while the amendment is in flight), or a
    // lint warning on the amendment, fails one of the asserts.
  } finally { fix.cleanup(); }
});

test('dispatch --amend: without a task file the title comes from the amendment file', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-amend-title-');
  try {
    fix.writeRoster(undefined, ROW12('build', 'p1', 'grok', 'implementer', 'xai', fix.repo, 'grok-4.7', 'build'));
    // An earlier dispatch happened (it recorded the report) but left no
    // task file.
    fs.writeFileSync(path.join(fix.ws, 'last-report-build'), '/some/report.md\n');
    const amend = fix.brief('amend.md', '# Amend — retry with the right flag\n\nDo it.\n');
    const r = cmd(fix, ['dispatch', 'build', amend, '--amend', '--no-wait']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(fix.ws, 'task-build'), 'utf8'), 'implementer: Amend — retry with the right flag\n');
    assert.ok(fix.log().split('\n').includes('pane report-metadata p1 --source herdr-agents --title implementer: Amend — retry with the right flag'),
      `the title: ${fix.log()}`);
    // Mutation captured: the amendment re-titling the pane from its own
    // file (dropping the current task) or not writing the task file (the
    // check mark could never land) fails the asserts.
  } finally { fix.cleanup(); }
});

test('dispatch --amend: without an earlier dispatch it exits 2 (exact text)', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-amend-none-');
  try {
    fix.writeRoster(undefined, ROW12('build', 'p1', 'grok', 'implementer', 'xai', fix.repo, 'grok-4.7', 'build'));
    const amend = fix.brief('amend.md', 'Fix the flag.\n');
    const r = cmd(fix, ['dispatch', 'build', amend, '--amend', '--no-wait']);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /dispatch: --amend needs an earlier dispatch to 'build' \(nothing to amend\)/);
    assert.ok(!fix.log().includes('agent prompt'), 'nothing was sent');
    assert.ok(!fs.existsSync(path.join(fix.ws, 'last-report-build')), 'nothing was recorded');
    // Mutation captured: the precondition missing (or checked only after
    // the send) fails the rc, the stderr text or the log asserts.
  } finally { fix.cleanup(); }
});

test('dispatch --amend: --role together with --amend exits 2 (exact text)', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-amend-role-');
  try {
    fix.writeRoster(undefined, ROW12('build', 'p1', 'grok', 'implementer', 'xai', fix.repo, 'grok-4.7', 'build'));
    const amend = fix.brief('amend.md', 'Fix the flag.\n');
    const r = cmd(fix, ['dispatch', 'build', amend, '--amend', '--role', 'reviewer', '--no-wait']);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /dispatch: --amend keeps the current role; drop --role/);
    assert.ok(!fix.log().includes('agent prompt'), 'nothing was sent');
    // Mutation captured: the conflict not detected (the role flag applied
    // to the amendment, or no exit 2) fails the asserts.
  } finally { fix.cleanup(); }
});

test('composeAmendment: the report_language line, in order, only when set', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-amend-lang-');
  try {
    const report = '/some/state/ws/reports/build-amend.md';
    const amendRaw = '# Amend\n\nDo X.\n';
    const expected = [
      '# Amendment to your current brief\n\n',
      amendRaw,
      '\n\n# Report contract\n\n',
      '- This amendment overrides your current brief where they differ; the rest of that brief still holds.\n',
      `- Write your report as Markdown to \`${report}\` (create parent directories if needed). If you have not written the report of your current brief yet, write one report there that covers the brief and this amendment; otherwise report only on the amendment.\n`,
      '- Give every item its state as `[done]`, `[partial]` or `[skipped]`, followed by the reason.\n',
      '- Write the report in pt-BR.\n',
      '- Write the report in one go, as the last action of your work; the orchestrator treats its existence as completion.\n',
      '- Only you write this report, once all of the brief is done, including any part you handed to subagents or background tasks; a subagent never writes it. Report every item as it stands in the files, not as a subagent summarized it.\n',
      '- Nobody watches this terminal: do not ask interactive questions or wait for a confirmation. When the brief does not decide something, follow its "When the brief does not decide" section, or mark the item partial and list the gap and the options under open questions.\n',
      '- Never invent names, endpoints, flags, credentials, URLs or requirements.\n',
      '- Do not commit, push, tag, or open pull requests.\n',
      '- When finished, reply in the terminal with exactly the report path and nothing else.\n',
    ].join('');
    assert.equal(composeAmendment(amendRaw, report, fix.ctx, { ...fix.env, HERDR_AGENTS_REPORT_LANGUAGE: 'pt-BR' }), expected,
      'the language line sits after the report path, before the one-go rule');
    const plain = composeAmendment(amendRaw, report, fix.ctx, fix.env);
    assert.ok(!plain.includes('Write the report in pt-BR'), 'no language line without report_language');
    // Mutation captured: the language line in the wrong place (after the
    // one-go rule) or present without report_language fails the asserts.
  } finally { fix.cleanup(); }
});

test('run: --amend is not a run option (exit 2, nothing spawned)', { timeout: 30000 }, () => {
  const fix = makeFix('ha-run-amend-');
  try {
    const brief = fix.brief('brief.md', FULL_BRIEF);
    const r = cmd(fix, ['run', 'implementer', brief, '--amend']);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /run: unknown option --amend/);
    assert.ok(!fix.log().includes('agent start'), 'no agent was spawned');
    // Mutation captured: --amend forwarded to the dispatch (or accepted by
    // run) would spawn the agent or change the exit code above.
  } finally { fix.cleanup(); }
});

// ---------- one dispatch, one pair of paths ----------

test('dispatchPairSuffix: no collision keeps the plain name; each cause takes -2', { timeout: 30000 }, () => {
  const composedAt = (suf) => `/s/briefs/build-20260101T000000${suf}.md`;
  const reportAt = (suf) => `/s/reports/build-20260101T000000${suf}.md`;
  const never = () => false;
  assert.equal(dispatchPairSuffix(composedAt, reportAt, never, ''), '', 'no collision: the unsuffixed pair');
  assert.equal(dispatchPairSuffix(composedAt, reportAt, (p) => p === composedAt(''), ''), '-2',
    'the composed prompt of the same second already exists');
  assert.equal(dispatchPairSuffix(composedAt, reportAt, (p) => p === reportAt(''), ''), '-2',
    'the report of the same second already exists');
  assert.equal(dispatchPairSuffix(composedAt, reportAt, never, reportAt('')), '-2',
    'last-report already points at the report (the file may be absent)');
  const takenUpTo2 = (p) => p === composedAt('') || p === composedAt('-2') || p === reportAt('') || p === reportAt('-2');
  assert.equal(dispatchPairSuffix(composedAt, reportAt, takenUpTo2, ''), '-3', 'walks the suffixes until a free pair');
  // Mutation captured: the collision check missing (any of the three
  // causes) or the suffix sequence wrong (a taken suffix reused, the
  // next one skipped) fails one of the asserts.
});

test('dispatch: a strict lint dies 2 without creating the state dirs', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-nostate-');
  try {
    // A valid roster, and the state subdirs gone: nothing may be created
    // before the lint dies. The lib runs in a child process, not through
    // the entry (whose friction-log setup creates the state dir itself),
    // so what the assert sees is what cmdDispatch did.
    for (const d of ['briefs', 'reports', 'wait']) {
      fs.rmSync(path.join(fix.ws, d), { recursive: true, force: true });
    }
    fix.writeRoster(undefined, ROW12('build', 'p1', 'grok', 'implementer', 'xai', fix.repo, 'grok-4.7', 'build'));
    const f = fix.brief('brief.md', FULL_BRIEF.replace('# Owned files\n\nscripts/x.mjs\n', ''));
    const child = path.join(fix.root, 'dispatch-lib.mjs');
    fs.writeFileSync(child, [
      `import { cmdDispatch } from '${pathToFileURL(path.join(SCRIPTS, 'lib', 'dispatch.mjs')).href}';`,
      `import { loadConfig } from '${pathToFileURL(path.join(SCRIPTS, 'lib', 'config.mjs')).href}';`,
      'const env = process.env;',
      'const ctx = loadConfig(env, process.cwd());',
      `cmdDispatch(${JSON.stringify(['build', f, '--no-wait'])}, ctx, env, process.cwd());`,
    ].join('\n'));
    const r = spawnSync(nodeBin(), [child], {
      cwd: fix.repo,
      env: { ...fix.env, HERDR_AGENTS_BRIEF_LINT: 'strict' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(r.status, 2, r.stderr);
    assert.ok(r.stderr.includes('is missing sections: [Owned files] — workers without owned files collide (brief_lint=strict)'), r.stderr);
    // The state subdirs were not created before the lint died.
    assert.ok(!fs.existsSync(path.join(fix.ws, 'briefs')), 'briefs/ is not created before the strict lint');
    assert.ok(!fs.existsSync(path.join(fix.ws, 'reports')));
    assert.ok(!fs.existsSync(path.join(fix.ws, 'wait')));
    // Mutation captured: stateDir called before the lint (the original
    // order) would recreate the subdirs and fail the existsSync asserts.
  } finally { fix.cleanup(); }
});

// ---------- a done report that marks items partial ----------

// The wait line of a done report with partial items carries the count; the
// final dispatch JSON gains `partial` right after report_exists (before
// auto_approved), and the warn is the wait's own — the dispatch does not
// repeat it.
test('dispatch: a done report with partial items gets the partial key after report_exists', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-partial-');
  try {
    fix.writeRoster(undefined, ROW12('build', 'p1', 'grok', 'implementer', 'xai', fix.repo, 'grok-4.7', 'build'));
    const brief = fix.brief('brief.md', FULL_BRIEF);
    const body = ['# Report', '', '| item | state |', '| --- | --- |', '| slice | [done] |',
      '| fact A | [partial] |', '| fact B | [partial] |', ''].join('\n');
    const warnLine = "herdr-agents: warning: report of 'build' marks 2 item(s) partial: a partial item is not a pass; read them before commit, push or release";
    // Mutation captured: not reading the partial count from the wait line
    // (or placing the key anywhere else) breaks the key set and the warn
    // count below.
    const r = cmd(fix, ['dispatch', 'build', brief, '--timeout', '10000'],
      { HERDR_AGENTS_PROMPT_CHECK_SECONDS: '0', FAKE_REPORT_TEXT: body });
    assert.equal(r.status, 0, r.stderr);
    const j = parsePretty(r.stdout);
    assert.equal(j.wait_status, 'done');
    assert.equal(j.report_exists, true);
    assert.equal(j.partial, 2);
    assert.deepEqual(Object.keys(j),
      ['wait_status', 'agent', 'role', 'kind', 'composed_prompt', 'report', 'report_exists', 'partial', 'auto_approved'],
      'partial right after report_exists, before auto_approved');
    assert.equal(r.stderr.split(`${warnLine}`).length - 1, 1,
      `the warn is the wait's own and is not repeated: ${r.stderr}`);
  } finally { fix.cleanup(); }
});

// A done report without `partial` keeps the final JSON key set of today
// (no partial key) and nothing about partial is printed.
test('dispatch: a clean done report keeps the key set of today', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-clean-');
  try {
    fix.writeRoster(undefined, ROW12('build', 'p1', 'grok', 'implementer', 'xai', fix.repo, 'grok-4.7', 'build'));
    const brief = fix.brief('brief.md', FULL_BRIEF);
    // Mutation captured: the partial key present with 0 (or emitted on a
    // non-done wait) breaks the key set below.
    const r = cmd(fix, ['dispatch', 'build', brief, '--timeout', '10000'],
      { HERDR_AGENTS_PROMPT_CHECK_SECONDS: '0', FAKE_REPORT_TEXT: '# Report\n\ndone.\n' });
    assert.equal(r.status, 0, r.stderr);
    const j = parsePretty(r.stdout);
    assert.equal(j.wait_status, 'done');
    assert.equal(j.report_exists, true);
    assert.deepEqual(Object.keys(j),
      ['wait_status', 'agent', 'role', 'kind', 'composed_prompt', 'report', 'report_exists', 'auto_approved']);
    assert.ok(!r.stderr.includes('partial'), 'no partial warn for a clean report');
  } finally { fix.cleanup(); }
});

// The amendment report with partial items: the final JSON carries `amend`
// right after report_exists and `partial` right after `amend` — the count
// is the amendment report's (the wait watches the new report path).
test('dispatch --amend: the amendment report with partial items gets amend then partial', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-amend-partial-');
  try {
    fix.writeRoster(undefined, ROW12('build', 'p1', 'grok', 'implementer', 'xai', fix.repo, 'grok-4.7', 'build'));
    const brief = fix.brief('brief.md', FULL_BRIEF.replace('# Goal\n', '# Brief — fix the flag\n# Goal\n'));
    const first = cmd(fix, ['dispatch', 'build', brief, '--no-wait']);
    assert.equal(first.status, 0, first.stderr);
    const j1 = parsePretty(first.stdout);
    fs.writeFileSync(j1.report, '# Report\n\nall done\n');
    const amend = fix.brief('amend.md', '# Amend — verify the external fact\n\nDo X with `--flag` instead.\n');
    const body = ['# Report', '', '| item | state |', '| --- | --- |', '| fact A | [partial] |', ''].join('\n');
    // Mutation captured: the partial key before amend (or missing on an
    // amendment, or counted from the finished brief's report) breaks the
    // key set and the count below.
    const r = cmd(fix, ['dispatch', 'build', amend, '--amend', '--timeout', '10000'],
      { HERDR_AGENTS_PROMPT_CHECK_SECONDS: '0', FAKE_REPORT_TEXT: body });
    assert.equal(r.status, 0, r.stderr);
    const j = parsePretty(r.stdout);
    assert.equal(j.wait_status, 'done');
    assert.equal(j.amend, true);
    assert.equal(j.partial, 1, 'the count is the amendment report, not the finished brief\'s');
    assert.deepEqual(Object.keys(j),
      ['wait_status', 'agent', 'role', 'kind', 'composed_prompt', 'report', 'report_exists', 'amend', 'partial', 'auto_approved'],
      'amend right after report_exists, partial right after amend');
    assert.equal(r.stderr.split("herdr-agents: warning: report of 'build' marks 1 item(s) partial").length - 1, 1,
      `the warn is the wait's own and is not repeated: ${r.stderr}`);
  } finally { fix.cleanup(); }
});

// ---------- the per-section reason of the missing-sections warning ----------

// The warning names the reason of every missing section (in the checks'
// order): one reason per section, joined by "; ".
test('lint: each missing section carries its own reason, alone and combined', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-lint-reasons-');
  try {
    fix.writeRoster(undefined, ROW12('build', 'p1', 'grok', 'implementer', 'xai', fix.repo, 'grok-4.7', 'build'));
    const warnText = (f) => {
      const orig = process.stderr.write;
      let cap = '';
      process.stderr.write = (s) => { cap += s; return true; };
      try { lintBrief(f, fix.ctx, fix.env); } finally { process.stderr.write = orig; }
      return cap;
    };
    // The pure join: same order as the missing list.
    assert.equal(missingSectionsReasons(''), '');
    assert.equal(missingSectionsReasons(' [Goal] [Report]'),
      'the worker does not know what the slice is for; without a report section the worker may never write one');
    const cases = [
      [FULL_BRIEF.replace('# Goal\n', ''), '[Goal]', 'the worker does not know what the slice is for'],
      [FULL_BRIEF.replace('# Expected result\n', ''), '[Expected result]', 'nothing says when the slice is done'],
      [FULL_BRIEF.replace('# Owned files\n\nscripts/x.mjs\n', ''), '[Owned files]', 'workers without owned files collide'],
      [FULL_BRIEF.replace('# Forbidden\n', ''), '[Forbidden]', 'nothing keeps the worker out of other files'],
      [FULL_BRIEF.replace('# Report\n', ''), '[Report]', 'without a report section the worker may never write one'],
      [FULL_BRIEF.replace('Do not commit or push.', 'Do nothing.'), "[no-git line: say 'no commit/push']", 'the worker may commit or push'],
    ];
    for (const [body, label, reason] of cases) {
      const f = fix.brief('b.md', body);
      // Mutation captured: the old generic tail (one shared reason for
      // every missing section) fails the per-label text below.
      assert.equal(warnText(f), `herdr-agents: warning: brief ${f} is missing sections: ${label} — ${reason}\n`, label);
    }
    // Combined: every missing section keeps its own reason, in order.
    const both = fix.brief('both.md',
      FULL_BRIEF.replace('# Goal\n', '').replace('# Expected result\n', '').replace('Do not commit or push.', 'Do nothing.'));
    assert.equal(warnText(both),
      `herdr-agents: warning: brief ${both} is missing sections: [Goal] [Expected result] [no-git line: say 'no commit/push'] — the worker does not know what the slice is for; nothing says when the slice is done; the worker may commit or push\n`);
    // strict: the same text plus (brief_lint=strict), through the entry.
    const r = cmd(fix, ['dispatch', 'build', both, '--no-wait'], { HERDR_AGENTS_BRIEF_LINT: 'strict' });
    assert.equal(r.status, 2, r.stderr);
    assert.ok(r.stderr.includes(`herdr-agents: brief ${both} is missing sections: [Goal] [Expected result] [no-git line: say 'no commit/push'] — the worker does not know what the slice is for; nothing says when the slice is done; the worker may commit or push (brief_lint=strict)\n`), r.stderr);
  } finally { fix.cleanup(); }
});

// ---------- brief_lint_aliases ----------

// A level 1-3 header that starts with an alias (any case) satisfies the
// section; the match is at the heading start (not mid-title) and on
// alternative headings alike.
test('lint: an alias heading covering the section passes, a mid-title one does not', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-lint-alias-');
  try {
    const aliasBody = (h) => FULL_BRIEF.replace('# Goal\n\nDo the slice.\n', `${h}\n\nDo the slice.\n`);
    const f = fix.brief('brief.md', aliasBody('## Parte A — o contexto'));
    assert.equal(briefMissingSections(f), ' [Goal]', 'without aliases the Goal header is absent');
    assert.equal(briefMissingSections(f, { aliases: { Goal: ['Parte A', 'Contexto'] } }), '');
    // Level 1 and 3 count too; level 4 does not; case is ignored.
    assert.equal(briefMissingSections(fix.brief('h1.md', aliasBody('# Contexto')), { aliases: { Goal: ['Contexto'] } }), '');
    assert.equal(briefMissingSections(fix.brief('h3.md', aliasBody('### Contexto')), { aliases: { Goal: ['Contexto'] } }), '');
    assert.equal(briefMissingSections(fix.brief('h4.md', aliasBody('#### Contexto')), { aliases: { Goal: ['Contexto'] } }), ' [Goal]');
    assert.equal(briefMissingSections(fix.brief('ci.md', aliasBody('## pArTe a x')), { aliases: { Goal: ['Parte A'] } }), '');
    // The heading must START with the alias: a mid-title hit does not.
    // Mutation captured: an alias regex that matches the heading
    // mid-title (instead of at the start) fails this assert.
    assert.equal(briefMissingSections(fix.brief('mid.md', aliasBody('## The Parte A context')), { aliases: { Goal: ['Parte A'] } }), ' [Goal]');
    // Any alternative of the list works.
    assert.equal(briefMissingSections(fix.brief('alt.md', aliasBody('### Contexto')), { aliases: { Goal: ['Parte A', 'Contexto'] } }), '');
  } finally { fix.cleanup(); }
});

// The parser applies the valid items and warns once per malformed one
// (no "=", unknown section, empty heading list); valid items keep working
// even when the value also carries malformed ones.
test('aliases: the parser applies the valid items and warns once per malformed one', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-alias-parse-');
  try {
    fix.writeRoster(undefined, ROW12('build', 'p1', 'grok', 'implementer', 'xai', fix.repo, 'grok-4.7', 'build'));
    assert.deepEqual(parseBriefLintAliases(''), { sections: {}, ignored: [] });
    assert.deepEqual(parseBriefLintAliases('Goal=Parte A|Contexto,Expected result=Entrega'),
      { sections: { Goal: ['Parte A', 'Contexto'], 'Expected result': ['Entrega'] }, ignored: [] });
    const p = parseBriefLintAliases('Goal=OK,nodash,PartX=Foo,Report=');
    assert.deepEqual(p.sections, { Goal: ['OK'] }, 'the valid item applies');
    assert.deepEqual(p.ignored, ['nodash', 'PartX=Foo', 'Report='], 'each malformed item, in order');
    // Through the entry: the valid alias satisfies the section (no section
    // warning) while each malformed item gets its own single warning.
    // Mutation captured: silently dropping the valid items (or warning more
    // than once per malformed item, or never) breaks the stderr asserts
    // below.
    const f = fix.brief('brief.md', FULL_BRIEF.replace('# Expected result\n\nThe slice is done.\n', '## Entrega\n\nThe slice is done.\n'));
    const r = cmd(fix, ['dispatch', 'build', f, '--no-wait'],
      { HERDR_AGENTS_BRIEF_LINT_ALIASES: 'Expected result=Entrega,nodash,PartX=Foo', HERDR_AGENTS_PROMPT_CHECK_SECONDS: '0' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stderr.includes('is missing sections'), 'the alias satisfied the section: ' + r.stderr);
    for (const item of ['nodash', 'PartX=Foo']) {
      const line = `herdr-agents: warning: brief_lint_aliases: ignored '${item}' (use Section=Heading|Heading)`;
      assert.equal(r.stderr.split(line).length - 1, 1, `one warning per malformed item: ${r.stderr}`);
    }
    // A malformed value never suppresses a real missing section.
    const g = fix.brief('g.md', FULL_BRIEF.replace('# Goal\n', ''));
    const orig = process.stderr.write;
    let cap = '';
    process.stderr.write = (s) => { cap += s; return true; };
    try { lintBrief(g, fix.ctx, { ...fix.env, HERDR_AGENTS_BRIEF_LINT_ALIASES: 'nodash' }); }
    finally { process.stderr.write = orig; }
    assert.ok(cap.includes(`brief_lint_aliases: ignored 'nodash' (use Section=Heading|Heading)\n`), cap);
    assert.ok(cap.includes('is missing sections: [Goal] — the worker does not know what the slice is for\n'), cap);
  } finally { fix.cleanup(); }
});

// The read-only rule and the aliases compose: the alias can cover the Goal
// of a read-only role that carries no Owned files at all.
test('lint: the read-only rule still applies with aliases', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-alias-ro-');
  try {
    fix.writeRoster(undefined, ROW12('rev', 'p1', 'codex', 'reviewer', 'openai', fix.repo, 'gpt-5', 'build'));
    const body = FULL_BRIEF.replace('# Goal\n\nDo the slice.\n', '## Parte A\n\nDo the slice.\n').replace('# Owned files\n\nscripts/x.mjs\n', '');
    const f = fix.brief('brief.md', body);
    const aliases = { Goal: ['Parte A'] };
    assert.equal(briefMissingSections(f, { aliases }), ' [Owned files]', 'an edit role still needs Owned files');
    // Mutation captured: dropping the read-only rule when aliases are in
    // play (or ignoring the alias there) breaks the two asserts below.
    assert.equal(briefMissingSections(f, { readOnly: true, aliases }), '', 'a read-only role owns nothing');
    const r = cmd(fix, ['dispatch', 'rev', f, '--no-wait'],
      { HERDR_AGENTS_BRIEF_LINT: 'strict', HERDR_AGENTS_BRIEF_LINT_ALIASES: 'Goal=Parte A', HERDR_AGENTS_PROMPT_CHECK_SECONDS: '0' });
    assert.equal(r.status, 0, r.stderr);
  } finally { fix.cleanup(); }
});

// ---------- the empty inline code symptom (``) ----------

// A run of exactly two backticks outside fenced blocks flags the line;
// fence markers (three or more, backtick or tilde) and the fenced content
// never do. Lines are 1-based; a line with several runs counts once.
test('emptyCodeLines: exactly two backticks, outside fences, once per line', { timeout: 30000 }, () => {
  assert.deepEqual(emptyCodeLines('a\n`` b\n'), [2]);
  // A fence marker line never counts; the content inside never does; the
  // fence closes on the same char with at least the opener's run.
  assert.deepEqual(emptyCodeLines('``\n```\n``\n```\n``\n'), [1, 5]);
  assert.deepEqual(emptyCodeLines('```\n`` x\n```\n'), []);
  assert.deepEqual(emptyCodeLines('~~~\n`` y\n~~~\n'), []);
  // A different-char or suffixed marker is content, not a close: the
  // fence stays open over them, and only the matching marker closes it.
  assert.deepEqual(emptyCodeLines('```\n~~~\n`` z\n```\n'), []);
  assert.deepEqual(emptyCodeLines('a\n```\n``` close\n`` w\n```\n`` x\n'), [6]);
  // One backtick, a run of four, and a code span never count.
  assert.deepEqual(emptyCodeLines('a ` b\n'), []);
  assert.deepEqual(emptyCodeLines('a ```` b\n'), []);
  assert.deepEqual(emptyCodeLines('a `b` c\n'), []);
  // Several runs on one line count the line once; an unclosed fence swallows
  // the rest of the file.
  assert.deepEqual(emptyCodeLines('a `` b `` c\n'), [1]);
  assert.deepEqual(emptyCodeLines('a `` b\n```\nc `` d\n'), [1]);
  // Mutation captured: counting runs of three or more (or forgetting the
  // fence state) breaks the fenced asserts above.
});

// The lint emits one warning per bad line (at most three, then one for the
// rest), in warn and strict alike; only brief_lint=off silences it.
test('lint: the empty-code warn caps at three lines plus one summary', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-empty-code-');
  try {
    const line = (p, n) => `herdr-agents: warning: brief ${p} line ${n} has empty inline code (\`\`): a shell heredoc without quotes may have run the backticks\n`;
    const summary = (k) => `herdr-agents: warning: … and ${k} more line(s)\n`;
    const warnText = (f, env) => {
      const orig = process.stderr.write;
      let cap = '';
      process.stderr.write = (s) => { cap += s; return true; };
      try { lintBrief(f, fix.ctx, env); } finally { process.stderr.write = orig; }
      return cap;
    };
    // One bad line outside the fences: line 3 of the brief.
    // Mutation captured: counting the fence-marker line, or warning more
    // than three per-line lines without the summary (or the other way
    // round), breaks the exact captured stderr below.
    const f = fix.brief('b.md', FULL_BRIEF.replace('Do the slice.', 'Do the `` slice.'));
    assert.equal(warnText(f, fix.env), line(f, 3));
    // Five bad lines: the first three per line, then one for the rest.
    const g = fix.brief('g.md', FULL_BRIEF.replace('Do the slice.', 'a `` b\nc `` d\ne `` f\ng `` h\ni `` j'));
    assert.equal(warnText(g, fix.env), line(g, 3) + line(g, 4) + line(g, 5) + summary(2));
    // Fenced content stays quiet through the lint too.
    const h = fix.brief('h.md', FULL_BRIEF.replace('Do the slice.', 'Do it.\n\n```js\nconst x = ``;\n```\n\n`` real\n'));
    assert.equal(warnText(h, fix.env), line(h, 9));
    // strict still warns (the check does not depend on the mode's strict
    // death); only off is silent.
    const threw = (() => { try { warnText(f, { ...fix.env, HERDR_AGENTS_BRIEF_LINT: 'strict' }); return null; } catch (e) { return e; } })();
    assert.equal(threw, null, 'strict does not die on the empty-code warn alone');
    assert.equal(warnText(f, { ...fix.env, HERDR_AGENTS_BRIEF_LINT: 'strict' }), line(f, 3));
    assert.equal(warnText(f, { ...fix.env, HERDR_AGENTS_BRIEF_LINT: 'off' }), '');
  } finally { fix.cleanup(); }
});

// ---------- the one-line dispatch JSON (wait_status first) ----------

// Every dispatch JSON path prints exactly one line, starting with
// `wait_status` — the final (no-wait), the prompt failure and the
// not-received — so `dispatch … | tail -1` returns the whole JSON.
test('dispatch: the JSON output is one line with wait_status first (final, error, not-received)', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-json-line-');
  try {
    fix.writeRoster(undefined, ROW12('build', 'p1', 'grok', 'implementer', 'xai', fix.repo, 'grok-4.7', 'build'));
    const brief = fix.brief('brief.md', FULL_BRIEF);
    const oneLine = (label, r) => {
      const lines = r.stdout.replace(/\n+$/, '').split('\n');
      assert.equal(lines.length, 1, `${label}: one line of JSON stdout: ${r.stdout}`);
      assert.ok(r.stdout.startsWith('{"wait_status":'), `${label}: wait_status first: ${r.stdout}`);
      return JSON.parse(lines[0]);
    };
    // Mutation captured: pretty-printed (indented) output — or wait_status
    // not first — fails the one-line / first-key asserts on every path.
    const f = cmd(fix, ['dispatch', 'build', brief, '--no-wait'], { HERDR_AGENTS_PROMPT_CHECK_SECONDS: '0' });
    assert.equal(f.status, 0, f.stderr);
    assert.equal(oneLine('final', f).wait_status, 'submitted');
    fix.promptFail(true);
    const e = cmd(fix, ['dispatch', 'build', brief, '--no-wait'], { HERDR_AGENTS_PROMPT_CHECK_SECONDS: '0' });
    fix.promptFail(false);
    assert.equal(e.status, 4, e.stderr);
    const je = oneLine('error', e);
    assert.equal(je.wait_status, 'error');
    assert.ok(je.raw.length > 0, 'the raw stays in the error JSON');
    // not-received: the prompt is swallowed (once + the single resend).
    fix.promptSkip();
    fix.promptSkip();
    const n = cmd(fix, ['dispatch', 'build', brief, '--no-wait']);
    assert.equal(n.status, 15, n.stderr);
    assert.equal(oneLine('not-received', n).wait_status, 'not-received');
  } finally { fix.cleanup(); }
});

// `run` chains spawn → dispatch: the spawn JSON is pretty and multi-line,
// and the last stdout line is the dispatch JSON — one line, wait_status
// first, naming the worker the spawn just created.
test('run: the last stdout line is the one-line dispatch JSON', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-run-line-');
  try {
    const brief = fix.brief('brief.md', FULL_BRIEF);
    const r = cmd(fix, ['run', 'implementer', brief, '--no-wait'],
      { HERDR_AGENTS_LAYOUT: 'tab', HERDR_AGENTS_PROMPT_CHECK_SECONDS: '0' });
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout.replace(/\n+$/, '');
    const lines = out.split('\n');
    const last = lines[lines.length - 1];
    // Mutation captured: a pretty (multi-line) dispatch JSON — or the old
    // key order — puts something else on the last line or starts it
    // without wait_status.
    assert.ok(last.startsWith('{"wait_status":'), `the last line is the dispatch JSON: ${last}`);
    const j = JSON.parse(last);
    assert.equal(j.wait_status, 'submitted');
    assert.equal(Object.keys(j)[0], 'wait_status');
    // The dispatched agent is the one the spawn JSON (the pretty block
    // above the last line) reports.
    const name = out.match(/^  "name": "([^"]+)"/m);
    assert.ok(name, `the spawn JSON with its name: ${out}`);
    assert.equal(j.agent, name[1]);
  } finally { fix.cleanup(); }
});

// ---------- owned paths of a brief ----------

// The paths a brief owns: code spans and path-like list items of the
// `Owned files` section (or its lint alias), normalized; the section ends
// at the next header of the same or a higher level.
test('ownedPaths: spans, list items, normalization, stopwords, aliases, section end', { timeout: 30000 }, () => {
  // Code spans (list and prose items) and path-like list items.
  assert.deepEqual(ownedPaths('# Owned files\n\n- `scripts/lib/a.mjs` — the lib\n- Use `scripts/lib/b.mjs` too\n'),
    ['scripts/lib/a.mjs', 'scripts/lib/b.mjs']);
  assert.deepEqual(ownedPaths('# Owned files\n\n- scripts/lib/a.mjs\n2. docs/x.md\n* pkg/y\n'),
    ['scripts/lib/a.mjs', 'docs/x.md', 'pkg/y']);
  // A list item whose text is prose (even numbered) is not a path.
  assert.deepEqual(ownedPaths('# Owned files\n\n- 2. docs/x.md\n'), []);
  // Normalization: a leading ./ and a trailing / are dropped; deduplicated.
  assert.deepEqual(ownedPaths('# Owned files\n\n- ./scripts/a.mjs\n- scripts/lib/\n- scripts/a.mjs\n'),
    ['scripts/a.mjs', 'scripts/lib']);
  // Lone words that are not paths (any case, with or without punctuation).
  assert.deepEqual(ownedPaths('# Owned files\n\nNenhum\n'), []);
  assert.deepEqual(ownedPaths('# Owned files\n\n- none\n- Nenhum.\n'), []);
  // The section ends at the next same-or-higher header, not a deeper one;
  // a deeper sub-header stays inside.
  assert.deepEqual(ownedPaths('## Owned files\n\n- scripts/a.mjs\n\n### Notes\n\n- docs/b.md\n\n# Forbidden\n\n- scripts/c.mjs\n'),
    ['scripts/a.mjs', 'docs/b.md']);
  // A lint alias heading satisfies the section; the accepted spellings do.
  assert.deepEqual(ownedPaths('## Arquivos\n\n- scripts/a.mjs\n', { 'Owned files': ['Arquivos'] }), ['scripts/a.mjs']);
  assert.deepEqual(ownedPaths('# Scope\n\n- scripts/a.mjs\n'), ['scripts/a.mjs']);
  // A heading suffix still counts (the lint matches the header prefix).
  assert.deepEqual(ownedPaths('## Owned files (repo-relative)\n\n- scripts/a.mjs\n'), ['scripts/a.mjs']);
  // No section: nothing.
  assert.deepEqual(ownedPaths('# Goal\n\nDo it.\n'), []);
  // Mutation captured: counting plain paragraph lines (not just spans and
  // list items) would add scripts/x.mjs below and break the no-section
  // assert.
  assert.deepEqual(ownedPaths('# Owned files\n\nscripts/x.mjs\n'), []);
});

// Two owned paths cross when equal, when one is a directory the other is
// inside (a segment boundary, either way), or when the glob prefixes cross.
test('pathsCross: equal, directory containment either way, glob prefixes', { timeout: 30000 }, () => {
  assert.ok(pathsCross('scripts/lib/a.mjs', 'scripts/lib/a.mjs'), 'equal');
  // Mutation captured: an equality-only crossing (no directory
  // containment) fails the next two asserts.
  assert.ok(pathsCross('scripts/lib', 'scripts/lib/a.mjs'), 'a directory crosses its children');
  assert.ok(pathsCross('scripts/lib/a.mjs', 'scripts/lib'), 'either way');
  assert.ok(!pathsCross('scripts', 'scripts2/a.mjs'), 'a directory boundary is a segment');
  assert.ok(!pathsCross('scripts/a.mjs', 'scripts/b.mjs'), 'siblings do not cross');
  // A glob compares only the prefix before the first *, ? or [.
  assert.ok(pathsCross('scripts/lib/*.mjs', 'scripts/lib/a.mjs'));
  assert.ok(!pathsCross('scripts/lib/*.mjs', 'scripts/other/a.mjs'));
  assert.ok(pathsCross('scripts/lib/*.mjs', 'scripts/lib/*.js'), 'the prefixes cross');
  assert.ok(pathsCross('scripts/lib/[ab].mjs', 'scripts/lib/a.mjs'), 'the [ opens the wildcard');
  assert.ok(!pathsCross('a/*', 'b/c.mjs'));
});

// A glob crosses a path when the path matches the glob (the review case:
// `roles/reviewer*.md` must cross `roles/reviewer.md`), `*`/`?` stay inside
// one segment, `**` crosses, `[...]` is a class; a glob crosses a
// directory by its literal prefix either way; glob vs glob by the literal
// prefixes.
test('pathsCross: a file-name glob matches the path and the directory relation holds', { timeout: 30000 }, () => {
  // The review case: a file-name glob crossing the exact file.
  assert.ok(pathsCross('roles/reviewer*.md', 'roles/reviewer.md'),
    'reviewer*.md crosses reviewer.md (the review case)');
  assert.ok(pathsCross('roles/reviewer*.md', 'roles/reviewer-security.md'));
  assert.ok(!pathsCross('roles/reviewer*.md', 'roles/review.md'), 'the * does not stretch across the name');
  assert.ok(!pathsCross('roles/reviewer*.md', 'docs/reviewer.md'), 'another directory does not cross');
  // The matching semantics: * and ? stay inside a segment, ** crosses,
  // [...] is a class.
  assert.ok(!globMatches('scripts/*.mjs', 'scripts/lib/a.mjs'), '* never matches across a /');
  assert.ok(pathsCross('scripts/lib/*.mjs', 'scripts/other/a.mjs') === false, 'a deeper file outside the glob directory does not cross');
  assert.ok(pathsCross('scripts/*.mjs', 'scripts/lib/a.mjs'),
    'the prefix-directory relation still crosses (a directory could sit there: the warn is advisory)');
  assert.ok(pathsCross('scripts/**', 'scripts/lib/a.mjs'), '** crosses /');
  assert.ok(pathsCross('scripts/**.mjs', 'scripts/a.mjs'));
  assert.ok(pathsCross('scripts/**.mjs', 'scripts/lib/a.mjs'), '** reaches any depth');
  assert.ok(pathsCross('lib/a?.mjs', 'lib/a1.mjs'), '? is one segment char');
  assert.ok(!pathsCross('lib/a?.mjs', 'lib/abc.mjs'), '? matches exactly one char');
  assert.ok(pathsCross('roles/[uv]ser.md', 'roles/user.md'), 'the class matches');
  assert.ok(!pathsCross('roles/[uv]ser.md', 'docs/wser.md'), 'another directory does not cross');
  assert.ok(pathsCross('a[!b]c', 'axc'), 'a negated class matches the rest');
  // glob against a directory: the literal prefix inside the directory, or
  // the directory inside the prefix.
  assert.ok(pathsCross('scripts/lib/*', 'scripts'), 'the prefix sits inside the directory');
  assert.ok(pathsCross('scripts/*', 'scripts/lib/sub'), 'the directory sits inside the prefix');
  assert.ok(!pathsCross('scripts/lib/*', 'docs'), 'unrelated directories do not cross');
  // glob vs glob: one literal prefix starts with the other.
  assert.ok(pathsCross('scripts/lib/*.mjs', 'scripts/lib/*.js'), 'equal prefixes cross');
  assert.ok(pathsCross('scripts/lib/*', 'scripts/lib/deep/*.mjs'), 'the longer prefix starts with the shorter');
  assert.ok(!pathsCross('scripts/lib/*.mjs', 'scripts/other/*.mjs'), 'different prefixes do not cross');
  assert.ok(!pathsCross('scripts/*', 'scripts2/*.mjs'), 'a directory boundary is a segment between prefixes');
  assert.ok(pathsCross('roles/reviewer*.md', 'roles/review*.md'), 'file-name prefixes cross as text (both match roles/reviewer.md)');
  assert.ok(!pathsCross('roles/reviewer*.md', 'roles/revx*.md'), 'diverging file-name prefixes do not cross');
  // globMatches itself: the segments and the class edges.
  assert.ok(globMatches('dir/**/x.mjs', 'dir/x.mjs'), '**/ matches zero segments');
  assert.ok(globMatches('dir/**/x.mjs', 'dir/a/b/x.mjs'));
  assert.ok(!globMatches('a*b', 'a/xb'), '* never crosses /');
  // Mutation captured: the prefix-only comparison (no glob matching) fails
  // the reviewer*.md case; * crossing / or the segment boundary in the
  // prefix compare breaks the negated asserts.
});

// End to end: a pending agent that owns a file-name glob warns when the
// new brief owns the file the glob matches.
test('dispatch: the owned-files overlap warn fires for a file-name glob of the pending brief', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-overlap-glob-');
  try {
    seedPendingOther(fix, 'other', ['- roles/reviewer*.md']);
    const brief = fix.brief('brief.md', FULL_BRIEF.replace('scripts/x.mjs\n', '- roles/reviewer.md\n'));
    const r = cmd(fix, ['dispatch', 'build', brief, '--no-wait'], { HERDR_AGENTS_PROMPT_CHECK_SECONDS: '0' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes(`herdr-agents: warning: brief ${brief} owns files that 'other' is still editing: roles/reviewer.md`), r.stderr);
    // A file the glob does not match does not warn.
    const other2 = fix.brief('brief2.md', FULL_BRIEF.replace('scripts/x.mjs\n', '- roles/review.md\n'));
    const r2 = cmd(fix, ['dispatch', 'build', other2, '--no-wait'], { HERDR_AGENTS_PROMPT_CHECK_SECONDS: '0' });
    assert.equal(r2.status, 0, r2.stderr);
    assert.ok(!r2.stderr.includes('is still editing'), r2.stderr);
  } finally { fix.cleanup(); }
});

// The pending brief of a recorded report: the same timestamp pair under
// briefs/ (state routing) or alongside the report (the $TMPDIR routing).
test('pendingBriefPath: the state and the $TMPDIR routing', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-pending-brief-');
  try {
    // State routing: the composed brief sits under briefs/ (sibling of
    // reports/).
    const wsReports = path.join(fix.ws, 'reports');
    fs.mkdirSync(wsReports, { recursive: true });
    const stateBrief = path.join(fix.ws, 'briefs', 'other-1.md');
    fs.writeFileSync(stateBrief, 'brief\n');
    assert.equal(pendingBriefPath(path.join(wsReports, 'other-1.md')), stateBrief);
    // $TMPDIR routing: the composed brief sits alongside the report as
    // <name>.brief.md.
    const tmp = fix.tmpReports();
    fs.mkdirSync(tmp, { recursive: true });
    const tmpBrief = path.join(tmp, 'other-2.brief.md');
    fs.writeFileSync(tmpBrief, 'brief\n');
    // Mutation captured: a pending-brief lookup that ignores the $TMPDIR
    // routing (the <name>.brief.md alongside the report) fails this assert.
    assert.equal(pendingBriefPath(path.join(tmp, 'other-2.md')), tmpBrief);
    // No composed brief on either routing: nothing.
    assert.equal(pendingBriefPath(path.join(wsReports, 'other-3.md')), '');
  } finally { fix.cleanup(); }
});

// The `# Brief` section of a composed brief file: up to the next level-1
// header; an amendment's composed file has none.
test('composedBriefSection: the # Brief block, absent in an amendment', { timeout: 30000 }, () => {
  const composed = '# Role: implementer\n\nbody\n\n# Brief\n\n# Goal\n\nDo it.\n\n# Report contract\n\n- Write it.\n';
  assert.equal(composedBriefSection(composed), '# Brief\n\n# Goal\n\nDo it.\n');
  assert.equal(composedBriefSection('# Amendment to your current brief\n\nDo X.\n\n# Report contract\n\n- Write it.\n'), '');
});

// ---------- the owned-files overlap warn ----------

// A helper fixture: `other` is a roster agent with a pending report
// (last-report exists, the report is absent) and a composed brief that
// owns the given paths; `build` is the dispatched agent.
function seedPendingOther(fix, other, ownedLines, { cwd = '/tmp/work', tmp = false } = {}) {
  const repDir = tmp ? fix.tmpReports() : path.join(fix.ws, 'reports');
  fs.mkdirSync(repDir, { recursive: true });
  const report = path.join(repDir, `${other}-1.md`);
  fs.rmSync(report, { force: true }); // a pending report is absent or empty
  fs.writeFileSync(path.join(fix.ws, `last-report-${other}`), `${report}\n`);
  const briefPath = tmp ? path.join(repDir, `${other}-1.brief.md`) : path.join(fix.ws, 'briefs', `${other}-1.md`);
  const owned = (ownedLines ?? ['- scripts/x.mjs']).join('\n');
  fs.writeFileSync(briefPath, `# Role: implementer\n\nbody\n\n# Brief\n\n# Goal\n\nDo the slice.\n\n# Owned files\n\n${owned}\n\n# Report\n\nDone.\n\n# Report contract\n\n- Write it.\n`);
  fix.writeRoster(undefined,
    ROW12(other, 'p2', 'grok', 'implementer', 'xai', cwd, 'grok-4.7', 'other'),
    ROW12('build', 'p1', 'grok', 'implementer', 'xai', fix.repo, 'grok-4.7', 'build'));
}

// The edit-role warn: one per other agent with an intersection, at most
// five paths listed; the read-only role gets the reviewing text; an
// intersecting agent without a pending report never counts.
test('dispatch: the owned-files overlap warn (edit, read-only, the cap of 5, settled reports)', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-overlap-');
  try {
    const brief = fix.brief('brief.md', FULL_BRIEF.replace('scripts/x.mjs\n', '- scripts/x.mjs\n'));
    // Mutation captured: no warn at all (or the old generic text) fails
    // the exact stderr below; a warn that lists more than five paths fails
    // the cap assert.
    seedPendingOther(fix, 'other', ['- scripts/x.mjs']);
    let r = cmd(fix, ['dispatch', 'build', brief, '--no-wait'], { HERDR_AGENTS_PROMPT_CHECK_SECONDS: '0' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes(`herdr-agents: warning: brief ${brief} owns files that 'other' is still editing: scripts/x.mjs`), r.stderr);
    // A settled report (present and non-empty): no warn.
    fs.writeFileSync(path.join(fix.ws, 'reports', 'other-1.md'), 'done\n');
    r = cmd(fix, ['dispatch', 'build', brief, '--no-wait'], { HERDR_AGENTS_PROMPT_CHECK_SECONDS: '0' });
    assert.ok(!r.stderr.includes('is still editing'), r.stderr);
    // The cap: seven crossing paths list five.
    seedPendingOther(fix, 'other', ['- lib/a1.mjs', '- lib/a2.mjs', '- lib/a3.mjs', '- lib/a4.mjs', '- lib/a5.mjs', '- lib/a6.mjs', '- lib/a7.mjs']);
    const seven = fix.brief('seven.md',
      '# Goal\n\nDo the slice.\n\n# Owned files\n\n' + ['- lib/a1.mjs', '- lib/a2.mjs', '- lib/a3.mjs', '- lib/a4.mjs', '- lib/a5.mjs', '- lib/a6.mjs', '- lib/a7.mjs'].join('\n') + '\n\n# Expected result\n\nDone.\n\n# Forbidden\n\nDo not commit or push.\n\n# Report\n\nDone.\n');
    r = cmd(fix, ['dispatch', 'build', seven, '--no-wait'], { HERDR_AGENTS_PROMPT_CHECK_SECONDS: '0' });
    assert.ok(r.stderr.includes(`herdr-agents: warning: brief ${seven} owns files that 'other' is still editing: lib/a1.mjs, lib/a2.mjs, lib/a3.mjs, lib/a4.mjs, lib/a5.mjs`), r.stderr);
    assert.ok(!r.stderr.includes('lib/a6.mjs'), 'only five paths are listed');
    // The read-only role: the reviewing text, without the brief path.
    const revFix = makeFix('ha-dispatch-overlap-ro-');
    try {
      const revBrief = fix.brief('rev.md', FULL_BRIEF.replace('scripts/x.mjs\n', '- scripts/x.mjs\n'));
      const repDir = path.join(revFix.ws, 'reports');
      fs.mkdirSync(repDir, { recursive: true });
      fs.writeFileSync(path.join(revFix.ws, 'last-report-other'), `${path.join(repDir, 'other-1.md')}\n`);
      fs.writeFileSync(path.join(revFix.ws, 'briefs', 'other-1.md'), '# Role: implementer\n\nbody\n\n# Brief\n\n# Goal\n\nDo it.\n\n# Owned files\n\n- scripts/x.mjs\n\n# Report\n\nDone.\n\n# Report contract\n\n- Write it.\n');
      revFix.writeRoster(undefined,
        ROW12('other', 'p2', 'grok', 'implementer', 'xai', '/tmp/work', 'grok-4.7', 'other'),
        ROW12('rev', 'p1', 'codex', 'reviewer', 'openai', revFix.repo, 'gpt-5', 'build'));
      const rr = cmd(revFix, ['dispatch', 'rev', revBrief, '--no-wait'], { HERDR_AGENTS_PROMPT_CHECK_SECONDS: '0' });
      assert.equal(rr.status, 0, rr.stderr);
      assert.ok(rr.stderr.includes(`herdr-agents: warning: reviewing files that 'other' is still editing: scripts/x.mjs`), rr.stderr);
    } finally { revFix.cleanup(); }
  } finally { fix.cleanup(); }
});

// $TMPDIR routing: the other agent's pending brief sits alongside its
// report as <name>.brief.md; the warn still fires.
test('dispatch: the owned-files overlap warn across the $TMPDIR routing', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-overlap-tmp-');
  try {
    const brief = fix.brief('brief.md', FULL_BRIEF.replace('scripts/x.mjs\n', '- scripts/x.mjs\n'));
    seedPendingOther(fix, 'other', ['- scripts/x.mjs'], { tmp: true });
    const r = cmd(fix, ['dispatch', 'build', brief, '--no-wait'], { HERDR_AGENTS_PROMPT_CHECK_SECONDS: '0' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes(`herdr-agents: warning: brief ${brief} owns files that 'other' is still editing: scripts/x.mjs`), r.stderr);
  } finally { fix.cleanup(); }
});

// --amend skips the overlap check: the worker keeps its own brief, and an
// amendment file that names the same paths does not warn.
test('dispatch: --amend does not run the owned-files overlap check', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-overlap-amend-');
  try {
    seedPendingOther(fix, 'other', ['- scripts/x.mjs']);
    const first = fix.brief('first.md', FULL_BRIEF);
    const d0 = cmd(fix, ['dispatch', 'build', first, '--no-wait'], { HERDR_AGENTS_PROMPT_CHECK_SECONDS: '0' });
    assert.equal(d0.status, 0, d0.stderr);
    const j0 = JSON.parse(d0.stdout);
    fs.writeFileSync(j0.report, 'done\n');
    const amend = fix.brief('amend.md', '# Amend\n\n- scripts/x.mjs\n');
    const r = cmd(fix, ['dispatch', 'build', amend, '--amend', '--no-wait'], { HERDR_AGENTS_PROMPT_CHECK_SECONDS: '0' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stderr.includes('is still editing'), r.stderr);
  } finally { fix.cleanup(); }
});

// The pending prompt's committed `# Brief`: its own section when it is a
// base brief; when it is an amendment (no `# Brief`), the section of the
// same agent's newest earlier base brief in the same directory (the
// amendment amends that brief). '' when absent.
test('pendingBriefSection: an amendment walks back to the agent\'s newest base brief', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-pending-section-');
  try {
    const briefs = path.join(fix.ws, 'briefs');
    const base = (ts, owned) => `# Role: implementer\n\nbody\n\n# Brief\n\n# Goal\n\nDo the slice.\n\n# Owned files\n\n${owned}\n\n# Report\n\nDone.\n\n# Report contract\n\n- Write it.\n`;
    const amend = `# Amendment to your current brief\n\nDo X instead.\n\n# Report contract\n\n- Write it.\n`;
    // A base brief returns its own `# Brief` section.
    const p1 = path.join(briefs, 'other-20260925T100000.md');
    fs.writeFileSync(p1, base('20260925T100000', '- scripts/a.mjs'));
    assert.ok(pendingBriefSection(p1).includes('- scripts/a.mjs'), 'the base brief carries its own section');
    // An amendment walks back to the newest earlier base brief of the same
    // agent — not to another agent's brief, not to a newer one, and a
    // suffixed base brief (same second) still counts as earlier when the
    // amendment's suffix is higher.
    const p2 = path.join(briefs, 'other-20260925T110000.md');
    fs.writeFileSync(p2, amend);
    assert.ok(pendingBriefSection(p2).includes('- scripts/a.mjs'), 'the amendment uses the earlier base brief');
    const p3 = path.join(briefs, 'other-20260925T120000.md');
    fs.writeFileSync(p3, base('20260925T120000', '- scripts/b.mjs'));
    const p4 = path.join(briefs, 'other-20260925T130000.md');
    fs.writeFileSync(p4, amend);
    assert.ok(pendingBriefSection(p4).includes('- scripts/b.mjs') && !pendingBriefSection(p4).includes('- scripts/a.mjs'),
      'the NEWEST earlier base brief wins');
    // Same-second suffix order: the amendment of -2 walks back to -1.
    const p5 = path.join(briefs, 'other-20260925T140000-1.md');
    fs.writeFileSync(p5, base('20260925T140000', '- scripts/c.mjs'));
    const p6 = path.join(briefs, 'other-20260925T140000-2.md');
    fs.writeFileSync(p6, amend);
    assert.ok(pendingBriefSection(p6).includes('- scripts/c.mjs'), 'the same-second -1 base brief is earlier');
    // Another agent's brief is never used; an unreadable earlier brief is
    // skipped; with no earlier base brief at all it is ''.
    const p7 = path.join(briefs, 'mine-20260925T150000.md');
    fs.writeFileSync(p7, amend);
    assert.equal(pendingBriefSection(p7), '', 'no base brief of its own agent: nothing');
    // The $TMPDIR kind (.brief.md) scans only .brief.md siblings.
    const tmp = fix.tmpReports();
    fs.mkdirSync(tmp, { recursive: true });
    const t1 = path.join(tmp, 'w-20260925T100000.brief.md');
    fs.writeFileSync(t1, base('20260925T100000', '- scripts/d.mjs'));
    const t2 = path.join(tmp, 'w-20260925T110000.brief.md');
    fs.writeFileSync(t2, amend);
    fs.writeFileSync(path.join(tmp, 'w-20260925T110000.md'), 'a report file, not a base brief\n');
    assert.ok(pendingBriefSection(t2).includes('- scripts/d.mjs'), 'the tmp routing walks the .brief.md siblings only');
    // Mutation captured: using the amendment's own (empty) section, the
    // newest base brief not used, or a report file mistaken for a base
    // brief breaks the asserts above.
  } finally { fix.cleanup(); }
});

// End to end: while the amendment is pending, the overlap check still
// sees the files of the brief the amendment amends — a concurrent
// dispatch that owns one of them warns.
test('dispatch: the overlap check uses the base brief while an amendment is pending', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-overlap-pend-amend-');
  try {
    const briefs = path.join(fix.ws, 'briefs');
    const reports = path.join(fix.ws, 'reports');
    fs.mkdirSync(reports, { recursive: true });
    // other: a base brief (owns scripts/x.mjs) and a pending amendment
    // (no report yet — the wait watches the amendment's report).
    fs.writeFileSync(path.join(briefs, 'other-20260925T100000.md'),
      '# Role: implementer\n\nbody\n\n# Brief\n\n# Goal\n\nDo the slice.\n\n# Owned files\n\n- scripts/x.mjs\n\n# Report\n\nDone.\n\n# Report contract\n\n- Write it.\n');
    fs.writeFileSync(path.join(briefs, 'other-20260925T100001.md'),
      '# Amendment to your current brief\n\nUse the right flag.\n\n# Report contract\n\n- Write it.\n');
    fs.writeFileSync(path.join(fix.ws, 'last-report-other'), `${path.join(reports, 'other-20260925T100001.md')}\n`);
    fix.writeRoster(undefined,
      ROW12('other', 'p2', 'grok', 'implementer', 'xai', '/tmp/work', 'grok-4.7', 'other'),
      ROW12('build', 'p1', 'grok', 'implementer', 'xai', fix.repo, 'grok-4.7', 'build'));
    const brief = fix.brief('brief.md', FULL_BRIEF.replace('scripts/x.mjs\n', '- scripts/x.mjs\n'));
    const r = cmd(fix, ['dispatch', 'build', brief, '--no-wait'], { HERDR_AGENTS_PROMPT_CHECK_SECONDS: '0' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes(`herdr-agents: warning: brief ${brief} owns files that 'other' is still editing: scripts/x.mjs`),
      `the base brief's files still participate: ${r.stderr}`);
    // A file neither the base brief nor the amendment owns does not warn.
    const otherBrief = fix.brief('brief2.md', FULL_BRIEF.replace('scripts/x.mjs\n', '- scripts/y.mjs\n'));
    const r2 = cmd(fix, ['dispatch', 'build', otherBrief, '--no-wait'], { HERDR_AGENTS_PROMPT_CHECK_SECONDS: '0' });
    assert.equal(r2.status, 0, r2.stderr);
    assert.ok(!r2.stderr.includes('is still editing'), r2.stderr);
    // Mutation captured: the amendment's composed prompt (no `# Brief`) used
    // as the overlap source (or the walk-back to the earlier brief missing)
    // leaves the warning out on the crossing brief.
  } finally { fix.cleanup(); }
});

// ---------- the codex sandbox notes ----------

const SANDBOX_GIT = '- Your sandbox cannot write under .git: do not run git mv, git checkout, git add or git commit. Describe renames and restores in the report; the orchestrator runs them.\n';
const SANDBOX_NET = '- Your sandbox has no network, local ports included: tests that start a local server fail with "Operation not permitted". Mark them [partial] and say so; the orchestrator runs them.\n';

// The notes are codex-only, follow the opening args, and sit right before
// the standing rules — in the brief and the amendment prompts.
test('sandbox notes: the codex arg combinations, in the brief and the amendment', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-sandbox-compose-');
  try {
    const dir = path.join(fix.repo, '.agents', 'herdr-roles');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'alpha.md'), '---\nname: alpha\n---\n\nBody.\n');
    const roleFile = path.join(dir, 'alpha.md');
    const report = '/r.md';
    const rules = '- Only you write this report';
    // Mutation captured: the network note emitted with
    // network_access=true (or the notes placed after the standing rules)
    // breaks the index asserts below.
    const t1 = composePrompt(roleFile, 'alpha', 'w1', '# Goal\nGo.\n', report, fix.ctx, fix.env, 'codex', '');
    assert.ok(t1.includes(SANDBOX_GIT) && t1.includes(SANDBOX_NET), 'both notes with empty args');
    assert.ok(t1.indexOf(SANDBOX_GIT) < t1.indexOf(SANDBOX_NET) && t1.indexOf(SANDBOX_NET) < t1.indexOf(rules), 'right before the standing rules');
    const t2 = composePrompt(roleFile, 'alpha', 'w1', '# Goal\nGo.\n', report, fix.ctx, fix.env, 'codex', 'network_access=true');
    assert.ok(t2.includes(SANDBOX_GIT) && !t2.includes(SANDBOX_NET), 'network_access=true: only the .git note');
    const t3 = composePrompt(roleFile, 'alpha', 'w1', '# Goal\nGo.\n', report, fix.ctx, fix.env, 'codex', '--model m network_access=true --flag');
    assert.ok(t3.includes(SANDBOX_GIT) && !t3.includes(SANDBOX_NET), 'the arg is tokenized, not substring-matched');
    const t4 = composePrompt(roleFile, 'alpha', 'w1', '# Goal\nGo.\n', report, fix.ctx, fix.env, 'codex', 'danger-full-access');
    assert.ok(!t4.includes(SANDBOX_GIT) && !t4.includes(SANDBOX_NET), 'danger-full-access: no note');
    const t5 = composePrompt(roleFile, 'alpha', 'w1', '# Goal\nGo.\n', report, fix.ctx, fix.env, 'grok', '');
    assert.ok(!t5.includes(SANDBOX_GIT) && !t5.includes(SANDBOX_NET), 'another kind: no note');
    const a1 = composeAmendment('Do X instead.\n', report, fix.ctx, fix.env, 'codex', '');
    assert.ok(a1.includes(SANDBOX_GIT) && a1.includes(SANDBOX_NET) && a1.indexOf(SANDBOX_NET) < a1.indexOf(rules), 'the amendment carries both');
    const a2 = composeAmendment('Do X instead.\n', report, fix.ctx, fix.env, 'codex', 'danger-full-access');
    assert.ok(!a2.includes(SANDBOX_GIT) && !a2.includes(SANDBOX_NET), 'the amendment honors danger-full-access');
  } finally { fix.cleanup(); }
});

// The real network token ends in network_access=true (the flag value
// sandbox_workspace_write.network_access=true, passed via -c); the bypass
// flag counts as full access too. Direct unit checks on sandboxNotes.
test('sandbox notes: the real network token and the bypass flag lift their limits', { timeout: 30000 }, () => {
  const GIT = SANDBOX_GIT;
  const NET = SANDBOX_NET;
  // The real token (via -c): the network note goes, the .git note stays.
  assert.deepEqual(sandboxNotes('codex', '-c sandbox_workspace_write.network_access=true'), [GIT],
    'the real token ends in network_access=true');
  assert.deepEqual(sandboxNotes('codex', '-c sandbox_workspace_write.network_access=false'), [GIT, NET],
    'the sandbox flag value with network_access=false does not release the network');
  // The bypass flag counts as full access: no note at all.
  assert.deepEqual(sandboxNotes('codex', '--dangerously-bypass-approvals-and-sandbox'), []);
  assert.deepEqual(sandboxNotes('codex', '--dangerously-bypass-approvals-and-sandbox -c sandbox_workspace_write.network_access=true'), []);
  // The plain token still works (tokenized, not substring-matched).
  assert.deepEqual(sandboxNotes('codex', '--model m network_access=true --flag'), [GIT]);
  // Mutation captured: an exact-token or substring match on
  // network_access=true (instead of the ends-with check) keeps the network
  // note on the real token, and a full check that misses the bypass flag
  // leaves both notes with it.
});

// End to end: a codex row without the opening-args column (an old line)
// gets both notes in the composed file; with network_access=true only the
// .git note; with danger-full-access none.
test('dispatch: the composed prompt of a codex worker carries the sandbox notes', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-sandbox-e2e-');
  try {
    const brief = fix.brief('brief.md', FULL_BRIEF);
    const composedOf = (r) => fs.readFileSync(JSON.parse(r.stdout).composed_prompt, 'utf8');
    // Old 11-column line: no opening-args column → both notes.
    fix.writeRoster(undefined, ROW11('build', 'p1', 'codex', 'implementer', 'openai', fix.repo, 'gpt-5', 'implementer'));
    let r = cmd(fix, ['dispatch', 'build', brief, '--no-wait'], { HERDR_AGENTS_PROMPT_CHECK_SECONDS: '0' });
    assert.equal(r.status, 0, r.stderr);
    let c = composedOf(r);
    assert.ok(c.includes(SANDBOX_GIT) && c.includes(SANDBOX_NET), `both notes: ${c}`);
    // 14-column line with network_access=true → only the .git note.
    const row14 = `build\tp1\tcodex\timplementer\txai\t1\t${fix.repo}\tnow\tgpt-5\tfull\timplementer\tbuild\t\tnetwork_access=true`;
    fix.writeRoster(undefined, row14);
    r = cmd(fix, ['dispatch', 'build', brief, '--no-wait'], { HERDR_AGENTS_PROMPT_CHECK_SECONDS: '0' });
    c = composedOf(r);
    assert.ok(c.includes(SANDBOX_GIT) && !c.includes(SANDBOX_NET), `only the .git note: ${c}`);
    // danger-full-access → no note.
    fix.writeRoster(undefined, row14.replace('network_access=true', 'danger-full-access'));
    r = cmd(fix, ['dispatch', 'build', brief, '--no-wait'], { HERDR_AGENTS_PROMPT_CHECK_SECONDS: '0' });
    c = composedOf(r);
    assert.ok(!c.includes(SANDBOX_GIT) && !c.includes(SANDBOX_NET), `no note: ${c}`);
    // Another kind → no note.
    fix.writeRoster(undefined, ROW12('build', 'p1', 'grok', 'implementer', 'xai', fix.repo, 'grok-4.7', 'build'));
    r = cmd(fix, ['dispatch', 'build', brief, '--no-wait'], { HERDR_AGENTS_PROMPT_CHECK_SECONDS: '0' });
    c = composedOf(r);
    assert.ok(!c.includes(SANDBOX_GIT) && !c.includes(SANDBOX_NET), `grok: no note: ${c}`);
  } finally { fix.cleanup(); }
});

// ---------- the review header fields of the final JSON ----------

// A blocked wait line carries the dialog (the last 20 non-empty visible
// lines): the final dispatch JSON carries it the same way — right after
// report_exists (and before the review header fields) — so a block inside
// a dispatch keeps the screen context the wait line provides.
test('dispatch: a blocked worker ends 7 and the final JSON carries the wait dialog', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-dialog-');
  try {
    fix.writeRoster(undefined, ROW12('build', 'p1', 'grok', 'implementer', 'xai', fix.repo, 'grok-4.7', 'build'));
    const brief = fix.brief('brief.md', FULL_BRIEF);
    fix.mode('blocked');
    fix.screen('Approve write to scripts/x.mjs?\n  1. Yes\n  2. No\n');
    fix.promptSkip(); // the prompt is a silent no-op: the screen keeps the dialog verbatim
    // auto_approve off (the default): the confirmed blocked probe returns
    // 'blocked' with the dialog — no key is sent, the wait line carries it.
    // Mutation captured: the dialog field dropped by the dispatch consumer
    // (or placed after the review header fields) breaks the key set and the
    // dialog value below.
    const r = cmd(fix, ['dispatch', 'build', brief, '--timeout', '10000'],
      { HERDR_AGENTS_PROMPT_CHECK_SECONDS: '3' });
    assert.equal(r.status, 7, r.stderr);
    const j = parsePretty(r.stdout);
    assert.equal(j.wait_status, 'blocked');
    assert.equal(j.dialog, 'Approve write to scripts/x.mjs?\n1. Yes\n2. No', 'the dialog is the visible screen (lines trimmed)');
    assert.deepEqual(Object.keys(j),
      ['wait_status', 'agent', 'role', 'kind', 'composed_prompt', 'report', 'report_exists', 'dialog', 'auto_approved'],
      'dialog right after report_exists, before the review fields and auto_approved');
    assert.equal(j.auto_approved, 0, 'auto_approve off: nothing was sent');
    assert.match(r.stderr, /agent 'build' is blocked on an approval or question; run: herdr agent read build --source recent-unwrapped --lines 80/);
  } finally { fix.cleanup(); }
});

// A done report that starts with the review header carries verdict,
// findings and severity into the final JSON — after report_exists (and
// amend), before partial — and a plain done report carries none.
test('dispatch: a done review report lands verdict, findings and severity before partial', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-review-');
  try {
    fix.writeRoster(undefined, ROW12('build', 'p1', 'grok', 'implementer', 'xai', fix.repo, 'grok-4.7', 'build'));
    const brief = fix.brief('brief.md', FULL_BRIEF);
    const body = 'findings: 3 (P0 1, P1 1, P2 1, P3 0) | verdict: fail\n\n| item | state |\n| --- | --- |\n| slice | [done] |\n| fact A | [partial] |\n';
    // Mutation captured: the review fields in the wrong order (e.g. after
    // partial) or missing on a review report break the key set below.
    const r = cmd(fix, ['dispatch', 'build', brief, '--timeout', '10000'],
      { HERDR_AGENTS_PROMPT_CHECK_SECONDS: '0', FAKE_REPORT_TEXT: body });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.wait_status, 'done');
    assert.equal(j.verdict, 'fail');
    assert.equal(j.findings, 3);
    assert.deepEqual(j.severity, { P0: 1, P1: 1, P2: 1, P3: 0 });
    assert.equal(j.partial, 1);
    assert.deepEqual(Object.keys(j),
      ['wait_status', 'agent', 'role', 'kind', 'composed_prompt', 'report', 'report_exists', 'verdict', 'findings', 'severity', 'partial', 'auto_approved'],
      'verdict, findings and severity after report_exists, before partial');
    // A plain done report (no header): none of the three keys.
    const c = cmd(fix, ['dispatch', 'build', brief, '--timeout', '10000'],
      { HERDR_AGENTS_PROMPT_CHECK_SECONDS: '0', FAKE_REPORT_TEXT: '# Report\n\ndone.\n' });
    assert.equal(c.status, 0, c.stderr);
    const jc = JSON.parse(c.stdout);
    assert.ok(!('verdict' in jc) && !('findings' in jc) && !('severity' in jc), `no review fields: ${c.stdout}`);
  } finally { fix.cleanup(); }
});

// ---------- the new dispatch clears the approve-screen marker ----------

test('dispatch: a new dispatch clears the approve-screen marker', { timeout: 30000 }, () => {
  const fix = makeFix('ha-dispatch-approve-screen-');
  try {
    fix.writeRoster(undefined, ROW12('build', 'p1', 'grok', 'implementer', 'xai', fix.repo, 'grok-4.7', 'build'));
    const marker = path.join(fix.ws, 'wait', 'build.approve-screen');
    fs.writeFileSync(marker, '3\tabc\n');
    const r = cmd(fix, ['dispatch', 'build', fix.brief('brief.md', FULL_BRIEF), '--no-wait'], { HERDR_AGENTS_PROMPT_CHECK_SECONDS: '0' });
    assert.equal(r.status, 0, r.stderr);
    // Mutation captured: 'approve-screen' missing from the cleared marker
    // list leaves the file behind.
    assert.ok(!fs.existsSync(marker), 'the approve-screen marker is cleared by a new dispatch');
  } finally { fix.cleanup(); }
});
