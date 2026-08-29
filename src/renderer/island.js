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
  wings: false,
  signin: null       // { status: 'working' | 'done' | 'needs-terminal' }
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
window.island.onBusy((on) => {
  // The spin reflects a real fetch. It used to be a fixed 680ms animation
  // fired on click, so it played even when the request was suppressed and
  // stopped long before a slow one finished — a placebo either way.
  $('#refresh-btn').classList.toggle('spinning', on === true);
});
window.island.onSignIn((s) => { state.signin = s || null; render(); });

// Relative labels ("resets in 51 min", "4h15") drift; keep them honest.
// Rows are reconciled in place, so this tick never disturbs a running
// animation. The wings count down too, so this runs while they are out.
setInterval(() => {
  if (state.panelOpen || state.peek || state.wings) render();
}, 30000);

// The two fixed controls. The window only takes the mouse while the cursor
// is over the island's surface, so these never intercept an outside click.
$('#refresh-btn').addEventListener('click', () => window.island.act('refresh'));
$('#peek').addEventListener('click', () => window.island.act('expand'));

// A click anywhere on the band — the notch or either chip — opens the panel,
// and closes it again. Handled by position rather than per-element so the
// real notch, the drawn one and the wings all behave the same, including the
// cutout where there is no element of ours to attach to.
$('#stage').addEventListener('click', (e) => {
  const band = (state.geometry && state.geometry.hotHeight) || 0;
  if (e.clientY <= band) window.island.act('toggle');
});

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
function wingInfo() { return (state.data && state.data.wingInfo) || 'off'; }
function wingSources() {
  const s = state.data && state.data.wingSources;
  return Array.isArray(s) && s.length ? s : ['session'];
}

/**
 * The narrowest the panel may be drawn — and therefore the narrowest the
 * BAND may be, because the two share their edges and one of them has to give.
 *
 * Measured, not chosen: at 300pt every row still reads, the settings chips
 * still sit on their own lines, and the header keeps a gap between the
 * active-limit badge and the number. It is tight but whole at 270 and
 * comfortable here. The old floor was 340, which is wider than a one-chip
 * band ever gets — so the panel overhung the band it was supposed to grow
 * out of, on every account showing a single limit.
 */
const PANEL_MIN = 300;

/**
 * The band's real extent, measured from what is drawn rather than derived
 * from constants: chips are content-sized and equalized, so any arithmetic
 * version of this drifts from the pixels within a release or two. Both the
 * chips and the panel are sized from this one answer, which is what keeps
 * their edges flush.
 */
function bandExtent() {
  const g = state.geometry;
  const centre = document.documentElement.clientWidth / 2;
  let left = centre - g.notchWidth / 2;
  let right = centre + g.notchWidth / 2;
  for (const wing of document.querySelectorAll('#wings .wing')) {
    if (wing.classList.contains('empty')) continue;
    left = Math.min(left, wing.offsetLeft);
    right = Math.max(right, wing.offsetLeft + wing.offsetWidth);
  }
  return { left, right, width: right - left };
}

/**
 * @param {number} minSweep  smallest arc a non-zero value may draw.
 *
 * At menu-bar size a true 3% arc is a hairline: the ring reads as an empty
 * grey circle and contributes nothing a glance can use. A floor makes the
 * TONE legible while the exact number sits right beside it — the same
 * bargain the panel's bars already make with `min-width`.
 */
function setRing(el, percent, severity, minSweep = 0) {
  const p = Math.max(0, Math.min(100, percent));
  el.style.setProperty('--p', String(p > 0 ? Math.max(p, minSweep) : 0));
  el.style.setProperty('--tone', `var(--${VM.tone(percent, severity)})`);
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
/**
 * Where the island actually is, as a LIST of rectangles.
 *
 * Not a bounding box: with the wings off, one box around the notch and the
 * wider panel below it would also cover the empty menu-bar strip either side
 * of the notch — and clicks there belong to menu titles and status items.
 * Each drawn thing reports its own rect, so the island takes the mouse over
 * its own opaque pixels and nowhere else.
 */
function reportSurface() {
  const rects = [];
  const add = (el) => {
    if (!el || el.classList.contains('off')) return;
    // offset* and NOT getBoundingClientRect(): the latter returns the
    // ANIMATED box, and this runs while the entry transform is still at
    // scaleY(0.84) translateY(-12px). Layout metrics ignore transforms and
    // describe where the thing lands.
    const left = el.offsetLeft;
    const top = el.offsetTop;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (w > 0 && h > 0) rects.push({ left, top, right: left + w, bottom: top + h });
  };

  add($('#panel'));
  add($('#peek'));
  add($('#fakenotch'));
  const wings = $('#wings');
  if (wings && !wings.classList.contains('off')) {
    for (const wing of wings.querySelectorAll('.wing')) {
      if (!wing.classList.contains('empty')) add(wing);
    }
  }

  // A real notch has no pixels of ours to draw on, and macOS puts nothing
  // there either — so the cutout is always ours to accept a click on, which
  // is what makes clicking it open the panel from a standing start.
  const g = state.geometry;
  if (g && g.notched) {
    const half = g.notchWidth / 2;
    const centre = document.documentElement.clientWidth / 2;
    rects.push({ left: centre - half, top: 0, right: centre + half, bottom: g.hotHeight });
  }

  window.island.reportSurface(rects.length ? rects : null);
}

/** The drawn notch: only on displays that lack a real one, only when out.
    A side a wing joins goes square, so band and chip merge into one shape. */
function renderAnchor() {
  const anything = state.panelOpen || state.peek || state.wings;
  const virtual = state.geometry && state.geometry.notched === false;
  const model = VM.wingsModel(state.data.gauges, wingSources());
  const wingsShowing = state.wings && Boolean(model);
  const el = $('#fakenotch');
  el.classList.toggle('off', !(virtual && anything));
  el.classList.toggle('join-left', wingsShowing && model.left.length > 0);
  el.classList.toggle('join-right', wingsShowing && model.right.length > 0);

  // The plan, in the one place a MacBook cannot put anything. A drawn notch
  // is our own rectangle rather than a camera housing, so on those displays
  // it can name what the numbers either side of it are a percentage of.
  //
  // Not while the panel is open: the header says it there, forty pixels
  // below, and twice in forty pixels is once too many.
  const label = el.querySelector('.notch-plan');
  const plan = virtual && !state.panelOpen && typeof state.data.plan === 'string'
    ? state.data.plan : '';
  label.textContent = plan;
  // All or nothing, at whatever width this display's notch actually is. The
  // rectangle is pretending to be hardware, and hardware does not clip text
  // — a half-shown "Enterpris" reads as a bug, where nothing reads as a
  // notch. Measured rather than assumed: the width comes from the display.
  if (plan && el.scrollWidth > el.clientWidth) label.textContent = '';
}

/**
 * One limit inside a chip: its name, its number, and — for the first one
 * only — how long the window has left.
 *
 * A second limit sharing a chip is a `tail`. It keeps its tone and its
 * escalation dot, because a week going critical must register wherever it
 * happens to be drawn.
 *
 * The reset note belongs to a chip that holds ONE limit. With two, the note
 * sat between them behind a hairline identical to the one dividing the
 * limits themselves, so `Week 63% | 2d left | Opus 91%` read as three equal
 * things and the note appeared to belong to neither. Dropping it there is
 * also what keeps a three-limit band near 600 pt instead of 713.
 */
function wingUnit(gauge, tail, withNote) {
  const tone = VM.tone(gauge.percent, gauge.severity);
  const unit = document.createElement('span');
  unit.className = `unit tone-${tone}${tail ? ' tail' : ''}`;

  // Two steps of escalation, so the band is silent most of the day: a dot
  // APPEARS past halfway — a shape change catches peripheral vision even
  // when the text is too small to read — and the number takes colour only
  // when the ceiling is actually close.
  if (tone !== 'ok') {
    const dot = document.createElement('span');
    dot.className = `dot tone-${tone}`;
    unit.appendChild(dot);
  }

  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = VM.wingTag(gauge);
  unit.appendChild(tag);

  const pct = document.createElement('span');
  pct.className = `pct tone-${tone}`;
  pct.textContent = `${gauge.percent}%`;
  unit.appendChild(pct);

  if (withNote) {
    const rst = document.createElement('span');
    rst.className = 'rst';
    rst.textContent = VM.wingReset(gauge, wingInfo(), Date.now(), locale(), timeFormat());
    if (rst.textContent) unit.appendChild(rst);
  }
  return unit;
}

function renderWings() {
  const wingsEl = $('#wings');
  const model = VM.wingsModel(state.data.gauges, wingSources());
  // Wings stay out while the panel is open: the band is part of the island,
  // and a band that shrinks when the panel morphs would break the shape.
  const show = state.wings && Boolean(model);
  wingsEl.classList.toggle('off', !show);
  // With the panel flush below, the band's outer corners go square: the
  // surface continues downward, and a rounded corner would bite the seam.
  wingsEl.classList.toggle('merged', show && state.panelOpen);
  if (!show) return;

  // No ring here any more. At 15px it was a grey circle whose arc said
  // nothing the adjacent number did not say better, and it cost about a
  // fifth of the chip. Colour now appears only when it means something,
  // which is also what makes it register when it does.
  const fill = (side, gauges) => {
    const el = wingsEl.querySelector(`.wing.${side}`);
    el.classList.toggle('empty', !gauges.length);
    // Rebuilt rather than reconciled: a chip holds one unit or two, and the
    // whole thing is four spans of text that never animate.
    el.textContent = '';
    const alone = gauges.length === 1;
    gauges.forEach((gauge, i) => el.appendChild(wingUnit(gauge, i > 0, alone)));
  };
  fill('left', model.left);
  fill('right', model.right);

  // Equalize the two chips so the band stays centred on the notch. Chips are
  // content-sized, and "5h" against "Fable" pushed the whole island ~8px off
  // the one landmark it is pretending to grow out of — an offset that then
  // shifted whenever the model name changed length.
  const l = wingsEl.querySelector('.wing.left');
  const r = wingsEl.querySelector('.wing.right');
  l.style.width = r.style.width = '';
  const widest = Math.max(
    l.classList.contains('empty') ? 0 : l.offsetWidth,
    r.classList.contains('empty') ? 0 : r.offsetWidth
  );
  if (widest) l.style.width = r.style.width = `${widest}px`;

  // And never narrower than the panel that has to grow out of it. A single
  // chip showing a bare percentage measures under 300pt on a real notch and
  // barely 230 beside a narrow virtual one, so the panel used to sit at its
  // own floor and overhang the band on both sides — the seam the whole shape
  // depends on. The chips take the shortfall instead, and they take it in
  // every state rather than only while the panel is open: a band that
  // widened on click would be a moving target in the menu bar.
  if (!state.geometry) return;
  const chips = [l, r].filter((el) => !el.classList.contains('empty'));
  const short = PANEL_MIN - bandExtent().width;
  if (chips.length && short > 0) {
    const each = Math.ceil(short / chips.length);
    for (const el of chips) el.style.width = `${el.offsetWidth + each}px`;
  }
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
  setRing(el.querySelector('.ring'), gauge.percent, gauge.severity);
  // The number is the entire point of an alert; as one uniform run it got no
  // emphasis and no tone, leaving the ring as the only red thing in a red
  // warning.
  const title = el.querySelector('.peek-title');
  title.textContent = `${VM.rowLabel(gauge)} `;
  const num = document.createElement('span');
  num.className = `num tone-${VM.tone(gauge.percent, gauge.severity)}`;
  num.textContent = `${gauge.percent}%`;
  title.appendChild(num);
  el.querySelector('.peek-sub').textContent =
    VM.rateLine(gauge, state.data.trend) ||
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

  // A 400pt slab holding one line and a button reads unresolved. Sized here
  // rather than by a class, because the inline width below would win.
  if (!(state.data.gauges || []).length) {
    width = 320;
    left = center - width / 2;
    panel.style.left = `${left}px`;
    panel.style.width = `${width}px`;
    return;
  }

  const model = VM.wingsModel(state.data.gauges, wingSources());
  if (state.wings && model) {
    // Centred on the BAND's real extent, measured — not on the notch.
    //
    // With two equalized chips those are the same point. With one chip the
    // band genuinely sits off to one side, and centring the panel on the
    // notch left the two misaligned: the band overhanging one way, the
    // panel the other. The island is one shape, so the panel follows
    // whatever the band actually is.
    const band = bandExtent();
    // The band has already been widened to PANEL_MIN, so the floor here is a
    // backstop rather than the thing that decides: the two agree by
    // construction, and the max only catches a band measured mid-layout.
    width = Math.max(band.width, PANEL_MIN);
    left = (band.left + band.right) / 2 - width / 2;
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
  // Empty string, never a placeholder: an account that does not say which
  // plan it is on should read as though the line was never there.
  panel.querySelector('.plan').textContent = typeof d.plan === 'string' ? d.plan : '';
  const stale = d.stale === true || d.ok === false;
  panel.classList.toggle('stale', stale);

  const when = d.fetchedAt
    ? new Date(d.fetchedAt).toLocaleTimeString(locale(), VM.timeOptions(timeFormat()))
    : '';
  const whenWord = !gauges.length ? 'checked' : (stale ? 'as of' : 'refreshed');
  $('#panel .when').textContent = when ? `${whenWord} ${when}` : '';

  // A pending retry is shown even with no gauges: it used to be suppressed
  // precisely when there were no numbers to look at, leaving the word
  // "rate-limited" alone on a black card with no ETA and a 15-minute silence.
  const pendingRetry = Boolean(d.retryAt && d.retryAt > Date.now());
  const staleEl = $('#stale');
  const showStale = stale && (gauges.length || pendingRetry) &&
    !(!gauges.length && VM.isCredentialProblem(d.reason));
  staleEl.classList.toggle('off', !showStale);
  if (showStale) {
    staleEl.querySelector('.stale-text').textContent =
      VM.staleLine(d.reason, d.retryAt, Date.now(), d.accountLive);
  }

  // A 400pt slab holding one line and a button reads unresolved.
  panel.classList.toggle('narrow', !gauges.length);

  const note = VM.ceilingNote(d);
  const ceilingEl = $('#ceiling');
  ceilingEl.classList.toggle('off', !note);
  ceilingEl.textContent = note;

  // A feature that spends quota on a schedule has to say it is armed, and
  // when it will next act. Silent automation on someone's account is not a
  // feature, it is a surprise.
  const primeEl = $('#prime');
  primeEl.classList.toggle('off', !d.primeNote);
  primeEl.textContent = d.primeNote ? `⟳ ${d.primeNote}` : '';
  renderPrimeBar(d.prime);

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
      note.textContent = d.ok ? 'No limits exposed for this account' : VM.reasonLabel(d.reason, d.accountLive);
      rowsEl.appendChild(note);
      syncSignIn(rowsEl, d.reason);
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
  gauges.forEach((gauge, i) => fillRow(rowEls[i], gauge, d.alertAt));
  syncSignIn(rowsEl, d.reason);
  syncPrime(rowsEl, d);
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
  const btn = existing || appendSignIn(rowsEl);
  const status = state.signin && state.signin.status;
  // Every outcome reaches the user. The button used to say "signing in…"
  // forever on failure, or silently reset to its default label on success —
  // either way they never learned what happened. The wording lives in the
  // viewmodel, where the rule about what is actually fixable is tested.
  const action = VM.signInAction(state.data.reason, status, state.data.accountLive);
  btn.textContent = action.label;
  btn.disabled = action.disabled;
}

/**
 * The row's structure, with its bar at zero so it can grow into place.
 *
 * The number leads. It used to be the smallest, dimmest text in the panel,
 * printed under a bar that already encoded it — so the row said "73" three
 * times and never once loudly.
 */
function buildRow(gauge, index) {
  const row = document.createElement('div');
  row.className = 'row';
  row.style.setProperty('--i', String(index));   // drives the entrance stagger

  const head = document.createElement('div');
  head.className = 'row-head';
  const name = document.createElement('span');
  name.className = 'row-name';
  const value = document.createElement('span');
  value.className = 'row-value';
  head.append(name, value);

  const bar = document.createElement('div');
  bar.className = 'bar';
  const fill = document.createElement('i');
  fill.style.width = '0%';
  bar.appendChild(fill);

  const reset = document.createElement('div');
  reset.className = 'row-reset';

  row.append(head, bar, reset);
  return row;
}

/** The row's content, written into whichever nodes are already there. */
function fillRow(row, gauge, thresholds) {
  if (!row) return;
  const tone = VM.tone(gauge.percent, gauge.severity);

  const name = row.querySelector('.row-name');
  name.textContent = VM.rowLabel(gauge);
  if (gauge.active) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'active limit';
    name.appendChild(badge);
  }

  const value = row.querySelector('.row-value');
  value.className = `row-value tone-${tone}`;
  value.textContent = `${gauge.percent}%`;

  const bar = row.querySelector('.bar');
  const fill = bar.querySelector('i');
  fill.className = `tone-${tone}`;
  fill.style.width = `${Math.max(0, Math.min(100, gauge.percent))}%`;

  // Residue for alerts: a peek lasts four seconds once, so without a mark on
  // the track a warning you looked away from never existed. Doubles as the
  // non-colour channel for the thresholds.
  for (const old of bar.querySelectorAll('.tick')) old.remove();
  for (const level of thresholds || []) {
    if (level <= 0 || level >= 100) continue;
    const tick = document.createElement('span');
    tick.className = gauge.percent >= level ? 'tick crossed' : 'tick';
    tick.style.left = `${level}%`;
    bar.appendChild(tick);
  }

  // The header and the status strip already own the timestamp; repeating it
  // per row printed the same time four times in a 400px panel.
  const rate = VM.rateLine(gauge, state.data.trend);
  const reset = row.querySelector('.row-reset');
  reset.textContent = VM.resetLabel(gauge, Date.now(), locale(), timeFormat());
  if (rate) {
    const span = document.createElement('span');
    span.className = 'row-rate';
    span.textContent = ` · ${rate}`;
    reset.appendChild(span);
  }
}

/**
 * The auto-open control, in the panel rather than the tray.
 *
 * A native macOS menu dismisses itself on every click, so setting a time
 * there means reopening the menu to see the result or change your mind.
 * This is our own window, so a chip can toggle and stay put.
 */
const MODES = [
  ['', 'Off', 'Never open a window automatically'],
  ['at', 'At', 'Open a window at a time you choose'],
  ['chain', 'Chain', 'Open a new window as soon as the current one ends']
];
const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Every handler here closes over a CONSTANT (its own mode, field or day
 * index) and never over the current settings — buttons are built once and
 * reused, so a captured setting goes stale on the first change.
 */
const WING_INFO = [
  ['off', '%', 'Just the percentage'],
  ['remaining', 'Left', 'Also how long until the window resets'],
  ['ends', 'Ends', 'Also when the window resets']
];

/**
 * Which limits the band shows, in the order it draws them. These name the
 * limits themselves — the old control asked for a NUMBER of chips and left
 * the choice of what went in them to the app, which is why a model's week
 * could take the right chip and hide the all-models week for good.
 */
const WING_SOURCES = [
  ['session', 'Session', 'The rolling five-hour window'],
  ['weekly', 'Week', 'The weekly quota across all models'],
  // Deliberately generic: this source is "whichever model is busiest", and
  // which one that is changes during the day. Naming it after the model an
  // account happens to have today would read as a fixed choice.
  ['model', 'Model', 'The busiest model’s own week']
];

/** Which gauge kind each source draws from. */
const SOURCE_KIND = { session: 'session', weekly: 'weekly', model: 'model' };


/** Two sides, so three limits is the most the band can hold. */
const MAX_SOURCES = 3;

function buildPrimeBar(bar) {
  const wsrc = bar.querySelector('.chips.wsrc');
  for (const [value, label, title] of WING_SOURCES) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.wsrc = value;
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', () => window.island.act('wing-source', value));
    wsrc.appendChild(b);
  }

  const winfo = bar.querySelector('.chips.winfo');
  for (const [value, label, title] of WING_INFO) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.winfo = value;
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', () => window.island.act('wing-info', value));
    winfo.appendChild(b);
  }

  const modes = bar.querySelector('.chips.mode');
  for (const [value, label, title] of MODES) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.mode = value;
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', () => window.island.act('prime-mode', value));
    modes.appendChild(b);
  }
  for (const btn of bar.querySelectorAll('.step')) {
    const field = btn.dataset.field;
    const delta = Number(btn.dataset.delta);
    btn.addEventListener('click', () => window.island.act('prime-step', { field, delta }));
  }
  const days = bar.querySelector('.chips.days');
  DAY_LETTERS.forEach((letter, index) => {
    const b = document.createElement('button');
    b.className = 'chip day';
    b.dataset.day = String(index);
    b.textContent = letter;
    b.title = DAY_NAMES[index];
    b.addEventListener('click', () => window.island.act('prime-day', index));
    days.appendChild(b);
  });
}

function renderPrimeBar(p) {
  const bar = $('#primebar');
  bar.classList.toggle('off', !p);
  if (!p) return;
  if (!bar.dataset.built) { buildPrimeBar(bar); bar.dataset.built = '1'; }

  // Only worth offering while the chips are actually in the menu bar.
  for (const row of bar.querySelectorAll('.prow.wingrow')) {
    row.classList.toggle('off', !state.wings);
  }
  for (const b of bar.querySelectorAll('.chips.winfo .chip')) {
    b.classList.toggle('on', b.dataset.winfo === wingInfo());
  }
  const sources = wingSources();
  const full = sources.length >= MAX_SOURCES;
  const sole = sources.length === 1;
  const gauges = state.data.gauges || [];
  for (const b of bar.querySelectorAll('.chips.wsrc .chip')) {
    const source = b.dataset.wsrc;
    const on = sources.includes(source);
    b.classList.toggle('on', on);
    // A limit this account does not expose is not a choice: the band would
    // draw nothing for it. Only claimed while a reading is actually in hand —
    // an empty gauge list is a fetch that has not landed, not an account
    // without quotas.
    const kind = SOURCE_KIND[source];
    const absent = gauges.length > 0 && kind && !gauges.some((g) => g.kind === kind);
    // Both ends of the range are shown rather than enforced silently: a
    // fourth limit has nowhere to go, and the last one standing cannot be
    // turned off without leaving the band empty.
    b.disabled = on ? sole : (full || absent);
  }

  const mode = p.chain ? 'chain' : p.at ? 'at' : '';
  for (const b of bar.querySelectorAll('.chips.mode .chip')) {
    b.classList.toggle('on', b.dataset.mode === mode);
  }
  // Time and days only matter for a scheduled open, so they only appear
  // then — the panel does not carry controls that cannot do anything.
  for (const row of bar.querySelectorAll('.prow.detail')) {
    row.classList.toggle('off', mode !== 'at');
  }
  if (mode !== 'at') return;

  bar.querySelector('.clock').textContent = p.at || '08:00';
  const days = Array.isArray(p.days) ? p.days : [];
  for (const b of bar.querySelectorAll('.chips.days .chip')) {
    b.classList.toggle('on', days.includes(Number(b.dataset.day)));
  }
}

/**
 * "Open a session window" — shown only when no window is running, because
 * that is the only moment the button would do anything: a message cannot
 * restart a window that has already begun.
 */
function syncPrime(rowsEl, d) {
  const existing = rowsEl.querySelector('.btn-prime');
  const status = state.signin && state.signin.status;
  const busy = status === 'priming';
  const show = (d.canPrime || busy) && !VM.isCredentialProblem(d.reason);
  if (!show) {
    if (existing) existing.remove();
    return;
  }
  const btn = existing || (() => {
    const b = document.createElement('button');
    b.className = 'btn btn-prime';
    b.addEventListener('click', () => window.island.act('prime'));
    rowsEl.appendChild(b);
    return b;
  })();
  btn.textContent = busy ? 'Opening a window…'
    : status === 'prime-failed' ? 'Could not open — try again'
    : 'Open a session window';
  btn.disabled = busy;
}

/** The one-click fix, right where the problem is reported. */
function appendSignIn(parent) {
  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.textContent = 'Sign in with Claude Code';
  btn.addEventListener('click', () => window.island.act('sign-in'));
  parent.appendChild(btn);
  return btn;
}
