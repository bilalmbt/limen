'use strict';
/* What the island says. Wording and color are the interface's contract:
   the tones must match the data thresholds, and the words must tell the
   reader what to do, not what went wrong internally. */

const assert = require('assert');
const VM = require('../src/viewmodel');
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok  ' + name); };

test('tones follow the headroom scale: 50, 75, 90', () => {
  assert.strictEqual(VM.tone(0), 'ok');
  assert.strictEqual(VM.tone(49), 'ok');
  assert.strictEqual(VM.tone(50), 'warn');
  assert.strictEqual(VM.tone(74), 'warn');
  assert.strictEqual(VM.tone(75), 'hot');
  assert.strictEqual(VM.tone(89), 'hot');
  assert.strictEqual(VM.tone(90), 'crit');
  assert.strictEqual(VM.tone(100), 'crit');
});

test("the server's own grading outranks our thresholds", () => {
  assert.strictEqual(VM.tone(10, 'critical'), 'crit',
    'if Anthropic says critical, a low percentage does not overrule it');
  assert.strictEqual(VM.tone(10, 'warning'), 'hot');
  assert.strictEqual(VM.tone(10, 'normal'), 'ok', 'normal defers to the local scale');
  assert.strictEqual(VM.tone(95, 'normal'), 'crit');
  assert.strictEqual(VM.tone(10, 'something-new'), 'ok',
    'an unknown grade must not silently become an alarm');
});

test('rows are named for the reader, not the API', () => {
  assert.strictEqual(VM.rowLabel({ kind: 'session' }), 'Current session');
  assert.strictEqual(VM.rowLabel({ kind: 'weekly' }), 'All models');
  assert.strictEqual(VM.rowLabel({ kind: 'model', model: 'Fable' }), 'Fable, this week');
});

test('the session resets in relative time', () => {
  const now = Date.parse('2026-08-28T12:00:00Z');
  const g = (mins) => ({ resetStyle: 'relative', resetsAt: new Date(now + mins * 60000).toISOString() });
  assert.strictEqual(VM.resetLabel(g(51), now), 'resets in 51 min');
  assert.strictEqual(VM.resetLabel(g(0.4), now), 'resets any minute');
  assert.strictEqual(VM.resetLabel(g(125), now), 'resets in 2 h 5 min');
  assert.strictEqual(VM.resetLabel(g(120), now), 'resets in 2 h');
});

test('a reset in the past never shows a negative time', () => {
  const now = Date.parse('2026-08-28T12:00:00Z');
  const g = { resetStyle: 'relative', resetsAt: new Date(now - 60000).toISOString() };
  assert.strictEqual(VM.resetLabel(g, now), 'resets any minute');
});

test('weekly windows reset on a named day', () => {
  const now = Date.parse('2026-08-28T12:00:00Z');
  const g = { resetStyle: 'absolute', resetsAt: '2026-08-31T16:17:00Z' };
  const label = VM.resetLabel(g, now, 'en-US', '12');
  assert.ok(label.startsWith('resets Mon '), `got "${label}"`);
  assert.ok(/\d/.test(label), 'no time in the label');
});

test('a missing or unreadable reset date yields no label, not garbage', () => {
  assert.strictEqual(VM.resetLabel({ resetStyle: 'relative' }, 0), '');
  assert.strictEqual(VM.resetLabel({ resetStyle: 'relative', resetsAt: 'not a date' }, 0), '');
});

test('failure reasons are diagnoses, and the button carries the action', () => {
  assert.strictEqual(VM.reasonLabel('token-expired'), 'Your Claude Code sign-in expired');
  assert.strictEqual(VM.reasonLabel('rate-limited'), 'Anthropic throttled the check');
  assert.ok(!/click|open Claude Code once/i.test(VM.reasonLabel('token-expired')),
    'the note must not repeat the instruction the button already gives');
  assert.strictEqual(VM.reasonLabel('never-seen-before'), 'never-seen-before',
    'an unknown reason must pass through, not vanish');
});

test('the status strip names the reason and the retry time', () => {
  const now = 0;
  assert.strictEqual(VM.staleLine('rate-limited', 8 * 60000, now),
    'Anthropic throttled the check — retrying in 8 min');
  assert.strictEqual(VM.staleLine('network', null, now), 'No connection');
  assert.ok(VM.staleLine('server', 20000, now).endsWith('retrying in 1 min'),
    'sub-minute retries round up, never to zero');
  assert.ok(!VM.staleLine('network', null, now).startsWith('stale'),
    'the amber dot and the header already say the numbers are old');
});

const BAND = [
  { id: 'session', kind: 'session', percent: 12 },
  { id: 'weekly', kind: 'weekly', percent: 40 },
  { id: 'model-opus', kind: 'model', model: 'Opus', percent: 91, active: true },
  { id: 'model-fable', kind: 'model', model: 'Fable', percent: 30 }
];
const ids = (units) => units.map((g) => g.id);

test('one source is one chip, on the indicator side', () => {
  const one = VM.wingsModel(BAND, ['weekly']);
  assert.deepStrictEqual(ids(one.left), []);
  assert.deepStrictEqual(ids(one.right), ['weekly']);
});

test('the model source takes the busiest model', () => {
  assert.deepStrictEqual(ids(VM.wingsModel(BAND, ['model']).right), ['model-opus'],
    'the flagged limit wins');
  const noFlag = VM.wingsModel([
    { id: 'session', kind: 'session', percent: 10 },
    { id: 'model-opus', kind: 'model', model: 'Opus', percent: 30 },
    { id: 'model-fable', kind: 'model', model: 'Fable', percent: 62 }
  ], ['model']);
  assert.deepStrictEqual(ids(noFlag.right), ['model-fable'], 'with nothing flagged, the fullest');
});

test('with no sources at all the band still says something true', () => {
  // Where a settings file naming the retired 'auto' source lands, too — and
  // it lands on exactly what auto used to mean.
  assert.deepStrictEqual(ids(VM.wingsModel(BAND).right), ['model-opus']);
  assert.deepStrictEqual(ids(VM.wingsModel(BAND, []).right), ['model-opus']);
  assert.deepStrictEqual(ids(VM.wingsModel(BAND, ['auto']).right), ['model-opus']);
});

test('the week can be asked for by name, even while a model is active', () => {
  // The whole point of the change: with a count, the active model took the
  // right chip and the all-models week could not be shown at all.
  const w = VM.wingsModel(BAND, ['session', 'weekly']);
  assert.deepStrictEqual(ids(w.left), ['session']);
  assert.deepStrictEqual(ids(w.right), ['weekly']);
});

test('a third limit rides in the right chip', () => {
  const w = VM.wingsModel(BAND, ['session', 'weekly', 'model']);
  assert.deepStrictEqual(ids(w.left), ['session']);
  assert.deepStrictEqual(ids(w.right), ['weekly', 'model-opus'],
    'the busiest model, sharing the chip with the week');
});

test('a named limit the account does not expose is dropped, not faked', () => {
  const noWeek = [
    { id: 'session', kind: 'session', percent: 40 },
    { id: 'model-opus', kind: 'model', model: 'Opus', percent: 70 }
  ];
  const w = VM.wingsModel(noWeek, ['session', 'weekly']);
  assert.deepStrictEqual(ids(w.left), [], 'one limit left: it sits on the right');
  assert.deepStrictEqual(ids(w.right), ['session']);

  // Ask only for limits this account has never heard of and the band still
  // says something true rather than going blank.
  const none = VM.wingsModel(noWeek, ['weekly']);
  assert.deepStrictEqual(ids(none.right), ['model-opus']);
});

test('wings: a single gauge fills one chip and leaves the other empty', () => {
  const w = VM.wingsModel([{ id: 'session', kind: 'session', percent: 40 }], ['session', 'weekly']);
  assert.deepStrictEqual(ids(w.left), []);
  assert.deepStrictEqual(ids(w.right), ['session']);
});

test('wings: no gauges, no wings, no crash', () => {
  assert.strictEqual(VM.wingsModel([]), null);
  assert.strictEqual(VM.wingsModel(null), null);
});

test('wing chips name what their number means, in words', () => {
  // "5h" and "7d" were our shorthand and nobody else's.
  assert.strictEqual(VM.wingTag({ kind: 'session' }), 'Session');
  assert.strictEqual(VM.wingTag({ kind: 'weekly' }), 'Week');
  assert.strictEqual(VM.wingTag({ kind: 'model', model: 'Fable', monogram: 'F' }), 'Fable',
    'a short model name is clearer than its initial');
  assert.strictEqual(VM.wingTag({ kind: 'model', model: 'Considerable', monogram: 'C' }), 'C',
    'a long model name falls back to its monogram — a chip is not a marquee');
  assert.strictEqual(VM.wingTag(null), '');
});

test('the pace line speaks only when the quota runs out first', () => {
  const g = { id: 'session' };
  assert.strictEqual(
    VM.rateLine(g, { session: { exhaustsInMs: 40 * 60000, beforeReset: true } }),
    'full in ~40 min');
  assert.strictEqual(
    VM.rateLine(g, { session: { exhaustsInMs: 40 * 60000, beforeReset: false } }), '',
    'a limit that resets before you reach it needs no warning');
  assert.strictEqual(VM.rateLine(g, {}), '');
  assert.strictEqual(VM.rateLine(g, null), '');
  assert.strictEqual(
    VM.rateLine(g, { session: { exhaustsInMs: 130 * 60000, beforeReset: true } }),
    'full in ~2 h 10 min');
  assert.strictEqual(
    VM.rateLine(g, { session: { exhaustsInMs: 125 * 60000, beforeReset: true } }),
    'full in ~2 h', 'a stray five minutes is false precision on an estimate');
});

test('the panel says when 100% bills rather than stops', () => {
  // A red bar means "you will be cut off" — unless extra usage is on, where
  // it means "you are now paying". The same paint for both misleads exactly
  // the people spending money.
  assert.strictEqual(VM.ceilingNote({ ok: true, extraUsageEnabled: true }),
    'extra usage on — past 100% bills, it does not stop');
  assert.strictEqual(VM.ceilingNote({ ok: true, extraUsageEnabled: false }), '');
  assert.strictEqual(VM.ceilingNote({ ok: false, extraUsageEnabled: true }), '',
    'a failed read must not assert anything about billing');
  assert.strictEqual(VM.ceilingNote(null), '');
});

test('wing chips can carry how long is left', () => {
  const now = Date.parse('2026-08-28T12:00:00Z');
  const at = (mins) => ({ resetsAt: new Date(now + mins * 60000).toISOString() });
  assert.strictEqual(VM.wingReset(at(45), 'remaining', now), '45m left');
  assert.strictEqual(VM.wingReset(at(255), 'remaining', now), '4h15 left');
  assert.strictEqual(VM.wingReset(at(120), 'remaining', now), '2h left', 'a round hour drops the zeroes');
  assert.strictEqual(VM.wingReset(at(60 * 24 * 6), 'remaining', now), '6d left',
    'a weekly window is days, not a hundred-odd hours');
  assert.strictEqual(VM.wingReset(at(-5), 'remaining', now), 'resetting',
    'never a negative countdown');
});

test('wing chips can carry when the window ends instead', () => {
  const now = Date.parse('2026-08-28T12:00:00Z');
  const soon = { resetsAt: new Date(now + 3 * 3600000).toISOString() };
  const far = { resetsAt: new Date(now + 5 * 86400000).toISOString() };
  // Always HH:MM, whatever the panel is set to — no AM/PM to widen the strip.
  assert.match(VM.wingReset(soon, 'ends', now, 'en-US', '12'), /^resets \d{2}:\d{2}$/);
  assert.match(VM.wingReset(soon, 'ends', now, 'en-US', 'auto'), /^resets \d{2}:\d{2}$/);
  assert.match(VM.wingReset(far, 'ends', now, 'en-US', '24'), /^resets [A-Za-z]{3}/,
    'past today a clock time alone would be a lie by omission');
});

test('every reset note carries a verb', () => {
  // A bare "Fri" or "22:50" could be a reset, a start, or the clock — the
  // reader has to already know which, which is exactly what a new user does
  // not. Each form must say what happens.
  const now = Date.parse('2026-08-28T12:00:00Z');
  const soon = { resetsAt: new Date(now + 3 * 3600000).toISOString() };
  const far = { resetsAt: new Date(now + 5 * 86400000).toISOString() };
  for (const [g, mode] of [[soon, 'ends'], [far, 'ends'], [soon, 'remaining'], [far, 'remaining']]) {
    const text = VM.wingReset(g, mode, now, 'en-US', '24');
    assert.ok(/resets|left|resetting/.test(text), `"${text}" says nothing about what happens`);
  }
});

test('the reset note is off unless asked for, and never invents one', () => {
  const now = 0;
  const g = { resetsAt: new Date(now + 60000).toISOString() };
  assert.strictEqual(VM.wingReset(g, 'off', now), '');
  assert.strictEqual(VM.wingReset(g, undefined, now), '');
  assert.strictEqual(VM.wingReset({}, 'remaining', now), '', 'no reset date, no note');
  assert.strictEqual(VM.wingReset({ resetsAt: 'nonsense' }, 'remaining', now), '');
  assert.strictEqual(VM.wingReset(null, 'remaining', now), '');
});

test('only sign-in fixable reasons offer the sign-in path', () => {
  assert.strictEqual(VM.isCredentialProblem('no-credentials'), true);
  assert.strictEqual(VM.isCredentialProblem('token-expired'), true);
  assert.strictEqual(VM.isCredentialProblem('unauthorized'), true);
  assert.strictEqual(VM.isCredentialProblem('rate-limited'), false,
    'a 429 is not fixed by logging in again');
  assert.strictEqual(VM.isCredentialProblem('network'), false);
  assert.strictEqual(VM.isCredentialProblem(undefined), false);
});

test('an expired token on a live account is not an expired sign-in', () => {
  // The account is signed in; only the stored token went stale, and Claude
  // Code rotates that itself on its next call. Saying "your sign-in expired"
  // sends someone to a login screen they do not need.
  assert.strictEqual(VM.reasonLabel('token-expired', true),
    'Claude Code has not refreshed its token yet');
  assert.strictEqual(VM.reasonLabel('token-expired', false),
    'Your Claude Code sign-in expired', 'no account behind it: that IS a sign-in problem');
  assert.strictEqual(VM.reasonLabel('token-expired'),
    'Your Claude Code sign-in expired', 'unknown falls back to the cautious wording');
  assert.ok(VM.staleLine('token-expired', null, 0, true).startsWith('Claude Code has not'),
    'the status strip agrees with the label');
});

test('the button asks for a refresh when there is nothing to sign into', () => {
  assert.strictEqual(VM.signInAction('token-expired', null, true).label,
    'Refresh from Claude Code', 'signed in already — do not offer a sign-in');
  assert.strictEqual(VM.signInAction('token-expired', null, false).label,
    'Open Terminal to sign in', 'no live account: only a browser will do');
  assert.strictEqual(VM.signInAction('token-expired', null, null).label,
    'Sign in with Claude Code', 'unknown keeps the old wording');
});

test('the sign-in button offers what can actually be done', () => {
  // A headless nudge only fixes an expired token with a live refresh token.
  // With no credentials at all, nothing is refreshable and the only real
  // step is a browser login — so the button says so instead of waiting.
  assert.strictEqual(VM.signInAction('no-credentials').label, 'Open Terminal to sign in');
  assert.strictEqual(VM.signInAction('token-expired').label, 'Sign in with Claude Code',
    'an expired token IS worth a silent nudge');
  assert.strictEqual(VM.signInAction('unauthorized').label, 'Sign in with Claude Code');
});

test('the sign-in button reports every outcome, and locks while working', () => {
  assert.deepStrictEqual(VM.signInAction('token-expired', 'working'),
    { label: 'Signing in…', disabled: true }, 'no second click while one is running');
  assert.strictEqual(VM.signInAction('token-expired', 'needs-terminal').label,
    'Open Terminal to finish');
  assert.strictEqual(VM.signInAction('no-credentials', 'working').disabled, true,
    'status outranks the reason: a run in progress is a run in progress');
});

console.log(`\n${passed} viewmodel tests passed`);
