# Code review checklist

Applied by `/agile-refinement` in code-review mode. Every finding cites a file and
line and describes a concrete failure: the input or state, and the wrong result.

## Correctness

- [ ] The change does what the story's acceptance criteria say, on the edge cases too (empty, huge, unicode, concurrent, retried).
- [ ] No silent behavior change outside the stated scope.
- [ ] Errors are handled at system boundaries; no swallowed exceptions.
- [ ] State has one source of truth; no display bug "fixed" by duplicating data.

## Security

- [ ] Inputs validated and sanitized at trust boundaries.
- [ ] No SQL injection, XSS, command injection, path traversal, or SSRF.
- [ ] No hardcoded secrets; sensitive data not exposed in logs or responses.
- [ ] Authentication, authorization, and tenant or scope isolation correct when applicable.

## Tests

- [ ] Each acceptance criterion has a test or a recorded proof.
- [ ] New tests verify observable behavior and name the mutation they kill.
- [ ] No rejected shapes: "is defined" with no assertion, "was called" without the effect, "renders" with no DOM assertion, oversized unexplained snapshots, mocking the unit under test.
- [ ] A bug fix comes with a regression test that fails without the fix.

## Project coherence

- [ ] Follows the repository's patterns and conventions; no new variant of an existing pattern without reason.
- [ ] Uses existing components, utilities, and helpers.
- [ ] Naming and imports consistent with the codebase.
- [ ] Visible text goes through the project's localization mechanism when it has one.

## Scope and size

- [ ] Code does only what was requested; no unrelated refactors or extra features.
- [ ] No premature abstractions, no handling of impossible scenarios, no generalization for hypothetical needs.
- [ ] Formatter churn limited to files the project already formats.

## Completeness

- [ ] The diff was read in full.
- [ ] The author's verification results exist for the applicable contract items (the verdicts themselves are recorded at closure).
- [ ] Documentation updated when public behavior or API changed.
