// Report scan: count the report lines that mark a `partial` item, so a
// finished worker's report is never mistaken for a pass while it still
// holds items the worker could not verify. The report contract fixes a
// per-item state marker — every item carries `[done]`, `[partial]` or
// `[skipped]` followed by the reason — so the scan looks only for the
// marker, never for the bare word (contract quotes and prose such as
// "no item is partial" must not count).
import { readTextFile } from './platform.mjs';

// Number of lines of `text` that mark a `partial` item: the `[partial]`
// marker (case-insensitive), on lines outside fenced code blocks (``` or
// ~~~ fences). A line counts at most once — the count is the number of
// marked lines, not the number of markers. The bare word `partial` (or a
// line that only embeds it in another word) does not mark an item, and
// neither does a line that carries all three markers — that is a quote of
// the state list, not an item's state. Empty text counts 0.
//
// Fence rules: an opening fence is 3+ backticks or tildes (up to three
// leading spaces) and may carry an info string. A block only closes with
// the same character, a run at least as long as the opening one, and
// nothing but spaces after the run — a ```js line inside a block is
// content, not a close. Fence lines themselves never count.
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
