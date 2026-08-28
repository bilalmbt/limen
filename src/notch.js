'use strict';
/**
 * Notch geometry and hover rules, with no dependency on Electron.
 *
 * Kept separate so it can be tested: this is the part where a one point
 * mistake either makes the island impossible to open, or makes it pop up
 * every time the cursor crosses the top of the screen.
 *
 * Detection is by shape, not by table. Every constant you might hardcode is
 * wrong somewhere — the menu bar runs 25–44 pt depending on model AND display
 * scaling, and a 16" notch is wider than a 14" one. But flat Retina MacBook
 * panels are exactly 16:10, and notched panels are 16:10 plus the camera
 * band. So on the internal display:
 *
 *     bounds.height - bounds.width / 1.6 > slack   =>  notched
 *
 * and that difference IS the notch-band height in points, at any scaling.
 */

const G = {
  aspect: 1.6,             // flat Retina MacBook panels are exactly 16:10
  notchSlack: 2,           // rounding tolerance in the aspect rule, in points
  // Measured on real hardware with NSScreen, not derived from screenshots:
  //   MBP 14"  185 x 32 pt at 1512 x 982   -> 185/1512 = 0.12235
  //   MBP 16"  220 x 38 pt at 1800 x 1169  -> 220/1800 = 0.12222
  //   MacBook Air                          -> about 12%
  // The ratio is constant across every notched Mac, so one number covers
  // all of them at any scaling. 0.1223 reproduces both measurements exactly.
  notchWidthRatio: 0.1223,
  // A display with no cutout gets an ANCHOR, not a replica. There is no
  // camera housing to represent, so it is sized to root the island —
  // proportional to the menu bar, which is the one dimension it must sit
  // in — rather than to impersonate hardware that isn't there.
  virtualAnchorScale: 4,
  virtualAnchorMin: 88,
  virtualAnchorMax: 140,
  hotMargin: 24,           // the hot zone extends this far past the notch sides
  fallbackMenuBar: 24,     // hot-strip height when the OS reports none
  panelWidth: 400,         // the expanded panel
  // Wider than the panel on purpose: the wings extend past it on both
  // sides, and a chip clipped by the window edge is worse than a wide
  // transparent window, which costs nothing.
  windowWidth: 660,
  windowSlack: 84,         // below the panel: the shadow reaches 26+56 px
  keepAliveMargin: 16,     // sideways beyond the panel
  keepAliveBottom: 44      // below the panel
};
// Timing (dwell, grace, peek) lives in island-state.js: one owner per constant.

/**
 * What the top of this display looks like.
 * @param {{bounds: {x,y,width,height}, workArea: {x,y,width,height},
 *          internal?: boolean}} display  an Electron Display, or a fixture
 * @param {{notchWidth?: number}} overrides  config trumps the estimate
 */
function metrics(display, overrides = {}) {
  const b = display.bounds;
  const menuBar = Math.max(0, (display.workArea ? display.workArea.y : b.y) - b.y);
  const band = b.height - b.width / G.aspect;
  const notched = display.internal === true && band > G.notchSlack;

  // The notch is exactly as tall as the menu bar — Apple sizes the bar so
  // its background covers the cutout. The ASPECT band is a few points
  // taller (the panel below the cutout is not precisely 16:10), so using it
  // as the height overstated the notch by ~5 pt on every model. The band is
  // still the right fallback for an auto-hidden menu bar, where the
  // physical cutout does not hide along with it.
  const hotHeight = notched
    ? (menuBar > 20 ? menuBar : Math.round(band))
    : (menuBar > 0 ? menuBar : G.fallbackMenuBar);

  const notchWidth = overrides.notchWidth || (notched
    ? Math.round(b.width * G.notchWidthRatio)
    : Math.min(G.virtualAnchorMax,
      Math.max(G.virtualAnchorMin, Math.round(hotHeight * G.virtualAnchorScale))));

  return {
    notched,
    menuBar,
    hotHeight,
    notchWidth,
    centerX: b.x + b.width / 2,
    top: b.y
  };
}

/** Height of the expanded panel for this many gauge rows. */
function panelHeight(rows) {
  const n = Math.max(1, rows);
  return 92 + n * 52;   // header + status strip + rows + padding
}

/** Window placement: centered on the notch, flush with the top of the display. */
function windowBounds(display, rows, overrides = {}) {
  const m = metrics(display, overrides);
  const b = display.bounds;
  const height = Math.min(
    m.hotHeight + panelHeight(rows) + G.windowSlack,
    b.height
  );
  const width = Math.min(G.windowWidth, b.width);
  return {
    x: Math.round(m.centerX - width / 2),
    y: b.y,
    width,
    height
  };
}

/** The strip that reveals the island: the notch plus a margin, top of screen. */
function hotZone(display, overrides = {}) {
  const m = metrics(display, overrides);
  const half = m.notchWidth / 2 + G.hotMargin;
  return {
    left: m.centerX - half,
    right: m.centerX + half,
    top: m.top,
    bottom: m.top + m.hotHeight
  };
}

/**
 * Once open, the island stays while the cursor is inside this area. Kept
 * deliberately tight sideways: a cursor headed for the File menu or a status
 * item has left the island's business, and the island should get out of the
 * way rather than shadow the journey.
 *
 * Invariant (tested): the keep-alive area always contains the hot zone.
 * Anything else flickers: the strip that opens the island would close it.
 */
function keepAlive(display, rows, overrides = {}) {
  const m = metrics(display, overrides);
  const hz = hotZone(display, overrides);
  const panelHalf = G.panelWidth / 2 + G.keepAliveMargin;
  return {
    left: Math.min(hz.left, m.centerX - panelHalf),
    right: Math.max(hz.right, m.centerX + panelHalf),
    top: m.top,
    bottom: m.top + m.hotHeight + panelHeight(rows) + G.keepAliveBottom
  };
}

function inRect(cursor, r) {
  if (!r) return false;
  return cursor.x >= r.left && cursor.x <= r.right &&
    cursor.y >= r.top && cursor.y <= r.bottom;
}

/**
 * The clickable surface while the panel is out. It starts BELOW the menu bar
 * strip on purpose: the island may accept clicks on its own pixels, but a
 * click aimed at a menu title or a status item must never be ours — so the
 * top sliver of the panel (the part tucked under the notch) stays passive.
 */
function panelRect(display, rows, overrides = {}) {
  const m = metrics(display, overrides);
  const half = G.panelWidth / 2;
  return {
    left: m.centerX - half,
    right: m.centerX + half,
    top: m.top + m.hotHeight,
    bottom: m.top + m.hotHeight - 10 + panelHeight(rows)
  };
}

/** The clickable surface while a peek is out: a narrow strip under the notch. */
function peekRect(display, overrides = {}) {
  const m = metrics(display, overrides);
  return {
    left: m.centerX - 170,
    right: m.centerX + 170,
    top: m.top + m.hotHeight,
    bottom: m.top + m.hotHeight + 60
  };
}

/** Is the cursor inside the reveal strip? */
function inHotZone(cursor, display, overrides = {}) {
  return inRect(cursor, hotZone(display, overrides));
}

/** Is the cursor still inside the area that keeps the island open? */
function insideKeepAlive(cursor, display, rows, overrides = {}) {
  return inRect(cursor, keepAlive(display, rows, overrides));
}

/**
 * Which display the island belongs on.
 *
 * The notch only exists on the built-in panel, so that display wins whenever
 * it is present. Without one (clamshell mode, desktop Macs), externalMode
 * decides: 'island' draws a free-floating virtual island on the chosen or
 * primary display, 'off' draws nothing. An unknown preferred id falls back to
 * the primary rather than being positioned off the desktop.
 */
function pickIslandDisplay({ displays, primaryId, externalMode = 'island', preferredId } = {}) {
  const list = displays || [];
  if (!list.length) return null;

  const notched = list.find((d) => metrics(d).notched);
  if (notched) return notched;

  if (externalMode === 'off') return null;
  if (preferredId && preferredId !== 'primary') {
    const chosen = list.find((d) => String(d.id) === String(preferredId));
    if (chosen) return chosen;
  }
  return list.find((d) => d.id === primaryId) || list[0];
}

module.exports = {
  G, metrics, panelHeight, windowBounds, hotZone, keepAlive,
  inRect, inHotZone, insideKeepAlive, panelRect, peekRect, pickIslandDisplay
};
