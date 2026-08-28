'use strict';
/* Notch geometry. The aspect rule has to hold across real machines and real
   scaling modes, and the keep-alive area must always contain the hot zone —
   anything else flickers: the strip that opens the island would close it. */

const assert = require('assert');
const N = require('../src/notch');
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok  ' + name); };

/** A display fixture: bounds plus the menu bar the OS reserves. */
const display = (width, height, { internal = true, menuBar = 25, x = 0, y = 0, id = 1 } = {}) => ({
  id,
  internal,
  bounds: { x, y, width, height },
  workArea: { x, y: y + menuBar, width, height: height - menuBar }
});

/**
 * Real machines with their MEASURED menu-bar heights — the notch is exactly
 * as tall as the bar, so these are the notch heights too. Note they are a
 * few points SHORTER than the aspect band (982 - 1512/1.6 = 37, not 32):
 * the panel below the cutout is not precisely 16:10, which is why the band
 * detects a notch but must not be used to size one.
 */
const FIXTURES = [
  ['MBP 14" default (1512x982)', display(1512, 982, { menuBar: 32 }), true, 32, 185],
  ['MBP 16" default (1728x1117)', display(1728, 1117, { menuBar: 38 }), true, 38, 211],
  ['MBP 16" more space (1800x1169)', display(1800, 1169, { menuBar: 38 }), true, 38, 220],
  ['MBP 14" larger text (1147x745)', display(1147, 745, { menuBar: 25 }), true, 25, 140],
  ['Air 13.6" default (1280x832)', display(1280, 832, { menuBar: 32 }), true, 32, 157],
  ['flat MBP 13" (1440x900)', display(1440, 900), false, 25, null],
  ['flat MBP (1280x800)', display(1280, 800), false, 25, null],
  ['external 16:9 (1920x1080)', display(1920, 1080, { internal: false }), false, 25, null],
  ['iMac-like internal 16:9 (2240x1260)', display(2240, 1260), false, 25, null]
];

test('the aspect rule detects every notched fixture and no flat one', () => {
  for (const [name, d, notched] of FIXTURES) {
    assert.strictEqual(N.metrics(d).notched, notched, `${name}: notched should be ${notched}`);
  }
});

test('a notch is exactly as tall as the menu bar, not as tall as the aspect band', () => {
  for (const [name, d, notched, height] of FIXTURES) {
    if (!notched) continue;
    assert.strictEqual(N.metrics(d).hotHeight, height, `${name}: height should be ${height}`);
  }
  // The measured case that proves the point. The 14" band computes to 37,
  // the real cutout is 32: the panel below it is not precisely 16:10, so
  // the band detects a notch honestly but sizes one badly.
  const mbp14 = N.metrics(display(1512, 982, { menuBar: 32 }));
  assert.strictEqual(Math.round(982 - 1512 / 1.6), 37, 'the band says 37');
  assert.strictEqual(mbp14.hotHeight, 32, 'the hardware says 32, and the menu bar reports it');
});

test('notch width matches the measured 12.2% on every real machine', () => {
  for (const [name, d, notched, , width] of FIXTURES) {
    if (!notched) continue;
    assert.strictEqual(N.metrics(d).notchWidth, width, `${name}: width should be ${width}`);
  }
});

test('a flat 16:10 panel is flat even when marked internal', () => {
  assert.strictEqual(N.metrics(display(1440, 900)).notched, false);
});

test('a notched-shaped external display is never treated as notched', () => {
  const d = display(1512, 982, { internal: false });
  assert.strictEqual(N.metrics(d).notched, false);
});

test('an auto-hidden menu bar does not erase the hot strip on a notched panel', () => {
  // With the bar hidden there is nothing to measure, so the aspect band is
  // the fallback: a few points generous, but the cutout is still there.
  const d = display(1512, 982, { menuBar: 0 });
  assert.strictEqual(N.metrics(d).hotHeight, 37, 'the physical cutout does not hide');
});

test('a display with no cutout gets an anchor, not a replica of one', () => {
  // The point of the change: we were drawing a 196 pt "notch" on machines
  // that have no camera housing at all — wider than a real 14" notch.
  const mini = N.metrics(display(1728, 1080, { internal: false, menuBar: 30 }));
  assert.strictEqual(mini.notched, false);
  assert.strictEqual(mini.notchWidth, 120, 'four times the menu bar, not a fake notch');
  const realNotchHere = Math.round(1728 * 0.122);
  assert.ok(mini.notchWidth < realNotchHere * 0.6,
    `an anchor should be well under a real notch (${realNotchHere} pt) on the same display`);
});

test('the anchor scales with the bar but stays within sane bounds', () => {
  const tiny = N.metrics(display(1280, 800, { internal: false, menuBar: 20 }));
  assert.strictEqual(tiny.notchWidth, 88, 'clamped so it never becomes a stub');
  const huge = N.metrics(display(3840, 2160, { internal: false, menuBar: 44 }));
  assert.strictEqual(huge.notchWidth, 140, 'clamped so it never becomes a slab');
});

test('a flat display with no menu bar still gets a usable hot strip', () => {
  const d = display(1920, 1080, { internal: false, menuBar: 0 });
  assert.strictEqual(N.metrics(d).hotHeight, N.G.fallbackMenuBar);
});

test('notch width scales with the display, so any scaling mode is covered', () => {
  const m14 = N.metrics(display(1512, 982, { menuBar: 32 }));
  const m16 = N.metrics(display(1728, 1117, { menuBar: 38 }));
  assert.strictEqual(m14.notchWidth, 185, 'the measured 14" figure');
  assert.strictEqual(m16.notchWidth, 211);
  assert.ok(m16.notchWidth > m14.notchWidth, 'the 16" notch is wider than the 14"');
  // Same machine, different scaling: the ratio holds where a table would not.
  assert.strictEqual(N.metrics(display(1800, 1169, { menuBar: 38 })).notchWidth, 220);
});

test('a configured notch width beats the estimate', () => {
  const m = N.metrics(display(1512, 982), { notchWidth: 200 });
  assert.strictEqual(m.notchWidth, 200);
});

test('the hot zone straddles the notch and never leaves the top strip', () => {
  for (const [name, d] of FIXTURES) {
    const m = N.metrics(d);
    const hz = N.hotZone(d);
    assert.ok(hz.left < m.centerX && hz.right > m.centerX, `${name}: zone must straddle center`);
    assert.strictEqual(hz.top, d.bounds.y, `${name}: zone starts at the top edge`);
    assert.ok(hz.bottom - hz.top <= 50, `${name}: the zone is a strip, not a region`);
  }
});

test('INVARIANT: keep-alive contains the hot zone on every fixture and row count', () => {
  for (const [name, d] of FIXTURES) {
    for (const rows of [1, 2, 3, 5, 6]) {
      const hz = N.hotZone(d);
      const ka = N.keepAlive(d, rows);
      assert.ok(ka.left <= hz.left && ka.right >= hz.right &&
        ka.top <= hz.top && ka.bottom >= hz.bottom,
        `${name} rows=${rows}: the area that keeps the island open must contain the strip that opens it`);
    }
  }
});

test('every corner of the hot zone tests as inside both zones', () => {
  const d = display(1512, 982);
  const hz = N.hotZone(d);
  for (const p of [
    { x: hz.left, y: hz.top }, { x: hz.right, y: hz.top },
    { x: hz.left, y: hz.bottom }, { x: hz.right, y: hz.bottom }
  ]) {
    assert.ok(N.inHotZone(p, d), `corner ${p.x},${p.y} missed the hot zone`);
    assert.ok(N.insideKeepAlive(p, d, 3), `corner ${p.x},${p.y} missed keep-alive`);
  }
});

test('just outside the strip is outside', () => {
  const d = display(1512, 982);
  const hz = N.hotZone(d);
  assert.ok(!N.inHotZone({ x: hz.left - 1, y: hz.top }, d));
  assert.ok(!N.inHotZone({ x: hz.left, y: hz.bottom + 1 }, d));
});

test('the window is centered on the notch and stays on the display', () => {
  for (const [name, d] of FIXTURES) {
    for (const rows of [1, 3, 6]) {
      const b = N.windowBounds(d, rows);
      const center = b.x + b.width / 2;
      assert.ok(Math.abs(center - N.metrics(d).centerX) <= 1, `${name}: off-center`);
      assert.strictEqual(b.y, d.bounds.y, `${name}: flush with the top`);
      assert.ok(b.x >= d.bounds.x && b.x + b.width <= d.bounds.x + d.bounds.width,
        `${name}: window leaves the display`);
      assert.ok(b.height <= d.bounds.height, `${name}: taller than the display`);
    }
  }
});

test('the window is tall enough for the panel plus the notch band', () => {
  const d = display(1512, 982);
  const b = N.windowBounds(d, 5);
  assert.ok(b.height >= N.metrics(d).hotHeight + N.panelHeight(5), 'the panel would be clipped');
});

test('a display sitting at negative coordinates keeps its zones aligned', () => {
  const d = display(1512, 982, { x: -1512, y: -200 });
  const hz = N.hotZone(d);
  assert.strictEqual(hz.top, -200);
  assert.ok(N.inHotZone({ x: -1512 + 756, y: -190 }, d), 'center of the notch missed');
});

test('the notched built-in display wins whenever it is present', () => {
  const laptop = display(1512, 982, { id: 1 });
  const ext = display(1920, 1080, { internal: false, menuBar: 25, id: 2 });
  const picked = N.pickIslandDisplay({ displays: [ext, laptop], primaryId: 2 });
  assert.strictEqual(picked.id, 1);
});

test('clamshell mode falls back to the primary, or to nothing when told off', () => {
  const ext = display(1920, 1080, { internal: false, menuBar: 25, id: 2 });
  const ext2 = display(2560, 1440, { internal: false, menuBar: 25, id: 3 });
  assert.strictEqual(N.pickIslandDisplay({ displays: [ext, ext2], primaryId: 3 }).id, 3);
  assert.strictEqual(N.pickIslandDisplay({ displays: [ext], primaryId: 2, externalMode: 'off' }), null);
});

test('a preferred display that was unplugged falls back to the primary', () => {
  const ext = display(1920, 1080, { internal: false, menuBar: 25, id: 2 });
  const picked = N.pickIslandDisplay({ displays: [ext], primaryId: 2, preferredId: '99' });
  assert.strictEqual(picked.id, 2, 'an unknown id must not position the island off the desktop');
});

test('no displays means no island, not a crash', () => {
  assert.strictEqual(N.pickIslandDisplay({ displays: [], primaryId: 1 }), null);
  assert.strictEqual(N.pickIslandDisplay(), null);
});

test('the clickable surfaces never cover the menu bar strip', () => {
  for (const [name, d] of FIXTURES) {
    const m = N.metrics(d);
    for (const r of [N.panelRect(d, 3), N.peekRect(d)]) {
      assert.ok(r.top >= d.bounds.y + m.hotHeight,
        `${name}: a click aimed at a menu title must never be ours`);
      assert.ok(r.left < m.centerX && r.right > m.centerX, `${name}: surface must straddle center`);
    }
  }
});

test('the clickable surfaces stay inside the keep-alive area', () => {
  for (const [name, d] of FIXTURES) {
    const ka = N.keepAlive(d, 3);
    for (const r of [N.panelRect(d, 3), N.peekRect(d)]) {
      assert.ok(r.left >= ka.left && r.right <= ka.right && r.bottom <= ka.bottom,
        `${name}: a clickable point outside keep-alive would collapse under the cursor`);
    }
  }
});

console.log(`\n${passed} notch geometry tests passed`);
