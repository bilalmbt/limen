'use strict';
/**
 * Burn rate, from a bounded history of readings.
 *
 * "73%" answers how much you have used. The question a person actually opens
 * a quota widget to ask, mid-task, is "will I make it?" — and that needs a
 * second reading to compare against, which neither this project nor its
 * ancestor used to keep.
 *
 * Two honesty constraints shape everything here:
 *
 *   1. The five-hour window is ROLLING. Usage ages off the back of it, so a
 *      straight line through two points over-predicts exhaustion. We only
 *      speak when the rise is sustained across several samples, and we
 *      always word it as a pace, never as a deadline.
 *
 *   2. The endpoint returns whole percentages. At low usage the signal is
 *      mostly quantisation noise, so a rate under half a point per ten
 *      minutes is treated as flat rather than dressed up as a trend.
 */

const WINDOW_MS = 30 * 60 * 1000;   // how far back a rate looks
const MIN_SAMPLES = 3;              // fewer than this is a coincidence
const MIN_SPAN_MS = 5 * 60 * 1000;  // and so is a rate over a two-minute gap
const MIN_RATE = 0.05;              // %/min — below this, call it flat
/**
 * The endpoint returns WHOLE percentages, so the smallest change it can
 * report is one point — and one point is also what a rounding boundary
 * produces when nothing has happened. Over the five-minute minimum span, a
 * single step is 0.2 %/min, four times MIN_RATE, so the flat-rate floor
 * could not see it: 49,49,49,50 over six minutes produced "full in ~5 h"
 * from noise. Below this many points of rise there is no signal to read.
 */
const MIN_RISE = 2;
/**
 * Only the last WINDOW_MS is ever read, which at the fastest cadence the
 * config allows (30 s) is 60 samples. The cap was 2016 — described as "7
 * days" and actually 2.8 — so a 300 KB file was re-read, re-serialised and
 * re-written every two minutes to support a thirty-minute question.
 */
const MAX_SAMPLES = 120;

/**
 * Append a reading, newest last, dropping anything past the cap.
 * Stored as flat {at, p:{id: percent}} so the file stays small and a schema
 * change to gauges cannot corrupt the series.
 */
function push(history, gauges, now, cap = MAX_SAMPLES) {
  const list = Array.isArray(history) ? history.slice() : [];
  const p = {};
  for (const g of gauges || []) {
    if (Number.isFinite(g.percent)) p[g.id] = g.percent;
  }
  if (!Object.keys(p).length) return list;
  list.push({ at: now, p });
  return list.length > cap ? list.slice(list.length - cap) : list;
}

/**
 * Percentage points per minute for one gauge, or null when there is not
 * enough evidence. A reset inside the window (the value falling) voids the
 * rate rather than reporting a negative one: the question is how fast you
 * are spending, and a reset is not spending.
 */
function rateFor(history, gaugeId, now, windowMs = WINDOW_MS) {
  const samples = (Array.isArray(history) ? history : [])
    .filter((s) => s && Number.isFinite(s.at) && s.at >= now - windowMs &&
      s.p && Number.isFinite(s.p[gaugeId]));
  if (samples.length < MIN_SAMPLES) return null;

  const first = samples[0];
  const last = samples[samples.length - 1];
  const span = last.at - first.at;
  if (span < MIN_SPAN_MS) return null;

  for (let i = 1; i < samples.length; i++) {
    if (samples[i].p[gaugeId] < samples[i - 1].p[gaugeId]) return null;   // reset
  }

  const rise = last.p[gaugeId] - first.p[gaugeId];
  if (rise < MIN_RISE) return null;   // one rounding step is not a trend
  const rate = rise / (span / 60000);
  return rate >= MIN_RATE ? rate : null;
}

/**
 * Milliseconds until this gauge reaches 100% at the current pace, or null.
 * Already-full is null too: a wall you have hit is not a forecast.
 */
function project(percent, rate, now) {
  if (!Number.isFinite(rate) || rate <= 0) return null;
  if (!Number.isFinite(percent) || percent >= 100) return null;
  return ((100 - percent) / rate) * 60000;
}

/**
 * The trend payload the panel renders: per gauge, the pace and — only when
 * it lands BEFORE the window resets — how long that leaves. Anything that
 * would resolve itself at the reset is not worth a line of a 400pt panel.
 */
function summarize(history, gauges, now) {
  const out = {};
  for (const g of gauges || []) {
    const rate = rateFor(history, g.id, now);
    if (rate === null) continue;
    const ms = project(g.percent, rate, now);
    if (ms === null) continue;
    const resetsAt = g.resetsAt ? Date.parse(g.resetsAt) : NaN;
    const beforeReset = Number.isFinite(resetsAt) ? (now + ms) < resetsAt : true;
    out[g.id] = { rate, exhaustsInMs: ms, beforeReset };
  }
  return out;
}

module.exports = {
  push, rateFor, project, summarize,
  WINDOW_MS, MIN_SAMPLES, MIN_SPAN_MS, MIN_RATE, MAX_SAMPLES
};
