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

// The self-test clicks REAL controls, and real controls save real settings.
// Redirect both files into a scratch directory before ./paths and ./state
// resolve their locations at require time, so exercising the wiring can
// never edit the config of the person running the harness.
if (process.env.ISLAND_SELFTEST && !process.env.LIMEN_CONFIG_DIR) {
  process.env.LIMEN_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'limen-selftest-'));
  if (!process.env.ISLAND_STATE_FILE) {
    process.env.ISLAND_STATE_FILE = path.join(process.env.LIMEN_CONFIG_DIR, 'state.json');
  }
}

const { fetchUsage, readCredentials, credentialsLookUsable } = require('./usage');
const { createCredWatch } = require('./credwatch');
const {
  FORCE_FLOOR_MS, nextDelay, shouldRefreshOnReveal, mayFetch, isServerImposed
} = require('./schedule');
const store = require('./state');
const alerts = require('./alerts');
const N = require('./notch');
const I = require('./island-state');
const trend = require('./trend');
const autostart = require('./autostart');
const prime = require('./prime');
const { DEFAULTS, sanitize, toggleSource } = require('./config');
const VM = require('./viewmodel');
const { execFile } = require('child_process');

const DEMO = process.argv.includes('--demo');
const CAPTURE = process.env.ISLAND_CAPTURE || null;
const SCENE = process.env.ISLAND_SCENE || 'expanded';

const CONFIG_PATH = require('./paths').file('config.json');
/**
 * Exactly what a prime sends, in one place so it can be documented honestly.
 * One word, on the cheapest model, with no session file and no MCP servers
 * loaded: the smallest thing that still opens a five-hour window.
 */
function primeArgs() {
  return ['-p', 'ok',
    '--model', config.primeModel,
    ...MINIMAL_CLAUDE_ARGS];
}

/**
 * How long to wait on a headless Claude Code run before deciding it will not
 * answer.
 *
 * Measured rather than guessed: with working credentials the nudge returns in
 * about three seconds. Twenty leaves room for a slow link and a token refresh
 * round-trip, and still fails fast enough to feel like an answer. It used to
 * be sixty, which is not a wait — it is a stare, and it ended in the panel
 * asking for a second click.
 */
const NUDGE_TIMEOUT_MS = 20000;

/**
 * The flags that keep a headless Claude Code run to itself.
 *
 * Shared, because they were not. The priming path had them and the sign-in
 * path did not, so clicking "Sign in with Claude Code" started the user's
 * ENTIRE Claude Code environment — every MCP server they have configured —
 * as a child of this app, and macOS attributes a child's file access to the
 * responsible process. Their servers reaching for Downloads or the media
 * library produced prompts saying "Limen would like to access…".
 */
const MINIMAL_CLAUDE_ARGS = [
  '--output-format', 'text',
  '--no-session-persistence',   // don't litter the user's session history
  '--strict-mcp-config'         // don't load their MCP servers to say "ok"
];

/**
 * Read the settings, and CLEAN THE FILE if reading it found anything wrong.
 *
 * Normalising only in memory was the mistake: a contradictory pair or a key
 * from an older version would be ignored on every launch and left on disk
 * forever, so the file drifted further from what the app actually does every
 * time something changed. Rewriting it means the file is always the truth.
 */
function loadConfig() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (_) {
    return { ...DEFAULTS };   // absent or unreadable: defaults, write nothing
  }
  const { config: cfg, file, dropped } = sanitize(raw);
  if (dropped.length) {
    writeConfigFile(file);
    trace(`settings cleaned: dropped ${dropped.join(', ')}`);
  }
  return cfg;
}

function writeConfigFile(file) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    // Write beside it, then rename — the same bargain state.js makes, for
    // the same reason: this file is rewritten on every tray toggle, and a
    // truncated one reads as {} — after which the next save would persist
    // only the one toggled key and quietly discard every other setting.
    const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n');
    fs.renameSync(tmp, CONFIG_PATH);
    return true;
  } catch (_) {
    return false;   // a read-only home must not take the island down
  }
}

let config = loadConfig();

/**
 * Persist only what changed, merged over what is on disk right now — the
 * tray invites hand-editing the file, and a toggle must not clobber an edit
 * made while the island was running.
 */
function saveConfig(patch) {
  let onDisk = {};
  try { onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {}; } catch (_) {}
  // Normalised on the way out too, so a write can never reintroduce the
  // contradiction the read just removed.
  const { file } = sanitize({ ...onDisk, ...patch });
  writeConfigFile(file);
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
let history = store.read().history || [];   // for burn rate; percentages only
let inFlight = false;
let nextAllowedAt = 0;    // wall-clock floor under every fetch, whoever asks
let lastFetchAt = 0;      // so a held mouse button cannot become a flood
let serverImposed = false; // only a 429 / Retry-After makes the floor unwaivable
let surfaceRects = [];    // the island's REAL drawn pixels, reported by the renderer
let ready = false;
let currentDisplayId = null;
let pollTimer = null;
let refreshTimer = null;
let lastCursor = null;   // for stillness: a moving cursor is not a hover
let hideTimer = null;
if (lastGood) {
  // Without the trend: "full in ~35 min" carries no timestamp, so a
  // projection computed yesterday reads as a live one, against a window that
  // has since reset. The next fetch recomputes it from real samples.
  const { trend: _staleTrend, ...restored } = lastGood;
  lastData = { ...restored, stale: true, reason: 'loading' };
  // Size the window for the restored gauges, or the panel opens clipped
  // for accounts with more than three quotas until the first fetch lands.
  rows = Math.max(1, lastGood.gauges.length);
}

/** The refresh control should reflect a real fetch, not a fixed animation. */
function sendBusy(on) {
  if (ready && win && !win.isDestroyed()) win.webContents.send('busy', on === true);
}

/**
 * The runtime twin of restoreLastGood's age rule. A restart refuses to show
 * a reading older than a day, but a Mac that stays up for weeks never
 * restarts — so through a long enough outage the "stale" numbers on screen
 * were last month's, still wearing a percentage. Past the same cutoff, the
 * degraded no-numbers view is the honest one.
 */
function showableLastGood() {
  return Boolean(lastGood && lastGood.fetchedAt &&
    Date.now() - lastGood.fetchedAt <= store.MAX_AGE_MS);
}

/**
 * Where an installed copy writes its log.
 *
 * A packaged app launched from Finder has nowhere to put stdout: it is not
 * a terminal, and console.log does not reach the unified log either, so
 * `log show` returns LaunchServices noise and nothing of ours. The result is
 * an app that cannot be diagnosed by the person running it — they can only
 * describe what they saw. Running from a checkout keeps the terminal, which
 * is why this was never noticed.
 */
const LOG_PATH = path.join(os.homedir(), 'Library', 'Logs', 'Limen.log');
const LOG_CAP = 512 * 1024;   // a widget's log is for the last hour, not the year

let logStream = null;
let logBytes = 0;
function openLog() {
  try {
    // Truncate on launch past the cap rather than rotating: nobody wants
    // Limen.log.3, and the interesting part is always the current run.
    let flags = 'a';
    try {
      logBytes = fs.statSync(LOG_PATH).size;
      if (logBytes > LOG_CAP) { flags = 'w'; logBytes = 0; }
    } catch (_) { logBytes = 0; }
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    logStream = fs.createWriteStream(LOG_PATH, { flags });
  } catch (_) {
    logStream = null;   // a read-only home is not a reason to refuse to run
  }
}

/** One log line per state change, never one per poll. */
function trace(event) {
  const line = `[${new Date().toISOString()}] ${event}`;
  console.log(line);
  if (logStream) {
    try {
      logStream.write(line + '\n');
      logBytes += Buffer.byteLength(line) + 1;
      // Enforced here, not only at launch: this app is built to run for
      // months between launches, and the mouse take/release lines alone
      // would grow an unwatched file without bound.
      if (logBytes > LOG_CAP) {
        logStream.end();
        logStream = fs.createWriteStream(LOG_PATH, { flags: 'w' });
        logBytes = 0;
        logStream.write(`[${new Date().toISOString()}] log started over past ${LOG_CAP} bytes\n`);
      }
    } catch (_) { logStream = null; }
  }
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
    // The id must go too: the startup path already knows this — a stale id
    // lets poll() run the whole hover machine on a screen the settings
    // excluded, and re-show the window the line below just hid.
    currentDisplayId = null;
    if (win && !win.isDestroyed()) win.hide();
    return;
  }
  const moved = display.id !== currentDisplayId;
  if (moved) trace(`displays changed: moving to ${display.id}`);
  // A panel or peek that was open on the display that just went away should
  // not reappear on the one that replaced it, with the cursor nowhere near
  // it. Only the chips survive a display change, because only they are
  // meant to be on screen without a cursor.
  //
  // Only when the island actually changes displays. This handler fires for
  // a metrics tick on ANY monitor — a fullscreen transition, a Dock resize —
  // and collapsing the open panel for one of those closes it under a cursor
  // that is nowhere near the hot strip. Worse for a peek: the ledger has
  // already recorded its alert as spoken, so a peek cut short is an alert
  // lost for the whole reset window.
  if (moved && machine.state !== I.DORMANT) {
    machine = { ...machine, state: I.DORMANT, dwellSince: null, hideAt: null, peekGaugeId: null };
    if (ready && win && !win.isDestroyed()) {
      win.webContents.send('panel', false);
      win.webContents.send('peek', null);
    }
  }
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
    show: false,
    roundedCorners: false,
    // An NSPanel with the non-activating style mask. This is the whole
    // reason the buttons can work: `focusable: false` makes a window that
    // macOS will not route clicks to at all, while a non-activating panel
    // receives them WITHOUT bringing the app forward — so clicking the
    // island still never pulls you out of your editor.
    type: 'panel',
    // The window is never the active app, so every click on it is a "first
    // mouse": without this the first click would only wake the window
    // rather than press the button it landed on.
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

  // Keep the island out of screenshots, recordings and screen shares. It
  // lives at the top of the screen during exactly the moments people demo
  // and record, and it is showing account usage. Skipped for the capture
  // harness, which needs to photograph its own window.
  if (config.contentProtection && !CAPTURE) win.setContentProtection(true);

  // No remote content exists here and the CSP forbids it; these close the
  // category permanently rather than relying on that staying true.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  win.on('closed', () => {
    win = null;
    ready = false;
    // All four, as before-quit does. Two were missing here, so a peek could
    // still drain — and raise an OS notification — with no island to show
    // it on.
    clearInterval(pollTimer);
    clearTimeout(refreshTimer);
    clearTimeout(hideTimer);
    clearTimeout(peekTimer);
    clearTimeout(primeTimer);
  });
  // Reload rather than shrug: a dead renderer left the tray working and the
  // island a blank window until someone quit and relaunched by hand. The
  // did-finish-load replay below already restores the whole state — that
  // machinery exists for exactly this. At most once a minute, so a renderer
  // that dies on arrival cannot become a relaunch loop.
  let lastRendererRevival = 0;
  win.webContents.on('render-process-gone', (_e, d) => {
    trace(`renderer gone: ${d.reason}`);
    const now = Date.now();
    if (now - lastRendererRevival > 60000 && win && !win.isDestroyed()) {
      lastRendererRevival = now;
      ready = false;
      win.webContents.reload();
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => {
    ready = true;
    sendGeometry();
    win.webContents.send('usage', decorate(lastData));
    // A reveal can happen before loading finishes: replay the current state.
    win.webContents.send('panel', machine.state === I.EXPANDED);
    win.webContents.send('wings', machine.wings);
    if (machine.state === I.PEEK) win.webContents.send('peek', { gaugeId: machine.peekGaugeId });
    // currentDisplay() and not just windowVisible(): with wings on in the
    // config but externalDisplays 'off', the machine wants a window that has
    // nowhere to be — display-added shows it when somewhere appears.
    if (I.windowVisible(machine) && currentDisplay()) win.showInactive();
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
  // Nothing is SHOWN without a display to show it on. Hover cannot get here
  // display-less (poll bails first), but the wings toggle and the startup
  // replay can — and a window shown then sits on the excluded display, drawn
  // with the stylesheet's placeholder geometry because sendGeometry() had
  // nothing to measure.
  const show = () => { if (currentDisplay()) win.showInactive(); };
  for (const effect of effects) {
    if (effect === 'expand') {
      clearTimeout(hideTimer);
      show();
      if (ready) win.webContents.send('panel', true);
      // Forced while the account is unreadable: that state made no request,
      // so there is no pacing to protect — and a person who just signed in
      // is hovering at a widget that would otherwise answer "held" until
      // the timer came round. The five-second floor still bounds it, and a
      // server-imposed backoff still refuses; see mayFetch.
      if (shouldRefreshOnReveal(lastGood && lastGood.fetchedAt, failures, Date.now())) {
        refresh('reveal', credProblem());
      }
    } else if (effect === 'collapse') {
      setInteractive(false);
      if (ready) win.webContents.send('panel', false);
      hideWhenIdle();
    } else if (effect === 'peek') {
      clearTimeout(hideTimer);
      show();
      if (ready) win.webContents.send('peek', { gaugeId: machine.peekGaugeId });
    } else if (effect === 'unpeek') {
      setInteractive(false);
      if (ready) win.webContents.send('peek', null);
      hideWhenIdle();
    } else if (effect === 'wings-on') {
      clearTimeout(hideTimer);
      show();
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
  // Logged because this is the one behaviour that cannot be unit-tested and
  // fails silently: if a button does nothing, the first question is whether
  // the window was even accepting the mouse at that moment.
  trace(`mouse: ${on ? 'taking' : 'releasing'} clicks over the island`);
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
  // Not windowVisible(): that is true whenever the chips are out, and the
  // chips are the always-on mode — so sampling the cursor 25 times a second,
  // forever, was the normal state of the app. Wings need no cursor at all;
  // what needs the fast rate is a state that can change under one.
  setPollRate(machine.state !== I.DORMANT || inHot ? POLL_LIVE : POLL_IDLE);

  // Keep-alive is the geometric area OR the surface actually drawn, padded:
  // a control outside it would collapse the panel under the cursor reaching
  // for it, which is how a button becomes unclickable.
  const surface = surfaceBounds();
  const inKeepAlive =
    N.insideKeepAlive(cursor, display, rows, overrides()) ||
    N.inRect(cursor, surface && {
      left: surface.left - 16, right: surface.right + 16,
      top: surface.top, bottom: surface.bottom + 44
    });

  const moved = lastCursor
    ? Math.hypot(cursor.x - lastCursor.x, cursor.y - lastCursor.y)
    : 0;
  lastCursor = cursor;

  const r = I.tick(machine, { inHot, inKeepAlive, moved, now: Date.now() });
  machine = r.m;
  applyEffects(r.effects);

  // Take the mouse only where the island is ACTUALLY drawn — the renderer
  // reports its own bounds, because a rect computed from constants drifts
  // from the pixels and the gap becomes a window that eats clicks aimed at
  // whatever is behind it.
  // Any ONE of the drawn rectangles, never their bounding box: the gap
  // beside the notch belongs to the menu bar.
  setInteractive(surfaceScreenRects().some((r) => N.inRect(cursor, r)));
}

/** The island's drawn pixels in screen coordinates, as a list of rectangles. */
function surfaceScreenRects() {
  if (!surfaceRects.length || !win || win.isDestroyed() || !win.isVisible()) return [];
  const b = win.getBounds();
  return surfaceRects.map((r) => ({
    left: b.x + r.left,
    right: b.x + r.right,
    top: b.y + r.top,
    bottom: b.y + r.bottom
  }));
}

/** The union, for the keep-alive area and for sizing the window. */
function surfaceBounds() {
  const list = surfaceScreenRects();
  if (!list.length) return null;
  return {
    left: Math.min(...list.map((r) => r.left)),
    right: Math.max(...list.map((r) => r.right)),
    top: Math.min(...list.map((r) => r.top)),
    bottom: Math.max(...list.map((r) => r.bottom))
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
 *
 * @returns {Promise<boolean>} whether a request was actually made — a held
 * or already-running call returns false, which callers must not read as a
 * failed fetch.
 */
async function refresh(cause = 'schedule', force = false) {
  if (inFlight) return false;
  // One gate, all six callers. Naming the caller is what turns a surprise
  // fetch from a mystery into a fact.
  // A backward clock correction (a Mac that booted with a wrong future
  // clock, a restored snapshot) leaves both stamps in the future, and every
  // gate then refuses until real time catches up — the timer, the force
  // path and the refresh button together. Stamps that cannot be reached
  // from here did not come from here.
  const now0 = Date.now();
  // A day, not MAX_DELAY_MS. Our own backoff never exceeds fifteen minutes,
  // but a server Retry-After is deliberately uncapped — so this guard used
  // to read a legitimate "come back in an hour" as a broken clock, discard
  // it, and hammer the endpoint that had just asked for room.
  if (nextAllowedAt > now0 + CLOCK_SKEW_MS) {
    trace('clock moved backwards: re-arming the refresh loop');
    nextAllowedAt = 0;
  }
  if (lastFetchAt > now0) lastFetchAt = 0;

  if (!mayFetch({ now: Date.now(), nextAllowedAt, serverImposed, lastFetchAt, force })) {
    const wait = Math.max(1000, nextAllowedAt - Date.now()) || 60000;  // || also catches NaN
    trace(`refresh(${cause}) held: ${Math.round(wait / 1000)} s left`);
    // Re-arm, always. A held call that returns without rescheduling leaves
    // nothing holding the loop — the island would show one reading forever.
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refresh('schedule'), wait);
    return false;
  }
  inFlight = true;
  lastFetchAt = Date.now();
  sendBusy(true);   // the ↻ spins for as long as the fetch really runs
  let data;
  try {
    data = await fetchUsage();
  } catch (err) {
    // fetchUsage answers failures as values; this catches only the
    // unexpected. Either way the loop below must keep breathing.
    data = { ok: false, reason: 'network', detail: String((err && err.message) || err), fetchedAt: Date.now(), gauges: [] };
  } finally {
    inFlight = false;
    sendBusy(false);
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
    if (data.ok && !data.gauges.length) {
      // A parseable 200 with nothing in it is not news. Taken as good it
      // replaced the last real reading, blanked the island, and persisted
      // the void — after which restoreLastGood had nothing to restore
      // either, because it rejects empty readings on the way back in.
      // A real reason all the same: the dressed reading used to carry none,
      // and the status strip rendered `undefined` as "Unknown problem".
      trace('empty reading: keeping the last good one');
      lastData = showableLastGood()
        ? { ...lastGood, stale: true, reason: 'empty', checkedAt: data.fetchedAt, retryAt: Date.now() + delay }
        : data;
    } else if (data.ok) {
      history = trend.push(history, data.gauges, data.fetchedAt);
      data.trend = trend.summarize(history, data.gauges, data.fetchedAt);
      lastGood = data;
      lastData = data;
      raiseAlerts(data.gauges, data.trend);
      store.save({
        lastGood: data, failures: 0, alerts: alertLedger, history,
        lastReason: null, nextAllowedAt: 0
      });
    } else {
      // Persist WHEN the next attempt is due, not just how many failed:
      // a count alone restarts the whole backoff on every launch, so a
      // restart an hour later would still sit out a fresh 15 minutes.
      store.save({ failures, lastReason: data.reason, nextAllowedAt: Date.now() + delay });
      lastData = showableLastGood()
        ? { ...lastGood, stale: true, reason: data.reason, checkedAt: data.fetchedAt, retryAt: Date.now() + delay }
        : { ...data, retryAt: Date.now() + delay };
      // The plan comes from the credentials, not the endpoint, so a failed
      // fetch still knows it — and a restored reading from yesterday should
      // not claim a plan the account may have changed since.
      if (data.plan) lastData.plan = data.plan;
    }

    // Only when something is wrong with the credentials, and only then: the
    // probe is cheap but it is still a subprocess, and there is no reason to
    // run one every two minutes to be told again that all is well.
    // A credential problem that fixed itself — in a terminal, by a refresh,
    // by anything — takes its follow-up state with it. Left standing, the
    // next problem days later opened Terminal on the FIRST click, from a
    // button that had not named Terminal in this episode at all.
    if (!credProblem()) { pendingTerminal = false; pendingInstall = false; }

    if (!data.ok && VM.isCredentialProblem(data.reason)) {
      // Cheap, but still a subprocess, and this loop runs every two minutes
      // for as long as the problem lasts. The answer only changes when
      // someone signs in or out, so ask on the first poll of a given
      // failure and then at a walking pace.
      const fresh = data.reason !== accountProbe.reason ||
        Date.now() - accountProbe.at > ACCOUNT_PROBE_MS;
      if (fresh) {
        const bin = await resolveClaude();
        accountProbe = {
          reason: data.reason,
          at: Date.now(),
          live: bin ? await claudeLoggedIn(bin) : null
        };
        trace(`credentials: ${data.reason}, claude account live=${accountProbe.live}`);
      }
      lastData.accountLive = accountProbe.live;
    } else {
      lastData.accountLive = undefined;
      accountProbe = { reason: null, at: 0, live: undefined };
    }

    logState(data);
    if (data.ok && data.gauges.length) setRows(data.gauges.length);
    // decorate(), never a hand-written copy of its field list: the two lists
    // diverged once already (the canPrime gate), and the next field added
    // would land in one and not the other.
    pushUsage();
    updateTray();
    // Checked on the data cadence: it needs to know whether a window is open,
    // which is exactly what we just found out.
    checkPrime();
  } catch (err) {
    // A rendering or notification hiccup must never kill the polling loop:
    // a widget that silently stops refreshing looks exactly like a crash.
    trace(`refresh aftermath failed: ${(err && err.stack) || err}`);
  }

  clearTimeout(refreshTimer);
  nextAllowedAt = Date.now() + delay;
  // Guard the reschedule: an in-flight fetch that lands after the window is
  // gone would otherwise revive the loop for a dead window.
  if (win && !win.isDestroyed()) {
    refreshTimer = setTimeout(() => refresh('schedule'), delay);
  }
}

/**
 * A forced refresh that outlasts the five-second force floor.
 *
 * A prime or a sign-in nudge finishes a few seconds after the fetch that
 * triggered it, so its verification refresh routinely lands inside the
 * floor, is held, and the caller then judges "did it work" from numbers
 * that predate the thing it just did — a prime that worked reported as
 * failed, and a second click spending a second real message. The sign-in
 * path learned this first; the prime paths repeated it. One helper, so the
 * next caller cannot.
 */
async function verifyingRefresh(cause) {
  if (await refresh(cause, true)) return true;
  const wait = Math.max(0, lastFetchAt + FORCE_FLOOR_MS - Date.now()) + 250;
  trace(`${cause}: refresh held, waiting ${Math.round(wait / 1000)} s for the floor`);
  await new Promise((r) => setTimeout(r, wait));
  return refresh(cause, true);
}

/**
 * Crossing a threshold peeks the island — and, only if asked, also raises an
 * OS notification. Same ledger for both, so nothing ever speaks twice.
 */
function raiseAlerts(gauges, summary) {
  // What may be said, and the bookkeeping that makes it said once, both live
  // in alerts.js — where the test suite can hold them. This function's job is
  // only to hand over the settings and put the result on screen.
  const { raise, ledger } = alerts.plan(gauges, {
    thresholds: Array.isArray(config.alertAt) ? config.alertAt : [],
    summary,
    ledger: alertLedger,
    silenced: alertsPausedUntil > Date.now()
  });
  alertLedger = ledger;

  // Queue them: raising two in one poll used to overwrite the first peek
  // while the ledger had already recorded it as spoken, so it was never
  // shown at all. Session and weekly crossing together is the normal case.
  for (const item of raise) queuePeek(item);
}

/**
 * One peek at a time, in order. When several are due at once the panel is
 * the better answer than a queue of pills, so anything past the second
 * expands instead.
 */
const peekQueue = [];
let peekTimer = null;
let peekShowing = false;
function queuePeek(item) {
  peekQueue.push(item);
  if (peekQueue.length > 2) {
    // Too many to show one at a time, so the panel answers instead — but
    // every one of them still gets its notification. The ledger has already
    // recorded them as spoken, so anything dropped here is dropped for the
    // whole reset window, and the first poll after launch raises every
    // gauge already over a threshold at once.
    for (const queued of peekQueue) notify(queued);
    peekQueue.length = 0;
    peekShowing = false;
    // Same gate as drainPeeks: with no display for the island (clamshell +
    // externalDisplays off), the notifications above are the whole answer —
    // promoting would open a panel nothing can ever dismiss.
    if (!canShowIsland()) return;
    const r = I.promote(machine, Date.now());
    machine = r.m;
    applyEffects(r.effects);
    return;
  }
  // `showing`, not `peekTimer`: drainPeeks armed a timer only if the queue
  // was still non-empty AFTER its shift, which it never was — so the second
  // alert of a poll drained immediately and overwrote the first, while the
  // ledger had already recorded both as spoken. Session and weekly crossing
  // together is the normal case, and the first one was never seen.
  if (!peekShowing) drainPeeks();
}

function drainPeeks() {
  if (!canShowIsland()) {
    // No island to show a peek on, but a notification needs no island — and
    // the ledger has already recorded these as spoken, so dropping them
    // drops them for the whole reset window.
    for (const queued of peekQueue) notify(queued);
    peekQueue.length = 0;
    peekShowing = false;
    return;
  }
  const item = peekQueue.shift();
  clearTimeout(peekTimer);
  peekTimer = null;
  if (!item) { peekShowing = false; return; }

  const r = I.alert(machine, item.gauge.id, Date.now());
  machine = r.m;
  applyEffects(r.effects);
  notify(item);
  // One peek holds the island for peekMs; the next waits that out whether or
  // not anything is queued behind it yet, so an alert arriving during a peek
  // still gets its turn instead of replacing what is on screen.
  peekShowing = true;
  peekTimer = setTimeout(drainPeeks, I.T.peekMs + 400);
}

function notify(item) {
  if (!config.osNotifications || !Notification.isSupported()) return;
  const { gauge, level } = item;
  const name = gauge.model || (gauge.kind === 'session' ? 'Current session' : 'All models');
  new Notification({
    title: level === 'pace'
      ? `${name} will run out before it resets`
      : `Claude at ${gauge.percent}%`,
    body: level === 'pace'
      ? `About ${item.minutes} min left at the current pace.`
      : `${name} crossed ${level}%.`,
    silent: level !== 'pace' && level < 90
  }).show();
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

// Where "Install Claude Code first" sends people: the project page, which
// carries the install instructions and is the least likely URL to move.
const CLAUDE_INSTALL_URL = 'https://github.com/anthropics/claude-code';

/** A path that exists and can be executed — `command -v` happily returns an
    alias or a shell function, neither of which is one. */
function usableBinary(p) {
  try {
    return Boolean(p) && path.isAbsolute(p) && (fs.accessSync(p, fs.constants.X_OK), true);
  } catch (_) { return false; }
}

/**
 * Claude Code's binary — asking the user's shell only when we have to.
 *
 * The order is the point. Looking in the places Claude Code and Homebrew
 * actually install it costs nothing and answers for almost everyone. Only
 * when that fails do we spawn a shell, and only then does it escalate to an
 * INTERACTIVE one.
 *
 * `-i` is what reads .zshrc, which is where nvm, fnm and mise put their PATH
 * line — so it cannot simply be dropped. But an interactive shell also runs
 * every other thing in a person's startup files, as a child of this app and
 * therefore under this app's name in any permission prompt they raise. That
 * is a lot of someone else's code to run in order to locate one binary, so
 * it is now the last resort rather than the first move.
 */
// Resolving asks the user's shell in the worst case, which runs their
// startup files as our child. Doing that once per launch is a lookup; doing
// it on the poll loop — which is where the credential probe put it — is a
// standing invitation to run someone else's code every two minutes.
let claudeBinary;
async function resolveClaude() {
  if (claudeBinary !== undefined && usableBinary(claudeBinary)) return claudeBinary;
  claudeBinary = await findClaude();
  return claudeBinary;
}

async function findClaude() {
  const known = WELL_KNOWN_CLAUDE.find(usableBinary);
  if (known) return known;

  const ask = (args) => new Promise((resolve) => {
    execFile('/bin/zsh', args, { timeout: 8000 }, (err, stdout) => {
      const found = !err && stdout ? stdout.trim().split('\n').pop() : '';
      resolve(usableBinary(found) ? found : null);
    });
  });

  // Login shell first: .zshenv/.zprofile, no .zshrc, no plugins.
  return await ask(['-lc', 'command -v claude']) ||
         await ask(['-ilc', 'command -v claude']);
}

/**
 * What Claude Code itself thinks about being signed in.
 *
 * `claude auth status` answers in about a fifth of a second and loads
 * nothing — no session, no MCP servers. It is the cheapest way to tell the
 * two failures apart: a token this app cannot read because it expired, which
 * a real call will refresh, and an account that is simply not logged in,
 * where nothing but a browser will do.
 *
 * @returns {Promise<boolean|null>} null when the question cannot be asked
 */
function claudeLoggedIn(bin) {
  return new Promise((resolve) => {
    execFile(bin, ['auth', 'status'], { timeout: 5000, killSignal: 'SIGKILL' }, (err, stdout) => {
      if (err && !stdout) return resolve(null);
      try {
        const parsed = JSON.parse(String(stdout));
        resolve(typeof parsed.loggedIn === 'boolean' ? parsed.loggedIn : null);
      } catch (_) {
        resolve(null);   // a future version that answers differently is not a no
      }
    });
  });
}

// Asking Claude Code whether the account is live, at a pace that suits an
// answer which changes when a person signs in or out — not every poll.
const ACCOUNT_PROBE_MS = 10 * 60 * 1000;

/** Further ahead than any legitimate wait: past this, the clock moved. */
const CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;
let accountProbe = { reason: null, at: 0, live: undefined };

let signingIn = false;
let pendingTerminal = false;   // the first click nudges; a second opens Terminal
let pendingInstall = false;    // no binary found; a second click opens the install page

// The sign-in watcher: local credential re-reads on a heartbeat, the
// credentials file watched directly, so a login is noticed in seconds
// instead of at the next timer. Checks are local reads only; the single
// verifying refresh it fires goes through the same gate as every fetch.
const credWatch = createCredWatch({
  read: readCredentials,
  looksUsable: credentialsLookUsable,
  isProblem: () => credProblem(),
  onUsable: () => {
    verifyingRefresh('sign-in-detected')
      .catch((err) => trace(`sign-in-detected refresh failed: ${(err && err.message) || err}`));
  },
  watch: (dir, listener) => fs.watch(dir, listener),
  dir: path.join(os.homedir(), '.claude'),
  file: '.credentials.json',
  trace
});

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
// --- Session priming ---------------------------------------------------------

let priming = false;
let lastPrime = store.read().lastPrime || { day: null, slot: null };
let primeFailUntil = 0;                 // after a failure, stop retrying for a while
const PRIME_RETRY_MS = 30 * 60 * 1000;

/** Is a five-hour window running right now? */
function sessionOpen() {
  const g = (lastData.gauges || []).find((x) => x.id === 'session');
  if (!g || !g.resetsAt) return false;
  const at = Date.parse(g.resetsAt);
  return Number.isFinite(at) && at > Date.now();
}

/**
 * Can "is a window open" be answered at all? Accounts expose whichever
 * limits the API enforces, and without a session gauge sessionOpen() says
 * "no" forever — which chain mode would read as an invitation to send a
 * message on every retry, around the clock, for an account whose windows it
 * cannot see.
 */
function sessionKnowable() {
  return (lastData.gauges || []).some((g) => g.id === 'session');
}

/** When the running window ends, for the menu to explain why it is disabled. */
function sessionEndsAt() {
  const g = (lastData.gauges || []).find((x) => x.id === 'session');
  if (!g || !g.resetsAt) return '';
  return new Date(g.resetsAt).toLocaleTimeString(app.getLocale() || undefined,
    { hour: '2-digit', minute: '2-digit' });
}

/**
 * The prime schedule, on a clock of its own.
 *
 * It used to be checked from the refresh loop, and only from there.
 * refreshSeconds can be set as high as an hour, while a slot's grace is
 * fifteen minutes — so at the coarse end a slot was stepped over three times
 * in four. A timer of its own, at the grace window's own pace, so the two no
 * longer depend on a setting that knows nothing about them. The refresh loop
 * still calls checkPrime too — it has just found out whether a window is
 * open, which is the other thing the decision needs.
 */
let primeTimer = null;
function armPrimeTimer() {
  clearTimeout(primeTimer);
  const active = config.primeChain || config.primeAt.length;
  if (!active) return;
  primeTimer = setTimeout(() => { checkPrime(); armPrimeTimer(); }, 5 * 60 * 1000);
}

async function checkPrime() {
  if (priming) return;
  if (!config.primeAt.length && !config.primeChain) return;
  // Nothing to prime with, and nothing worth spending: a broken sign-in
  // would just produce a failed message.
  if (credProblem() || !lastData.ok) return;
  // The panel's own rule, which this path was missing: a stale reading is
  // not a basis for spending a real message — canPrime has always refused
  // it, and auto-open must not be looser than the button.
  if (lastData.stale === true) return;
  // And a reading with no session gauge cannot answer "is a window open":
  // acting on a permanent "no" would prime on every retry, forever.
  if (!sessionKnowable()) return;
  if (Date.now() < primeFailUntil) return;

  const now = new Date();
  // The DATE, not the weekday. Keyed by weekday index, "already primed at
  // this slot today" was still true the next time that weekday came round,
  // so a single-day schedule primed once and never again — and any schedule
  // whose next run landed on the same weekday (a machine asleep between)
  // died the same way.
  // Two different questions, and they were sharing one variable. The DATE
  // answers "have I already primed this slot" — a weekday index comes round
  // every seven days, which is what killed a single-day schedule. The
  // WEEKDAY answers "is today one of the chosen days", and passing it a date
  // string meant days.includes() never matched and nothing ever fired.
  const dayKey = prime.dayKey(now);
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  const slot = prime.dueSlot({
    times: config.primeAt,
    days: config.primeDays,
    weekday: now.getDay(),
    minutesNow,
    lastSlot: lastPrime.day === dayKey ? lastPrime.slot : null,
    sessionOpen: sessionOpen()
  });

  // Chain mode: whenever no window is running, start one. Deliberately
  // unconditional — no schedule, no working hours. The boundaries then drift
  // about five hours a day, which is the trade being made knowingly.
  const chaining = config.primeChain && !sessionOpen();
  if (slot === null && !chaining) return;

  priming = true;
  if (slot !== null) {
    // Recorded BEFORE the attempt: a crash mid-send must not leave the slot
    // armed to fire again on the next tick.
    lastPrime = { day: dayKey, slot };
    store.save({ lastPrime });
  }
  const what = slot !== null ? `prime ${prime.formatSlot(slot)}` : 'prime chain';
  try {
    const bin = await resolveClaude();
    if (!bin) {
      trace(`${what}: Claude Code not found; nothing sent`);
      primeFailUntil = Date.now() + PRIME_RETRY_MS;
      return;
    }
    trace(`${what}: opening a window (${config.primeModel})`);
    const failed = await new Promise((resolve) => {
      execFile(bin, primeArgs(), { timeout: 90000, killSignal: 'SIGKILL' }, (err) => {
        if (err) trace(`${what}: failed — ${err.message}`);
        resolve(Boolean(err));
      });
    });
    await verifyingRefresh('prime');
    if (failed || !sessionOpen()) {
      // Without this a chain whose prime keeps failing would try again on
      // every poll, forever, because no window ever opens.
      primeFailUntil = Date.now() + PRIME_RETRY_MS;
      trace(`${what}: no window opened; next attempt in ${PRIME_RETRY_MS / 60000} min`);
    } else {
      trace(`${what}: window open until ${sessionEndsAt()}`);
    }
  } finally {
    priming = false;
  }
}

/**
 * Open a window right now, by hand. Refuses when one is already running —
 * the message could not restart it, so the only effect would be spending
 * quota — and says so rather than appearing to do nothing.
 */
async function primeNow() {
  if (priming) return;
  if (sessionOpen()) { trace('prime now: a window is already open; nothing sent'); return; }
  priming = true;
  buildMenu(true);
  sendSignIn('priming');
  try {
    const bin = await resolveClaude();
    if (!bin) {
      trace('prime now: Claude Code not found; nothing sent');
      sendSignIn('prime-failed');
      return;
    }
    trace(`prime now: opening a new session window (${config.primeModel})`);
    await new Promise((resolve) => {
      execFile(bin, primeArgs(), { timeout: 90000, killSignal: 'SIGKILL' }, (err) => {
        if (err) trace(`prime now: failed — ${err.message}`);
        resolve();
      });
    });
    await verifyingRefresh('prime-now');
    sendSignIn(sessionOpen() ? 'primed' : 'prime-failed');
  } finally {
    priming = false;
    buildMenu(true);
  }
}

/**
 * The whole auto-open choice, applied as one value: off, a time, or chain.
 * Held as two settings it could land half-applied — a time selected while
 * chain stayed on, where chain then wins and the click looks ignored.
 */
let rememberedPrimeAt = '';
function setPrimeMode(mode) {
  // Chaining clears primeAt on disk on purpose — a time stored beside chain
  // looks like it applied. But the user did not throw it away, and switching
  // to chain and back was silently resetting 06:30 to 08:00.
  if (config.primeAt.length) rememberedPrimeAt = config.primeAt[0];
  const known = config.primeAt.length ? config.primeAt
    : rememberedPrimeAt ? [rememberedPrimeAt] : [];
  const { chain, times } = prime.resolveMode(mode, known);
  config.primeChain = chain;
  config.primeAt = times;
  saveConfig({ primeChain: chain, primeAt: times });
  primeFailUntil = 0;
  trace(chain ? 'auto-open: whenever the current window ends'
    : times.length ? `auto-open: ${times[0]}`
    : 'auto-open: off');
  armPrimeTimer();
  buildMenu(true);
  pushUsage();
  if (chain || times.length) checkPrime();
}

/** Applied live, so the choice takes effect without a restart. */
function setContentProtection(on) {
  config.contentProtection = on === true;
  saveConfig({ contentProtection: config.contentProtection });
  if (win && !win.isDestroyed()) win.setContentProtection(config.contentProtection);
  trace(`content protection: ${config.contentProtection ? 'on (hidden from capture)' : 'off (visible in capture)'}`);
  buildMenu(true);
}

/** Turn one limit on or off in the band. The rules — canonical order, at
    most three, never empty — live in config.js so they can be tested. */
function setWingSource(name) {
  config.wingSources = toggleSource(config.wingSources, name);
  saveConfig({ wingSources: config.wingSources });
  trace(`chips: ${config.wingSources.join(', ')}`);
  pushUsage();
}

function setWingInfo(mode) {
  const next = ['off', 'remaining', 'ends'].includes(mode) ? mode : 'off';
  config.wingInfo = next;
  saveConfig({ wingInfo: next });
  trace(`chips show: ${next}`);
  pushUsage();
}

/** A nudged time. Changing it re-arms today's slot, so a time you just moved
    to can still fire today rather than waiting until tomorrow. */
function setPrimeTimeValue(time) {
  config.primeAt = [time];
  config.primeChain = false;
  lastPrime = { day: null, slot: null };
  saveConfig({ primeAt: config.primeAt, primeChain: false });
  store.save({ lastPrime });
  trace(`auto-open: ${time}`);
  armPrimeTimer();
  buildMenu(true);
  pushUsage();
  checkPrime();
}

function setPrimeDays(days) {
  config.primeDays = days;
  saveConfig({ primeDays: days });
  trace(`auto-open days: ${days.length ? days.join(',') : 'none'}`);
  buildMenu(true);
  pushUsage();
}

/**
 * Attach everything the panel needs that is settings, not usage.
 *
 * These used to be written at the end of refresh(), which meant a launch
 * that restored a backoff — and therefore deferred its first fetch — sent a
 * reading with none of them, and the panel quietly dropped its whole
 * controls section until the first request finally landed.
 */
function decorate(d) {
  d.alertAt = Array.isArray(config.alertAt) ? config.alertAt : [];
  d.primeNote = primeNote();
  // Not the cache's `ok`: a stale payload is `{...lastGood, stale:true}`, so
  // `ok` is the last GOOD reading's. Offering to spend a real message on the
  // strength of a reading the same panel is flagging as unreliable — and at
  // launch, before any fetch at all. sessionKnowable() for the same reason
  // the schedule requires it: without a session gauge, "no window is open"
  // is not a fact, and the button would spend a message to disprove it.
  d.canPrime = d.ok === true && d.stale !== true && sessionKnowable() && !sessionOpen();
  d.accountLive = lastData.accountLive;
  // The sign-in nudge costs a five-hour window unless one is already open,
  // and the button says so — which it can only do if it is told.
  d.sessionOpen = sessionOpen();
  d.wingInfo = config.wingInfo;
  d.wingSources = config.wingSources;
  d.prime = {
    at: config.primeAt[0] || '',
    days: config.primeDays,
    chain: config.primeChain,
    model: config.primeModel
  };
  return d;
}

/** The one way a reading reaches the renderer. */
function pushUsage() {
  if (ready && win && !win.isDestroyed()) win.webContents.send('usage', decorate(lastData));
}

/** "next at 08:00" / "next Mon 08:00" — so an armed feature says so. */
function primeNote() {
  if (config.primeChain) {
    return sessionOpen()
      ? `new window when this one ends (${sessionEndsAt()})`
      : 'opening a new window…';
  }
  if (!config.primeAt.length) return '';
  const now = new Date();
  const next = prime.nextSlot({
    times: config.primeAt,
    days: config.primeDays,
    weekday: now.getDay(),
    minutesNow: now.getHours() * 60 + now.getMinutes()
  });
  if (!next) return '';
  const when = prime.formatSlot(next.minutes);
  if (next.daysAhead === 0) return `new window at ${when}`;
  if (next.daysAhead === 1) return `new window tomorrow ${when}`;
  const day = new Date(now.getTime() + next.daysAhead * 86400000)
    .toLocaleDateString(app.getLocale() || undefined, { weekday: 'short' });
  return `new window ${day} ${when}`;
}

/** Tell the panel what the sign-in is doing; it collapses out from under it otherwise. */
function sendSignIn(status, detail) {
  if (ready && win && !win.isDestroyed()) win.webContents.send('signin', { status, detail });
}

/**
 * Hand the login to a human, in a Terminal window.
 *
 * `claude auth login`, not bare `claude`: a full session would start every
 * MCP server the user has configured, and Terminal would then ask, in its
 * own name, for their Downloads and their music library. A login needs none
 * of that.
 *
 * The path is passed as an argument rather than interpolated into the
 * script — building AppleScript by concatenation breaks on a space and
 * quotes badly on anything worse.
 */
function openLoginTerminal(bin) {
  trace('sign-in: opening Terminal for an interactive login');
  // A login is now EXPECTED: watch the credentials hard for a few minutes,
  // so the widget lights up the moment the browser round-trip lands rather
  // than at the next timer.
  credWatch.expectLogin();
  execFile('/usr/bin/osascript', [
    '-e', 'on run argv',
    '-e', 'tell application "Terminal" to activate',
    '-e', 'tell application "Terminal" to do script ((quoted form of item 1 of argv) & " auth login")',
    '-e', 'end run',
    bin || 'claude'
  ], { timeout: 8000 }, (err) => {
    if (err) trace(`sign-in: could not open Terminal: ${err.message}`);
  });
}

async function signInViaClaudeCode() {
  if (signingIn) return;
  signingIn = true;
  // Hold the panel open for the duration: collapse is cursor-driven, so the
  // only progress indicator vanished the moment the mouse moved off the
  // button — leaving the whole wait as apparent nothing.
  machine = { ...machine, busy: true };
  if (canShowIsland()) {
    const r = I.promote(machine, Date.now());
    machine = r.m;
    applyEffects(r.effects);
  }
  sendSignIn('working');
  updateTray();
  try {
    const bin = await resolveClaude();

    // Claude Code may simply not be here — a fresh machine, an install the
    // resolver cannot see. Opening Terminal to run a command that does not
    // exist ends in "command not found", which reads as our bug and helps
    // nobody. Name the real next step instead, and only open the browser on
    // the click that asked for it — the same two-step the Terminal uses.
    // Re-resolving on that second click is on purpose: if Claude Code was
    // installed in the meantime, the flow continues as a normal sign-in.
    if (!bin) {
      if (pendingInstall) {
        pendingInstall = false;
        trace('sign-in: no claude binary, opening the install page');
        openExternal(CLAUDE_INSTALL_URL);
        sendSignIn(null);
      } else {
        pendingInstall = true;
        trace('sign-in: no claude binary found');
        sendSignIn('no-claude');
      }
      return;
    }
    pendingInstall = false;

    // The button already reads "Open Terminal to finish", which means a nudge
    // was tried and did not work. Running it again on the way to Terminal is
    // ten seconds spent re-learning what the label is already reporting — and
    // ten seconds is exactly how long it felt.
    if (pendingTerminal) {
      trace('sign-in: Terminal already offered, opening it');
      pendingTerminal = false;
      openLoginTerminal(bin);
      // Back to a pressable button. Every entry here sets 'working', and
      // this path returns without another status, which left the panel
      // disabled on "Signing in…" — with no way back if the browser login
      // was abandoned.
      sendSignIn(null);
      return;
    }

    // Ask Claude Code before spending twenty seconds guessing: with no
    // credentials at all, or no account behind them, `claude -p ok` cannot
    // log anyone in — that needs a browser — so trying buys twenty seconds
    // of waiting and the same answer.
    const loggedIn = bin ? await claudeLoggedIn(bin) : null;
    if (loggedIn !== null) trace(`sign-in: claude auth status says loggedIn=${loggedIn}`);
    const nothingToRefresh = lastData.reason === 'no-credentials' || loggedIn === false;
    if (nothingToRefresh) trace('sign-in: nothing to refresh, going straight to Terminal');
    if (bin && !nothingToRefresh) {
      trace('sign-in: nudging Claude Code headlessly');
      const began = Date.now();
      await new Promise((resolve) => {
        execFile(bin, ['-p', 'ok', ...MINIMAL_CLAUDE_ARGS],
          { timeout: NUDGE_TIMEOUT_MS, killSignal: 'SIGKILL' }, (err) => {
          if (err) trace(`sign-in: nudge failed after ${Math.round((Date.now() - began) / 1000)}s: ${err.message}`);
          resolve();
        });
      });
      // A forced refresh is still floored five seconds off the last one, and
      // a hover a moment before the click can eat that. Held, it returns
      // false and leaves the OLD reason standing — which this code would
      // otherwise read as "the nudge failed" and send someone to Terminal to
      // fix a token that had just been fixed.
      await verifyingRefresh('sign-in');
      if (!credProblem()) {
        trace('sign-in: token refreshed, gauges live');
        pendingTerminal = false;
        sendSignIn('done');
        return;
      }
    }
    // A real login needs a browser and a person. Opening Terminal unasked
    // steals focus and types a command, which is indistinguishable from
    // malware — so the panel asks first and the user presses the button.
    sendSignIn('needs-terminal');
    // The second click existed so Terminal never opened unasked. When the
    // button itself reads "Open Terminal to sign in", it has been asked.
    if (!nothingToRefresh) { pendingTerminal = true; return; }
    openLoginTerminal(bin);
    sendSignIn(null);
  } finally {
    signingIn = false;
    machine = { ...machine, busy: false };
    updateTray();
  }
}

// --- Tray -------------------------------------------------------------------

function updateTray() {
  if (!tray || tray.isDestroyed()) return;
  const session = (lastData.gauges || []).find((g) => g.id === 'session');
  // The old expression tested the gauge FIRST, and a credential failure
  // keeps the last good gauges — so the menu bar went on showing a
  // percentage while the app could not read the account at all, including
  // one restored from up to a day earlier.
  const label = VM.trayTitle(session, {
    signingIn, reason: lastData.reason, stale: lastData.stale === true
  });
  // The tooltip is the accessible surface: the window is click-through and
  // unfocusable, so for a VoiceOver user this is the only place the numbers
  // exist at all. It used to be the constant string "Limen".
  const detail = (lastData.gauges || [])
    .map((g) => `${VM.rowLabel(g)}: ${g.percent}%`).join('\n');
  tray.setToolTip(detail ? `Limen\n${detail}` : 'Limen');
  if (process.platform === 'darwin') tray.setTitle(` ${label}`);
  buildMenu();
}

/**
 * The login item's state, cached.
 *
 * On a checkout install this forks `launchctl` synchronously, and it was
 * called once to build the menu signature — so every refresh, whether or not
 * the menu changed, blocked the process that samples the cursor every 40 ms.
 * The answer only changes when this app changes it, or when someone edits
 * launchd from outside, which the next forced rebuild picks up.
 */
let loginItemCache;
function loginItemEnabled() {
  if (loginItemCache === undefined) loginItemCache = autostart.isEnabled();
  return loginItemCache;
}

/**
 * Is there anywhere to draw the island at all?
 *
 * In clamshell with externalDisplays 'off' there is not, and poll() returns
 * before the state machine ticks — so anything that opened the island there
 * put it on the excluded screen with nothing able to close it again. The
 * tray item was gated; the keyboard shortcut, the peek and the sign-in were
 * not.
 */
function canShowIsland() {
  return Boolean(islandDisplay());
}

/**
 * How long until a forced refresh would be allowed, as words, or '' if it
 * would go through right now. The gate lives in schedule.js; asking it the
 * question here is what lets the menu stop offering what it cannot do.
 */
function refreshHeldFor() {
  if (inFlight) return 'a moment';
  const now = Date.now();
  if (mayFetch({ now, nextAllowedAt, serverImposed, lastFetchAt, force: true })) return '';
  const mins = Math.ceil(Math.max(nextAllowedAt - now, FORCE_FLOOR_MS - (now - lastFetchAt)) / 60000);
  return mins > 1 ? `${mins} min` : 'a moment';
}

/** Rebuilding a context menu while it is open dismisses it under the cursor. */
let menuSignature = null;
function buildMenu(force = false) {
  if (!tray || tray.isDestroyed()) return;
  const paused = alertsPausedUntil > Date.now();
  const signature = [
    credProblem(), signingIn, pendingTerminal, pendingInstall, machine.wings, paused, primeNote(), config.contentProtection,
    priming, sessionOpen(), config.primeAt[0] || '', config.primeDays.length,
    (lastData.gauges || []).length > 0, lastData.ok === true, loginItemEnabled(),
    refreshHeldFor(), canShowIsland()
  ].join('|');
  if (!force && signature === menuSignature) return;

  tray.setContextMenu(Menu.buildFromTemplate([
    ...(credProblem() ? [
      {
        // The panel's button changes to name Terminal before it opens one;
        // this item never did, so the second click activated Terminal and
        // typed a command from a label that had promised a sign-in.
        label: signingIn ? 'Signing in…'
          : pendingInstall ? 'Open the Claude Code install page'
          : pendingTerminal ? 'Open Terminal to sign in'
          : 'Sign in with Claude Code',
        enabled: !signingIn,
        click: () => signInViaClaudeCode()
      },
      { type: 'separator' }
    ] : []),
    // The panel was hover-only and no menu item opened it, so a user who
    // never guessed the gesture could not reach the data at all.
    {
      label: 'Show usage',
      // Nothing to show it on: in clamshell with externalDisplays 'off' the
      // island has no display, and opening the panel anyway drew it on the
      // screen the setting excluded — where nothing could then dismiss it,
      // because poll() returns before the state machine ever ticks.
      enabled: canShowIsland(),
      accelerator: liveShortcuts['show usage'] || undefined,
      click: () => showPanel()
    },
    {
      // Enabled only when a fetch would actually happen. Under a 429 this
      // was a menu item that did nothing, silently, for up to fifteen
      // minutes — the click was gated inside refresh() where nobody could
      // see it.
      label: refreshHeldFor() ? `Refresh in ${refreshHeldFor()}` : 'Refresh now',
      enabled: !refreshHeldFor(),
      click: () => refresh('tray', true)
    },
    { type: 'separator' },
    {
      label: 'Show chips in the menu bar',
      type: 'checkbox',
      checked: machine.wings,
      accelerator: liveShortcuts['menu-bar chips'] || undefined,
      click: () => toggleWings()
    },
    {
      label: 'Session window',
      submenu: [
        {
          // The 5h window starts at your first message, so opening one at a
          // chosen time puts its boundaries where your day needs them.
          label: priming ? 'Opening a window…'
            : sessionOpen() ? `Open until ${sessionEndsAt()}`
            : 'Open one now',
          // `lastData.ok` matters: before the first successful read, and on
          // any failure, sessionOpen() is false because there are no gauges
          // — not because no window is running. The panel's own gate has
          // always required ok; this one did not, and spent a real message
          // to find out. Same rule as canPrime now, all of it: not stale,
          // and only when the session gauge exists to verify against.
          enabled: !priming && lastData.ok === true && lastData.stale !== true &&
            sessionKnowable() && !sessionOpen() && !credProblem(),
          click: () => primeNow()
        },
        { type: 'separator' },
        { label: 'Open one automatically', enabled: false },
        {
          label: 'Never',
          type: 'radio',
          checked: !config.primeChain && !config.primeAt.length,
          click: () => setPrimeMode('')
        },
        {
          // The exact time and days are set in the panel, where a stepper
          // and seven day toggles fit. A menu that closes on every click is
          // the wrong place to nudge a number.
          label: config.primeAt.length
            ? `At ${config.primeAt[0]}${daysLabel()}`
            : 'At a time (choose it in the panel)',
          type: 'radio',
          checked: !config.primeChain && config.primeAt.length > 0,
          click: () => setPrimeMode('at')
        },
        {
          label: 'Whenever the current one ends',
          type: 'radio',
          checked: config.primeChain,
          click: () => setPrimeMode('chain')
        }
      ]
    },
    {
      label: paused ? 'Alerts paused' : 'Pause alerts',
      submenu: [
        { label: 'For 1 hour', click: () => pauseAlerts(60) },
        { label: 'For 12 hours', click: () => pauseAlerts(60 * 12) },
        { label: 'Resume alerts', enabled: paused, click: () => pauseAlerts(0) }
      ]
    },
    { type: 'separator' },
    {
      label: 'Start at login',
      type: 'checkbox',
      checked: loginItemEnabled() === true,
      enabled: loginItemEnabled() !== null,
      click: (item) => { autostart.setEnabled(item.checked); loginItemCache = undefined; buildMenu(true); }
    },
    {
      // On by default because the island sits at the top of the screen
      // during exactly the moments people demo and record, and it is showing
      // account usage. But it is the reason the widget is missing from your
      // own screenshots too, so it has to be a visible switch.
      label: 'Show in screenshots and screen sharing',
      type: 'checkbox',
      checked: config.contentProtection === false,
      click: (item) => setContentProtection(!item.checked)
    },
    { label: 'Reload settings', click: () => reloadConfig() },
    { label: 'Show the config file', click: () => revealConfig() },
    { type: 'separator' },
    { label: 'About Limen', click: () => showAbout() },
    // The About panel is native, and nothing in it is clickable — so the
    // handle it names gets an item that actually goes there.
    { label: '@billybowss on X', click: () => openExternal('https://x.com/billybowss') },
    { type: 'separator' },
    {
      // A checkout without a LaunchAgent has nothing to restart, and the
      // click used to do nothing at all, silently.
      label: 'Restart the island',
      click: () => { if (!autostart.restart()) trace('restart: nothing to restart (no login item)'); }
    },
    { label: 'Quit', click: () => app.quit() }
  ]));
  // Recorded only once the menu is actually installed. Set before, a throw
  // inside buildFromTemplate left the cache claiming this signature was on
  // screen, and every later unforced rebuild returned early — a tray frozen
  // on a menu that was never drawn.
  menuSignature = signature;
}

/** "weekdays" / "every day" / "Mon, Wed" — for the tray, which has no room. */
function daysLabel() {
  const d = [...(config.primeDays || [])].sort((a, b) => a - b);
  if (!d.length) return ' — no days selected';
  if (d.length === 7) return ' every day';
  if (d.join() === '1,2,3,4,5') return ' on weekdays';
  if (d.join() === '0,6') return ' at weekends';
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return ` on ${d.map((i) => names[i]).join(', ')}`;
}

/** Open the panel deliberately — from the tray, or the keyboard. */
function showPanel() {
  if (!canShowIsland()) {
    trace('show usage: no display for the island; nothing to show it on');
    return;
  }
  const r = I.promote(machine, Date.now());
  machine = r.m;
  applyEffects(r.effects);
  // Forced on an unreadable account for the same reason as the reveal: a
  // deliberate open is a person asking now, and no request is being paced.
  refresh('shown', credProblem());
}

/**
 * The shortcut toggles where the tray item only shows: a keyboard user needs
 * a route OUT as much as one in, and the promoted panel now waits for a
 * cursor that a keyboard user is never going to move.
 */
function toggleShownPanel() {
  if (machine.state === I.EXPANDED) {
    const r = I.toggle(machine, Date.now());
    machine = r.m;
    applyEffects(r.effects);
    return;
  }
  showPanel();
}

/**
 * Two bindings, because hover was the only way in: a keyboard user, a
 * VoiceOver user, or anyone who cannot hold a cursor steady had no route to
 * their own quota at all.
 */
// Which accelerators the OS actually gave us. `register()` returns false
// for a binding something else already holds — the menu was advertising the
// keystroke anyway, next to an item that keystroke could never reach.
let liveShortcuts = {};
function registerShortcuts() {
  liveShortcuts = {};
  const bind = (accel, fn, what) => {
    if (!accel || !accel.trim()) return;
    try {
      // register() RETURNS false for a taken binding rather than throwing,
      // so a bare catch would report nothing and the shortcut would simply
      // not exist, with no diagnosis anywhere.
      if (globalShortcut.register(accel, fn)) liveShortcuts[what] = accel;
      else trace(`shortcut "${accel}" (${what}) is already taken; use the tray menu`);
    } catch (err) {
      trace(`shortcut "${accel}" (${what}) rejected: ${err.message}`);
    }
  };
  bind(config.shortcut, () => toggleWings(), 'menu-bar chips');
  bind(config.showShortcut, () => toggleShownPanel(), 'show usage');
}

let alertsPausedUntil = store.read().alertsPausedUntil || 0;
function pauseAlerts(minutes) {
  alertsPausedUntil = minutes ? Date.now() + minutes * 60000 : 0;
  store.save({ alertsPausedUntil });
  trace(minutes ? `alerts paused for ${minutes} min` : 'alerts resumed');
  buildMenu(true);
}

/**
 * Apply the config file without a restart. Editing JSON *and* restarting to
 * change one threshold is the worst of both worlds — and the tray invites
 * the edit.
 */
function reloadConfig() {
  loginItemCache = undefined;   // the file may name a different install
  const before = {
    shortcut: config.shortcut,
    showShortcut: config.showShortcut,
    wings: config.wings,
    contentProtection: config.contentProtection
  };
  config = loadConfig();
  machine.wings = config.wings === true;

  // BOTH shortcuts: comparing only the first left a changed showShortcut
  // unregistered, with the old binding still live and no trace of either.
  if (before.shortcut !== config.shortcut || before.showShortcut !== config.showShortcut) {
    globalShortcut.unregisterAll();
    registerShortcuts();
  }
  // The menu redrew this checkbox from the new config while the window kept
  // the old setting, so the tray reported a protection that was not applied.
  if (before.contentProtection !== config.contentProtection &&
      win && !win.isDestroyed()) {
    win.setContentProtection(config.contentProtection);
    trace(`content protection: ${config.contentProtection ? 'on' : 'off'} (reloaded)`);
  }
  // islandDisplay() FIRST: it is what reads the new externalDisplays and
  // displayId, and currentDisplay() won whenever the old screen was still
  // attached — so the two settings with no tray control had no live
  // application path at all.
  const target = islandDisplay();
  if (target) placeOn(target);
  else {
    trace('settings reloaded: no display for the island; hiding');
    // As on startup and display change: with the id left set, poll() keeps
    // driving the hover machine on the display the setting just excluded,
    // and the next dwell re-shows the window this branch is hiding.
    currentDisplayId = null;
    if (win && !win.isDestroyed()) win.hide();
  }
  sendGeometry();
  // Turning wings on in the file has to show the window, exactly as the
  // tray toggle does. Sending 'wings' to a hidden window drew chips nobody
  // could see, under a checkbox that said they were on.
  if (machine.wings && target && win && !win.isDestroyed()) {
    clearTimeout(hideTimer);
    win.showInactive();
  }
  if (ready && win && !win.isDestroyed()) win.webContents.send('wings', machine.wings);
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh('schedule'), 1000);
  // The file is where primeAt/primeChain get hand-edited, and the dedicated
  // timer was only armed at startup and by the tray/panel setters — so a
  // reloaded schedule fell back to the refresh loop's cadence, which is the
  // exact slot-skipping the timer exists to prevent.
  armPrimeTimer();
  buildMenu(true);
  trace('settings reloaded');
}

function toggleWings() {
  const r = I.toggleWings(machine);
  machine = r.m;
  applyEffects(r.effects);
  config.wings = machine.wings;
  saveConfig({ wings: machine.wings });
  buildMenu();
}

/**
 * What the app says about itself, in the panel macOS draws for every app.
 *
 * Only applicationName, applicationVersion, version, copyright and credits
 * reach it on macOS — `website` and `authors` are Linux-only keys — and none
 * of it is clickable, so every address here is also written out in full for
 * someone reading rather than clicking.
 *
 * The upstream MIT notice lives in LICENSE, which is where the licence
 * requires it and where it survives being redistributed. This panel is the
 * author's line, not the legal one.
 */
function setAboutPanel() {
  const { version } = require('../package.json');
  app.setAboutPanelOptions({
    applicationName: 'Limen',
    applicationVersion: version,
    copyright: `© ${new Date().getFullYear()} @billybowss · MIT`,
    credits: [
      'Your Claude Code usage limits, in the notch.',
      '',
      'Made by @billybowss — x.com/billybowss',
      'github.com/bilalmbt/limen'
    ].join('\n')
  });
}

/**
 * The one moment the island takes focus.
 *
 * Everything else here is built so the window never steals a keystroke, but
 * the About panel is a real window: opened without focus it lands behind
 * whatever you were doing, and clicking a menu item that appears to do
 * nothing is worse than not having the item.
 */
function showAbout() {
  app.focus({ steal: true });
  app.showAboutPanel();
}

/** A link the user asked for, opened in their browser rather than in ours. */
async function openExternal(url) {
  const { shell } = require('electron');
  try {
    await shell.openExternal(url);
  } catch (err) {
    trace(`could not open ${url}: ${(err && err.message) || err}`);
  }
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
  // A naked percentage beside the battery percentage is unattributable —
  // the icon is what makes the number belong to something.
  let image = nativeImage.createFromPath(
    path.join(__dirname, 'renderer', 'trayTemplate.png'));
  if (image.isEmpty()) image = nativeImage.createEmpty();
  else image.setTemplateImage(true);   // macOS recolours it per menu-bar theme
  try {
    tray = new Tray(image);
  } catch (_) {
    return;   // no tray on this session: carry on without one
  }
  updateTray();
}

// --- Capture & demo: the visual states, reproducibly ------------------------

const FIXTURE = {
  ok: true,
  fetchedAt: Date.now() - 60000,
  alertAt: [80, 95],
  wingInfo: 'remaining',
  wingSources: ['session', 'weekly'],
  plan: 'Max 20x',
  // The real panel always carries a schedule — decorate() sets one on every
  // reading — so a scene without it was showing a panel that cannot happen,
  // and the band's own controls appeared in no scene at all.
  prime: { at: '', days: [1, 2, 3, 4, 5], chain: false, model: 'haiku' },
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
  // 'priming' is in the list because the self-test clicks through this scene:
  // two of the panel's controls now decide what the CHIPS show, and a control
  // whose row is hidden cannot be clicked to prove its wiring.
  const WITH_WINGS = ['wings', 'wings-low', 'wings-high', 'wings-week', 'wings-three',
    'full', 'full-one', 'full-three', 'collapse', 'priming'];
  send('wings', WITH_WINGS.includes(scene));
  if (scene === 'wings') {
    send('usage', FIXTURE);
  } else if (scene === 'wings-week') {
    // The case the count could not express: the session beside the weekly
    // quota, whatever the API happens to be flagging as active.
    send('usage', FIXTURE);
  } else if (scene === 'wings-three') {
    // The widest band the settings allow — two limits sharing the right
    // chip. If the band is ever going to crowd the menu bar, it is here.
    send('usage', { ...FIXTURE, wingSources: ['session', 'weekly', 'model'] });
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
  } else if (scene === 'full-one') {
    // One source: the band is a single chip, and the control greys that
    // source out — turning off the last one would leave nothing to draw.
    send('usage', { ...FIXTURE, wingSources: ['model'] });
    send('panel', true);
  } else if (scene === 'full-three') {
    // Three: the cap. The fourth source is greyed for the opposite reason.
    send('usage', { ...FIXTURE, wingSources: ['session', 'weekly', 'model'] });
    send('panel', true);
  } else if (scene === 'wings-low' || scene === 'wings-high') {
    // The two ends of the scale: a nearly-empty ring is the case where a
    // menu-bar gauge stops carrying information, and a full one is where
    // the tone has to shout.
    const low = scene === 'wings-low';
    send('usage', {
      ...FIXTURE,
      gauges: [
        { ...FIXTURE.gauges[0], percent: low ? 3 : 97 },
        { ...FIXTURE.gauges[2], percent: low ? 8 : 100 }
      ]
    });
  } else if (scene === 'priming') {
    // No window running: the one moment the button would do something.
    send('usage', {
      ...FIXTURE,
      gauges: FIXTURE.gauges.map((g) => g.id === 'session' ? { ...g, percent: 0 } : g),
      canPrime: true,
      primeNote: 'new window tomorrow 08:00',
      prime: { at: '08:00', days: [1,2,3,4,5], chain: false, model: 'haiku' }
    });
    send('panel', true);
  } else if (scene === 'pace') {
    // A quota on course to run out before its window resets.
    send('usage', {
      ...FIXTURE,
      trend: { session: { rate: 0.6, exhaustsInMs: 44 * 60000, beforeReset: true } }
    });
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

/**
 * Exercise the panel's controls without a mouse.
 *
 * Clicking is the one path unit tests cannot reach, and it has two halves
 * that fail identically from the outside: the renderer wiring (listener →
 * preload → IPC → handler) and the OS actually delivering a click to a
 * non-activating, click-through-by-default window. This drives the first
 * half directly, so a failure tells you which one is broken.
 */
function runSelfTest() {
  win.webContents.on('did-finish-load', async () => {
    playScene('priming');
    await new Promise((r) => setTimeout(r, 800));
    // ISLAND_SELFTEST names the control to click, so any button can be
    // exercised without a mouse.
    const selector = process.env.ISLAND_SELFTEST === '1'
      ? '#primebar .chips.mode .chip[data-mode="at"]'
      : process.env.ISLAND_SELFTEST;
    const found = await win.webContents.executeJavaScript(`(() => {
      const target = document.querySelector(${JSON.stringify(selector)});
      if (!target) return { found: false, selector: ${JSON.stringify(selector)} };
      const r = target.getBoundingClientRect();
      target.click();
      return {
        found: true,
        text: target.textContent,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        winHeight: window.innerHeight,
        insideWindow: r.bottom <= window.innerHeight
      };
    })()`);
    trace(`selftest: ${JSON.stringify(found)}`);
    setTimeout(() => {
      trace(`selftest: wingSources=${config.wingSources.join('+')} wingInfo=${config.wingInfo} ` +
        `primeAt=${JSON.stringify(config.primeAt)} chain=${config.primeChain}`);
      app.exit(0);
    }, 600);
  });
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
if (!DEMO && !CAPTURE && !process.env.ISLAND_SELFTEST &&
    !app.requestSingleInstanceLock()) app.exit(0);

process.on('uncaughtException', (err) => trace(`uncaught: ${err && err.stack}`));
process.on('unhandledRejection', (err) => trace(`unhandled rejection: ${err}`));

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  // Before anything worth tracing happens, and only for an installed copy:
  // a checkout already has a terminal to write to.
  if (app.isPackaged) { openLog(); trace(`log: ${LOG_PATH}`); }
  setAboutPanel();

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

  if (process.env.ISLAND_SELFTEST) { runSelfTest(); return; }
  if (CAPTURE) { runCapture(); return; }
  if (DEMO) {
    // A showcase, nothing else: no tray, no fetching, no cursor sampling.
    // The real refresh loop would overwrite the scene with live data.
    // One shortcut all the same: a packaged copy launched with --demo has no
    // tray, no dock icon and no terminal, which made the showcase
    // unquittable outside Activity Monitor.
    globalShortcut.register('CommandOrControl+Q', () => app.quit());
    win.webContents.once('did-finish-load', () => playScene(process.env.ISLAND_SCENE || 'expanded'));
    return;
  }

  createTray();
  armPrimeTimer();
  // Real runs only: a capture or demo never fetches, so it has no sign-in
  // to notice. Started before the first refresh so a launch straight into a
  // credential problem is already being watched.
  credWatch.start();
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
    // A rate-limited remainder is honoured in FULL: nextDelay() has no
    // Retry-After to obey here (it is not persisted), so min-ing with it
    // re-capped a server-imposed hour at fifteen minutes — the exact
    // truncation the schedule module forbids at runtime. The cap stays for
    // our own guesswork; the skew guard alone bounds the server's.
    const delay = !Number.isFinite(remaining)
      ? nextDelay({ ok: false }, failures, config.refreshSeconds)
      : bootReason === 'rate-limited'
        ? Math.max(0, Math.min(remaining, CLOCK_SKEW_MS))
        : Math.max(0, Math.min(remaining, nextDelay({ ok: false }, failures, config.refreshSeconds)));
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

  registerShortcuts();

  // Waking from sleep with hours-old numbers is worse than one extra call —
  // but the failure count is NOT cleared here. Zeroing it would erase the
  // very backoff that survived the sleep, and a machine that wakes often
  // would hammer an endpoint that had already pushed back.
  // A wake with the account unreadable is forced for the reveal's reason:
  // the sign-in may have happened on another machine while this one slept,
  // and the local recheck costs nothing.
  powerMonitor.on('resume', () => refresh('resume', credProblem()));
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
    screen.on(event, onDisplaysChanged);
  }
});

// Clicks on the island's surface arrive here from the renderer.
// The renderer reports the island's real drawn bounds after every paint.
ipcMain.on('island-surface', (e, rects) => {
  if (!win || win.isDestroyed() || e.sender !== win.webContents) return;
  const ok = (r) => r && ['left', 'top', 'right', 'bottom'].every((k) => Number.isFinite(r[k]));
  surfaceRects = Array.isArray(rects) ? rects.filter(ok) : [];
  ensureTallEnough();
});

/**
 * Grow the window to fit what the renderer actually drew.
 *
 * panelHeight() estimates from a row count, but the panel carries optional
 * content — a status strip, a sign-in or open-a-window button, footnotes —
 * and any of them can push it past an estimate. The window then clips its
 * own panel. Growing from the measured surface is the same rule as the hit
 * test: derive from the pixels, do not predict them.
 *
 * Only ever grows; placeOn() recomputes from scratch when the layout
 * genuinely changes, so this cannot ratchet upward or oscillate.
 */
function ensureTallEnough() {
  if (!surfaceRects.length || !win || win.isDestroyed()) return;
  const display = currentDisplay();
  if (!display) return;
  const b = win.getBounds();
  const needed = Math.ceil(Math.max(...surfaceRects.map((r) => r.bottom))) + N.G.windowSlack;
  if (needed <= b.height) return;
  const height = Math.min(needed, display.bounds.height);
  if (height > b.height) win.setBounds({ ...b, height });
}

ipcMain.on('island-action', (e, name, value) => {
  if (!win || win.isDestroyed() || e.sender !== win.webContents) return;
  if (name === 'prime-mode') {
    setPrimeMode(value);
  } else if (name === 'wing-info') {
    setWingInfo(value);
  } else if (name === 'wing-source') {
    setWingSource(value);
  } else if (name === 'prime-step') {
    const field = value && value.field === 'm' ? 'm' : 'h';
    const delta = value && Number(value.delta) < 0 ? -1 : 1;
    setPrimeTimeValue(prime.stepTime(config.primeAt[0] || '08:00', field, delta));
  } else if (name === 'prime-day') {
    setPrimeDays(prime.toggleDay(config.primeDays, Number(value)));
  } else if (name === 'refresh') {
    refresh('button', true);
  } else if (name === 'sign-in') {
    signInViaClaudeCode();
  } else if (name === 'prime') {
    primeNow();
  } else if (name === 'toggle') {
    const was = machine.state;
    const r = I.toggle(machine, Date.now());
    machine = r.m;
    applyEffects(r.effects);
    trace(`band clicked: ${was} -> ${machine.state}`);
  } else if (name === 'expand') {
    const r = I.promote(machine, Date.now());
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
  clearTimeout(peekTimer);
  clearTimeout(primeTimer);
  credWatch.stop();
  globalShortcut.unregisterAll();
});
