// dialog (S5 item 2): dialogKind — the question-marker table per kind with
// the counterexamples from the decisions (codex "allow command?" / "press
// enter to confirm" are approvals; claude "Do you want to proceed?" with
// "❯ 1. Yes" is an approval; opencode with "permission required" is an
// approval; kinds without a known marker are never questions); questionText
// — the last 20 non-empty lines, right-trimmed, redacted, joined with \n,
// capped at 1200 characters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dialogKind, questionText } from '../lib/dialog.mjs';

test('dialogKind: the question-marker table with the counterexamples', () => {
  const rows = [
    // codex: its question footer (either marker), case-insensitive.
    ['codex', 'Choose an option:\n  1. Use the local cache\n  2. Fetch from remote\n\nEnter to submit answer, esc to cancel', 'question'],
    ['codex', 'Apply all changes?\n\nEnter to submit all, esc to cancel', 'question'],
    ['codex', 'SELECT LANE\n\nENTER TO SUBMIT ANSWER, ESC TO CANCEL', 'question'],
    // codex approvals: the counterexamples from the decisions.
    ['codex', 'Allow command? git push\n\n❯ 1. Yes, proceed\n  2. No\n\nPress enter to confirm or esc to cancel', 'approval'],
    // claude: "enter to select" AND ("to navigate" OR "submit answers").
    ['claude', 'Select an option (1-2):\n❯ 1. Use the local cache\n  2. Fetch remote\n\n↑↓ to navigate · Enter to select', 'question'],
    ['claude', 'Answer 1 of 2\n❯ 1. Yes\n  2. No\n\nEnter to select · Submit answers', 'question'],
    // claude approval: the counterexample — every positive marker present,
    // but "Do you want to" turns it back into an approval dialog.
    ['claude', 'Do you want to proceed?\n❯ 1. Yes\n  2. No\n\n↑↓ to navigate · Enter to select', 'approval'],
    ['claude', 'Do you want to proceed?\n❯ 1. Yes\n  2. No', 'approval'],
    // claude: each positive clause alone is not enough.
    ['claude', 'Type to navigate the list', 'approval'],
    ['claude', 'Enter to select a value', 'approval'],
    // opencode: "esc dismiss" AND ("enter submit" OR "enter toggle").
    ['opencode', '  1. Continue the plan\n  2. Stop\n\nEnter submit · Esc dismiss', 'question'],
    ['opencode', '  1. A\n  2. B\n\nEnter toggle · Esc dismiss', 'question'],
    // opencode approval: a permission prompt (the exclusion wins).
    ['opencode', 'Permission required: read /etc/hosts\n\nEnter submit · Esc dismiss', 'approval'],
    ['opencode', 'Bash command pending\n\nEsc dismiss', 'approval'],
    // kinds without a known marker: never a question.
    ['grok', 'Enter to submit answer, esc to cancel', 'approval'],
    ['cursor', 'Enter to select', 'approval'],
    ['agy', 'Esc dismiss · Enter submit', 'approval'],
    ['pi', 'Enter to submit answer, esc to cancel', 'approval'],
    ['gemini', 'Enter to submit answer', 'approval'],
    ['unknown-kind', 'anything at all', 'approval'],
    ['', 'anything at all', 'approval'],
    // an empty screen is an approval (today's behavior).
    ['codex', '', 'approval'],
  ];
  // Mutation captured: dropping any marker or exclusion (e.g. the claude
  // "do you want to" or the opencode "permission required" exclusion, or
  // reading the screen case-sensitively) turns one of the rows above into
  // the wrong kind.
  for (const [kind, screen, want] of rows) {
    assert.equal(dialogKind(kind, screen), want, `${kind}: ${screen}`);
  }
});

test('questionText: last 20 non-empty lines, trimmed, redacted, 1200 cap', () => {
  // Only the last 20 non-empty lines are kept.
  const many = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const got = questionText(many);
  assert.equal(got.split('\n').length, 20);
  assert.equal(got.split('\n')[0], 'line 6', 'the oldest 5 lines are dropped');
  // Blank lines are dropped and trailing whitespace trimmed.
  assert.equal(questionText('a   \n\nb\t\nc\n'), 'a\nb\nc');
  // Every line passes through redactSecrets.
  assert.equal(questionText('token=abc123\nkey sk_live_abcdefghijklmnop here\nBearer zz9.999 and more\n'),
    'token=[redacted]\nkey [redacted] here\nBearer [redacted] and more');
  // The 1200-character cap is applied after the join (separators included).
  const long = 'x'.repeat(500);
  const capped = questionText(`${long}\n${long}\n${long}\n`);
  assert.equal(capped.length, 1200);
  assert.equal(capped, 'x'.repeat(500) + '\n' + 'x'.repeat(500) + '\n' + 'x'.repeat(198));
  // Empty screens.
  assert.equal(questionText(''), '');
  assert.equal(questionText('\n\n   \n\t\n'), '');
});
