'use strict';
/* Persisted state. Both fields exist because their absence was a bug: a
   restart used to reset the backoff, and to blank the widget. */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'island-state-'));
process.env.ISLAND_STATE_FILE = path.join(TMP, 'state.json');
const store = require('../src/state');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok  ' + name); };
const reading = (at) => ({ fetchedAt: at, gauges: [{ id: 'session', percent: 9 }] });

test('nothing stored yet is not an error', () => {
  assert.strictEqual(store.restoreLastGood(), null);
  assert.strictEqual(store.restoreFailures(), 0);
});

test('a recent reading comes back, so a restart shows numbers at once', () => {
  const now = Date.now();
  store.save({ lastGood: reading(now - 60000) });
  assert.ok(store.restoreLastGood(now), 'the reading was lost');
});

test('a reading older than a day is dropped rather than shown as current', () => {
  const now = Date.now();
  store.save({ lastGood: reading(now - store.MAX_AGE_MS - 1000) });
  assert.strictEqual(store.restoreLastGood(now), null);
});

test('an empty reading is never restored', () => {
  store.save({ lastGood: { fetchedAt: Date.now(), gauges: [] } });
  assert.strictEqual(store.restoreLastGood(), null);
});

test('the failure count survives, so a restart does not undo the backoff', () => {
  store.save({ failures: 3 });
  assert.strictEqual(store.restoreFailures(), 3);
});

test('a corrupted file does not bring the widget down', () => {
  fs.writeFileSync(process.env.ISLAND_STATE_FILE, '{ this is not json');
  assert.deepStrictEqual(store.read(), {});
  assert.strictEqual(store.restoreLastGood(), null);
  assert.strictEqual(store.restoreFailures(), 0);
});

test('saving merges rather than replacing', () => {
  store.write({});
  store.save({ failures: 2 });
  store.save({ alerts: { session: { window: 'w', level: 80 } } });
  const s = store.read();
  assert.strictEqual(s.failures, 2, 'the failure count was wiped by the second save');
  assert.ok(s.alerts.session);
});

test('keys from an older version are not carried forever', () => {
  store.write({});
  store.save({ failures: 1, verticalAnchor: 0.45, theme: 'ember' });
  const s = store.read();
  assert.strictEqual(s.failures, 1);
  assert.strictEqual('theme' in s, false, 'debris must not survive a save');
  assert.strictEqual('verticalAnchor' in s, false);
});

test('a merge still keeps every key the app does use', () => {
  store.write({});
  for (const key of store.KNOWN) store.save({ [key]: 'x' });
  const s = store.read();
  assert.deepStrictEqual(Object.keys(s).sort(), [...store.KNOWN].sort(),
    'the allow-list must not quietly drop something the app relies on');
});

fs.rmSync(TMP, { recursive: true, force: true });
test('a save leaves no temp file behind, and replaces atomically', () => {
  store.save({ failures: 3 });
  const dir = path.dirname(process.env.ISLAND_STATE_FILE);
  const strays = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepStrictEqual(strays, [], 'the temp file is renamed, not left');
  assert.strictEqual(store.read().failures, 3, 'and the content is there');
});

console.log(`\n${passed} state tests passed`);
