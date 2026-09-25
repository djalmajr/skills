// Report scan: count the report lines that mark a `partial` item, so a
// finished worker's report is never mistaken for a pass while it still
// holds items the worker could not verify. The report contract fixes a
// per-item state marker — every item carries `[done]`, `[partial]` or
// `[skipped]` followed by the reason — so the scan looks only for the
// marker, never for the bare word (contract quotes and prose such as
// "no item is partial" must not count).
import { readTextFile } from './platform.mjs';

// Number of lines of `text` that mark a `partial` item: the `[partial]`
// marker (case-insensitive, optionally wrapped in backticks and/or `**`),
// on lines outside fenced code blocks (``` or ~~~ fences). A line counts
// at most once — the count is the number of marked lines, not the number
// of markers. The bare word `partial` (or a line that only embeds it in
// another word) does not mark an item, and neither does a line that
// carries all three markers — that is a quote of the state list, not an
// item's state. Empty text counts 0.
//
// A marker only counts in a STATE POSITION — a mention mid-sentence
// ("soma de `[partial]` …") names the marker without stating an item's
// state, and does not count. The marker is in a state position when it is
// preceded by:
//   1. the start of the line — after optional spaces and at most one block
//      marker: a list bullet (`-`, `*`, `+`, `1.`), a heading (`#…`), a
//      quote (`>`) or a task box (`[ ]`/`[x]`);
//   2. a table cell edge — `|` plus spaces before, with the cell ending
//      right after the marker (`|`, spaces, or end of line);
//   3. a colon or a dash with a space — `:`, `—`, `–` or `-` right before
//      the spaces that precede the marker (e.g. `**Estado:** [partial]`,
//      `### B.3 — **[partial]**`).
//
// Fence rules: an opening fence is 3+ backticks or tildes (up to three
// leading spaces) and may carry an info string. A block only closes with
// the same character, a run at least as long as the opening one, and
// nothing but spaces after the run — a ```js line inside a block is
// content, not a close. Fence lines themselves never count.

// The marker, optionally wrapped in backticks and/or `**` (in either
// order). Global: reset lastIndex before each line.
const PARTIAL_MARKER_RE = /[\`*]*\[partial\][\`*]*/gi;
// Start of line: optional spaces, at most one block marker, spaces.
const STATE_BEFORE_RE = /^[ \t]*(?:[-*+][ \t]+|\d+\.[ \t]+|#{1,6}[ \t]+|>[ \t]*|\[[ xX]\][ \t]+)?[ \t]*$/;
// Table cell edge: the `|` (plus spaces) right before the marker…
const CELL_BEFORE_RE = /\|[ \t]*$/;
// …with the cell ending right after it (spaces then `|` or end of line).
const CELL_AFTER_RE = /^[ \t]*(?:\||$)/;
// A colon or a dash (hyphen, en dash, em dash) with a space before the
// marker — the colon/dash may be wrapped in closing `**`/backticks right
// up to the space (e.g. `**Estado:** [partial]`).
const DASH_BEFORE_RE = /[:\u2014\u2013-][\`*]*[ \t]+$/;

function markerInStatePosition(line) {
  PARTIAL_MARKER_RE.lastIndex = 0;
  let m;
  while ((m = PARTIAL_MARKER_RE.exec(line)) !== null) {
    const before = line.slice(0, m.index);
    const after = line.slice(m.index + m[0].length);
    if (STATE_BEFORE_RE.test(before)) return true;
    if (CELL_BEFORE_RE.test(before) && CELL_AFTER_RE.test(after)) return true;
    if (DASH_BEFORE_RE.test(before)) return true;
  }
  return false;
}
export function partialCount(text) {
  if (typeof text !== 'string' || text === '') return 0;
  let n = 0;
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  for (const line of text.split('\n')) {
    const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!inFence && open) {
      inFence = true;
      fenceChar = open[1][0];
      fenceLen = open[1].length;
      continue;
    }
    if (inFence) {
      // Same character, run at least as long as the opening one, and only
      // spaces after the run — otherwise the line is content (including a
      // different-character run) and never counts.
      const close = line.match(/^ {0,3}(`{3,}|~{3,}) *$/);
      if (close && close[1][0] === fenceChar && close[1].length >= fenceLen) {
        inFence = false;
      }
      continue;
    }
    if (!/\[partial\]/i.test(line)) continue;
    if (/\[done\]/i.test(line) && /\[skipped\]/i.test(line)) continue; // the state list quoted
    if (!markerInStatePosition(line)) continue; // a mention, not an item's state
    n += 1;
  }
  return n;
}

// partialCount of the report file at `p` (CRLF-normalized, like the rest
// of the read path): an unreadable or missing file counts 0 — the report
// still settles done, the scan is best effort.
export function partialCountFile(p) {
  try { return partialCount(readTextFile(p)); } catch { return 0; }
}

// A review report opens with a header line — the first non-empty line of
// the file, case-insensitive, leading/trailing whitespace of the line
// ignored, single spaces exactly as in the format:
//   findings: <N> (P0 <a>, P1 <b>, P2 <c>, P3 <d>) | verdict: pass|fail
// Only the first non-empty line is inspected; when it does not match
// return null (a header deeper in the report does not count). The numbers
// are kept as parsed — `findings` is never re-derived from the P0..P3
// sum (wait warns on the mismatch, it does not fix the report).
const REVIEW_HEADER_RE = /^findings: (\d+) \(P0 (\d+), P1 (\d+), P2 (\d+), P3 (\d+)\) \| verdict: (pass|fail)$/i;

export function reviewHeader(text) {
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    const m = REVIEW_HEADER_RE.exec(line);
    if (!m) return null;
    return {
      findings: Number(m[1]),
      severity: { P0: Number(m[2]), P1: Number(m[3]), P2: Number(m[4]), P3: Number(m[5]) },
      verdict: m[6].toLowerCase(),
    };
  }
  return null;
}
