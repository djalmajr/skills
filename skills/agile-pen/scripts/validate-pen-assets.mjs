#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildInventory, catalogDir, catalogSources, stableJson } from "./lib/catalog.mjs";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function checksum(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

const taxonomy = await readJson(join(catalogDir, "taxonomy.json"));
const snapshots = await Promise.all(Object.entries(catalogSources).map(async ([source, definition]) => {
  const snapshot = await readJson(join(catalogDir, definition.file));
  requireCondition(snapshot.source === source, `${definition.file}: source mismatch`);
  const {checksum: expected, ...payload} = snapshot;
  requireCondition(expected === checksum(stableJson(payload)), `${definition.file}: checksum mismatch`);
  return snapshot;
}));
const expectedInventory = buildInventory(snapshots, taxonomy);
const inventory = await readJson(join(catalogDir, "inventory.json"));
requireCondition(stableJson(inventory) === stableJson(expectedInventory), "inventory.json does not match the official snapshots and taxonomy");
const officialCount = inventory.categories.reduce((total, category) => total + category.components.length, 0);
requireCondition(officialCount === 105, `expected 105 official registry:ui components, found ${officialCount}`);

const project = process.argv[2] ? resolve(process.argv[2]) : null;
if (project) {
  const generated = join(project, "design/generated");
  const componentManifestPath = join(generated, "components.manifest.json");
  const captureLockPath = join(generated, "capture.lock.json");
  if (existsSync(componentManifestPath) || existsSync(captureLockPath)) {
    requireCondition(existsSync(componentManifestPath) && existsSync(captureLockPath), "generated capture manifest and lock must exist together");
    const manifest = await readJson(componentManifestPath);
    const lock = await readJson(captureLockPath);
    requireCondition(lock.writer === "pencil-mcp-only", "capture lock must enforce Pencil MCP as the only .pen writer");
    requireCondition(lock.namingConvention === "Name (id)", "capture lock naming convention must be Name (id)");
    requireCondition(manifest.components.length === lock.components.length, "capture manifest and lock component counts differ");
    for (const component of manifest.components) {
      requireCondition(component.writer === "pencil-mcp-only", `${component.id}: invalid writer`);
      requireCondition(component.namingConvention === "Name (id)", `${component.id}: invalid naming convention`);
      for (const [kind, relativePath] of Object.entries(component.artifacts)) {
        if (!relativePath) continue;
        const path = join(generated, relativePath);
        requireCondition(existsSync(path), `${component.id}: missing ${kind} artifact`);
        requireCondition(component.checksums[kind] === checksum(await readFile(path)), `${component.id}: ${kind} checksum mismatch`);
      }
    }
  }
  const validationPath = join(generated, "validation.manifest.json");
  if (existsSync(validationPath)) {
    const validation = await readJson(validationPath);
    requireCondition(validation.writer === "pencil-mcp-evidence", "validation manifest writer must be pencil-mcp-evidence");
    requireCondition(validation.semantic?.passed === true && validation.semantic.refs?.length > 0, "semantic ref gate did not pass");
    requireCondition(validation.layout?.passed === true && validation.layout.problems === 0, "layout gate did not pass");
    requireCondition(validation.layout.rootOverlaps === 0, "root overlap gate did not pass");
    requireCondition(validation.layout.namingViolations === 0, "Pencil naming gate did not pass");
    requireCondition(validation.layout.geometryViolations === 0, "root geometry gate did not pass");
    requireCondition(validation.layout.coherenceViolations === 0, "layout coherence gate did not pass");
    const layoutReportPath = resolve(project, validation.layout.report);
    requireCondition(existsSync(layoutReportPath), "missing layout audit report");
    const layoutReportSource = await readFile(layoutReportPath);
    requireCondition(checksum(layoutReportSource) === validation.layout.checksum, "layout audit report checksum mismatch");
    const layoutReport = JSON.parse(layoutReportSource);
    requireCondition(layoutReport.passed === true, "layout audit report did not pass");
    requireCondition(layoutReport.overlaps?.length === 0, "layout audit contains root overlaps");
    requireCondition(layoutReport.namingViolations?.length === 0, "layout audit contains naming violations");
    requireCondition(layoutReport.geometryViolations?.length === 0, "layout audit contains geometry violations");
    requireCondition(layoutReport.coherenceViolations?.length === 0, "layout audit contains coherence violations");
    for (const visual of validation.visual ?? []) {
      const reportPath = resolve(project, visual.report);
      requireCondition(existsSync(reportPath), `${visual.id}: missing visual report`);
      const source = await readFile(reportPath);
      requireCondition(checksum(source) === visual.checksum, `${visual.id}: visual report checksum mismatch`);
      const report = JSON.parse(source);
      requireCondition(report.gates?.passed === true, `${visual.id}: visual gate did not pass`);
    }
  }
}

console.log(`validated ${officialCount} official components in ${inventory.categories.length} categories`);
console.log("validated deterministic catalog checksums and taxonomy coverage");
console.log("Pencil layout, screenshot and semantic-ref gates must run through Pencil MCP after applying generated batches");
