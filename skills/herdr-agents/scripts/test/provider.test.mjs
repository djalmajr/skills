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

// R11/D58: a terminal authentication failure is a provider-error with
// auth=true — no retry or second probe will help. The stopped screen
// contains `401`, `unexpected status`, `Incorrect API key` or
// `refresh token was revoked`, including the Codex access-token refresh
// failure. No real credentials anywhere: the secrets below are fake
// placeholders shaped like the redactor's patterns.
test('providerDetect: authentication failures are terminal provider-errors', () => {
  const authHit = (state, screen, label) => {
    const out = providerDetect(state, screen);
    assert.ok(out, `${label}: expected a match`);
    assert.equal(out.status, 'provider-error', `${label}: ${out.status}`);
    assert.equal(out.auth, true, `${label}: the auth flag marks it terminal`);
    assert.ok(out.cause, `${label}: non-empty cause`);
  };
  authHit('idle', 'Error: 401 Unauthorized', 'bare 401');
  authHit('idle', 'Error: 401: {"message":"Incorrect API key provided"}', '401 with an API key message');
  authHit('idle', 'API Error: Incorrect API key provided', 'Incorrect API key');
  authHit('idle', '■ unexpected status 401: authentication failed', 'Codex unexpected status');
  authHit('idle', '■ Failed to refresh access token: the refresh token was revoked, please log in again',
    'Codex access-token refresh failure');
  authHit('idle', 'Error: Failed to refresh access token', 'refresh failure without the revoked phrase');
  // A transient failure keeps auth=false (the wait still double-confirms it).
  const transient = providerDetect('idle', 'Error: Connection error.');
  assert.ok(transient, 'transient matched');
  assert.equal(transient.status, 'provider-error');
  assert.equal(transient.auth, false, 'a transient failure is not auth');
  // Capacity always wins over auth on the same line.
  const both = providerDetect('idle', 'Error: 529 Incorrect API key');
  assert.ok(both, 'matched');
  assert.equal(both.status, 'capacity', 'capacity precedence over auth');
  // The most recent matching line wins across the classes.
  const newerTransient = providerDetect('idle', 'Error: 401 Unauthorized\nError: Connection error.\n');
  assert.ok(newerTransient, 'matched');
  assert.equal(newerTransient.auth, false, 'a newer transient wins over the older auth');
  const newerAuth = providerDetect('idle', 'Error: Connection error.\nError: 401 Unauthorized\n');
  assert.ok(newerAuth, 'matched');
  assert.equal(newerAuth.auth, true, 'a newer auth wins over the older transient');
});

test('providerDetect: auth false positives stay null', () => {
  miss('working', 'Error: 401 Unauthorized', 'never while working');
  miss('idle', '  const msg = "Error: 401 Unauthorized";', 'a code line with 401');
  miss('idle', '// Error: Incorrect API key provided', 'a comment line with an auth phrase');
  miss('idle', '• Ran the health check: 401 on the first try, fine after', 'tool output with 401');
  miss('idle', '● The docs said the refresh token was revoked, so I used the local copy', 'tool output with an auth phrase');
  miss('idle', 'error: 401 unauthorized', 'lowercase error: start is not an error line');
  miss('idle', 'throw new Error("Incorrect API key")', 'the text must START with the error word');
  miss('idle', 'Error: expected a semicolon', 'an error line without any provider pattern');
});

test('providerDetect: the auth cause is redacted and sanitized', () => {
  const out = providerDetect('idle', 'Error: 401 Unauthorized token=sk_test_fakekey000');
  assert.ok(out, 'matched');
  assert.equal(out.status, 'provider-error');
  assert.equal(out.auth, true);
  assert.equal(out.cause, 'Error: 401 Unauthorized token=[redacted]', 'the fake secret is redacted');
  assert.ok(!out.cause.includes('sk_test_fakekey000'), 'no credential in the cause');
});

// Amendment: only a 401 unexpected status is auth — a non-401 unexpected
// status stays a transient provider-error (the wait double-confirms it) —
// and refresh matching is narrowed to a revoked refresh token or a failed
// token refresh. The D58 revoked-token examples still match.
test('providerDetect: non-401 unexpected statuses are transient, not auth', () => {
  for (const screen of [
    'Error: unexpected status 503 Service Unavailable',
    'Error: unexpected status 500 Internal Server Error',
    '■ unexpected status 503 Service Unavailable',
  ]) {
    const out = providerDetect('idle', screen);
    assert.ok(out, `${screen}: still a provider stop`);
    assert.equal(out.status, 'provider-error', screen);
    assert.equal(out.auth, false, `${screen}: transient, needs the second probe`);
  }
  const auth401 = providerDetect('idle', 'Error: unexpected status 401: authentication failed');
  assert.ok(auth401, 'matched');
  assert.equal(auth401.status, 'provider-error');
  assert.equal(auth401.auth, true, 'a 401 unexpected status stays terminal');
});

test('providerDetect: refresh matching needs a revoked token or a failed token refresh', () => {
  for (const screen of [
    '■ Failed to refresh access token: the refresh token was revoked, please log in again',
    'Error: the refresh token was revoked by the admin',
    'Error: refresh token revoked, please re-login',
    'Error: Failed to refresh access token',
  ]) {
    const out = providerDetect('idle', screen);
    assert.ok(out, `${screen}: expected a match`);
    assert.equal(out.status, 'provider-error', screen);
    assert.equal(out.auth, true, `${screen}: terminal auth`);
  }
  miss('idle', 'Error: failed to refresh the dashboard', 'a refresh without a token is not auth');
  miss('idle', 'Error: the refresh token cache is stale', 'a refresh token without revoked is not auth');
});

// Amendment 2: a bare `unexpected status` with no HTTP reason phrase is
// still a stop — transient for a non-401 code, terminal auth for 401 —
// but only inside an error line.
test('providerDetect: bare unexpected statuses classify inside an error line only', () => {
  const bare503 = providerDetect('idle', 'Error: unexpected status 503');
  assert.ok(bare503, 'matched');
  assert.equal(bare503.status, 'provider-error');
  assert.equal(bare503.auth, false, 'bare 503 is transient');
  const bare401 = providerDetect('idle', 'Error: unexpected status 401');
  assert.ok(bare401, 'matched');
  assert.equal(bare401.status, 'provider-error');
  assert.equal(bare401.auth, true, 'bare 401 stays terminal auth');
  const glyph503 = providerDetect('idle', '■ unexpected status 503');
  assert.ok(glyph503, 'matched');
  assert.equal(glyph503.auth, false, 'the glyph line is transient too');
  miss('idle', 'unexpected status 503', 'no error start: not a stop');
  miss('idle', '• unexpected status 503, kept going locally', 'tool output is not a stop');
  miss('idle', 'const s = "unexpected status 503";', 'a code line is not a stop');
  miss('working', 'Error: unexpected status 503', 'never while working');
});
