'use strict';
/* The renderer only draws. It receives gauges, geometry, and state over IPC
   and answers with nothing but pixels: the window is click-through in every
   state, so nothing here is a control. Wording and tones come from the
   shared viewmodel (VM), which is tested in Node. */

/* global VM */

const $ = (sel) => document.querySelector(sel);

const state = {
  geometry: null,
  data: { ok: false, reason: 'loading', gauges: [] },
  panelOpen: false,
  peek: null,        // { gaugeId } or null
  wings: false
};

// The shape currently in the DOM, so rows are rebuilt only when they must be.
let renderedIds = null;

// --- geometry ---------------------------------------------------------------

window.island.onGeometry((g) => {
  state.geometry = g;
  const root = document.documentElement.style;
  root.setProperty('--hot-h', `${g.hotHeight}px`);
  root.setProperty('--notch-w', `${g.notchWidth}px`);
  root.setProperty('--panel-w', `${g.panelWidth}px`);
  render();
});

window.island.onUsage((d) => { state.data = d || state.data; render(); });
window.island.onPanel((open) => {
  const opening = open === true && !state.panelOpen;
  state.panelOpen = open === true;
  if (opening) beginEntrance();
  else if (!state.panelOpen) $('#panel').classList.remove('entering');
  render();
});
window.island.onPeek((p) => { state.peek = p || null; render(); });
window.island.onWings((on) => { state.wings = on === true; render(); });

// Relative labels ("resets in 51 min") drift; keep them honest. Rows are
// reconciled in place, so this tick never disturbs a running animation.
setInterval(() => { if (state.panelOpen || state.peek) render(); }, 30000);

// The two fixed controls. The window only takes the mouse while the cursor
// is over the island's surface, so these never intercept an outside click.
$('#refresh-btn').addEventListener('click', (e) => {
  spin(e.currentTarget);
  window.island.act('refresh');
});
$('#peek').addEventListener('click', () => window.island.act('expand'));

/** A control should answer the click itself, before the data comes back. */
function spin(btn) {
  btn.classList.remove('spinning');
  void btn.offsetWidth;          // restart the animation on a rapid second click
  btn.classList.add('spinning');
  setTimeout(() => btn.classList.remove('spinning'), 700);
}

/**
 * Replay the opening choreography: the surface springs out, then the rows
 * resolve in sequence and the bars grow into place. Rebuilding the rows is
 * what arms the bar growth, so the entrance is the one moment we discard
 * the reconciled DOM on purpose.
 */
let entranceTimer = null;
function beginEntrance() {
  const panel = $('#panel');
  renderedIds = null;
  panel.classList.remove('entering');
  void panel.offsetWidth;        // restart the staggered animations
  panel.classList.add('entering');
  clearTimeout(entranceTimer);
  entranceTimer = setTimeout(() => panel.classList.remove('entering'), 1000);
}

// --- painting ---------------------------------------------------------------

function locale() { return (state.geometry && state.geometry.locale) || undefined; }
function timeFormat() { return (state.geometry && state.geometry.timeFormat) || 'auto'; }

function setRing(el, percent) {
  el.style.setProperty('--p', String(Math.max(0, Math.min(100, percent))));
  el.style.setProperty('--tone', `var(--${VM.tone(percent)})`);
}

function render() {
  renderAnchor();
  renderWings();
  renderPeek();
  renderPanel();
  reportSurface();
}

/**
 * Tell the main process where the island actually is, so it can take the
 * mouse over those pixels and nowhere else. Measured, never assumed: the
 * panel is sized from the wings band and its height is content-driven, so
 * any rect derived from constants drifts from what is drawn — and the gap
 * is a transparent window that silently eats clicks.
 *
 * The wings are deliberately excluded. They sit in the menu-bar strip, and
 * taking the mouse there would intercept clicks meant for menu titles.
 */
function reportSurface() {
  const rects = [];
  for (const el of [$('#panel'), $('#peek')]) {
    if (!el || el.classList.contains('off')) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) rects.push(r);
  }
  if (!rects.length) return window.island.reportSurface(null);
  window.island.reportSurface({
    left: Math.min(...rects.map((r) => r.left)),
    top: Math.min(...rects.map((r) => r.top)),
    right: Math.max(...rects.map((r) => r.right)),
    bottom: Math.max(...rects.map((r) => r.bottom))
  });
}

/** The drawn notch: only on displays that lack a real one, only when out.
    A side a wing joins goes square, so band and chip merge into one shape. */
function renderAnchor() {
  const anything = state.panelOpen || state.peek || state.wings;
  const virtual = state.geometry && state.geometry.notched === false;
  const model = VM.wingsModel(state.data.gauges);
  const wingsShowing = state.wings && Boolean(model);
  const el = $('#fakenotch');
  el.classList.toggle('off', !(virtual && anything));
  el.classList.toggle('join-left', wingsShowing && Boolean(model && model.left));
  el.classList.toggle('join-right', wingsShowing && Boolean(model && model.right));
}

function renderWings() {
  const wingsEl = $('#wings');
  const model = VM.wingsModel(state.data.gauges);
  // Wings stay out while the panel is open: the band is part of the island,
  // and a band that shrinks when the panel morphs would break the shape.
  const show = state.wings && Boolean(model);
  wingsEl.classList.toggle('off', !show);
  // With the panel flush below, the band's outer corners go square: the
  // surface continues downward, and a rounded corner would bite the seam.
  wingsEl.classList.toggle('merged', show && state.panelOpen);
  if (!show) return;

  const fill = (side, gauge) => {
    const el = wingsEl.querySelector(`.wing.${side}`);
    el.classList.toggle('empty', !gauge);
    if (!gauge) return;
    el.querySelector('.tag').textContent = VM.wingTag(gauge);
    setRing(el.querySelector('.ring'), gauge.percent);
    el.querySelector('.pct').textContent = `${gauge.percent}%`;
    el.title = `${VM.rowLabel(gauge)} — ${gauge.percent}% used`;
  };
  fill('left', model.left);
  fill('right', model.right);
}

function renderPeek() {
  const el = $('#peek');
  // Resolve the gauge before revealing anything: a peek with nothing to say
  // must stay hidden, not animate out as an empty dark pill.
  const gauges = state.data.gauges || [];
  const gauge = state.peek
    ? (gauges.find((g) => g.id === state.peek.gaugeId) || gauges[0])
    : null;
  el.classList.toggle('off', !gauge);
  if (!gauge) return;
  setRing(el.querySelector('.ring'), gauge.percent);
  el.querySelector('.peek-title').textContent = `${VM.rowLabel(gauge)} ${gauge.percent}%`;
  el.querySelector('.peek-sub').textContent =
    VM.resetLabel(gauge, Date.now(), locale(), timeFormat());
}

/**
 * The panel's edges are derived, never guessed: with wings out, it spans
 * exactly from the left chip's outer edge to the right chip's outer edge
 * (measured, since chips are content-sized), so band and panel share flush
 * sides. Without wings it centers at its default width.
 */
function alignPanel(panel) {
  const g = state.geometry;
  if (!g) return;
  const center = document.documentElement.clientWidth / 2;
  let left = center - g.panelWidth / 2;
  let width = g.panelWidth;

  const model = VM.wingsModel(state.data.gauges);
  if (state.wings && model) {
    const l = $('#wings .wing.left');
    const r = $('#wings .wing.right');
    const bandLeft = !l.classList.contains('empty')
      ? l.getBoundingClientRect().left
      : center - g.notchWidth / 2;
    const bandRight = !r.classList.contains('empty')
      ? r.getBoundingClientRect().right
      : center + g.notchWidth / 2;
    const bandWidth = bandRight - bandLeft;
    width = Math.max(bandWidth, 340);   // never so narrow the rows squeeze
    left = bandLeft + bandWidth / 2 - width / 2;
  }
  // Exact fractional pixels: rounding left and width independently drifts
  // the edges a device pixel away from the chips they must sit flush with.
  panel.style.left = `${left}px`;
  panel.style.width = `${width}px`;
}

function renderPanel() {
  const panel = $('#panel');
  alignPanel(panel);
  panel.classList.toggle('off', !state.panelOpen);
  if (!state.panelOpen) return;

  const d = state.data;
  const gauges = d.gauges || [];
  const stale = d.stale === true || d.ok === false;
  panel.classList.toggle('stale', stale);

  const when = d.fetchedAt
    ? new Date(d.fetchedAt).toLocaleTimeString(locale(), VM.timeOptions(timeFormat()))
    : '';
  const whenWord = !gauges.length ? 'checked' : (stale ? 'as of' : 'refreshed');
  $('#panel .when').textContent = when ? `${whenWord} ${when}` : '';

  // With no numbers at all the empty note carries the message alone; a stale
  // strip on top of it would say the same thing twice.
  const staleEl = $('#stale');
  staleEl.classList.toggle('off', !stale || !gauges.length);
  if (stale && gauges.length) {
    staleEl.querySelector('.stale-text').textContent =
      VM.staleLine(d.reason, d.retryAt, Date.now());
  }

  const note = VM.ceilingNote(d);
  const ceilingEl = $('#ceiling');
  ceilingEl.classList.toggle('off', !note);
  ceilingEl.textContent = note;

  const rowsEl = $('#rows');
  // The reason only shapes the DOM when there are no gauges to draw; letting
  // it into the key otherwise tore the rows down mid-entrance (a 'loading'
  // placeholder becoming a real reading on the very first hover), restarting
  // the stagger for the rows but not the header.
  const shape = gauges.length
    ? gauges.map((g) => g.id).join('|')
    : `empty#${d.reason || ''}#${d.ok}`;

  // Rebuild only when the shape of the panel changes; otherwise update the
  // existing nodes so bars can transition to their new values and a running
  // entrance is never yanked out from under itself.
  const rebuilt = shape !== renderedIds;
  if (rebuilt) {
    renderedIds = shape;
    rowsEl.textContent = '';
    if (!gauges.length) {
      const note = document.createElement('div');
      note.className = 'empty-note';
      // A successful answer with no limits is its own case, not an "unknown" error.
      note.textContent = d.ok ? 'no limits exposed for this account' : VM.reasonLabel(d.reason);
      rowsEl.appendChild(note);
      appendSignIn(rowsEl, d.reason);
      return;
    }
    gauges.forEach((gauge, i) => rowsEl.appendChild(buildRow(gauge, i)));
    // Commit the zero-width bars before filling them, so the growth is a
    // transition rather than an instant paint.
    void rowsEl.offsetHeight;
  } else if (!gauges.length) {
    return;
  }

  const rowEls = rowsEl.querySelectorAll('.row');
  gauges.forEach((gauge, i) => fillRow(rowEls[i], gauge, stale, when));
  syncSignIn(rowsEl, d.reason);
}

/**
 * The sign-in button belongs wherever the credential problem is reported —
 * including alongside stale rows. A cached reading is the NORMAL case when a
 * token expires, and hiding the fix behind "no gauges at all" meant the
 * button was absent in exactly the situation it exists for.
 */
function syncSignIn(rowsEl, reason) {
  const existing = rowsEl.querySelector('.btn');
  if (!VM.isCredentialProblem(reason)) {
    if (existing) existing.remove();
    return;
  }
  if (existing) return;   // never replace a button mid-sign-in
  appendSignIn(rowsEl, reason);
}

/** The row's structure, with its bar at zero so it can grow into place. */
function buildRow(gauge, index) {
  const row = document.createElement('div');
  row.className = 'row';
  row.style.setProperty('--i', String(index));   // drives the entrance stagger

  const head = document.createElement('div');
  head.className = 'row-head';
  const name = document.createElement('span');
  name.className = 'row-name';
  const reset = document.createElement('span');
  reset.className = 'row-reset';
  head.append(name, reset);

  const bar = document.createElement('div');
  bar.className = 'bar';
  const fill = document.createElement('i');
  fill.style.width = '0%';
  bar.appendChild(fill);

  const pct = document.createElement('div');
  pct.className = 'row-pct';

  row.append(head, bar, pct);
  return row;
}

/** The row's content, written into whichever nodes are already there. */
function fillRow(row, gauge, stale, when) {
  if (!row) return;
  const name = row.querySelector('.row-name');
  name.textContent = VM.rowLabel(gauge);
  if (gauge.active) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'active limit';
    name.appendChild(badge);
  }
  row.querySelector('.row-reset').textContent =
    VM.resetLabel(gauge, Date.now(), locale(), timeFormat());

  const fill = row.querySelector('.bar > i');
  fill.className = `tone-${VM.tone(gauge.percent)}`;
  fill.style.width = `${Math.max(0, Math.min(100, gauge.percent))}%`;

  row.querySelector('.row-pct').textContent =
    stale ? `${gauge.percent}% as of ${when}` : `${gauge.percent}% used`;
}

/** The one-click fix, right where the problem is reported. */
function appendSignIn(parent, reason) {
  if (!VM.isCredentialProblem(reason)) return;
  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.textContent = 'Sign in with Claude Code';
  btn.addEventListener('click', () => {
    btn.textContent = 'signing in…';
    btn.disabled = true;
    window.island.act('sign-in');
  });
  parent.appendChild(btn);
}
