'use strict';
/* The settings file. Reading it is easy; the job is making sure nothing
   invalid, contradictory, or obsolete can survive in it. */

const assert = require('assert');
const C = require('../src/config');
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok  ' + name); };

test('an empty or missing file is just the defaults', () => {
  assert.deepStrictEqual(C.sanitize({}).config, C.DEFAULTS);
  assert.deepStrictEqual(C.sanitize(null).config, C.DEFAULTS);
  assert.deepStrictEqual(C.sanitize('nonsense').config, C.DEFAULTS);
  assert.deepStrictEqual(C.sanitize([1, 2]).config, C.DEFAULTS);
});

test('a valid setting is kept, and the file stays minimal', () => {
  const { config, file } = C.sanitize({ wings: true });
  assert.strictEqual(config.wings, true);
  assert.strictEqual(config.refreshSeconds, 120, 'the rest comes from defaults');
  assert.deepStrictEqual(file, { wings: true },
    'a one-key file must not become a dump of every default');
});

test('auto-open is one choice: chain and a time cannot both survive', () => {
  // The bug this exists to prevent: a click set the time while chain stayed
  // on. Chain wins, so the time sat in the file forever looking applied.
  const { config, file, dropped } = C.sanitize({ primeChain: true, primeAt: ['10:00'] });
  assert.strictEqual(config.primeChain, true);
  assert.deepStrictEqual(config.primeAt, [], 'the contradiction must not survive');
  assert.strictEqual('primeAt' in file, false, 'and must be removed from the file');
  assert.ok(dropped.some((d) => d.startsWith('primeAt')), 'and be reported, not silently dropped');
});

test('the notched override is a boolean or it is nothing', () => {
  assert.strictEqual(C.sanitize({ notched: true }).config.notched, true);
  assert.strictEqual(C.sanitize({ notched: false }).config.notched, false,
    'false is a real answer, not an unset one');
  const bad = C.sanitize({ notched: 'yes' });
  assert.strictEqual(bad.config.notched, null, 'anything else means detect by shape');
  assert.ok(bad.dropped.includes('notched'), 'and is reported, not silently eaten');
});

test('a time alone, or chain alone, is untouched', () => {
  assert.deepStrictEqual(C.sanitize({ primeAt: ['08:00'] }).file, { primeAt: ['08:00'] });
  assert.deepStrictEqual(C.sanitize({ primeChain: true }).file, { primeChain: true });
  assert.deepStrictEqual(C.sanitize({ primeChain: false, primeAt: ['08:00'] }).file,
    { primeChain: false, primeAt: ['08:00'] }, 'chain off is not a contradiction');
});

test('obsolete keys are removed rather than carried forever', () => {
  const { config, file, dropped } = C.sanitize({ wings: true, verticalAnchor: 0.45, theme: 'ember' });
  assert.deepStrictEqual(file, { wings: true });
  assert.deepStrictEqual(dropped.sort(), ['theme', 'verticalAnchor']);
  assert.strictEqual('theme' in config, false);
});

test('a wrong type falls back to the default and is reported', () => {
  // Each of these used to break something silently: a non-string shortcut
  // aborted startup, a non-numeric interval stopped all refreshing.
  const bad = {
    shortcut: true, refreshSeconds: '2 minutes', alertAt: 'lots',
    primeAt: 'morning', notchWidth: {}, timeFormat: 'twelve',
    externalDisplays: 'maybe', primeModel: 'rm -rf /'
  };
  const { config, dropped } = C.sanitize(bad);
  assert.strictEqual(config.shortcut, C.DEFAULTS.shortcut);
  assert.strictEqual(config.refreshSeconds, 120);
  assert.deepStrictEqual(config.alertAt, [80, 95]);
  assert.deepStrictEqual(config.primeAt, []);
  assert.strictEqual(config.notchWidth, null);
  assert.strictEqual(config.timeFormat, 'auto');
  assert.strictEqual(config.externalDisplays, 'island');
  assert.strictEqual(config.primeModel, 'haiku', 'a model name reaches execFile');
  assert.strictEqual(dropped.length, 8, 'every rejection is reported');
});

test('partly-valid lists keep the good entries', () => {
  assert.deepStrictEqual(C.sanitize({ alertAt: [80, 'x', 95, 200, -1] }).config.alertAt, [80, 95]);
  assert.deepStrictEqual(C.sanitize({ primeAt: ['08:00', '25:00', 'noon'] }).config.primeAt, ['08:00']);
  assert.deepStrictEqual(C.sanitize({ primeDays: [1, 2, 9, 'x'] }).config.primeDays, [1, 2]);
});

test('an out-of-range number is refused, not clamped into nonsense', () => {
  assert.strictEqual(C.sanitize({ refreshSeconds: 1 }).config.refreshSeconds, 120);
  assert.strictEqual(C.sanitize({ refreshSeconds: 1e9 }).config.refreshSeconds, 120);
  assert.strictEqual(C.sanitize({ notchWidth: 99999 }).config.notchWidth, 600, 'width is capped');
  assert.strictEqual(C.sanitize({ notchWidth: -5 }).config.notchWidth, null);
});

test('__proto__ in the file cannot reach Object.prototype', () => {
  const { config } = C.sanitize(JSON.parse('{"__proto__":{"polluted":1},"wings":true}'));
  assert.strictEqual({}.polluted, undefined);
  assert.strictEqual(config.wings, true);
});

test('wingSources: known names only, canonical order, at most three', () => {
  assert.deepStrictEqual(C.sanitize({ wingSources: ['weekly', 'session'] }).config.wingSources,
    ['session', 'weekly'], 'ordered here, so the chips never swap sides later');
  assert.deepStrictEqual(C.sanitize({ wingSources: ['session', 'session'] }).config.wingSources,
    ['session'], 'the same limit twice is one chip, not two');
  assert.deepStrictEqual(C.sanitize({ wingSources: ['nonsense'] }).config.wingSources,
    C.DEFAULTS.wingSources, 'an unreadable list falls back to the default, not an empty band');
  assert.deepStrictEqual(C.sanitize({ wingSources: 'weekly' }).config.wingSources,
    C.DEFAULTS.wingSources);
});

test('the retired "auto" source is migrated, not reported as debris', () => {
  const only = C.sanitize({ wingSources: ['auto'] });
  assert.deepStrictEqual(only.config.wingSources, C.DEFAULTS.wingSources,
    'a band that asked only for auto keeps a band');
  assert.deepStrictEqual(only.dropped, [], 'retiring a setting is not the reader’s mistake');

  assert.deepStrictEqual(C.sanitize({ wingSources: ['session', 'auto'] }).config.wingSources,
    ['session'], 'alongside a real limit, auto simply falls away');
});

test('the old wingCount is migrated, not treated as debris', () => {
  const two = C.sanitize({ wingCount: 2 });
  assert.deepStrictEqual(two.config.wingSources, ['session', 'weekly'],
    'a file that asked for two chips keeps showing two');
  assert.deepStrictEqual(two.dropped, [], 'a rename is not something to report');
  assert.strictEqual('wingCount' in two.file, false, 'and the old key does not survive');

  assert.deepStrictEqual(C.sanitize({ wingCount: 1 }).config.wingSources, ['session']);
  // An explicit new setting wins over the old one, whichever order they sit in.
  assert.deepStrictEqual(
    C.sanitize({ wingCount: 2, wingSources: ['weekly'] }).config.wingSources, ['weekly']);
  assert.ok(C.sanitize({ wingCount: 7 }).dropped.some((d) => d.startsWith('wingCount')),
    'an unreadable count is still reported');
});

test('toggling a source never empties the band', () => {
  assert.deepStrictEqual(C.toggleSource(['session'], 'weekly'), ['session', 'weekly']);
  assert.deepStrictEqual(C.toggleSource(['session', 'weekly'], 'weekly'), ['session']);
  assert.deepStrictEqual(C.toggleSource(['session'], 'nonsense'), ['session']);
  assert.deepStrictEqual(C.toggleSource(null, 'weekly'), ['session', 'weekly'],
    'an unreadable list is the default, and the click lands on top of it');
  assert.deepStrictEqual(C.toggleSource(['model', 'session'], 'weekly'),
    ['session', 'weekly', 'model'], 'order is the band’s, not the click’s');
});

test('a click only ever changes the source it lands on', () => {
  // Turning off the last one used to substitute another source, which lit a
  // control the reader never touched. It is refused instead, and greyed.
  assert.deepStrictEqual(C.toggleSource(['session'], 'session'), ['session'],
    'the last source standing cannot be turned off');
  assert.deepStrictEqual(C.toggleSource(['model'], 'model'), ['model']);
  const full = ['session', 'weekly', 'model'];
  assert.deepStrictEqual(C.toggleSource(full, 'weekly'), ['session', 'model'],
    'a full band can still be emptied out one at a time');
});

test('a clean file is reported as needing no change', () => {
  const { file, dropped } = C.sanitize({ wings: true, primeAt: ['08:00'] });
  assert.deepStrictEqual(dropped, [], 'nothing to clean means nothing to rewrite');
  assert.deepStrictEqual(file, { wings: true, primeAt: ['08:00'] });
});

console.log(`\n${passed} config tests passed`);
