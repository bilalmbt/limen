'use strict';
/**
 * The settings file, and the rules that keep it honest.
 *
 * Two jobs, and the second is the one that was missing:
 *
 *   1. Every value is untrusted. The file is meant to be hand-edited, so a
 *      wrong type must degrade one setting rather than take the app down or
 *      silently stop the refresh loop.
 *
 *   2. The file is NORMALISED, not merely read. Validating each field on its
 *      own let contradictory pairs survive — an auto-open time recorded
 *      alongside "chain", where chain silently wins and the other setting
 *      sits there forever looking like it applied. Unknown keys lingered the
 *      same way, so every renamed setting left debris behind it.
 *
 * Kept free of Electron so both can be tested.
 */

const DEFAULTS = {
  refreshSeconds: 120,      // asking more often is what gets you rate limited
  alertAt: [80, 95],        // peek when a quota crosses these marks; [] = never
  wings: false,             // ambient chips: opt-in, the menu bar is busy land
  wingInfo: 'remaining',    // what a chip adds: 'off', 'remaining', 'ends'
  wingCount: 1,             // 1 = only the limit that will stop you; 2 = both
  externalDisplays: 'island', // 'island' draws a virtual one, 'off' draws nothing
  displayId: 'primary',     // which notchless display hosts the virtual island
  notchWidth: null,         // points; null = derived from the display
  timeFormat: 'auto',       // 'auto', '12' or '24'
  osNotifications: false,   // peek replaces notifications; turn both on if you like
  contentProtection: true,  // keep the island out of screenshots and shares
  shortcut: 'CommandOrControl+Shift+I',     // menu-bar chips; '' registers nothing
  showShortcut: 'CommandOrControl+Shift+U', // open the panel without the mouse

  // Session priming. OFF unless you choose a time or chain. The five-hour
  // window starts at your first message, so opening one at 08:00 puts the
  // boundaries at 13:00 and 18:00 — inside the working day.
  primeAt: [],              // e.g. ["08:00"] — local times
  primeDays: [1, 2, 3, 4, 5], // 0 = Sunday … 6 = Saturday
  primeChain: false,        // open a new window the moment the old one ends
  primeModel: 'haiku'       // cheapest model: priming must not eat an Opus budget
};

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const KNOWN = Object.keys(DEFAULTS);

function validTime(t) { return typeof t === 'string' && TIME_RE.test(t.trim()); }

/** One value, checked on its own terms. Returns undefined to mean "use the default". */
function clean(key, v) {
  switch (key) {
    case 'refreshSeconds':
      return Number.isFinite(v) && v >= 30 && v <= 3600 ? v : undefined;
    case 'notchWidth':
      return Number.isFinite(v) && v > 0 ? Math.min(v, 600) : undefined;
    case 'alertAt':
      return Array.isArray(v)
        ? v.filter((n) => Number.isFinite(n) && n > 0 && n <= 100)
        : undefined;
    case 'primeAt':
      return Array.isArray(v) ? v.filter(validTime) : undefined;
    case 'primeDays':
      return Array.isArray(v)
        ? v.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
        : undefined;
    case 'wings':
    case 'osNotifications':
    case 'primeChain':
      return v === true ? true : v === false ? false : undefined;
    case 'contentProtection':
      return typeof v === 'boolean' ? v : undefined;
    case 'externalDisplays':
      return v === 'off' || v === 'island' ? v : undefined;
    case 'wingInfo':
      return ['off', 'remaining', 'ends'].includes(v) ? v : undefined;
    case 'wingCount':
      return v === 1 || v === 2 ? v : undefined;
    case 'timeFormat':
      return ['12', '24', 'auto'].includes(v) ? v : undefined;
    case 'shortcut':
    case 'showShortcut':
      return typeof v === 'string' ? v : undefined;
    case 'primeModel':
      return typeof v === 'string' && /^[a-z0-9-]{1,60}$/.test(v) ? v : undefined;
    case 'displayId':
      return typeof v === 'string' || Number.isFinite(v) ? v : undefined;
    default:
      return undefined;
  }
}

/**
 * The file as it SHOULD look: known keys only, each value valid, and the
 * invariants between them held. Deliberately keeps only the keys the user
 * actually wrote — a minimal file stays minimal instead of becoming a dump
 * of every default.
 *
 * @returns {{file: object, dropped: string[]}}
 */
function normalize(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const file = {};
  const dropped = [];

  for (const key of Object.keys(input)) {
    if (!KNOWN.includes(key)) { dropped.push(key); continue; }   // debris
    const value = clean(key, input[key]);
    if (value === undefined) { dropped.push(key); continue; }    // unusable
    file[key] = value;
  }

  // Auto-open is ONE choice. Holding it as two settings let both be true at
  // once, where chain wins and the time sits in the file forever looking as
  // though it had applied.
  if (file.primeChain === true && Array.isArray(file.primeAt) && file.primeAt.length) {
    delete file.primeAt;
    dropped.push('primeAt (auto-open was set to chain)');
  }

  return { file, dropped };
}

/** The effective settings: defaults with the cleaned file laid over them. */
function sanitize(raw) {
  const { file, dropped } = normalize(raw);
  return { config: { ...DEFAULTS, ...file }, file, dropped };
}

module.exports = { DEFAULTS, KNOWN, normalize, sanitize, clean };
