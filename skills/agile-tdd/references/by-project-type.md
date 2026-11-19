# Testing by project type

Pick the test layers for `VALIDATION.md` by archetype. Most repositories are several
at once (a desktop app is a UI layer, a pure-logic core, and a native backend), so
combine the sets. The acceptance bar in `SKILL.md` (observable behavior, named
mutation, rejected shapes) applies to every archetype; this guide is about which
extra techniques earn their cost.

## Identify the archetype by its signals

- **Pure inputs to deterministic outputs, often with a public format** → pure logic.
- **Crosses a trust or process boundary (filesystem, network, IPC) or handles untrusted input** → backend / boundary.
- **Renders a DOM, has props and events, conditional UI** → UI layer.
- **Shared mutable state, threads or locks, long-running process, or a shipped binary** → concurrent / desktop / CLI.
- **Mostly docs, templates, or configuration around an external tool** → docs / configuration / tool-wrapper package.

## 1. Pure logic (library, parser, converter)

- **High value:** property-based tests, differential tests against a reference
  implementation, the official conformance suite when the format has one,
  approval (golden) tests, metamorphic relations, pinned regressions.
- **Adversarial:** mutation testing pays most here; fuzzing for anything that takes untrusted bytes.
- **Usually overkill:** soak tests, end to end.

## 2. Backend / API / boundary

- **High value:** contract tests that keep both sides in sync; integration with the
  real dependency (database, HTTP, filesystem); security-boundary tests (path
  traversal, authorization, tenant or scope isolation).
- **Must fail a test:** removing a validation, ignoring a scoping key, duplicating a
  delivery or webhook, dropping a transaction or an idempotency key.
- **Add:** property-based tests on validators and canonicalizers; idempotency and
  ordering tests for retries and deduplication; fuzzing on deserializers.
- **Usually overkill:** visual regression.

## 3. UI layer

- **High value:** render tests on components with a small prop surface, asserting
  DOM or accessibility state; one named mutation per conditional rule; extract a
  smaller child or a pure function when the host is too heavy to mount.
- **Watch for shared module state:** mount two instances to catch cross-instance coupling.
- **Add:** fault injection for async I/O; end to end for the golden path only, asserting content.
- **Avoid:** "it renders" tests without assertions, large snapshots, testing library internals.

## 4. Concurrent core / desktop / CLI

- **High value:** stateful property-based tests for stores and state machines;
  race and schedule exploration for shared state behind locks; memory-safety tools
  for unsafe or FFI code.
- **Long-running processes:** soak and leak tests, nightly.
- **Performance-sensitive paths:** benchmark baselines with a regression gate.
- **CLI:** golden tests on stdout, stderr, and exit codes; property tests on argument parsing.

## 5. Docs / configuration / tool-wrapper package

Signals: mostly Markdown, templates, or configuration; thin scripts that drive an
external tool (a CLI, an API, a code generator).

- **High value:** a structural lint of the docs and manifests (required sections,
  links and paths that exist, names that match); running every documented command
  once; smoke tests against the real external tool, with a strict flag in CI so a
  missing tool fails instead of skipping.
- **Watch for:** smoke tests that still pass when the code they guard is broken —
  break the guarded code once (name the mutation) and confirm the smoke fails.
- **Usually overkill:** coverage targets, end to end beyond the documented commands.

## Every archetype

- Pin every counterexample a property test finds as a permanent regression.
- Keep a fast pre-commit gate (typecheck, unit, lint) and move heavy gates
  (mutation, end to end, soak) to CI, nightly, or release.
- Confirm a test hook actually fires by feeding it a real payload.
- Avoid shell tooling that works on one platform only (`sed -i`, `readlink -f`, `grep -P`).
