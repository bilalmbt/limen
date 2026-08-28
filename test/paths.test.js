'use strict';
/* The rename's one-shot move. It runs once on one machine and is never
   exercised again, which is exactly the code that has to be right first
   time — a settings directory is not something you get to lose twice. */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok  ' + name); };

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'limen-paths-'));
let n = 0;

/** A fresh pair of directory names, and paths.js loaded against them. */
function load({ legacy, current }) {
  const box = path.join(ROOT, `case-${n++}`);
  const LEGACY_DIR = path.join(box, 'claude-island');
  const DIR = path.join(box, 'limen');
  const write = (dir, body) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), body);
  };
  if (legacy) write(LEGACY_DIR, legacy);
  if (current) write(DIR, current);

  process.env.LIMEN_CONFIG_DIR = DIR;
  process.env.LIMEN_LEGACY_DIR = LEGACY_DIR;
  delete require.cache[require.resolve('../src/paths')];
  const paths = require('../src/paths');
  const read = (dir) => {
    try { return fs.readFileSync(path.join(dir, 'config.json'), 'utf8'); } catch (_) { return null; }
  };
  return { paths, DIR, LEGACY_DIR, read };
}

test('settings written under the old name are carried over', () => {
  const c = load({ legacy: '{"wings":true}' });
  assert.strictEqual(c.read(c.DIR), '{"wings":true}', 'the file moved, contents intact');
  assert.strictEqual(fs.existsSync(c.LEGACY_DIR), false, 'and the old directory is gone');
});

test('an existing directory is never merged into', () => {
  // Half-migrated — new settings beside an old state file — is a shape
  // nothing else in the app expects, so the move is all or nothing.
  const c = load({ legacy: '{"wings":true}', current: '{"wings":false}' });
  assert.strictEqual(c.read(c.DIR), '{"wings":false}', 'what was already there wins');
  assert.strictEqual(c.read(c.LEGACY_DIR), '{"wings":true}', 'and the old is left untouched');
});

test('a first run on a clean machine moves nothing and creates nothing', () => {
  const c = load({});
  assert.strictEqual(fs.existsSync(c.DIR), false,
    'the directory appears when something is saved, not on import');
});

test('the path helper answers with a file inside the directory', () => {
  const c = load({ legacy: '{}' });
  assert.strictEqual(c.paths.file('state.json'), path.join(c.DIR, 'state.json'));
});

fs.rmSync(ROOT, { recursive: true, force: true });
delete process.env.LIMEN_CONFIG_DIR;
delete process.env.LIMEN_LEGACY_DIR;
console.log(`\n${passed} path tests passed`);
