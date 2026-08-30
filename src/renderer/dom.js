'use strict';
/* DOM construction helpers. UMD like the viewmodel, so Node tests exercise
   the real code against a stub document instead of a transcription. */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IslandDom = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  /** One element, named and filled in a single call. */
  function el(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  return { el };
}));
