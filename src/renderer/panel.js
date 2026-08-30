'use strict';
/* The panel: every gauge, the header that dates them, the degraded strip,
   and the two action buttons.

   Rows are RECONCILED: rebuilt only when the panel's shape changes (see
   vm.panelShape), otherwise written into the nodes already there — so bars
   glide between values on refresh, and the 30-second label tick never
   disturbs a running animation. The entrance is the one moment the
   reconciled DOM is discarded on purpose, because rebuilding the rows is
   what arms the bar growth. */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IslandPanel = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  /**
   * Write the two action buttons into the row container — creating,
   * relabelling or removing each so the same node survives every render.
   * The DECISION of which button shows, saying what, is vm.panelButtons;
   * this only applies it. Selectors are exact (`.btn-signin`, `.btn-prime`)
   * because `.btn` matches both: the sign-in sync used to find the prime
   * button, decide it was a sign-in button that should not exist, and
   * remove it — after which the prime sync built a fresh one, and a click
   * landing in that gap did nothing at all.
   */
  function syncActionButtons(rowsEl, buttons, act, doc, dom) {
    const sync = (kind, action, onClick) => {
      const existing = rowsEl.querySelector(`.btn-${kind}`);
      if (!action) {
        if (existing) existing.remove();
        return;
      }
      let btn = existing;
      if (!btn) {
        btn = dom.el(doc, 'button', `btn btn-${kind}`);
        btn.addEventListener('click', onClick);
        rowsEl.appendChild(btn);
      }
      btn.textContent = action.label;
      btn.disabled = action.disabled === true;
    };
    sync('signin', buttons.signin, () => act('sign-in'));
    sync('prime', buttons.prime, () => act('prime'));
  }

  function createPanel({ root, doc, vm, selectors, band, primebar, act, dom }) {
    // The shape currently in the DOM, so rows are rebuilt only when they must be.
    let renderedIds = null;
    let entranceTimer = null;

    /**
     * Replay the opening choreography: the surface springs out, then the
     * rows resolve in sequence and the bars grow into place. Rebuilding the
     * rows is what arms the bar growth, so the entrance discards the
     * reconciled DOM on purpose.
     *
     * `.entering` stays on through the exit. Removing it on close dropped
     * the stagger animations mid-fill, so a fast hover-out at 200 ms popped
     * the not-yet-revealed settings block to full opacity for the whole
     * fade-out. This resets the class on the next open, and the timer
     * clears it once the choreography is over either way.
     */
    function beginEntrance() {
      renderedIds = null;
      root.classList.remove('entering');
      void root.offsetWidth;        // restart the staggered animations
      root.classList.add('entering');
      clearTimeout(entranceTimer);
      entranceTimer = setTimeout(() => root.classList.remove('entering'), 1000);
    }

    /**
     * The panel's edges are derived, never guessed: with wings out, it spans
     * exactly from the left chip's outer edge to the right chip's outer edge
     * (measured, since chips are content-sized), so band and panel share
     * flush sides. Without wings it centers at its default width.
     */
    function align(state) {
      const g = state.geometry;
      if (!g) return;
      const center = doc.documentElement.clientWidth / 2;
      let left = center - g.panelWidth / 2;
      let width = g.panelWidth;

      // A 400pt slab holding one line and a button reads unresolved. Sized
      // here rather than by a class, because the inline width below would win.
      if (!(state.data.gauges || []).length) {
        width = 320;
        left = center - width / 2;
        root.style.left = `${left}px`;
        root.style.width = `${width}px`;
        return;
      }

      const model = vm.wingsModel(state.data.gauges, selectors.wingSources(state));
      if (selectors.wingsShowing(state, model, vm)) {
        // Centred on the BAND's real extent, measured — not on the notch.
        //
        // With two equalized chips those are the same point. With one chip
        // the band genuinely sits off to one side, and centring the panel on
        // the notch left the two misaligned: the band overhanging one way,
        // the panel the other. The island is one shape, so the panel follows
        // whatever the band actually is.
        const extent = band.bandExtent(doc, g.notchWidth);
        // The band has already been widened to PANEL_MIN, so the floor here
        // is a backstop rather than the thing that decides: the two agree by
        // construction, and the max only catches a band measured mid-layout.
        width = Math.max(extent.width, band.PANEL_MIN);
        left = (extent.left + extent.right) / 2 - width / 2;
      }
      // Exact fractional pixels: rounding left and width independently
      // drifts the edges a device pixel away from the chips they must sit
      // flush with.
      root.style.left = `${left}px`;
      root.style.width = `${width}px`;
    }

    /**
     * The row's structure, with its bar at zero so it can grow into place.
     *
     * The number leads. It used to be the smallest, dimmest text in the
     * panel, printed under a bar that already encoded it — so the row said
     * "73" three times and never once loudly.
     */
    function buildRow(index) {
      const row = dom.el(doc, 'div', 'row');
      row.style.setProperty('--i', String(index));   // drives the entrance stagger

      const head = dom.el(doc, 'div', 'row-head');
      head.append(dom.el(doc, 'span', 'row-name'), dom.el(doc, 'span', 'row-value'));

      const bar = dom.el(doc, 'div', 'bar');
      const fill = dom.el(doc, 'i');
      fill.style.width = '0%';
      bar.appendChild(fill);

      row.append(head, bar, dom.el(doc, 'div', 'row-reset'));
      return row;
    }

    /** The row's content, written into whichever nodes are already there. */
    function fillRow(state, row, gauge, thresholds) {
      if (!row) return;
      const tone = vm.tone(gauge.percent, gauge.severity);

      const name = row.querySelector('.row-name');
      name.textContent = vm.rowLabel(gauge);
      if (gauge.active) {
        name.appendChild(dom.el(doc, 'span', 'badge', 'active limit'));
      }

      const value = row.querySelector('.row-value');
      value.className = `row-value tone-${tone}`;
      value.textContent = `${gauge.percent}%`;

      const bar = row.querySelector('.bar');
      const fill = bar.querySelector('i');
      const percent = Math.max(0, Math.min(100, gauge.percent));
      // `some` carries the minimum-width floor that keeps 1% visible. At 0%
      // it is withheld, because a quota nobody has touched should look
      // untouched rather than identical to a used one.
      fill.className = `tone-${tone}${percent > 0 ? ' some' : ''}`;
      fill.style.width = `${percent}%`;

      // Residue for alerts: a peek lasts four seconds once, so without a
      // mark on the track a warning you looked away from never existed.
      // Doubles as the non-colour channel for the thresholds.
      for (const old of bar.querySelectorAll('.tick')) old.remove();
      for (const level of thresholds || []) {
        // 100 is a mark the config accepts and the alert ledger honours, so
        // the track has to show it: an alert whose threshold is invisible
        // reads as an alert with no cause. Only nonsense outside the scale
        // is skipped.
        if (level <= 0 || level > 100) continue;
        const tick = dom.el(doc, 'span', gauge.percent >= level ? 'tick crossed' : 'tick');
        tick.style.left = `${level}%`;
        bar.appendChild(tick);
      }

      // The header and the status strip already own the timestamp; repeating
      // it per row printed the same time four times in a 400px panel.
      const rate = vm.rateLine(gauge, state.data.trend);
      const reset = row.querySelector('.row-reset');
      reset.textContent = vm.resetLabel(gauge, Date.now(),
        selectors.locale(state), selectors.timeFormat(state));
      if (rate) {
        // The separator only when there is something to separate: a gauge
        // with no readable reset date still gets a pace estimate, and the
        // row began with a dangling middot.
        reset.appendChild(dom.el(doc, 'span', 'row-rate',
          reset.textContent ? ` · ${rate}` : rate));
      }
    }

    function render(state) {
      align(state);
      root.classList.toggle('off', !state.panelOpen);
      if (!state.panelOpen) return;

      const d = state.data;
      const gauges = d.gauges || [];
      // Empty string, never a placeholder: an account that does not say
      // which plan it is on should read as though the line was never there.
      root.querySelector('.plan').textContent = typeof d.plan === 'string' ? d.plan : '';
      root.classList.toggle('stale', vm.isStale(d));
      // Dimmed, and labelled by the header's "as of", when the figures are
      // from an account the app can no longer read. They stay — they are the
      // last thing anyone knew — but they stop presenting themselves as now.
      root.classList.toggle('unreadable', !vm.numbersAreCurrent(d));

      const when = d.fetchedAt
        ? new Date(d.fetchedAt).toLocaleTimeString(selectors.locale(state),
            vm.timeOptions(selectors.timeFormat(state)))
        : '';
      root.querySelector('.when').textContent = when ? `${vm.whenWord(d)} ${when}` : '';

      const staleEl = root.querySelector('#stale');
      const showStale = vm.staleVisible(d, Date.now());
      staleEl.classList.toggle('off', !showStale);
      if (showStale) {
        staleEl.querySelector('.stale-text').textContent =
          vm.staleLine(d.reason, d.retryAt, Date.now(), d.accountLive);
      }

      const note = vm.ceilingNote(d);
      const ceilingEl = root.querySelector('#ceiling');
      ceilingEl.classList.toggle('off', !note);
      ceilingEl.textContent = note;

      // A feature that spends quota on a schedule has to say it is armed,
      // and when it will next act. Silent automation on someone's account is
      // not a feature, it is a surprise.
      const primeEl = root.querySelector('#prime');
      primeEl.classList.toggle('off', !d.primeNote);
      primeEl.textContent = d.primeNote ? `⟳ ${d.primeNote}` : '';
      primebar.render(state);

      const rowsEl = root.querySelector('#rows');
      const shape = vm.panelShape(d);
      const buttons = vm.panelButtons(d, state.signin && state.signin.status);

      // Rebuild only when the shape of the panel changes; otherwise update
      // the existing nodes so bars can transition to their new values and a
      // running entrance is never yanked out from under itself.
      const rebuilt = shape !== renderedIds;
      // Rebuilding rows inside a panel still wearing `.entering` restarts
      // their stagger from zero while the header carries on, and the class
      // is then pulled by the timer from the original open — cutting the
      // replay short. The entrance belongs to the opening, not to every
      // reshuffle within it.
      if (rebuilt && root.classList.contains('entering') && renderedIds !== null) {
        root.classList.remove('entering');
      }
      if (rebuilt) {
        renderedIds = shape;
        rowsEl.textContent = '';
        if (!gauges.length) {
          rowsEl.appendChild(dom.el(doc, 'div', 'empty-note', vm.emptyNote(d)));
          syncActionButtons(rowsEl, buttons, act, doc, dom);
          return;
        }
        gauges.forEach((gauge, i) => rowsEl.appendChild(buildRow(i)));
        // Commit the zero-width bars before filling them, so the growth is
        // a transition rather than an instant paint.
        void rowsEl.offsetHeight;
      } else if (!gauges.length) {
        // Nothing to redraw in the rows, but the BUTTONS still change: a
        // signin message arrives with the same data, so the shape is
        // identical and nothing was rebuilt. Returning without this left
        // the button frozen on its first label — which is the entire
        // first-run sign-in experience.
        syncActionButtons(rowsEl, buttons, act, doc, dom);
        return;
      }

      const rowEls = rowsEl.querySelectorAll('.row');
      gauges.forEach((gauge, i) => fillRow(state, rowEls[i], gauge, d.alertAt));
      syncActionButtons(rowsEl, buttons, act, doc, dom);
    }

    return { render, beginEntrance };
  }

  return { createPanel, syncActionButtons };
}));
