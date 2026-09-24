// `env` command — the environment block for a feedback issue (port of bash
// `cmd_env`, :732-745). Same lines in the same order; the decided change:
// the `bash: … · jq: …` line becomes `runtime: node <version>` or
// `runtime: bun <version>` (jq is no longer a requirement, orchestrator
// decision 5; the runtime is the one executing the script). All external
// calls go through runCli with a 10 s timeout, like the bash
// `timeout 10 <exe> --version`. Never requires the Herdr environment
// (bash `main` does not call require_env for `env`).
import os from 'node:os';
import { cfg, KNOWN_KINDS, skillDir } from '../config.mjs';
import { kindExe } from '../kinds.mjs';
import { findExecutable, runCli } from '../platform.mjs';

// bash `timeout 10 <exe> --version`.
const VERSION_TIMEOUT_MS = 10000;

// bash `$(cmd 2>/dev/null || echo X)`: on success the stdout with the
// trailing newlines command substitution strips; on any failure (not on
// PATH, non-zero exit, timeout) the fallback.
function versionOr(r, fallback) {
  if (r.notFound || r.timedOut || r.error || r.status !== 0) return fallback;
  return (r.stdout ?? '').replace(/\n+$/, '');
}

// bash `$(timeout 10 <exe> --version 2>/dev/null | head -n1 || echo '?')`:
// the first stdout line on success, `?` on failure. (The bash quirk of
// printing the first line AND `?` when a CLI fails after printing is a
// defect; the decision is a single `?` on failure.)
function kindVersion(r) {
  if (r.notFound || r.timedOut || r.error || r.status !== 0) return '?';
  return (r.stdout ?? '').split('\n')[0];
}

// The `runtime:` line: node <version> under Node, bun <version> under Bun
// (process.versions.bun is set only by Bun).
function runtimeLine() {
  return process.versions.bun
    ? `runtime: bun ${process.versions.bun}`
    : `runtime: node ${process.versions.node}`;
}

export function cmdEnv(ctx, env = process.env) {
  const lines = [];
  const git = runCli('git', ['-C', skillDir(), 'log', '-1', '--format=%h %cs'],
    { env, timeoutMs: VERSION_TIMEOUT_MS });
  lines.push(`herdr-agents: ${versionOr(git, 'unversioned')}`);
  const herdr = runCli('herdr', ['--version'], { env, timeoutMs: VERSION_TIMEOUT_MS });
  lines.push(`herdr: ${versionOr(herdr, 'unknown')}`);
  // bash: `uname -s`, `uname -r`, `uname -m` (spec section 6).
  lines.push(`os: ${os.type()} ${os.release()} (${os.machine()})`);
  lines.push(runtimeLine());
  for (const k of KNOWN_KINDS) {
    const exe = kindExe(k);
    if (!findExecutable(exe, env)) continue;
    lines.push(`kind ${k}: ${kindVersion(runCli(exe, ['--version'], { env, timeoutMs: VERSION_TIMEOUT_MS }))}`);
  }
  lines.push(`config: layout=${cfg(ctx, 'layout', 'split')} reuse_workers=${cfg(ctx, 'reuse_workers', 'on')} ` +
    `approvals=${cfg(ctx, 'approvals', 'ask')} auto_approve=${cfg(ctx, 'auto_approve', 'off')} ` +
    `family_check=${cfg(ctx, 'family_check', 'strict')} brief_lint=${cfg(ctx, 'brief_lint', 'warn')}`);
  process.stdout.write(lines.join('\n') + '\n');
}
