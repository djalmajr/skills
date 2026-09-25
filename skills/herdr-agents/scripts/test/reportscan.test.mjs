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
import { partialCount, partialCountFile } from '../lib/reportscan.mjs';

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
  const oneLine = 'fact A and fact B are both [partial] here\n';
  assert.equal(partialCount(oneLine), 1, 'one marked line, no matter the markers');
  const mixed = 'a [partial] item: [partial] again\none more\n';
  assert.equal(partialCount(mixed), 1);
  // Mutation captured: counting markers instead of lines returns 2 and 2
  // on the two inputs above.
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
    '- the external fact [partial] — could not verify it',
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
