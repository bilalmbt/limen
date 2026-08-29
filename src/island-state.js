'use strict';
/**
 * The island's state machine, pure and clock-free: every function takes `now`
 * and returns the next machine plus the effects the shell should perform.
 * That is what makes "a graze must not open the panel" and "a menu must never
 * be shadowed" testable sentences instead of hopes.
 *
 * States:
 *   dormant   nothing shown (the window itself may stay up for wings)
 *   peek      one line, event-driven, auto-retracts
 *   expanded  the full panel, hover-driven
 *
 * `wings` is orthogonal: two ambient rings that are on or off regardless of
 * the state above. Data freshness is also orthogonal and lives in the usage
 * payload, never here.
 */

const DORMANT = 'dormant';
const PEEK = 'peek';
const EXPANDED = 'expanded';

const T = {
  dwellMs: 120,      // hover this long before expanding: the top edge is a corridor
  graceMs: 380,      // leaving keep-alive starts this timer before collapsing
  peekMs: 4000,      // how long an alert peek stays out
  reentryMs: 1500,   // re-opening this soon skips the dwell: intent is established
  stillPt: 6,        // movement under this between samples counts as parked
  // A DELIBERATE open — the tray item, the shortcut, a click — waits this
  // long for the cursor before hover rules apply. Without it the grace timer
  // armed on the very first sample, and "Show usage" from the tray was a
  // half-second flash: the cursor was at the tray, nowhere near keep-alive.
  // Long enough to travel from any corner and read the panel; bounded, so a
  // panel promoted by an alert burst while nobody is at the desk does not
  // squat over the screen for hours.
  holdMs: 30000
};

function create() {
  return {
    state: DORMANT,
    wings: false,
    busy: false,      // a task is running IN the panel; it must not collapse
    suppressHover: false,  // dismissed by click; deaf until the cursor leaves
    dwellSince: null,
    hideAt: null,
    holdUntil: null,  // a deliberate open stays out until then, or until visited
    peekUntil: null,
    peekGaugeId: null,
    lastCollapseAt: null
  };
}

/**
 * One cursor sample. Call at the polling cadence with where the cursor is.
 * @param {object} m  the machine
 * @param {{inHot: boolean, inKeepAlive: boolean, now: number}} input
 * @param {object} t  timing overrides, for tests
 * @returns {{m: object, effects: string[]}}
 */
function tick(m, { inHot, inKeepAlive, now, moved = 0 }, t = T) {
  const effects = [];
  const next = { ...m };

  if (next.state === DORMANT) {
    // Dismissed by a click while the cursor was still on the trigger: stay
    // shut until the pointer has actually gone somewhere else.
    if (next.suppressHover) {
      if (!inHot) next.suppressHover = false;
      next.dwellSince = null;
      return { m: next, effects };
    }
    if (inHot) {
      // Dwell on STILLNESS, not presence. The top-centre strip is the route
      // from the app menus to Control Center; a cursor crossing it at a
      // normal pace is inside for the best part of a second and used to
      // open the panel every single time. A deliberate hover parks.
      const parked = moved <= t.stillPt;
      const quickReturn = next.lastCollapseAt !== null &&
        now - next.lastCollapseAt <= t.reentryMs;
      // Stillness is required either way. Quick return used to be OR'd in
      // here, so for a second and a half after ANY collapse a cursor merely
      // travelling through the strip armed the dwell — backdated, so it
      // opened on the very next sample. That is precisely the traffic the
      // stillness rule exists to ignore, leaking through the re-entry hatch,
      // and each reopen re-armed the hatch for the next crossing.
      if (!parked) {
        next.dwellSince = null;
      } else if (next.dwellSince === null) {
        // Coming straight back is intent already established: re-opening
        // should not re-charge the whole dwell.
        next.dwellSince = quickReturn ? now - t.dwellMs : now;
      } else if (now - next.dwellSince >= t.dwellMs) {
        next.state = EXPANDED;
        next.dwellSince = null;
        next.hideAt = null;
        effects.push('expand');
      }
    } else {
      next.dwellSince = null;
    }
    return { m: next, effects };
  }

  if (next.state === EXPANDED) {
    // A task running in the panel holds it open: the sign-in button's own
    // progress used to vanish the moment the cursor left.
    if (inKeepAlive || next.busy) {
      next.hideAt = null;
      // The cursor has arrived: the deliberate-open hold has done its job,
      // and from here the normal hover rules decide.
      next.holdUntil = null;
    } else if (next.holdUntil !== null && now < next.holdUntil) {
      // Opened on purpose, cursor not here yet: wait for it rather than
      // collapsing at whatever corner of the screen the tray click left it.
      next.hideAt = null;
    } else if (next.hideAt === null) {
      next.holdUntil = null;
      next.hideAt = now + t.graceMs;
    } else if (now >= next.hideAt) {
      next.state = DORMANT;
      next.hideAt = null;
      next.holdUntil = null;
      next.lastCollapseAt = now;
      effects.push('collapse');
    }
    return { m: next, effects };
  }

  // PEEK: hovering promotes to the full panel without a dwell — the island is
  // already out, the reader is already looking. Otherwise it retracts on time.
  if (inHot) {
    next.state = EXPANDED;
    next.peekUntil = null;
    next.peekGaugeId = null;
    next.hideAt = null;
    effects.push('unpeek', 'expand');
  } else if (now >= next.peekUntil) {
    next.state = DORMANT;
    next.peekUntil = null;
    next.peekGaugeId = null;
    effects.push('unpeek');
  }
  return { m: next, effects };
}

/**
 * A quota crossed an alert threshold (or reset). Dormant peeks; a peek that
 * is already out is refreshed; the expanded panel already shows everything
 * and is never demoted.
 */
function alert(m, gaugeId, now, t = T) {
  const next = { ...m };
  if (next.state === EXPANDED) return { m: next, effects: [] };

  next.state = PEEK;
  next.peekUntil = now + t.peekMs;
  next.peekGaugeId = gaugeId;
  next.dwellSince = null;
  next.hideAt = null;
  return { m: next, effects: ['peek'] };
}


/**
 * A deliberate open — the tray item, the shortcut, a click, an alert burst
 * that outgrew its peeks. A peek promotes to the panel; the panel stays as
 * it is. The hold is what lets the panel outlive a cursor that is still at
 * the tray icon it was opened from.
 */
function promote(m, now = 0, t = T) {
  if (m.state === EXPANDED) return { m: { ...m }, effects: [] };
  const wasPeek = m.state === PEEK;
  const next = {
    ...m, state: EXPANDED, holdUntil: now + t.holdMs,
    dwellSince: null, hideAt: null, peekUntil: null, peekGaugeId: null
  };
  return { m: next, effects: wasPeek ? ['unpeek', 'expand'] : ['expand'] };
}

/**
 * A deliberate click on the band — the notch or a wing chip. Opens the
 * panel, or closes it if it is already out, so the same target both reveals
 * and dismisses rather than being a one-way door.
 */
function toggle(m, now = 0) {
  if (m.state === EXPANDED) {
    if (m.busy) return { m: { ...m }, effects: [] };   // a running task holds it
    return {
      m: {
        ...m, state: DORMANT, dwellSince: null, hideAt: null, holdUntil: null,
        // The click that closed it left the cursor sitting on the very thing
        // that opens it, so hover would re-open on the next sample and the
        // panel could never be dismissed. Hovering is deaf until the cursor
        // leaves — and a deliberate close does not arm quick-return either,
        // because "go away" should not be undone by a twitch.
        suppressHover: true,
        lastCollapseAt: null
      },
      effects: ['collapse']
    };
  }
  return promote(m, now);
}

/** The global shortcut / tray checkbox: ambient wings on or off. */
function toggleWings(m) {
  const next = { ...m, wings: !m.wings };
  return { m: next, effects: [next.wings ? 'wings-on' : 'wings-off'] };
}

/** Should the window itself be visible? (Wings need it even while dormant.) */
function windowVisible(m) {
  return m.state !== DORMANT || m.wings;
}

module.exports = {
  DORMANT, PEEK, EXPANDED, T,
  create, tick, alert, promote, toggle, toggleWings, windowVisible
};
