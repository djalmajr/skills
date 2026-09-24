// Quota detection (port slice 4). Port of scripts/herdr-agents.sh
// :1030-1133 (redact_secrets lives in text.mjs, per the slice decision).
//
// Provider lines only, never on source-code lines, never while working.
// Case-insensitive matching, a CRLF screen is normalized to LF before the
// line scan (decision 7), and both the matched line and the renewal line
// pass through redactSecrets and then sanitizeCause.
import { sanitizeCause, redactSecrets } from './text.mjs';

// quota_line_is_code() port: the line is source code, not a provider error.
// A credential glued on with token=secret is not an assignment: that line
// can still be the provider message (redact_secrets strips it afterwards).
export function quotaLineIsCode(line) {
  return /^\s*(#|\/\/|\/\*)/.test(line)
    || /\s#(\s|$)/.test(line)
    || /(^|[^:])\/\/|\/\*/.test(line)
    || /(^|[^A-Za-z0-9_])return([^A-Za-z0-9_]|$)/.test(line)
    || /(^|[^A-Za-z0-9_])function([^A-Za-z0-9_]|$)/.test(line)
    || /(^|[^A-Za-z0-9_])func\s/.test(line)
    // Spaced assignment, or ident="...". token=secret on a provider line stays.
    || /[A-Za-z0-9_]\s+=\s*/.test(line)
    || /[A-Za-z0-9_]=["']/.test(line);
}

// The 11 provider patterns, in the bash order (first match on a line wins).
const QUOTA_RES = [
  /hit your usage limit/i,
  /Individual quota reached/i,
  /You exceeded your current quota/i,
  /quota exceeded/i,
  /RESOURCE_EXHAUSTED/i,
  /429 Too Many Requests/i,
  /rate limit exceeded/i,
  /You've hit your( [A-Za-z]+)? limit/i,
  /You have hit your( [A-Za-z]+)? limit/i,
  /You have reached your( specified)?( (workspace )?API)? usage limits?/i,
  /You've reached your( specified)?( (workspace )?API)? usage limits?/i,
];

// The renewal patterns of `grep -m1` (a line matches any of them).
const RENEWAL_LINE_RES = [
  /resets? (at|in|on) /i,
  /try again (at|in) /i,
  /available (again )?(at|in) /i,
  /retry after /i,
  /in [0-9]+ (minute|hour|second)s?/i,
];

// renewal_value() port: the date/time value of a renewal line, or ''.
// Strict forms only — clock time (14:30, 09:15:00, 2:30 PM.), ISO date
// (2026-09-24), or a duration (5 minutes) — so the value can never carry
// the rest of the provider line. Anything wider: no usable value, ''.
// Like `grep -E -i -o -e … -e … -e … | head -n1`: the leftmost match over
// the three patterns (pattern order decides a same-position tie).
const RENEWAL_VALUE_RES = [
  /[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?([APap]\.[Mm]\.)?/i,
  /[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}/,
  /[0-9]+ (minute|hour|second|day)s?/i,
];

export function renewalValue(line) {
  let best = null;
  for (const re of RENEWAL_VALUE_RES) {
    const m = re.exec(String(line));
    if (m && (best === null || m.index < best.index)) best = { index: m.index, text: m[0] };
  }
  return best ? best.text : '';
}

// quota_phrase_quoted() port: the matched phrase is a string literal, not
// a sentence the provider printed. A JSON "message" field, or an
// `insufficient_quota` / `rate_limit_error` key before it, still counts as
// a provider error (not quoted). `re` is the pattern that matched.
export function quotaPhraseQuoted(line, re) {
  const m = re.exec(String(line).toLowerCase());
  if (!m) return false;
  const pre = line.slice(0, m.index).replace(/[ \t]+$/, '');
  const post = line.slice(m.index + m[0].length).replace(/^[ \t]+/, '');
  if (pre.includes('"message"') || pre.includes('insufficient_quota') || pre.includes('rate_limit_error')) return false;
  const pc = pre.length ? pre[pre.length - 1] : '';
  const nc = post.length ? post[0] : '';
  return (pc === '"' && nc === '"') || (pc === "'" && nc === "'") || (pc === '`' && nc === '`');
}

// quota_detect() port. `state` is the agent state; `screen` the visible
// lines. Returns [match, renewal] (either possibly '') or null when this
// is not a quota stop.
export function quotaDetect(state, screen) {
  if (state === 'working') return null;
  let text = String(screen ?? '');
  if (!text) return null;
  text = text.replace(/\r\n/g, '\n'); // CRLF screen (decision 7)
  const lines = text.split('\n');
  let line = '';
  outer: for (const candidate of lines) {
    if (!candidate) continue;
    if (quotaLineIsCode(candidate)) continue;
    for (const re of QUOTA_RES) {
      if (!re.test(candidate)) continue;
      if (quotaPhraseQuoted(candidate, re)) continue;
      line = candidate;
      break outer;
    }
  }
  if (!line) return null;
  let renewal = '';
  for (const l of lines) {
    if (RENEWAL_LINE_RES.some((re) => re.test(l))) { renewal = l; break; }
  }
  return [sanitizeCause(redactSecrets(line)), sanitizeCause(redactSecrets(renewal))];
}
