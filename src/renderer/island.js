'use strict';
/* The renderer's composition root. The renderer only draws: it receives
   gauges, geometry, and state over IPC and answers with nothing but pixels —
   the window is click-through in every state, so nothing here is a control
   in the OS's eyes.

   The shape of the code, and why:

     IPC event ──▶ store.patch ──▶ renderAll(state) ──▶ surface.measure
                                    (one subscriber)

   - One direction. Messages land in the store; painters read from it. No
     painter writes state, so a bug is always "wrong state" or "wrong paint
     of right state", never a third thing.
   - One subscriber, so the paint ORDER is a guarantee, not a habit: the
     wings must land before the panel measures the band (panel edges derive
     from chip pixels), and the surface is measured after everything so the
     reported rects describe what is actually drawn.
   - Decisions live in the viewmodel (vm.*, tested in Node); painters live
     in one module per drawn thing and are handed their dependencies, so the
     same files load here with <script> tags and in tests with require().

   Wording and tones come from the shared viewmodel; wiring mistakes fail
   loudly at load rather than as a half-drawn island. */

/* global VM, IslandDom, IslandStore, IslandSelectors, IslandBand,
          IslandAnchor, IslandWings, IslandPeek, IslandPanel,
          IslandPrimeBar, IslandSurface */

(function () {
  // Every module this file composes, checked before anything is wired: a
  // missing <script> would otherwise surface as whichever painter happened
  // to run first throwing on undefined, far from the actual mistake. Read
  // off `window`, because a bare identifier would itself throw before the
  // check could say which file to look at.
  for (const name of ['VM', 'IslandDom', 'IslandStore', 'IslandSelectors',
    'IslandBand', 'IslandAnchor', 'IslandWings', 'IslandPeek', 'IslandPanel',
    'IslandPrimeBar', 'IslandSurface']) {
    if (!window[name]) throw new Error(`renderer module missing: ${name} — check index.html's script order`);
  }

  const $ = (sel) => document.querySelector(sel);
  const act = (name, value) => window.island.act(name, value);

  const store = IslandStore.createStore({
    geometry: null,
    data: { ok: false, reason: 'loading', gauges: [] },
    panelOpen: false,
    peek: null,        // { gaugeId } or null
    wings: false,
    signin: null       // { status: 'working' | 'done' | 'needs-terminal' | … }
  });

  // The painters, each handed exactly what it reads: the document, the
  // viewmodel, the shared band contract, and its own root element.
  const ctx = { doc: document, vm: VM, selectors: IslandSelectors,
    band: IslandBand, dom: IslandDom, act };
  const anchor = IslandAnchor.createAnchor({ ...ctx, root: $('#fakenotch') });
  const wings = IslandWings.createWings({ ...ctx, root: $('#wings') });
  const peek = IslandPeek.createPeek({ ...ctx, root: $('#peek') });
  const primebar = IslandPrimeBar.createPrimeBar({ ...ctx, root: $('#primebar') });
  const panel = IslandPanel.createPanel({ ...ctx, root: $('#panel'), primebar });
  const surface = IslandSurface.createSurface({
    doc: document,
    report: (rects) => window.island.reportSurface(rects)
  });

  /** Paint everything, in the order the measurements depend on. */
  function renderAll(state) {
    anchor.render(state);
    wings.render(state);    // before the panel: its edges derive from these pixels
    peek.render(state);
    panel.render(state);
    surface.measure(state); // last: the rects must describe what is drawn
  }
  store.subscribe(renderAll);

  // --- messages in -----------------------------------------------------------

  window.island.onGeometry((g) => {
    const root = document.documentElement.style;
    root.setProperty('--hot-h', `${g.hotHeight}px`);
    root.setProperty('--notch-w', `${g.notchWidth}px`);
    root.setProperty('--panel-w', `${g.panelWidth}px`);
    store.patch({ geometry: g });
  });

  // A null reading keeps the last one: the main process clears data by
  // sending a reading that SAYS it is degraded, never by sending nothing.
  window.island.onUsage((d) => store.patch({ data: d || store.get().data }));

  window.island.onPanel((open) => {
    const opening = open === true && !store.get().panelOpen;
    if (opening) panel.beginEntrance();
    store.patch({ panelOpen: open === true });
  });

  window.island.onPeek((p) => store.patch({ peek: p || null }));
  window.island.onWings((on) => store.patch({ wings: on === true }));
  window.island.onSignIn((s) => store.patch({ signin: s || null }));

  // The one message that skips the store: the spin reflects a real fetch in
  // flight and touches a single class — repainting the island for it would
  // be noise. It used to be a fixed 680ms animation fired on click, so it
  // played even when the request was suppressed and stopped long before a
  // slow one finished — a placebo either way.
  window.island.onBusy((on) => {
    $('#refresh-btn').classList.toggle('spinning', on === true);
  });

  // Relative labels ("resets in 51 min", "4h15") drift; keep them honest.
  // Rows are reconciled in place, so this tick never disturbs a running
  // animation. The wings count down too, so this runs while they are out.
  setInterval(() => {
    const state = store.get();
    if (state.panelOpen || state.peek || state.wings) renderAll(state);
  }, 30000);

  // --- clicks out ------------------------------------------------------------

  // The two fixed controls. The window only takes the mouse while the cursor
  // is over the island's surface, so these never intercept an outside click.
  $('#refresh-btn').addEventListener('click', () => act('refresh'));
  $('#peek').addEventListener('click', () => act('expand'));

  // A click anywhere on the band — the notch or either chip — opens the
  // panel, and closes it again. Handled by position rather than per-element
  // so the real notch, the drawn one and the wings all behave the same,
  // including the cutout where there is no element of ours to attach to.
  $('#stage').addEventListener('click', (e) => {
    const geometry = store.get().geometry;
    const band = (geometry && geometry.hotHeight) || 0;
    if (e.clientY > band) return;
    // The peek is deliberately tucked 8px under the band and is wider than
    // the notch, so its top corners sit on real band pixels. A click there
    // used to fire the peek's expand AND this toggle: the panel opened and
    // shut in one gesture, and left suppressHover set, so hovering did
    // nothing until the cursor left the strip.
    if (e.target.closest && e.target.closest('#peek')) return;
    act('toggle');
  });
})();
