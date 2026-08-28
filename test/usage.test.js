'use strict';
/* Normalisation. The API answer varies from account to account; what matters
   is that a missing quota never turns into a displayed zero. */

const assert = require('assert');
const { normalize, planLabel } = require('../src/usage');
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok  ' + name); };

const base = {
  five_hour: { utilization: 73.4, resets_at: '2026-08-28T13:39:59Z' },
  seven_day: { utilization: 12, resets_at: '2026-09-02T09:59:59Z' },
  seven_day_opus: null,
  seven_day_sonnet: null,
  limits: [],
  extra_usage: { is_enabled: false }
};

test('percentages are rounded and clamped', () => {
  const r = normalize({ ...base, five_hour: { utilization: 73.4, resets_at: null } });
  assert.strictEqual(r.gauges[0].percent, 73);
  const over = normalize({ ...base, five_hour: { utilization: 140, resets_at: null } });
  assert.strictEqual(over.gauges[0].percent, 100);
});

test('a missing quota produces no ring', () => {
  const r = normalize({ ...base, seven_day: null });
  assert.strictEqual(r.gauges.filter((x) => x.id === 'weekly').length, 0);
  assert.ok(r.gauges.every((x) => x.percent !== null));
});

test('every model gets its own ring', () => {
  const r = normalize({
    ...base,
    seven_day_opus: { utilization: 94, resets_at: '2026-09-02T09:59:59Z' },
    seven_day_sonnet: { utilization: 30, resets_at: '2026-09-02T09:59:59Z' }
  });
  const models = r.gauges.filter((x) => x.kind === 'model').map((x) => x.model);
  assert.deepStrictEqual(models, ['Opus', 'Sonnet']);
  assert.deepStrictEqual(r.gauges.filter((x) => x.kind === 'model').map((x) => x.monogram), ['O', 'S']);
});

test('a model exposed through limits[] is picked up', () => {
  const r = normalize({
    ...base,
    limits: [{ kind: 'weekly_scoped', percent: 6, resets_at: '2026-09-02T09:59:59Z',
      is_active: false, scope: { model: { display_name: 'Fable' } } }]
  });
  const fable = r.gauges.find((x) => x.model === 'Fable');
  assert.ok(fable, 'Fable missing');
  assert.strictEqual(fable.percent, 6);
});

test('a model present in both shapes appears once', () => {
  const r = normalize({
    ...base,
    seven_day_opus: { utilization: 94, resets_at: null },
    limits: [{ kind: 'weekly_scoped', percent: 94, resets_at: null, is_active: true,
      scope: { model: { display_name: 'Opus' } } }]
  });
  assert.strictEqual(r.gauges.filter((x) => x.model === 'Opus').length, 1);
});

test('the biting limit is flagged', () => {
  const r = normalize({
    ...base,
    limits: [{ kind: 'weekly_all', percent: 12, is_active: true, resets_at: null, scope: null }]
  });
  assert.strictEqual(r.gauges.find((x) => x.id === 'weekly').active, true);
  assert.strictEqual(r.gauges.find((x) => x.id === 'session').active, false);
});

test('an empty response does not break normalisation', () => {
  const r = normalize({});
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.gauges, []);
});

const { reasonFor } = require('../src/usage');

test('a failure is named for what it is, not blamed on the network', () => {
  assert.strictEqual(reasonFor({ status: 429 }), 'rate-limited');
  assert.strictEqual(reasonFor({ status: 401 }), 'unauthorized');
  assert.strictEqual(reasonFor({ status: 403 }), 'unauthorized');
  assert.strictEqual(reasonFor({ status: 503 }), 'server');
  assert.strictEqual(reasonFor({}), 'network', 'only a real transport failure is a network error');
});

test('the plan is read from the credentials, in words a person would use', () => {
  const cred = (subscriptionType, rateLimitTier) => ({ subscriptionType, rateLimitTier });
  assert.strictEqual(planLabel(cred('max', 'default_claude_max_20x')), 'Max 20x');
  assert.strictEqual(planLabel(cred('max', 'default_claude_max_5x')), 'Max 5x');
  assert.strictEqual(planLabel(cred('pro')), 'Pro');
  assert.strictEqual(planLabel(cred('MAX', 'default_claude_max_20x')), 'Max 20x', 'case is theirs, not ours');
});

test('an unreadable plan is shown as nothing, never as its codename', () => {
  // Both fields are Claude Code's own vocabulary and can change without
  // notice. Printing "default_claude_max_20x" at someone because we could
  // not parse it is worse than staying quiet.
  const cred = (subscriptionType, rateLimitTier) => ({ subscriptionType, rateLimitTier });
  assert.strictEqual(planLabel(cred('max', 'some_tier_we_have_never_seen')), 'Max',
    'the plan survives even when the multiplier does not');
  assert.strictEqual(planLabel(cred('something_new', 'default_claude_max_20x')), '',
    'an unknown plan says nothing, and takes the multiplier down with it');
  assert.strictEqual(planLabel(cred('pro', 'default_claude_max_20x')), 'Pro',
    'only Max is sold in multiples; a 5x anywhere else is our misreading');
  assert.strictEqual(planLabel({}), '', 'a token-only setup has no plan to report');
  assert.strictEqual(planLabel(null), '');
});

console.log(`\n${passed} normalisation tests passed`);
