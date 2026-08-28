'use strict';
/**
 * Session priming: opening a fresh five-hour window at a time you choose.
 *
 * The five-hour window starts when you send your first message, so where its
 * boundary falls is decided by when you happen to start work. Prime at 08:00
 * and the boundaries land at 13:00 and 18:00 — inside the working day, where
 * hitting a cap costs you a coffee break rather than an evening.
 *
 * Two rules keep this honest, and both are the point of the module:
 *
 *   1. It only acts when acting would DO something. A message sent while a
 *      window is already running does not restart it — the window still ends
 *      five hours after its own first message. Priming then would spend
 *      quota to achieve exactly nothing, so a running window means skip.
 *
 *   2. It acts once per slot. A missed slot is not made up later in the day
 *      beyond a short grace, because a prime at 14:00 that was meant for
 *      08:00 puts the boundary in the wrong place — which is the very
 *      problem this exists to solve.
 *
 * Kept free of clocks and Electron so the decision can be tested: everything
 * here takes the local time as plain numbers.
 */

const DEFAULT_GRACE_MIN = 15;

/** "08:00" -> 480 minutes into the local day; null if it isn't a time. */
function parseTime(text) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(text || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** The configured slots for a given weekday, in order, as minutes. */
function slotsFor(times, days, weekday) {
  if (!Array.isArray(times) || !times.length) return [];
  const onDays = Array.isArray(days) && days.length ? days : [0, 1, 2, 3, 4, 5, 6];
  if (!onDays.includes(weekday)) return [];
  return times.map(parseTime).filter((m) => m !== null).sort((a, b) => a - b);
}

/**
 * The slot we should prime for right now, or null.
 *
 * @param {object} o
 * @param {string[]} o.times        e.g. ["08:00", "13:00"]
 * @param {number[]} o.days         0=Sunday … 6=Saturday
 * @param {number} o.weekday        local weekday now
 * @param {number} o.minutesNow     local minutes into the day now
 * @param {number|null} o.lastSlot  slot already primed today, or null
 * @param {boolean} o.sessionOpen   is a five-hour window currently running
 * @param {number} [o.graceMin]     how late a slot may still be acted on
 * @returns {number|null} the slot, so the caller can record it
 */
function dueSlot({ times, days, weekday, minutesNow, lastSlot = null,
  sessionOpen = false, graceMin = DEFAULT_GRACE_MIN }) {
  // A window that is already open cannot be restarted by another message;
  // priming into it would spend quota and change nothing.
  if (sessionOpen) return null;

  const slots = slotsFor(times, days, weekday);
  let due = null;
  for (const slot of slots) {
    if (minutesNow < slot || minutesNow > slot + graceMin) continue;
    if (lastSlot !== null && lastSlot >= slot) continue;   // already done
    due = slot;
  }
  return due;
}

/**
 * The next slot, for telling the user when the island will next act.
 * @returns {{minutes: number, daysAhead: number}|null}
 */
function nextSlot({ times, days, weekday, minutesNow }) {
  for (let ahead = 0; ahead <= 7; ahead++) {
    const day = (weekday + ahead) % 7;
    for (const slot of slotsFor(times, days, day)) {
      if (ahead === 0 && slot <= minutesNow) continue;
      return { minutes: slot, daysAhead: ahead };
    }
  }
  return null;
}

/**
 * One control, one value. The auto-open setting is a single choice — off, a
 * time, or chain — so it is set as one, not as two messages that have to
 * agree. Two settings meant a click could land half-applied.
 *
 * @param {string} mode  "" | "HH:MM" | "chain"
 * @returns {{chain: boolean, times: string[]}}
 */
function resolveMode(mode, current = []) {
  const text = String(mode == null ? '' : mode);
  if (text === 'chain') return { chain: true, times: [] };
  // "at" means "on, at whatever time is already chosen" — switching away to
  // chain and back must not silently forget it.
  if (text === 'at') {
    const kept = (Array.isArray(current) ? current : []).filter((t) => parseTime(t) !== null);
    return { chain: false, times: kept.length ? [kept[0]] : ['08:00'] };
  }
  return parseTime(text) !== null
    ? { chain: false, times: [text] }
    : { chain: false, times: [] };
}

/**
 * Nudge one field of a time, wrapping rather than clamping: reaching 07:00
 * from 09:00 should be two clicks down, not a walk to midnight and back.
 *
 * @param {string} time   "HH:MM"
 * @param {'h'|'m'} field
 * @param {number} delta  steps; minutes move in quarter hours
 */
function stepTime(time, field, delta) {
  const base = parseTime(time);
  if (base === null || !Number.isFinite(delta)) return formatSlot(parseTime('08:00'));
  const step = field === 'h' ? 60 : 15;
  const next = (((base + delta * step) % 1440) + 1440) % 1440;
  return formatSlot(next);
}

/** Turn one weekday on or off, kept sorted so the file reads the same way twice. */
function toggleDay(days, day) {
  if (!Number.isInteger(day) || day < 0 || day > 6) return [...(days || [])];
  const set = new Set((days || []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6));
  if (set.has(day)) set.delete(day); else set.add(day);
  return [...set].sort((a, b) => a - b);
}

/** 480 -> "08:00", for display. */
function formatSlot(minutes) {
  if (!Number.isFinite(minutes)) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

module.exports = {
  parseTime, slotsFor, dueSlot, nextSlot, formatSlot, resolveMode,
  stepTime, toggleDay, DEFAULT_GRACE_MIN
};
