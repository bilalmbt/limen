'use strict';
/* Read-side answers derived from renderer state — every "what does the state
   mean here" question, asked once and answered once. Pure, so Node tests can
   check the defaults and the one rule several painters share. */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IslandSelectors = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  function locale(state) {
    return (state.geometry && state.geometry.locale) || undefined;
  }

  function timeFormat(state) {
    return (state.geometry && state.geometry.timeFormat) || 'auto';
  }

  function wingInfo(state) {
    return (state.data && state.data.wingInfo) || 'off';
  }

  function wingSources(state) {
    const s = state.data && state.data.wingSources;
    return Array.isArray(s) && s.length ? s : ['session'];
  }

  /**
   * Whether the band is actually on screen — ONE answer for everything that
   * keys off it. renderWings once hid the chips for a signed-out account
   * while the anchor and the panel still asked `state.wings && model`, so
   * the drawn notch squared its corners toward chips that were not there,
   * and the panel sized itself from the invisible band's stale leftovers.
   */
  function wingsShowing(state, model, vm) {
    return state.wings && Boolean(model) && vm.numbersAreCurrent(state.data);
  }

  /**
   * Does the island have anything on screen to root — a panel, a peek, or
   * the band? The drawn notch keys off THIS, not the raw wings flag: it is
   * an anchor for content, not furniture. Keyed off the flag, a signed-out
   * account on a notchless display kept a black anchor wearing yesterday's
   * plan label with no chips beside it — half-dressed. The chips' own rule
   * is the band's one answer, so the anchor follows it.
   */
  function islandSaysSomething(state, model, vm) {
    return Boolean(state.panelOpen || state.peek || wingsShowing(state, model, vm));
  }

  return { locale, timeFormat, wingInfo, wingSources, wingsShowing, islandSaysSomething };
}));
