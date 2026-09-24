// Quota detection (slice 4): every hit/miss of test-quota.sh (case-
// insensitive patterns, source-code lines, quoted phrases, never while
// working), the secret + renewal case, the redaction passes and
// renewalValue (clock time, time with AM/PM, ISO date, duration, nothing).
// Each test builds its own temp dir (decision 10); nothing here needs the
// disk except the isolated ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { quotaDetect, quotaLineIsCode, quotaPhraseQuoted, renewalValue } from '../lib/quota.mjs';
import { redactSecrets, sanitizeCause } from '../lib/text.mjs';

test('quotaDetect: the test-quota.sh hit/miss matrix', () => {
  const hit = (state, text, label) => {
    const out = quotaDetect(state, text);
    assert.ok(out, `${label}: expected a match`);
    assert.ok(out[0], `${label}: non-empty match line`);
  };
  const miss = (state, text, label) => {
    assert.equal(quotaDetect(state, text), null, `${label}: expected no match`);
  };
  hit('idle', 'You have hit your usage limit for grok', 'usage limit');
  hit('idle', 'Individual quota reached', 'individual');
  hit('idle', 'Error: quota exceeded', 'quota exceeded');
  hit('idle', 'RESOURCE_EXHAUSTED: project', 'resource');
  hit('idle', '429 Too Many Requests', '429');
  hit('idle', 'rate limit exceeded, retry later', 'rate limit exceeded');
  hit("idle", "You've hit your limit for today", 'you have hit');
  hit('idle', 'You exceeded your current quota, please check your plan and billing details.', 'openai quota');
  hit('idle', 'You have reached your API usage limits: monthly threshold', 'anthropic reached');
  hit("idle", "You've reached your API usage limits", 'anthropic contraction');
  hit('done', 'INDIVIDUAL QUOTA REACHED', 'case-insensitive');
  miss('idle', 'implement a rate limit for the API client', 'prose rate limit');
  miss('idle', 'return "rate limit"', 'code rate limit');
  miss('idle', 'return "rate limit exceeded"', 'return phrase');
  miss('idle', '// 429 Too Many Requests', 'slash comment');
  miss('idle', '# quota exceeded', 'hash comment');
  miss('idle', '/* RESOURCE_EXHAUSTED */', 'block comment');
  miss('idle', 'func Limit() { quota exceeded }', 'func keyword');
  miss('idle', 'function check() { quota exceeded }', 'function keyword');
  miss('idle', 'msg = "quota exceeded"', 'assignment');
  miss('idle', '"rate limit exceeded"', 'quoted phrase');
  miss("idle", "You've hit your stride", 'stride');
  miss('working', '429 Too Many Requests', 'working 429');
  miss('working', 'hit your usage limit', 'working usage');
  miss('idle', '', 'empty screen');
});

test('quotaDetect: renewal line kept, secrets redacted (test-quota.sh case)', () => {
  const out = quotaDetect('idle', 'Individual quota reached token=sk_live_abcdefghij\nResets at 5:00pm token=sk_live_klmnopqrst');
  assert.ok(out, 'matched');
  assert.match(out[0], /Individual quota reached/);
  assert.match(out[1], /Resets at 5:00pm/);
  assert.ok(!out[0].includes('sk_live_'), 'no secret leak');
  assert.ok(!out[1].includes('sk_live_'), 'renewal line has no secret leak');
  assert.match(out[0], /\[redacted\]/);
  assert.match(out[1], /\[redacted\]/);
});

// The exact screen of the scripts/test-quota.sh renewal case (the bash
// suite is retired in slice 9b): the match line and the renewal line are
// kept, the secret never reaches the output.
test('quotaDetect: the exact test-quota.sh renewal input (ported)', () => {
  const out = quotaDetect('idle', 'Individual quota reached token=sk_live_abcdefghij\nResets at 5:00pm');
  assert.ok(out, 'matched');
  assert.match(out[0], /Individual quota reached/);
  assert.match(out[1], /Resets at 5:00pm/);
  assert.ok(!out.join('\n').includes('sk_live_'), 'no secret leak');
  assert.match(out[0], /\[redacted\]/);
});

test('quotaDetect: Bearer, api_key=, sk-proj- and JSON "message" lines', () => {
  const b = quotaDetect('idle', 'Bearer abc123.~+/ and hit your usage limit');
  assert.ok(b, 'bearer line matches');
  assert.equal(b[0], 'Bearer [redacted] and hit your usage limit');

  const a = quotaDetect('idle', 'api_key=sk-proj-abcdefgh1234 quota exceeded');
  assert.ok(a, 'api_key line matches');
  assert.equal(a[0], 'api_key=[redacted] quota exceeded');

  const s = quotaDetect('idle', 'key sk-proj-abcdefgh1234 rate limit exceeded');
  assert.ok(s, 'sk-proj line matches');
  assert.equal(s[0], 'key [redacted] rate limit exceeded');

  const j = quotaDetect('idle', '{"message":"rate limit exceeded"}');
  assert.ok(j, 'JSON "message" still counts');
  assert.equal(j[0], '{"message":"rate limit exceeded"}');

  const e = quotaDetect('idle', '{"error":"quota exceeded"}');
  assert.equal(e, null, 'a quoted phrase without "message" is code, not a stop');

  const q = quotaDetect('idle', '{"error":{"code":"insufficient_quota","message":"rate limit exceeded"}}');
  assert.ok(q, 'insufficient_quota before the phrase still counts');
});

test('quotaDetect: a CRLF screen is normalized before the scan (decision 7)', () => {
  const out = quotaDetect('idle', 'hit your usage limit\r\nResets at 10:00\r\n');
  assert.ok(out, 'CRLF screen matches');
  assert.equal(out[0], 'hit your usage limit');
  assert.equal(out[1], 'Resets at 10:00');
  // A CRLF line that is source code stays code after normalization
  // (the test-quota.sh `func Limit()` status case, CRLF form).
  assert.equal(quotaDetect('idle', 'func Limit() { /* rate limit the handler */ }\r\n'), null);
  assert.equal(quotaDetect('working', '429 Too Many Requests\r\n'), null);
});

test('renewalValue: clock time, AM/PM, ISO date, duration, nothing', () => {
  assert.equal(renewalValue('Resets at 5:00pm'), '5:00');
  assert.equal(renewalValue('Resets at 09:15:00'), '09:15:00');
  // The AM/PM group only matches the fully dotted P.M. form glued to the
  // time (the bash pattern is [APap]\.[Mm]\., so "2:30PM." stays "2:30").
  assert.equal(renewalValue('Resets at 2:30PM.'), '2:30');
  assert.equal(renewalValue('Resets at 2:30P.M.'), '2:30P.M.');
  assert.equal(renewalValue('resets on 2026-09-24 at noon'), '2026-09-24');
  assert.equal(renewalValue('try again in 5 minutes'), '5 minutes');
  assert.equal(renewalValue('retry after 2 hours'), '2 hours');
  assert.equal(renewalValue('quota exceeded, resets at 5:00pm'), '5:00');
  // The leftmost value wins, like `grep -o … | head -n1`.
  assert.equal(renewalValue('2026-09-24 14:30'), '2026-09-24');
  assert.equal(renewalValue('in 5 minutes at 14:30'), '5 minutes');
  assert.equal(renewalValue('nothing usable here'), '');
  assert.equal(renewalValue(''), '');
});

test('redactSecrets: the four sed passes in order', () => {
  assert.equal(redactSecrets('Bearer abc123.~+/'), 'Bearer [redacted]');
  assert.equal(redactSecrets('bearer xyz-123'), 'Bearer [redacted]');
  assert.equal(redactSecrets('pk-proj-abcdefgh12'), '[redacted]');
  assert.equal(redactSecrets('token=sk_live_abcdefghij'), 'token=[redacted]');
  assert.equal(redactSecrets('secret: sk_test_a1b2c3 rest'), 'secret: [redacted] rest');
  // Short key-shaped tokens are NOT redacted (the hyphen form needs 8+).
  assert.equal(redactSecrets('sk-ant-123'), 'sk-ant-123');
});

// The four exact inputs of the redact_secrets block in scripts/test-probe.sh
// (retired in slice 9b): hyphen keys with a hyphen inside, and the classic
// sk_ form inside a longer string.
test('redactSecrets: the test-probe.sh hyphen-key inputs (ported)', () => {
  assert.equal(redactSecrets('sk-proj-abcDEF123456'), '[redacted]');
  assert.equal(redactSecrets('sk-ant-api01-XYZ12345'), '[redacted]');
  assert.equal(redactSecrets('pk-live12345678'), '[redacted]');
  assert.equal(redactSecrets('key sk_live_987654321'), 'key [redacted]');
});

test('quotaLineIsCode / quotaPhraseQuoted: the unit rules', () => {
  assert.ok(quotaLineIsCode('# quota exceeded'));
  assert.ok(quotaLineIsCode('  // 429'));
  assert.ok(quotaLineIsCode('x /* quota exceeded */ y'));
  assert.ok(quotaLineIsCode('return "rate limit"'));
  assert.ok(quotaLineIsCode('function f() { quota exceeded }'));
  assert.ok(quotaLineIsCode('const q = "x"'));
  assert.ok(!quotaLineIsCode('Error: quota exceeded'));
  // token=secret glued on is not an assignment for this check.
  assert.ok(!quotaLineIsCode('quota exceeded token=abc'));

  const re = /rate limit exceeded/i;
  assert.ok(quotaPhraseQuoted('"rate limit exceeded"', re));
  assert.ok(quotaPhraseQuoted("let s = 'rate limit exceeded'", re));
  assert.ok(quotaPhraseQuoted('`rate limit exceeded`', re));
  assert.ok(!quotaPhraseQuoted('Error: rate limit exceeded', re));
  assert.ok(!quotaPhraseQuoted('{"message":"rate limit exceeded"}', re));
  assert.ok(!quotaPhraseQuoted('insufficient_quota: rate limit exceeded', re));
  assert.ok(!quotaPhraseQuoted('rate_limit_error rate limit exceeded', re));
  assert.ok(!quotaPhraseQuoted('no match here', re));
});

test('sanitizeCause: the shared text helper (text.mjs)', () => {
  assert.equal(sanitizeCause('a\nb\tc'), 'a b c');
  assert.equal(sanitizeCause('x\u001b[31my\r\n z'), 'x[31my z');
  assert.equal(sanitizeCause('a  b   c '), 'a b c');
  assert.equal(sanitizeCause('a'.repeat(300)).length, 200);
  assert.equal(sanitizeCause(''), '');
});
