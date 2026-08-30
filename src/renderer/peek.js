'use strict';
/* The peek: one line, event-driven — an alert pill that names the limit it
   was raised for, resolves its gauge before revealing anything, and stays
   hidden rather than animating out empty. */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IslandPeek = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  /**
   * @param {number} minSweep  smallest arc a non-zero value may draw.
   *
   * At small sizes a true 3% arc is a hairline: the ring reads as an empty
   * grey circle and contributes nothing a glance can use. A floor makes the
   * TONE legible while the exact number sits right beside it — the same
   * bargain the panel's bars already make with `min-width`.
   */
  function setRing(vm, el, percent, severity, minSweep = 0) {
    const p = Math.max(0, Math.min(100, percent));
    el.style.setProperty('--p', String(p > 0 ? Math.max(p, minSweep) : 0));
    el.style.setProperty('--tone', `var(--${vm.tone(percent, severity)})`);
  }

  function createPeek({ root, doc, vm, selectors, dom }) {
    function render(state) {
      // Resolve the gauge before revealing anything: a peek with nothing to
      // say must stay hidden, not animate out as an empty dark pill.
      const gauge = vm.peekGauge(state.data.gauges, state.peek);
      root.classList.toggle('off', !gauge);
      if (!gauge) return;
      // The floor keeps a low-percent alert legible: a 2% arc on a 16px ring
      // is a hairline, and an alert ring that reads as an empty circle says
      // the opposite of what the pill is there to say.
      setRing(vm, root.querySelector('.ring'), gauge.percent, gauge.severity, 10);
      // The number is the entire point of an alert; as one uniform run it
      // got no emphasis and no tone, leaving the ring as the only red thing
      // in a red warning.
      const title = root.querySelector('.peek-title');
      title.textContent = `${vm.rowLabel(gauge)} `;
      title.appendChild(dom.el(doc, 'span',
        `num tone-${vm.tone(gauge.percent, gauge.severity)}`, `${gauge.percent}%`));
      root.querySelector('.peek-sub').textContent =
        vm.rateLine(gauge, state.data.trend) ||
        vm.resetLabel(gauge, Date.now(), selectors.locale(state), selectors.timeFormat(state));
    }

    return { render };
  }

  return { createPeek, setRing };
}));
