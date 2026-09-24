// Parity (slice 4): lanes and quota, output by output — the bash script
// sourced with HERDR_AGENTS_LIB=1 (exactly like test-lanes.sh /
// test-quota.sh) versus the lib/*.mjs modules:
//   - lane_names / lane_of_role / max_workers over a config matrix
//     (presets 3/4, custom, env, hyphen in the lane name, lanes off,
//     explicit max_workers, empty lane roles, C-locale case order);
//   - quota_detect / renewal_value on every screen of the unit matrix
//     plus Bearer, api_key=, sk-proj- and JSON "message" lines;
//   - apply_lane_file on nine seed files: the final file byte for byte,
//     its final mode, the printed lines, the warnings, and no temporary
//     files left in the destination or TMPDIR. The Bash 0600 result and the
//     JS source-mode preservation are both asserted explicitly.
// The probes pin LC_ALL=C so the bash `sort -u` / grep collation runs in
// the C locale the brief defines for laneNames (code-unit order).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BASH_ENTRY, fixtureEnv, nodeBin, normalizeErr } from './parity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JSCONFIG = path.join(ROOT, 'lib', 'config.mjs');
const JSLANES = path.join(ROOT, 'lib', 'lanes.mjs');
const JSQUOTA = path.join(ROOT, 'lib', 'quota.mjs');
const ROLES = ['implementer', 'designer', 'tasker', 'scouter', 'researcher', 'reviewer', 'security-reviewer', 'ui-reviewer', 'inspector', 'sub-orchestrator'];

function mkFix(prefix) {
  let root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  root = fs.realpathSync(root);
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const conf = path.join(root, 'conf');
  const state = path.join(root, 'state');
  const tmp = path.join(root, 'tmp');
  for (const d of [repo, home, conf, state, tmp]) fs.mkdirSync(d, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
  const env = fixtureEnv({
    HOME: home,
    XDG_CONFIG_HOME: conf,
    HERDR_AGENTS_DIR: state,
    HERDR_WORKSPACE_ID: 'ws',
    TMPDIR: tmp,
    LC_ALL: 'C',
  });
  return {
    root, repo, conf, state, tmp, env,
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

function seed(fix, sc) {
  fs.rmSync(path.join(fix.repo, '.agents'), { recursive: true, force: true });
  if (sc.project !== undefined) {
    fs.mkdirSync(path.join(fix.repo, '.agents'), { recursive: true });
    if (sc.project !== null) fs.writeFileSync(path.join(fix.repo, '.agents', 'herdr-agents.conf'), sc.project);
  }
  fs.rmSync(path.join(fix.conf, 'herdr-agents'), { recursive: true, force: true });
  if (sc.user !== undefined) {
    fs.mkdirSync(path.join(fix.conf, 'herdr-agents'), { recursive: true });
    if (sc.user !== null) fs.writeFileSync(path.join(fix.conf, 'herdr-agents', 'config'), sc.user);
  }
}

// ---------- lane_names / lane_of_role / max_workers ----------

const LANES_BASH_PROBE = (bash) => `
set -u
export HERDR_AGENTS_LIB=1
. ${JSON.stringify(bash)}
load_config
# Every consumer skips blank lines; an empty lane name (lane..roles) prints one.
lane_names | grep . || true
for r in ${ROLES.join(' ')}; do
  l=$(lane_of_role "$r") || true
  [ -n "$l" ] || l=NONE
  printf 'ROLE %s %s\\n' "$r" "$l"
done
printf 'COUNT %s\\n' "$(lane_count)"
printf 'MAXWORKERS %s\\n' "$(max_workers)"
`;

const LANES_JS_PROBE = `
import { loadConfig } from ${JSON.stringify(pathToFileURL(JSCONFIG).href)};
import { laneNames, laneOfRole, laneCount, maxWorkers } from ${JSON.stringify(pathToFileURL(JSLANES).href)};
const env = process.env;
const ctx = loadConfig(env, process.cwd());
for (const n of laneNames(ctx, env)) console.log(n);
for (const r of ${JSON.stringify(ROLES)}) console.log(\`ROLE \${r} \${laneOfRole(ctx, r, env) || 'NONE'}\`);
console.log(\`COUNT \${laneCount(ctx, env)}\`);
console.log(\`MAXWORKERS \${maxWorkers(ctx, env)}\`);
`;

function lanesScenario(t, name, sc) {
  void t;
  const fix = mkFix(`ha-par-lanes-${name}-`);
  try {
    const results = [];
    for (const impl of ['bash', 'node']) {
      seed(fix, sc);
      const env = { ...fix.env, ...(sc.env ?? {}) };
      const probe = impl === 'bash' ? LANES_BASH_PROBE(BASH_ENTRY) : LANES_JS_PROBE;
      if (impl === 'bash') {
        const f = path.join(fix.root, 'probe.sh');
        fs.writeFileSync(f, probe);
        const r = spawnSync('bash', [f], { cwd: fix.repo, env, encoding: 'utf8' });
        results.push({ rc: r.status === null ? -1 : r.status, out: r.stdout ?? '', err: r.stderr ?? '' });
      } else {
        const f = path.join(fix.root, 'probe.mjs');
        fs.writeFileSync(f, probe);
        const r = spawnSync(nodeBin(), [f], { cwd: fix.repo, env, encoding: 'utf8' });
        results.push({ rc: r.status === null ? -1 : r.status, out: r.stdout ?? '', err: r.stderr ?? '' });
      }
    }
    assert.equal(results[1].rc, results[0].rc, `${name}: exit code (bash=${results[0].rc} node=${results[1].rc})`);
    assert.equal(results[1].out, results[0].out, `${name}: stdout (node output first)\nnode:\n${results[1].out}\nbash:\n${results[0].out}`);
    assert.equal(normalizeErr(results[1].err), normalizeErr(results[0].err), `${name}: stderr normalized`);
  } finally { fix.cleanup(); }
}

test('parity: lane_names / lane_of_role / max_workers matrix', { timeout: 120000 }, (t) => {
  lanesScenario(t, 'preset-4', {});
  lanesScenario(t, 'preset-3', { project: 'panes=3\n' });
  lanesScenario(t, 'preset-3-env', { env: { HERDR_AGENTS_PANES: '3' } });
  lanesScenario(t, 'custom-file', { project: 'panes=4\nlane.ops.roles=implementer,tasker\n' });
  lanesScenario(t, 'custom-env', { env: { HERDR_AGENTS_LANE_OPS_ROLES: 'implementer,tasker' } });
  lanesScenario(t, 'hyphen-file-key', { project: 'lane.ui-review.roles=ui-reviewer,inspector\n' });
  lanesScenario(t, 'hyphen-env-invisible', { env: { 'HERDR_AGENTS_LANE_UI-REVIEW_ROLES': 'ui-reviewer,inspector' } });
  lanesScenario(t, 'hyphen-env-plus-file', { project: 'lane.ui-review.roles=ui-reviewer,inspector\n', env: { 'HERDR_AGENTS_LANE_UI-REVIEW_ROLES': 'ui-reviewer,inspector' } });
  lanesScenario(t, 'mixed-file-env', { project: 'lane.a.roles=scouter\n', env: { HERDR_AGENTS_LANE_B_ROLES: 'researcher' } });
  lanesScenario(t, 'lanes-off', { env: { HERDR_AGENTS_LANES: 'off' } });
  lanesScenario(t, 'explicit-max', { project: 'max_workers=5\n' });
  lanesScenario(t, 'explicit-max-env', { env: { HERDR_AGENTS_MAX_WORKERS: '0' } });
  lanesScenario(t, 'empty-roles', { project: 'lane.empty.roles=\nlane.ops.roles=implementer\n', env: { HERDR_AGENTS_LANE_B_ROLES: 'researcher' } });
  lanesScenario(t, 'case-order', { project: 'lane.A.roles=reviewer\nlane.b.roles=scouter\n' });
  lanesScenario(t, 'user-layer', { user: 'panes=3\nlane.u.roles=implementer\n' });
  lanesScenario(t, 'user-and-project', { user: 'lane.u.roles=implementer\n', project: 'lane.p.roles=tasker\n' });
  // Bash word-splits a lane's roles: a space separates them like a comma.
  lanesScenario(t, 'space-separated-roles', { project: 'lane.x.roles=reviewer inspector\n' });
  lanesScenario(t, 'space-separated-env', { env: { HERDR_AGENTS_LANE_X_ROLES: 'scouter  researcher,reviewer' } });
  // `lane..roles`: an empty lane name is not counted.
  lanesScenario(t, 'empty-lane-name', { project: 'lane..roles=reviewer\nlane.y.roles=scouter\n' });
});

// ---------- quota_detect / renewal_value ----------

const QUOTA_CASES = [
  ['idle', 'You have hit your usage limit for grok', 'Resets at 5:00pm'],
  ['idle', 'Individual quota reached', 'Resets at 5:00pm'],
  ['idle', 'Error: quota exceeded', ''],
  ['idle', 'RESOURCE_EXHAUSTED: project', ''],
  ['idle', '429 Too Many Requests', 'retry after 5 minutes'],
  ['idle', 'rate limit exceeded, retry later', ''],
  ["idle", "You've hit your limit for today", ''],
  ['idle', 'You exceeded your current quota, please check your plan and billing details.', ''],
  ['idle', 'You have reached your API usage limits: monthly threshold', ''],
  ["idle", "You've reached your API usage limits", ''],
  ['done', 'INDIVIDUAL QUOTA REACHED', ''],
  ['idle', 'implement a rate limit for the API client', ''],
  ['idle', 'return "rate limit"', ''],
  ['idle', 'return "rate limit exceeded"', ''],
  ['idle', '// 429 Too Many Requests', ''],
  ['idle', '# quota exceeded', ''],
  ['idle', '/* RESOURCE_EXHAUSTED */', ''],
  ['idle', 'func Limit() { quota exceeded }', ''],
  ['idle', 'function check() { quota exceeded }', ''],
  ['idle', 'msg = "quota exceeded"', ''],
  ['idle', '"rate limit exceeded"', ''],
  ["idle", "You've hit your stride", ''],
  ['working', '429 Too Many Requests', ''],
  ['working', 'hit your usage limit', ''],
  ['idle', '', ''],
  ['idle', 'Individual quota reached token=sk_live_abcdefghij\nResets at 5:00pm', 'Resets at 5:00pm'],
  ['idle', 'Bearer abc123.~+/ and hit your usage limit', ''],
  ['idle', 'api_key=sk-proj-abcdefgh1234 quota exceeded', ''],
  ['idle', 'key sk-proj-abcdefgh1234 rate limit exceeded', ''],
  ['idle', '{"message":"rate limit exceeded"}', ''],
  ['idle', '{"error":"quota exceeded"}', ''],
  ['idle', '{"error":{"code":"insufficient_quota","message":"rate limit exceeded"}}', ''],
  ['idle', 'hit your usage limit\r\nResets at 10:00\r\n', 'Resets at 10:00'],
  ['idle', 'resets at 10:00', '10:00'],
  ['idle', 'available again on 2026-09-24', '2026-09-24'],
  ['idle', 'quota exceeded, resets at 5:00pm', '5:00pm'],
  ['idle', '2026-09-24 14:30', ''],
  ['idle', 'in 5 minutes at 14:30', ''],
  ['idle', 'nothing usable here', ''],
];

const RENEWAL_LINES = [
  'Resets at 5:00pm',
  'Resets at 09:15:00',
  'Resets at 2:30PM.',
  'Resets at 2:30P.M.',
  'resets on 2026-09-24 at noon',
  'try again in 5 minutes',
  'retry after 2 hours',
  'quota exceeded, resets at 5:00pm',
  '2026-09-24 14:30',
  'in 5 minutes at 14:30',
  'nothing usable here',
  '',
];

const QUOTA_BASH_PROBE = (bash) => `
set -u
export HERDR_AGENTS_LIB=1
. ${JSON.stringify(bash)}
while IFS=$'\\t' read -r i st rl; do
  screen=$(cat "s-$i")
  if out=$(quota_detect "$st" "$screen"); then
    printf 'CASE %s\\nDETECT\\n%s\\n' "$i" "$out"
  else
    printf 'CASE %s\\nNOMATCH\\n' "$i"
  fi
  printf 'RENEWAL [%s]\\n' "$(renewal_value "$rl")"
done < manifest.tsv
`;

const QUOTA_JS_PROBE = `
import fs from 'node:fs';
import { quotaDetect, renewalValue } from ${JSON.stringify(pathToFileURL(JSQUOTA).href)};
for (const line of fs.readFileSync('manifest.tsv', 'utf8').split('\\n').filter(Boolean)) {
  const [i, st, rl] = line.split('\\t');
  const screen = fs.readFileSync(\`s-\${i}\`, 'utf8');
  const out = quotaDetect(st, screen);
  console.log(\`CASE \${i}\`);
  // Bash command substitution strips trailing newlines; print one line back.
  const text = out ? out.join('\\n').replace(/\\n+$/, '') : '';
  if (out) { console.log('DETECT'); console.log(text); } else console.log('NOMATCH');
  console.log(\`RENEWAL [\${renewalValue(rl)}]\`);
}
`;

function seedQuota(fix) {
  const man = [];
  QUOTA_CASES.forEach(([st, screen], idx) => {
    const i = String(idx + 1).padStart(3, '0');
    fs.writeFileSync(path.join(fix.root, `s-${i}`), screen);
    man.push(`${i}\t${st}\t${RENEWAL_LINES[idx % RENEWAL_LINES.length]}`);
  });
  // The renewal_value lines get their own cases with an empty screen.
  RENEWAL_LINES.forEach((rl, idx) => {
    const i = String(QUOTA_CASES.length + idx + 1).padStart(3, '0');
    fs.writeFileSync(path.join(fix.root, `s-${i}`), '');
    man.push(`${i}\tidle\t${rl}`);
  });
  fs.writeFileSync(path.join(fix.root, 'manifest.tsv'), man.join('\n') + '\n');
}

test('parity: quota_detect / renewal_value (all unit screens + Bearer/api_key/sk-proj/JSON/CRLF)', { timeout: 120000 }, () => {
  const fix = mkFix('ha-par-quota-');
  try {
    const results = [];
    for (const impl of ['bash', 'node']) {
      seedQuota(fix);
      const probe = impl === 'bash' ? QUOTA_BASH_PROBE(BASH_ENTRY) : QUOTA_JS_PROBE;
      const f = path.join(fix.root, impl === 'bash' ? 'probe.sh' : 'probe.mjs');
      fs.writeFileSync(f, probe);
      const r = impl === 'bash'
        ? spawnSync('bash', [f], { cwd: fix.root, env: fix.env, encoding: 'utf8' })
        : spawnSync(nodeBin(), [f], { cwd: fix.root, env: fix.env, encoding: 'utf8' });
      results.push({ rc: r.status === null ? -1 : r.status, out: r.stdout ?? '', err: r.stderr ?? '' });
    }
    assert.equal(results[1].rc, results[0].rc, `exit code (bash=${results[0].rc} node=${results[1].rc})\nnode stderr:\n${results[1].err}\nbash stderr:\n${results[0].err}`);
    assert.equal(results[1].out, results[0].out, `stdout (node output first)\nnode:\n${results[1].out}\nbash:\n${results[0].out}`);
    assert.equal(normalizeErr(results[1].err), normalizeErr(results[0].err), 'stderr normalized');
  } finally { fix.cleanup(); }
});

// ---------- apply_lane_file ----------

const APPLY_CASES = [
  { name: 'empty', panes: '4', file: null },
  { name: 'preset3-to-4', panes: '4', file: 'lane.build.roles=implementer,designer,tasker\nlane.read.roles=scouter,researcher,reviewer,security-reviewer,ui-reviewer,inspector\n' },
  { name: 'preset4-to-3', panes: '3', file: 'lane.build.roles=implementer,designer,tasker\nlane.explore.roles=scouter,researcher\nlane.review.roles=reviewer,security-reviewer,ui-reviewer,inspector\n' },
  { name: 'custom', panes: '4', file: 'lane.ops.roles=implementer,tasker\n' },
  { name: 'unanimous-kind', panes: '4', file: 'role.implementer.kind=grok\nrole.designer.kind=grok\nrole.tasker.kind=grok\n' },
  { name: 'divergent-kind', panes: '4', file: 'role.implementer.kind=grok\nrole.designer.kind=agy\n' },
  { name: 'planner-keys', panes: '4', file: 'role.planner.kind=codex\nrole.planner.model=gpt-5\nrole.implementer.kind=grok\nrole.designer.kind=grok\nrole.tasker.kind=grok\n' },
  { name: 'existing-lane-kind', panes: '4', file: 'lane.build.kind=codex\nrole.implementer.kind=grok\nrole.designer.kind=grok\nrole.tasker.kind=grok\n' },
  { name: 'unanimous-model', panes: '4', file: 'lane.build.kind=agy\nrole.implementer.model=m1\nrole.designer.model=m1\nrole.tasker.model=m1\n' },
  { name: 'custom-space-roles', panes: '4', file: 'lane.x.roles=implementer designer\nrole.implementer.kind=grok\nrole.designer.kind=grok\n' },
];

const APPLY_BASH_PROBE = (bash) => `
set -u
export HERDR_AGENTS_LIB=1
. ${JSON.stringify(bash)}
load_config
out=$(apply_lane_file "$HA_DEST" "$HA_PANES")
printf '%s\\n' "$out"
`;

const APPLY_JS_PROBE = `
import { applyLaneFile } from ${JSON.stringify(pathToFileURL(JSLANES).href)};
const lines = applyLaneFile(process.env.HA_DEST, process.env.HA_PANES, process.env, process.cwd());
console.log(lines.join('\\n'));
`;

function applyScenario(t, name, sc) {
  void t;
  const fix = mkFix(`ha-par-apply-${name}-`);
  try {
    const dest = path.join(fix.root, 'dest', 'herdr-agents.conf');
    const modeProbe = path.join(fix.root, 'mode-probe');
    fs.writeFileSync(modeProbe, '');
    const freshMode = fs.statSync(modeProbe).mode & 0o777;
    fs.rmSync(modeProbe);
    const inputMode = sc.file === null ? freshMode : 0o640;
    const run = (impl) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (sc.file !== null) {
        fs.writeFileSync(dest, sc.file);
        if (process.platform !== 'win32') fs.chmodSync(dest, inputMode);
      }
      else fs.rmSync(dest, { force: true });
      const env = { ...fix.env, HA_DEST: dest, HA_PANES: sc.panes };
      const probe = impl === 'bash' ? APPLY_BASH_PROBE(BASH_ENTRY) : APPLY_JS_PROBE;
      const f = path.join(fix.root, impl === 'bash' ? 'probe.sh' : 'probe.mjs');
      fs.writeFileSync(f, probe);
      const r = impl === 'bash'
        ? spawnSync('bash', [f], { cwd: fix.repo, env, encoding: 'utf8' })
        : spawnSync(nodeBin(), [f], { cwd: fix.repo, env, encoding: 'utf8' });
      return {
        rc: r.status === null ? -1 : r.status,
        out: r.stdout ?? '',
        err: r.stderr ?? '',
        file: (() => { try { return fs.readFileSync(dest, 'utf8'); } catch { return null; } })(),
        mode: (() => { try { return fs.statSync(dest).mode & 0o777; } catch { return null; } })(),
        temps: [...new Set([path.dirname(dest), fix.tmp].flatMap((dir) => fs.readdirSync(dir)
          .filter((n) => n.startsWith('herdr-agents-conf.') || (n.startsWith('.herdr-agents.conf.') && n.endsWith('.tmp')))
          .map((n) => path.join(dir, n))))].sort(),
      };
    };
    const bashR = run('bash');
    const nodeR = run('node');
    assert.equal(nodeR.rc, bashR.rc, `${name}: exit code (bash=${bashR.rc} node=${nodeR.rc})`);
    assert.equal(nodeR.out, bashR.out, `${name}: printed lines (node first)\nnode:\n${nodeR.out}\nbash:\n${bashR.out}`);
    assert.equal(normalizeErr(nodeR.err), normalizeErr(bashR.err), `${name}: warnings normalized\nnode:\n${nodeR.err}\nbash:\n${bashR.err}`);
    assert.equal(nodeR.file, bashR.file, `${name}: final file (node first)\nnode:\n${nodeR.file}\nbash:\n${bashR.file}`);
    assert.deepEqual(nodeR.temps, bashR.temps, `${name}: leftover temporary files`);
    assert.deepEqual(nodeR.temps, [], `${name}: Node left a temporary file`);
    assert.deepEqual(bashR.temps, [], `${name}: Bash left a temporary file`);
    if (process.platform !== 'win32') {
      // Bash's mktemp + mv ends at 0600; the JS atomic writer preserves the
      // source mode (or the process umask mode for a newly created file).
      assert.equal(bashR.mode, 0o600, `${name}: Bash final mode`);
      assert.equal(nodeR.mode, inputMode, `${name}: JS final mode`);
    }
  } finally { fix.cleanup(); }
}

test('parity: apply_lane_file (nine seeds: bytes, modes, printed lines, warnings, no temps)', { timeout: 180000 }, (t) => {
  for (const sc of APPLY_CASES) applyScenario(t, sc.name, sc);
});

// ---------- setup_lane_spec ----------

const SPECS = ['build=codex', 'build=codex:gpt-6:high', 'x=claude:m:high::', 'x=claude:::',
  'x=claude:m:high:e:', 'x=claude\n:m', 'build', 'Build=codex', 'build=nope', 'build=codex:m:huge', 'build=codex:g#x'];

test('parity: setup_lane_spec over valid and rejected specs', { timeout: 120000 }, () => {
  const fix = mkFix('ha-par-spec-');
  try {
    for (const spec of SPECS) {
      const bash = spawnSync('bash', ['-c', `export HERDR_AGENTS_LIB=1; . ${JSON.stringify(BASH_ENTRY)}; load_config; setup_lane_spec "$1"`, 'probe', spec],
        { cwd: fix.repo, env: fix.env, encoding: 'utf8' });
      const js = spawnSync(nodeBin(), ['--input-type=module', '-e', `
import { setupLaneSpec } from ${JSON.stringify(pathToFileURL(JSLANES).href)};
try {
  const r = setupLaneSpec(process.argv[1]);
  process.stdout.write([r.name, r.kind, r.model, r.effort].join('\\t') + '\\n');
} catch (e) { process.stderr.write('herdr-agents: ' + e.message + '\\n'); process.exit(e.code); }
`, spec], { cwd: fix.repo, env: fix.env, encoding: 'utf8' });
      assert.equal(js.status, bash.status, `${JSON.stringify(spec)}: exit code (bash=${bash.status} node=${js.status} ${js.stderr})`);
      assert.equal(js.stdout, bash.stdout, `${JSON.stringify(spec)}: stdout`);
      assert.equal(normalizeErr(js.stderr), normalizeErr(bash.stderr), `${JSON.stringify(spec)}: stderr`);
    }
  } finally { fix.cleanup(); }
});
