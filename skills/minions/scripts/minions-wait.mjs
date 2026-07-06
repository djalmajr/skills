#!/usr/bin/env node
// minions-wait.mjs — liveness-aware wait + recover for Codex "minion" (rescue) jobs.
//
// Report-only by design: it NEVER cancels a job. It blocks until the job finishes
// (printing its result) or until the worker looks dead — a stale log or a missing
// worker pid — at which point it prints a zombie report and exits, so the
// coordinator decides whether to cancel and re-dispatch. This turns the classic
// "waited 48 minutes on a dead worker" failure into a ~1-minute detection.
//
// Usage:
//   node minions-wait.mjs [jobId] [--stale <secs>] [--max <secs>] [--poll <secs>]
//   no jobId → the single running rescue job (errors if 0 or >1 are running).
//
// Exit codes:
//   0  job finished  → its result is printed to stdout
//   2  zombie suspect → report printed to stdout; the job is NOT cancelled
//   1  usage error / no such job / max wait exceeded while still alive

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();

function findCompanion() {
  const base = path.join(HOME, ".claude/plugins/cache/openai-codex/codex");
  let versions = [];
  try {
    versions = fs.readdirSync(base);
  } catch {
    return null;
  }
  for (const v of versions.sort().reverse()) {
    const p = path.join(base, v, "scripts/codex-companion.mjs");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function parseArgs(argv) {
  const opts = { stale: 120, max: 3600, poll: 15, jobId: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stale") opts.stale = Number(argv[++i]);
    else if (a === "--max") opts.max = Number(argv[++i]);
    else if (a === "--poll") opts.poll = Number(argv[++i]);
    else if (!a.startsWith("--")) opts.jobId = a;
  }
  return opts;
}

function companionStatus(companion) {
  const out = execFileSync("node", [companion, "status", "--all", "--json"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(out);
}

function allJobs(snap) {
  const list = [];
  if (Array.isArray(snap.running)) list.push(...snap.running);
  if (Array.isArray(snap.recent)) list.push(...snap.recent);
  if (snap.latestFinished) list.push(snap.latestFinished);
  return list;
}

function findJob(snap, jobId) {
  if (jobId) return allJobs(snap).find((j) => j.id === jobId) || null;
  const running = (snap.running || []).filter(
    (j) => j.kindLabel === "rescue" || j.jobClass === "task",
  );
  if (running.length === 1) return running[0];
  return { __ambiguous: running.length };
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists but owned by another user
  }
}

function logIdleSecs(logFile) {
  try {
    return (Date.now() - fs.statSync(logFile).mtimeMs) / 1000;
  } catch {
    return Infinity;
  }
}

function fetchResult(companion, id) {
  try {
    return execFileSync("node", [companion, "result", id, "--json"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    return (e.stdout || "") + (e.stderr || "");
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sweep mode: report every running rescue job that looks dead, without waiting.
// Always exits 0 — it is a report. Prints nothing when everything is healthy.
function sweep(companion, staleSecs) {
  let snap;
  try {
    snap = companionStatus(companion);
  } catch {
    return 0;
  }
  const running = (snap.running || []).filter(
    (j) => j.kindLabel === "rescue" || j.jobClass === "task",
  );
  const suspects = [];
  for (const j of running) {
    const idle = logIdleSecs(j.logFile);
    const alive = pidAlive(j.pid);
    if (!alive || idle > staleSecs) {
      const why = [];
      if (!alive) why.push(`pid ${j.pid || "?"} dead`);
      if (idle > staleSecs) why.push(`log idle ${Math.round(idle)}s`);
      suspects.push(`- ${j.id} (${why.join(", ")}): ${String(j.summary ?? "").slice(0, 80)}`);
    }
  }
  if (suspects.length > 0) {
    process.stdout.write(
      `${suspects.length} suspected zombie minion job(s) from a prior session (report-only):\n`,
    );
    process.stdout.write(`${suspects.join("\n")}\n`);
    process.stdout.write("Verify with minions-wait <jobId>; cancel + re-dispatch if truly dead.\n");
  }
  return 0;
}

async function main() {
  const rawArgv = process.argv.slice(2);
  const companion = findCompanion();
  if (!companion) {
    console.error("minions-wait: codex companion script not found under ~/.claude/plugins");
    process.exit(1);
  }

  if (rawArgv.includes("--sweep")) {
    const staleIdx = rawArgv.indexOf("--stale");
    const staleSecs = staleIdx >= 0 ? Number(rawArgv[staleIdx + 1]) : 120;
    process.exit(sweep(companion, staleSecs));
  }

  const opts = parseArgs(rawArgv);

  const deadline = Date.now() + opts.max * 1000;
  for (;;) {
    let snap;
    try {
      snap = companionStatus(companion);
    } catch (e) {
      console.error("minions-wait: status failed:", e.message);
      process.exit(1);
    }

    const job = findJob(snap, opts.jobId);
    if (!job) {
      console.error(`minions-wait: no job found${opts.jobId ? " for " + opts.jobId : ""}`);
      process.exit(1);
    }
    if (job.__ambiguous !== undefined) {
      console.error(
        `minions-wait: ${job.__ambiguous} running rescue jobs — pass an explicit jobId`,
      );
      process.exit(1);
    }

    if (job.status !== "running") {
      process.stdout.write(`# minion ${job.id} — ${job.status}\n\n`);
      process.stdout.write(fetchResult(companion, job.id));
      process.stdout.write("\n");
      process.exit(0);
    }

    const idle = logIdleSecs(job.logFile);
    const alive = pidAlive(job.pid);
    if (!alive || idle > opts.stale) {
      const reasons = [];
      if (!alive) reasons.push(`worker pid ${job.pid || "?"} not alive`);
      if (idle > opts.stale) reasons.push(`log idle ${Math.round(idle)}s (> ${opts.stale}s)`);
      process.stdout.write(`# ZOMBIE SUSPECT: minion ${job.id}\n`);
      process.stdout.write(`phase=${job.phase ?? "?"} elapsed=${job.elapsed ?? "?"}\n`);
      process.stdout.write(`reasons: ${reasons.join("; ")}\n`);
      process.stdout.write(`summary: ${String(job.summary ?? "").slice(0, 120)}\n`);
      process.stdout.write("report-only — NOT cancelled. To recover, cancel then re-dispatch:\n");
      process.stdout.write(`  node ${companion} cancel ${job.id}\n`);
      process.exit(2);
    }

    if (Date.now() >= deadline) {
      console.error(
        `minions-wait: ${job.id} still running after ${opts.max}s (worker alive, log fresh) — ending the wait`,
      );
      process.exit(1);
    }
    await sleep(opts.poll * 1000);
  }
}

main();
