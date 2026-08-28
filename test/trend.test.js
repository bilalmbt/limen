'use strict';
/* Burn rate. The risk here is not getting the arithmetic wrong — it is
   speaking with confidence from two noisy samples, so most of these tests
   are about staying quiet. */

const assert = require('assert');
const T = require('../src/trend');
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok  ' + name); };

const MIN = 60000;
/** A series rising `perMin` points a minute, one sample every 2 minutes. */
const series = (perMin, count, now, id = 'session', start = 0) => {
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    out.push({ at: now - i * 2 * MIN, p: { [id]: start + (count - 1 - i) * 2 * perMin } });
  }
  return out;
};

test('a steady climb yields its own slope', () => {
  const now = 1000000;
  const rate = T.rateFor(series(0.5, 10, now), 'session', now);
  assert.ok(Math.abs(rate - 0.5) < 0.001, `expected ~0.5, got ${rate}`);
});

test('two samples are a coincidence, not a trend', () => {
  const now = 1000000;
  assert.strictEqual(T.rateFor(series(0.5, 2, now), 'session', now), null);
});

test('a long-enough span is required, however many samples', () => {
  const now = 1000000;
  // Six samples ten seconds apart: plenty of points, no real span.
  const tight = [0, 1, 2, 3, 4, 5].map((i) => ({ at: now - i * 10000, p: { session: 50 - i } })).reverse();
  assert.strictEqual(T.rateFor(tight, 'session', now), null);
});

test('quantisation noise is not a trend', () => {
  const now = 1000000;
  // One whole point across half an hour is below the floor.
  const creep = [0, 1, 2, 3, 4].map((i) => ({ at: now - i * 8 * MIN, p: { session: 20 + (i === 0 ? 1 : 0) } })).reverse();
  assert.strictEqual(T.rateFor(creep, 'session', now), null);
});

test('a reset inside the window voids the rate rather than going negative', () => {
  const now = 1000000;
  const history = series(0.5, 6, now).concat([
    { at: now - MIN, p: { session: 2 } }   // the window rolled over
  ]);
  assert.strictEqual(T.rateFor(history, 'session', now), null,
    'a reset is not spending, and must never read as a negative pace');
});

test('samples older than the window are ignored', () => {
  const now = 1000000;
  const ancient = series(5, 10, now - 4 * 60 * MIN);
  assert.strictEqual(T.rateFor(ancient, 'session', now), null);
});

test('a gauge the account stopped exposing simply has no rate', () => {
  const now = 1000000;
  assert.strictEqual(T.rateFor(series(0.5, 10, now), 'model-gone', now), null);
  assert.strictEqual(T.rateFor(null, 'session', now), null);
  assert.strictEqual(T.rateFor([], 'session', now), null);
});

test('projection is the remaining headroom over the pace', () => {
  assert.strictEqual(T.project(50, 1, 0), 50 * 60000);
  assert.strictEqual(T.project(90, 0.5, 0), 20 * 60000);
});

test('a full or falling gauge forecasts nothing', () => {
  assert.strictEqual(T.project(100, 1, 0), null, 'a wall you have hit is not a forecast');
  assert.strictEqual(T.project(50, 0, 0), null);
  assert.strictEqual(T.project(50, -1, 0), null);
});

test('the summary flags only exhaustion that beats the reset', () => {
  const now = 1000000;
  const history = series(1, 10, now, 'session', 40);   // 1 %/min, at ~58% now
  const soon = new Date(now + 6 * 60 * MIN).toISOString();
  const late = new Date(now + 10 * MIN).toISOString();

  const willRunOut = T.summarize(history, [
    { id: 'session', percent: 58, resetsAt: soon }
  ], now);
  assert.ok(willRunOut.session, 'a rising gauge should carry a trend');
  assert.strictEqual(willRunOut.session.beforeReset, true);

  const resetsFirst = T.summarize(history, [
    { id: 'session', percent: 58, resetsAt: late }
  ], now);
  assert.strictEqual(resetsFirst.session.beforeReset, false,
    'a limit that resets before you reach it needs no warning');
});

test('the history is a ring buffer, newest last', () => {
  const g = (p) => [{ id: 'session', percent: p }];
  let h = [];
  for (let i = 0; i < 8; i++) h = T.push(h, g(i), i * MIN, 5);
  assert.strictEqual(h.length, 5, 'the buffer must not grow forever');
  assert.strictEqual(h[h.length - 1].p.session, 7, 'newest reading last');
  assert.strictEqual(h[0].p.session, 3, 'oldest dropped first');
});

test('a failed read adds nothing to the history', () => {
  const h = T.push([{ at: 0, p: { session: 1 } }], [], 1000);
  assert.strictEqual(h.length, 1, 'an empty reading must not enter the series');
});

console.log(`\n${passed} trend tests passed`);
