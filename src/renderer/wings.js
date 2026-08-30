'use strict';
/* The ambient band: black chips flanking the notch, one unit per limit.

   Chips are rebuilt rather than reconciled — a chip holds one unit or two,
   and the whole thing is a few spans of text that never animate. What earns
   the care here is WIDTH: equalized so the band stays centred on the notch,
   clamped to the window so glyphs are never cut, and never narrower than
   the panel that has to grow out of it. */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IslandWings = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  function createWings({ root, doc, vm, selectors, band, dom }) {
    /**
     * One limit inside a chip: its name, its number, and — for the first
     * one only — how long the window has left.
     *
     * A second limit sharing a chip is a `tail`. It keeps its tone and its
     * escalation dot, because a week going critical must register wherever
     * it happens to be drawn.
     *
     * The reset note belongs to a chip that holds ONE limit. With two, the
     * note sat between them behind a hairline identical to the one dividing
     * the limits themselves, so `Week 63% | 2d left | Opus 91%` read as
     * three equal things and the note appeared to belong to neither.
     * Dropping it there is also what keeps a three-limit band near 600 pt
     * instead of 713.
     */
    function wingUnit(state, gauge, tail, withNote) {
      const tone = vm.tone(gauge.percent, gauge.severity);
      const unit = dom.el(doc, 'span', `unit tone-${tone}${tail ? ' tail' : ''}`);

      // Two steps of escalation, so the band is silent most of the day: a
      // dot APPEARS past halfway — a shape change catches peripheral vision
      // even when the text is too small to read — and the number takes
      // colour only when the ceiling is actually close.
      if (tone !== 'ok') unit.appendChild(dom.el(doc, 'span', `dot tone-${tone}`));

      unit.appendChild(dom.el(doc, 'span', 'tag', vm.wingTag(gauge)));
      unit.appendChild(dom.el(doc, 'span', `pct tone-${tone}`, `${gauge.percent}%`));

      if (withNote) {
        const text = vm.wingReset(gauge, selectors.wingInfo(state), Date.now(),
          selectors.locale(state), selectors.timeFormat(state));
        if (text) unit.appendChild(dom.el(doc, 'span', 'rst', text));
      }
      return unit;
    }

    function render(state) {
      const model = vm.wingsModel(state.data.gauges, selectors.wingSources(state));
      // Wings stay out while the panel is open: the band is part of the
      // island, and a band that shrinks when the panel morphs would break
      // the shape.
      //
      // And they go quiet when the account cannot be read at all. The chips
      // are the ambient claim "this is your usage right now" — made in the
      // menu bar, with no room for a caveat — so when the app is signed out
      // they state a figure from whenever it last worked. The tray says
      // "sign in" instead.
      const show = selectors.wingsShowing(state, model, vm);
      root.classList.toggle('off', !show);
      // With the panel flush below, the band's outer corners go square: the
      // surface continues downward, and a rounded corner would bite the seam.
      root.classList.toggle('merged', show && state.panelOpen);
      if (!show) return;

      // No ring here. At 15px it was a grey circle whose arc said nothing
      // the adjacent number did not say better, and it cost about a fifth of
      // the chip. Colour appears only when it means something, which is also
      // what makes it register when it does.
      const fill = (side, gauges) => {
        const el = root.querySelector(`.wing.${side}`);
        el.classList.toggle('empty', !gauges.length);
        // Rebuilt rather than reconciled: a chip holds one unit or two, and
        // the whole thing is four spans of text that never animate.
        el.textContent = '';
        const alone = gauges.length === 1;
        gauges.forEach((gauge, i) => el.appendChild(wingUnit(state, gauge, i > 0, alone)));
      };
      fill('left', model.left);
      fill('right', model.right);

      // Equalize the two chips so the band stays centred on the notch. Chips
      // are content-sized, and "5h" against "Fable" pushed the whole island
      // ~8px off the one landmark it is pretending to grow out of — an
      // offset that then shifted whenever the model name changed length.
      const l = root.querySelector('.wing.left');
      const r = root.querySelector('.wing.right');
      const equalize = () => {
        l.style.width = r.style.width = '';
        const widest = Math.max(
          l.classList.contains('empty') ? 0 : l.offsetWidth,
          r.classList.contains('empty') ? 0 : r.offsetWidth
        );
        if (widest) l.style.width = r.style.width = `${widest}px`;
      };
      equalize();

      // And never wider than the window that would clip it. Content-sized
      // chips have no ceiling of their own: three sources at 100% with the
      // reset notes on measure past 660 on a 16" notch, and the window then
      // cuts glyphs off mid-character — at exactly the usage level where the
      // band matters most. Shed detail rather than pixels: the reset notes
      // go first, then a long model name falls back to its monogram, the
      // same bargain the drawn notch's plan label already makes with itself.
      const budget = (state.geometry && state.geometry.windowWidth) || 0;
      const extent = () => band.bandExtent(doc, state.geometry.notchWidth);
      if (budget && extent().width > budget) {
        for (const rst of root.querySelectorAll('.rst')) rst.remove();
        equalize();
      }
      if (budget && extent().width > budget) {
        const drawn = [...model.left, ...model.right];
        root.querySelectorAll('.unit .tag').forEach((tag, i) => {
          const gauge = drawn[i];
          if (gauge && gauge.kind === 'model') tag.textContent = vm.wingMonogram(gauge);
        });
        equalize();
      }

      // And never narrower than the panel that has to grow out of it. A
      // single chip showing a bare percentage measures under 300pt on a real
      // notch and barely 230 beside a narrow virtual one, so the panel used
      // to sit at its own floor and overhang the band on both sides — the
      // seam the whole shape depends on. The chips take the shortfall
      // instead, and they take it in every state rather than only while the
      // panel is open: a band that widened on click would be a moving target
      // in the menu bar.
      if (!state.geometry) return;
      const chips = [l, r].filter((el) => !el.classList.contains('empty'));
      const short = band.PANEL_MIN - extent().width;
      if (chips.length && short > 0) {
        const each = Math.ceil(short / chips.length);
        for (const el of chips) el.style.width = `${el.offsetWidth + each}px`;
      }
    }

    return { render };
  }

  return { createWings };
}));
