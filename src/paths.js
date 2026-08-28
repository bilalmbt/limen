'use strict';
/**
 * Where the app keeps its two files, and the one-time move that got them
 * there.
 *
 * The project was called Claude Island until it needed a name that did not
 * lean on someone else's trademark. Renaming moved `~/.config/claude-island`
 * to `~/.config/limen`, and a rename that silently resets your settings is
 * not a rename, it is a reinstall — so the old directory is carried over the
 * first time either file is read.
 *
 * Kept in its own module because both the settings (main) and the persisted
 * state (state.js) resolve their paths at import time: whichever loads first
 * performs the move, and the second finds it already done.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// The overrides exist so the tests can exercise a real move without touching
// the user's own settings — the same bargain state.js makes.
const DIR = process.env.LIMEN_CONFIG_DIR || path.join(os.homedir(), '.config', 'limen');
const LEGACY_DIR = process.env.LIMEN_LEGACY_DIR ||
  path.join(os.homedir(), '.config', 'claude-island');

/**
 * Move, never merge. A half-migrated pair of files — new settings beside an
 * old state file — is a shape nothing else in the app expects, so the move
 * only happens when there is nothing at the destination at all.
 */
function migrate() {
  try {
    if (fs.existsSync(DIR) || !fs.existsSync(LEGACY_DIR)) return;
    fs.renameSync(LEGACY_DIR, DIR);
  } catch (_) {
    // A read-only home, a permission problem, or a race with another copy of
    // the app: the defaults are a working app, and losing settings is better
    // than refusing to start.
  }
}

migrate();

/** @returns {string} absolute path to one of the app's own files. */
function file(name) {
  return path.join(DIR, name);
}

module.exports = { DIR, LEGACY_DIR, file };
