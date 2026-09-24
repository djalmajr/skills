// Question vs approval detection (S5 item 2): a worker stopped on a
// multiple-choice question (the ask-the-user tool) must never be
// auto-answered — the wait reports status `question` with the text and
// sends no key, with or without auto_approve. A confirmed blocked dialog
// is a question only when its visible screen (case-insensitive) carries
// the kind's question markers; every other blocked screen is an
// approval (today's auto-approve behavior). Kinds without a known marker
// (grok, cursor, agy, pi) are never questions.
import { redactSecrets } from './text.mjs';

// Question markers per kind, tested against the case-folded screen; every
// entry of the kind must match. codex: "enter to submit answer" OR "enter
// to submit all"; claude: "enter to select" AND ("to navigate" OR "submit
// answers"); opencode: "esc dismiss" AND ("enter submit" OR "enter
// toggle").
const QUESTION_MARKERS = {
  codex: [
    /enter to submit answer|enter to submit all/,
  ],
  claude: [
    /enter to select/,
    /to navigate|submit answers/,
  ],
  opencode: [
    /esc dismiss/,
    /enter submit|enter toggle/,
  ],
};
// Exclusions that turn a marker match back into an approval dialog.
const CLAUDE_NOT_QUESTION = /do you want to/;
const OPENCODE_NOT_QUESTION = /permission required/;

// 'question' | 'approval' — see the header for the marker table.
export function dialogKind(kind, screen) {
  const marks = QUESTION_MARKERS[kind];
  if (!marks) return 'approval';
  const text = String(screen ?? '').toLowerCase();
  if (kind === 'claude' && CLAUDE_NOT_QUESTION.test(text)) return 'approval';
  if (kind === 'opencode' && OPENCODE_NOT_QUESTION.test(text)) return 'approval';
  return marks.every((re) => re.test(text)) ? 'question' : 'approval';
}

// The text shown with a `question`: the last 20 non-empty lines of the
// screen, each right-trimmed and passed through redactSecrets, joined
// with \n, capped at 1200 characters.
export function questionText(screen) {
  const lines = String(screen ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l !== '');
  return lines.slice(-20).map((l) => redactSecrets(l)).join('\n').slice(0, 1200);
}
