'use strict';
/* Session priming. This module SPENDS the user's quota, so most of these
   tests are about the times it must refuse to act. */

const assert = require('assert');
const P = require('../src/prime');
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok  ' + name); };

const WEEKDAYS = [1, 2, 3, 4, 5];
const base = {
  times: ['08:00'], days: WEEKDAYS, weekday: 3 /* Wednesday */,
  minutesNow: 8 * 60, lastSlot: null, sessionOpen: false
};

test('a time parses, and anything else does not', () => {
  assert.strictEqual(P.parseTime('08:00'), 480);
  assert.strictEqual(P.parseTime('8:05'), 485);
  assert.strictEqual(P.parseTime('23:59'), 1439);
  assert.strictEqual(P.parseTime('24:00'), null);
  assert.strictEqual(P.parseTime('08:60'), null);
  assert.strictEqual(P.parseTime('lunchtime'), null);
  assert.strictEqual(P.parseTime(''), null);
  assert.strictEqual(P.parseTime(null), null);
});

test('the slot fires at its time', () => {
  assert.strictEqual(P.dueSlot(base), 480);
});

test('nothing is configured, nothing happens', () => {
  assert.strictEqual(P.dueSlot({ ...base, times: [] }), null);
  assert.strictEqual(P.dueSlot({ ...base, times: undefined }), null);
});

test('a running window is never primed into', () => {
  // The heart of it: another message does not restart a window that is
  // already open, so this would spend quota and change nothing.
  assert.strictEqual(P.dueSlot({ ...base, sessionOpen: true }), null);
});

test('a slot fires once, not on every check', () => {
  assert.strictEqual(P.dueSlot({ ...base, minutesNow: 8 * 60 + 4, lastSlot: 480 }), null);
});

test('a slot is not made up hours later', () => {
  // Priming at 14:00 for an 08:00 slot puts the boundary in the wrong
  // place, which is the problem this feature exists to solve.
  assert.strictEqual(P.dueSlot({ ...base, minutesNow: 14 * 60 }), null);
  assert.strictEqual(P.dueSlot({ ...base, minutesNow: 8 * 60 + 10 }), 480,
    'a short grace covers a laptop that woke up late');
  assert.strictEqual(P.dueSlot({ ...base, minutesNow: 8 * 60 + 16 }), null);
});

test('it does not fire before its time', () => {
  assert.strictEqual(P.dueSlot({ ...base, minutesNow: 7 * 60 + 59 }), null);
});

test('the weekend is respected', () => {
  assert.strictEqual(P.dueSlot({ ...base, weekday: 0 }), null, 'Sunday is not a work day here');
  assert.strictEqual(P.dueSlot({ ...base, weekday: 6 }), null);
  assert.strictEqual(P.dueSlot({ ...base, weekday: 0, days: [0, 6] }), 480);
});

test('an empty day list means every day', () => {
  assert.strictEqual(P.dueSlot({ ...base, weekday: 0, days: [] }), 480);
});

test('with several slots, the one that is due wins', () => {
  const two = { ...base, times: ['08:00', '13:00'] };
  assert.strictEqual(P.dueSlot({ ...two, minutesNow: 13 * 60 }), 780);
  assert.strictEqual(P.dueSlot({ ...two, minutesNow: 13 * 60, lastSlot: 480 }), 780,
    'the morning slot being done must not block the afternoon one');
  assert.strictEqual(P.dueSlot({ ...two, minutesNow: 13 * 60, lastSlot: 780 }), null);
});

test('the next slot is reported for display', () => {
  assert.deepStrictEqual(
    P.nextSlot({ times: ['08:00'], days: WEEKDAYS, weekday: 3, minutesNow: 9 * 60 }),
    { minutes: 480, daysAhead: 1 }, 'past today, so tomorrow');
  assert.deepStrictEqual(
    P.nextSlot({ times: ['08:00'], days: WEEKDAYS, weekday: 3, minutesNow: 7 * 60 }),
    { minutes: 480, daysAhead: 0 });
  assert.deepStrictEqual(
    P.nextSlot({ times: ['08:00'], days: WEEKDAYS, weekday: 5, minutesNow: 9 * 60 }),
    { minutes: 480, daysAhead: 3 }, 'Friday evening skips the weekend to Monday');
  assert.strictEqual(P.nextSlot({ times: [], days: WEEKDAYS, weekday: 3, minutesNow: 0 }), null);
});

test('slots are shown the way they were written', () => {
  assert.strictEqual(P.formatSlot(480), '08:00');
  assert.strictEqual(P.formatSlot(785), '13:05');
  assert.strictEqual(P.formatSlot(NaN), '');
});

console.log(`\n${passed} priming tests passed`);
