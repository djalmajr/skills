# Orchestration contract

Tool-agnostic rules for delegating work to other agents. This skill's scripts
and role prompts encode them; the orchestrator is responsible for the rest.

## Before delegating

1. **Ask direction before proposing.** An ambiguous product decision is a
   one-line question to the human, never a long document.
2. **Decompose yourself.** The orchestrator that owns the context defines
   slices, interfaces, and order. Never outsource the top-level plan to an
   agent that starts without context.
3. **One slice = disjoint files.** Each agent gets the list it owns and the
   list it must not touch. Two agents in one file is deferred conflict.
4. **Shared resources arrive ready.** Translation catalogs, small stores,
   global constants: the orchestrator delivers keys/values in the brief, or a
   single agent owns them for the batch.

## The contract of each task

5. **Contract, not description.** Goal, owned files, forbidden files, local
   sources by path, applicable project rules, checks the worker may run, and
   the report format.
6. **Per-item report with three states:** done / partial / skipped + reason.
   "Skipped because the capability/data/API does not exist" is a correct
   answer; pretending is the only wrong one.
7. **No dead triggers.** A button, tab, command, or shortcut without real
   capability behind it is skipped and reported, never stubbed.
8. **No global validation mid-flight.** Parallel agents run only checks on
   their own files; the full suite, the formatter, and global gates run once
   at integration.

## Brief checklist (lessons from real failures)

A worker that has to guess will guess — and a simpler model guesses more.
Every item below was a real gap in an orchestrator's brief that cost a
review round or a rewrite. Reread the brief as the worker before
dispatching: any place where you would have to choose is a gap.

- **Expected result, acceptance criteria, decisions made.** State what
  exists at the end, how each criterion is proved (the command and the
  expected output), and every name, format, text and value the worker must
  not choose.
- **Rules as exact predicates, each with a counterexample.** "A segment that
  *is* a family name decides the family (`my-router/anthropic/x` →
  anthropic; `anthropic-proxy/x` → unknown)" — not "a segment that is a
  family prefix", which a worker reads as *starts with*.
- **A grep used as a criterion anchors what it looks for.** "`grep -n
  slice` finds nothing" was meant for a process label in comments; the
  worker also rewrote every `.slice()` call (one into a mutating
  `.splice()`) to satisfy it. Write the pattern that matches only the
  target (`// .*\bslice\b`, a word in a test name) and say what must not
  change.
- **Every option the user can pick has its exact semantics.** An option
  label ("2 panels") without the configuration it maps to gets invented,
  and the invention can silently drop the user's other choices.
- **Non-functional invariants, not only output.** For a rewritten file: its
  mode is kept (new private files 0600), the temp file sits next to the
  target (a temp dir on another filesystem breaks the rename), and nothing
  is deleted before the replacing rename. For anything interruptible: what
  happens on Ctrl-C / TERM, including children and grandchildren, and in
  sandboxes where `ps`/`pgrep` are denied (signal process groups instead of
  listing processes). Platform paths (Windows `.cmd` shims, `%APPDATA%`,
  `path.join`). Secrets never copied into output.
- **Input validation for every flag:** missing value, another flag in the
  value's place, incomplete combinations (`--model` without `--kind`),
  zero or negative numbers.
- **Parity compares metadata too.** Byte-identical content with a different
  file mode, a leftover temp file or a different exit code is not parity.
- **Two or three items per brief.** A six-item brief pushed a worker to
  90% of its context window; later turns get slower and sloppier.
- **Which checks, when.** A slice runs only its own tests, once per runner,
  while iterating and before the report; the full matrix runs once, at the
  end of a multi-slice effort, not per slice and not again in each review.
  Repeated full runs (three rounds per slice, plus the reviewer's) were most
  of a slice's wall time.
- **A resume brief says "you implement".** Handing over another worker's
  unfinished files as "a draft to check yourself" made a worker delegate a
  read-only audit and edit nothing. Say it plainly: edit the files, finish
  the criteria, run the slice's tests.
- **Never copy a defect of the reference to pass parity.** When a parity
  test only passes by reproducing a bug of the reference implementation,
  fix the reference (with a test) or record the divergence; say so in the
  brief before the worker meets it.
- **Tests never hang.** Every `spawnSync`/`execFileSync` a test runs gets a
  `timeout`, and every branch of a fake CLI advances its arguments: a fake
  whose `--new-tab)` branch had no `shift` looped forever and held
  `node --test` for 1h18 while the wait only saw `working`.
- **A UI slice is done after a browser smoke.** A builder in a sandbox
  usually cannot open a browser: a routing mistake in a web app passed its
  tests and only broke in the orchestrator's smoke. Before a UI slice counts
  as done, the orchestrator or an `inspector` opens the touched screens.
- **Small writes with XML-tool-call models.** Ask for one file per call and
  a few hundred lines at most per call. A `settled-no-report` whose screen
  shows raw tool-call text is a malformed call, not a finished worker:
  tell it nothing was written and to continue in smaller writes.
- **First-run dialogs in new directories.** A fresh worktree or temp folder
  can trigger a CLI's folder-trust prompt; tell the user or use a folder
  already trusted. A CLI that crashes at start shows it in its pane — read
  the pane before blaming the transport.
- **Facts verified when the brief is written.** Flags, versions and
  endpoints come from `--help` or the source at that moment; CLIs update
  themselves between sessions.
- **When the brief does not decide,** the worker marks the item `partial`,
  lists the gap and the options, and continues. The orchestrator answers the
  gap as a decision in the next brief — never by leaving it to the worker
  again.
- **An in-flight brief changes through an amendment, not a new prompt.** A
  worker that is busy, or already reported, does not get a rewritten brief
  or a hand-rolled `herdr agent prompt`: the amendment goes in its own file
  and is sent with `dispatch <agent> amend.md --amend`, which gives it a new
  report that the wait watches while the pane keeps the current task.

## Fragile resources

9. **Export per slice, to local files.** Prototypes, slow MCPs, remote APIs:
   never in one big batch, never in a long loop inside a REPL.
10. **One browser profile per agent**; serialize visual verification when
    there are many agents.

## Integration

11. **Fixed order after N parallel deliveries:** repo formatter → workspace
    typecheck → project gates → full suite → end-to-end smoke on touched
    surfaces. Only then commit.
12. **Review by a different model family** than the implementer, before any
    push. An implementer's self-report is not a review. It pays: across one
    multi-slice port every review found a real defect the implementer's own
    tests had passed (a session reused with the wrong model, a cleanup that
    would drop the whole roster on a malformed answer, a parser that read a
    field wrong).
    **Fix checks go to the same reviewer.** After fixing its findings, send
    the fix list to the reviewer that found them, with a report path of its
    own: it still has the context, so the check is short.
    **Parallel workers in one checkout** get disjoint files. When a shared
    file is unavoidable (an entry point both slices extend), give each worker
    its own worktree, or separate the slices at commit time: rebuild the
    shared file from `HEAD` plus only this slice's lines, stage that blob
    (`git hash-object -w` + `git update-index --cacheinfo`) without touching
    the other worker's working copy, and run the slice's tests on an exact
    copy of the index (`git checkout-index -a --prefix=<tmp>/`) before the
    commit.
13. **Say what was proved, not more.** "No regression observed in <tests +
    smokes>", never "zero regressions". What was skipped is not covered.
14. **Each delegated slice produces its own report file** in the
    initiative's directory when one exists.

## Orchestrator edits

15. **Re-read before each surgical edit** in a file that may have changed.
16. **Bulk mechanical edits go to a cheap agent with an exact contract**;
    the main model keeps decisions and integration.
17. **Small tasks stay with the orchestrator.** One or two files, no
    product decision, a few dozen lines, docs, config, a question, a quick
    verification: doing it beats briefing it. If writing the brief takes
    longer than the change, make the change. Product code the orchestrator
    writes still gets a reviewer from another model family before push.
18. **Surveys go to a scouter.** Reading many files, another repo, or
    several tools' conventions to inform a decision is research, not
    orchestration; the orchestrator briefs a `scouter`, reads the report and
    decides. Doing the survey itself spends the context that integration
    needs later.

## Roles (model-independent)

| Role | Responsibility | Must not be |
|---|---|---|
| Orchestrator | decompose, contract, integrate, decide | the one implementing slices |
| Implementer | one slice, per-item report | the one validating the whole repo |
| Reviewer | concrete findings anchored to file:line, before push | same model family as the implementer |
| Visual QA | screenshots in both themes, findings | the one fixing |
| Tasker | rename, move, insert keys — exact contract | a decision maker |
