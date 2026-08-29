'use strict';
/* Backoff. Getting this wrong is what earns an HTTP 429, and the widget then
   keeps asking at the same pace, which is how a small problem stays. */

const assert = require('assert');
const {
  nextDelay, shouldRefreshOnReveal, mayFetch, isServerImposed,
  MAX_DELAY_MS, FORCE_FLOOR_MS
} = require('../src/schedule');
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok  ' + name); };

test('a success keeps the configured pace', () => {
  assert.strictEqual(nextDelay({ ok: true }, 0, 120), 120000);
});

test('a floor protects the endpoint from an over-eager config', () => {
  assert.strictEqual(nextDelay({ ok: true }, 0, 1), 30000);
});

test('failures back off until the cap, then hold there', () => {
  const delays = [1, 2, 3, 4, 5, 6].map((f) => nextDelay({ ok: false }, f, 60));
  assert.ok(delays[0] > 60000, 'the first failure already waits longer than the base');
  for (let i = 1; i < delays.length; i++) {
    assert.ok(delays[i] >= delays[i - 1], `attempt ${i + 1} waited less than the previous one`);
  }
  assert.strictEqual(delays[delays.length - 1], MAX_DELAY_MS, 'the tail should sit at the cap');
  assert.ok(delays.some((d) => d < MAX_DELAY_MS), 'it should climb, not jump straight to the cap');
});

test('the backoff is capped, it never waits forever', () => {
  assert.strictEqual(nextDelay({ ok: false }, 99, 120), MAX_DELAY_MS);
  assert.ok(nextDelay({ ok: false }, 6, 600) <= MAX_DELAY_MS);
});

test('Retry-After from the server wins over our own guess', () => {
  assert.strictEqual(nextDelay({ ok: false, retryAfter: 300 }, 1, 60), 300000);
});

test('Retry-After never makes us ask sooner than the base interval', () => {
  assert.strictEqual(nextDelay({ ok: false, retryAfter: 1 }, 1, 120), 120000);
});

test('hovering does not refresh while backing off', () => {
  const now = Date.now();
  assert.strictEqual(shouldRefreshOnReveal(now - 3600000, 1, now), false);
});

test('hovering refreshes stale data, not fresh data', () => {
  const now = Date.now();
  assert.strictEqual(shouldRefreshOnReveal(now - 5000, 0, now), false);
  assert.strictEqual(shouldRefreshOnReveal(now - 120000, 0, now), true);
  assert.strictEqual(shouldRefreshOnReveal(null, 0, now), true, 'first reveal must fetch');
});

test('the gate lets a due fetch through', () => {
  assert.strictEqual(mayFetch({ now: 1000, nextAllowedAt: 1000 }), true);
  assert.strictEqual(mayFetch({ now: 5000, nextAllowedAt: 1000, serverImposed: true }), true);
});

test('the gate stops an early fetch whoever asked', () => {
  // The bug this exists to prevent: a timer scheduled 4 minutes out governs
  // only itself, while a hover, a wake-from-sleep or a tray click fetch now.
  assert.strictEqual(mayFetch({ now: 1000, nextAllowedAt: 60000 }), false);
  assert.strictEqual(mayFetch({ now: 1000, nextAllowedAt: 60000, serverImposed: true }), false);
});

test('a person may waive our own pacing', () => {
  assert.strictEqual(
    mayFetch({ now: 60000, nextAllowedAt: 120000, lastFetchAt: 0, force: true }), true,
    'someone looking at the widget may ask for an answer now');
});

test('nobody may waive a backoff the server imposed', () => {
  assert.strictEqual(
    mayFetch({ now: 60000, nextAllowedAt: 900000, serverImposed: true, force: true }), false,
    'asking again inside a 429 window is how a rate limit becomes permanent');
});

test('a rejected token is not the server asking us to slow down', () => {
  // The regression this pins: treating any failure as unwaivable stranded the
  // sign-in flow — it refreshed the token, then could not read the result.
  assert.strictEqual(
    mayFetch({ now: 60000, nextAllowedAt: 900000, serverImposed: false, force: true }), true,
    'a person must be able to retry after fixing their credentials');
  assert.strictEqual(isServerImposed({ ok: false, reason: 'unauthorized' }), false);
  assert.strictEqual(isServerImposed({ ok: false, reason: 'network' }), false);
  assert.strictEqual(isServerImposed({ ok: false, reason: 'server' }), false);
  assert.strictEqual(isServerImposed({ ok: false, reason: 'rate-limited' }), true);
  assert.strictEqual(isServerImposed({ ok: false, reason: 'server', retryAfter: 30 }), true,
    'an explicit Retry-After is the server speaking, whatever the status');
  assert.strictEqual(isServerImposed({ ok: true }), false);
});

test('a held mouse button cannot become a flood', () => {
  const base = { now: 60000, nextAllowedAt: 120000, force: true };
  assert.strictEqual(mayFetch({ ...base, lastFetchAt: 60000 - FORCE_FLOOR_MS }), true);
  assert.strictEqual(mayFetch({ ...base, lastFetchAt: 59000 }), false,
    'clicking again a second later must not issue a second request');
});

test('a forced fetch is still floored, which a sign-in must not misread', () => {
  // The sign-in flow nudges Claude Code, then forces a refresh to see if it
  // worked. A hover a second earlier can put that forced call inside the
  // five-second floor, where it is refused — and the caller then reads the
  // OLD failure as "the nudge did not work".
  const base = { now: 1000, nextAllowedAt: 1000 + 120000, serverImposed: false, force: true };
  assert.strictEqual(mayFetch({ ...base, lastFetchAt: 1000 }), false, 'immediately after: refused');
  assert.strictEqual(mayFetch({ ...base, now: 1000 + 4999, lastFetchAt: 1000 }), false,
    'a millisecond short is still short');
  assert.strictEqual(mayFetch({ ...base, now: 1000 + FORCE_FLOOR_MS, lastFetchAt: 1000 }), true,
    'and at the floor it goes through — which is why the caller waits it out');
});

console.log(`\n${passed} schedule tests passed`);
