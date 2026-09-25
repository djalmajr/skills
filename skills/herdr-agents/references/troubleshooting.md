# Troubleshooting and lessons learned

Observed failures while building and validating this skill (2026-09-20, Herdr
0.9.1, macOS). Each entry: symptom → cause → what the skill does now → what
you should do. Read this before changing the script or adding a kind.

## Worker says it wrote the report, file never appears

- **Symptom:** the agent replies with the report path; `collect` falls back to
  terminal output; `ls` shows nothing. Codex prints
  `zsh: operation not permitted: …/.agents/…`.
- **Cause:** Codex's `workspace-write` sandbox allows the repo root, `/tmp`
  and `$TMPDIR` but **denies its own config roots `.agents/` and `.codex/`**
  (tested: `.claude`, `.cache`, `.tmp`, `.worktrees`, `node_modules/.cache`
  and `.herdr-agents` are writable).
- **Now:** state lives in `<repo>/.herdr-agents/`. Never move it under
  `.agents/`. With `HERDR_AGENTS_DIR`, make sure every kind can write there.

## `dispatch --wait` returns `done` while the worker is still working

- **Symptom:** `wait_status: done`, `report_exists: false`; the pane shows the
  agent still calling tools (Codex during MCP calls).
- **Cause:** Herdr waits for a *lifecycle state*, not a turn. Integrations
  flicker `idle`/`done` mid-task. `agent get .revision` does **not** change
  with the screen, so it is useless as an activity signal (tried; failed).
- **Now:** `dispatch` keeps polling for the report file until the agent is not
  `working` **and** the visible screen checksum has been stable for
  `HERDR_AGENTS_SETTLED_GRACE` seconds (45), or the timeout is spent.
- **Do:** never `release --close` before the report exists. Closing the pane
  kills the worker mid-task; two test runs were lost this way.

## `agent start` times out; pane shows a model list and a shell prompt (Cursor)

- **Cause:** `cursor-agent --help` advertises `model[effort=high]` bracket
  syntax, but for the listed ids it is invalid: the CLI prints the model list
  and exits, and Herdr times out waiting for an agent that is gone.
- **Now:** `--model X --effort E` on `cursor` resolves to `X-E` only if
  `cursor-agent --list-models` lists it; otherwise the plain model with a
  warning. The Cursor executable is `cursor-agent`, not `cursor`.

## `agent start` returns `agent_not_ready` (exit 7)

- **Cause:** a startup dialog: Codex update prompt, login, workspace trust.
- **Now:** `spawn` records the agent, returns focus to the pane that had it
  when focus is still on the new pane, prints the visible screen, exits 7.
  Ask the user, then `herdr agent send-keys <name> …` and
  `herdr agent wait <name>`. The roster entry is valid; `dispatch` works
  after the dialog is cleared.

## Codex CLI updates itself at start; the pane exits right after `spawn`

- **Symptom:** the pane exits right after `spawn`; the screen shows the
  update lines (`Updating Codex via …`, `Please restart Codex`).
- **Cause:** the codex CLI can update itself at start and then exit — the
  process that Herdr started is not the one that runs the session.
- **Now:** right after a successful start, `spawn` watches a 5 s window.
  When the kind's update marker is on the screen it waits for the agent to
  go gone (until the spawn timeout) and relaunches it once, in the same
  pane with the same args (`'<name>' (<kind>) updated itself at start and
  exited; started it again`). An agent that exits right after start
  **without** the marker — or on the relaunch — makes `spawn` exit 4 with
  the last screen lines (up to 5, ` / `-joined); the pane stays open for
  inspection and no roster line is written.
- **Do:** on the second exit, read the screen — usually an interrupted
  update or a login prompt; verify the codex CLI by hand before spawning
  the team.

## Focus jumps while you are typing

- **Cause:** `herdr agent start` focuses the pane it starts, even after a
  `--no-focus` split. Spawn used to follow that by focusing the caller pane
  and tab, including after you had already moved.
- **Now:** spawn remembers the focused pane and puts focus back there only
  when it is still on the pane just started. Any other focused pane is left
  alone. `regrid` does not run `tab focus` on the caller's tab; if a move
  changed focus, it is put back on the pane that had it before the regrid.

## Worker refuses a command from the brief

- **Symptom (Codex):** `rm -f style commands are not permitted` although
  approvals are `-a never`.
- **Cause:** the worker CLI has its own command guard (here a Codex
  `approvals_reviewer` guardian). It is independent of Herdr and of this
  skill.
- **Do:** briefs must not depend on destructive shell idioms; let the worker
  choose the tool. If a guard blocks something essential, report it as
  `skipped + reason`, do not fight it.

## Worker spends its first minute reading rules

- **Cause:** the role is the first *message*; the worker's harness still
  loads the project `CLAUDE.md`/`AGENTS.md`, hooks and memory first. Codex on
  this machine read every ai-memory `_rules/*` page before touching the
  brief.
- **Do:** budget 1–3 minutes of startup per worker in `--timeout`; do not
  treat it as a hang.

## `roster`/`clean` print nothing and exit non-zero

- **Cause:** `set -o pipefail` plus `grep -v '^#'` on a roster with only the
  header. Fixed by `roster_rows()` (`|| true`). Keep using it for any new
  roster read.

## Hook-trust and workspace-trust bypass flags

- Adding Codex `--dangerously-bypass-hook-trust` (and similar) to the
  `approvals: full` mapping was rejected by the Claude Code auto-mode safety
  classifier while editing this skill, and it is a real risk on repos you do
  not own. The mapping deliberately excludes them. Users pass such flags
  after `--` when they accept the risk.

## Orchestrator never noticed the workers were done

- **Symptom:** workers finished in 20 s; the orchestrator polled for two
  minutes.
- **Cause:** a hand-written loop watching `agent get` for a specific state
  (`blocked`) instead of the report file. The file is the contract.
- **Now:** `dispatch` (default wait), `wait <agents…>`, `status <agents…>`.
  Never poll state by hand.

## `approvals: ask` did not block

- **Cause:** `ask` is the CLI's own default. On a machine where Claude Code
  runs with `defaultMode: auto`, nothing prompts. Forcing a prompt requires
  the native flag (`-- --permission-mode manual`).

## `bunx skills add` cannot install from a branch

- The `skills` CLI has no branch/ref option and mis-parses
  `…/tree/<branch>` URLs (`Remote branch feat not found`). Install smoke
  tests only after merging to the default branch.

## `spawn` fails with `agent_pane_busy` right after the split

- **Cause:** the new pane's shell had not reached its prompt (zsh init with
  plugins takes 1–3 s) when `agent start` ran.
- **Now:** `spawn` retries `agent start` once per second for 15 s on that
  error before giving up.

## Three workers ended up stacked in one column

- **Cause:** always splitting the caller pane; after the first right split
  the caller is narrow, so every later split goes down.
- **Now:** `spawn` splits the largest pane among caller + workers along its
  longer side (2x2 with three workers on a wide tab). `layout=tab` moves
  workers to their own tab when the caller must stay large.

## One column became a stack of strips while another stayed whole (2026-09-21)

- **Seen:** after a few `release --close`, the operator's tab had the caller
  full height on the left and 3–4 thin strips on the right.
- **Cause:** the anchor was chosen by counting columns (`group_by(x)`), not
  by area, and released panes were never re-placed in `layout=split`.
- **Now:** the anchor is the candidate with the largest **area** (fractions
  of the tab, rounded to 2 decimals so 107/106-column pairs tie; a worker
  wins a tie over the caller), halved on its longer side; a pane that would
  end below `split_min_pane` is never split. After every spawn/release,
  `regrid` rebuilds the caller's tab as an exact grid over caller + workers,
  caller top-left in the least crowded column. Panes of other origins in
  the tab keep their slot in the split tree. `layout-plan` prints the
  decision (`anchor`, `direction`, `reason: largest-area|full|min`, grid).
- **Capacity:** `max_workers` (default 3, orchestrator not counted) live
  workers at once; `spawn` past it exits 8 with the live names — release a
  finished worker or reuse an idle one. `split_max_panes` (default 4, caller
  included) per tab.
  Beyond it, or when nothing can be halved above `split_min_pane`, the
  worker goes to a herd tab (`<state>/herd-tab`: `tab_id`, label, `auto|manual`
  per line, dead tabs pruned on read). `release --close` in the
  caller's tab frees the slot; workers are not pulled back from herd tabs.

## Herd tabs were all called `herd`, `herd-2`… (2026-09-21)

- **Seen:** with two waves running, the operator could not tell which tab
  held what and renamed one by hand to `onda 2`; the next regrid would
  have renamed it back.
- **Now:** automatic labels are composed from the roles in the tab
  (`herd_label`, default `{roles}` → `impl+rev`, `impl+rev 2`; cut to
  `herd_label_max` = 16) and recomputed after every spawn/release/regrid.
  `spawn --tab-label "onda 2"` / `tab-label "onda 2"` pin a manual label.
  Before recomputing, the skill compares the live label with the last one
  it wrote (stored in `<state>/herd-tab`): a difference means a rename done
  in Herdr, and the tab becomes `manual`. `tab-label --auto` reverts.
- **Gotchas:** the state file stores an unknown label as `-` (a tab-separated
  empty field is swallowed by `read`); `--tab-label` always places the worker
  in that herd tab even when the caller's tab has room; a `--tab-label` that
  matches an `auto` tab adopts it as manual. The old one-column state file
  is migrated on first read: a live label still matching `herd`/`herd-N` is
  `auto`, anything else is treated as a hand rename.

## `regrid` in the caller's tab: Herdr refuses same-tab moves

- **Measured:** `herdr pane move P --tab <its own tab> --split … --target-pane C`
  returns `changed: false, reason: same_tab`.
- **Now:** the workers are moved to a temporary tab (`herd-park`) first —
  the caller's tab collapses to the caller alone — then moved back around
  the caller with computed ratios; the park tab closes itself when its last
  pane leaves. Pane ids are preserved inside a workspace and foreground
  processes survive (measured with `sleep` and live agents). If a move back
  fails, the error names the park tab: the workers are alive there;
  `herdr pane move <pane> --tab <caller tab> --split down --target-pane
  <caller>` brings one back by hand.
- **Gotcha (fixed):** BSD `seq 1 0` prints `1 0` instead of nothing, so a
  column with a single row crashed pass 2 (`cells[idx]: unbound`); the grid
  loops are arithmetic now. `regrid` failures inside `spawn`/`release` run
  in a subshell and only warn (see `friction`).

## Worker in a worktree cannot write the report

- **Cause:** the report path is under the main repo; sandboxes limit the
  worker to its own cwd (+ `/tmp`).
- **Now:** when the roster cwd differs from the repo root, `dispatch` routes
  brief and report through `$TMPDIR/herdr-agents/<ws>/reports/`.

## `wait` reported `blocked` once for a worker that went on working

- **Cause:** approval UIs flash briefly; a single `blocked` sample is not
  proof.
- **Now:** two consecutive probes (≈6 s) are required. With
  `auto_approve=on` the default option is sent and the wait continues.

## `auto_approve` loops on the same dialog

- **Symptom:** with `auto_approve=on` the worker keeps re-asking the same
  dialog (a prompt the default "yes" does not resolve).
- **Cause:** the dialog is not an approval the default option answers;
sending the key again brings it back unchanged.
- **Now:** after each auto-approve, the visible screen (digits and
  progress glyphs normalized) is hashed with a repetition count
  (`<state>/wait/<agent>.approve-screen`): the same dialog a **third**
  time in a row stops the auto-approval —
  `auto_approve: the same dialog came back 3 times for '<agent>'; leaving
  it blocked` — and the wait ends `blocked` (exit 7) with the dialog in
  the JSON `dialog` (the last 20 non-empty visible lines). A different
  dialog resets the counter; `max_auto_approvals` still bounds the total
  answers per dispatch.
- **Do:** read the pane and answer by hand (`herdr agent send-keys`), or
  `release --close` the worker if the dialog is hopeless.

## Nested orchestrator on Codex: `Operation not permitted`

- **Cause:** the Codex `workspace-write` sandbox blocks the Herdr control
  socket, so every `herdr …` call from inside a Codex pane fails.
- **Do:** run nested orchestrators on `claude` (validated), or Codex with
  its sandbox disabled via `args.codex` if you accept that.

## Codex worker: `listen EPERM` on 127.0.0.1

- **Cause:** with `approvals: full` a Codex worker runs `-s workspace-write`,
  whose sandbox denies network access — binding a local port included. A
  test that starts a server (`node:http` on `127.0.0.1:0`, a local database
  on a port, a local workers runtime) fails with `listen EPERM: operation
  not permitted`, and the worker can report the slice as done without ever
  running it (verified with `codex sandbox` 0.156: EPERM by default, `listen
  ok` with the key below).
- **Do:** in the brief, say that such tests do not run in the Codex sandbox:
  the worker marks the item `partial` and the orchestrator runs them. If you
  accept network access (not only localhost), give it only to the readers:
  `role.<role>.args=-c sandbox_workspace_write.network_access=true` (with
  `lanes=off`, and only when that role is configured with kind codex — see
  "A claude worker resumed the orchestrator's conversation") or
  `lane.<name>.args=-c …` (lanes on — a lane session is
  shared by every role in it, so a `role.<role>.args` never applies inside
  a lane, and the `doctor` warns about a scoped key in a config file that
  the current lane mode cannot apply). `args.codex=-c sandbox_workspace_write.network_access=true`
  stays the option that applies to every worker of the kind.

## Codex worker: `git mv` and `git checkout -- <file>` fail on `.git/index.lock`

- **Symptom:** a codex worker's git commands that rewrite the index fail
  on `.git/index.lock` (`operation not permitted`) although the repo root
  is writable.
- **Cause:** the `workspace-write` sandbox allows the repo root but
  **cannot write under `.git`**; `git mv` and `git checkout -- <file>`
  both write the index.
- **Now:** the composed prompt of a codex worker carries the note
  `Your sandbox cannot write under .git: do not run git mv, git checkout,
  git add or git commit. Describe renames and restores in the report; the
  orchestrator runs them.` (absent when the opening args carry
  `danger-full-access`).
- **Do:** the worker describes renames and restores in the report; the
  orchestrator runs them. The same sandbox denies network — see
  "Codex worker: `listen EPERM` on 127.0.0.1".

## QA worker stopped at sign-in

- **Cause:** the orchestrator wrote guessed credentials into the brief. The
  seed script (`scripts/seed-dev.ts`) defines the real ones.
- **Do:** verify every credential, URL, port and fixture named in a brief
  before dispatching (`git grep`, read the seed). Cheap for you, expensive
  for a worker that has to stop.

## Roster column mix-ups

- `agents.tsv` columns are: name, pane, kind, role, family, created_pane,
  cwd, started, and, on lines written by a current `spawn`, model,
  approvals, roles, lane, burst (column 13, `burst` for a temporary worker
  of the flex mode, else empty) and args (column 14, the configured native
  args the worker opened with). Old lines stop at `started` (8 columns) and are
  reused only for the same role. Column 4 is the current role. `roles` is a
  comma-separated history (`scouter,implementer`). Column 12 is the lane
  (`build`, `explore`, `review`, `read`). `reuse_workers` once
  compared the family with the cwd. Read columns by name in comments when
  adding code.
- With `multi_role=on`, `spawn` may reuse an idle worker of another role
  when kind, cwd and resolved model match and the worker's approvals are
  at least the request. A worker that has edited is not reused as
  `reviewer`, `security-reviewer`, `ui-reviewer` or `inspector`. The
  reviewer family check still treats that `roles` history as an edit agent
  after the current role changes.

## Orphan lines in the roster (a line of an agent that died)

- **Symptom:** `roster` shows a line whose pane is dead or whose name is
  used by another live agent; the worker count seems off.
- **Cause:** a worker exited without `release`; its roster line stayed.
- **Now:** a name is only free for a spawn when no live agent uses it, so
  a line left with a name (or with the pane a new spawn reuses) belongs to
  an agent that exited: `spawn` removes it (`replaced the stale roster
  line of '<name>' (pane <pane>)`) — a reused name does not accumulate
  lines. A line whose name is alive in **another** pane shows `gone` in
  `roster` and `status`, not the other agent's state. `max_workers`
  counts a line only when a live agent with the same name sits in the
  line's pane (a line without a known pane falls back to the name, counted
  once); a stale line counts nothing.
- **Do:** `release <name> --close` a dead worker when you see it; the next
  spawn of the same name cleans up by itself.

## `regrid` produced a full-width bottom row instead of a grid

- **Cause:** filling column 0 (down splits) before creating the other column
  heads; the later right split only divided the top-left pane.
- **Facts about `herdr pane move` (measured):** pane ids are preserved inside
  a workspace; `--split down --target-pane X` splits only X; `--ratio` is the
  share kept by the target; the source tab closes itself when its last pane
  leaves (`closed_tab_id`). Never close the old tab by hand: a pane that
  failed to move would die with it.
- **Now:** two passes — all column heads with right splits (ratio
  1/remaining columns), then each column's rows with down splits.

## `worker_context=lean` (partial, measured 2026-09-20)

- Claude worker: 22 s to report instead of ~40 s, no ai-memory reads; the
  project `CLAUDE.md` is still injected by the harness (`--bare` would skip
  it but only works with an API key, not OAuth).
- Codex worker: 53 s instead of 2.5–4 min, but `-c project_doc_max_bytes=0`
  did not stop the `# AGENTS.md instructions` injection and the worker still
  read the global ai-memory rules because `~/.codex/AGENTS.md` tells it to.
  Open: find the effective Codex switch (or trim the global AGENTS.md).
  `codex exec` does not accept `-a`; use `--ask-for-approval` there.

## Validating a new or updated kind

1. `herdr agent` must list the kind; the executable must be in `PATH`
   (`herdr-agents kinds`).
2. Add `kindExe`, `kindFamily`, `kindEffortCeiling`, `kindEffortArgs`,
   `kindModelArgs`, `kindApprovalArgs` entries in `scripts/lib/kinds.mjs` and a row in
   `kinds.md`.
3. Smoke: a 15-line read-only brief (`scouter`) asking for one constant and its
   reader in the current repo. `spawn --approvals full --effort <ceiling+1>`
   (expect a clamp warning) → `dispatch` (waits on the report) → `collect`
   → `release --close`. Watch for: startup dialogs, report written to the
   right path, focus still on the pane that had it before spawn, `friction` empty afterwards.
4. The caller's tab holds at most `split_max_panes` panes (4 → 2×2 on a
   213×57 tab); later workers overflow into herd tabs labelled
   after their roles (`impl+rev`) or `--tab-label`.

## `setup` rerun emptied AGENTS.md (fixed)

**Seen:** the second `setup` run printed `awk: newline in string` and the
target file ended up with zero bytes. **Cause:** BSD awk (macOS) rejects a
multi-line string passed with `-v`, and the temp file was moved into place
regardless of the awk exit status. **Fix:** the block is read by awk from a
temp file, the rewrite aborts on awk failure, and the result must be
non-empty and contain the end marker before it replaces the target.
**Rule for the script:** never `mv` a generated file over user content
without checking that generation succeeded and produced what you expect.

## Lane busy (exit 10) and `spawn planner` (exit 12)

- **Symptom:** `spawn implementer` prints `{"status":"busy","lane":"build","name":"build"}` and exits 10 while the build pane is still working.
- **Cause:** one lane is one session. A second pane would exceed `panes`.
- **Do:** `wait build`, then dispatch the next brief. `spawn planner` exits 12 on purpose: plan in the orchestrator session.

## Quota (exit 11)

- **Symptom:** `wait` / `status` / `dispatch` returns status `quota` and exit 11. The JSON has `lane`, `kind`, `model`, `match`, and `renewal` when the screen printed a time.
- **Cause:** the agent is not `working`, the report is missing, and the last ~20 visible lines contain a provider quota error as a whole sentence (`hit your usage limit`, `Individual quota reached`, `quota exceeded`, `You exceeded your current quota`, `RESOURCE_EXHAUSTED`, `429 Too Many Requests`, `rate limit exceeded`, `You've hit your … limit`, `You have reached your … usage limits`). A line that is source (`return`, `func` / `function`, an assignment, a `//` / `#` / `/*` comment, or the phrase in quotes) does not match. `You've hit your stride` does not match. Neither does the same text while the agent is `working`.
- **Do:** ask the user (switch the lane's kind/model, wait for renewal, take the slice, or pause). On resume, include `git diff` of the partial work in the next brief. The line is logged in `friction`.

## `doctor --fix` will not pick 3 or 4

- **Symptom:** `doctor --fix` exits 2 and the config file is unchanged.
- **Cause:** the file has no `panes=` and `--panes` was not passed. The script does not choose a team size.
- **Do:** ask the user, then `doctor --fix --panes 3` or `--panes 4`. That writes the preset lanes, sets `max_workers` to the lane count and `split_max_panes` to `panes`, and turns `reuse_workers` on. For each lane it resolves every role's kind and model (the value in that file, otherwise the role frontmatter). When they all agree, it writes `lane.<name>.kind` / `.model` and then removes those `role.<role>.kind` / `.model` keys. When they disagree, it leaves the keys, lists `role=kind`, and tells you to ask and run `setup --lane <name>=<kind>[:<model>[:<effort>]]`. `role.planner.*` is always removed. Full-line comments stay. `max_workers` written here does not count as the user having chosen a lane kind. `setup --panes 4 --lane build=grok:grok-4.7:high` writes the same keys plus the lane's kind, model and effort.

## Lane kind mismatch (exit 13)

- **Symptom:** `spawn` prints `{"status":"kind-mismatch",...}` with `session_kind`, `requested_kind`, and the model and effort on each side, and exits 13. The pane stays on the CLI of the role that opened it.
- **Cause:** `lane.<name>.kind` is empty, so the first role opened the session (designer is `agy`, implementer is `grok`). A later role would otherwise keep that process.
- **Do:** `release <name> --close` the lane, set one CLI for it with `setup --lane <name>=<kind>[:<model>[:<effort>]]` if `lane.<name>.kind` is missing, then spawn again. Setting the key alone does not retarget a running session: a live process on another CLI still exits 13 until it is released. `doctor` warns when the key is empty and the roles in the lane resolve to different kinds.

## First run and `explain` (2026-09-23)

- `doctor` prints `first_run: true` or `first_run: false` on its own line.
  `init` puts the same boolean in its JSON. True means the project file
  sets none of `multi_role`, `role.<role>.kind`, or `lane.<name>.kind`, and
  the state root has no roster data row. A header-only `agents.tsv` is still
  a first run. `max_workers` alone is not a team choice.
- Before any spawn on a first run, the orchestrator says what the panels are
  (in the user's language) and waits for a yes. `setup --detect` adds an
  English `summary` on every kind so that question can name only the
  assistants that are installed.
- `explain` is plain text for a person, not JSON. With roster rows it names
  each panel's lane, current role, assistant, model, and one of: working,
  idle, waiting for report, out of quota. With no rows it prints one
  paragraph on what the team is and how to start. It does not open or close
  panels.

## `wait` of several lanes

- **Symptom:** one lane is `quota` and another is `blocked` or `gone`, and the exit changes with the order of the names.
- **Now:** the exit is the most severe status in the wait: 4 (`unavailable`), then 11 (`quota`), then 14 (`provider-error` or `capacity`), then 15 (`not-received`), then 7 (`blocked` or `question`), then 6 (`gone` or settled). `wait build review` and `wait review build` return the same code.

## Prompt stuck in the input box of a CLI that was still opening

- **Symptom:** `dispatch --no-wait` exits 15 (`prompt to '<agent>' was not received after an Enter on the text left in its input box`) and a later `wait` on the same agent hangs until the agent finally starts — a manual Enter unblocks it.
- **Cause:** a freshly opened CLI is still starting; it accepts the prompt into its input box and swallows the Enter the dispatch sent, so the prompt never reaches the model. The dispatch's arrival check ended `not-received`, and the old `wait` had no way to know about it.
- **Now:** a `not-received` dispatch records the moment and the agent's `state_change_seq` in `<state>/wait/<agent>.not-received`. A `wait` retries one Enter per `prompt_check_seconds` window while the prompt is still visible in the input box, up to 3 retries; the agent starting to work, blocking, or its state having changed since the marker (a different `state_change_seq`) clears the markers and the wait goes on as usual; after the 3 retries — or when the prompt is no longer in the input box with the agent not working — the wait exits 15 with `not-received`. `status` reports `not-received` (exit 15) read-only, never sending a key, and a moved seq clears the report there too. A new dispatch clears the markers.
- **Do:** on a 15, read the pane (`herdr agent read <agent> --source visible`) and dispatch again — the CLI is usually ready by then.

## Running the test matrix

- The JS unit tests run under either runtime: `node --test scripts/test/`
  or `bun test scripts/test/`.
- Use `scripts/run-tests.sh`: every `scripts/test-*.sh` suite (bash suites
  that exercise the JS through the POSIX `scripts/herdr-agents` launcher) ×
  inside/outside in parallel (one `PASS|FAIL` line per run, last 30 log
  lines of each failed run on failure). Flags: `--env inside|outside|both`,
  `--bash <path>` (repeatable, adds an interpreter to the matrix),
  `--jobs N`, suite names or paths as extra arguments.
  `HERDR_AGENTS_KEEP_TEST_LOGS=1` keeps the logs.
- The old bash↔JS parity tests are golden files under
  `scripts/test/golden/` (recorded from the bash behavior before the
  port). An intentional behavior change re-records them with
  `HERDR_AGENTS_GOLDEN=update`, then review the diff.
- Every run is isolated: its own `HOME`, `XDG_CONFIG_HOME` and `TMPDIR`
  inside a temp dir, and all `HERDR_AGENTS_*` variables from the parent
  environment unset. No suite reads `~/.config/herdr-agents`, `~/.pi` or
  `~/.config/opencode`.
- While iterating on a change, run only the item's suite
  (`scripts/run-tests.sh --env outside test-<x>.sh`); the full matrix runs
  once, before the report. A suite path is relative to the skill directory
  (`scripts/test-x.sh`); a bare name (`test-x.sh`) is looked up in `scripts/`.

## Two edit agents in one tree: one worktree per worker (or per branch)

- **Symptom:** two agents with an edit role work in the same cwd; builds
  and test runs see each other's changes in progress.
- **Cause:** one shared working tree; nothing isolates the two.
- **Now:** `spawn` (a new worker and a reuse alike) warns per other live
  edit-role agent in the same cwd: `'<a>' and '<b>' both edit <cwd>: builds
  and test runs see each other's changes in progress; give each a git
  worktree (spawn --cwd <worktree>) to isolate them` — the extra `agent
  list` read happens only when a candidate exists. `dispatch` tells the
  worker whose tree is shared (one `agent list` read, never a call per
  agent): the composed prompt (brief and amendment) adds `Another worker
  edits this same tree now: run the global checks the brief asks for, but
  report failures in files you do not own as outside your slice (name the
  files), not as [partial] items of yours.` (a Herdr failure listing the
  agents skips the line: it is advisory).
- **Do:** one worktree per worker (or per branch): `git worktree add
  .worktrees/<slug>` (or `herdr worktree create`), then `spawn <role>
  --cwd <worktree>`; the roster stays in the main repo and the brief and
  report are routed through `$TMPDIR/herdr-agents/<ws>/reports/` (mirrored
  back into the state dir on `done`). Merge with `git -C <worktree> diff |
  git apply` (or cherry-pick). A reviewer can read and test in a worktree
  of the branch under review. Rust projects: give each worktree its own
  `CARGO_TARGET_DIR` so the target directories do not collide. The
  orchestrator's own mutation checks follow the copy rule in the next
  entry.

## A mutation check in the shared tree breaks another worker's tests

- **Symptom:** a worker's mutation check (a temporary change to make one
  test fail), restored within seconds, breaks the tests of another worker
  running in the same tree.
- **Cause:** the other worker runs tests that import the mutated file. The
  `Owned files` warning covers who edits, not who executes.
- **Now:** the `implementer` runs the mutation check in a throwaway copy of
  the project outside the repository (such as under `/tmp`) whenever other
  workers may share the tree; in-place mutation is allowed only when alone
  in the tree, and restores only after the file's sha256 still matches (a
  changed file is someone else's edit: not restored, and reported). The
  `reviewer` mutates only in a throwaway copy — it never edits the
  repository.
- **Do:** the same rule applies to the orchestrator, who also mutates. When
  a brief needs an in-place mutation, make the tree single-user first
  (release the other edit agents) or run the check in a copy.

## The orchestrator cannot commit while workers edit the same tree

- **Symptom:** a pre-commit hook that checks the whole tree (typecheck, related tests) fails on another worker's work in progress (a test in its red step, a half-made edit), not on the approved slice.
- **Do:** commit from a clean worktree.
  1. `git worktree add --detach ../<repo>-commit HEAD`, and install the dependencies there once.
  2. Copy only the approved files, checking each sha256 against the one the review saw.
  3. Commit there: the hook runs without anyone's work in progress.
  4. In the main tree, check `git merge-base --is-ancestor HEAD <sha>`, then `git reset -q <sha>`. The mixed reset moves the branch and the index without touching the working tree, so the workers keep going.

## A worker sits stuck without a report (the abandon flow)

- **Symptom:** a worker is `working` for many minutes (a high-effort model
  thinking) without writing anything; two `ctrl+c` presses queue answers
  instead of interrupting, and the lane stays stuck.
- **Cause:** the model is inside one long reasoning or tool phase; keys are
  queued, not injected.
- **Now:** after `stuck_warn_minutes` (20) of an unchanged screen (apart
  from counters) while `working`, the wait logs one friction line ("may be
  stuck in one tool call") and goes on; nothing is sent and nothing is
  killed automatically.
- **Do:** interrupt with `herdr agent send-keys <agent> esc` (or
  `ctrl+c`), release the slot with `release <agent> --close --force`, and
  log what happened with `friction add "<text>"`.

## Exit 137 with no cause: the skill's own process was killed from outside

- **Symptom:** a `dispatch` (or a foreground `wait`) dies with exit 137 and
  no cause line; it looks like the wait timed out, but the skill's own
  timeout exits 9 with a `timeout` JSON line and a friction suggestion.
- **Cause:** an external kill — the process was SIGKILLed, usually by the
  time cap of the command that called it. The 137 cause the skill prints
  is for a killed `herdr agent get` child, not for the skill process
  itself, which cannot write a cause once it is dead.
- **Now:** a `herdr agent get` killed by a signal (exit ≥ 128) is retried
  after 1 s and 2 s before counting; the skill process itself cannot catch
  its own SIGKILL.
- **Do:** the prompt may have gone out — run `status <agent>` (or
  `wait <agent>`) before repeating, so a brief is not sent twice. Run a
  `dispatch` that waits in the background (or `--no-wait` followed by
  `wait`), which matters under a Bash call cap (10 minutes for a Claude
  Code orchestrator).

## `wait` exits 9 (timeout) while the worker is still working

- **Symptom:** `wait` exits 9 with a `timeout` line; the pane shows the
  agent still calling tools and no report has appeared.
- **Cause:** the wait's timeout — the role's effective timeout (the
  frontmatter `timeout`, else `dispatch_timeout`, × 1.5 for `xhigh`, × 2
  for `max`) or the explicit `--timeout` — is shorter than the work. A
  timeout is not a failure.
- **Now:** the `timeout` line carries `elapsed_ms` and `state` (the last
  probe tag, `working` or `pending`), and each timed-out agent gets a
  friction line: `timeout waiting for '<agent>'; it may still be working
  (state: <state>). Run: herdr-agents wait <agent> --timeout <2×>` — the
  suggestion doubles the timeout this wait used.
- **Do:** check with `status <agent>`; re-run `wait <agent> --timeout <2×>`
  (or `--any` to wake per report). If the process instead died with 137
  and no cause line, it was killed from outside — see the exit-137 entry.

## A claude worker resumed the orchestrator's conversation

- **Symptom:** a `spawn --kind claude` worker opened the orchestrator's own conversation (same cwd, the worker's approvals) and acted as the orchestrator: release, spawn, dispatch, file edits.
- **Cause:** a codex flag in `role.reviewer.args` (`-c sandbox_workspace_write.network_access=true`) was appended to whatever kind played the role. To claude, `-c` is `--continue`, which resumes the most recent conversation of the cwd; to cursor it is `--cloud`, and the agent exits. The start also timed out and the pane stayed open with the agent running.
- **Now:**
  - scoped args (`role.<role>.args`, `lane.<name>.args`) reach a worker only when the spawn runs the kind configured for that role or lane; otherwise they are dropped, with a warning;
  - `spawn` refuses resume flags for claude and cursor from any source before a pane opens;
  - a start that fails in a pane the spawn opened closes that pane.
- **Do:** put CLI-specific flags in `args.<kind>` (`args.codex=-c …`). Check any `role.<role>.args` or `lane.<name>.args` against the kind that role or lane runs.
