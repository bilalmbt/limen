'use strict';
/* The state machine. Every timing promise the proposal makes is a test here:
   a graze must not open the panel, a menu must never stay shadowed, a peek
   must retract on its own, and an alert must never demote the full panel. */

const assert = require('assert');
const I = require('../src/island-state');
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok  ' + name); };

const IN = { inHot: true, inKeepAlive: true };
const NEAR = { inHot: false, inKeepAlive: true };   // over the open panel
const OUT = { inHot: false, inKeepAlive: false };

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

test('a mouse-down collapses the panel immediately, no grace', () => {
  const { m } = run(I.create(), [[IN, 0], [IN, 130]]);
  const r = I.mouseDown(m);
  assert.strictEqual(r.m.state, I.DORMANT);
  assert.deepStrictEqual(r.effects, ['collapse']);
});

test('a mouse-down dismisses a peek', () => {
  const r = I.mouseDown(I.alert(I.create(), 'session', 0).m);
  assert.strictEqual(r.m.state, I.DORMANT);
  assert.deepStrictEqual(r.effects, ['unpeek']);
});

test('a mouse-down while dormant changes nothing visible', () => {
  const r = I.mouseDown(I.create());
  assert.strictEqual(r.m.state, I.DORMANT);
  assert.deepStrictEqual(r.effects, []);
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
  assert.doesNotThrow(() => I.mouseDown(m));
  assert.doesNotThrow(() => I.promote(m));
  assert.doesNotThrow(() => I.toggleWings(m));
});

console.log(`\n${passed} island state tests passed`);
