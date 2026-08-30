'use strict';
/* The settings block: which limits the band shows, what each adds, and the
   auto-open schedule — in the panel rather than the tray, because a native
   macOS menu dismisses itself on every click, so choosing a time there means
   reopening it to see the result. This is our own window, so a chip can
   toggle and stay put.

   Buttons are built once and reused. Every handler closes over a CONSTANT
   (its own mode, field or day index) and never over the current settings —
   a captured setting goes stale on the first change. */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IslandPrimeBar = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  const MODES = [
    ['', 'Off', 'Never open a window automatically'],
    ['at', 'At', 'Open a window at a time you choose'],
    ['chain', 'Chain', 'Open a new window as soon as the current one ends']
  ];
  const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  const WING_INFO = [
    ['off', '%', 'Just the percentage'],
    ['remaining', 'Left', 'Also how long until the window resets'],
    ['ends', 'Ends', 'Also when the window resets']
  ];

  /**
   * Which limits the band shows, in the order it draws them. These name the
   * limits themselves — the old control asked for a NUMBER of chips and left
   * the choice of what went in them to the app, which is why a model's week
   * could take the right chip and hide the all-models week for good.
   */
  const WING_SOURCES = [
    ['session', 'Session', 'The rolling five-hour window'],
    ['weekly', 'Week', 'The weekly quota across all models'],
    // Deliberately generic: this source is "whichever model is busiest", and
    // which one that is changes during the day. Naming it after the model an
    // account happens to have today would read as a fixed choice.
    ['model', 'Model', 'The busiest model’s own week']
  ];

  function createPrimeBar({ root, doc, vm, selectors, act, dom }) {
    /** A toggle chip's whole visible-and-spoken state, in one move: the .on
        class for the paint, aria-pressed for anything that listens. */
    function setOn(chip, on) {
      chip.classList.toggle('on', on);
      chip.setAttribute('aria-pressed', String(on));
    }

    function chip(className, dataKey, value, label, title, onClick) {
      const b = dom.el(doc, 'button', className, label);
      b.dataset[dataKey] = value;
      b.title = title;
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', onClick);
      return b;
    }

    function build() {
      const wsrc = root.querySelector('.chips.wsrc');
      for (const [value, label, title] of WING_SOURCES) {
        wsrc.appendChild(chip('chip', 'wsrc', value, label, title,
          () => act('wing-source', value)));
      }

      const winfo = root.querySelector('.chips.winfo');
      for (const [value, label, title] of WING_INFO) {
        winfo.appendChild(chip('chip', 'winfo', value, label, title,
          () => act('wing-info', value)));
      }

      const modes = root.querySelector('.chips.mode');
      for (const [value, label, title] of MODES) {
        modes.appendChild(chip('chip', 'mode', value, label, title,
          () => act('prime-mode', value)));
      }

      for (const btn of root.querySelectorAll('.step')) {
        const field = btn.dataset.field;
        const delta = Number(btn.dataset.delta);
        btn.addEventListener('click', () => act('prime-step', { field, delta }));
      }

      const days = root.querySelector('.chips.days');
      DAY_LETTERS.forEach((letter, index) => {
        days.appendChild(chip('chip day', 'day', String(index), letter,
          DAY_NAMES[index], () => act('prime-day', index)));
      });
    }

    function render(state) {
      const p = state.data.prime;
      root.classList.toggle('off', !p);
      if (!p) return;
      if (!root.dataset.built) { build(); root.dataset.built = '1'; }

      // Only worth offering while the chips are actually in the menu bar.
      for (const row of root.querySelectorAll('.prow.wingrow')) {
        row.classList.toggle('off', !state.wings);
      }
      for (const b of root.querySelectorAll('.chips.winfo .chip')) {
        setOn(b, b.dataset.winfo === selectors.wingInfo(state));
      }

      // On/off and spent, decided in the tested viewmodel: full bands, the
      // last chip still drawing, and limits this account does not expose.
      const states = vm.sourceChips(state.data.gauges, selectors.wingSources(state));
      for (const b of root.querySelectorAll('.chips.wsrc .chip')) {
        const s = states.find((x) => x.source === b.dataset.wsrc);
        if (!s) continue;
        setOn(b, s.on);
        b.disabled = s.disabled;
      }

      const mode = vm.primeMode(p);
      for (const b of root.querySelectorAll('.chips.mode .chip')) {
        setOn(b, b.dataset.mode === mode);
      }
      // Time and days only matter for a scheduled open, so they only appear
      // then — the panel does not carry controls that cannot do anything.
      for (const row of root.querySelectorAll('.prow.detail')) {
        row.classList.toggle('off', mode !== 'at');
      }
      if (mode !== 'at') return;

      root.querySelector('.clock').textContent = p.at || '08:00';
      const days = Array.isArray(p.days) ? p.days : [];
      for (const b of root.querySelectorAll('.chips.days .chip')) {
        setOn(b, days.includes(Number(b.dataset.day)));
      }
    }

    return { render };
  }

  return { createPrimeBar };
}));
