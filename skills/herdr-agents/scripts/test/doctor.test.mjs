// doctor / doctor --fix: unit tests for lib/commands/doctor.mjs
// and lib/commands/explain.mjs — every doctorLaneWarnings warn line (invalid
// lanes value, panes outside 3/4, unknown role, role in two lanes, edit and
// review in the same lane, planner in a lane, the lane model/effort dropped
// by a layer as an ok line, per-role kind/model under a lane kind, divergent
// role kinds, the max_workers/split_max_panes/planner alignment warns),
// projectIsFirstRun, doctorUsedKinds, doctorFix (presets 3 and 4, --user,
// the dies 2, the no-change), and explainActivity with a fake herdr. Each
// test file builds its own temp root (mkdtemp) used as HOME, XDG_CONFIG_HOME,
// TMPDIR and HERDR_AGENTS_DIR, with a temporary git repo (operator testing
// rule); no real `herdr` or agent CLI is ever called (fakes.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { JS_ENTRY, nodeBin, fixtureEnv } from './parity.mjs';
import { writeFakeCli } from './fakes.mjs';
import {
  cmdDoctor, doctorCheck, doctorFix, doctorLaneWarnings, doctorRoleKind,
  doctorUsedKinds, projectIsFirstRun, ENTRY_SCRIPT,
} from '../lib/commands/doctor.mjs';
import { explainActivity, explainIdleParagraph, explainPrintRunning, explainRecommendation, explainStateDir } from '../lib/commands/explain.mjs';
import { loadConfig } from '../lib/config.mjs';
import { DieError } from '../lib/config.mjs';
import { configFileFor } from '../lib/config.mjs';
import { setupHookDoctor } from '../lib/setuptext.mjs';

let ROOT;
let REPO;
let HOME;
let CONF;
let STATE;
let TMP;
let FAKES;
let ENV;

// The fixture is created at module scope (node runs a file-scope
// test.before eagerly, bun queues it — a plain call behaves the same on
// both) and removed after the tests.
(() => {
  let root = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-doctor-unit-'));
  root = fs.realpathSync(root); // git reports the resolved path (macOS /var -> /private/var)
  ROOT = root;
  REPO = path.join(root, 'repo');
  HOME = path.join(root, 'home');
  CONF = path.join(root, 'conf');
  STATE = path.join(root, 'state');
  TMP = path.join(root, 'tmp');
  FAKES = path.join(root, 'fakes');
  for (const d of [REPO, HOME, CONF, STATE, TMP, FAKES]) fs.mkdirSync(d, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: REPO, stdio: 'ignore', timeout: 30000 });
  ENV = fixtureEnv({ HOME, XDG_CONFIG_HOME: CONF, HERDR_AGENTS_DIR: STATE, TMPDIR: TMP });
})();
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const PROJ_CONF = path.join(REPO, '.agents', 'herdr-agents.conf');
const USER_CONF = path.join(CONF, 'herdr-agents', 'config');
const writeProj = (text) => {
  fs.mkdirSync(path.dirname(PROJ_CONF), { recursive: true });
  fs.writeFileSync(PROJ_CONF, text);
};
const writeUser = (text) => {
  fs.mkdirSync(path.dirname(USER_CONF), { recursive: true });
  fs.writeFileSync(USER_CONF, text);
};
const cleanLayers = () => {
  fs.rmSync(PROJ_CONF, { force: true });
  fs.rmSync(USER_CONF, { force: true });
  fs.rmSync(STATE, { recursive: true, force: true });
  fs.mkdirSync(STATE, { recursive: true });
};
const ctxOf = () => loadConfig(ENV, REPO);

// A DoctorSay stand-in that records the lines.
function capture() {
  const lines = [];
  const say = {
    ok: (m) => lines.push(`ok: ${m}`),
    warn: (m) => lines.push(`warn: ${m}`),
    lines,
  };
  return say;
}

// ---------- doctorLaneWarnings ----------

test('doctorLaneWarnings: an invalid lanes value and panes outside 2/3/4', () => {
  cleanLayers();
  writeProj('lanes=bogus\n');
  const s1 = capture();
  doctorLaneWarnings(ctxOf(), ENV, REPO, s1);
  assert.ok(s1.lines.includes("warn: config: lanes='bogus' is not on|off"), s1.lines.join('\n'));
  cleanLayers();
  writeProj('panes=5\n');
  const s2 = capture();
  doctorLaneWarnings(ctxOf(), ENV, REPO, s2);
  assert.ok(s2.lines.includes("warn: config: panes='5' is not 2, 3 or 4 (doctor --fix --panes 2|3|4 writes a preset)"), s2.lines.join('\n'));
  cleanLayers();
  const s3 = capture();
  doctorLaneWarnings(ctxOf(), ENV, REPO, s3);
  assert.ok(s3.lines.includes(`warn: config: panes is not set in the project or user file (default 4). Ask the user for 2, 3 or 4 panes, then run '${ENTRY_SCRIPT} doctor --fix --panes <n>' with their answer.`), s3.lines.join('\n'));
  cleanLayers();
  writeProj('panes=3\n');
  const s4 = capture();
  doctorLaneWarnings(ctxOf(), ENV, REPO, s4);
  assert.ok(s4.lines.includes('ok: config: panes=3 (project)'), s4.lines.join('\n'));
  cleanLayers();
  writeProj('panes=2\n');
  const s4b = capture();
  doctorLaneWarnings(ctxOf(), ENV, REPO, s4b);
  assert.ok(s4b.lines.includes('ok: config: panes=2 (project)'), s4b.lines.join('\n'));
  cleanLayers();
  // The doctor does not validate the lane kind against the known kinds
  // (only setup --lane dies): a bogus kind flows into the report as-is.
  writeProj('panes=3\nlane.build.kind=boguskind\n');
  const s5 = capture();
  doctorLaneWarnings(ctxOf(), ENV, REPO, s5); // must not throw
  assert.ok(!s5.lines.some((l) => l.includes('unknown kind')), s5.lines.join('\n'));
  // Mutation captured: panes '2' read as invalid (the ok line would warn
  // instead), or the old "3 or 4" texts in the warns above.
  cleanLayers();
});

test('doctorLaneWarnings: the pane_mode status line (strict ok, flex ok, invalid warn)', () => {
  cleanLayers();
  // The default (strict): the ok line carries the effective pane count.
  writeProj('panes=4\n');
  let s = capture();
  doctorLaneWarnings(ctxOf(), ENV, REPO, s);
  assert.ok(s.lines.includes('ok: config: pane_mode=strict (never more than 4 panels)'), s.lines.join('\n'));
  writeProj('panes=2\n');
  s = capture();
  doctorLaneWarnings(ctxOf(), ENV, REPO, s);
  assert.ok(s.lines.includes('ok: config: pane_mode=strict (never more than 2 panels)'), s.lines.join('\n'));
  // flex: the temporary-panel line with the effective flex_roles.
  writeProj('panes=3\npane_mode=flex\n');
  s = capture();
  doctorLaneWarnings(ctxOf(), ENV, REPO, s);
  assert.ok(s.lines.includes('ok: config: pane_mode=flex (+1 temporary panel for reviewer,documenter)'), s.lines.join('\n'));
  writeProj('panes=3\npane_mode=flex\nflex_roles=documenter\n');
  s = capture();
  doctorLaneWarnings(ctxOf(), ENV, REPO, s);
  assert.ok(s.lines.includes('ok: config: pane_mode=flex (+1 temporary panel for documenter)'), s.lines.join('\n'));
  // An invalid value warns; the run time still resolves strict (the strict
  // lanes stay the effective ones).
  writeProj('panes=4\npane_mode=bogus\n');
  s = capture();
  doctorLaneWarnings(ctxOf(), ENV, REPO, s);
  assert.ok(s.lines.includes("warn: config: pane_mode='bogus' is not strict|flex"), s.lines.join('\n'));
  assert.ok(!s.lines.some((l) => l.startsWith('ok: config: pane_mode')), s.lines.join('\n'));
  // Mutation captured: the invalid value reported as ok, the flex line
  // without the effective flex_roles, or a wrong pane count in the strict
  // line.
  cleanLayers();
});

test('doctor: the flex split_max_panes warns (the mode cap, strict keeps its text)', () => {
  cleanLayers();
  rmOwnFiles();
  // flex panes=4 with an explicit split_max_panes=4 < 4 + 1: the room warn.
  writeProj('panes=4\npane_mode=flex\nsplit_max_panes=4\n');
  let out = doctorOut();
  assert.ok(out.split('\n').includes('warn   config: split_max_panes=4 leaves no room for the temporary panel (panes=4 + flex_extra=1); the extra worker will open in a herd tab. Remove split_max_panes or set 5.'), out);
  // At exactly panes + flex_extra there is room: no warn at all (the old
  // "greater than" check compares with the mode cap in flex).
  writeProj('panes=4\npane_mode=flex\nsplit_max_panes=5\n');
  out = doctorOut();
  assert.ok(!out.split('\n').some((l) => l.includes('is greater than panes') || l.includes('leaves no room for the temporary panel')), out);
  // Above the mode cap: the flex text of the old check.
  writeProj('panes=4\npane_mode=flex\nsplit_max_panes=6\n');
  out = doctorOut();
  assert.ok(out.split('\n').includes('warn   config: split_max_panes=6 is greater than panes=4 + flex_extra=1. Set split_max_panes=5 (doctor --fix aligns it).'), out);
  // The strict mode never gets the room warn (no temporary panel) and
  // keeps its own "greater than" text (pinned elsewhere).
  writeProj('panes=4\nsplit_max_panes=4\n');
  out = doctorOut();
  assert.ok(!out.split('\n').some((l) => l.includes('leaves no room for the temporary panel')), out);
  // Mutation captured: the old check comparing with panes alone in flex
  // (sp=5 would fire "greater than panes=4"), the flex text in the strict
  // mode, or the room warn with split_max_panes unset (the derived value
  // already includes the temporary panel).
  cleanLayers();
  rmOwnFiles();
});

test('doctorLaneWarnings: unknown role, a role in two lanes, edit+review mixed, planner in a lane', () => {
  cleanLayers();
  // Custom lanes: build carries an unknown role and the planner; the
  // implementer sits in two lanes and shares build with a review role.
  writeProj([
    'lane.build.roles=implementer,nosuch,planner,reviewer',
    'lane.read.roles=implementer,researcher',
    'lanes=on',
  ].join('\n'));
  const s = capture();
  doctorLaneWarnings(ctxOf(), ENV, REPO, s);
  assert.ok(s.lines.includes('warn: lanes: unknown roles: build:nosuch. Use a role from \'roles\', or remove it.'), s.lines.join('\n'));
  assert.ok(s.lines.includes('warn: lanes: roles in more than one lane: implementer. Keep each role in one lane.'), s.lines.join('\n'));
  assert.ok(s.lines.includes('warn: lanes: build mix an edit role with a review role (a session must not review code it wrote). Split them the way panes=4 separates build from review.'), s.lines.join('\n'));
  assert.ok(s.lines.includes("warn: lanes: 'build' includes planner. The orchestrator is the planner and opens no pane; remove it from the lane."), s.lines.join('\n'));
  cleanLayers();
});

test('doctorLaneWarnings: the planner in a solo lane is the only role: no used kind, no unknown', () => {
  cleanLayers();
  writeProj('lane.solo.roles=planner\n');
  const s = capture();
  doctorLaneWarnings(ctxOf(), ENV, REPO, s);
  assert.ok(s.lines.includes('ok: lanes: every role is known'), s.lines.join('\n'));
  cleanLayers();
});

test('doctorLaneWarnings: a lane model/effort from a lower layer than the lane kind is reported as ok', () => {
  cleanLayers();
  // panes=3 so the preset lanes are build and review (the old read lane
  // is gone from the presets and its keys are not the lane keys).
  writeUser('lane.build.model=claude-opus\nlane.review.effort=low\n');
  writeProj('panes=3\nlane.build.kind=grok\nlane.review.kind=codex\n');
  const s = capture();
  doctorLaneWarnings(ctxOf(), ENV, REPO, s);
  assert.ok(s.lines.includes('ok: lanes: lane \'build\' kind grok (project); ignored lane model claude-opus from user (another kind)'), s.lines.join('\n'));
  assert.ok(s.lines.includes('ok: lanes: lane \'review\' kind codex (project); ignored lane effort low from user (another kind)'), s.lines.join('\n'));
  // A model from the same layer as the kind is kept, not reported.
  writeProj('panes=3\nlane.build.kind=grok\nlane.build.model=grok-4.7\nlane.review.kind=codex\n');
  writeUser('lane.review.effort=low\n');
  const s2 = capture();
  doctorLaneWarnings(ctxOf(), ENV, REPO, s2);
  assert.ok(!s2.lines.some((l) => l.includes('ignored lane model')), s2.lines.join('\n'));
  assert.ok(s2.lines.includes('ok: lanes: lane \'review\' kind codex (project); ignored lane effort low from user (another kind)'), s2.lines.join('\n'));
  cleanLayers();
});

test('doctorLaneWarnings: per-role kind/model under a lane kind, divergent kinds, alignment warns', () => {
  cleanLayers();
  // role.<r>.kind / role.<r>.model are explicit while the lane has its own kind.
  writeProj([
    'lane.build.kind=grok',
    'role.implementer.kind=codex',
    'role.designer.model=gemini',
  ].join('\n'));
  const s = capture();
  doctorLaneWarnings(ctxOf(), ENV, REPO, s);
  assert.ok(s.lines.includes("warn: config: role.implementer.kind is set and lane 'build' has kind=grok. Remove role.implementer.kind (doctor --fix); the lane shares one kind."), s.lines.join('\n'));
  assert.ok(s.lines.includes("warn: config: role.designer.model is set and lane 'build' has its own kind. Remove role.designer.model (doctor --fix)."), s.lines.join('\n'));
  // Divergent role kinds without a lane kind (config, else frontmatter).
  cleanLayers();
  writeProj('role.designer.kind=agy\n'); // implementer frontmatter is grok
  const s2 = capture();
  doctorLaneWarnings(ctxOf(), ENV, REPO, s2);
  assert.ok(s2.lines.some((l) => l.startsWith("warn: lanes: lane 'build' has no lane.build.kind and its roles disagree (") && l.includes('implementer=grok designer=agy tasker=grok') && l.includes("setup --lane build=")), s2.lines.join('\n'));
  // max_workers mismatch (against the sum of the lane capacities) and
  // split_max_panes above panes.
  cleanLayers();
  writeProj('max_workers=5\nsplit_max_panes=6\npanes=3\n');
  const s3 = capture();
  doctorLaneWarnings(ctxOf(), ENV, REPO, s3);
  assert.ok(s3.lines.includes('warn: config: max_workers=5 but the lanes hold 2 workers (build=1 review=1). Set max_workers=2 (doctor --fix aligns it).'), s3.lines.join('\n'));
  assert.ok(s3.lines.includes('warn: config: split_max_panes=6 is greater than panes=3. Set split_max_panes=3 (doctor --fix aligns it).'), s3.lines.join('\n'));
  // The ok line names the capacities (panes=4: build holds 2).
  cleanLayers();
  writeProj('panes=4\n');
  const s3b = capture();
  doctorLaneWarnings(ctxOf(), ENV, REPO, s3b);
  assert.ok(s3b.lines.includes('ok: config: max_workers=3 matches the lanes (build=2 review=1)'), s3b.lines.join('\n'));
  // In the flex mode the max_workers target is the capacity sum plus
  // flex_extra (the temporary worker's live slot): the explicit capacity
  // sum is a mismatch, the sum + 1 matches.
  cleanLayers();
  writeProj('pane_mode=flex\nmax_workers=2\npanes=3\n');
  const s3c = capture();
  doctorLaneWarnings(ctxOf(), ENV, REPO, s3c);
  assert.ok(s3c.lines.includes('warn: config: max_workers=2 but the lanes hold 3 workers (build=1 review=1 docs=0). Set max_workers=3 (doctor --fix aligns it).'), s3c.lines.join('\n'));
  cleanLayers();
  writeProj('pane_mode=flex\nmax_workers=3\npanes=3\n');
  const s3d = capture();
  doctorLaneWarnings(ctxOf(), ENV, REPO, s3d);
  assert.ok(s3d.lines.includes('ok: config: max_workers=3 matches the lanes (build=1 review=1 docs=0)'), s3d.lines.join('\n'));
  // Mutation captured: the lane count used as the sum (the panes=4 ok
  // line would read "matches the lanes (build=1 review=1)" with max_workers=2),
  // or the old "there are N lanes" text.
  // role.planner.* set in the project file (the defaults layer does not warn).
  cleanLayers();
  writeProj('role.planner.model=fable\n');
  const s4 = capture();
  doctorLaneWarnings(ctxOf(), ENV, REPO, s4);
  assert.ok(s4.lines.includes('warn: config: role_planner_model is set (project) but the planner is the orchestrator and opens no pane. Remove it (doctor --fix).'), s4.lines.join('\n'));
  cleanLayers();
});

test('doctorLaneWarnings: the old preset lanes and the orphan lane keys', () => {
  cleanLayers();
  // The old 3-pane preset (build|read) still loads: the lanes are the old
  // ones, so the doctor points at the migration.
  writeProj([
    'lane.build.roles=implementer,designer,tasker',
    'lane.read.roles=scouter,researcher,reviewer,security-reviewer,ui-reviewer,inspector',
    'panes=3',
  ].join('\n'));
  const s = capture();
  doctorLaneWarnings(ctxOf(), ENV, REPO, s);
  assert.ok(s.lines.includes(`warn: lanes: the lanes come from an old preset (build, read); run '${ENTRY_SCRIPT} doctor --fix --panes 3' to move to the new ones (research joins the build lane).`), s.lines.join('\n'));
  cleanLayers();
  // The old 4-pane preset names its three lanes.
  writeProj([
    'lane.build.roles=implementer,designer,tasker',
    'lane.explore.roles=scouter,researcher',
    'lane.review.roles=reviewer,security-reviewer,ui-reviewer,inspector',
  ].join('\n'));
  const s2 = capture();
  doctorLaneWarnings(ctxOf(), ENV, REPO, s2);
  assert.ok(s2.lines.includes(`warn: lanes: the lanes come from an old preset (build, explore, review); run '${ENTRY_SCRIPT} doctor --fix --panes 4' to move to the new ones (research joins the build lane).`), s2.lines.join('\n'));
  // Counter-example: the current preset lanes are not old.
  cleanLayers();
  writeProj([
    'lane.build.roles=implementer,designer,tasker,scouter,researcher',
    'lane.review.roles=reviewer,security-reviewer,ui-reviewer,inspector',
  ].join('\n'));
  const s3 = capture();
  doctorLaneWarnings(ctxOf(), ENV, REPO, s3);
  assert.ok(!s3.lines.some((l) => l.includes('old preset')), s3.lines.join('\n'));
  // Orphan lane key: an effective lane.<l>.<attr> with <l> outside the
  // lane names — one line per key.
  cleanLayers();
  writeProj('lane.explore.kind=codex\n');
  const s4 = capture();
  doctorLaneWarnings(ctxOf(), ENV, REPO, s4);
  assert.ok(s4.lines.includes('warn: config: lane.explore.kind=codex (project) sets a lane that does not exist (lanes: build review). doctor --fix removes it.'), s4.lines.join('\n'));
  // Counter-example: an attr of an existing lane (a capacity override).
  cleanLayers();
  writeProj('lane.review.panes=2\n');
  const s5 = capture();
  doctorLaneWarnings(ctxOf(), ENV, REPO, s5);
  assert.ok(!s5.lines.some((l) => l.includes('sets a lane that does not exist')), s5.lines.join('\n'));
  // Mutation captured: the old preset signature not detected (the warn
  // vanishes), or an orphan key of an existing lane warned about.
  cleanLayers();
});

// ---------- projectIsFirstRun ----------

test('projectIsFirstRun: the team-choice and roster tests', () => {
  cleanLayers();
  assert.equal(projectIsFirstRun(ctxOf(), ENV, REPO), true, 'fresh project is a first run');
  // A header-only roster does not count.
  fs.mkdirSync(path.join(STATE, 'ws'), { recursive: true });
  fs.writeFileSync(path.join(STATE, 'ws', 'agents.tsv'), '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\tmodel\tapprovals\troles\tlane\n');
  assert.equal(projectIsFirstRun(ctxOf(), ENV, REPO), true, 'header-only roster is still a first run');
  // A roster row is a team running.
  fs.appendFileSync(path.join(STATE, 'ws', 'agents.tsv'), 'build\tp1\tgrok\timplementer\txai\t1\t/tmp/work\tt1\tgrok-4.7\tfull\timplementer\tbuild\n');
  assert.equal(projectIsFirstRun(ctxOf(), ENV, REPO), false, 'a roster row is not a first run');
  // A team choice in the config is not a first run (roster row stays).
  writeProj('lane.build.kind=grok\n');
  assert.equal(projectIsFirstRun(ctxOf(), ENV, REPO), false, 'config with a lane kind is not a first run');
  // Comments and max_workers alone are not a team choice.
  cleanLayers();
  writeProj('# note\nmax_workers=3\n');
  fs.mkdirSync(path.join(STATE, 'ws'), { recursive: true });
  fs.writeFileSync(path.join(STATE, 'ws', 'agents.tsv'), '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\tmodel\tapprovals\troles\tlane\n');
  assert.equal(projectIsFirstRun(ctxOf(), ENV, REPO), true, 'comments + max_workers alone is a first run');
  cleanLayers();
});

// Mutation captured: accepting any command containing `herdr-agents` hides a stale SessionStart hook.
test('doctor requires the current SessionStart command', () => {
  cleanLayers();
  const settings = path.join(REPO, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'sh -c herdr-agents doctor' }] }] },
  }));
  const old = spawnSync(nodeBin(), [JS_ENTRY, 'doctor'], { cwd: REPO, env: ENV, encoding: 'utf8', timeout: 60000 });
  assert.equal(old.status, 0, old.stderr);
  assert.ok(old.stdout.includes('warn   no herdr-agents hooks in .claude/settings.json'), old.stdout);

  fs.writeFileSync(settings, JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: setupHookDoctor() }] }] },
  }));
  const current = spawnSync(nodeBin(), [JS_ENTRY, 'doctor'], { cwd: REPO, env: ENV, encoding: 'utf8', timeout: 60000 });
  assert.equal(current.status, 0, current.stderr);
  assert.ok(current.stdout.includes('ok     Claude hooks present in .claude/settings.json'), current.stdout);
  fs.rmSync(path.join(REPO, '.claude'), { recursive: true, force: true });
});

// ---------- doctorUsedKinds ----------

test('doctorUsedKinds: lane kind wins, else the lane roles, else every role file; planner excluded', () => {
  cleanLayers();
  writeProj('lane.build.kind=claude\n');
  // build: the lane kind wins; review: the frontmatter
  // codex/claude/agy/agy. The build lane carries the research roles, so
  // nothing grok is in use here.
  assert.deepEqual(doctorUsedKinds(ctxOf(), ENV, REPO), ['agy', 'claude', 'codex']);
  cleanLayers();
  writeProj('role.implementer.kind=codex\nrole.designer.kind=claude\nrole.tasker.kind=codex\n');
  // build: codex/claude/codex + the research roles' frontmatter grok;
  // review: the frontmatter codex/claude/agy/agy — sorted unique.
  assert.deepEqual(doctorUsedKinds(ctxOf(), ENV, REPO), ['agy', 'claude', 'codex', 'grok']);
  // Lanes off: every role file (the planner's frontmatter kind is excluded —
  // spawn planner exits 12 before resolving a kind).
  cleanLayers();
  writeProj('lanes=off\n');
  assert.deepEqual(doctorUsedKinds(ctxOf(), ENV, REPO), ['agy', 'claude', 'codex', 'grok']);
  // A solo planner lane contributes no kind.
  cleanLayers();
  writeProj('lane.solo.roles=planner\n');
  assert.deepEqual(doctorUsedKinds(ctxOf(), ENV, REPO), []);
  // The documenter never votes a kind (its kind is configured per role, or
  // via the docs lane in the flex mode): a lane holding only the documenter
  // contributes nothing.
  cleanLayers();
  writeProj('lane.solo.roles=documenter\n');
  assert.deepEqual(doctorUsedKinds(ctxOf(), ENV, REPO), [], 'the documenter never joins the used kinds');
  // doctorRoleKind: config wins over frontmatter; the planner uses none.
  cleanLayers();
  writeProj('role.reviewer.kind=grok\n');
  assert.equal(doctorRoleKind('reviewer', ctxOf(), ENV, REPO), 'grok', 'config kind wins');
  assert.equal(doctorRoleKind('planner', ctxOf(), ENV, REPO), '', 'the planner uses no kind');
  assert.equal(doctorRoleKind('designer', ctxOf(), ENV, REPO), 'agy', 'frontmatter kind');
  // Mutation captured: the research roles kept out of the build lane (the
  // first case would name grok), or the lane kind not winning over the
  // role kinds.
  cleanLayers();
});

// ---------- doctorFix ----------

function runFix(args) {
  const keep = process.stdout.write.bind(process.stdout);
  let out = '';
  process.stdout.write = (s) => { out += s; return true; };
  let threw = null;
  try {
    doctorFix(args[0], args[1], ctxOf(), ENV, REPO);
  } catch (e) { threw = e; } finally {
    process.stdout.write = keep;
  }
  return { out, threw };
}

const LEGACY = [
  '# keep this comment',
  'split_max_panes=6',
  'role.implementer.kind=grok',
  'role.designer.kind=grok',
  'role.tasker.kind=grok',
  'role.scouter.kind=grok',
  'role.researcher.kind=grok',
  'role.reviewer.kind=grok',
  'role.security-reviewer.kind=grok',
  'role.ui-reviewer.kind=grok',
  'role.inspector.kind=grok',
  'role.planner.model=fable',
  '# tail comment',
].join('\n') + '\n';

test('doctorFix: the dies 2 (bad flag, no panes anywhere, bad file panes)', () => {
  cleanLayers();
  writeProj(LEGACY);
  let r = runFix(['project', '5']);
  assert.ok(r.threw instanceof DieError && r.threw.code === 2, String(r.threw));
  assert.equal(r.threw.message, 'doctor --fix: --panes must be 2, 3 or 4');
  r = runFix(['project', '']);
  assert.ok(r.threw instanceof DieError && r.threw.code === 2, String(r.threw));
  assert.ok(r.threw.message.startsWith('doctor --fix: panes is not set in '), r.threw.message);
  assert.ok(r.threw.message.includes("doctor --fix --panes <n>'."), r.threw.message);
  writeProj('panes=7\n');
  r = runFix(['project', '']);
  assert.equal(r.threw.message, 'doctor --fix: panes=7 in ' + PROJ_CONF + ' is not 2, 3 or 4');
  // The file is untouched by the dies.
  assert.equal(fs.readFileSync(PROJ_CONF, 'utf8'), 'panes=7\n');
  // Mutation captured: the flag/file validation still on 3|4 (the dies
  // above would accept 2 or warn with the old texts).
  cleanLayers();
});

test('doctorFix: the preset 3 and 4 rewrites (no frozen roles or limits, planner dropped)', () => {
  cleanLayers();
  writeProj(LEGACY);
  let r = runFix(['project', '3']);
  assert.equal(r.threw, null, r.threw);
  assert.ok(r.out.includes('set panes=3'), r.out);
  assert.ok(r.out.includes('removed split_max_panes=6 (derived from panes)'), r.out);
  assert.ok(!r.out.includes('set lane.build.roles'), r.out);
  assert.ok(!r.out.includes('set max_workers='), r.out);
  assert.ok(r.out.includes(`doctor --fix: updated ${PROJ_CONF}`), r.out);
  const conf3 = fs.readFileSync(PROJ_CONF, 'utf8');
  for (const line of ['panes=3', 'reuse_workers=on', 'lane.build.kind=grok', 'lane.review.kind=grok', '# keep this comment', '# tail comment']) {
    assert.ok(conf3.split('\n').includes(line), `missing ${line}:\n${conf3}`);
  }
  assert.ok(!/^max_workers=/m.test(conf3), conf3);
  assert.ok(!/^split_max_panes=/m.test(conf3), conf3);
  assert.ok(!/^lane\..*\.roles=/m.test(conf3), conf3);
  assert.ok(!conf3.includes('role.implementer.kind'), conf3);
  assert.ok(!conf3.includes('role.planner.model'), conf3);
  // The diff is shown (unifiedDiff, a/<file> / b/<file> labels).
  assert.ok(r.out.includes(`--- a/${PROJ_CONF}`), r.out);
  assert.ok(r.out.includes(`+++ b/${PROJ_CONF}`), r.out);
  // Re-running on the already-fixed file: no changes.
  r = runFix(['project', '3']);
  assert.equal(r.threw, null, r.threw);
  assert.ok(r.out.endsWith(`doctor --fix: no changes in ${PROJ_CONF}\n`), r.out);
  cleanLayers();
  writeProj(LEGACY);
  r = runFix(['project', '4']);
  const conf4 = fs.readFileSync(PROJ_CONF, 'utf8');
  for (const line of ['panes=4', 'reuse_workers=on', 'lane.build.kind=grok', 'lane.review.kind=grok']) {
    assert.ok(conf4.split('\n').includes(line), `missing ${line}:\n${conf4}`);
  }
  assert.ok(!/^lane\..*\.roles=/m.test(conf4), conf4);
  assert.ok(!/^max_workers=/m.test(conf4), conf4);
  assert.ok(!/^split_max_panes=/m.test(conf4), conf4);
  assert.ok(!conf4.includes('lane.explore'), conf4);
  // Mutation captured: writing the preset lane roles or max_workers back
  // into the file, or keeping the explore lane, would leave the lines
  // asserted absent here.
  cleanLayers();
});

test('doctorFix: a divergent review lane keeps the per-role kinds and warns on stderr', () => {
  cleanLayers();
  writeProj([
    'split_max_panes=6',
    'role.reviewer.kind=codex',
    'role.security-reviewer.kind=claude',
    'role.planner.model=fable',
  ].join('\n') + '\n');
  const keepErr = process.stderr.write.bind(process.stderr);
  const keepOut = process.stdout.write.bind(process.stdout);
  let err = '';
  process.stderr.write = (s) => { err += s; return true; };
  process.stdout.write = () => true;
  let threw = null;
  try { doctorFix('project', '4', ctxOf(), ENV, REPO); } catch (e) { threw = e; } finally {
    process.stderr.write = keepErr;
    process.stdout.write = keepOut;
  }
  assert.equal(threw, null, String(threw));
  const conf = fs.readFileSync(PROJ_CONF, 'utf8');
  assert.ok(conf.split('\n').includes('role.reviewer.kind=codex'), conf);
  assert.ok(conf.split('\n').includes('role.security-reviewer.kind=claude'), conf);
  assert.ok(!/^lane\.review\.kind=/m.test(conf), conf);
  assert.ok(!/^lane\.build\.kind=/m.test(conf), conf);
  assert.ok(!/^lane\.review\.model=/m.test(conf), conf);
  // The old explore lane is gone (research joins the build lane) and the
  // preset file freezes no roles.
  assert.ok(!conf.includes('lane.explore'), conf);
  assert.ok(!/^lane\..*\.roles=/m.test(conf), conf);
  assert.ok(!conf.includes('role.planner.model'), conf);
  assert.ok(err.includes('reviewer=codex') && err.includes('security-reviewer=claude'), err);
  assert.ok(err.includes('setup --lane review='), err);
  cleanLayers();
});

test('doctorFix: --user targets the user file', () => {
  cleanLayers();
  writeUser('panes=3\n');
  const r = runFix(['user', '4']);
  assert.equal(r.threw, null, r.threw);
  const conf = fs.readFileSync(USER_CONF, 'utf8');
  assert.ok(conf.split('\n').includes('panes=4'), conf);
  assert.ok(r.out.includes(`doctor --fix: updated ${USER_CONF}`), r.out);
  // --user with no panes anywhere dies 2 citing the user file.
  cleanLayers();
  writeUser('reuse_workers=on\n');
  const r2 = runFix(['user', '']);
  assert.ok(r2.threw instanceof DieError && r2.threw.code === 2);
  assert.ok(r2.threw.message.startsWith(`doctor --fix: panes is not set in ${USER_CONF}`), r2.threw.message);
  cleanLayers();
});

// ---------- cmdDoctor (in-process + the entry) ----------

test('cmdDoctor: unknown option dies 2; doctor --fix --user re-runs the check in-process', () => {
  cleanLayers();
  fs.writeFileSync(path.join(REPO, 'AGENTS.md'), '# Agent instructions\n');
  let threw = null;
  try { cmdDoctor(['--bogus'], ctxOf(), ENV, REPO); } catch (e) { threw = e; }
  assert.ok(threw instanceof DieError && threw.code === 2, String(threw));
  assert.equal(threw.message, "doctor: unknown option '--bogus'");
  cleanLayers();
  writeProj('panes=3\n');
  writeFakeCli(FAKES, 'herdr', 'process.exit(0);\n'); // no host herdr may be called
  const r = spawnSync(nodeBin(), [JS_ENTRY, 'doctor', '--fix', '--panes', '4'], { cwd: REPO, env: { ...ENV, PATH: FAKES }, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('set panes=4'), r.stdout);
  // The preset file freezes no roles or kinds, so the team choice is
  // still open and the re-run reads as a first run.
  assert.ok(r.stdout.includes('first_run: true'), r.stdout);
  const last = r.stdout.trimEnd().split('\n').pop();
  assert.ok(/^\d+ ok, \d+ warning\(s\)$/.test(last), r.stdout);
  // Mutation captured: the fix writing lane roles/kinds into the preset
  // file (the re-run would read first_run: false).
  cleanLayers();
});

// ---------- explainActivity (fake herdr, fakes.mjs) ----------

test('explainActivity: report, working, quota, waiting, closed and unknown states', { timeout: 30000 }, () => {
  cleanLayers();
  const sd = path.join(STATE, 'ws');
  fs.mkdirSync(sd, { recursive: true });
  const reportFile = path.join(STATE, 'reports', 'done.md');
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, 'report body\n');
  const fake = `
const name = process.argv[4];
const sub = process.argv[3]; // runCli passes ['agent', <sub>, <name>, …]
if (sub === 'get') {
  const status = { done: 'working', work: 'working', workrep: 'working', idle: 'idle', quota: 'idle', gone: 'gone', blocked: 'blocked', report: 'idle' }[name] ?? 'idle';
  if (name === 'gone' || name === 'unavailable') {
    process.stderr.write(JSON.stringify({ error: { code: name === 'gone' ? 'agent_not_found' : 'boom', message: 'no' } }) + '\\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ result: { agent: { agent_status: status } } }) + '\\n');
} else if (sub === 'read') {
  if (name === 'quota') process.stdout.write('Individual quota reached\\n');
}
`;
  writeFakeCli(FAKES, 'herdr', fake);
  const env = { ...ENV, PATH: `${FAKES}:/usr/bin:/bin` };
  const ctx = ctxOf();
  // A finished report (the recorded path exists and is non-empty) is idle,
  // even over a working state; with the report still missing, working wins.
  fs.writeFileSync(path.join(sd, 'last-report-done'), reportFile + '\n');
  assert.equal(explainActivity('done', sd, ctx, env, REPO), 'idle', 'finished report is idle');
  assert.equal(explainActivity('work', sd, ctx, env, REPO), 'working', 'no report: working');
  fs.writeFileSync(path.join(sd, 'last-report-workrep'), '/does/not/land.md\n');
  assert.equal(explainActivity('workrep', sd, ctx, env, REPO), 'working', 'working wins over a report that is still missing');
  assert.equal(explainActivity('idle', sd, ctx, env, REPO), 'idle', 'no report, agent idle');
  assert.equal(explainActivity('quota', sd, ctx, env, REPO), 'out of quota', 'the screen says quota');
  assert.equal(explainActivity('blocked', sd, ctx, env, REPO), 'waiting for approval');
  assert.equal(explainActivity('gone', sd, ctx, env, REPO), 'closed');
  assert.equal(explainActivity('unavailable', sd, ctx, env, REPO), 'state unknown');
  // A recorded report whose file is missing is a report that never landed.
  fs.writeFileSync(path.join(sd, 'last-report-report'), '/does/not/exist.md\n');
  assert.equal(explainActivity('report', sd, ctx, env, REPO), 'waiting for report');
  // No herdr on the PATH at all: the roster alone decides.
  const envNoHerdr = { ...ENV, PATH: '/usr/bin:/bin' };
  assert.equal(explainActivity('report', sd, ctx, envNoHerdr, REPO), 'waiting for report', 'no herdr: the recorded report waits');
  assert.equal(explainActivity('idle', sd, ctx, envNoHerdr, REPO), 'idle', 'no herdr, no report: idle');
  cleanLayers();
});

test('explainRecommendation: the 2, 3 and 4 panel texts and the lanes-off note', () => {
  cleanLayers();
  writeProj('panes=2\nlane.build.kind=grok\n');
  let rec = explainRecommendation(ctxOf(), ENV, REPO);
  assert.equal(rec[0], 'Recommendation: 2 panels - one writes code (research included) and the review happens here, from another model family. The lightest choice. 3 panels add a reviewer panel.');
  assert.ok(rec.includes('Chosen for build: grok.'), rec.join('\n'));
  writeProj('panes=3\nlane.build.kind=grok\nlane.review.kind=codex\n');
  rec = explainRecommendation(ctxOf(), ENV, REPO);
  assert.equal(rec[0], 'Recommendation: 3 panels - one writes code (research included) and one reviews. Lighter on quota. 4 panels add a second writer; with 2 panels the review happens here.');
  assert.ok(rec.includes('Chosen for build: grok.'), rec.join('\n'));
  assert.ok(rec.includes('Chosen for review: codex.'), rec.join('\n'));
  writeProj('panes=4\nlane.build.kind=grok\nlane.review.kind=codex\nlane.review.model=gpt-5\n');
  rec = explainRecommendation(ctxOf(), ENV, REPO);
  assert.equal(rec[0], 'Recommendation: 4 panels - two write code (research included) in parallel and one reviews. Uses more quota. 3 panels are lighter: one writes and one reviews. With 2 panels one writes and the review happens here.');
  // A lane attr with a model renders the model, a kind-only lane does not.
  assert.ok(rec.includes('Chosen for build: grok.'), rec.join('\n'));
  assert.ok(rec.includes('Chosen for review: codex, model gpt-5.'), rec.join('\n'));
  writeProj('lanes=off\n');
  rec = explainRecommendation(ctxOf(), ENV, REPO);
  assert.ok(rec.includes('Each agent keeps its own assistant instead of sharing one panel.'), rec.join('\n'));
  // Mutation captured: the old 3-vs-4 texts, or a 3-panel recommendation
  // for panes=2 (the 2-pane text is the lightest-choice one).
  cleanLayers();
});

test('explainPrintRunning: the panel count, the preset order and the idle paragraph', () => {
  cleanLayers();
  writeProj('panes=4\nlane.build.kind=grok\n');
  const ctx = ctxOf();
  const rows = [
    ['build', 'implementer', 'grok', 'grok-4.7', 'working'],
    ['review', 'reviewer', 'codex', 'gpt-5', 'idle'],
  ];
  const lines = explainPrintRunning(rows, ctx, ENV, REPO);
  assert.equal(lines[0], 'Panels: 4.');
  assert.ok(lines.includes('build: implementer, grok, model grok-4.7, working'), lines.join('\n'));
  assert.ok(lines.includes('review: reviewer, codex, model gpt-5, idle'), lines.join('\n'));
  // A preset lane without a row is not started (no review row).
  const onlyBuild = [[ 'build', 'implementer', 'grok', 'grok-4.7', 'working']];
  assert.ok(explainPrintRunning(onlyBuild, ctx, ENV, REPO).includes('review: not started'), 'a preset lane without a row is not started: ' + explainPrintRunning(onlyBuild, ctx, ENV, REPO).join('\n'));
  writeProj('panes=3\n');
  assert.equal(explainPrintRunning(rows, ctxOf(), ENV, REPO)[0], 'Panels: 3.');
  writeProj('panes=2\n');
  assert.equal(explainPrintRunning(rows, ctxOf(), ENV, REPO)[0], 'Panels: 2.');
  // The flex mode: the Panels line notes the temporary panel, and a burst
  // worker's row (roster column 13 `burst`) ends with (temporary).
  writeProj('panes=4\npane_mode=flex\n');
  const fctx = ctxOf();
  const burstRow = ['docs', 'documenter', 'codex', 'gpt-5', 'working', 'burst'];
  assert.equal(explainPrintRunning(rows, fctx, ENV, REPO)[0], 'Panels: 4 (+1 temporary).');
  const flines = explainPrintRunning([burstRow], fctx, ENV, REPO);
  assert.ok(flines.some((l) => l === 'docs: documenter, codex, model gpt-5, working (temporary)'), flines.join('\n'));
  // Without lanes the mode has no effect on the Panels line (a burst row
  // still carries the suffix — the roster row is the evidence).
  writeProj('panes=4\npane_mode=flex\nlanes=off\n');
  assert.equal(explainPrintRunning(rows, ctxOf(), ENV, REPO)[0], 'Panels: 4.');
  assert.ok(explainPrintRunning([burstRow], ctxOf(), ENV, REPO).some((l) => l.endsWith('(temporary)')));
  // The idle paragraph is the fixed text (the panels wording).
  assert.equal(explainIdleParagraph().join('\n'),
    'herdr-agents runs a small team of agents in Herdr panels. You stay in this panel and lead. Each other panel is one agent with one job: writing code (research included) or reviewing. Those agents never commit or push. You can watch a panel or close it. Each assistant spends the quota of its own account. Nothing is running yet. To start, describe the work here. The first time, you are asked how many panels to open and which assistant each job should use, and nothing opens until you agree. Four panels are recommended: two write code in parallel and one reviews; that uses more quota. Three panels are lighter: one writes and one reviews. With two panels one writes and the review happens here.');
  // Mutation captured: the old idle paragraph (the "how many agents to
  // open" wording), or a lane without a row printed with a row.
  cleanLayers();
});

test('explainStateDir: an unreadable state root lists nothing (bash find 2>/dev/null)', {
  skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'needs POSIX permissions and a non-root user' : false,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-explain-unreadable-'));
  const state = path.join(root, 'state');
  fs.mkdirSync(path.join(state, 'ws1'), { recursive: true });
  fs.writeFileSync(path.join(state, 'ws1', 'agents.tsv'), '# name\tpane\nw1\tp1\n');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const env = { ...fixtureEnv(), HOME: root, XDG_CONFIG_HOME: path.join(root, 'conf'), HERDR_AGENTS_DIR: state, PATH: bin };
  fs.chmodSync(state, 0o000);
  try {
    const r = explainStateDir(loadConfig(env, root), env, root);
    assert.deepEqual(r, { rc: 1, sd: '' });
  } finally {
    fs.chmodSync(state, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- own-provider traps ----------

const PI_MODELS_FILE = path.join(HOME, '.pi', 'agent', 'models.json');
const PI_SETTINGS_FILE = path.join(HOME, '.pi', 'agent', 'settings.json');
const OC_PROJECT_FILE = path.join(REPO, 'opencode.json');
const rmOwnFiles = () => {
  for (const f of [PI_MODELS_FILE, PI_SETTINGS_FILE, OC_PROJECT_FILE]) fs.rmSync(f, { force: true });
};

// doctorCheck in-process with captured stdout, on a controlled PATH (a
// fake herdr, no agent CLI) so no host binary can leak into the output.
function doctorOut() {
  writeFakeCli(FAKES, 'herdr', 'process.exit(0);\n'); // no host herdr may be called
  const env = { ...ENV, PATH: FAKES };
  const keep = process.stdout.write.bind(process.stdout);
  let out = '';
  process.stdout.write = (s) => { out += s; return true; };
  try {
    doctorCheck(loadConfig(env, REPO), env, REPO);
  } finally {
    process.stdout.write = keep;
  }
  return out;
}

const PI_KEY_LINE = (file) => `warn   own provider 'my-provider' (pi) has a literal apiKey in ${file}; use an environment reference (pi: "$MY_API_KEY", opencode: "{env:MY_API_KEY}")`;
const OC_KEY_LINE = (file) => `warn   own provider 'my-provider' (opencode) has a literal apiKey in ${file}; use an environment reference (pi: "$MY_API_KEY", opencode: "{env:MY_API_KEY}")`;

// Mutation captured: accepting a literal apiKey as a reference (pi not
// starting with $, opencode not exactly {env:NAME}) drops the warn lines
// these examples assert.
test('doctor: own provider with a literal apiKey warns; the env reference does not', () => {
  cleanLayers();
  rmOwnFiles();
  fs.mkdirSync(path.dirname(PI_MODELS_FILE), { recursive: true });
  // Example (pi): a literal key in the file.
  fs.writeFileSync(PI_MODELS_FILE, JSON.stringify({
    providers: { 'my-provider': { apiKey: 'sk-test-secret', models: [{ id: 'my-model', maxTokens: 32768 }] } },
  }));
  let out = doctorOut();
  assert.ok(out.split('\n').includes(PI_KEY_LINE(PI_MODELS_FILE)), out);
  assert.ok(!out.split('\n').some((l) => l.startsWith('warn   pi model')), 'enough maxTokens: no headroom line: ' + out);
  rmOwnFiles();
  // Counter-example (pi): "$MY_API_KEY" is a reference, not a trap.
  fs.writeFileSync(PI_MODELS_FILE, JSON.stringify({
    providers: { 'my-provider': { apiKey: '$MY_API_KEY', models: [{ id: 'my-model', maxTokens: 32768 }] } },
  }));
  out = doctorOut();
  assert.ok(!out.includes('literal apiKey'), out);
  rmOwnFiles();
  // Example (opencode): a literal key in the project opencode.json.
  fs.writeFileSync(OC_PROJECT_FILE, JSON.stringify({
    provider: { 'my-provider': { options: { apiKey: 'sk-test-secret' }, models: { 'my-model': { options: { thinking_token_budget: 16000 } } } } },
  }));
  out = doctorOut();
  assert.ok(out.split('\n').includes(OC_KEY_LINE(OC_PROJECT_FILE)), out);
  assert.ok(!out.split('\n').some((l) => l.startsWith('warn   opencode model')), 'budget present: no budget line: ' + out);
  rmOwnFiles();
  // Counter-example (opencode): "{env:MY_API_KEY}" is a reference.
  fs.writeFileSync(OC_PROJECT_FILE, JSON.stringify({
    provider: { 'my-provider': { options: { apiKey: '{env:MY_API_KEY}' }, models: { 'my-model': { options: { thinking_token_budget: 16000 } } } } },
  }));
  out = doctorOut();
  assert.ok(!out.includes('literal apiKey'), out);
  rmOwnFiles();
  cleanLayers();
});

// Mutation captured: `<=` instead of `<` at the headroom boundary (or a
// default level other than high) changes which fixtures warn below.
test('doctor: pi maxTokens without the 8192 headroom over the effort budget warns', () => {
  cleanLayers();
  rmOwnFiles();
  const writePi = (models, settings) => {
    fs.rmSync(PI_SETTINGS_FILE, { force: true });
    fs.mkdirSync(path.dirname(PI_MODELS_FILE), { recursive: true });
    fs.writeFileSync(PI_MODELS_FILE, JSON.stringify({ providers: { 'my-provider': { apiKey: '$MY_API_KEY', models } } }));
    if (settings !== undefined) fs.writeFileSync(PI_SETTINGS_FILE, JSON.stringify(settings));
  };
  // Example: the default level (effort.pi empty -> high, budget 16384).
  writePi([{ id: 'my-model', maxTokens: 20000 }]);
  let out = doctorOut();
  assert.ok(out.split('\n').includes('warn   pi model my-provider/my-model: maxTokens 20000 leaves less than 8192 tokens over the high reasoning budget (16384); answers and tool calls get truncated. Set maxTokens to at least 24576'), out);
  // Counter-example: 32768 leaves more than 8192 over 16384.
  writePi([{ id: 'my-model', maxTokens: 32768 }]);
  out = doctorOut();
  assert.ok(!out.includes('leaves less than 8192'), out);
  // The boundary: exactly budget + 8192 is fine (strict <).
  writePi([{ id: 'my-model', maxTokens: 24576 }]);
  out = doctorOut();
  assert.ok(!out.includes('leaves less than 8192'), 'maxTokens == budget + 8192 needs no warn: ' + out);
  // The level is the effective effort.pi: low (budget 2048), not the
  // default high.
  writeProj('effort.pi=low\n');
  writePi([{ id: 'my-model', maxTokens: 10000 }]);
  out = doctorOut();
  assert.ok(out.split('\n').includes('warn   pi model my-provider/my-model: maxTokens 10000 leaves less than 8192 tokens over the low reasoning budget (2048); answers and tool calls get truncated. Set maxTokens to at least 10240'), out);
  // Counter-example: low with maxTokens 10240 (== 2048 + 8192).
  writePi([{ id: 'my-model', maxTokens: 10240 }]);
  out = doctorOut();
  assert.ok(!out.includes('leaves less than 8192'), out);
  // The budget comes from settings.json thinkingBudgets (kinds.md example:
  // 31744; 40960 leaves the room, 39000 does not). effort.pi back to
  // empty: the default level high reads the entry.
  fs.rmSync(PROJ_CONF, { force: true });
  writePi([{ id: 'my-model', maxTokens: 39000 }], { thinkingBudgets: { high: 31744 } });
  out = doctorOut();
  assert.ok(out.split('\n').includes('warn   pi model my-provider/my-model: maxTokens 39000 leaves less than 8192 tokens over the high reasoning budget (31744); answers and tool calls get truncated. Set maxTokens to at least 39936'), out);
  writePi([{ id: 'my-model', maxTokens: 40960 }], { thinkingBudgets: { high: 31744 } });
  out = doctorOut();
  assert.ok(!out.includes('leaves less than 8192'), out);
  // xhigh without a defined value: no check, whatever maxTokens.
  writeProj('effort.pi=xhigh\n');
  writePi([{ id: 'my-model', maxTokens: 100 }]);
  out = doctorOut();
  assert.ok(!out.includes('leaves less than 8192'), 'xhigh without a budget is not checked: ' + out);
  // No maxTokens: no check.
  writeProj('effort.pi=low\n');
  writePi([{ id: 'my-model' }]);
  out = doctorOut();
  assert.ok(!out.includes('leaves less than 8192'), out);
  rmOwnFiles();
  cleanLayers();
});

// Mutation captured: treating a missing thinking_token_budget as present
// (or reading the knob from the provider options) drops the warn line.
test('doctor: opencode model without thinking_token_budget warns; the ok line; nothing without a provider', () => {
  cleanLayers();
  rmOwnFiles();
  // Example: a model whose options lack the budget knob (the provider key
  // is a reference, so only the budget warn appears).
  fs.writeFileSync(OC_PROJECT_FILE, JSON.stringify({
    provider: { 'my-provider': { options: { apiKey: '{env:MY_API_KEY}' }, models: { 'my-model': {} } } },
  }));
  let out = doctorOut();
  assert.ok(out.split('\n').includes("warn   opencode model my-provider/my-model has no thinking_token_budget in its options; the skill's effort is dropped and the server default applies"), out);
  // Counter-example: with the knob (any number) the only declared own
  // provider is trap-free: the ok line, no warn.
  fs.writeFileSync(OC_PROJECT_FILE, JSON.stringify({
    provider: { 'my-provider': { options: { apiKey: '{env:MY_API_KEY}' }, models: { 'my-model': { options: { thinking_token_budget: 16000 } } } } },
  }));
  out = doctorOut();
  assert.ok(!out.includes('no thinking_token_budget'), out);
  assert.ok(!out.includes('literal apiKey'), out);
  assert.ok(out.split('\n').includes('ok     own providers: no known trap'), out);
  rmOwnFiles();
  // No own provider declared at all: no own-provider line at all.
  out = doctorOut();
  assert.ok(!out.includes('own provider'), out);
  cleanLayers();
});

// Mutation captured: interpolating the key value into the warn text (or
// printing it anywhere) leaks sk-test-secret into stdout or stderr.
test('doctor: the literal key value never appears on stdout/stderr', () => {
  cleanLayers();
  rmOwnFiles();
  fs.mkdirSync(path.dirname(PI_MODELS_FILE), { recursive: true });
  fs.writeFileSync(PI_MODELS_FILE, JSON.stringify({
    providers: { 'my-provider': { apiKey: 'sk-test-secret', models: [{ id: 'my-model', maxTokens: 20000 }] } },
  }));
  writeFakeCli(FAKES, 'herdr', 'process.exit(0);\n'); // no host herdr may be called
  const r = spawnSync(nodeBin(), [JS_ENTRY, 'doctor'], { cwd: REPO, env: { ...ENV, PATH: FAKES }, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`own provider 'my-provider' (pi) has a literal apiKey in ${PI_MODELS_FILE}`), r.stdout);
  assert.ok(!r.stdout.includes('sk-test-secret'), 'stdout leaks the key:\n' + r.stdout);
  assert.ok(!r.stderr.includes('sk-test-secret'), 'stderr leaks the key:\n' + r.stderr);
  rmOwnFiles();
  cleanLayers();
});

// Mutation captured: back to one key line per model (instead of one per
// provider) makes the counts below come out doubled.
test('doctor: the literal-key warn appears once per provider, not per model', () => {
  cleanLayers();
  rmOwnFiles();
  fs.mkdirSync(path.dirname(PI_MODELS_FILE), { recursive: true });
  // A pi provider with a literal key and two models (enough maxTokens:
  // only the key trap fires).
  fs.writeFileSync(PI_MODELS_FILE, JSON.stringify({
    providers: { 'my-provider': { apiKey: 'sk-test-secret', models: [
      { id: 'my-model', maxTokens: 32768 },
      { id: 'second-model', maxTokens: 32768 },
    ] } },
  }));
  let out = doctorOut();
  const keyLines = out.split('\n').filter((l) => l.startsWith('warn   own provider '));
  assert.equal(keyLines.length, 1, 'one key line for the provider:\n' + out);
  assert.ok(keyLines[0].includes(`own provider 'my-provider' (pi) has a literal apiKey in ${PI_MODELS_FILE}`), out);
  assert.ok(!out.split('\n').some((l) => l.startsWith('warn   pi model')), out);
  rmOwnFiles();
  // Same for opencode: one key line for the provider; the per-model budget
  // warns stay one per model.
  fs.writeFileSync(OC_PROJECT_FILE, JSON.stringify({
    provider: { 'my-provider': { options: { apiKey: 'sk-test-secret' }, models: { 'my-model': {}, 'second-model': {} } } },
  }));
  out = doctorOut();
  assert.equal(out.split('\n').filter((l) => l.startsWith('warn   own provider ')).length, 1, out);
  assert.equal(out.split('\n').filter((l) => l.startsWith('warn   opencode model ')).length, 2, 'the budget trap stays per-model:\n' + out);
  // Mutation captured: deduping on the full text (which names the file)
  // prints the same provider once per opencode file.
  const ocUser = path.join(CONF, 'opencode', 'opencode.json');
  fs.mkdirSync(path.dirname(ocUser), { recursive: true });
  fs.writeFileSync(ocUser, JSON.stringify({
    provider: { 'my-provider': { options: { apiKey: 'sk-test-secret' }, models: { 'user-model': {} } } },
  }));
  out = doctorOut();
  assert.equal(out.split('\n').filter((l) => l.startsWith('warn   own provider ')).length, 1, 'one key line across project and user files:\n' + out);
  fs.rmSync(ocUser, { force: true });
  // Mutation captured: cutting the provider id from the model id at the
  // first `/` merges `org/alpha` and `org/beta` into one provider.
  fs.writeFileSync(OC_PROJECT_FILE, JSON.stringify({
    provider: {
      'org/alpha': { options: { apiKey: 'sk-test-secret' }, models: { m1: {} } },
      'org/beta': { options: { apiKey: 'sk-test-secret' }, models: { m2: {} } },
    },
  }));
  out = doctorOut();
  assert.equal(out.split('\n').filter((l) => l.startsWith('warn   own provider ')).length, 2, 'two providers that share a prefix:\n' + out);
  rmOwnFiles();
  cleanLayers();
});

// Mutation captured: counting any thinking_token_budget value as a budget
// hides the trap for null or a numeric string.
test('doctor: a non-numeric thinking_token_budget is no budget', () => {
  cleanLayers();
  rmOwnFiles();
  for (const v of [null, '16000']) {
    fs.writeFileSync(OC_PROJECT_FILE, JSON.stringify({
      provider: { 'my-provider': { options: { apiKey: '{env:MY_API_KEY}' }, models: { 'my-model': { options: { thinking_token_budget: v } } } } },
    }));
    const out = doctorOut();
    assert.ok(out.includes('opencode model my-provider/my-model has no thinking_token_budget in its options'), `${JSON.stringify(v)}:\n${out}`);
  }
  fs.writeFileSync(OC_PROJECT_FILE, JSON.stringify({
    provider: { 'my-provider': { options: { apiKey: '{env:MY_API_KEY}' }, models: { 'my-model': { options: { thinking_token_budget: 16000 } } } } },
  }));
  assert.ok(!doctorOut().includes('has no thinking_token_budget'), 'a number is a budget');
  rmOwnFiles();
  cleanLayers();
});
