'use strict';
/**
 * The little that must survive a restart.
 *
 * Two things, and both were bugs in the ancestor project before this file
 * existed. The failure count, because a widget restarted while rate limited
 * would otherwise start over at full speed and keep the limit alive. And the
 * last real reading, so a fresh start shows numbers immediately instead of
 * an empty island while the first request travels.
 *
 * Ported from Claude-Marge-Widget (MIT, Ulrich Rozier); only the paths differ.
 */

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

// The override exists so the tests can exercise a real file without touching
// the user's own state.
const FILE = process.env.ISLAND_STATE_FILE || paths.file('state.json');
const DIR = path.dirname(FILE);
const MAX_AGE_MS = 24 * 60 * 60 * 1000;   // older readings are not worth showing

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch (_) {
    return {};
  }
}

/**
 * What this file is allowed to contain. Anything else is debris from an
 * older version, and merging on save would carry it forever — so the list
 * is enforced on every write rather than only on the keys we happen to
 * touch.
 */
const KNOWN = [
  'lastGood',           // the last successful reading
  'failures',           // consecutive failures, so a restart keeps the backoff
  'nextAllowedAt',      // when the next fetch is due, so a restart serves it out
  'lastReason',         // what the last failure was
  'alerts',             // the ledger: once per level, per gauge, per window
  'alertsPausedUntil',  // a pause the user asked for
  'history',            // percentage samples for burn rate
  'lastPrime'           // the auto-open slot already acted on today
];

function write(state) {
  try {
    const clean = {};
    for (const key of KNOWN) {
      if (state[key] !== undefined) clean[key] = state[key];
    }
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(clean, null, 2));
    return true;
  } catch (_) {
    return false;    // a read-only home must not take the widget down
  }
}

/** The stored reading, only if it is recent enough to be worth showing. */
function restoreLastGood(now = Date.now()) {
  const { lastGood } = read();
  if (!lastGood || !lastGood.fetchedAt) return null;
  if (now - lastGood.fetchedAt > MAX_AGE_MS) return null;
  if (!Array.isArray(lastGood.gauges) || !lastGood.gauges.length) return null;
  return lastGood;
}

/** Failures carry over, so a restart does not undo the backoff. */
function restoreFailures() {
  const { failures } = read();
  return Number.isInteger(failures) && failures > 0 ? failures : 0;
}

function save(patch) {
  return write({ ...read(), ...patch });
}

module.exports = { read, write, save, restoreLastGood, restoreFailures, KNOWN, FILE, MAX_AGE_MS };
