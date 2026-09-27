// The `setup` command (bash port): write the marked
// "Multi-agent workflow (herdr-agents)" block into the project's canonical
// instruction file, merge the two Claude Code hooks into
// .claude/settings.json, apply `--panes`/`--lane` to the project config and
// keep the state dir git-ignored. Port of the original bash implementation
// :1836-1972 (setup_block / setup_target_existing / setup_block_result /
// setup_write_block / setup_hook_* / settings_hooks_result /
// setup_write_hooks), :2181-2214 (project_needs_config_prompt) and
// :2614-2719 (cmd_setup). The pure texts and merge live in lib/setuptext.mjs;
// this module owns the disk and the die messages. `--detect` lives in
// lib/commands/setup-detect.mjs and writes nothing; `--plan` lives in
// lib/commands/setup-plan.mjs and simulates the writes; `--probe` lives in
// lib/commands/setup-probe.mjs and runs the per-kind probes.
import fs from 'node:fs';
import path from 'node:path';
import { DieError, cfg, configWritePair, configFileFor, stateRoot } from '../config.mjs';
import { homeDir, projectRoot, readTextFile, atomicWrite } from '../platform.mjs';
import { warn } from '../state.mjs';
import { applyLaneFile, setupLaneSpec } from '../lanes.mjs';
import { SETUP_START, setupBlock, setupBlockResult, settingsHooksResult } from '../setuptext.mjs';
import {
  ensureLocalExcludes, localRels, localTarget, planLocalExcludes,
  preflightLocalExcludes, refuseTrackedLocal, refuseUnignorableStateDir, resolveSetupMode, stateDirShown,
} from '../setuplocal.mjs';
import { cmdSetupDetect } from './setup-detect.mjs';
import { cmdSetupPlan } from './setup-plan.mjs';
import { cmdSetupProbe } from './setup-probe.mjs';

// `[ -f ]` port: regular file, symlinks followed; false when unreadable.
function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// `[ ! -L ]` port: the path itself is a symlink.
function isSymlink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

// setup_target_existing <root>: the instruction file that already carries
// the block, if any (AGENTS.md first, then CLAUDE.md), else null.
export function setupTargetExisting(root) {
  for (const f of [path.join(root, 'AGENTS.md'), path.join(root, 'CLAUDE.md')]) {
    if (!isFile(f)) continue;
    try { if (readTextFile(f).includes(SETUP_START)) return f; } catch { /* unreadable */ }
  }
  return null;
}

// setup_write_block <file>: replace the block between the markers, or append
// it (atomicWrite, next to the target); returns the printed verb
// (written|updated). DieError 4 when the result would be incomplete (file
// left untouched), like bash setup_write_block.
export function setupWriteBlock(file) {
  let content = null;
  try { content = readTextFile(file); } catch { /* absent */ }
  const had = content !== null && content.includes(SETUP_START);
  const result = setupBlockResult(content);
  if (result === null) throw new DieError(`setup: produced an incomplete file for ${file} (file left untouched)`, 4);
  atomicWrite(file, result);
  return had ? 'updated' : 'written';
}

// setup_write_hooks <file>: merge the UserPromptSubmit reminder and the
// SessionStart doctor into the settings.json (mkdir -p of the directory);
// DieError 4 when the merge cannot be produced (file left untouched).
export function setupWriteHooks(file) {
  let content = null;
  try { content = readTextFile(file); } catch { /* absent */ }
  const merged = settingsHooksResult(content);
  if (merged === null) throw new DieError(`could not merge hooks into ${file}`, 4);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, merged);
}

// project_needs_config_prompt <file>: true when the orchestrator must still
// ask the user — the project file is absent or sets neither multi_role, any
// lane.<name>.kind, nor any role.<role>.kind (max_workers alone is not that
// choice). Inline comments are cut at a `#` preceded by whitespace, like
// the bash awk.
export function projectNeedsConfigPrompt(file) {
  let raw;
  try { raw = readTextFile(file); } catch { return true; }
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.replace(/[ \t]#.*$/, '').trim();
    if (line === '' || line.startsWith('#')) continue;
    if (/^multi_role=/.test(line) || /^role\.[A-Za-z0-9_-]+\.kind=/.test(line) || /^lane\.[A-Za-z0-9_-]+\.kind=/.test(line)) return false;
  }
  return true;
}

// The hooks write both modes share (same lines as the canonical path
// below): merge into .claude/settings.json and resolve the launcher for
// the SessionStart doctor.
function writeHooksSection(root, env) {
  const sj = path.join(root, '.claude', 'settings.json');
  setupWriteHooks(sj);
  process.stdout.write(`hooks written: ${sj} (UserPromptSubmit reminder, SessionStart doctor)\n`);
  let hookScript = '';
  for (const candidate of [
    path.join(root, '.agents', 'skills', 'herdr-agents', 'scripts', 'herdr-agents'),
    path.join(root, '.claude', 'skills', 'herdr-agents', 'scripts', 'herdr-agents'),
    path.join(homeDir(process.platform, env), '.agents', 'skills', 'herdr-agents', 'scripts', 'herdr-agents'),
    path.join(homeDir(process.platform, env), '.claude', 'skills', 'herdr-agents', 'scripts', 'herdr-agents'),
  ]) if (isFile(candidate)) { hookScript = candidate; break; }
  if (hookScript === '') warn("SessionStart hook cannot resolve herdr-agents; install the skill under the project's or user's .agents/skills or .claude/skills directory");
}

// cmd_setup (bash :2614-2719). --detect runs the pure detect JSON (7b) and
// returns without writing, like the bash. --plan simulates the writes
// (7c, cmdSetupPlan). --probe runs the per-kind probes (8b,
// cmdSetupProbe); the two forms are exclusive (the bash die 2). DieError
// carries the bash die 2/4 messages; the entry turns it into the
// `herdr-agents: <msg>` stderr line and the exit code.
export function cmdSetup(args, ctx, env, cwd = process.cwd()) {
  let wantProbe = 0;
  let wantPlan = 0;
  for (const a of args) {
    if (a === '--probe') wantProbe = 1;
    else if (a === '--plan') wantPlan = 1;
  }
  if (wantProbe === 1 && wantPlan === 1) throw new DieError('setup: --probe and --plan are exclusive', 2);
  if (wantProbe === 1) {
    // bash: strip every --probe and run cmd_setup_probe with the rest —
    // the probe needs no Herdr environment and opens no state.
    const rest = [];
    for (const a of args) if (a !== '--probe') rest.push(a);
    cmdSetupProbe(rest, ctx, env, cwd);
    return;
  }
  if (wantPlan === 1) {
    // bash: strip every --plan and run cmd_setup_plan with the rest — the
    // simulation writes nothing.
    const rest = [];
    for (const a of args) if (a !== '--plan') rest.push(a);
    cmdSetupPlan(rest, ctx, env, cwd);
    return;
  }

  const root = projectRoot(env, cwd);
  let target = '';
  let hooks = 1;
  let dry = 0;
  let detect = 0;
  let local = 0;
  let panes = '';
  const laneSpecs = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--target' || a === '--panes' || a === '--lane') {
      // need_value "setup" "$@": no next word, or the next word is a flag.
      if (i + 1 >= args.length || args[i + 1].startsWith('--')) throw new DieError(`setup: ${a} expects a value`, 2);
      const v = args[++i];
      if (a === '--target') target = v;
      else if (a === '--panes') panes = v;
      else laneSpecs.push(v);
    } else if (a === '--no-hooks') hooks = 0;
    else if (a === '--dry-run') dry = 1;
    else if (a === '--local') local = 1;
    else if (a === '--detect') detect = 1;
    else throw new DieError(`setup: unknown option '${a}'`, 2);
  }
  if (detect === 1) {
    // bash: cmd_setup_detect; return 0 — the detect JSON only, no writes,
    // regardless of the other flags already parsed.
    cmdSetupDetect(ctx, env, cwd);
    return;
  }
  // Local mode (R28/D71): --local wins over setup_target=local, an explicit
  // --target wins over both, and --local with --target dies 2 here — before
  // any write, including the panes config below.
  const mode = resolveSetupMode({ local: local === 1, target, ctx, env, cmd: 'setup' });
  const localFile = mode === 'local' ? localTarget(root) : '';
  // Local preflight before any mutation or output: a symlinked
  // CLAUDE.local.md would write through onto tracked CLAUDE.md, and the
  // exclude preflight (unsafe state-dir name, unresolvable, symlinked or
  // ancestor-redirected exclude, unreadable-or-directory exclude,
  // unwritable exclude destination) dies 4 here. dry-run passes read-only
  // (no active write probe): like plan, it must stay write-free.
  if (mode === 'local') {
    // An unignorable state dir — a work tree root (current or a sibling
    // work tree, including `.` and `sub/..` spellings) or a path with a
    // symlink component below the matched work tree root (loop/cache
    // through an in-repo symlink, a final symlink to an in-repo target)
    // — dies 4 here, before the CLAUDE.local.md check and any mutation or
    // output (R28 review P2).
    refuseUnignorableStateDir(root, ctx, env, cwd, 'setup');
    refuseTrackedLocal(root, env, 'setup');
    preflightLocalExcludes(root, localRels(root, ctx, env, cwd), env, 'setup', dry === 0);
  }

  if (target === '') {
    target = setupTargetExisting(root) ?? '';
    if (target === '') {
      if (isFile(path.join(root, 'AGENTS.md'))) target = path.join(root, 'AGENTS.md');
      else if (isFile(path.join(root, 'CLAUDE.md')) && !isSymlink(path.join(root, 'CLAUDE.md'))) target = path.join(root, 'CLAUDE.md');
      else target = path.join(root, 'AGENTS.md');
    }
  }
  if (!path.isAbsolute(target)) target = root + '/' + target;

  if (panes !== '' && panes !== '2' && panes !== '3' && panes !== '4') throw new DieError('setup: --panes must be 2, 3 or 4', 2);
  // Parse/validate every --lane spec up front (R28 review P3): a bad kind
  // is a usage error (die 2) and must not surface only after the local
  // exclude, block and hooks writes — or, in canonical mode, after the
  // partial applyLaneFile preset write. Parsed once here and reused by the
  // preset write below, so the successful behavior of both modes is
  // unchanged.
  const lanes = laneSpecs.map(setupLaneSpec);
  const conf = configFileFor('project', env, cwd);
  // The tracked project-config write of the --panes/--lane preset. In local
  // mode the call site moves to the end of the command (after the local
  // exclude, block and hooks writes that may still die 4), so a late final
  // exclude failure leaves the tracked config byte-identical (R28 review
  // P2); canonical mode keeps writing the preset here, in the same place
  // as before.
  const applyPanesPreset = () => {
    fs.mkdirSync(path.dirname(conf), { recursive: true });
    for (const line of applyLaneFile(conf, panes, env, cwd)) process.stdout.write(`${line}\n`);
    for (const p of lanes) {
      configWritePair(conf, `lane.${p.name}.kind`, p.kind, env);
      process.stdout.write(`set lane.${p.name}.kind=${p.kind}\n`);
      if (p.model !== '') {
        configWritePair(conf, `lane.${p.name}.model`, p.model, env);
        process.stdout.write(`set lane.${p.name}.model=${p.model}\n`);
      }
      if (p.effort !== '') {
        configWritePair(conf, `lane.${p.name}.effort`, p.effort, env);
        process.stdout.write(`set lane.${p.name}.effort=${p.effort}\n`);
      }
    }
  };
  if (panes !== '') {
    if (dry === 1) {
      process.stdout.write(`# would set panes=${panes} and the preset lanes in ${conf}\n`);
      for (const spec of laneSpecs) process.stdout.write(`# would apply --lane ${spec}\n`);
    } else if (mode !== 'local') {
      applyPanesPreset();
    }
  }
  if (dry === 1) {
    process.stdout.write(`# would write to ${mode === 'local' ? localFile : target}\n`);
    process.stdout.write(setupBlock());
    if (hooks === 1) process.stdout.write(`\n# would merge into ${root}/.claude/settings.json: UserPromptSubmit + SessionStart hooks\n`);
    if (mode === 'local') {
      const planned = planLocalExcludes(root, localRels(root, ctx, env, cwd), env, 'setup');
      if (planned && planned.path !== '' && planned.added.length > 0) {
        process.stdout.write(`# would ensure ${planned.path} ignores: ${planned.added.join(', ')}\n`);
      }
    }
    return;
  }
  if (mode === 'local') {
    // Local mode never touches AGENTS.md, CLAUDE.md or the tracked
    // .gitignore: the block goes to CLAUDE.local.md and the unversioned
    // state rides the repo-local info/exclude (written above the block,
    // so an exclude failure dies before the instruction write).
    const rels = localRels(root, ctx, env, cwd);
    const ensured = ensureLocalExcludes(root, rels, env, 'setup');
    process.stdout.write(`block ${setupWriteBlock(localFile)}: ${localFile}\n`);
    if (ensured.added.length > 0) process.stdout.write(`local excludes updated: ${ensured.path} (${ensured.added.join(', ')})\n`);
    if (hooks === 1) writeHooksSection(root, env);
    // The tracked config is the last write in local mode: the exclude,
    // block and hooks writes above may still die 4, and their refusal must
    // leave the tracked project config byte-identical (R28 review P2).
    if (panes !== '') applyPanesPreset();
    // Outside a work tree ensureLocalExcludes installs nothing (path ''),
    // so never claim the state dir is ignored there — it would not survive
    // a later `git init`.
    // The status line names the effective state dir ($HERDR_AGENTS_DIR else
    // cfg state_dir), never the default when an override is in force — an
    // override to cache/ must not report `.herdr-agents/` (R28 review P3).
    // stateDirShown keeps the default message byte-for-byte, and the
    // canonical mode below keeps its own pre-existing line. A state dir
    // outside the repo gets no repository Git exclusion at all, so it is
    // reported as outside, never as ignored (R28 review P3) — rels.length >
    // 1 is exactly "the state dir lives under the root" (localRels).
    const stateShown = stateDirShown(root, ctx, env, cwd);
    if (ensured.path === '') process.stdout.write(`state dir not ignored: outside a git work tree, no git exclusion was installed for ${stateShown}\n`);
    else if (rels.length > 1) process.stdout.write(`state dir ignored: ${stateShown}\n`);
    else process.stdout.write(`state dir outside the repository: ${stateShown} (no repository Git exclusion is needed)\n`);
    process.stdout.write('note: only Claude Code reads CLAUDE.local.md and runs the hooks; Codex, Grok, Cursor and agy need a separate local instruction route.\n');
    if (projectNeedsConfigPrompt(conf)) {
      // Local target kept in the guided follow-up: canonical `setup
      // --panes` would write the upstream's tracked instruction file.
      warn(`project config ${conf} sets neither multi_role, any lane.<name>.kind, nor any role.<role>.kind. max_workers alone is not that choice. Orchestrator: run 'setup --detect', ask the user in their language how many agents at once (4 recommended, 3, or 2) and which detected assistant should implement, review, and research — do not say lane, kind, or panes to them — then run 'setup --local --panes 2|3|4 [--lane name=kind:model:effort]'. If doctor reports a missing or legacy config, finish with 'doctor --fix --panes 2|3|4'.`);
    }
    return;
  }
  process.stdout.write(`block ${setupWriteBlock(target)}: ${target}\n`);
  const claude = path.join(root, 'CLAUDE.md');
  if (isFile(claude) && !isSymlink(claude) && target !== claude) {
    let hasBlock = false;
    try { hasBlock = readTextFile(claude).includes(SETUP_START); } catch { /* unreadable */ }
    if (!hasBlock) warn("CLAUDE.md exists separately and has no block: run 'setup --target CLAUDE.md' too, or make CLAUDE.md a symlink to AGENTS.md");
  }
  if (hooks === 1) writeHooksSection(root, env);
  stateRoot(ctx, env, cwd);
  process.stdout.write(`state dir ignored: ${cfg(ctx, 'state_dir', '.herdr-agents', env)}/\n`);
  process.stdout.write('note: Codex, Grok, Cursor and agy read the instruction file; only Claude Code runs the hooks.\n');
  if (projectNeedsConfigPrompt(conf)) {
    warn(`project config ${conf} sets neither multi_role, any lane.<name>.kind, nor any role.<role>.kind. max_workers alone is not that choice. Orchestrator: run 'setup --detect', ask the user in their language how many agents at once (4 recommended, 3, or 2) and which detected assistant should implement, review, and research — do not say lane, kind, or panes to them — then run 'setup --panes 2|3|4 [--lane name=kind:model:effort]'. If doctor reports a missing or legacy config, finish with 'doctor --fix --panes 2|3|4'.`);
  }
}
