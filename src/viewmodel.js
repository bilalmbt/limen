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
    // 'numeric' for the 12-hour clock, which nobody pads: en-US writes
    // "7:05 PM", and '2-digit' produced "07:05 PM". The 24-hour clock does
    // pad, and 'auto' hands the whole question to the locale — which is the
    // point of auto, and why hour12 is not passed there.
    if (setting === '12') return { hour: 'numeric', minute: '2-digit', hour12: true };
    if (setting === '24') return { hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23' };
    return { hour: 'numeric', minute: '2-digit' };
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
    // A restored reading can be up to a day old, and its weekly reset may
    // already have passed — "resets Fri 18:00" on Saturday is a date, not a
    // forecast. The relative branch has always clamped; this one did not.
    if (at <= now) return 'resets any minute';
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

  /**
   * May the numbers be shown as though they were current?
   *
   * A transient failure — no network, a throttle — leaves the last reading
   * true and about to be true again, so it stays on screen with the reason
   * beneath it. A credential failure is different in kind: the app cannot
   * read the account at all, the figures are from whenever it last could,
   * and nothing about "3%" looks fifteen hours old. Presented plainly beside
   * "Claude Code isn't signed in", they read as a contradiction — which is
   * exactly what a person reports when they see it.
   */
  function numbersAreCurrent(data) {
    if (!data) return false;
    return !isCredentialProblem(data.reason);
  }

  /** Reasons a fresh Claude Code sign-in would fix. */
  function isCredentialProblem(reason) {
    return reason === 'no-credentials' || reason === 'token-expired' || reason === 'unauthorized';
  }

  /** Why the numbers are stale, in words a human can act on. */
  function reasonLabel(reason, accountLive) {
    // An expired token on a live account is not an expired sign-in, and
    // saying so sends people to a login screen they do not need. Claude Code
    // rotates this token on its own; all that is missing is a call to make
    // it happen, which is one click away.
    if (reason === 'token-expired' && accountLive === true) {
      return 'Claude Code has not refreshed its token yet';
    }
    // Claude Code is signed in and we still found nothing. The read failed,
    // not the account — a locked Keychain, a denied prompt, an entry under
    // another name. Saying "isn't signed in" sends someone to log in again,
    // which produces the same nothing, which is a loop with no exit.
    if (reason === 'no-credentials' && accountLive === true) {
      return 'Claude Code is signed in, but Limen could not read its token';
    }
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
  function staleLine(reason, retryAt, now, accountLive) {
    const base = reasonLabel(reason, accountLive);
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
    // Words, not our shorthand. "5h" meant the rolling five-hour window to
    // us and nothing at all to anyone reading it for the first time — and
    // these are the names the panel already uses, so the two now agree.
    if (gauge.kind === 'session') return 'Session';
    if (gauge.kind === 'weekly') return 'Week';
    // Model names are short ("Opus", "Fable"): say the name. Only a long
    // one falls back to its monogram — a chip is not a marquee.
    const name = String(gauge.model || '').trim();
    if (name && name.length <= 8) return name;
    if (gauge.monogram) return gauge.monogram;
    return name ? name[0].toUpperCase() : '?';
  }

  /**
   * The compact reset note on a wing chip.
   *
   * Two forms, because they answer different questions and people want
   * different ones: "how long have I got" (remaining) and "when does this
   * end" (ends). A menu bar has room for a few characters, not a sentence,
   * so a weekly window reads as a weekday or a day count rather than a date.
   *
   * @param {'off'|'remaining'|'ends'} mode
   */
  function wingReset(gauge, mode, now, locale, timeFormat) {
    if (mode !== 'remaining' && mode !== 'ends') return '';
    if (!gauge || !gauge.resetsAt) return '';
    const at = Date.parse(gauge.resetsAt);
    if (!Number.isFinite(at)) return '';

    // Every form carries a verb. A bare "Fri" or "22:50" could be a reset,
    // a start, or the clock — the reader has to already know which.
    if (mode === 'ends') {
      const d = new Date(at);
      // Past today, a clock time is a lie by omission — say which day.
      if ((at - now) >= 20 * 3600 * 1000) {
        return `resets ${d.toLocaleDateString(locale || undefined, { weekday: 'short' })}`;
      }
      // Always 24-hour here, whatever the panel is set to: "10:49 PM" is
      // eight characters and a space in a strip measured in millimetres,
      // and it is the only place in the app where width beats familiarity.
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      return `resets ${hh}:${mm}`;
    }

    const mins = Math.round((at - now) / 60000);
    if (mins <= 0) return 'resetting';
    if (mins < 60) return `${mins}m left`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h < 24) return m ? `${h}h${String(m).padStart(2, '0')} left` : `${h}h left`;
    return `${Math.round(h / 24)}d left`;
  }

  /** The limit that will stop you first: flagged active, else the fullest. */
  function binding(pool) {
    return pool.slice().sort((a, b) =>
      (b.active === true) - (a.active === true) || b.percent - a.percent)[0] || null;
  }

  /**
   * What the band shows, from the limits the reader asked for by name.
   *
   * The setting used to be a COUNT, which said how many chips would appear
   * and nothing about what was in them — so on an account where a model's
   * week is the active limit, the all-models week could never be shown at
   * all. Sources say which limits; the number of chips is what follows.
   *
   *   'session'  the rolling five-hour window
   *   'weekly'   the quota across all models
   *   'model'    the busiest model's own week
   *
   * The notch has two sides, so a third source rides in the right chip
   * beside the second: the first source takes the left, the rest share the
   * right. One source alone sits on the right, where the menu bar keeps its
   * other indicators.
   *
   * @param {string[]} sources  in draw order; empty falls back to the binding limit
   * @returns {{left: object[], right: object[]}|null}
   */
  function wingsModel(gauges, sources) {
    if (!gauges || !gauges.length) return null;
    const list = Array.isArray(sources) ? sources : [];

    const picked = [];
    const taken = new Set();
    const take = (g) => {
      if (!g || taken.has(g.id)) return;
      taken.add(g.id);
      picked.push(g);
    };
    for (const name of list) {
      if (name === 'session') take(gauges.find((g) => g.kind === 'session'));
      else if (name === 'weekly') take(gauges.find((g) => g.kind === 'weekly'));
      else if (name === 'model') take(binding(gauges.filter((g) => g.kind === 'model')));
    }

    // Every named limit can be absent: accounts differ, and the API only
    // reports the quotas it actually enforces. Rather than an empty band —
    // which reads as a bug — fall back to the one that will stop you first.
    // This is also where a settings file still naming the retired 'auto'
    // source lands, and it lands on exactly what 'auto' used to mean.
    if (!picked.length) take(binding(gauges));
    if (!picked.length) return null;

    if (picked.length === 1) return { left: [], right: picked };
    return { left: picked.slice(0, 1), right: picked.slice(1) };
  }

  /**
   * What the menu bar shows beside the tray icon.
   *
   * The percentage is the point of the app, but only while it means
   * something. A stale reading is a number from a window that may have
   * reset hours ago — after an overnight restore it is last night's — so a
   * credential failure says what is wrong instead of showing a figure that
   * looks live. A stale reading with a merely transient failure (network,
   * a throttle) keeps its number, because that one really is the last true
   * value and is about to be true again.
   *
   * @param {{percent?: number}|null} session
   */
  function trayTitle(session, { signingIn, reason, stale } = {}) {
    if (signingIn) return 'signing in…';
    if (isCredentialProblem(reason)) return 'sign in';
    if (!session || typeof session.percent !== 'number') return '–';
    return stale === true ? `${session.percent}%*` : `${session.percent}%`;
  }

  /**
   * What the sign-in button should say, and whether it can be pressed.
   *
   * The headless nudge fixes exactly one thing: an expired access token
   * with a valid refresh token, which Claude Code renews on its own. With
   * NO credentials there is nothing to refresh — logging in needs a browser
   * and a person — so offering "Sign in" and then waiting is offering to do
   * something that cannot be done. The button names the real next step
   * instead, and naming it is also what makes opening Terminal acceptable:
   * a button that says it will open Terminal may open Terminal.
   */
  function signInAction(reason, status, ctx) {
    const { accountLive, windowOpen } = ctx || {};
    if (status === 'working') return { label: 'Signing in…', disabled: true };
    if (status === 'needs-terminal') return { label: 'Open Terminal to finish', disabled: false };
    // A fresh login is still the best move even when the account is live:
    // it rewrites the Keychain entry, which is what an unreadable one needs.
    if (reason === 'no-credentials' && accountLive === true) {
      return { label: 'Open Terminal to sign in again', disabled: false };
    }
    if (reason === 'no-credentials' || accountLive === false) {
      return { label: 'Open Terminal to sign in', disabled: false };
    }
    // Signed in already: the button's job is to make Claude Code rotate a
    // token it is perfectly entitled to rotate, so it should not be offering
    // a sign-in to someone who is signed in.
    //
    // But the only way to make it rotate one is a real message, and a real
    // message STARTS THE FIVE-HOUR WINDOW — the boundary this app has a whole
    // scheduling feature to help people place on purpose. Inside a window
    // already running it costs nothing and stays quiet. Outside one, the
    // button says what it will do, because a widget that starts your clock
    // without saying so is worse than one that asks.
    if (accountLive === true) {
      return windowOpen
        ? { label: 'Refresh from Claude Code', disabled: false }
        : { label: 'Refresh — starts a 5-hour window', disabled: false };
    }
    return { label: 'Sign in with Claude Code', disabled: false };
  }

  return {
    tone, rowLabel, timeOptions, resetLabel, reasonLabel, staleLine, signInAction, trayTitle,
    numbersAreCurrent,
    wingsModel, wingTag, wingReset, ceilingNote, rateLine, isCredentialProblem
  };
}));
