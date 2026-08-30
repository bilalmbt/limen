'use strict';
/* The band ↔ panel contract, in one place because it binds two painters.

   The wings widen themselves to at least PANEL_MIN, and the panel spans the
   band's measured extent with PANEL_MIN as a backstop — both read the same
   floor and the same measurement, which is what keeps their edges flush. */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IslandBand = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  /**
   * The narrowest the panel may be drawn — and therefore the narrowest the
   * BAND may be, because the two share their edges and one of them has to
   * give.
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
   * chips and the panel are sized from this one answer.
   */
  function bandExtent(doc, notchWidth) {
    const centre = doc.documentElement.clientWidth / 2;
    let left = centre - notchWidth / 2;
    let right = centre + notchWidth / 2;
    for (const wing of doc.querySelectorAll('#wings .wing')) {
      if (wing.classList.contains('empty')) continue;
      left = Math.min(left, wing.offsetLeft);
      right = Math.max(right, wing.offsetLeft + wing.offsetWidth);
    }
    return { left, right, width: right - left };
  }

  return { PANEL_MIN, bandExtent };
}));
