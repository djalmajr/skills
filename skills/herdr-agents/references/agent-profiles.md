# Agent profiles: strengths and weaknesses by kind and role

What each assistant did well and badly while playing each role, from real
use of this skill. Use it to choose `role.<role>.kind`, `lane.<name>.kind`
and the model per role. It is evidence, not a benchmark:
- the brief, the effort and the project weigh as much as the model;
- models change.

Re-check in your own project with `herdr-agents stats` and the review
headers before changing a team.

**Source.** Seven projects, on 2026-09-24 and 2026-09-25, with about 270
dispatched tasks:
- a backend with its deployment manifests;
- infrastructure scripts;
- a desktop app that also ships on Windows;
- a browser extension with its backend;
- three web apps.
- **Time:** from the composed brief to the report.
- **Rounds:** new slices a review sent back.

## At a glance

| Kind (model, effort) | Best at | Weak at |
|---|---|---|
| `codex` (gpt-6-luna, xhigh/max) | Following a closed brief to the letter; test-first with literal RED/GREEN; honest `[partial]`; reviews without false positives | Slow at `xhigh`; its sandbox blocks ports and `ps`, and cannot write under `.git`, so UI, e2e and anything that needs a server go unproved; behaviour of a platform it cannot run |
| `grok` (grok-4.7, xhigh) | Speed (about 3× codex on the same project); large slices; lean SQL; scripts from a narrow brief | Reshapes production code to make a test or the type check pass; writes expected values without checking the fixture; security and cleanup gaps in scripts |
| `cursor` (grok-4.7, high/xhigh) | Fast, precise review when it can execute what it reviews; multi-file backend slices; spikes that need a running server | Little rigor when there is nothing to execute; confident claims about runtime behaviour it cannot run; fills its context fast |
| `claude` (opus, xhigh) | Deepest review of UI, architecture and integration, proved with probes | Small sample (7 reviews) |
| `agy` (gemini-3.8-flash, medium/high) | Found a real privacy P1 in review; says what a test really proves | Missed a state change across requests with confidence 1.0; hits its quota; small sample |
| `pi` with a small self-hosted model (~27B, high) | Fast and cheap; no invented names; pastes real output; good with a strict report format (claims table, lookup) | Fixes the instance, not the class; skips validation against real systems |

## By kind

### codex (gpt-6-luna)

**As implementer** (4 projects, about 40 tasks; median 13 to 33 min per
project, max 59):
- **Strong:**
  - follows the brief to the letter: no `Owned files` or `Forbidden`
    violation in 18 tasks in one project;
  - writes the failing test first, pastes the literal RED and GREEN, and
    runs mutation probes that it restores;
  - marks `[partial]` with the right cause (sandbox, loopback);
  - invents no names, flags or endpoints;
  - writes complete reports.
- **Weak:**
  - slow: a 600-line slice with tests took 21 min;
  - without network, it replaced the integration test with tests of a
    helper predicate (the codex network note now asks for the integration
    test anyway);
  - platform behaviour it cannot observe, which only CI or the target OS
    caught:
    - a test path built with a literal `/`;
    - a lint rule of a newer CI toolchain;
    - a child process held by a Windows job object;
  - once skipped the neighbouring unit test of the file it changed.

**As designer** (1 project, 4 tasks, about 30 min):
- **Weak:** this was its worst role. It delivered UI and e2e tests it never
  ran, because the sandbox gives it no port.
  - The orchestrator found, in the browser: 3 runtime bugs, 1 dependency
    that broke the dev server and about 8 wrong selectors.
  - It also removed a field without checking a test that consumed it.

**As reviewer or security-reviewer** (3 projects, about 43 tasks):
- **Time depends on the effort:**
  - at `xhigh`: median 10 to 12 min, max 35;
  - at `high` (one project, 4 tasks): 2 to 3 min on average, and it still
    found concrete P1s.
- **Strong:**
  - finds the class of bug an implementer left, and proves it with a probe
    in a throwaway copy;
  - on scripts: a wrong final copy, live tokens used in a rehearsal, and a
    probe that reported a false PASS and skipped its cleanup;
  - separates a static review from a proof on the real system;
  - no known false positive.
- **Weak:**
  - at `xhigh` a review costs 2 to 4 times the slice;
  - marks `[partial]` in most reviews for checks the environment cannot run
    (a missing tool, no network, no cluster).

**As scouter or researcher:**
- **Strong:** fast (6 to 17 min) and light on context when the evidence is
  text in the repository.
- **Weak:** when the evidence was screenshots it could not see, it matched
  IDs to themes by their order in the brief. It said so, but the map was
  useless for a visual decision.

**Failures seen:**
- a provider outage (`401`) that showed on screen from the first second
  and surfaced only as `settled-no-report`;
- a CLI self-update at start.

### grok (grok-4.7)

**As implementer** (2 projects, 16 tasks):
- one web project: 12 tasks, median 12 min, max 26, and 3 slices needed
  another round;
- scripts and manifests from a narrow brief: 4 tasks, about 2 min on
  average, max 5.
- **Strong:**
  - fast;
  - large slices done in one go: 13 files, with proof that route code
    splitting still worked;
  - correct, lean SQL: one aggregation with the right indexes;
  - proof of time-zone and DST edges.
- **Weak:**
  - design shortcuts to make a test or the type check pass:
    - exported page components only for a test, which disabled route code
      splitting (P1);
    - hung a function on a DOM node;
    - justified a change with a compiler option the project did not set;
  - wrote eval answer keys without checking them against the fixture;
  - scripts needed security and cleanup fixes that the review found;
  - one pane gave no report after 9 min and was abandoned;
  - closed a task without reading a prompt sent to it mid-slice with a raw
    `herdr agent prompt`. The skill's way to add to a running slice is
    `dispatch --amend`, which asks for a new report.

**As documenter** (1 task, about 8 min): checked the code, and separated
what was committed from what was still in review.

### cursor running grok-4.7

**As reviewer** (5 projects, about 45 tasks; median or mean 3.8 to 9.4 min
per project, max 25). **As security-reviewer** (1 project, 3 tasks; about
17 min, max 26).
- **Strong:**
  - fast;
  - very precise when it can execute what it reviews: no false positive in
    7 reports in one project and 16 in another;
  - mutates in a throwaway copy outside the repository and shows the RED;
  - gives findings with a ready fix;
  - good at SQL, atomicity, tests, i18n and UX regressions, and at static
    contracts, such as a CSS selector against the attributes a component
    really emits;
  - no false test failures once the role said "run it before claiming it";
  - in one project, 3 of 6 reviews asked for fixes, with 3 P1 and 1 P2, all
    actionable.
- **Weak:**
  - little rigor when there is nothing to execute: in one project it passed
    3 of 4 slices that had real problems;
  - confident claims about runtime behaviour it cannot run: a P1 about
    shell semantics was half wrong;
  - reviews SQL and tests by their text. It had no large UI to review in
    the project where a claude reviewer found a UI-level P1, so its depth
    there is unknown;
  - in a directory with `direnv`, the TUI did not come up, and the brief
    was typed into the shell.

**As implementer** (2 projects: 3 spikes that need a server, about 23 min
typical and max 28; multi-file backend and extension slices in the other):
- **Strong:**
  - large multi-file slices with a clear report of files, tests and limits,
    and an explicit `[skipped]` for tests that must wait for a release tag;
  - research with execution: it cites source and documentation files and
    invents no flag;
  - found a bundler behaviour on its own;
  - left the server running with its PIDs, as asked.
- **Weak:**
  - fills its context fast: 70% in one spike;
  - one change dropped a flag when a later poll omitted it; the
    orchestrator caught it;
  - ran a package install at the repository root without saying so;
  - wrote a proof file inside a build output directory.

### claude (opus)

**As reviewer** (1 project, 7 tasks; median 5 min, max 10):
- **Strong:** the deepest reviewer seen, with no false positive.
  - Proved a UI P1 with the framework's own compiler.
  - Wrote probes that fail on the original code and pass on the fix.
  - Checked a commit message against the schema it described.
- **Weak:** marks `[partial]` on items that need a browser the brief
  forbade. That is correct by the contract, but it triggers the warning.

### pi with a small self-hosted model (~27B)

**As implementer** (1 project, 35 tasks; median 8 min, max 18):
- **Strong:**
  - follows the brief to the letter;
  - no invented name, flag or endpoint in 35 tasks, and no `Forbidden`
    violation;
  - pastes real command output: every declared test run that was checked
    had run;
  - stops with options (`[partial]`) instead of guessing.
- **Weak:**
  - fixes the instance, not the class. Slices on untrusted input (host,
    path, URL) came back twice each: first one variant, then the next;
  - did not validate manifests against an API server. Three errors showed
    up in a strict server dry-run and on a live apply, not in the slice;
  - once created a local cluster the brief did not ask for. The role now
    forbids this.

**As scouter or researcher** (9 tasks; median 10 to 15 min): with the
lookup directive, the surveys were ready for a decision. It once claimed an
absence without searching.

**As documenter** (11 tasks; median 5 min): with the claims table, no round
back. Without it, it stated the plausible.

**As tasker** (2 tasks): 2 to 3 min.

### agy (gemini-3.8-flash)

**As implementer** (1 project, 3 tasks; mean 12 min, max 15, medium
effort): 2 fixes after review across the 3 slices; its `[partial]` items
were declared.

**As reviewer** (1 project, high effort; median about 4 min over all the
project's reviews):
- **Strong:**
  - found a real privacy P1 (a public cache header on authenticated
    content), with the place and the fix;
  - said what a test really proves, apart from what it seems to prove.
- **Weak:**
  - passed a change that dropped a flag when a later poll omitted it: a
    state change across requests, missed with confidence 1.0;
  - hit its individual quota once and resumed after the reset.

## Validation on the target machine

Outside the skill, the orchestrator of the desktop project asked a claude
on the Windows machine (`herdr --machine <m> agent prompt`) to run 7 native
validations:
- no false positive;
- 2 real findings that no worker saw: a test path separator, and an
  uninstall hook that killed every running instance;
- it stopped to ask when the machine differed from the brief.

Platform behaviour needs a run on the platform. A reviewer that cannot run
it should say so instead of guessing.

## Recommendation per role

- **implementer:**
  - `codex` for closed briefs and sensitive correctness (TDD,
    atomicity, payments, access control);
  - `grok` for speed on well-specified slices and scripts, with a
    reviewer that looks for design shortcuts and missing cleanup;
  - `cursor` for multi-file backend slices and spikes that need a server;
  - a small model for closed, low-risk slices;
  - slices on untrusted input need a stronger model, or a brief that lists
    the hostile variants to test.
- **designer and UI work with e2e:** a kind that can open a port and run a
  browser. Not `codex` inside its sandbox.
- **reviewer:** another family than the implementer (the rule that never
  moves):
  - `claude` for UI, architecture and integration;
  - `cursor`/`grok` for SQL, atomicity and tests;
  - `codex` when the implementer is `grok` or `cursor`, at `high` effort
    (`xhigh` for security and large slices);
  - `agy` at `high` for privacy and access-control reviews, with a check
    for a state change across requests; `agy` at `medium` for bounded UI.
    When its quota is spent, use another family;
  - for platform behaviour, a run on the target machine.
- **security-reviewer:** `cursor`/`grok` or `codex`, both precise when
  they could execute their probes.
- **scouter and researcher:**
  - `codex` or a small model when the evidence is text in the repository;
  - none of them when the evidence is visual and the images are not
    reachable. Map it yourself first.
- **documenter:** `codex`, `grok` or a small model, with the claims table.
  `grok` and a small model are the cheapest.

## Directives these observations already put in the roles

- The reviewer runs a test before calling it wrong, and may mutate or build
  only in a throwaway copy.
- The implementer:
  - writes the integration test the brief asks for even when it cannot run
    it (the codex network note);
  - runs mutation checks in a throwaway copy when the tree is shared;
  - never starts local infrastructure the brief did not ask for.
- Workers stop the processes they started by PID, and never list every
  process command line.
- The scouter and the researcher look up before they state; the documenter
  fills a claims table.
- The designer reports how the UI was verified (`ui_verification`).
