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

test('wings: session on the left, the binding limit on the right', () => {
  const gauges = [
    { id: 'session', kind: 'session', percent: 73 },
    { id: 'weekly', kind: 'weekly', percent: 21 },
    { id: 'model-fable', kind: 'model', model: 'Fable', percent: 52, active: true }
  ];
  const w = VM.wingsModel(gauges);
  assert.strictEqual(w.left.id, 'session');
  assert.strictEqual(w.right.id, 'model-fable', 'the active limit must win the right wing');
});

test('wings: with no active flag the fullest remaining gauge wins', () => {
  const w = VM.wingsModel([
    { id: 'session', kind: 'session', percent: 10 },
    { id: 'weekly', kind: 'weekly', percent: 21 },
    { id: 'model-opus', kind: 'model', model: 'Opus', percent: 94 }
  ]);
  assert.strictEqual(w.right.id, 'model-opus');
});

test('wings: a single gauge fills the left wing and leaves the right empty', () => {
  const w = VM.wingsModel([{ id: 'session', kind: 'session', percent: 40 }]);
  assert.strictEqual(w.left.id, 'session');
  assert.strictEqual(w.right, null);
});

test('wings: no gauges, no wings, no crash', () => {
  assert.strictEqual(VM.wingsModel([]), null);
  assert.strictEqual(VM.wingsModel(null), null);
});

test('wing chips name what their number means', () => {
  assert.strictEqual(VM.wingTag({ kind: 'session' }), '5h');
  assert.strictEqual(VM.wingTag({ kind: 'weekly' }), '7d');
  assert.strictEqual(VM.wingTag({ kind: 'model', model: 'Fable', monogram: 'F' }), 'Fable',
    'a short model name is clearer than its initial');
  assert.strictEqual(VM.wingTag({ kind: 'model', model: 'Extended', monogram: 'E' }), 'E',
    'a long model name falls back to its monogram — a chip is not a marquee');
  assert.strictEqual(VM.wingTag({ kind: 'model', model: 'opus' }), 'opus');
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

test('only sign-in fixable reasons offer the sign-in path', () => {
  assert.strictEqual(VM.isCredentialProblem('no-credentials'), true);
  assert.strictEqual(VM.isCredentialProblem('token-expired'), true);
  assert.strictEqual(VM.isCredentialProblem('unauthorized'), true);
  assert.strictEqual(VM.isCredentialProblem('rate-limited'), false,
    'a 429 is not fixed by logging in again');
  assert.strictEqual(VM.isCredentialProblem('network'), false);
  assert.strictEqual(VM.isCredentialProblem(undefined), false);
});

console.log(`\n${passed} viewmodel tests passed`);
