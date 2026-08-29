'use strict';
/* Threshold alerts. The hard part is not raising one, it is not raising the
   same one thirty times an hour, which is how people learn to ignore them. */

const assert = require('assert');
const { due, plan, FORGET_AFTER_POLLS } = require('../src/alerts');
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok  ' + name); };

const WINDOW = '2026-09-02T09:59:59Z';
const gauge = (percent, resetsAt = WINDOW) => ({ id: 'session', kind: 'session', percent, resetsAt });
const weekly = () => ({ id: 'weekly', kind: 'weekly', percent: 5, resetsAt: WINDOW });

test('crossing a threshold raises one alert', () => {
  const { raise } = due([gauge(83)], [80, 95], {});
  assert.strictEqual(raise.length, 1);
  assert.strictEqual(raise[0].level, 80);
});

test('staying above the threshold stays quiet', () => {
  const first = due([gauge(83)], [80, 95], {});
  const second = due([gauge(88)], [80, 95], first.ledger);
  assert.strictEqual(second.raise.length, 0, 'it repeated itself');
});

test('crossing the next threshold up speaks again', () => {
  const first = due([gauge(83)], [80, 95], {});
  const second = due([gauge(96)], [80, 95], first.ledger);
  assert.strictEqual(second.raise.length, 1);
  assert.strictEqual(second.raise[0].level, 95);
});

test('a new reset window arms the alert again', () => {
  const first = due([gauge(83)], [80, 95], {});
  const second = due([gauge(83, '2026-09-09T09:59:59Z')], [80, 95], first.ledger);
  assert.strictEqual(second.raise.length, 1, 'the new week said nothing');
});

test('below every threshold, nothing is raised', () => {
  assert.strictEqual(due([gauge(12)], [80, 95], {}).raise.length, 0);
});

test('no thresholds configured means no alerts', () => {
  assert.strictEqual(due([gauge(99)], [], {}).raise.length, 0);
});

test('the ledger forgets quotas the account no longer exposes', () => {
  // ...but not on one poll's word: removal is only believed after
  // FORGET_AFTER_POLLS consecutive polls without the gauge.
  let { ledger } = due([gauge(83)], [80], {});
  for (let poll = 1; poll < FORGET_AFTER_POLLS; poll++) {
    ledger = due([weekly()], [80], ledger).ledger;
    assert.ok('session' in ledger, `absent poll ${poll} is not yet proof of removal`);
  }
  ledger = due([weekly()], [80], ledger).ledger;
  assert.deepStrictEqual(Object.keys(ledger), [], 'the ledger would grow forever');
});

test('the absence count survives a restart', () => {
  // The ledger is persisted (state.json) and read back on launch. The count
  // rides the entry through JSON, so a restart mid-absence neither starts
  // the count over nor forgets early.
  let { ledger } = due([gauge(83)], [80], {});
  ledger = due([weekly()], [80], ledger).ledger;         // one absent poll...
  ledger = JSON.parse(JSON.stringify(ledger));           // ...then a restart
  for (let poll = 1; poll < FORGET_AFTER_POLLS; poll++) {
    ledger = due([weekly()], [80], ledger).ledger;
  }
  assert.ok(!('session' in ledger), 'the count did not survive the round trip');
});

test('a jump straight past both thresholds reports the higher one', () => {
  const { raise } = due([gauge(99)], [80, 95], {});
  assert.strictEqual(raise.length, 1);
  assert.strictEqual(raise[0].level, 95, 'it should not warn about 80 when already past 95');
});

// --- plan(): everything the island may say this poll -----------------------

const PACING = { session: { beforeReset: true, exhaustsInMs: 44 * 60000 } };
const opts = (extra) => ({ thresholds: [80, 95], summary: PACING, ledger: {}, ...extra });

test('the pace warning speaks once per window, not once per poll', () => {
  // It used to speak every poll: the ledger pruner deleted "pace-session"
  // each time, because that is not the id of any live gauge, so the next
  // poll found nothing on record and warned again — every two minutes.
  let ledger = {};
  const spoke = [];
  for (let poll = 0; poll < 4; poll++) {
    const r = plan([gauge(60)], opts({ ledger }));
    ledger = r.ledger;
    spoke.push(r.raise.length);
  }
  assert.deepStrictEqual(spoke, [1, 0, 0, 0]);
  assert.strictEqual(ledger['pace-session'].window, WINDOW, 'and it is on record');
});

test('a new window arms the pace warning again', () => {
  const first = plan([gauge(60)], opts({}));
  assert.strictEqual(first.raise.length, 1);
  const later = plan([gauge(60, '2026-09-09T09:59:59Z')], opts({ ledger: first.ledger }));
  assert.strictEqual(later.raise.length, 1, 'a fresh quota is a fresh warning');
});

test('past 90 the pace warning goes quiet', () => {
  // At that height "you will run out" is what the red bar already says, and
  // saying it twice in one poll is how a quiet widget becomes a noisy one.
  const r = plan([gauge(93)], opts({}));
  assert.deepStrictEqual(r.raise.map((x) => x.level), [80],
    'the threshold still speaks — 93 has not reached 95 — but the pace does not');
  assert.ok(!('pace-session' in r.ledger), 'and nothing is recorded on its behalf');
});

test('a pause skips alerts rather than holding them', () => {
  const paused = plan([gauge(83)], opts({ silenced: true }));
  assert.deepStrictEqual(paused.raise, [], 'nothing is said');
  assert.strictEqual(paused.ledger.session.level, 80,
    'but it is recorded as said, which is what makes a pause a pause');

  const after = plan([gauge(85)], opts({ ledger: paused.ledger }));
  assert.deepStrictEqual(after.raise, [],
    'so nothing replays the moment the pause lapses');
});

test('a pause silences what it covered, not the rest of the window', () => {
  const paused = plan([gauge(83)], opts({ silenced: true }));
  const later = plan([gauge(96)], opts({ ledger: paused.ledger }));
  assert.deepStrictEqual(later.raise.map((x) => x.level), [95],
    'the level above was never covered by the pause');
});

test('no thresholds configured silences the pace warning too', () => {
  // alertAt: [] is "never interrupt me", and a pace warning is an
  // interruption like any other.
  const r = plan([gauge(60)], opts({ thresholds: [] }));
  assert.deepStrictEqual(r.raise, []);
  assert.deepStrictEqual(r.ledger, {}, 'and nothing is recorded on its behalf');
});

test('a threshold and a pace warning in one poll come out in that order', () => {
  const r = plan([gauge(83)], opts({}));
  assert.deepStrictEqual(r.raise.map((x) => x.level), [80, 'pace'],
    'where you are before where you are heading');
  assert.strictEqual(r.raise[1].minutes, 44, 'the pace carries its own estimate');
});

test('a one-poll blip does not re-arm a spoken alert', () => {
  // One 200 can arrive with a single null utilization; usage.js reads that
  // as "no such limit" and the gauge is simply not in the list for a poll.
  // Forgetting it on that blip meant the spoken 80 — and the spoken pace
  // warning — spoke AGAIN the moment the gauge returned.
  const spoke = plan([gauge(83)], opts({}));
  assert.deepStrictEqual(spoke.raise.map((x) => x.level), [80, 'pace']);

  const blip = plan([], opts({ ledger: spoke.ledger }));
  const back = plan([gauge(84)], opts({ ledger: blip.ledger }));
  assert.deepStrictEqual(back.raise, [], 'the blip re-armed what had been said');

  // And absence only counts when consecutive: a gauge that keeps coming
  // back is never forgotten, however many blips it rides through.
  let ledger = back.ledger;
  for (let round = 1; round <= FORGET_AFTER_POLLS + 1; round++) {
    ledger = plan([], opts({ ledger })).ledger;
    const returned = plan([gauge(84)], opts({ ledger }));
    ledger = returned.ledger;
    assert.deepStrictEqual(returned.raise, [], `blip ${round} re-armed a spoken alert`);
  }
});

test('the ledger keeps a pace entry for a live gauge, drops it for a dead one', () => {
  const alive = plan([gauge(60)], opts({}));
  assert.ok('pace-session' in alive.ledger);
  let ledger = alive.ledger;
  for (let poll = 0; poll < FORGET_AFTER_POLLS; poll++) {
    ledger = plan([weekly()], opts({ ledger })).ledger;
  }
  assert.deepStrictEqual(Object.keys(ledger), [],
    'a quota the account no longer exposes takes its pace entry with it');
});

console.log(`\n${passed} alert tests passed`);
