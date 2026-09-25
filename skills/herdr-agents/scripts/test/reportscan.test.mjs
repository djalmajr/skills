// reportscan: the units the acceptance criterion lists — partialCount on a
// table with the [partial] marker, a list, a header, upper case, one line
// with two markers (counts once), bare-word prose (the contract quote
// "done / partial / skipped", "no item is partial", `partially`,
// `impartial`: 0), the backticked state quote line (counts 1 — acceptable,
// documented), fenced code blocks (``` and ~~~, 0), a suffixed fence line
// (```js) inside a block that must not close it, and partialCountFile on
// a missing or unreadable file (0). The pure function is exercised
// in-process; no herdr is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { partialCount, partialCountFile, reviewHeader } from '../lib/reportscan.mjs';

test('partialCount: a table, a list and a header count their [partial] lines', () => {
  const table = [
    '# Report',
    '',
    '| item | state |',
    '| --- | --- |',
    '| read the brief | [done] |',
    '| fact A | [partial] |',
    '| fact B | [partial] |',
    '',
  ].join('\n');
  // Mutation captured: counting occurrences instead of lines (or not
  // matching the table row marker at all) changes the count below.
  assert.equal(partialCount(table), 2, 'two table rows mark two items');
  const list = [
    '## Results',
    '- fact A: [partial] — the source was not reachable',
    '- fact B: [done]',
    '- fact C: [skipped] — not in scope',
  ].join('\n');
  assert.equal(partialCount(list), 1, 'a list line marks one item');
  const header = '# [partial] — could not verify the external fact\n\ndone.\n';
  assert.equal(partialCount(header), 1, 'a header line counts');
  // Mutation captured: matching the bare word instead of the marker (or
  // only the table shape) breaks one of the three asserts above.
});

test('partialCount: the marker is case-insensitive', () => {
  assert.equal(partialCount('[PARTIAL]: the doc is missing\n'), 1);
  assert.equal(partialCount('[Partial] — left for later\n[partial] again\n'), 2);
  // Mutation captured: a case-sensitive marker pattern leaves the
  // upper-case report with no partial item and the orchestrator treats it
  // as a pass.
});

test('partialCount: a line with two markers counts once', () => {
  const oneLine = '**Estado:** [partial] — e o segundo: [partial]\n';
  assert.equal(partialCount(oneLine), 1, 'one marked line, no matter the markers');
  const mixed = 'a [partial] item: [partial] again\none more\n';
  assert.equal(partialCount(mixed), 1);
  // Mutation captured: counting markers instead of lines returns 2 and 2
  // on the two inputs above. (The marker is in a state position — table
  // cell, then a colon — a mention mid-sentence would not count.)
});

test('partialCount: bare-word prose does not count (the P1 regression)', () => {
  // A real report quoted the contract and the states many times; a single
  // [partial] item must still count 1, not every prose occurrence.
  const report = [
    '# Report',
    '',
    'For every item in the brief: `done` / `partial` / `skipped` + reason.',
    'When the brief does not decide something, mark the item partial and list the gap.',
    'No item is partial except the one below.',
    'The review was partially done; the verdict was impartial.',
    '',
    '## Items',
    '',
    '- read the brief [done]',
    '- the external fact: [partial] — could not verify it',
    '- re-run the checks [skipped] — not in scope',
  ].join('\n');
  // Mutation captured: matching the bare word `partial` instead of the
  // marker counts the prose lines too (14-ish, not 1).
  assert.equal(partialCount(report), 1, 'prose with the bare word never counts');
  assert.equal(partialCount('done / partial / skipped\n'), 0, 'the state list itself');
  assert.equal(partialCount('the review was partially done\n'), 0, '`partially` is not a marker');
  assert.equal(partialCount('the verdict was impartial\n'), 0, '`impartial` is not a marker');
});

test('partialCount: a quote of the state list is not an item state', () => {
  // A line with all three markers quotes the list the contract gives; it
  // marks no item. An item line with the marker still counts, even when it
  // names another state in its reason.
  const quote = '`[done]`, `[partial]` or `[skipped]`\n';
  assert.equal(partialCount(quote), 0, 'the quoted state list does not count');
  assert.equal(partialCount('Estados: [done] / [partial] / [skipped] + reason\n'), 0, 'the list in another shape');
  assert.equal(partialCount('| 2 | fact | [partial] | depends on item 1, which is [done] |\n'), 1,
    'an item marked partial counts even when its reason names another state');
  assert.equal(partialCount('| 3 | `[partial]` | not verified |\n'), 1, 'a backticked item state counts');
  // Mutation captured: dropping the quote rule counts the first two lines;
  // requiring the line to have no other marker at all drops the third.
});

test('partialCount: fenced code blocks do not count, outside lines still do', () => {
  const backticks = [
    'before: [partial]',
    '```',
    'a code block with [partial] inside',
    'and another [partial] line',
    '```',
    'after: [partial]',
  ].join('\n');
  // Mutation captured: counting inside a code block (or forgetting the
  // fence lines delimit the block) returns 4 here instead of 2.
  assert.equal(partialCount(backticks), 2, 'only the lines outside the ``` block');
  const tildes = [
    '~~~',
    '[partial] in a tilde fence',
    '~~~',
    '[partial] outside',
  ].join('\n');
  assert.equal(partialCount(tildes), 1, 'the ~~~ fence delimits too');
  // A different fence character does not close the block.
  const mixedFence = ['```', '[partial]', '~~~', '[partial]', '```'].join('\n');
  assert.equal(partialCount(mixedFence), 0, '~~~ does not close a ``` block');
  // The fence line itself never counts, even when it carries the marker.
  const fenceWord = '```[partial]\n```\ndone\n';
  assert.equal(partialCount(fenceWord), 0);
});

test('partialCount: a suffixed fence line inside a block does not close it (the P2 case)', () => {
  // ```js inside a ``` block is content: only the same character with a
  // run at least as long and nothing but spaces after it closes.
  const suffixed = [
    '```',
    '[partial] in the block',
    '```js',
    'still inside — the suffixed fence does not close',
    '```',
    '[partial] after the real close',
  ].join('\n');
  // Mutation captured: letting a suffixed fence line close the block
  // counts the "still inside" content (1 here instead of 1 → the line
  // after the real close would then be the only one, and a marker between
  // the suffixed line and the close would be counted).
  assert.equal(partialCount(suffixed), 1, 'only the line after the real close');
  // A shorter run of the same character does not close a longer opening.
  const longerOpen = ['~~~~', '[partial]', '```', '[partial]', '~~~~'].join('\n');
  assert.equal(partialCount(longerOpen), 0, 'a 3-run does not close a 4-run block');
  // An unclosed fence keeps everything after it out of the count.
  const unclosed = '```\n[partial]\n[partial]\n';
  assert.equal(partialCount(unclosed), 0, 'unclosed fence: the rest is inside');
});

test('partialCount: the marker counts only in a state position, not when mentioned', () => {
  // A mention mid-sentence names the marker without stating an item's
  // state — it does not count. The state positions: line start (after
  // optional spaces and one block marker: list/heading/quote/task box),
  // a table cell edge, or a colon/dash with a space before the marker.
  // Mutation captured: accepting the marker in ANY position (the rule
  // before the state-position fix) counts the mentions below.
  assert.equal(partialCount('soma de `[partial]` (via `partialCount` de reportscan)\n'), 0,
    'a backticked mention mid-sentence (the report line that over-counted)');
  assert.equal(partialCount('a mention of [partial] in prose\n'), 0, 'a bare mention in prose');
  assert.equal(partialCount('- [partial] item\n'), 1, 'a list item at the line start');
  assert.equal(partialCount('| 2 | fact | [partial] | …\n'), 1, 'a table cell');
  assert.equal(partialCount('| 3 | `[partial]` | …\n'), 1, 'a backticked table cell');
  assert.equal(partialCount('**Estado:** [partial] — …\n'), 1, 'after a colon');
  assert.equal(partialCount('### B.3 — **[partial]**\n'), 1, 'after an em dash, bold-wrapped');
  assert.equal(partialCount('1. [partial] …\n'), 1, 'a numbered list item');
  assert.equal(partialCount('> [partial] …\n'), 1, 'a quote');
  // Block markers the state position accepts at the line start.
  assert.equal(partialCount('* [partial] star list\n'), 1, 'a `*` list item');
  assert.equal(partialCount('+ [partial] plus list\n'), 1, 'a `+` list item');
  assert.equal(partialCount('[ ] [partial] task box\n'), 1, 'a task box');
  assert.equal(partialCount('# [partial] heading\n'), 1, 'a heading');
  // Dashes: en dash and hyphen-with-spaces are state positions too.
  assert.equal(partialCount('### B.4 – [partial]\n'), 1, 'after an en dash');
  assert.equal(partialCount('item - [partial] fallback\n'), 1, 'after a space-hyphen-space');
  // A mention and a state marker on the same line count once.
  assert.equal(partialCount('menção a `[partial]` no texto; o estado real: [partial]\n'), 1, 'the state marker wins, once');
  // The rules that stay: the state-list quote and the fences.
  assert.equal(partialCount('`[done]`, `[partial]` or `[skipped]`\n'), 0, 'the quoted state list still never counts');
  assert.equal(partialCount('```\n`[partial]` inside a fence does not count\n```\n[partial]\n'), 1, 'the fence still delimits');
});

test('partialCount: empty text counts 0', () => {
  assert.equal(partialCount(''), 0);
  assert.equal(partialCount('\n\n  \n'), 0, 'blank lines count nothing');
  // Mutation captured: an off-by-one or a "first line" default returns a
  // nonzero count on the empty text.
});

test('partialCountFile: a readable file counts, a missing or unreadable file counts 0', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ha-reportscan-')));
  try {
    const p = path.join(root, 'report.md');
    fs.writeFileSync(p, '| x | [partial] |\n| y | [partial] |\n');
    assert.equal(partialCountFile(p), 2, 'the file content counts');
    // A missing file and a path that is not a readable file both count 0
    // (the scan is best effort: the report still settles done).
    // Mutation captured: re-throwing the read failure (or counting 1 for
    // an absent file) breaks one of the asserts below.
    assert.equal(partialCountFile(path.join(root, 'absent.md')), 0, 'missing file');
    assert.equal(partialCountFile(root), 0, 'a directory is not a readable report');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------- reviewHeader (the review report's first line) ----------

// The header is accepted ONLY on the first non-empty line, case-
// insensitive, leading/trailing whitespace of the line ignored. A header
// deeper in the report does not count (null), and the numbers are kept as
// parsed (findings is never re-derived from the P0..P3 sum).
test('reviewHeader: the first non-empty line only, tolerant of case and whitespace', () => {
  assert.equal(reviewHeader(''), null, 'empty report');
  assert.equal(reviewHeader('   \n\n  \n'), null, 'only blank lines');
  assert.equal(reviewHeader('# Report\n\ndone.\n'), null, 'a plain report has no header');
  // Mutation captured: accepting the header on ANY line (scanning past a
  // non-matching first non-empty line) returns an object here; the header
  // must be the first non-empty line of the file.
  assert.equal(reviewHeader('# Report\n\ndone.\nfindings: 1 (P0 1, P1 0, P2 0, P3 0) | verdict: fail\n'),
    null, 'a header after other content is not the report header');
  assert.deepEqual(reviewHeader('findings: 1 (P0 1, P1 0, P2 0, P3 0) | verdict: fail\n# Report\n'),
    { findings: 1, severity: { P0: 1, P1: 0, P2: 0, P3: 0 }, verdict: 'fail' },
    'the header first, the report after it');
  assert.deepEqual(reviewHeader('findings: 0 (P0 0, P1 0, P2 0, P3 0) | verdict: pass\n'),
    { findings: 0, severity: { P0: 0, P1: 0, P2: 0, P3: 0 }, verdict: 'pass' });
  assert.deepEqual(reviewHeader('  Findings: 3 (P0 0, P1 1, P2 2, P3 0) | Verdict: FAIL  \n\nrest of the report\n'),
    { findings: 3, severity: { P0: 0, P1: 1, P2: 2, P3: 0 }, verdict: 'fail' },
    'case-insensitive, leading/trailing whitespace ignored');
  assert.equal(reviewHeader('findings: 2  (P0 1, P1 1, P2 0, P3 0) | verdict: pass\n'),
    null, 'extra internal spaces are not the format');
  assert.equal(reviewHeader('findings: 2 (P0 1, P1 1, P2 0, P3 0) | verdict: blocked\n'),
    null, 'only pass|fail verdicts');
  assert.equal(reviewHeader('findings: 2 (P0 1, P1 1) | verdict: pass\n'),
    null, 'all four severities are required');
});
