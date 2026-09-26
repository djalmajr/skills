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
// Transient: worth a second probe before reporting (the wait double
// confirms these). `unexpected status` matches even without an HTTP
// reason phrase (R11: a bare `unexpected status 503` is a stop); a 401
// on the same line never reaches this list — the auth patterns above
// match first and report it as terminal.
const PROVIDER_RES = [
  /Request timed out/i,
  /Connection error/i,
  /\bECONN(REFUSED|RESET)\b/,
  /connection (refused|reset)/i,
  /Retry failed after \d+ attempts?/i,
  /\b(500|502|503|504)\b\s*[:{(]/,
  /\b(Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out)\b/i,
  /unexpected status/i,
  /stream disconnected before completion/i,
  /socket hang up/i,
  /fetch failed/i,
];

// auth: the provider refused the credentials — terminal, no retry or
// second probe will help. R11/D58: a stopped screen containing `401`,
// `Incorrect API key`, an `unexpected status` WITH a 401, or a revoked
// refresh token / failed access-token refresh (the Codex access-token
// refresh failure). Narrow on purpose: a non-401 unexpected status (e.g.
// `unexpected status 503`) stays a transient provider-error, and a
// `refresh` without a revoked token or a failed token refresh matches
// nothing. Checked after the capacity patterns (capacity always wins)
// and before the transient provider patterns; only ever evaluated on a
// line that already passed the error-line gate above, so source-code
// lines and ordinary tool output never reach it.
const AUTH_RES = [
  /\b401\b/,
  /unexpected status.*401|401.*unexpected status/i,
  /incorrect api key/i,
  /refresh token.*revok|revok.*refresh token/i,
  /failed to refresh.*token/i,
];

// providerDetect(): `state` is the agent state; `screen` the visible
// lines. Returns null when this is not a provider stop, else
// { status: 'capacity' | 'provider-error', cause, auth }: `auth` is true
// for a terminal credential failure (no retry will help) and false for a
// possibly-transient provider failure. The scan covers the
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
    if (CAPACITY_RES.some((re) => re.test(line))) return { status: 'capacity', cause, auth: false };
    if (AUTH_RES.some((re) => re.test(line))) return { status: 'provider-error', cause, auth: true };
    if (PROVIDER_RES.some((re) => re.test(line))) return { status: 'provider-error', cause, auth: false };
  }
  return null;
}
