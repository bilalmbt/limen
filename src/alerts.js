'use strict';
/**
 * Threshold alerts: say something before the ceiling, not after it.
 *
 * The rule is "once per level, per gauge, per reset window". Crossing 80%
 * notifies once; staying above it says nothing more; the window resetting
 * arms it again. Without that bookkeeping a widget polling every two minutes
 * would notify thirty times an hour, which teaches people to ignore it.
 *
 * Ported unchanged from Claude-Marge-Widget (MIT, Ulrich Rozier). In the
 * island these alerts drive the peek state first, notifications second.
 */

/**
 * A gauge's pace alert is remembered under its own key, so "you crossed 80"
 * and "you will run out first" are independent once-per-window promises.
 */
const paceKey = (id) => `pace-${id}`;

/** Above this the crit threshold owns the warning, and pace would repeat it. */
const PACE_CEILING = 90;

/**
 * Consecutive polls a gauge must be absent before its ledger entry is
 * forgotten. One absent poll is as likely a blip as a removal — a single 200
 * can carry one unreadable utilization, which usage.js reads as "no such
 * limit" — so removal is only believed once polls keep saying it.
 */
const FORGET_AFTER_POLLS = 3;

/** @returns {{gauge, level}[]} the alerts to raise now, and the new ledger. */
function due(gauges, thresholds, ledger) {
  const levels = [...(thresholds || [])].sort((a, b) => b - a);
  const next = { ...(ledger || {}) };
  const raise = [];

  for (const gauge of gauges || []) {
    const crossed = levels.find((l) => gauge.percent >= l);
    if (crossed === undefined) continue;

    const seen = next[gauge.id];
    // A gauge with no reset date has no window to be "the same" as, and
    // keying them all to null meant it spoke once and then never again.
    // Treated as a fresh window each time: an alert that repeats is a
    // nuisance, one that never comes back is a silence you cannot diagnose.
    const window = gauge.resetsAt || null;
    const sameWindow = seen && window !== null && seen.window === window;
    if (sameWindow && seen.level >= crossed) continue;   // already said, stay quiet

    next[gauge.id] = { window, level: crossed };
    raise.push({ gauge, level: crossed });
  }

  // Forget gauges the account no longer exposes, so the ledger cannot grow
  // forever — but read a pace key as the gauge it belongs to. Pruning by bare
  // id deleted every pace entry on every poll, which re-armed the pace alert
  // each time: "once per window" became once every two minutes.
  //
  // And never on one poll's word. A 200 can arrive with a single unreadable
  // utilization, which usage.js reads as "no such limit", so a real gauge is
  // simply not in this list for a poll. Forgetting it there re-armed its
  // spoken alert for the moment it returned: "once per window" became twice.
  // Absence has to be consecutive to mean removal, and the count rides the
  // entry itself so the persisted ledger carries it across a restart.
  const alive = new Set((gauges || []).map((g) => g.id));
  for (const key of Object.keys(next)) {
    const entry = next[key];
    if (!entry || typeof entry !== 'object') { delete next[key]; continue; }   // debris
    const id = key.startsWith('pace-') ? key.slice('pace-'.length) : key;
    if (alive.has(id)) {
      // Present again: the absence was a blip, and the count starts over.
      if ('missing' in entry) {
        next[key] = { ...entry };
        delete next[key].missing;
      }
      continue;
    }
    const missing = (Number.isInteger(entry.missing) ? entry.missing : 0) + 1;
    if (missing >= FORGET_AFTER_POLLS) delete next[key];
    else next[key] = { ...entry, missing };
  }

  return { raise, ledger: next };
}

/**
 * Everything the island is entitled to say this poll, and the ledger that
 * makes it say each thing once.
 *
 * Two kinds ride the same ledger. A threshold crossing is a LAGGING signal —
 * it fires once you are already there. "You will run out before this window
 * resets" is the leading one, and it stays quiet above PACE_CEILING because
 * the crit threshold is already saying it.
 *
 * `silenced` is a pause, and a pause SKIPS rather than defers. The ledger
 * still advances, so what was missed stays missed: returning before the
 * bookkeeping meant a crossing during a pause peeked the moment the pause
 * lapsed — news an hour old, arriving as an interruption, from the one
 * control asked for silence. The wings and the panel carry the number the
 * instant anyone looks.
 *
 * @param {{thresholds?: number[], summary?: object, ledger?: object, silenced?: boolean}} options
 * @returns {{raise: object[], ledger: object}}
 */
function plan(gauges, options) {
  const { thresholds = [], summary = null, ledger = {}, silenced = false } = options || {};
  // No thresholds is the config's way of saying "never interrupt me", and it
  // covers the pace warning too — it is the same interruption.
  if (!thresholds.length) return { raise: [], ledger };

  const { raise, ledger: next } = due(gauges, thresholds, ledger);

  const paced = [];
  for (const gauge of gauges || []) {
    const t = summary && summary[gauge.id];
    if (!t || !t.beforeReset || gauge.percent >= PACE_CEILING) continue;
    const seen = next[paceKey(gauge.id)];
    if (seen && seen.window === (gauge.resetsAt || null)) continue;
    next[paceKey(gauge.id)] = { window: gauge.resetsAt || null, level: 'pace' };
    paced.push({ gauge, level: 'pace', minutes: Math.round(t.exhaustsInMs / 60000) });
  }

  return { raise: silenced ? [] : [...raise, ...paced], ledger: next };
}

module.exports = { due, plan, PACE_CEILING, FORGET_AFTER_POLLS };
