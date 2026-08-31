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
  wingSources: ['session'], // WHICH limits the chips show; see SOURCES below
  externalDisplays: 'island', // 'island' draws a virtual one, 'off' draws nothing
  displayId: 'primary',     // which notchless display hosts the virtual island
  notchWidth: null,         // points; null = derived from the display
  notched: null,            // true/false forces the answer; null = detect by shape
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

/**
 * The limits a chip can name, in the order the band draws them.
 *
 * Every entry is a limit you can point at. 'auto' used to sit at the end —
 * not a limit but a rule, "whatever will stop you first" — and it read as a
 * fourth quota sitting beside three real ones. A control that names a rule
 * in the same breath as the things it chooses between is a control that has
 * to be explained, so it is gone.
 */
const SOURCES = ['session', 'weekly', 'model'];

/** Removed sources a settings file may still be asking for. */
const LEGACY_SOURCES = ['auto'];

/**
 * The notch has two sides, so a third source has to share a chip and a fourth
 * would have nowhere to go. Kept as a real rule rather than an accident of
 * there being three sources today: the band's shape is what sets it, not the
 * length of the list.
 */
const MAX_SOURCES = 3;

function validTime(t) { return typeof t === 'string' && TIME_RE.test(t.trim()); }

/**
 * Keep the valid entries — unless that would empty a list the reader meant
 * to fill, in which case say so and let the default stand. An empty list is
 * a real setting here ("never alert", "never auto-open"), so arriving at one
 * by throwing away everything the file said is the one outcome that is both
 * wrong and silent.
 */
function keptOrRejected(v, ok) {
  if (!Array.isArray(v)) return undefined;
  const kept = v.filter(ok);
  if (!kept.length && v.length) return undefined;   // rejected, and reported
  return kept;
}

/**
 * A source list the band can actually draw: known names, no repeats, in the
 * canonical order, at most three. Ordered here rather than by click order so
 * the chips never swap sides between one session and the next.
 */
function cleanSources(v) {
  if (!Array.isArray(v)) return undefined;
  const list = SOURCES.filter((name) => v.includes(name));
  if (list.length) return list.slice(0, MAX_SOURCES);
  // A file still asking only for a removed source is migrated to the default
  // rather than reported as debris: the setting was ours to retire, not a
  // mistake anyone made.
  return v.some((n) => LEGACY_SOURCES.includes(n)) ? DEFAULTS.wingSources.slice() : undefined;
}

/**
 * Turn one source on or off.
 *
 * Two refusals, and both exist so that a click only ever changes the thing
 * clicked. A full band ignores a fourth rather than making room by dropping
 * whichever source happens to sort last; and the last source standing cannot
 * be turned off, because a band with nothing in it is not a setting anyone
 * meant to choose. Substituting another source there was worse than
 * refusing: it lit a control the reader never touched.
 *
 * The interface greys out both cases, and this agrees with it even when the
 * interface is a hand-edited file.
 */
function toggleSource(list, name) {
  const base = cleanSources(list) || DEFAULTS.wingSources.slice();
  if (!SOURCES.includes(name)) return base;
  if (base.includes(name)) {
    return cleanSources(base.filter((n) => n !== name)) || base;   // never empty
  }
  if (base.length >= MAX_SOURCES) return base;   // no room; say nothing changed
  return cleanSources(base.concat(name)) || base;
}

/** One value, checked on its own terms. Returns undefined to mean "use the default". */
function clean(key, v) {
  switch (key) {
    case 'refreshSeconds':
      return Number.isFinite(v) && v >= 30 && v <= 3600 ? v : undefined;
    case 'notchWidth':
      return Number.isFinite(v) && v > 0 ? Math.min(v, 600) : undefined;
    // The three list settings share a trap: filtering an all-invalid list
    // leaves an EMPTY one, which is itself a valid and meaningful setting —
    // no alerts, no auto-open, no days. `alertAt: ["80","95"]` in a
    // hand-edited file silently turned alerts off and reported nothing.
    // An empty result from a non-empty input is a rejection, not a value.
    case 'alertAt':
      return keptOrRejected(v, (n) => Number.isFinite(n) && n > 0 && n <= 100);
    case 'primeAt':
      return keptOrRejected(v, validTime);
    case 'primeDays':
      return keptOrRejected(v, (d) => Number.isInteger(d) && d >= 0 && d <= 6);
    case 'wings':
    case 'osNotifications':
    case 'primeChain':
      return v === true ? true : v === false ? false : undefined;
    case 'contentProtection':
      return typeof v === 'boolean' ? v : undefined;
    // Only a hand-written true or false counts as forcing the detection;
    // anything else — including an explicit null — means "detect by shape".
    case 'notched':
      return typeof v === 'boolean' ? v : undefined;
    case 'externalDisplays':
      return v === 'off' || v === 'island' ? v : undefined;
    case 'wingInfo':
      return ['off', 'remaining', 'ends'].includes(v) ? v : undefined;
    case 'wingSources':
      return cleanSources(v);
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
    if (key === 'wingCount') continue;    // renamed; handled below, not debris
    if (!KNOWN.includes(key)) { dropped.push(key); continue; }   // debris
    const value = clean(key, input[key]);
    if (value === undefined) { dropped.push(key); continue; }    // unusable
    file[key] = value;
  }

  // wingCount asked for a NUMBER of chips; wingSources names the limits. The
  // old setting is migrated rather than discarded — a file that asked for two
  // chips keeps showing two, and the reader never has to notice the rename.
  if (file.wingSources === undefined && 'wingCount' in input) {
    if (input.wingCount === 2) file.wingSources = ['session', 'weekly'];
    else if (input.wingCount === 1) file.wingSources = ['session'];
    else dropped.push('wingCount (unreadable; wingSources left at its default)');
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

module.exports = {
  DEFAULTS, KNOWN, SOURCES, LEGACY_SOURCES, MAX_SOURCES,
  normalize, sanitize, clean, toggleSource
};
