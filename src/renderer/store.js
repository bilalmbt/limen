'use strict';
/* The renderer's single source of truth.

   Every IPC message lands here as a patch, and every paint reads from here —
   one direction, no side channels, so a bug is always "wrong state" or
   "wrong paint of right state", never a third thing. Subscribers run after
   each patch; island.js registers exactly one, which is what guarantees the
   paint ORDER (the panel measures the band, so wings must land first). */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IslandStore = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  function createStore(initial) {
    const state = Object.assign({}, initial);
    const subscribers = [];
    return {
      /** The live state. Read-only by convention: mutate via patch(). */
      get() { return state; },
      /** Merge a partial state in, then tell every subscriber once. */
      patch(partial) {
        Object.assign(state, partial);
        for (const fn of subscribers) fn(state);
      },
      subscribe(fn) { subscribers.push(fn); }
    };
  }

  return { createStore };
}));
