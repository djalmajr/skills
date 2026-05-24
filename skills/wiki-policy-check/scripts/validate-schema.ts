#!/usr/bin/env bun
// validate-schema.ts — Validates frontmatter of decisions/rules + lines of
// events.jsonl in a wiki target against the typed-schema defined in
// `<wiki>/_schemas/typed-schema.yaml`. See ADR-0009 for the schema spec.
//
// Exit codes:
//   0 = all valid (or wiki has no typed docs yet)
//   1 = invalid docs detected (schema errors, duplicate IDs, or orphan refs)
//   2 = execution error (schema file missing, glob failed, etc.)

import { readFileSync, existsSync } from "node:fs";
import { resolve, relative, basename } from "node:path";
import { parseArgs } from "node:util";
import Ajv, { type ValidateFunction } from "ajv";
import { load as yamlLoad, JSON_SCHEMA } from "js-yaml";
import { glob } from "glob";
import matter from "gray-matter";

// gray-matter uses js-yaml internally with DEFAULT_SCHEMA, which parses
// `date: 2026-05-22` as a Date object (via !!timestamp). We want plain
// strings so the JSON Schema `pattern` regex matches. Override the YAML
// engine to use JSON_SCHEMA (which has no !!timestamp tag).
const matterOptions = {
  engines: {
    yaml: (input: string) => yamlLoad(input, { schema: JSON_SCHEMA }),
  },
};

interface ValidationError {
  field: string;
  message: string;
}

interface DocValidation {
  path: string;
  valid: boolean;
  errors?: ValidationError[];
  id?: string;
  project?: string;
}

interface EventValidation {
  path: string;
  line: number;
  valid: boolean;
  errors?: ValidationError[];
  kind?: string;
}

interface OrphanRef {
  in: string;
  ref: string;
  reason: string;
}

interface DuplicateId {
  project: string;
  id: string;
  paths: string[];
}

interface Report {
  schema_version: string;
  summary: {
    valid: number;
    invalid: number;
    duplicate_ids: number;
    orphan_refs: number;
  };
  validations: {
    decisions: DocValidation[];
    rules: DocValidation[];
    events: EventValidation[];
  };
  duplicate_ids: DuplicateId[];
  orphan_refs: OrphanRef[];
}

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(2);
}

function parseSchema(yamlPath: string): {
  version: string;
  decision: object;
  rule: object;
  event: object;
} {
  if (!existsSync(yamlPath)) {
    fail(`schema not found at ${yamlPath}`);
  }
  const raw = readFileSync(yamlPath, "utf-8");
  const doc = yamlLoad(raw) as {
    version?: string;
    definitions?: { decision?: object; rule?: object; event?: object };
  };
  if (!doc?.definitions?.decision || !doc.definitions.rule || !doc.definitions.event) {
    fail(`schema at ${yamlPath} missing required definitions (decision, rule, event)`);
  }
  return {
    version: doc.version ?? "0.0.0",
    decision: doc.definitions.decision,
    rule: doc.definitions.rule,
    event: doc.definitions.event,
  };
}

function ajvErrorsToFields(errs: Ajv["errors"]): ValidationError[] {
  if (!errs) return [];
  return errs.map((e) => ({
    field: e.params?.missingProperty ?? e.instancePath.replace(/^\//, "") ?? "(root)",
    message: e.message ?? "validation failed",
  }));
}

function validateDocs(
  wikiPath: string,
  pattern: string,
  validator: ValidateFunction,
): DocValidation[] {
  const files = glob.sync(pattern, { cwd: wikiPath, absolute: true });
  return files.map((file) => {
    const raw = readFileSync(file, "utf-8");
    const parsed = matter(raw, matterOptions);
    const data = parsed.data;
    const ok = validator(data);
    return {
      path: relative(wikiPath, file),
      valid: !!ok,
      errors: ok ? undefined : ajvErrorsToFields(validator.errors),
      id: typeof data.id === "string" ? data.id : undefined,
      project: typeof data.project === "string" ? data.project : undefined,
    };
  });
}

function validateEvents(
  wikiPath: string,
  pattern: string,
  validator: ValidateFunction,
): EventValidation[] {
  const files = glob.sync(pattern, { cwd: wikiPath, absolute: true });
  const out: EventValidation[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf-8").split("\n");
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let data: unknown;
      try {
        data = JSON.parse(trimmed);
      } catch (e) {
        out.push({
          path: relative(wikiPath, file),
          line: idx + 1,
          valid: false,
          errors: [{ field: "(parse)", message: `invalid JSON: ${(e as Error).message}` }],
        });
        return;
      }
      const ok = validator(data);
      out.push({
        path: relative(wikiPath, file),
        line: idx + 1,
        valid: !!ok,
        errors: ok ? undefined : ajvErrorsToFields(validator.errors),
        kind: typeof (data as { kind?: string }).kind === "string"
          ? (data as { kind: string }).kind
          : undefined,
      });
    });
  }
  return out;
}

function findDuplicateIds(docs: DocValidation[]): DuplicateId[] {
  const groups = new Map<string, string[]>();
  for (const d of docs) {
    if (!d.id || !d.project) continue;
    const key = `${d.project}::${d.id}`;
    const arr = groups.get(key) ?? [];
    arr.push(d.path);
    groups.set(key, arr);
  }
  const dups: DuplicateId[] = [];
  for (const [key, paths] of groups) {
    if (paths.length > 1) {
      const [project, id] = key.split("::");
      dups.push({ project, id, paths });
    }
  }
  return dups;
}

function findOrphanRefs(decisions: DocValidation[], wikiPath: string): OrphanRef[] {
  // Build set of IDs per project from disk (re-parse to get supersedes/superseded_by/references)
  const idsByProject = new Map<string, Set<string>>();
  const docsWithRefs: Array<{
    path: string;
    project: string;
    refs: { field: string; value: string }[];
  }> = [];

  for (const d of decisions) {
    if (!d.project || !d.id) continue;
    const set = idsByProject.get(d.project) ?? new Set();
    set.add(d.id);
    idsByProject.set(d.project, set);

    // Re-parse to get refs
    const full = readFileSync(resolve(wikiPath, d.path), "utf-8");
    const fm = matter(full, matterOptions).data as Record<string, unknown>;
    const refs: { field: string; value: string }[] = [];
    if (typeof fm.supersedes === "string") {
      refs.push({ field: "supersedes", value: fm.supersedes });
    }
    if (typeof fm.superseded_by === "string") {
      refs.push({ field: "superseded_by", value: fm.superseded_by });
    }
    if (Array.isArray(fm.references)) {
      for (const r of fm.references) {
        if (typeof r === "string" && /^ADR-\d{4}$/.test(r)) {
          refs.push({ field: "references", value: r });
        }
      }
    }
    if (refs.length > 0) {
      docsWithRefs.push({ path: d.path, project: d.project, refs });
    }
  }

  const orphans: OrphanRef[] = [];
  for (const doc of docsWithRefs) {
    const set = idsByProject.get(doc.project) ?? new Set();
    for (const ref of doc.refs) {
      if (!set.has(ref.value)) {
        orphans.push({
          in: doc.path,
          ref: ref.value,
          reason: `${ref.value} not found in same project (${doc.project})`,
        });
      }
    }
  }
  return orphans;
}

function buildReport(wikiPath: string, schemaPath: string): Report {
  const schema = parseSchema(schemaPath);
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validateDecision = ajv.compile(schema.decision);
  const validateRule = ajv.compile(schema.rule);
  const validateEvent = ajv.compile(schema.event);

  const decisions = validateDocs(wikiPath, "*/decisions/ADR-*.md", validateDecision);
  const rules = validateDocs(wikiPath, "*/rules/*.md", validateRule);
  const events = validateEvents(wikiPath, "*/history/events.jsonl", validateEvent);

  const allDocs = [...decisions, ...rules];
  const duplicateIds = findDuplicateIds(allDocs);
  const orphanRefs = findOrphanRefs(decisions, wikiPath);

  const validCount =
    decisions.filter((d) => d.valid).length +
    rules.filter((r) => r.valid).length +
    events.filter((e) => e.valid).length;
  const invalidCount =
    decisions.filter((d) => !d.valid).length +
    rules.filter((r) => !r.valid).length +
    events.filter((e) => !e.valid).length;

  return {
    schema_version: schema.version,
    summary: {
      valid: validCount,
      invalid: invalidCount,
      duplicate_ids: duplicateIds.length,
      orphan_refs: orphanRefs.length,
    },
    validations: { decisions, rules, events },
    duplicate_ids: duplicateIds,
    orphan_refs: orphanRefs,
  };
}

function renderTable(report: Report): string {
  const lines: string[] = [];
  lines.push(`# Wiki Typed-Schema Validation (schema ${report.schema_version})\n`);
  lines.push(
    `Summary: ${report.summary.valid} valid, ${report.summary.invalid} invalid, ` +
      `${report.summary.duplicate_ids} duplicate IDs, ${report.summary.orphan_refs} orphan refs\n`,
  );

  const renderDocSection = (title: string, docs: DocValidation[]) => {
    if (docs.length === 0) return;
    lines.push(`## ${title} (${docs.length})\n`);
    for (const d of docs) {
      const status = d.valid ? "✓" : "✗";
      lines.push(`  ${status} ${d.path}` + (d.id ? `  [${d.project}/${d.id}]` : ""));
      if (!d.valid && d.errors) {
        for (const e of d.errors) {
          lines.push(`      - ${e.field}: ${e.message}`);
        }
      }
    }
    lines.push("");
  };

  renderDocSection("Decisions", report.validations.decisions);
  renderDocSection("Rules", report.validations.rules);

  if (report.validations.events.length > 0) {
    lines.push(`## Events (${report.validations.events.length})\n`);
    for (const e of report.validations.events) {
      const status = e.valid ? "✓" : "✗";
      lines.push(`  ${status} ${e.path}:${e.line}` + (e.kind ? `  [kind=${e.kind}]` : ""));
      if (!e.valid && e.errors) {
        for (const err of e.errors) {
          lines.push(`      - ${err.field}: ${err.message}`);
        }
      }
    }
    lines.push("");
  }

  if (report.duplicate_ids.length > 0) {
    lines.push(`## Duplicate IDs (${report.duplicate_ids.length})\n`);
    for (const d of report.duplicate_ids) {
      lines.push(`  ${d.project}/${d.id}: ${d.paths.join(", ")}`);
    }
    lines.push("");
  }

  if (report.orphan_refs.length > 0) {
    lines.push(`## Orphan References (${report.orphan_refs.length})\n`);
    for (const o of report.orphan_refs) {
      lines.push(`  ${o.in} → ${o.ref}: ${o.reason}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// Library entry point — used by tests
export function validate(opts: { wikiPath: string; schemaPath?: string }): Report {
  const wikiPath = resolve(opts.wikiPath);
  const schemaPath = opts.schemaPath ?? resolve(wikiPath, "_schemas", "typed-schema.yaml");
  return buildReport(wikiPath, schemaPath);
}

// CLI entry point
function main(): void {
  const { values } = parseArgs({
    options: {
      "wiki-path": { type: "string" },
      format: { type: "string", default: "json" },
      "schema-path": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help || !values["wiki-path"]) {
    console.error(`Usage: bun validate-schema.ts --wiki-path <path> [--format json|table] [--schema-path <path>]

Validates frontmatter of decisions/rules + events.jsonl lines in <wiki-path>
against the typed-schema at <wiki-path>/_schemas/typed-schema.yaml (or --schema-path).

Exit codes:
  0 = all valid (or no docs found)
  1 = invalid docs detected (schema errors, duplicate IDs, or orphan refs)
  2 = execution error (schema missing, etc.)`);
    process.exit(values.help ? 0 : 2);
  }

  const wikiPath = resolve(values["wiki-path"]);
  const schemaPath = values["schema-path"]
    ? resolve(values["schema-path"])
    : resolve(wikiPath, "_schemas", "typed-schema.yaml");

  const format = values.format ?? "json";
  if (format !== "json" && format !== "table") {
    fail(`unknown format: ${format} (expected json or table)`);
  }

  const report = buildReport(wikiPath, schemaPath);
  if (format === "json") {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(renderTable(report));
  }

  const hasFailures =
    report.summary.invalid > 0 ||
    report.summary.duplicate_ids > 0 ||
    report.summary.orphan_refs > 0;
  process.exit(hasFailures ? 1 : 0);
}

// Run main only when invoked as CLI (not when imported by tests)
if (import.meta.main) {
  main();
}
