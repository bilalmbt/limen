'use strict';
/* The two panel controls, against a DOM small enough to reason about.
   Both bugs this file exists for were invisible to every other test: the
   renderer had no coverage at all, and both were about one control quietly
   standing on the other. */

const assert = require('assert');
const VM = require('../src/viewmodel');
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok  ' + name); };

/** Just enough DOM: class lists, children, and querySelector by class. */
function makeEl(className = '') {
  const el = {
    className,
    textContent: '',
    disabled: false,
    children: [],
    appendChild(child) { this.children.push(child); child.parent = this; return child; },
    remove() {
      if (!this.parent) return;
      this.parent.children = this.parent.children.filter((c) => c !== this);
      this.parent = null;
    },
    querySelector(sel) {
      const want = sel.replace('.', '');
      const hit = (n) => String(n.className).split(/\s+/).includes(want);
      const walk = (n) => {
        for (const c of n.children) {
          if (hit(c)) return c;
          const deep = walk(c);
          if (deep) return deep;
        }
        return null;
      };
      return walk(this);
    }
  };
  return el;
}

/* The two functions under test, transcribed from src/renderer/island.js.
   Transcription is a real risk, so each is kept to the shape of the
   original and the selectors are the point of the test. */
function syncSignIn(rowsEl, reason, signin, data) {
  const existing = rowsEl.querySelector('.btn-signin');
  if (!VM.isCredentialProblem(reason)) {
    if (existing) existing.remove();
    return;
  }
  const btn = existing || rowsEl.appendChild(makeEl('btn btn-signin'));
  const action = VM.signInAction(reason, signin, data);
  btn.textContent = action.label;
  btn.disabled = action.disabled;
}

function syncPrime(rowsEl, d, signin) {
  const existing = rowsEl.querySelector('.btn-prime');
  const busy = signin === 'priming';
  const show = (d.canPrime || busy) && !VM.isCredentialProblem(d.reason);
  if (!show) { if (existing) existing.remove(); return; }
  const btn = existing || rowsEl.appendChild(makeEl('btn btn-prime'));
  btn.textContent = busy ? 'Opening a session window…' : 'Open a session window';
}

const names = (rows) => rows.children.map((c) => c.className);

test('the sign-in button does not delete the prime button', () => {
  // `.btn` matched `btn btn-prime`. Every render with healthy data found the
  // prime button, decided it was a sign-in button that should not exist, and
  // removed it — after which syncPrime built a fresh one. A click landing in
  // that gap did nothing at all.
  const rows = makeEl('rows');
  syncPrime(rows, { canPrime: true, reason: null }, null);
  const before = rows.children[0];
  for (let render = 0; render < 5; render++) {
    syncSignIn(rows, null, null, {});
    syncPrime(rows, { canPrime: true, reason: null }, null);
  }
  assert.deepStrictEqual(names(rows), ['btn btn-prime']);
  assert.strictEqual(rows.children[0], before,
    'the same node survives every render — it is not destroyed and rebuilt');
});

test('a credential problem swaps prime for sign-in, and back', () => {
  const rows = makeEl('rows');
  syncPrime(rows, { canPrime: true, reason: null }, null);
  // Token expires. The prime button must go and the sign-in button appear —
  // in the same render, not one render each.
  syncSignIn(rows, 'token-expired', null, {});
  syncPrime(rows, { canPrime: true, reason: 'token-expired' }, null);
  assert.deepStrictEqual(names(rows), ['btn btn-signin'],
    'exactly one button, and it is the one that can help');

  syncSignIn(rows, null, null, {});
  syncPrime(rows, { canPrime: true, reason: null }, null);
  assert.deepStrictEqual(names(rows), ['btn btn-prime']);
});

test('the sign-in button relabels when only the status changed', () => {
  // The bug: with no gauges the render returned before syncSignIn, so a
  // signin message — which carries no data change — repainted nothing. The
  // button stayed on its first label through the entire flow.
  const rows = makeEl('rows');
  const data = { accountLive: true, windowOpen: true };
  syncSignIn(rows, 'token-expired', null, data);
  assert.strictEqual(rows.children[0].textContent, 'Refresh from Claude Code');

  syncSignIn(rows, 'token-expired', 'working', data);
  assert.strictEqual(rows.children[0].textContent, 'Signing in…');
  assert.strictEqual(rows.children[0].disabled, true);

  syncSignIn(rows, 'token-expired', 'needs-terminal', data);
  assert.strictEqual(rows.children[0].textContent, 'Open Terminal to finish');
  assert.strictEqual(rows.children[0].disabled, false, 'and it can be pressed');

  assert.strictEqual(rows.children.length, 1, 'one button throughout, not four');
});

test('a prime in flight does not remove the sign-in button', () => {
  const rows = makeEl('rows');
  syncSignIn(rows, 'token-expired', 'priming', {});
  syncPrime(rows, { canPrime: false, reason: 'token-expired' }, 'priming');
  assert.deepStrictEqual(names(rows), ['btn btn-signin'],
    'a credential problem outranks a prime: the prime cannot work anyway');
});

console.log(`\n${passed} renderer tests passed`);
