#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const wikiInit = join(here, "wiki-init.ts");

execFileSync("bun", [wikiInit, "doctor", ...process.argv.slice(2)], {
  stdio: "inherit",
});
