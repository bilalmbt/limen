'use strict';
/**
 * The login item, seen and toggled from inside the app.
 *
 * install.sh writes the LaunchAgent; this only enables and disables it, so
 * the two never disagree about where it lives. Turning it off leaves the
 * running island alone — it simply will not come back at the next login.
 *
 * Adapted from Claude-Marge-Widget's autostart.js (MIT, Ulrich Rozier).
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const LABEL = 'com.claudeisland.widget';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

function domain() {
  return `gui/${process.getuid ? process.getuid() : ''}`;
}

/**
 * @returns {boolean|null} true/false when a service is registered, and null
 * when none is — an unknown state, which the menu shows as disabled rather
 * than as a lie in either direction.
 */
function isEnabled() {
  if (process.platform !== 'darwin' || !fs.existsSync(PLIST)) return null;
  try {
    const out = execFileSync('/bin/launchctl', ['print-disabled', domain()],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    const line = out.split('\n').find((l) => l.includes(`"${LABEL}"`));
    return line ? !/true/.test(line) : true;
  } catch (_) {
    return null;
  }
}

function setEnabled(on) {
  if (process.platform !== 'darwin' || !fs.existsSync(PLIST)) return false;
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
  if (process.platform !== 'darwin' || !fs.existsSync(PLIST)) return false;
  try {
    execFileSync('/bin/launchctl', ['kickstart', '-k', `${domain()}/${LABEL}`],
      { timeout: 5000, stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { isEnabled, setEnabled, restart, LABEL, PLIST };
