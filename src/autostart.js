'use strict';
/**
 * The login item, seen and toggled from inside the app.
 *
 * Two worlds, because the app arrives two ways. Run from a checkout, it is
 * launchd's: install.sh writes the LaunchAgent and this only enables and
 * disables it, so the two never disagree about where it lives. Installed
 * from the .dmg there is no plist and never will be — nobody runs a shell
 * script out of an app bundle — so the packaged build asks macOS directly
 * through app.setLoginItemSettings.
 *
 * Getting this wrong is not a crash, it is worse: the menu item stayed
 * permanently greyed out in every packaged build, which reads as a broken
 * app rather than a missing plist.
 *
 * Adapted from Claude-Marge-Widget's autostart.js (MIT, Ulrich Rozier).
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

/**
 * Electron is required lazily and defensively: this module is loaded by the
 * test suite too, which has no Electron around it.
 */
function electronApp() {
  try {
    const { app } = require('electron');
    return app && typeof app.setLoginItemSettings === 'function' ? app : null;
  } catch (_) {
    return null;
  }
}

/** A build the user dragged into /Applications, rather than a checkout. */
function packaged() {
  const app = electronApp();
  return Boolean(app && app.isPackaged);
}

const LABEL = 'io.moobytes.limen';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

function domain() {
  return `gui/${process.getuid ? process.getuid() : ''}`;
}

/**
 * Read one service out of `launchctl print-disabled`.
 *
 * The output format changed. macOS 11 and earlier printed
 * `"label" => true`, where true meant DISABLED; current macOS prints
 * `"label" => disabled` / `=> enabled`. The old reader tested for the word
 * "true", which never appears now — so a service the user had just disabled
 * read back as enabled, and the "Start at login" checkbox could not be
 * unticked: it snapped straight back every time.
 *
 * Absent from the list means never disabled, which is enabled.
 *
 * @returns {boolean|null} enabled, or null when the answer is not in there
 */
function parseDisabled(output, label) {
  const line = String(output || '').split('\n').find((l) => l.includes(`"${label}"`));
  if (!line) return true;
  const value = (line.split('=>')[1] || '').trim().toLowerCase();
  if (value.startsWith('disabled') || value.startsWith('true')) return false;
  if (value.startsWith('enabled') || value.startsWith('false')) return true;
  return null;   // a third format we have never seen: say so rather than guess
}

/**
 * @returns {boolean|null} true/false when the answer is knowable, and null
 * when it is not — an unknown state, which the menu shows as disabled rather
 * than as a lie in either direction.
 */
function isEnabled() {
  if (process.platform !== 'darwin') return null;
  if (packaged()) {
    const app = electronApp();
    try {
      return app.getLoginItemSettings().openAtLogin === true;
    } catch (_) {
      return null;
    }
  }
  if (!fs.existsSync(PLIST)) return null;
  try {
    const out = execFileSync('/bin/launchctl', ['print-disabled', domain()],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return parseDisabled(out, LABEL);
  } catch (_) {
    return null;
  }
}

function setEnabled(on) {
  if (process.platform !== 'darwin') return false;
  if (packaged()) {
    const app = electronApp();
    try {
      app.setLoginItemSettings({ openAtLogin: on === true });
      return true;
    } catch (_) {
      return false;
    }
  }
  if (!fs.existsSync(PLIST)) return false;
  try {
    execFileSync('/bin/launchctl', [on ? 'enable' : 'disable', `${domain()}/${LABEL}`],
      { timeout: 5000, stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

/** Relaunch through launchd, so the supervisor stays the owner of the process. */
function restart() {
  if (process.platform !== 'darwin') return false;
  // No launchd to hand the process back to: relaunch it ourselves.
  if (packaged()) {
    const app = electronApp();
    try {
      app.relaunch();
      app.exit(0);
      return true;
    } catch (_) {
      return false;
    }
  }
  if (!fs.existsSync(PLIST)) return false;
  try {
    execFileSync('/bin/launchctl', ['kickstart', '-k', `${domain()}/${LABEL}`],
      { timeout: 5000, stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { isEnabled, setEnabled, restart, packaged, parseDisabled, LABEL, PLIST };
