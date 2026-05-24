// validate-schema.test.ts — unit tests for the validate-schema script.
// Run via: bun test scripts/validate-schema.test.ts

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { validate } from "./validate-schema";

const FIXTURES = resolve(import.meta.dir, "fixtures", "wiki");

describe("validate-schema", () => {
  test("valid ADR (full frontmatter) reports valid", () => {
    const report = validate({ wikiPath: FIXTURES });
    const adr = report.validations.decisions.find(
      (d) => d.path === "valid-proj/decisions/ADR-0001-keycloak.md",
    );
    expect(adr).toBeDefined();
    expect(adr!.valid).toBe(true);
    expect(adr!.errors).toBeUndefined();
    expect(adr!.id).toBe("ADR-0001");
    expect(adr!.project).toBe("valid-proj");
  });

  test("invalid ADR (missing status) reports schema error with field+message", () => {
    const report = validate({ wikiPath: FIXTURES });
    const adr = report.validations.decisions.find(
      (d) => d.path === "invalid-proj/decisions/ADR-0001-missing-status.md",
    );
    expect(adr).toBeDefined();
    expect(adr!.valid).toBe(false);
    expect(adr!.errors).toBeDefined();
    const statusError = adr!.errors!.find((e) => e.field === "status");
    expect(statusError).toBeDefined();
    expect(statusError!.message).toContain("required property 'status'");
  });

  test("duplicate IDs in same project are detected", () => {
    const report = validate({ wikiPath: FIXTURES });
    expect(report.summary.duplicate_ids).toBe(1);
    const dup = report.duplicate_ids[0];
    expect(dup.project).toBe("dup-proj");
    expect(dup.id).toBe("ADR-0001");
    expect(dup.paths).toHaveLength(2);
    expect(dup.paths).toContain("dup-proj/decisions/ADR-0001-a.md");
    expect(dup.paths).toContain("dup-proj/decisions/ADR-0001-b.md");
  });

  test("orphan ref (supersedes pointing to non-existent ADR) is detected", () => {
    const report = validate({ wikiPath: FIXTURES });
    expect(report.summary.orphan_refs).toBe(1);
    const orphan = report.orphan_refs[0];
    expect(orphan.in).toBe("orphan-proj/decisions/ADR-0001-references-orphan.md");
    expect(orphan.ref).toBe("ADR-9999");
    expect(orphan.reason).toContain("orphan-proj");
  });

  test("valid Rule (full frontmatter, filename without RULE- prefix) reports valid", () => {
    const report = validate({ wikiPath: FIXTURES });
    const rule = report.validations.rules.find(
      (r) => r.path === "valid-proj/rules/pii-tokenization.md",
    );
    expect(rule).toBeDefined();
    expect(rule!.valid).toBe(true);
    expect(rule!.id).toBe("RULE-pii-tokenization");
  });

  test("valid event (etl-run + decision-created kinds) reports valid", () => {
    const report = validate({ wikiPath: FIXTURES });
    const events = report.validations.events.filter((e) =>
      e.path.startsWith("valid-proj/"),
    );
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.valid)).toBe(true);
    expect(events.find((e) => e.line === 1)!.kind).toBe("etl-run");
    expect(events.find((e) => e.line === 2)!.kind).toBe("decision-created");
  });

  test("invalid event (missing ts) reports schema error", () => {
    const report = validate({ wikiPath: FIXTURES });
    const event = report.validations.events.find(
      (e) => e.path === "badevent-proj/history/events.jsonl" && e.line === 2,
    );
    expect(event).toBeDefined();
    expect(event!.valid).toBe(false);
    const tsError = event!.errors!.find((e) => e.field === "ts");
    expect(tsError).toBeDefined();
    expect(tsError!.message).toContain("required property 'ts'");
  });

  test("summary aggregates counts correctly + schema_version present", () => {
    const report = validate({ wikiPath: FIXTURES });
    expect(report.schema_version).toBe("1.0.0");
    expect(report.summary.valid).toBeGreaterThanOrEqual(8); // 4 dup-proj + 1 orphan-proj + 1 valid ADR + 1 rule + 1 valid event line + 1 etl-run badevent
    expect(report.summary.invalid).toBe(2); // missing-status + badevent line 2
    expect(report.summary.duplicate_ids).toBe(1);
    expect(report.summary.orphan_refs).toBe(1);
  });
});
