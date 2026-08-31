'use strict';
/* The renderer's own modules, required for real — no transcription. These
   files are UMD exactly so this test can hold the code that ships: the two
   button bugs this file exists for were invisible to every other test, and
   a transcribed copy of the fix drifts from the fix. */

const assert = require('assert');
const VM = require('../src/viewmodel');
const dom = require('../src/renderer/dom');
const { createStore } = require('../src/renderer/store');
const selectors = require('../src/renderer/selectors');
const band = require('../src/renderer/band');
const { syncActionButtons } = require('../src/renderer/panel');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok  ' + name); };

/** Just enough DOM: class names, children, listeners, querySelector. */
function makeEl(tag = 'div') {
  const el = {
    tagName: tag,
    className: '',
    textContent: '',
    disabled: false,
    children: [],
    listeners: {},
    appendChild(child) { this.children.push(child); child.parent = this; return child; },
    remove() {
      if (!this.parent) return;
      this.parent.children = this.parent.children.filter((c) => c !== this);
      this.parent = null;
    },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    click() { for (const fn of this.listeners.click || []) fn(); },
    querySelector(sel) {
      const want = sel.split('.').filter(Boolean);
      const hit = (n) => {
        const classes = String(n.className).split(/\s+/);
        return want.every((w) => classes.includes(w));
      };
      const walk = (n) => {
        for (const c of n.children) {
          if (hit(c)) return c;
          const deep = walk(c);
          if (deep) return deep;
        }
        return null;
      };
      return walk(this);
    }
  };
  return el;
}
const doc = { createElement: (tag) => makeEl(tag) };

const names = (rows) => rows.children.map((c) => c.className);
const noop = () => {};

/** Drive the real pipeline the way panel.render does: decide, then apply. */
function sync(rows, data, signinStatus, act = noop) {
  syncActionButtons(rows, VM.panelButtons(data, signinStatus), act, doc, dom);
}

// One gauge, because the prime button belongs under real rows: an empty
// panel has never carried it, and panelButtons enforces that.
const GAUGES = [{ id: 'session', kind: 'session', percent: 10 }];

test('the sign-in button does not delete the prime button', () => {
  // `.btn` matched `btn btn-prime`. Every render with healthy data found the
  // prime button, decided it was a sign-in button that should not exist, and
  // removed it — after which the prime sync built a fresh one. A click
  // landing in that gap did nothing at all.
  const rows = makeEl();
  sync(rows, { canPrime: true, reason: null, gauges: GAUGES }, null);
  const before = rows.children[0];
  for (let render = 0; render < 5; render++) {
    sync(rows, { canPrime: true, reason: null, gauges: GAUGES }, null);
  }
  assert.deepStrictEqual(names(rows), ['btn btn-prime']);
  assert.strictEqual(rows.children[0], before,
    'the same node survives every render — it is not destroyed and rebuilt');
});

test('a credential problem swaps prime for sign-in, and back', () => {
  const rows = makeEl();
  sync(rows, { canPrime: true, reason: null, gauges: GAUGES }, null);
  // Token expires. The prime button must go and the sign-in button appear —
  // in the same render, not one render each.
  sync(rows, { canPrime: true, reason: 'token-expired', gauges: GAUGES }, null);
  assert.deepStrictEqual(names(rows), ['btn btn-signin'],
    'exactly one button, and it is the one that can help');

  sync(rows, { canPrime: true, reason: null, gauges: GAUGES }, null);
  assert.deepStrictEqual(names(rows), ['btn btn-prime']);
});

test('the sign-in button relabels when only the status changed', () => {
  // The bug: with no gauges the render returned before the button sync, so a
  // signin message — which carries no data change — repainted nothing. The
  // button stayed on its first label through the entire flow.
  const rows = makeEl();
  const data = { reason: 'token-expired', accountLive: true, sessionOpen: true, gauges: [] };
  sync(rows, data, null);
  assert.strictEqual(rows.children[0].textContent, 'Refresh from Claude Code');

  sync(rows, data, 'working');
  assert.strictEqual(rows.children[0].textContent, 'Signing in…');
  assert.strictEqual(rows.children[0].disabled, true);

  sync(rows, data, 'needs-terminal');
  assert.strictEqual(rows.children[0].textContent, 'Open Terminal to finish');
  assert.strictEqual(rows.children[0].disabled, false, 'and it can be pressed');

  assert.strictEqual(rows.children.length, 1, 'one button throughout, not four');
});

test('a prime in flight does not remove the sign-in button', () => {
  const rows = makeEl();
  sync(rows, { canPrime: false, reason: 'token-expired', gauges: GAUGES }, 'priming');
  assert.deepStrictEqual(names(rows), ['btn btn-signin'],
    'a credential problem outranks a prime: the prime cannot work anyway');
});

test('the prime button reports its own outcomes, and locks while working', () => {
  const rows = makeEl();
  const live = { canPrime: true, reason: null, gauges: GAUGES };
  sync(rows, live, null);
  assert.strictEqual(rows.children[0].textContent, 'Open a session window');
  sync(rows, live, 'priming');
  assert.strictEqual(rows.children[0].textContent, 'Opening a window…');
  assert.strictEqual(rows.children[0].disabled, true, 'no second click while one runs');
  sync(rows, live, 'prime-failed');
  assert.strictEqual(rows.children[0].textContent, 'Could not open — try again');
  assert.strictEqual(rows.children[0].disabled, false);
});

test('the buttons are wired to their own actions, not each other’s', () => {
  const sent = [];
  const act = (name) => sent.push(name);
  const rows = makeEl();
  sync(rows, { canPrime: true, reason: null, gauges: GAUGES }, null, act);
  rows.children[0].click();
  sync(rows, { canPrime: true, reason: 'token-expired', gauges: GAUGES }, null, act);
  rows.children[0].click();
  assert.deepStrictEqual(sent, ['prime', 'sign-in']);
});

// --- the store: one direction, every subscriber told once per patch --------

test('the store merges patches and notifies with the merged state', () => {
  const store = createStore({ a: 1, b: 2 });
  const seen = [];
  store.subscribe((s) => seen.push({ ...s }));
  store.patch({ b: 3 });
  store.patch({ c: 4 });
  assert.deepStrictEqual(seen, [{ a: 1, b: 3 }, { a: 1, b: 3, c: 4 }]);
  assert.strictEqual(store.get().c, 4);
});

test('a null reading kept at the call site never reaches the store', () => {
  // The onUsage handler patches `d || store.get().data` — this is the
  // property that rule protects: state.data is always a reading.
  const store = createStore({ data: { ok: true, gauges: [] } });
  const d = null;
  store.patch({ data: d || store.get().data });
  assert.deepStrictEqual(store.get().data, { ok: true, gauges: [] });
});

// --- selectors: the defaults several painters share -------------------------

test('selectors fall back the way the app promises', () => {
  const empty = { geometry: null, data: null };
  assert.strictEqual(selectors.locale(empty), undefined);
  assert.strictEqual(selectors.timeFormat(empty), 'auto');
  assert.strictEqual(selectors.wingInfo(empty), 'off');
  assert.deepStrictEqual(selectors.wingSources(empty), ['session'],
    'an unset band shows the session — never nothing');
  assert.deepStrictEqual(selectors.wingSources({ data: { wingSources: [] } }),
    ['session'], 'an empty list is unset, not a request for an empty band');
});

test('wingsShowing is one answer: flag AND model AND readable account', () => {
  const model = { left: [], right: [{}] };
  const on = { wings: true, data: { reason: null } };
  assert.strictEqual(selectors.wingsShowing(on, model, VM), true);
  assert.strictEqual(selectors.wingsShowing({ ...on, wings: false }, model, VM), false);
  assert.strictEqual(selectors.wingsShowing(on, null, VM), false);
  assert.strictEqual(selectors.wingsShowing(
    { wings: true, data: { reason: 'token-expired' } }, model, VM), false,
    'a signed-out account keeps its chips out of the menu bar');
});

test('the drawn notch follows the chips, not the wings flag', () => {
  const model = { left: [], right: [{}] };
  const base = { panelOpen: false, peek: null, wings: true, data: { reason: null } };
  assert.strictEqual(selectors.islandSaysSomething(base, model, VM), true,
    'chips out: the anchor roots them');
  assert.strictEqual(selectors.islandSaysSomething(
    { ...base, data: { reason: 'token-expired' } }, model, VM), false,
    'signed out: no chips, so no bare anchor wearing yesterday’s plan');
  assert.strictEqual(selectors.islandSaysSomething({ ...base, wings: false }, model, VM), false);
  assert.strictEqual(selectors.islandSaysSomething(
    { ...base, data: { reason: 'token-expired' }, panelOpen: true }, model, VM), true,
    'an open panel is something to say whatever the account state');
  assert.strictEqual(selectors.islandSaysSomething(
    { ...base, wings: false, peek: { gaugeId: 'session' } }, model, VM), true);
});

// --- the band contract ------------------------------------------------------

test('bandExtent starts at the notch and grows to the drawn chips', () => {
  const wing = (offsetLeft, offsetWidth, empty = false) => ({
    offsetLeft, offsetWidth,
    classList: { contains: (c) => c === 'empty' && empty }
  });
  const page = (wings) => ({
    documentElement: { clientWidth: 800 },
    querySelectorAll: () => wings
  });
  assert.deepStrictEqual(band.bandExtent(page([]), 120),
    { left: 340, right: 460, width: 120 }, 'no chips: the notch is the band');
  assert.deepStrictEqual(band.bandExtent(page([wing(300, 80), wing(460, 90)]), 120),
    { left: 300, right: 550, width: 250 }, 'chips stretch it on both sides');
  assert.deepStrictEqual(band.bandExtent(page([wing(0, 700, true)]), 120),
    { left: 340, right: 460, width: 120 }, 'an empty chip is not drawn, so it does not count');
});

test('the panel floor is the one the wings also read', () => {
  assert.strictEqual(band.PANEL_MIN, 300,
    'measured, not chosen — change it in band.js and both sides follow');
});

console.log(`\n${passed} renderer tests passed`);
