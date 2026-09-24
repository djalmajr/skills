// Provider error / capacity detection: the screens where the model
// provider stopped (down, timeout, refused connection, HTTP 5xx, a cut
// stream) or refused the request because it was full. Follows the
// quota.mjs pattern: provider lines only, never on source-code lines,
// never while working. Case-sensitive error-word start (a lowercase
// `error:` is not an error line), a CRLF screen is normalized to LF
// before the line scan, and the matched line passes through
// redactSecrets and then sanitizeCause.
import { sanitizeCause, redactSecrets } from './text.mjs';
import { quotaLineIsCode } from './quota.mjs';

// A new attempt already in flight is not a settled stop:
// `API Error (Request timed out) · Retrying in 5 seconds…` never counts.
const RETRYING_RE = /retrying|retry in|will retry|reconnecting/i;

// Error line: the text, ignoring leading whitespace, starts with `Error`,
// `ERROR` or `API Error` followed by `:`, a space or `(` — optionally
// after a marker (■ ✗ ✘ × ⚠ ● • ⎿ and whitespace, as in Claude Code's
// `⎿  API Error: …`). A marker alone does not make an error line: `•` and
// `●` open ordinary tool output (`• Ran curl … Connection error`). The
// exception is `■`, Codex's error glyph (`■ stream disconnected before
// completion: …`). `throw new Error(…)` never counts: the text must START
// with the error word.
const ERROR_START_RE = /^\s*(?:[■✗✘×⚠●•⎿]\s+)?(API Error|ERROR|Error)[: (]/;
const ERROR_GLYPH_RE = /^\s*■\s/;

// Only the bottom of the screen counts: an agent stopped by its provider
// shows the error just above its input box and footer, while an error it
// recovered from scrolls up under newer output. The last TAIL_LINES
// non-empty lines hold the error line plus any CLI's prompt and footer.
// Inside that tail, a line of agent output below the error (the tool and
// message bullets of Codex and Claude Code) means the agent went on after
// it: the scan stops there. A CLI whose output has no bullet (pi) can still
// show a recovered error in the tail when it stops within a few lines; that
// worker has no report either, and the cause shown is the last error seen.
const TAIL_LINES = 10;
const OUTPUT_BULLET_RE = /^\s*[•●⏺✓✔]\s/;

// capacity: the provider was full.
const CAPACITY_RES = [
  /"type"\s*:\s*"[A-Za-z0-9_]*(capacity|overload)[A-Za-z0-9_]*"/i,
  /\boverloaded\b/i,
  /\b(at|over) capacity\b/i,
  /\b529\b/,
];

// provider-error: the provider is down or the request failed in transit.
const PROVIDER_RES = [
  /Request timed out/i,
  /Connection error/i,
  /\bECONN(REFUSED|RESET)\b/,
  /connection (refused|reset)/i,
  /Retry failed after \d+ attempts?/i,
  /\b(500|502|503|504)\b\s*[:{(]/,
  /\b(Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out)\b/i,
  /stream disconnected before completion/i,
  /socket hang up/i,
  /fetch failed/i,
];

// providerDetect(): `state` is the agent state; `screen` the visible
// lines. Returns null when this is not a provider stop, else
// { status: 'capacity' | 'provider-error', cause }. The scan covers the
// last TAIL_LINES non-empty lines, bottom to top: the most recent matching
// line wins.
export function providerDetect(state, screen) {
  if (state === 'working') return null;
  let text = String(screen ?? '');
  if (!text) return null;
  text = text.replace(/\r\n/g, '\n');
  const lines = text.split('\n').filter((l) => l.trim() !== '').slice(-TAIL_LINES);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (RETRYING_RE.test(line)) continue;
    if (quotaLineIsCode(line)) continue;
    if (OUTPUT_BULLET_RE.test(line) && !ERROR_START_RE.test(line)) return null;
    if (!ERROR_GLYPH_RE.test(line) && !ERROR_START_RE.test(line)) continue;
    const cause = sanitizeCause(redactSecrets(line));
    if (CAPACITY_RES.some((re) => re.test(line))) return { status: 'capacity', cause };
    if (PROVIDER_RES.some((re) => re.test(line))) return { status: 'provider-error', cause };
  }
  return null;
}
