#!/usr/bin/env node
// Idempotently register the minions hooks in ~/.claude/settings.json, preserving
// every existing hook (e.g. ai-memory). Backs up the file before writing.
// Usage: node minions-install-settings.mjs <hooksDir>

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const hooksDir = process.argv[2];
if (!hooksDir) {
  console.error("usage: minions-install-settings.mjs <hooksDir>");
  process.exit(1);
}

const settingsPath = path.join(os.homedir(), ".claude/settings.json");
let settings = {};
if (fs.existsSync(settingsPath)) {
  settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
}
settings.hooks = settings.hooks || {};

const specs = [
  { event: "UserPromptSubmit", matcher: "", script: "minions-directive.sh", timeout: 5 },
  { event: "PreToolUse", matcher: "Edit|Write|NotebookEdit", script: "minions-guard.sh", timeout: 5 },
  { event: "SessionStart", matcher: "", script: "minions-sessionstart-sweep.sh", timeout: 10 },
];

let added = 0;
for (const s of specs) {
  const list = (settings.hooks[s.event] = settings.hooks[s.event] || []);
  const already = list.some((entry) =>
    (entry.hooks || []).some(
      (h) => typeof h.command === "string" && h.command.includes(s.script),
    ),
  );
  if (already) continue;
  list.push({
    matcher: s.matcher,
    hooks: [{ type: "command", command: path.join(hooksDir, s.script), timeout: s.timeout }],
  });
  added++;
}

if (added > 0 && fs.existsSync(settingsPath)) {
  fs.copyFileSync(settingsPath, `${settingsPath}.bak`);
}
fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
console.log(
  `settings.json: ${added} hook entr${added === 1 ? "y" : "ies"} added, ${specs.length - added} already present (${settingsPath})`,
);
