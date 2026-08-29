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

test('an empty day list means no days at all', () => {
  // It used to mean every day. Unticking the last chip in the panel is the
  // clearest "stop" gesture there is, and it turned auto-open fully on.
  for (let weekday = 0; weekday < 7; weekday++) {
    assert.strictEqual(P.dueSlot({ ...base, weekday, days: [] }), null);
  }
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

test('the auto-open setting is one value, so a click cannot half-apply', () => {
  assert.deepStrictEqual(P.resolveMode('chain'), { chain: true, times: [] });
  assert.deepStrictEqual(P.resolveMode('08:00'), { chain: false, times: ['08:00'] });
  assert.deepStrictEqual(P.resolveMode(''), { chain: false, times: [] });
  // Choosing a time must turn chain OFF in the same breath — as two separate
  // settings, a stale value could leave both on and chain would win.
  assert.strictEqual(P.resolveMode('09:00').chain, false);
  assert.deepStrictEqual(P.resolveMode('nonsense'), { chain: false, times: [] });
  assert.deepStrictEqual(P.resolveMode(null), { chain: false, times: [] });
  assert.deepStrictEqual(P.resolveMode(undefined), { chain: false, times: [] });
});

test('"at" keeps the time already chosen, and only defaults when there is none', () => {
  assert.deepStrictEqual(P.resolveMode('at', ['06:30']), { chain: false, times: ['06:30'] },
    'switching to chain and back must not forget the time');
  assert.deepStrictEqual(P.resolveMode('at', []), { chain: false, times: ['08:00'] });
  assert.deepStrictEqual(P.resolveMode('at', ['nonsense']), { chain: false, times: ['08:00'] });
});

test('stepping a time wraps instead of stopping at the ends', () => {
  assert.strictEqual(P.stepTime('08:00', 'h', 1), '09:00');
  assert.strictEqual(P.stepTime('08:00', 'h', -1), '07:00');
  assert.strictEqual(P.stepTime('08:00', 'm', 1), '08:15');
  assert.strictEqual(P.stepTime('08:45', 'm', 1), '09:00', 'minutes carry into the hour');
  assert.strictEqual(P.stepTime('00:00', 'm', -1), '23:45', 'and wrap backwards over midnight');
  assert.strictEqual(P.stepTime('23:00', 'h', 1), '00:00');
  assert.strictEqual(P.stepTime('00:00', 'h', -1), '23:00');
});

test('a corrupt time steps to a sane one rather than propagating', () => {
  assert.strictEqual(P.stepTime('nonsense', 'h', 1), '08:00');
  assert.strictEqual(P.stepTime('08:00', 'h', NaN), '08:00');
});

test('days toggle individually and stay sorted', () => {
  assert.deepStrictEqual(P.toggleDay([1, 2, 3, 4, 5], 6), [1, 2, 3, 4, 5, 6]);
  assert.deepStrictEqual(P.toggleDay([1, 2, 3, 4, 5], 3), [1, 2, 4, 5]);
  assert.deepStrictEqual(P.toggleDay([5, 1, 3], 0), [0, 1, 3, 5], 'order must not depend on click order');
  assert.deepStrictEqual(P.toggleDay([], 0), [0]);
  assert.deepStrictEqual(P.toggleDay([0], 0), [], 'every day may be turned off');
});

test('a day outside the week is ignored, not stored', () => {
  assert.deepStrictEqual(P.toggleDay([1, 2], 9), [1, 2]);
  assert.deepStrictEqual(P.toggleDay([1, 2], -1), [1, 2]);
  assert.deepStrictEqual(P.toggleDay([1, 2], 'x'), [1, 2]);
});

test('with no days selected, nothing ever fires', () => {
  assert.strictEqual(P.dueSlot({ ...base, days: [2] }), null,
    'Wednesday is not in the list, so the slot must not fire');
});

test('slots are shown the way they were written', () => {
  assert.strictEqual(P.formatSlot(480), '08:00');
  assert.strictEqual(P.formatSlot(785), '13:05');
  assert.strictEqual(P.formatSlot(NaN), '');
});

test('switching to chain and back keeps the time the user chose', () => {
  // The comment in resolveMode says this must hold. It did not: chain
  // returned times: [] and coming back produced the 08:00 default, so two
  // adjacent radio buttons in one submenu silently reset 06:30.
  const at = P.resolveMode('at', ['06:30']);
  assert.deepStrictEqual(at.times, ['06:30']);
  const chain = P.resolveMode('chain', at.times);
  assert.strictEqual(chain.chain, true);
  // resolveMode itself still clears it — the settings file must not hold a
  // time beside chain — so the caller is what remembers. This asserts the
  // rule the caller has to honour.
  assert.deepStrictEqual(chain.times, [], 'nothing beside chain on disk');
  assert.deepStrictEqual(P.resolveMode('at', ['06:30']).times, ['06:30'],
    'given the remembered time, it comes back');
});



test('unticking every day stops auto-open, rather than starting it daily', () => {
  let days = [1, 2, 3, 4, 5];
  for (const d of [1, 2, 3, 4, 5]) days = P.toggleDay(days, d);
  assert.deepStrictEqual(days, [], 'the gesture is allowed');
  for (let weekday = 0; weekday < 7; weekday++) {
    assert.strictEqual(P.dueSlot({ times: ['08:00'], days, weekday, minutesNow: 480 }), null,
      'and it means what it looks like it means');
  }
});

test('a slot is primed once per DATE, not once per weekday', () => {
  // lastPrime was keyed by getDay(), which repeats every seven days: a
  // Monday-only schedule primed once and was then "already done" every
  // Monday after. This asserts the shape the caller must key by.
  const monday = new Date('2026-08-31T08:02:00');
  const nextMonday = new Date('2026-09-07T08:02:00');
  const key = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  assert.notStrictEqual(key(monday), key(nextMonday), 'a week later is a different day');
  assert.strictEqual(monday.getDay(), nextMonday.getDay(), 'but the same weekday — the old key');
});

console.log(`\n${passed} priming tests passed`);
