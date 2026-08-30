'use strict';
const crypto = require('crypto');
/**
 * Noticing a sign-in the moment it lands.
 *
 * While the account is unreadable, the widget's only route back used to be
 * the refresh timer — so someone who had just logged in hovered at a widget
 * still saying "sign in" for up to two minutes, and nothing they did could
 * hurry it. This watches for the credentials themselves to change:
 *
 *   - the credentials FILE is watched directly (fs.watch costs nothing),
 *   - the Keychain cannot be watched, so it is re-read on a slow heartbeat —
 *     and on a fast one for a few minutes after Terminal was opened for a
 *     login, when a change is actually expected.
 *
 * Every check is LOCAL — a keychain/file read, no network — so this adds no
 * API traffic at any pace. Only the flip from "nothing usable" to "a token
 * that looks usable" fires onUsable, exactly once per landing; the caller's
 * verifying refresh is then the first real request of the episode, which is
 * the one the user has been waiting on. While the account reads fine, the
 * heartbeat skips the read entirely and the watcher's events are ignored.
 *
 * Built as a factory with injected reads, watcher and pacing so the whole
 * machine runs under Node tests — main.js only wires it up.
 */

function createCredWatch({
  read,                // async () => credentials|null   (a LOCAL read, never network)
  looksUsable,         // (cred, now) => boolean
  isProblem,           // () => boolean — is the standing state a credential failure?
  onUsable,            // () => void — a login landed; verify it with a refresh
  watch,               // (dir, listener) => watcher with close(), or throws
  dir,                 // directory holding the credentials file
  file,                // the credentials file's basename
  trace = () => {},
  recheckMs = 15000,   // heartbeat while signed out: one local read, no network
  fastMs = 3000,       // heartbeat while a Terminal login is expected
  fastWindowMs = 5 * 60 * 1000,
  cooldownMs = 10000,  // one landing, one refresh — not one per event source
  debounceMs = 300     // a login writes the file more than once
}) {
  let timer = null;
  let debounceTimer = null;
  let watcher = null;
  let stopped = false;
  let checking = false;
  let fastUntil = 0;
  let cooldownUntil = 0;
  // What was already offered for verification, so onUsable fires once per
  // CREDENTIAL, not once per heartbeat. A revoked token can look usable
  // forever while every fetch with it fails; fired on the standing state,
  // the watcher would answer that stalemate with an API call per beat —
  // precisely the 429 factory this app is built not to be. A fingerprint
  // rather than a usable/unusable edge, because the fix for a revoked
  // token is a NEW token — which arrives as usable-to-usable and would
  // never cross an edge. The token itself is never kept: the fingerprint
  // is a truncated digest plus the expiry.
  let lastOffered = null;

  function fingerprint(cred) {
    if (!cred || !cred.accessToken) return '';
    const digest = crypto.createHash('sha256')
      .update(String(cred.accessToken)).digest('hex').slice(0, 16);
    return `${cred.expiresAt || ''}:${digest}`;
  }

  async function check() {
    // Idle guard first: while the account reads fine this costs nothing at
    // all — no subprocess, no file read. The cooldown keeps the file event
    // and the heartbeat from both answering the same landing.
    if (stopped || !isProblem() || checking) return;
    if (Date.now() < cooldownUntil) return;
    checking = true;
    try {
      const cred = await read();
      if (stopped || !isProblem()) return;
      const offer = looksUsable(cred, Date.now()) ? fingerprint(cred) : null;
      if (offer && offer !== lastOffered) {
        lastOffered = offer;
        cooldownUntil = Date.now() + cooldownMs;
        trace('credwatch: credentials changed and look usable — verifying');
        onUsable();
      }
    } catch (err) {
      trace(`credwatch: read failed: ${(err && err.message) || err}`);
    } finally {
      checking = false;
    }
  }

  function schedule() {
    if (stopped) return;
    const delay = isProblem() && Date.now() < fastUntil ? fastMs : recheckMs;
    timer = setTimeout(async () => {
      await check();
      schedule();
    }, delay);
  }

  return {
    start() {
      schedule();
      try {
        // The directory, not the file: the file may not exist yet, and a
        // login that creates it is precisely the event worth catching.
        watcher = watch(dir, (_event, filename) => {
          // Some platforms omit the name; treat that as "something changed".
          if (filename && filename !== file) return;
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(check, debounceMs);
        });
        if (watcher && typeof watcher.on === 'function') {
          // An error after setup (the directory removed, the fd recycled)
          // must not take the process down; the heartbeat still covers.
          watcher.on('error', (err) => trace(`credwatch: watcher error: ${err.message}`));
        }
      } catch (err) {
        // No directory yet, or watching unsupported: the heartbeat covers.
        trace(`credwatch: not watching ${dir}: ${(err && err.message) || err}`);
      }
    },

    /** A Terminal login was just opened: a change is EXPECTED — listen hard. */
    expectLogin() {
      fastUntil = Date.now() + fastWindowMs;
      // Re-arm at the new pace now: the pending round was scheduled at the
      // slow one, and the fast window should not spend its first beat there.
      clearTimeout(timer);
      schedule();
    },

    stop() {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(debounceTimer);
      if (watcher) { try { watcher.close(); } catch (_) { /* already gone */ } }
    }
  };
}

module.exports = { createCredWatch };
