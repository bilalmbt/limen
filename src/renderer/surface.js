'use strict';
/* Where the island actually is, as a LIST of rectangles.

   Measured, never assumed: the panel is sized from the wings band and its
   height is content-driven, so any rect derived from constants drifts from
   what is drawn — and the gap is a transparent window that silently eats
   clicks. The wings ARE included: they are drawn pixels of ours, and a click
   on a chip opens the panel.

   Not a bounding box: with the wings off, one box around the notch and the
   wider panel below it would also cover the empty menu-bar strip either side
   of the notch — and clicks there belong to menu titles and status items.
   Each drawn thing reports its own rect, so the island takes the mouse over
   its own opaque pixels and nowhere else. */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IslandSurface = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  function createSurface({ doc, report }) {
    function measure(state) {
      const rects = [];
      const add = (el, minTop = 0) => {
        if (!el || el.classList.contains('off')) return;
        // offset* and NOT getBoundingClientRect(): the latter returns the
        // ANIMATED box, and this runs while the entry transform is still at
        // scaleY(0.84) translateY(-12px). Layout metrics ignore transforms
        // and describe where the thing lands.
        const left = el.offsetLeft;
        const top = Math.max(el.offsetTop, minTop);
        const w = el.offsetWidth;
        const h = el.offsetHeight - (top - el.offsetTop);
        if (w > 0 && h > 0) rects.push({ left, top, right: left + w, bottom: top + h });
      };

      // The panel and the peek are tucked a few pixels under the band so no
      // seam can open — but those tucked slivers sit in the MENU BAR strip,
      // and a click on a menu title's bottom pixels must never be ours.
      // Their clickable rects start at the band's lower edge; the band
      // itself belongs to the wings, the drawn notch, and the cutout rect
      // below, which are the things a band click is aimed at.
      const band = (state.geometry && state.geometry.hotHeight) || 0;
      add(doc.querySelector('#panel'), band);
      add(doc.querySelector('#peek'), band);
      add(doc.querySelector('#fakenotch'));
      const wings = doc.querySelector('#wings');
      if (wings && !wings.classList.contains('off')) {
        for (const wing of wings.querySelectorAll('.wing')) {
          if (!wing.classList.contains('empty')) add(wing);
        }
      }

      // A real notch has no pixels of ours to draw on, and macOS puts
      // nothing there either — so the cutout is always ours to accept a
      // click on, which is what makes clicking it open the panel from a
      // standing start.
      const g = state.geometry;
      if (g && g.notched) {
        const half = g.notchWidth / 2;
        const centre = doc.documentElement.clientWidth / 2;
        rects.push({ left: centre - half, top: 0, right: centre + half, bottom: g.hotHeight });
      }

      report(rects.length ? rects : null);
    }

    return { measure };
  }

  return { createSurface };
}));
