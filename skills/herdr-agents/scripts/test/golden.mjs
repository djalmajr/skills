// Golden values for the parity tests: the normalized JS result per scenario
// is stored once in test/golden/<suite>.json, and the tests compare the JS
// against that stored value.
//
//   HERDR_AGENTS_GOLDEN unset   compare the JS value with the stored value;
//                               a missing entry fails.
//   HERDR_AGENTS_GOLDEN=update  write the JS value: an intentional change,
//                               reviewed through the diff of the golden file.
//
// A value is anything JSON can hold (per-step rc/stdout/stderr, file
// contents, call logs). Temporary roots differ on every run, so values go
// through normalizeRoots before they are compared or written.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GOLDEN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'golden');

export function goldenMode() {
  const v = process.env.HERDR_AGENTS_GOLDEN ?? '';
  if (v === '') return 'check';
  if (v === 'update') return 'update';
  throw new Error(`HERDR_AGENTS_GOLDEN must be unset or update (got '${v}')`);
}

const cache = new Map();

function goldenFile(suite) {
  return path.join(GOLDEN_DIR, `${suite}.json`);
}

function load(suite) {
  if (!cache.has(suite)) {
    let data = {};
    try { data = JSON.parse(fs.readFileSync(goldenFile(suite), 'utf8')); } catch { /* none yet */ }
    cache.set(suite, data);
  }
  return cache.get(suite);
}

// Object keys sorted at every level (arrays keep their order), so the same
// value always serializes the same way whatever the directory enumeration
// order that produced it.
export function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canonical(v[k]);
    return o;
  }
  return v;
}

function save(suite) {
  fs.mkdirSync(GOLDEN_DIR, { recursive: true });
  fs.writeFileSync(goldenFile(suite), `${JSON.stringify(canonical(cache.get(suite)), null, 2)}\n`);
}

// golden(suite, key, actual): in check mode assert that `actual()` equals
// the stored value; in update mode store `actual()`.
export function golden(suite, key, actual) {
  const mode = goldenMode();
  const data = load(suite);
  const value = actual();
  if (mode === 'update') {
    data[key] = value;
    save(suite);
    return;
  }
  assert.ok(Object.hasOwn(data, key),
    `${suite} › ${key}: no golden entry (run with HERDR_AGENTS_GOLDEN=update and review the diff)`);
  assert.deepEqual(value, data[key], `${suite} › ${key}: differs from test/golden/${suite}.json (JS value first)`);
}

// normalizeRoots(value, roots): replace every occurrence of each root (and
// of its realpath, e.g. /var → /private/var on macOS) in every string of
// `value` with its placeholder. `roots` maps placeholder → path; longer paths
// are replaced first so a root nested in another keeps its own placeholder.
export function normalizeRoots(value, roots) {
  const pairs = [];
  for (const [ph, p] of Object.entries(roots)) {
    if (!p) continue;
    pairs.push([p, ph]);
    let real = p;
    try { real = fs.realpathSync(p); } catch { /* may not exist */ }
    if (real !== p) pairs.push([real, ph]);
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  const fix = (s) => {
    let out = s;
    for (const [p, ph] of pairs) out = out.split(p).join(ph);
    return out;
  };
  const walk = (v) => {
    if (typeof v === 'string') return fix(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[fix(k)] = walk(x);
      return o;
    }
    return v;
  };
  return walk(value);
}
