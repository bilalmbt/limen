'use strict';
/* The state machine. Every timing promise the proposal makes is a test here:
   a graze must not open the panel, a menu must never stay shadowed, a peek
   must retract on its own, and an alert must never demote the full panel. */

const assert = require('assert');
const I = require('../src/island-state');
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok  ' + name); };

// `moved: 0` = the cursor is parked, which is what arms a dwell.
const IN = { inHot: true, inKeepAlive: true, moved: 0 };
const NEAR = { inHot: false, inKeepAlive: true, moved: 0 };   // over the open panel
const OUT = { inHot: false, inKeepAlive: false, moved: 0 };
const CROSSING = { inHot: true, inKeepAlive: true, moved: 40 };   // travelling through

/** Run a scripted sequence of ticks; returns machine and every effect seen. */
function run(m, steps) {
  const effects = [];
  for (const [input, now] of steps) {
    const r = I.tick(m, { ...input, now });
    m = r.m;
    effects.push(...r.effects);
  }
  return { m, effects };
}

test('a graze across the top edge does not open the panel', () => {
  const { m, effects } = run(I.create(), [[IN, 0], [OUT, 40], [IN, 200], [OUT, 240]]);
  assert.strictEqual(m.state, I.DORMANT);
  assert.deepStrictEqual(effects, [], 'the island opened on a pass-through');
});

test('a cursor travelling through the hot zone never opens it, however long', () => {
  // The real failure: crossing to Control Center keeps the pointer inside
  // the strip for the better part of a second, so presence alone always
  // tripped the dwell. Stillness is the signal, not presence.
  const steps = [];
  for (let t = 0; t <= 900; t += 40) steps.push([CROSSING, t]);
  const { m, effects } = run(I.create(), steps);
  assert.strictEqual(m.state, I.DORMANT);
  assert.deepStrictEqual(effects, []);
});

test('parking after travelling through does open it', () => {
  const { m } = run(I.create(), [[CROSSING, 0], [CROSSING, 40], [IN, 80], [IN, 210]]);
  assert.strictEqual(m.state, I.EXPANDED);
});

test('coming straight back skips the dwell', () => {
  let { m } = run(I.create(), [[IN, 0], [IN, 130]]);
  const closed = run(m, [[OUT, 200], [OUT, 600]]);
  assert.strictEqual(closed.m.state, I.DORMANT);
  // One sample back inside, well under the dwell, because intent is settled.
  const back = run(closed.m, [[IN, 700], [IN, 740]]);
  assert.strictEqual(back.m.state, I.EXPANDED, 're-entry should not re-charge the dwell');
});

test('a task running in the panel holds it open', () => {
  let { m } = run(I.create(), [[IN, 0], [IN, 130]]);
  m = { ...m, busy: true };
  const r = run(m, [[OUT, 200], [OUT, 1000], [OUT, 5000]]);
  assert.strictEqual(r.m.state, I.EXPANDED, 'sign-in progress must not vanish under the cursor');
  const done = run({ ...r.m, busy: false }, [[OUT, 6000], [OUT, 6400]]);
  assert.strictEqual(done.m.state, I.DORMANT);
});

test('dwelling in the hot zone expands, once', () => {
  const { m, effects } = run(I.create(), [[IN, 0], [IN, 40], [IN, 80], [IN, 120], [IN, 160]]);
  assert.strictEqual(m.state, I.EXPANDED);
  assert.deepStrictEqual(effects, ['expand'], 'expand must fire exactly once');
});

test('leaving the hot zone resets the dwell clock', () => {
  const { m } = run(I.create(), [[IN, 0], [OUT, 80], [IN, 100], [IN, 180]]);
  assert.strictEqual(m.state, I.DORMANT, 'two short visits must not add up to one dwell');
});

test('moving from the strip onto the panel keeps it open', () => {
  const { m, effects } = run(I.create(),
    [[IN, 0], [IN, 130], [NEAR, 200], [NEAR, 600], [NEAR, 2000]]);
  assert.strictEqual(m.state, I.EXPANDED);
  assert.deepStrictEqual(effects, ['expand']);
});

test('leaving keep-alive collapses only after the grace period', () => {
  let { m } = run(I.create(), [[IN, 0], [IN, 130]]);
  let r = run(m, [[OUT, 200], [OUT, 400]]);
  assert.strictEqual(r.m.state, I.EXPANDED, 'collapsed inside the grace window');
  r = run(r.m, [[OUT, 590]]);
  assert.strictEqual(r.m.state, I.DORMANT, 'grace expired but the island stayed');
  assert.deepStrictEqual(r.effects, ['collapse']);
});

test('coming back inside the grace window cancels the hide', () => {
  let { m } = run(I.create(), [[IN, 0], [IN, 130]]);
  const r = run(m, [[OUT, 200], [NEAR, 400], [OUT, 900], [OUT, 1281]]);
  // left at 900, grace 380 → hides at 1280, not at the first departure's clock
  assert.strictEqual(r.m.state, I.DORMANT);
  const r2 = run(I.create(), [[IN, 0], [IN, 130], [OUT, 200], [NEAR, 400], [OUT, 900], [OUT, 1275]]);
  assert.strictEqual(r2.m.state, I.EXPANDED, 'an earlier departure leaked into the new grace clock');
});

test('an alert peeks from dormant and retracts on its own', () => {
  let m = I.create();
  let r = I.alert(m, 'session', 1000);
  assert.strictEqual(r.m.state, I.PEEK);
  assert.deepStrictEqual(r.effects, ['peek']);
  const done = run(r.m, [[OUT, 3000], [OUT, 5001]]);
  assert.strictEqual(done.m.state, I.DORMANT);
  assert.deepStrictEqual(done.effects, ['unpeek']);
});

test('a peek stays out for its full four seconds', () => {
  const r = I.alert(I.create(), 'session', 0);
  const early = run(r.m, [[OUT, 3999]]);
  assert.strictEqual(early.m.state, I.PEEK);
});

test('hovering a peek promotes to the full panel without a dwell', () => {
  const r = I.alert(I.create(), 'session', 0);
  const promoted = run(r.m, [[IN, 500]]);
  assert.strictEqual(promoted.m.state, I.EXPANDED);
  assert.deepStrictEqual(promoted.effects, ['unpeek', 'expand']);
  assert.strictEqual(promoted.m.peekGaugeId, null);
});

test('an alert never demotes the expanded panel', () => {
  const { m } = run(I.create(), [[IN, 0], [IN, 130]]);
  const r = I.alert(m, 'weekly', 200);
  assert.strictEqual(r.m.state, I.EXPANDED);
  assert.deepStrictEqual(r.effects, [], 'the panel already shows everything');
});

test('a second alert refreshes a peek that is already out', () => {
  const first = I.alert(I.create(), 'session', 0);
  const second = I.alert(first.m, 'weekly', 3000);
  assert.strictEqual(second.m.peekGaugeId, 'weekly');
  assert.strictEqual(second.m.peekUntil, 7000, 'the clock must restart for the new alert');
});

test('a click on a peek promotes it to the full panel', () => {
  const r = I.promote(I.alert(I.create(), 'session', 0).m);
  assert.strictEqual(r.m.state, I.EXPANDED);
  assert.deepStrictEqual(r.effects, ['unpeek', 'expand']);
  assert.strictEqual(r.m.peekUntil, null);
});

test('promoting the panel or a dormant island is safe', () => {
  const fromDormant = I.promote(I.create());
  assert.strictEqual(fromDormant.m.state, I.EXPANDED);
  assert.deepStrictEqual(fromDormant.effects, ['expand']);
  const already = I.promote(fromDormant.m);
  assert.strictEqual(already.m.state, I.EXPANDED);
  assert.deepStrictEqual(already.effects, [], 'a second click must not re-fire the morph');
});

test('clicking the band opens the panel, and clicking again closes it', () => {
  const open = I.toggle(I.create(), 100);
  assert.strictEqual(open.m.state, I.EXPANDED);
  assert.deepStrictEqual(open.effects, ['expand']);

  const shut = I.toggle(open.m, 200);
  assert.strictEqual(shut.m.state, I.DORMANT);
  assert.deepStrictEqual(shut.effects, ['collapse']);
});

test('a click that dismisses does not let hover re-open it under the cursor', () => {
  // The click that closes the panel leaves the pointer on the very thing
  // that opens it, so without this the next sample re-expands and the panel
  // can never be dismissed at all.
  const shut = I.toggle(I.toggle(I.create(), 0).m, 100);
  const stillThere = run(shut.m, [[IN, 200], [IN, 400], [IN, 900]]);
  assert.strictEqual(stillThere.m.state, I.DORMANT, 'it reopened under the cursor');
  assert.deepStrictEqual(stillThere.effects, []);

  // Leaving re-arms hover normally.
  const left = run(stillThere.m, [[OUT, 1000]]);
  assert.strictEqual(left.m.suppressHover, false);
  const back = run(left.m, [[IN, 1100], [IN, 1300]]);
  assert.strictEqual(back.m.state, I.EXPANDED, 'hover must work again once the cursor left');
});

test('a deliberate dismissal is not undone by a twitch', () => {
  const shut = I.toggle(I.toggle(I.create(), 0).m, 100);
  assert.strictEqual(shut.m.lastCollapseAt, null,
    'quick-return would reopen it without the dwell, defeating the dismissal');
});

test('clicking the band promotes a peek rather than dismissing it', () => {
  const peeking = I.alert(I.create(), 'session', 0);
  const r = I.toggle(peeking.m, 500);
  assert.strictEqual(r.m.state, I.EXPANDED);
  assert.deepStrictEqual(r.effects, ['unpeek', 'expand']);
});

test('clicking the band cannot close a panel with a task running in it', () => {
  const open = I.toggle(I.create(), 0);
  const busy = { ...open.m, busy: true };
  const r = I.toggle(busy, 100);
  assert.strictEqual(r.m.state, I.EXPANDED, 'a sign-in in progress must not be dismissed');
  assert.deepStrictEqual(r.effects, []);
});

test('wings toggle on and off and never touch the panel state', () => {
  let r = I.toggleWings(I.create());
  assert.strictEqual(r.m.wings, true);
  assert.deepStrictEqual(r.effects, ['wings-on']);
  assert.strictEqual(r.m.state, I.DORMANT);
  r = I.toggleWings(r.m);
  assert.strictEqual(r.m.wings, false);
  assert.deepStrictEqual(r.effects, ['wings-off']);
});

test('the window shows when anything is on screen, hides only when nothing is', () => {
  assert.strictEqual(I.windowVisible(I.create()), false);
  assert.strictEqual(I.windowVisible({ ...I.create(), wings: true }), true);
  assert.strictEqual(I.windowVisible({ ...I.create(), state: I.PEEK }), true);
  assert.strictEqual(I.windowVisible({ ...I.create(), state: I.EXPANDED }), true);
});

test('ticks never mutate their input machine', () => {
  const m = I.create();
  Object.freeze(m);
  assert.doesNotThrow(() => I.tick(m, { ...IN, now: 0 }));
  assert.doesNotThrow(() => I.alert(m, 'session', 0));
  assert.doesNotThrow(() => I.promote(m));
  assert.doesNotThrow(() => I.toggleWings(m));
});

test('a cursor crossing the strip after a collapse stays shut', () => {
  // Quick return used to be OR'd with stillness, so for reentryMs after ANY
  // collapse a cursor merely travelling through armed the dwell — backdated,
  // so it opened on the next sample. The route from the app menus to Control
  // Center runs straight through this strip.
  const collapsed = { ...I.create(), state: I.DORMANT, lastCollapseAt: 1000 };
  const crossing = { inHot: true, inKeepAlive: true, moved: 35, busy: false };
  let m = collapsed;
  for (const now of [1100, 1140, 1180, 1400, 1900]) {
    m = I.tick(m, { ...crossing, now }).m;
    assert.strictEqual(m.state, I.DORMANT, `still shut at ${now}`);
  }
});

test('but a deliberate hover still skips most of the dwell coming back', () => {
  const collapsed = { ...I.create(), state: I.DORMANT, lastCollapseAt: 1000 };
  const parked = { inHot: true, inKeepAlive: true, moved: 0, busy: false };
  const m = I.tick(collapsed, { ...parked, now: 1100 }).m;
  assert.strictEqual(I.tick(m, { ...parked, now: 1140 }).m.state, I.EXPANDED,
    'one sample later, not a whole dwell later');

  const cold = I.tick(I.create(), { ...parked, now: 5000 }).m;
  assert.strictEqual(I.tick(cold, { ...parked, now: 5040 }).m.state, I.DORMANT,
    'a cold hover still serves the full dwell');
  assert.strictEqual(I.tick(cold, { ...parked, now: 5000 + I.T.dwellMs + 40 }).m.state,
    I.EXPANDED);
});

console.log(`\n${passed} island state tests passed`);
