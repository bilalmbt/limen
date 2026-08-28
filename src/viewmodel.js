'use strict';
/* What the renderer says and colors, kept pure so it can be tested in Node
   and loaded in the page with a plain <script> tag. Time-format handling
   follows Claude-Marge-Widget's format.js (MIT, Ulrich Rozier): "auto" must
   mean the locale's own habit, so hour12 is simply not passed. */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VM = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  /**
   * Headroom tone. Amber used to start at 35%, which is barely a third of a
   * quota — alarm fatigue by design. Caution now begins at the halfway mark,
   * where it means something.
   */
  function tone(percent, severity) {
    // The server grades its own limits; when it speaks, it outranks our
    // thresholds, so the scale stays right if Anthropic moves the cliff.
    if (severity && severity !== 'normal') {
      if (severity === 'critical' || severity === 'exceeded') return 'crit';
      if (severity === 'warning' || severity === 'high') return 'hot';
    }
    if (percent < 50) return 'ok';
    if (percent < 75) return 'warn';
    if (percent < 90) return 'hot';
    return 'crit';
  }

  function rowLabel(gauge) {
    if (gauge.kind === 'session') return 'Current session';
    if (gauge.kind === 'weekly') return 'All models';
    return `${gauge.model}, this week`;
  }

  /** @param {'auto'|'12'|'24'} setting */
  function timeOptions(setting) {
    const base = { hour: '2-digit', minute: '2-digit' };
    if (setting === '12') return { ...base, hour12: true };
    if (setting === '24') return { ...base, hour12: false, hourCycle: 'h23' };
    return base;   // auto: the locale decides, which is the point of auto
  }

  /**
   * "resets in 51 min" for the rolling session, "resets Mon 4:17 PM" for the
   * weekly windows — relative time answers "will it free up during this
   * task", absolute answers "which day am I budgeting for".
   */
  function resetLabel(gauge, now, locale, timeFormat) {
    if (!gauge.resetsAt) return '';
    const at = new Date(gauge.resetsAt).getTime();
    if (!Number.isFinite(at)) return '';
    if (gauge.resetStyle === 'relative') {
      const mins = Math.max(0, Math.round((at - now) / 60000));
      if (mins < 1) return 'resets any minute';
      if (mins < 60) return `resets in ${mins} min`;
      const h = Math.floor(mins / 60);
      const r = mins % 60;
      return r ? `resets in ${h} h ${r} min` : `resets in ${h} h`;
    }
    const d = new Date(at);
    const day = d.toLocaleDateString(locale || undefined, { weekday: 'short' });
    const time = d.toLocaleTimeString(locale || undefined, timeOptions(timeFormat));
    return `resets ${day} ${time}`;
  }

  /**
   * What hitting 100% actually means for this account.
   *
   * Without extra usage, a full bar is a wall: work stops until the window
   * resets. With extra usage enabled it is a threshold: work continues and
   * billing starts. Showing the same red bar for both tells the people
   * spending money that they are about to be stopped, which is the opposite
   * of what happens — so the panel has to say which world it is in.
   */
  function ceilingNote(data) {
    if (!data || !data.ok) return '';
    if (!data.extraUsageEnabled) return '';
    return 'extra usage on — past 100% bills, it does not stop';
  }

  /**
   * "full in ~40 min" — said only when the pace would exhaust the quota
   * before its window resets, because a limit that resets first needs no
   * warning and a 400pt panel has no room for reassurance. Worded as a pace
   * rather than a deadline: the five-hour window is rolling, so a straight
   * line through the samples is an estimate, not a promise.
   */
  function rateLine(gauge, trend) {
    const t = trend && trend[gauge.id];
    if (!t || !t.beforeReset) return '';
    const mins = Math.round(t.exhaustsInMs / 60000);
    if (mins < 1) return 'full any minute';
    if (mins < 60) return `full in ~${mins} min`;
    const h = Math.floor(mins / 60);
    const r = mins % 60;
    return r >= 10 ? `full in ~${h} h ${r} min` : `full in ~${h} h`;
  }

  /** Reasons a fresh Claude Code sign-in would fix. */
  function isCredentialProblem(reason) {
    return reason === 'no-credentials' || reason === 'token-expired' || reason === 'unauthorized';
  }

  /** Why the numbers are stale, in words a human can act on. */
  function reasonLabel(reason) {
    // Diagnoses, not instructions: the panel's button carries the action, and
    // a note that repeats it in dimmer type says the same thing twice.
    const known = {
      'no-credentials': "Claude Code isn't signed in",
      'token-expired': 'Your Claude Code sign-in expired',
      'unauthorized': 'Claude rejected this sign-in',
      'rate-limited': 'Anthropic throttled the check',
      'server': 'Claude’s API is unavailable',
      'network': 'No connection',
      'loading': 'First read on its way'
    };
    return known[reason] || reason || 'Unknown problem';
  }

  /**
   * The strip on a degraded panel: what happened, and when we retry. The
   * word "stale" is gone — the amber dot and the header's "as of" already
   * carry it, and three middot-chained clauses in the smallest type read as
   * developer vocabulary rather than a status.
   */
  function staleLine(reason, retryAt, now) {
    const base = reasonLabel(reason);
    const said = base.charAt(0).toUpperCase() + base.slice(1);
    if (!retryAt || retryAt <= now) return said;
    const mins = Math.max(1, Math.round((retryAt - now) / 60000));
    return `${said} — retrying in ${mins} min`;
  }

  /**
   * The identity tag on a wing chip: the label that makes "73%" mean
   * something at a glance. "5h" is the rolling session, "7d" the all-models
   * week, and a model's own weekly limit wears its monogram.
   */
  function wingTag(gauge) {
    if (!gauge) return '';
    if (gauge.kind === 'session') return '5h';
    if (gauge.kind === 'weekly') return '7d';
    // Model names are short ("Opus", "Fable"): say the name. Only a long
    // one falls back to its monogram — a chip is not a marquee.
    const name = String(gauge.model || '').trim();
    if (name && name.length <= 6) return name;
    if (gauge.monogram) return gauge.monogram;
    return name ? name[0].toUpperCase() : '?';
  }

  /**
   * Which two gauges the wings show: left is always the 5-hour session (the
   * one that cuts you off mid-task), right is the binding limit — the one
   * flagged active, or failing that the fullest of the rest.
   */
  function wingsModel(gauges) {
    if (!gauges || !gauges.length) return null;
    const left = gauges.find((g) => g.kind === 'session') || gauges[0];
    const rest = gauges.filter((g) => g !== left);
    const right = rest.find((g) => g.active) ||
      rest.slice().sort((a, b) => b.percent - a.percent)[0] || null;
    return { left, right };
  }

  return {
    tone, rowLabel, timeOptions, resetLabel, reasonLabel, staleLine,
    wingsModel, wingTag, ceilingNote, rateLine, isCredentialProblem
  };
}));
