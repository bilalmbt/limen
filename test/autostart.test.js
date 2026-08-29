'use strict';
/* The login item. This file had no tests, and the one thing in it that
   parses someone else's output was reading a format Apple stopped printing
   around macOS 11 — so the checkbox could not be unticked. */

const assert = require('assert');
const A = require('../src/autostart');
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok  ' + name); };

const LABEL = 'io.moobytes.limen';

// Real output, current macOS (Darwin 25.6).
const MODERN = `
	disabled services = {
		"com.clawdbot.gateway" => enabled
		"${LABEL}" => disabled
		"com.apple.ManagedClientAgent.enrollagent" => disabled
	}
`;
// Real output, macOS 11 and earlier, where "true" meant disabled.
const LEGACY = `
	disabled services = {
		"com.example.other" => false
		"${LABEL}" => true
	}
`;

test('the current format is read the right way round', () => {
  assert.strictEqual(A.parseDisabled(MODERN, LABEL), false,
    '"=> disabled" means the login item is off');
  assert.strictEqual(A.parseDisabled(MODERN.replace('"' + LABEL + '" => disabled',
    '"' + LABEL + '" => enabled'), LABEL), true);
});

test('the older format still reads correctly', () => {
  // The bug was reading ONLY this one, on a system that no longer emits it.
  assert.strictEqual(A.parseDisabled(LEGACY, LABEL), false, '"=> true" means disabled');
  assert.strictEqual(A.parseDisabled(LEGACY.replace('"' + LABEL + '" => true',
    '"' + LABEL + '" => false'), LABEL), true);
});

test('a service absent from the disabled list is enabled', () => {
  assert.strictEqual(A.parseDisabled(MODERN, 'io.moobytes.something-else'), true);
  assert.strictEqual(A.parseDisabled('', LABEL), true);
  assert.strictEqual(A.parseDisabled(null, LABEL), true);
});

test('a format we do not recognise says so rather than guessing', () => {
  // Reporting "enabled" for an answer we cannot read is how the checkbox
  // came to lie in the first place; null greys the item out instead.
  assert.strictEqual(A.parseDisabled(`"${LABEL}" => perhaps`, LABEL), null);
  assert.strictEqual(A.parseDisabled(`"${LABEL}"`, LABEL), null, 'no arrow, no answer');
});

test('the label must match exactly, not by prefix', () => {
  const other = `\t\t"${LABEL}.helper" => disabled\n`;
  assert.strictEqual(A.parseDisabled(other, LABEL), true,
    'a different service being disabled says nothing about ours');
});

console.log(`\n${passed} autostart tests passed`);
