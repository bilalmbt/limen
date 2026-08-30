'use strict';
/* The sign-in watcher, driven with fake reads, a fake fs.watch and real
   timers at test pace. What matters: it notices a login fast, exactly once,
   costs nothing while the account is healthy, and cannot crash the app when
   watching is impossible. */

const assert = require('assert');
const { createCredWatch } = require('../src/credwatch');

let passed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A watcher harness: counts reads, captures the fs listener, records fires. */
function rig(overrides = {}) {
  const state = {
    problem: true,
    usable: false,
    token: 't',
    reads: 0,
    fired: 0,
    listener: null,
    closed: false,
    watchThrows: false
  };
  const watch = (dir, listener) => {
    if (state.watchThrows) throw new Error('no such directory');
    state.listener = listener;
    return { close: () => { state.closed = true; }, on: () => {} };
  };
  state.watcher = createCredWatch(Object.assign({
    read: async () => { state.reads++; return state.usable ? { accessToken: state.token } : null; },
    looksUsable: (cred) => Boolean(cred && cred.accessToken),
    isProblem: () => state.problem,
    onUsable: () => { state.fired++; },
    watch,
    dir: '/nowhere/.claude',
    file: '.credentials.json',
    recheckMs: 20,
    fastMs: 10,
    fastWindowMs: 1000,
    cooldownMs: 10000,
    debounceMs: 10
  }, overrides));
  return state;
}

(async () => {
  const test = async (name, fn) => { await fn(); passed++; console.log('  ok  ' + name); };

  await test('the heartbeat notices a login, and fires exactly once', async () => {
    const r = rig();
    r.watcher.start();
    await sleep(70);
    assert.strictEqual(r.fired, 0, 'unusable credentials fire nothing');
    assert.ok(r.reads >= 1, 'but they are being re-read');
    r.usable = true;
    await sleep(90);
    assert.strictEqual(r.fired, 1, 'one landing, one verification — the fingerprint holds the rest');
    r.watcher.stop();
  });

  await test('a token that looks usable but keeps failing is probed once, not per beat', async () => {
    // The revoked-token stalemate: the credentials look fine locally while
    // every fetch with them dies. Fired on the standing state, this would
    // be an API call per heartbeat — a 429 factory.
    const r = rig({ cooldownMs: 0 });
    r.usable = true;
    r.watcher.start();
    await sleep(120);
    assert.ok(r.reads >= 3, 'the watcher keeps looking');
    assert.strictEqual(r.fired, 1, 'but the same credential is only offered once');
    r.watcher.stop();
  });

  await test('a NEW token during a revoked stalemate is noticed', async () => {
    // The fix for a revoked token is a fresh login — which arrives as
    // usable-to-usable and never crosses an edge. The fingerprint sees it.
    const r = rig({ cooldownMs: 0 });
    r.usable = true;
    r.watcher.start();
    await sleep(60);
    assert.strictEqual(r.fired, 1);
    r.token = 'a-fresh-login';
    await sleep(60);
    assert.strictEqual(r.fired, 2, 'new credentials are worth exactly one more verification');
    r.watcher.stop();
  });

  await test('a healthy account costs nothing at all', async () => {
    const r = rig();
    r.problem = false;
    r.watcher.start();
    await sleep(90);
    assert.strictEqual(r.reads, 0, 'no subprocess, no file read, while nothing is wrong');
    r.watcher.stop();
  });

  await test('a write to the credentials file answers within the debounce', async () => {
    const r = rig({ recheckMs: 60000, fastMs: 60000 });
    r.usable = true;
    r.watcher.start();
    await sleep(30);
    assert.strictEqual(r.reads, 0, 'the slow heartbeat has not come round');
    r.listener('rename', '.credentials.json');
    await sleep(60);
    assert.strictEqual(r.fired, 1, 'the file event did not wait for any timer');
    r.watcher.stop();
  });

  await test('a burst of file events coalesces into one read', async () => {
    const r = rig({ recheckMs: 60000, fastMs: 60000, debounceMs: 30 });
    r.usable = true;
    r.watcher.start();
    for (let i = 0; i < 5; i++) r.listener('change', '.credentials.json');
    await sleep(90);
    assert.strictEqual(r.reads, 1, 'a login writes the file more than once; we read it once');
    r.watcher.stop();
  });

  await test('another file changing in ~/.claude is not a login', async () => {
    const r = rig({ recheckMs: 60000, fastMs: 60000 });
    r.usable = true;
    r.watcher.start();
    r.listener('change', 'settings.json');
    await sleep(50);
    assert.strictEqual(r.reads, 0);
    r.watcher.stop();
  });

  await test('expectLogin switches to the fast cadence at once', async () => {
    const r = rig({ recheckMs: 60000, fastMs: 15 });
    r.watcher.start();
    await sleep(60);
    assert.strictEqual(r.reads, 0, 'ambient pace is the slow one');
    r.watcher.expectLogin();
    await sleep(90);
    assert.ok(r.reads >= 2, 'a Terminal login is expected: listen hard');
    r.watcher.stop();
  });

  await test('an unwatchable directory degrades to the heartbeat, not a crash', async () => {
    const r = rig();
    r.watchThrows = true;
    r.usable = true;
    r.watcher.start();
    await sleep(70);
    assert.strictEqual(r.fired, 1, 'the heartbeat alone still notices the login');
    r.watcher.stop();
  });

  await test('stop() ends the watching, the timer and the watcher', async () => {
    const r = rig();
    r.watcher.start();
    r.watcher.stop();
    assert.strictEqual(r.closed, true, 'the fs watcher is closed');
    r.usable = true;
    if (r.listener) r.listener('change', '.credentials.json');
    await sleep(70);
    assert.strictEqual(r.reads, 0);
    assert.strictEqual(r.fired, 0);
  });

  console.log(`\n${passed} credwatch tests passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
