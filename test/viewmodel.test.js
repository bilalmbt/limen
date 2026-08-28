'use strict';
/* What the island says. Wording and color are the interface's contract:
   the tones must match the data thresholds, and the words must tell the
   reader what to do, not what went wrong internally. */

const assert = require('assert');
const VM = require('../src/viewmodel');
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok  ' + name); };

test('tones follow the headroom scale: 35, 70, 90', () => {
  assert.strictEqual(VM.tone(0), 'ok');
  assert.strictEqual(VM.tone(34), 'ok');
  assert.strictEqual(VM.tone(35), 'warn');
  assert.strictEqual(VM.tone(69), 'warn');
  assert.strictEqual(VM.tone(70), 'hot');
  assert.strictEqual(VM.tone(89), 'hot');
  assert.strictEqual(VM.tone(90), 'crit');
  assert.strictEqual(VM.tone(100), 'crit');
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

test('failure reasons are instructions where an instruction exists', () => {
  assert.strictEqual(VM.reasonLabel('token-expired'), 'open Claude Code once');
  assert.strictEqual(VM.reasonLabel('unauthorized'), 'open Claude Code once');
  assert.strictEqual(VM.reasonLabel('rate-limited'), 'rate-limited');
  assert.strictEqual(VM.reasonLabel('never-seen-before'), 'never-seen-before',
    'an unknown reason must pass through, not vanish');
});

test('the stale strip names the reason and the retry time', () => {
  const now = 0;
  assert.strictEqual(VM.staleLine('rate-limited', 8 * 60000, now),
    'stale · rate-limited · next try in 8 min');
  assert.strictEqual(VM.staleLine('network', null, now), 'stale · offline');
  assert.strictEqual(VM.staleLine('server', 20000, now),
    'stale · API unavailable · next try in 1 min', 'sub-minute retries round up, never to zero');
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
