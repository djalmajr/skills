// The `collect` command (port slice 6a). Port of
// the original bash implementation :4004-4017: a ready report is printed under its
// `<!-- report: <path> -->` marker (rc 0); otherwise an unqueryable roster
// worker warns and exits 4 (no terminal fallback), and the rest falls back
// to `herdr agent read --source recent-unwrapped --lines <N>` (rc 6). The
// `${1:?agent}` parameter error is bash's builtin (exit 1, no friction
// entry), so it uses plain die, not dieFriction.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { die, runCli, projectRoot } from '../platform.mjs';
import { stateDir, rosterLine, lastReport, warn, dieFriction } from '../state.mjs';
import { agentState, HERDR_TIMEOUT_MS } from '../herdr.mjs';

// `done` requires the recorded report file to exist and be non-empty
// (bash `[ -s "$r" ]`), not just the path to be recorded.
function reportNonEmpty(p) {
  if (!p) return false;
  try { return fs.statSync(p).size > 0; } catch { return false; }
}

// The `shasum -a 256` output line: the 64-hex hash, then the path — the
// `*` of binary mode is allowed before the path. The pattern also counts
// inside code blocks on purpose: a report that lists its files is the
// common shape.
const SHA256_LINE_RE = /^\s*([0-9a-f]{64})\s+\*?(\S.*?)\s*$/;

// `--verify` on the agent's last report: one line per sha256 line
// (`ok`/`changed`/`missing`, the checked path — relative paths resolved
// against the worker's cwd, roster column 7; a relative cwd itself
// resolves against the project root, not against the collector's cwd) and
// the summary `verified <n>: ok <a>, changed <b>, missing <c>`. Returns 0
// when every file is ok, 16 when any changed or is missing; a report that
// exists but cannot be read is an error (`collect --verify: cannot read
// <report>`, exit 4); no sha256 lines prints `no sha256 lines in <report>`
// and returns 0.
function verifyReport(sd, agent, report, env = process.env, cwd = process.cwd()) {
  let text;
  try {
    text = fs.readFileSync(report, 'utf8');
  } catch {
    // A report that exists but cannot be read proves nothing: it is a
    // verify error, not a "no hash lines" success.
    dieFriction(`collect --verify: cannot read ${report}`, 4);
    return 4; // unreachable: dieFriction exits
  }
  // The checked files, keyed by the path as written: a repeated line for
  // the same path keeps the last hash.
  const files = new Map();
  for (const line of text.split('\n')) {
    const m = SHA256_LINE_RE.exec(line);
    if (!m) continue;
    files.set(m[2], m[1]);
  }
  if (files.size === 0) {
    process.stdout.write(`no sha256 lines in ${report}\n`);
    return 0;
  }
  // A relative worker cwd (spawn --cwd) resolves against the project root,
  // not against the cwd of the process running collect: the files the
  // worker touched live where the worker's sandbox sees them.
  const workerCwdRaw = rosterLine(sd, agent).split('\t')[6] ?? '';
  const workerCwd = path.isAbsolute(workerCwdRaw)
    ? workerCwdRaw
    : path.join(projectRoot(env, cwd), workerCwdRaw);
  let ok = 0;
  let changed = 0;
  let missing = 0;
  for (const [raw, hash] of files) {
    const p = path.isAbsolute(raw) ? raw : path.join(workerCwd, raw);
    let state;
    try {
      const h = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
      state = h === hash ? 'ok' : 'changed';
      if (state === 'ok') ok += 1; else changed += 1;
    } catch {
      state = 'missing';
      missing += 1;
    }
    process.stdout.write(`${state} ${p}\n`);
  }
  process.stdout.write(`verified ${ok + changed + missing}: ok ${ok}, changed ${changed}, missing ${missing}\n`);
  return changed + missing > 0 ? 16 : 0;
}

// `collect <agent> [--lines N] [--verify]` (default lines 120) → rc 0
// (report, or every verified file ok), 16 (a verified file changed or is
// missing), 4 (unavailable), 6 (fallback) — or herdr's own code when the
// fallback read fails (bash `set -e` passes it through).
export function cmdCollect(argv, ctx, env = process.env, cwd = process.cwd()) {
  const agent = argv[0];
  if (agent === undefined) die('agent: Parameter not set', 1);
  let lines = 120;
  let linesSet = false;
  let verify = false;
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--lines') {
      const v = argv[i + 1];
      if (v === undefined) dieFriction('collect: --lines expects a value', 2);
      lines = v;
      linesSet = true;
      i += 1;
    } else if (a === '--verify') {
      verify = true;
    } else {
      dieFriction(`collect: unknown option ${a}`, 2);
    }
  }
  const sd = stateDir(ctx, env, cwd);
  // D54: the original report under the tmp routing dir may be gone ($TMPDIR
  // is cleaned by the system): when the pointer path no longer exists and
  // the mirror the wait made sits at <state>/reports/<same name>, read that
  // copy (with --verify too — the sha lines check the project files, not
  // the report's location). No copy: today's behavior (the pointer stays,
  // the fallbacks run).
  let report = lastReport(sd, agent);
  if (report !== '' && !fs.existsSync(report)) {
    const copy = path.join(sd, 'reports', path.basename(report));
    if (fs.existsSync(copy)) report = copy;
  }
  if (report !== '' && reportNonEmpty(report)) {
    if (verify) return verifyReport(sd, agent, report, env, cwd);
    process.stdout.write(`<!-- report: ${report} -->\n`);
    process.stdout.write(fs.readFileSync(report, 'utf8')); // `cat`
    return 0;
  }
  if (rosterLine(sd, agent) !== '') {
    const st = agentState(agent, env);
    if (st.state === 'unavailable') {
      warn(`no report file yet for '${agent}', and herdr agent get failed: ${st.cause}. The worker may still be live.`);
      return 4;
    }
    // A worker still working (or blocked) has no report yet by definition:
    // a short status line plus the wait pointer, and no terminal dump —
    // the terminal only helps once the worker has stopped (the fallback
    // below keeps it for idle/done/gone and the not-in-roster cases). An
    // explicit --lines forces the terminal anyway.
    if ((st.state === 'working' || st.state === 'blocked') && !linesSet) {
      warn(`'${agent}' is ${st.state} and has no report yet (${report || '<none dispatched>'}); wait for it: herdr-agents wait ${agent}`);
      return 4;
    }
  }
  warn(`no report file yet for '${agent}' (expected ${report || '<none dispatched>'}); falling back to recent terminal output`);
  const r = runCli('herdr', ['agent', 'read', agent, '--source', 'recent-unwrapped', '--lines', String(lines)], { env, timeoutMs: HERDR_TIMEOUT_MS });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.notFound) die('herdr CLI not found in PATH', 2);
  if (r.status !== 0) return r.status ?? 1;
  return 6;
}
