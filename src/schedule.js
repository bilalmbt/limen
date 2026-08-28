'use strict';
/**
 * When to ask again. Kept apart from Electron so the backoff can be tested:
 * getting this wrong is what earns an HTTP 429 in the first place.
 *
 * Ported unchanged from Claude-Marge-Widget (MIT, Ulrich Rozier).
 */

const MIN_SECONDS = 30;
const MAX_DELAY_MS = 15 * 60 * 1000;
const MAX_FAILURES = 6;

/**
 * @param {{ok: boolean, retryAfter?: number}} result  the last answer
 * @param {number} failures  consecutive failures, this one included
 * @param {number} baseSeconds  the configured interval
 * @returns {number} milliseconds to wait before asking again
 */
function nextDelay(result, failures, baseSeconds) {
  const base = Math.max(MIN_SECONDS, baseSeconds || 60) * 1000;
  if (result && result.ok) return base;

  // The server told us how long to wait: obey it, never ask sooner. (Clamped
  // to the same cap as our own backoff.)
  if (result && Number.isFinite(result.retryAfter) && result.retryAfter > 0) {
    return Math.min(MAX_DELAY_MS, Math.max(base, result.retryAfter * 1000));
  }

  const steps = Math.min(Math.max(1, failures), MAX_FAILURES);
  return Math.min(MAX_DELAY_MS, base * Math.pow(2, steps));
}

/** Should a reveal trigger a fresh call, or is the last read good enough? */
function shouldRefreshOnReveal(lastGoodAt, failures, now) {
  if (failures > 0) return false;        // already backing off, do not pile on
  if (!lastGoodAt) return true;
  return (now - lastGoodAt) > 60000;
}

/** A person may ask again this often, however hard they click. */
const FORCE_FLOOR_MS = 5000;

/**
 * The single gate every fetch passes through, whoever asked.
 *
 * Scheduling the next call is not the same as forbidding an earlier one: a
 * timer only governs the caller holding it, and this app has six callers
 * (the timer, a hover, the tray, a button, waking from sleep, signing in).
 * Any of them asking early is how a rate limit becomes permanent, so the
 * rule lives here rather than in each of them.
 *
 * `force` marks a person who is looking at the widget and wants an answer
 * now. That waives OUR OWN courtesy pacing, subject to a small floor so a
 * held mouse button cannot become a flood — but it never waives a backoff
 * the SERVER imposed, because asking again inside a 429 window is precisely
 * how a rate limit sustains itself.
 *
 * Note what `serverImposed` deliberately is NOT: "we have failures". A
 * rejected token, an offline laptop and a 500 all produce failures, and none
 * of them is the server asking us to slow down — blocking a person's click
 * on those would strand them exactly when a retry is the fix.
 *
 * @param {{now: number, nextAllowedAt: number, serverImposed?: boolean,
 *          lastFetchAt?: number, force?: boolean}} state
 */
function mayFetch({ now, nextAllowedAt, serverImposed = false, lastFetchAt = 0, force = false }) {
  if (now >= nextAllowedAt) return true;
  if (force !== true || serverImposed === true) return false;
  return now >= lastFetchAt + FORCE_FLOOR_MS;
}

/** Did the server itself ask us to slow down? Only that is unwaivable. */
function isServerImposed(result) {
  if (!result || result.ok) return false;
  return result.reason === 'rate-limited' || Number.isFinite(result.retryAfter);
}

module.exports = {
  nextDelay, shouldRefreshOnReveal, mayFetch, isServerImposed,
  MIN_SECONDS, MAX_DELAY_MS, MAX_FAILURES, FORCE_FLOOR_MS
};
