// Canonical setup texts + pure merge results.
//
// The block and Claude Code hook commands are shared setup output. The block
// carries no absolute installer path, and the doctor hook resolves the POSIX
// launcher from the project and user skill locations.
//
// `setupBlockResult` and `settingsHooksResult` are the pure, never-writing
// halves of the bash `setup_block_result` (:1797) and `settings_hooks_result`
// (:1849): they return the full file content after the write, or null when
// the write would be refused (bash exit 4, file untouched). No effects: the
// commands in lib/commands/setup.mjs own the disk and the die messages.
export const SETUP_START = '<!-- herdr-agents:start -->';
export const SETUP_END = '<!-- herdr-agents:end -->';

// setup_block: the marked instruction block. Ends with a newline, like the
// bash heredoc; the block itself never names a script path.
export function setupBlock() {
  return "<!-- herdr-agents:start -->\n## Multi-agent workflow (herdr-agents)\n\nInside Herdr (`HERDR_ENV=1`) non-trivial work in this project runs through\nthe `herdr-agents` skill. The calling agent is the **orchestrator**: it\ndecomposes the objective, writes one brief per slice, spawns role workers in\nsibling panes, waits on their report files, integrates, runs the gates and\nowns git. Load the skill (`/herdr-agents`) before planning such work.\n\n- **Delegate**: multi-file slices, UI under the design contract, anything\n  touching auth, secrets or input handling, work that parallelizes, any change\n  that needs a reviewer, and **research**: reading more than a handful of\n  files, another repository or several tools' conventions is `scouter` work.\n  The orchestrator briefs the scouter, reads the report and decides.\n- **Keep**: a one-or-two-file change with no product decision, docs, config,\n  a question, a quick verification. If writing the brief takes longer than the\n  change, make the change.\n- Workers never commit, push or open PRs; the orchestrator owns git.\n- The orchestrator is the planner. `spawn planner` opens no pane.\n- Roles share a pane by lane (`panes=4`: build, explore, review; `panes=3`:\n  build and read). A busy lane is not a new pane: `wait <lane>`, then dispatch.\n- Every code slice gets a `reviewer` from another model family before push,\n  including code the orchestrator wrote itself (pick that kind by hand).\n- The only completion signal is the worker's report file (`dispatch`,\n  `wait`, `status`); never poll agent state by hand.\n- Quota (exit 11: usage limit, 429, resource exhausted) stops the lane. Ask\n  the user before switching kind, waiting, taking the slice, or pausing.\n- Heavy work (implementation, mechanical edits, research) goes to `grok`\n  first, then `cursor` (grok models), then `codex`, then `claude`; review,\n  security, planning and orchestration stay on `codex`/`claude` (a reviewer\n  is always another model family than the implementer); visual work\n  (`designer`, `inspector`) goes to `agy`.\n- Project roles override the skill's in `.agents/herdr-roles/<role>.md`;\n  project config in `.agents/herdr-agents.conf`; scratch state in\n  `.herdr-agents/` (git-ignored).\n- Refresh this block and the hooks by loading `/herdr-agents` and running its\n  `setup` command from the project root.\n<!-- herdr-agents:end -->\n";
}

// setup_hook_reminder: the UserPromptSubmit command (bash `printf '%s'`,
// no trailing newline; the jq --arg value, exactly what lands in
// settings.json).
export function setupHookReminder() {
  return "sh -c '[ \"${HERDR_ENV:-}\" = 1 ] && echo \"herdr-agents: this project routes non-trivial work through /herdr-agents — surveys go to a scouter, slices to workers; the orchestrator keeps only one-or-two-file changes.\"; true'";
}

// setup_hook_doctor: the SessionStart command (bash heredoc minus the
// trailing newline the command substitution strips).
export function setupHookDoctor() {
  return "sh -c '[ \"${HERDR_ENV:-}\" = 1 ] || exit 0; for script in \"${CLAUDE_PROJECT_DIR:-$PWD}/.agents/skills/herdr-agents/scripts/herdr-agents\" \"${CLAUDE_PROJECT_DIR:-$PWD}/.claude/skills/herdr-agents/scripts/herdr-agents\" \"$HOME/.agents/skills/herdr-agents/scripts/herdr-agents\" \"$HOME/.claude/skills/herdr-agents/scripts/herdr-agents\"; do [ -f \"$script\" ] || continue; sh \"$script\" doctor 2>/dev/null | grep -E \"^warn\" | sed \"s/^warn */herdr-agents doctor: /\"; exit 0; done; echo \"herdr-agents doctor: skill script not found\"; true'";
}

// setup_block_result <content|null> — the instruction file content after
// setup_write_block:
//   - with the block already in it: replace the range between the markers,
//     bash awk semantics (the line holding SETUP_START and the line holding
//     SETUP_END are consumed; a second start repeats the block; a line
//     holding both counts as a start; everything after the last consumed
//     start line that is not an end line is dropped);
//   - without it: append the block, guaranteeing the missing final newline
//     first and a blank line before the block (an absent or empty file just
//     gains the block, possibly after a blank line when the file exists).
// Returns the full new content, or null when the result would be incomplete
// (bash: the write is refused with exit 4, file left untouched). `content`
// is the file content ('' when the file is empty) or null when it does not
// exist; CRLF is normalized by the reader before it gets here (decision 7).
export function setupBlockResult(content) {
  const block = setupBlock();
  // bash awk: the blockfile is read line by line and joined WITHOUT a final
  // newline; `print block` adds exactly one. setupBlock() keeps the heredoc's
  // trailing newline, so drop it here and let the join/append restore it.
  const blockNoNL = block.slice(0, -1);
  if (content !== null && content.includes(SETUP_START)) {
    const lines = content.split('\n');
    if (content.endsWith('\n')) lines.pop(); // the trailing '' is not a line
    const out = [];
    let skip = false;
    for (const line of lines) {
      if (line.includes(SETUP_START)) { out.push(blockNoNL); skip = true; continue; }
      if (line.includes(SETUP_END)) { skip = false; continue; }
      if (!skip) out.push(line);
    }
    const result = out.length ? out.join('\n') + '\n' : '';
    // bash: `! -s tmp` or `! grep -q SETUP_END tmp` → exit 4. (The block
    // always carries SETUP_END, so this only bites on a degenerate block.)
    if (result === '' || !result.includes(SETUP_END)) return null;
    return result;
  }
  let head = '';
  if (content !== null) {
    if (content !== '' && !content.endsWith('\n')) content += '\n'; // bash `tail -c1` check
    head = content + '\n'; // the blank line before the block
  }
  return head + block;
}

// settings_hooks_result <content|null> — the .claude/settings.json content
// after setup_write_hooks: replace entries containing the exact generated
// command, append the current entry, and preserve other hooks and fields. The
// output uses jq's formatting (2-space indent, empty containers, raw UTF-8,
// one trailing newline). Returns the
// full new content, or null when the merge cannot be produced (bash: die 4
// `could not merge hooks into <file>`, file left untouched).
export function settingsHooksResult(content) {
  let doc;
  if (content === null || content.trim() === '') {
    // An absent, empty or blank file reads as {} (bash does the same since
    // the fix of the empty-file case, where jq emitted nothing and the hooks
    // were lost).
    doc = {};
  } else {
    try { doc = JSON.parse(content); } catch { return null; }
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return null;
  if (doc.hooks === undefined || doc.hooks === null) doc.hooks = {};
  if (typeof doc.hooks !== 'object' || Array.isArray(doc.hooks)) return null;
  const put = (ev, command) => {
    let arr = doc.hooks[ev];
    // jq `a // b` also replaces false: (.hooks[ev] // [])
    if (arr === undefined || arr === null || arr === false) arr = [];
    if (!Array.isArray(arr)) return false; // jq: cannot map a non-array
    const kept = [];
    for (const entry of arr) {
      if (entry === null) { kept.push(entry); continue; }
      if (typeof entry !== 'object' || Array.isArray(entry)) return false; // jq: cannot index
      let hooks = entry.hooks;
      if (hooks === undefined || hooks === null || hooks === false) hooks = []; // (.hooks // [])
      if (!Array.isArray(hooks)) return false; // jq: cannot iterate
      let drop = false;
      for (const h of hooks) {
        // .command? // "" — missing/null/false read as ''; a non-string
        // value makes jq's test() error (the whole merge fails).
        let c = (h === null || typeof h !== 'object' || Array.isArray(h)) ? '' : h.command;
        if (c === undefined || c === null || c === false) c = '';
        if (typeof c !== 'string') return false;
        if (c === command) { drop = true; break; }
      }
      if (!drop) kept.push(entry);
    }
    kept.push({ hooks: [{ type: 'command', command }] });
    doc.hooks[ev] = kept;
    return true;
  };
  if (!put('UserPromptSubmit', setupHookReminder())) return null;
  if (!put('SessionStart', setupHookDoctor())) return null;
  return JSON.stringify(doc, null, 2) + '\n';
}
