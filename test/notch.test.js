'use strict';
/* Notch geometry. The aspect rule has to hold across real machines and real
   scaling modes, and the keep-alive area must always contain the hot zone —
   anything else flickers: the strip that opens the island would close it. */

const assert = require('assert');
const N = require('../src/notch');
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok  ' + name); };

/** A display fixture: bounds plus the menu bar the OS reserves. */
const display = (width, height, { internal = true, menuBar = null, x = 0, y = 0, id = 1 } = {}) => {
  const bar = menuBar === null
    ? (internal && height - width / 1.6 > 2 ? Math.round(height - width / 1.6) : 25)
    : menuBar;
  return {
    id,
    internal,
    bounds: { x, y, width, height },
    workArea: { x, y: y + bar, width, height: height - bar }
  };
};

// Real machines, real scaling modes. The band arithmetic is the claim.
const FIXTURES = [
  ['MBP 14" default (1512x982)', display(1512, 982), true, 37],
  ['MBP 14" more space (1800x1169)', display(1800, 1169), true, 44],
  ['MBP 14" larger text (1147x745)', display(1147, 745), true, 28],
  ['MBP 16" default (1728x1117)', display(1728, 1117), true, 37],
  ['Air 13.6" default (1280x832)', display(1280, 832), true, 32],
  ['flat MBP 13" (1440x900)', display(1440, 900), false, null],
  ['flat MBP (1280x800)', display(1280, 800), false, null],
  ['external 16:9 (1920x1080)', display(1920, 1080, { internal: false, menuBar: 25 }), false, null],
  ['iMac-like internal 16:9 (2240x1260)', display(2240, 1260), false, null]
];

test('the aspect rule detects every notched fixture and no flat one', () => {
  for (const [name, d, notched, band] of FIXTURES) {
    const m = N.metrics(d);
    assert.strictEqual(m.notched, notched, `${name}: notched should be ${notched}`);
    if (notched) assert.strictEqual(m.hotHeight, band, `${name}: band should be ${band}`);
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
  const d = display(1512, 982, { menuBar: 0 });
  assert.strictEqual(N.metrics(d).hotHeight, 37, 'the physical band does not hide');
});

test('a flat display with no menu bar still gets a usable hot strip', () => {
  const d = display(1920, 1080, { internal: false, menuBar: 0 });
  assert.strictEqual(N.metrics(d).hotHeight, N.G.fallbackMenuBar);
});

test('notch width scales with the display and yields ~12.5% of logical width', () => {
  const m14 = N.metrics(display(1512, 982));
  const m16 = N.metrics(display(1728, 1117));
  assert.strictEqual(m14.notchWidth, 189);
  assert.strictEqual(m16.notchWidth, 216);
  assert.ok(m16.notchWidth > m14.notchWidth, 'the 16" notch is wider than the 14"');
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
