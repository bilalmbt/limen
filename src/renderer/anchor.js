'use strict';
/* The drawn notch: only on displays that lack a real one, only while the
   island has something to say. A side a wing joins goes square, so band and
   chip merge into one shape. */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IslandAnchor = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  function createAnchor({ root, vm, selectors }) {
    const label = root.querySelector('.notch-plan');

    function render(state) {
      const virtual = state.geometry && state.geometry.notched === false;
      const model = vm.wingsModel(state.data.gauges, selectors.wingSources(state));
      const joined = selectors.wingsShowing(state, model, vm);
      // The band counts as "something to say" only when the chips are
      // actually out (their rule, not the raw flag) — see the selector.
      const anything = selectors.islandSaysSomething(state, model, vm);
      root.classList.toggle('off', !(virtual && anything));
      root.classList.toggle('join-left', joined && model.left.length > 0);
      root.classList.toggle('join-right', joined && model.right.length > 0);

      // The plan, in the one place a MacBook cannot put anything. A drawn
      // notch is our own rectangle rather than a camera housing, so on those
      // displays it can name what the numbers either side of it are a
      // percentage of.
      //
      // Not while the panel is open: the header says it there, forty pixels
      // below, and twice in forty pixels is once too many.
      const plan = virtual && !state.panelOpen && typeof state.data.plan === 'string'
        ? state.data.plan : '';
      label.textContent = plan;
      // All or nothing, at whatever width this display's notch actually is.
      // The rectangle is pretending to be hardware, and hardware does not
      // clip text — a half-shown "Enterpris" reads as a bug, where nothing
      // reads as a notch. Measured rather than assumed: the width comes from
      // the display.
      if (plan && root.scrollWidth > root.clientWidth) label.textContent = '';
    }

    return { render };
  }

  return { createAnchor };
}));
