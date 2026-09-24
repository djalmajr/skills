// Provider error / capacity detection: every example and
// counterexample of the brief, the in-flight Retrying line, the
// bottom-up most-recent-wins scan, the code-line exclusion, the
// error-word case sensitivity, the CRLF normalization, the capacity
// before provider-error precedence and the redacted/sanitized cause.
// Pure function: nothing here needs the disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import { providerDetect } from '../lib/provider.mjs';

const hit = (state, screen, wantStatus, label) => {
  const out = providerDetect(state, screen);
  assert.ok(out, `${label}: expected a match`);
  assert.equal(out.status, wantStatus, `${label}: ${out.status}`);
  assert.ok(out.cause, `${label}: non-empty cause`);
};
const miss = (state, screen, label) => {
  assert.equal(providerDetect(state, screen), null, label);
};

test('providerDetect: the brief examples and counterexamples', () => {
  hit('idle', 'Error: Retry failed after 3 attempts: 503: {"message":"inference capacity exhausted","type":"model_capacity"}',
    'capacity', 'model_capacity type');
  hit('idle', 'Error: 429: {"message":"too many concurrent requests for this key","type":"key_capacity"}',
    'capacity', 'key_capacity type');
  hit('idle', 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    'capacity', '529 overloaded_error');
  hit('idle', 'Error: Retry failed after 3 attempts: Request timed out.',
    'provider-error', 'retry failed + timeout');
  hit('idle', 'Error: Connection error.', 'provider-error', 'connection error');
  hit('idle', '■ stream disconnected before completion: error sending request',
    'provider-error', 'marker stream disconnected');
  miss('idle', "error: expected ';' at line 4", 'lowercase error: is not an error line');
  miss('idle', '  const msg = "Error: Request timed out";', 'a code line is never a provider stop');
  miss('idle', 'throw new Error("Request timed out")', 'the text must START with the error word');
});

test('providerDetect: the in-flight Retrying line is ignored', () => {
  miss('idle', 'API Error (Request timed out) · Retrying in 5 seconds…', 'Retrying in 5 seconds…');
  miss('idle', 'Will retry in 30 seconds', 'Will retry');
  miss('idle', 'Reconnecting…', 'Reconnecting…');
  // A skipped retry line does not mask an older error line below it:
  // the scan continues bottom-up over the remaining lines.
  hit('idle', 'Error: Connection error.\nReconnecting…', 'provider-error', 'the older error line still counts');
  hit('idle', 'Error: 529 at capacity\nretrying next request', 'capacity', 'an older capacity line still counts');
});

test('providerDetect: never while working, never on an empty screen', () => {
  miss('working', 'Error: Connection error.', 'working connection error');
  miss('working', 'API Error: 529 {"type":"overloaded_error"}', 'working 529');
  miss('idle', '', 'empty screen');
  miss('idle', '\n\n', 'blank lines');
});

test('providerDetect: CRLF screens are normalized before the scan', () => {
  hit('idle', 'Error: Connection error.\r\n', 'provider-error', 'CRLF single line');
  hit('idle', 'first\r\nError: 503 Service Unavailable\r\n', 'provider-error', 'CRLF multi-line');
});

test('providerDetect: bottom-up scan, the most recent line wins', () => {
  const out = providerDetect('idle', 'Error: Request timed out.\n■ at capacity\n');
  assert.ok(out, 'matched');
  assert.equal(out.status, 'capacity', 'the newest line (capacity) wins over the older provider-error');
  const out2 = providerDetect('idle', '■ at capacity\nError: 502: Bad Gateway\n');
  assert.ok(out2, 'matched');
  assert.equal(out2.status, 'provider-error', 'a newer provider-error wins over the older capacity');
  // An error line that matches no provider pattern does not shadow an
  // older matching line below it.
  const out3 = providerDetect('idle', '■ something else broke\nError: Connection error.\n');
  assert.ok(out3, 'matched');
  assert.equal(out3.status, 'provider-error', 'the unclassified error line falls through');
});

test('providerDetect: a line matching both is capacity', () => {
  const out = providerDetect('idle', 'Error: 503: {"type":"overload","message":"Request timed out"}');
  assert.ok(out, 'matched');
  assert.equal(out.status, 'capacity', 'the capacity patterns are checked first');
});

test('providerDetect: the remaining capacity and provider-error patterns', () => {
  hit('idle', 'Error: 503 at capacity, try later', 'capacity', 'at capacity');
  hit('idle', 'ERROR: OVERLOADED', 'capacity', 'overloaded word');
  hit('idle', 'Error: 529', 'capacity', 'bare 529');
  hit('idle', 'Error: connect ECONNREFUSED', 'provider-error', 'ECONNREFUSED');
  hit('idle', 'Error: ECONNRESET', 'provider-error', 'ECONNRESET');
  hit('idle', 'Error: connect connection refused', 'provider-error', 'connection refused');
  hit('idle', 'Error: connect connection reset by peer', 'provider-error', 'connection reset');
  hit('idle', 'Error: Retry failed after 1 attempt', 'provider-error', 'single attempt');
  hit('idle', 'Error: 500 Internal Server Error', 'provider-error', '500 + phrase');
  hit('idle', 'Error: 502: Bad Gateway', 'provider-error', '502 colon');
  hit('idle', 'Error: 503 (Service Unavailable)', 'provider-error', '503 paren');
  hit('idle', 'Error: 504 Gateway Timeout', 'provider-error', '504 gateway timeout');
  hit('idle', 'Error: 504 gateway time-out', 'provider-error', 'hyphenated gateway time-out');
  hit('idle', '■ socket hang up', 'provider-error', 'socket hang up');
  hit('idle', '■ fetch failed', 'provider-error', 'fetch failed');
  hit('idle', '✗ Error: stream disconnected before completion: timeout', 'provider-error', '✗ marker');
});

test('providerDetect: non-provider error lines and code lines stay null', () => {
  miss('idle', '■ installing dependencies', 'a marker line without a provider pattern');
  miss('idle', 'Error: expected a semicolon', 'an error line without a provider pattern');
  miss('idle', 'error: Request timed out', 'lowercase error: start is not an error line');
  miss('idle', 'ERRORS: none found', 'ERRORS is not ERROR');
  miss('idle', 'Error handling is fine', 'a prose "Error" sentence');
  miss('idle', '// Error: Connection error.', 'a comment line');
  miss('idle', '# Error: 503 at capacity', 'a hash comment line');
  miss('idle', 'result = "Error: Request timed out"', 'an assignment line');
  miss('idle', 'return "Error: 502: Bad Gateway"', 'a return line');
});

test('providerDetect: the cause is the redacted, sanitized line', () => {
  const out = providerDetect('idle', '■ Error: Request timed out token=sk_live_abcdefghij');
  assert.ok(out, 'matched');
  assert.equal(out.status, 'provider-error');
  assert.equal(out.cause, 'Error: Request timed out token=[redacted]', 'the marker is dropped, the secret redacted');
  // Sanitize caps the cause at 200 chars.
  const long = providerDetect('idle', `Error: Connection error ${'x'.repeat(300)}`);
  assert.ok(long, 'matched');
  assert.equal(long.cause.length, 200);
});

// Mutation captured: accepting any marker-opened line (• ●) as an error
// line turns ordinary tool output into a provider stop.
test('providerDetect: ordinary tool output with provider words is not a stop', () => {
  miss('idle', '• Ran the health check: Connection error on the first try, fine after', 'Codex tool bullet');
  miss('idle', '● The docs page said: Request timed out, so I used the local copy', 'Claude tool bullet');
  hit('idle', '■ unexpected status 503 Service Unavailable', 'provider-error', 'Codex error glyph');
  hit('idle', '  ⎿  API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}', 'capacity', 'Claude error line under ⎿');
});

// Mutation captured: scanning the whole screen (or more than the bottom
// lines) reports an error the agent already recovered from.
test('providerDetect: only the bottom of the screen counts', () => {
  const footer = '\n────────\n \n────────\n~/work (main)\n↑48k ↓933 8.6%/262k (auto)   (my-provider) my-model • high\n';
  hit('idle', `Error: Retry failed after 3 attempts: Request timed out.${footer}`, 'provider-error', 'error above the input box and footer');
  const later = Array.from({ length: 10 }, (_, i) => `• step ${i + 1} done`).join('\n');
  miss('idle', `Error: Connection error.\n${later}${footer}`, 'a recovered error under newer output');
});

// Mutation captured: scanning past newer agent output inside the tail
// reports an error the agent already recovered from.
test('providerDetect: agent output below an error ends the search', () => {
  miss('idle', 'Error: Connection error.\n• Ran the tests again\n  └ 12 passed\n›\n  my-model · 40% left', 'Codex went on after the error');
  miss('idle', '  ⎿  API Error: Request timed out\n● Wrote the report\n>\n  ? for shortcuts', 'Claude went on after the error');
  hit('idle', '• Ran the tests\nError: Connection error.\n›\n  my-model · 40% left', 'provider-error', 'the error is below the last output');
});
