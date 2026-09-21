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
    push. An implementer's self-report is not a review.
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

## Roles (model-independent)

| Role | Responsibility | Must not be |
|---|---|---|
| Orchestrator | decompose, contract, integrate, decide | the one implementing slices |
| Implementer | one slice, per-item report | the one validating the whole repo |
| Reviewer | concrete findings anchored to file:line, before push | same model family as the implementer |
| Visual QA | screenshots in both themes, findings | the one fixing |
| Mechanic | rename, move, insert keys — exact contract | a decision maker |
