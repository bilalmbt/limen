'use strict';
/**
 * The island supervisor: one always-click-through window anchored to the
 * notch of the built-in display (or a virtual island top-center elsewhere).
 *
 * Core ideas, both inherited from Claude-Marge-Widget and both deliberate:
 *
 *   - The window NEVER takes focus and NEVER swallows a click. Hover is
 *     derived from sampling the cursor in this process and hit-testing in
 *     pure code (src/notch.js), not from DOM mouse events.
 *
 *   - The window sits at the 'status' level: just above the menu bar, and
 *     BELOW open menus, Spotlight, and dialogs. The island must never shadow
 *     something the user is actually using.
 *
 * All state transitions live in src/island-state.js, pure and tested. This
 * file only wires clocks, screens, and IPC to them.
 */

const {
  app, BrowserWindow, screen, Tray, Menu, nativeImage, ipcMain,
  Notification, globalShortcut, powerMonitor
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { fetchUsage } = require('./usage');
const { nextDelay, shouldRefreshOnReveal, mayFetch, isServerImposed } = require('./schedule');
const store = require('./state');
const alerts = require('./alerts');
const N = require('./notch');
const I = require('./island-state');
const VM = require('./viewmodel');
const { execFile } = require('child_process');

const DEMO = process.argv.includes('--demo');
const CAPTURE = process.env.ISLAND_CAPTURE || null;
const SCENE = process.env.ISLAND_SCENE || 'expanded';

const CONFIG_PATH = path.join(os.homedir(), '.config', 'claude-island', 'config.json');
const DEFAULTS = {
  refreshSeconds: 120,      // asking more often is what gets you rate limited
  alertAt: [80, 95],        // peek when a quota crosses these marks; [] = never
  wings: false,             // ambient rings: opt-in, the menu bar is busy land
  externalDisplays: 'island', // 'island' draws a virtual one, 'off' draws nothing
  displayId: 'primary',     // which notchless display hosts the virtual island
  notchWidth: null,         // points; null = derived from the display
  timeFormat: 'auto',       // 'auto', '12' or '24'
  osNotifications: false,   // peek replaces notifications; turn both on if you like
  shortcut: 'CommandOrControl+Shift+I'  // toggles the wings; '' registers nothing
};

/**
 * Config is user-editable, so every value is treated as untrusted. A bad
 * entry must degrade one setting, never take the app down or silently stop
 * the refresh loop — both of which a wrong type used to do.
 */
function sanitize(raw) {
  const c = { ...DEFAULTS, ...raw };
  const num = (v, lo, hi, fallback) =>
    (Number.isFinite(v) && v >= lo && v <= hi ? v : fallback);

  c.refreshSeconds = num(c.refreshSeconds, 30, 3600, DEFAULTS.refreshSeconds);
  c.notchWidth = Number.isFinite(c.notchWidth) && c.notchWidth > 0
    ? Math.min(c.notchWidth, 600)
    : null;
  c.alertAt = Array.isArray(c.alertAt)
    ? c.alertAt.filter((n) => Number.isFinite(n) && n > 0 && n <= 100)
    : DEFAULTS.alertAt;
  c.shortcut = typeof c.shortcut === 'string' ? c.shortcut : DEFAULTS.shortcut;
  c.wings = c.wings === true;
  c.osNotifications = c.osNotifications === true;
  c.externalDisplays = c.externalDisplays === 'off' ? 'off' : 'island';
  c.timeFormat = ['12', '24', 'auto'].includes(c.timeFormat) ? c.timeFormat : 'auto';
  c.displayId = typeof c.displayId === 'string' || Number.isFinite(c.displayId)
    ? c.displayId
    : DEFAULTS.displayId;
  return c;
}

function loadConfig() {
  try {
    return sanitize(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  } catch (_) {
    return { ...DEFAULTS };
  }
}
let config = loadConfig();

/**
 * Persist only what changed, merged over what is on disk right now — the
 * tray invites hand-editing the file, and a toggle must not clobber an edit
 * made while the island was running.
 */
function saveConfig(patch) {
  try {
    let onDisk = {};
    try { onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {}; } catch (_) {}
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...onDisk, ...patch }, null, 2) + '\n');
  } catch (_) { /* a read-only home must not take the island down */ }
}

const overrides = () => (config.notchWidth ? { notchWidth: config.notchWidth } : {});

// --- State ------------------------------------------------------------------

let win = null;
let tray = null;
let machine = I.create();
// Capture runs must not inherit the user's config, or a scene renders
// differently on two machines and the harness stops being evidence.
machine.wings = !CAPTURE && config.wings === true;
let rows = 3;
let lastData = { ok: false, reason: 'loading', gauges: [] };
let lastGood = store.restoreLastGood();   // survives a restart: no blank island
let failures = store.restoreFailures();   // survives a restart: no lost backoff
let alertLedger = store.read().alerts || {};
let inFlight = false;
let nextAllowedAt = 0;    // wall-clock floor under every fetch, whoever asks
let lastFetchAt = 0;      // so a held mouse button cannot become a flood
let serverImposed = false; // only a 429 / Retry-After makes the floor unwaivable
let surfaceRect = null;   // the island's REAL drawn bounds, reported by the renderer
let ready = false;
let currentDisplayId = null;
let pollTimer = null;
let refreshTimer = null;
let hideTimer = null;
if (lastGood) {
  lastData = { ...lastGood, stale: true, reason: 'loading' };
  // Size the window for the restored gauges, or the panel opens clipped
  // for accounts with more than three quotas until the first fetch lands.
  rows = Math.max(1, lastGood.gauges.length);
}

/** One log line per state change, never one per poll. */
function trace(event) {
  console.log(`[${new Date().toISOString()}] ${event}`);
}

// --- Placement --------------------------------------------------------------

function islandDisplay() {
  return N.pickIslandDisplay({
    displays: screen.getAllDisplays(),
    primaryId: screen.getPrimaryDisplay().id,
    externalMode: config.externalDisplays,
    preferredId: config.displayId
  });
}

function currentDisplay() {
  return screen.getAllDisplays().find((d) => d.id === currentDisplayId) || null;
}

function placeOn(display) {
  if (!win || win.isDestroyed() || !display) return;
  currentDisplayId = display.id;
  const wanted = N.windowBounds(display, rows, overrides());
  win.setBounds(wanted);
  // The spike made this a gate; keep it a tripwire. If macOS refuses to place
  // us over the menu bar, say so in the log instead of silently sitting low.
  const got = win.getBounds();
  if (got.y !== wanted.y || got.height !== wanted.height) {
    trace(`placement clamped: wanted y=${wanted.y} h=${wanted.height}, got y=${got.y} h=${got.height}`);
  }
}

function onDisplaysChanged() {
  const display = islandDisplay();
  if (!display) {
    trace('no display for the island (clamshell + externalDisplays off): hiding');
    if (win && !win.isDestroyed()) win.hide();
    return;
  }
  trace(`displays changed: moving to ${display.id}`);
  placeOn(display);
  sendGeometry();
  // A display that came back must bring the wings (or an open state) with
  // it: nothing else re-shows a window hidden by an unplug.
  if (I.windowVisible(machine) && win && !win.isDestroyed()) win.showInactive();
}

// --- Window -----------------------------------------------------------------

function createWindow(display) {
  win = new BrowserWindow({
    ...N.windowBounds(display, rows, overrides()),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    roundedCorners: false,
    // The window is never active, so every click on it is a "first mouse":
    // without this, the first click would only wake the window, not press
    // the button it landed on.
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  currentDisplayId = display.id;

  // 'status' clears the menu bar (24) and stays under open menus (101):
  // the island must never shadow a menu the user just opened.
  win.setAlwaysOnTop(true, 'status');
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true
  });
  // The mouse-ignore flag is dynamic: passive by default, interactive only
  // while the cursor is over the island's own visible surface (see poll).
  // Clicks aimed anywhere else — the menu bar strip above all — pass through.
  win.setIgnoreMouseEvents(true);

  win.on('closed', () => {
    win = null;
    ready = false;
    clearInterval(pollTimer);
    clearTimeout(refreshTimer);
  });
  win.webContents.on('render-process-gone', (_e, d) => trace(`renderer gone: ${d.reason}`));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => {
    ready = true;
    sendGeometry();
    win.webContents.send('usage', lastData);
    // A reveal can happen before loading finishes: replay the current state.
    win.webContents.send('panel', machine.state === I.EXPANDED);
    win.webContents.send('wings', machine.wings);
    if (machine.state === I.PEEK) win.webContents.send('peek', { gaugeId: machine.peekGaugeId });
    if (I.windowVisible(machine)) win.showInactive();
  });
}

function sendGeometry() {
  if (!ready || !win || win.isDestroyed()) return;
  const display = currentDisplay();
  if (!display) return;
  const m = N.metrics(display, overrides());
  win.webContents.send('geometry', {
    hotHeight: m.hotHeight,
    notchWidth: m.notchWidth,
    notched: m.notched,
    panelWidth: N.G.panelWidth,
    windowWidth: N.G.windowWidth,
    rows,
    locale: app.getLocale() || 'en',
    timeFormat: config.timeFormat
  });
}

/** Resize when the number of quotas the account exposes changes. */
function setRows(n) {
  const next = Math.max(1, n);
  if (next === rows) return;
  rows = next;
  placeOn(currentDisplay() || islandDisplay());
  sendGeometry();
}

// --- Effects: the machine speaks, the shell moves ---------------------------

function applyEffects(effects) {
  if (!effects.length || !win || win.isDestroyed()) return;
  for (const effect of effects) {
    if (effect === 'expand') {
      clearTimeout(hideTimer);
      win.showInactive();
      if (ready) win.webContents.send('panel', true);
      if (shouldRefreshOnReveal(lastGood && lastGood.fetchedAt, failures, Date.now())) refresh('reveal');
    } else if (effect === 'collapse') {
      setInteractive(false);
      if (ready) win.webContents.send('panel', false);
      hideWhenIdle();
    } else if (effect === 'peek') {
      clearTimeout(hideTimer);
      win.showInactive();
      if (ready) win.webContents.send('peek', { gaugeId: machine.peekGaugeId });
    } else if (effect === 'unpeek') {
      setInteractive(false);
      if (ready) win.webContents.send('peek', null);
      hideWhenIdle();
    } else if (effect === 'wings-on') {
      clearTimeout(hideTimer);
      win.showInactive();
      if (ready) win.webContents.send('wings', true);
    } else if (effect === 'wings-off') {
      if (ready) win.webContents.send('wings', false);
      hideWhenIdle();
    }
  }
}

/**
 * Passive by default, interactive only while the cursor is over the island's
 * visible surface. Toggled from the same cursor sampling that drives hover,
 * so there is no extra machinery and no DOM hit-testing.
 */
let interactive = false;
function setInteractive(on) {
  if (!win || win.isDestroyed() || on === interactive) return;
  interactive = on;
  win.setIgnoreMouseEvents(!on);
}

/** Hide the window once nothing is on screen, after the exit animation. */
function hideWhenIdle() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (win && !win.isDestroyed() && !I.windowVisible(machine)) win.hide();
  }, 360);
}

// --- Cursor sampling --------------------------------------------------------

// Two speeds: lazily while nothing is on screen, smoothly once something is.
const POLL_IDLE = 140;
const POLL_LIVE = 40;
let pollRate = POLL_IDLE;

function setPollRate(ms) {
  if (ms === pollRate) return;
  pollRate = ms;
  clearInterval(pollTimer);
  pollTimer = setInterval(poll, pollRate);
}

function poll() {
  if (!win || win.isDestroyed() || DEMO || CAPTURE) return;
  // Sample fast the moment the cursor could be arming a dwell, not only once
  // something is already on screen: at the idle rate the 120 ms dwell could
  // not be measured at all, and the gesture opened after one poll interval.
  const display = currentDisplay();
  if (!display) { setInteractive(false); return; }
  const cursor = screen.getCursorScreenPoint();
  const inHot = N.inHotZone(cursor, display, overrides());
  setPollRate(I.windowVisible(machine) || inHot ? POLL_LIVE : POLL_IDLE);

  // Keep-alive is the geometric area OR the surface actually drawn, padded:
  // a control outside it would collapse the panel under the cursor reaching
  // for it, which is how a button becomes unclickable.
  const surface = surfaceScreenRect();
  const inKeepAlive =
    N.insideKeepAlive(cursor, display, rows, overrides()) ||
    N.inRect(cursor, surface && {
      left: surface.left - 16, right: surface.right + 16,
      top: surface.top, bottom: surface.bottom + 44
    });

  const r = I.tick(machine, { inHot, inKeepAlive, now: Date.now() });
  machine = r.m;
  applyEffects(r.effects);

  // Take the mouse only where the island is ACTUALLY drawn — the renderer
  // reports its own bounds, because a rect computed from constants drifts
  // from the pixels and the gap becomes a window that eats clicks aimed at
  // whatever is behind it.
  setInteractive(N.inRect(cursor, surfaceScreenRect()));
}

/** The island's drawn surface in screen coordinates, or null if nothing is out. */
function surfaceScreenRect() {
  if (!surfaceRect || !win || win.isDestroyed() || !win.isVisible()) return null;
  const b = win.getBounds();
  return {
    left: b.x + surfaceRect.left,
    right: b.x + surfaceRect.right,
    top: b.y + surfaceRect.top,
    bottom: b.y + surfaceRect.bottom
  };
}

// --- Data -------------------------------------------------------------------

let lastLogged = null;
function logState(data) {
  const describe = (g) => `${g.model || g.kind} ${g.percent}%`;
  const state = data.ok
    ? `ok ${(data.gauges || []).map(describe).join(', ')}`
    : `failed ${data.reason}${failures ? ` (attempt ${failures})` : ''}`;
  if (state === lastLogged) return;
  lastLogged = state;
  trace(state);
}

/**
 * Ask once, then schedule the next call. A failure never wipes the display:
 * the last real numbers stay on screen, marked stale, with the reason and
 * the retry time underneath.
 */
async function refresh(cause = 'schedule', force = false) {
  if (inFlight) return;
  // One gate, all six callers. Naming the caller is what turns a surprise
  // fetch from a mystery into a fact.
  if (!mayFetch({ now: Date.now(), nextAllowedAt, serverImposed, lastFetchAt, force })) {
    const wait = Math.max(1000, nextAllowedAt - Date.now()) || 60000;  // || also catches NaN
    trace(`refresh(${cause}) held: ${Math.round(wait / 1000)} s left`);
    // Re-arm, always. A held call that returns without rescheduling leaves
    // nothing holding the loop — the island would show one reading forever.
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refresh('schedule'), wait);
    return;
  }
  inFlight = true;
  lastFetchAt = Date.now();
  let data;
  try {
    data = await fetchUsage();
  } catch (err) {
    // fetchUsage answers failures as values; this catches only the
    // unexpected. Either way the loop below must keep breathing.
    data = { ok: false, reason: 'network', detail: String((err && err.message) || err), fetchedAt: Date.now(), gauges: [] };
  } finally {
    inFlight = false;
  }

  // 'no-credentials' and 'token-expired' are local conditions: no request
  // was made, so there is nothing to back off from. Counting them would only
  // delay noticing when the user signs in — keep polling at the base rate.
  const localFailure = !data.ok && (data.reason === 'no-credentials' || data.reason === 'token-expired');
  failures = data.ok || localFailure ? 0 : failures + 1;
  serverImposed = isServerImposed(data);
  const delay = localFailure
    ? nextDelay({ ok: true }, 0, config.refreshSeconds)
    : nextDelay(data, failures, config.refreshSeconds);

  try {
    if (data.ok) {
      lastGood = data;
      lastData = data;
      raiseAlerts(data.gauges);
      store.save({
        lastGood: data, failures: 0, alerts: alertLedger,
        lastReason: null, nextAllowedAt: 0
      });
    } else {
      // Persist WHEN the next attempt is due, not just how many failed:
      // a count alone restarts the whole backoff on every launch, so a
      // restart an hour later would still sit out a fresh 15 minutes.
      store.save({ failures, lastReason: data.reason, nextAllowedAt: Date.now() + delay });
      lastData = lastGood
        ? { ...lastGood, stale: true, reason: data.reason, checkedAt: data.fetchedAt, retryAt: Date.now() + delay }
        : { ...data, retryAt: Date.now() + delay };
    }

    logState(data);
    if (data.ok && data.gauges.length) setRows(data.gauges.length);
    if (ready && win && !win.isDestroyed()) win.webContents.send('usage', lastData);
    updateTray();
  } catch (err) {
    // A rendering or notification hiccup must never kill the polling loop:
    // a widget that silently stops refreshing looks exactly like a crash.
    trace(`refresh aftermath failed: ${(err && err.stack) || err}`);
  }

  clearTimeout(refreshTimer);
  nextAllowedAt = Date.now() + delay;
  refreshTimer = setTimeout(() => refresh('schedule'), delay);
}

/**
 * Crossing a threshold peeks the island — and, only if asked, also raises an
 * OS notification. Same ledger for both, so nothing ever speaks twice.
 */
function raiseAlerts(gauges) {
  const thresholds = Array.isArray(config.alertAt) ? config.alertAt : [];
  if (!thresholds.length) return;

  const { raise, ledger } = alerts.due(gauges, thresholds, alertLedger);
  alertLedger = ledger;

  for (const { gauge, level } of raise) {
    const r = I.alert(machine, gauge.id, Date.now());
    machine = r.m;
    applyEffects(r.effects);
    if (config.osNotifications && Notification.isSupported()) {
      const name = gauge.model || (gauge.kind === 'session' ? 'Current session' : 'All models');
      new Notification({
        title: `Claude at ${gauge.percent}%`,
        body: `${name} crossed ${level}%.`,
        silent: level < 90
      }).show();
    }
  }
}

// --- Sign in, one click -----------------------------------------------------

/** Is a fresh Claude Code sign-in what the current state needs? */
function credProblem() {
  return VM.isCredentialProblem(lastData.reason);
}

const WELL_KNOWN_CLAUDE = [
  path.join(os.homedir(), '.claude', 'local', 'claude'),
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude'
];

/**
 * Claude Code's binary, found the way the user's own shell would find it.
 *
 * `-i` matters: `zsh -lc` reads .zshenv/.zprofile but NOT .zshrc, which is
 * exactly where nvm, fnm, mise and Claude Code's own installer put their
 * PATH line — without it the lookup fails for a large slice of users and
 * every sign-in falls through to opening a Terminal.
 *
 * The result is validated before use. `command -v` happily returns an alias
 * or a shell function, neither of which is a path.
 */
function resolveClaude() {
  return new Promise((resolve) => {
    execFile('/bin/zsh', ['-ilc', 'command -v claude'], { timeout: 8000 }, (err, stdout) => {
      const found = !err && stdout ? stdout.trim().split('\n').pop() : '';
      const usable = (p) => {
        try {
          return Boolean(p) && path.isAbsolute(p) && (fs.accessSync(p, fs.constants.X_OK), true);
        } catch (_) { return false; }
      };
      resolve(usable(found) ? found : WELL_KNOWN_CLAUDE.find(usable) || null);
    });
  });
}

let signingIn = false;

/**
 * One click from the tray. Two rungs:
 *
 *   1. A tiny headless Claude Code run. Claude Code refreshes its own OAuth
 *      token before making any call, so for the common case — expired access
 *      token, valid refresh token — this fixes everything invisibly. The
 *      island still never touches the token itself.
 *   2. If the numbers are still locked out, a real login needs a human and a
 *      browser: open Terminal running `claude`, where /login lives.
 */
async function signInViaClaudeCode() {
  if (signingIn) return;
  signingIn = true;
  updateTray();
  try {
    const bin = await resolveClaude();
    if (bin) {
      trace('sign-in: nudging Claude Code headlessly');
      await new Promise((resolve) => {
        execFile(bin, ['-p', 'ok', '--output-format', 'text'], { timeout: 60000 }, (err) => {
          if (err) trace(`sign-in: nudge failed: ${err.message}`);
          resolve();
        });
      });
      await refresh('sign-in', true);
      if (!credProblem()) {
        trace('sign-in: token refreshed, gauges live');
        return;
      }
    }
    // A real login needs a human and a browser. The path is passed as an
    // argument rather than interpolated into the script: building AppleScript
    // by concatenation breaks on a space and quotes badly on anything worse.
    trace('sign-in: opening Terminal for an interactive login');
    execFile('/usr/bin/osascript', [
      '-e', 'on run argv',
      '-e', 'tell application "Terminal" to activate',
      '-e', 'tell application "Terminal" to do script (quoted form of item 1 of argv)',
      '-e', 'end run',
      bin || 'claude'
    ], { timeout: 8000 }, (err) => {
      if (err) trace(`sign-in: could not open Terminal: ${err.message}`);
    });
  } finally {
    signingIn = false;
    updateTray();
  }
}

// --- Tray -------------------------------------------------------------------

function updateTray() {
  if (!tray || tray.isDestroyed()) return;
  const session = (lastData.gauges || []).find((g) => g.id === 'session');
  const label = session ? `${session.percent}%`
    : signingIn ? 'signing in…'
    : credProblem() ? 'sign in'
    : 'Island';
  tray.setToolTip('Claude Island');
  if (process.platform === 'darwin') tray.setTitle(` ${label}`);
  buildMenu();
}

function buildMenu() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    ...(credProblem() ? [
      {
        label: signingIn ? 'Signing in…' : 'Sign in with Claude Code',
        enabled: !signingIn,
        click: () => signInViaClaudeCode()
      },
      { type: 'separator' }
    ] : []),
    { label: 'Refresh now', click: () => refresh('tray', true) },
    {
      label: 'Peek for a moment',
      enabled: (lastData.gauges || []).length > 0,
      click: () => {
        const first = (lastData.gauges || [])[0];
        if (!first) return;   // nothing to peek is nothing to show
        const r = I.alert(machine, first.id, Date.now());
        machine = r.m;
        applyEffects(r.effects);
      }
    },
    { type: 'separator' },
    {
      label: 'Wings',
      type: 'checkbox',
      checked: machine.wings,
      click: () => toggleWings()
    },
    { label: 'Reveal the config file', click: () => revealConfig() },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
  ]));
}

function toggleWings() {
  const r = I.toggleWings(machine);
  machine = r.m;
  applyEffects(r.effects);
  config.wings = machine.wings;
  saveConfig({ wings: machine.wings });
  buildMenu();
}

async function revealConfig() {
  const { shell } = require('electron');
  // Reveal needs something to reveal: write the full defaults on first use,
  // so the file is a template rather than a mystery.
  if (!fs.existsSync(CONFIG_PATH)) saveConfig(config);
  const problem = await shell.openPath(CONFIG_PATH);
  if (problem) shell.showItemInFolder(CONFIG_PATH);
}

function createTray() {
  try {
    tray = new Tray(nativeImage.createEmpty());
  } catch (_) {
    return;   // no tray on this session: carry on without one
  }
  updateTray();
}

// --- Capture & demo: the visual states, reproducibly ------------------------

const FIXTURE = {
  ok: true,
  fetchedAt: Date.now() - 60000,
  gauges: [
    { id: 'session', kind: 'session', percent: 73, resetsAt: new Date(Date.now() + 51 * 60000).toISOString(), resetStyle: 'relative', active: true },
    { id: 'weekly', kind: 'weekly', percent: 21, resetsAt: '2026-08-31T16:17:00Z', resetStyle: 'absolute', active: false },
    { id: 'model-fable', kind: 'model', model: 'Fable', monogram: 'F', percent: 52, resetsAt: '2026-08-31T16:17:00Z', resetStyle: 'absolute', active: false }
  ]
};

function playScene(scene) {
  const send = (ch, v) => win.webContents.send(ch, v);
  rows = FIXTURE.gauges.length;
  placeOn(currentDisplay() || islandDisplay());
  sendGeometry();
  // Hermetic: state every scene's wings explicitly. Inheriting the running
  // config meant "expanded" silently rendered wings on a machine that had
  // them on, so the no-wings panel was never actually reviewed.
  send('wings', scene === 'wings' || scene === 'full' || scene === 'collapse');
  if (scene === 'wings') {
    send('usage', FIXTURE);
  } else if (scene === 'expired') {
    // A cached reading plus an expired token — the normal way a token dies,
    // and the case where the sign-in button used to be missing entirely.
    send('usage', {
      ...FIXTURE, stale: true, reason: 'token-expired',
      checkedAt: Date.now(), retryAt: Date.now() + 2 * 60000
    });
    send('panel', true);
  } else if (scene === 'billing') {
    send('usage', { ...FIXTURE, extraUsageEnabled: true });
    send('panel', true);
  } else if (scene === 'peek') {
    const hot = {
      ...FIXTURE,
      gauges: FIXTURE.gauges.map((g) => g.id === 'session' ? { ...g, percent: 95 } : g)
    };
    send('usage', hot);
    send('peek', { gaugeId: 'session' });
  } else if (scene === 'stale') {
    send('usage', {
      ...FIXTURE, stale: true, reason: 'rate-limited',
      checkedAt: Date.now(), retryAt: Date.now() + 8 * 60000
    });
    send('panel', true);
  } else if (scene === 'empty') {
    send('usage', { ok: false, reason: 'token-expired', fetchedAt: Date.now(), gauges: [] });
    send('panel', true);
  } else if (scene === 'full') {
    send('usage', FIXTURE);
    send('panel', true);
  } else if (scene === 'collapse') {
    // Open, settle, then close — so a capture delay past 700 ms lands inside
    // the exit and proves it is the quicker, damped motion, not the spring.
    send('usage', FIXTURE);
    send('panel', true);
    setTimeout(() => send('panel', false), 700);
  } else {
    send('usage', FIXTURE);
    send('panel', true);
  }
  win.showInactive();
}

function runCapture() {
  // ISLAND_CAPTURE_DELAY freezes the frame mid-animation: the settled state
  // says nothing about how the island got there, and a motion bug only shows
  // in the frames between.
  const delay = Number(process.env.ISLAND_CAPTURE_DELAY) || 1200;
  win.webContents.on('did-finish-load', () => {
    playScene(SCENE);
    setTimeout(async () => {
      try {
        const image = await win.webContents.capturePage();
        fs.writeFileSync(CAPTURE, image.toPNG());
        const s = image.getSize();
        console.log(`capture written: ${CAPTURE} ${s.width}x${s.height} scene=${SCENE} at=${delay}ms`);
      } catch (err) {
        console.error('capture failed:', err.message);
      }
      app.exit(0);
    }, delay);
  });
}

// --- Lifecycle --------------------------------------------------------------

// The losing instance must not fetch, save state, or draw — exit outright
// rather than quitting politely and racing the primary until it does.
// Capture and demo runs are one-shot showcases that touch neither the API
// nor the state file, so they may coexist with a running island.
if (!DEMO && !CAPTURE && !app.requestSingleInstanceLock()) app.exit(0);

process.on('uncaughtException', (err) => trace(`uncaught: ${err && err.stack}`));
process.on('unhandledRejection', (err) => trace(`unhandled rejection: ${err}`));

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  const display = islandDisplay();
  createWindow(display || screen.getPrimaryDisplay());
  if (!display) {
    // The window must exist to be shown later, but nothing may drive it: the
    // constructor claimed a display id, and leaving it set would let poll()
    // run the whole hover machine on a screen the settings excluded.
    currentDisplayId = null;
    trace('no usable display for the island (externalDisplays off); waiting for one');
  }
  const m = N.metrics(display || screen.getPrimaryDisplay(), overrides());
  trace(`started pid=${process.pid} notched=${m.notched} hotHeight=${m.hotHeight} notchWidth=${m.notchWidth}`);

  if (CAPTURE) { runCapture(); return; }
  if (DEMO) {
    // A showcase, nothing else: no tray, no fetching, no cursor sampling.
    // The real refresh loop would overwrite the scene with live data.
    win.webContents.once('did-finish-load', () => playScene(process.env.ISLAND_SCENE || 'expanded'));
    return;
  }

  createTray();
  // Restarting while rate limited must not cost an immediate extra hit: the
  // restored failure count re-enters the backoff where it left off. But only
  // for failures the endpoint actually saw — a stale count from a local
  // condition (expired token, no credentials) defers nothing, and the UI
  // must say what it is waiting for instead of "loading" for minutes.
  const bootReason = store.read().lastReason || null;
  const endpointFailure = failures > 0 &&
    bootReason && bootReason !== 'no-credentials' && bootReason !== 'token-expired';
  if (endpointFailure) {
    // Serve out the REMAINDER of the stored backoff. Time passes while the
    // app is closed, and re-waiting the full delay would punish a restart.
    const stored = store.read().nextAllowedAt;
    const remaining = Number.isFinite(stored) ? stored - Date.now() : NaN;
    const delay = Number.isFinite(remaining)
      ? Math.max(0, Math.min(remaining, nextDelay({ ok: false }, failures, config.refreshSeconds)))
      : nextDelay({ ok: false }, failures, config.refreshSeconds);
    const retryAt = Date.now() + delay;
    lastData = lastGood
      ? { ...lastGood, stale: true, reason: bootReason, retryAt }
      : { ok: false, reason: bootReason, gauges: [], fetchedAt: Date.now(), retryAt };
    // Arm the floor, not just the timer: a timer governs only the caller
    // holding it, and a hover or a wake could otherwise fetch immediately.
    nextAllowedAt = retryAt;
    serverImposed = bootReason === 'rate-limited';
    trace(`restored backoff: ${failures} failures (${bootReason}), first try in ${Math.round(delay / 1000)} s`);
    refreshTimer = setTimeout(() => refresh('schedule'), delay);
  } else {
    failures = 0;
    refresh('startup');
  }
  pollTimer = setInterval(poll, pollRate);

  // An invalid or taken accelerator must not stop the island — and it must
  // not be silent either: register() RETURNS false for a taken binding
  // rather than throwing, so a catch alone would report nothing.
  if (config.shortcut.trim()) {
    try {
      if (!globalShortcut.register(config.shortcut, () => toggleWings())) {
        trace(`shortcut "${config.shortcut}" is already taken; wings stay on the tray menu`);
      }
    } catch (err) {
      trace(`shortcut "${config.shortcut}" rejected: ${err.message}`);
    }
  }

  // Waking from sleep with hours-old numbers is worse than one extra call —
  // but the failure count is NOT cleared here. Zeroing it would erase the
  // very backoff that survived the sleep, and a machine that wakes often
  // would hammer an endpoint that had already pushed back.
  powerMonitor.on('resume', () => refresh('resume'));
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
    screen.on(event, onDisplaysChanged);
  }
});

// Clicks on the island's surface arrive here from the renderer.
// The renderer reports the island's real drawn bounds after every paint.
ipcMain.on('island-surface', (e, rect) => {
  if (!win || win.isDestroyed() || e.sender !== win.webContents) return;
  surfaceRect = rect && ['left', 'top', 'right', 'bottom'].every((k) => Number.isFinite(rect[k]))
    ? rect
    : null;
});

ipcMain.on('island-action', (e, name) => {
  if (!win || win.isDestroyed() || e.sender !== win.webContents) return;
  if (name === 'refresh') {
    refresh('button', true);
  } else if (name === 'sign-in') {
    signInViaClaudeCode();
  } else if (name === 'expand') {
    const r = I.promote(machine);
    machine = r.m;
    applyEffects(r.effects);
  }
});

// The island has no main window to close: it never quits on its own.
app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  clearInterval(pollTimer);
  clearTimeout(refreshTimer);
  clearTimeout(hideTimer);
  globalShortcut.unregisterAll();
});
