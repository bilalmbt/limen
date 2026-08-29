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
 * The flags that keep a headless Claude Code run to itself.
 *
 * Shared, because they were not. The priming path had them and the sign-in
 * path did not, so clicking "Sign in with Claude Code" started the user's
 * ENTIRE Claude Code environment — every MCP server they have configured —
 * as a child of this app. macOS attributes a child's file access to the
 * responsible process, so their servers reaching for Downloads or the media
 * library produced prompts that said "Limen would like to access…", which
 * is precisely the kind of thing that makes a small widget look like
 * spyware.
 */
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
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(file, null, 2) + '\n');
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
  lastData = { ...lastGood, stale: true, reason: 'loading' };
  // Size the window for the restored gauges, or the panel opens clipped
  // for accounts with more than three quotas until the first fetch lands.
  rows = Math.max(1, lastGood.gauges.length);
}

/** The refresh control should reflect a real fetch, not a fixed animation. */
function sendBusy(on) {
  if (ready && win && !win.isDestroyed()) win.webContents.send('busy', on === true);
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
function openLog() {
  try {
    // Truncate on launch past the cap rather than rotating: nobody wants
    // Limen.log.3, and the interesting part is always the current run.
    let flags = 'a';
    try { if (fs.statSync(LOG_PATH).size > LOG_CAP) flags = 'w'; } catch (_) {}
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
    try { logStream.write(line + '\n'); } catch (_) { logStream = null; }
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
    clearInterval(pollTimer);
    clearTimeout(refreshTimer);
  });
  win.webContents.on('render-process-gone', (_e, d) => trace(`renderer gone: ${d.reason}`));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => {
    ready = true;
    sendGeometry();
    win.webContents.send('usage', decorate(lastData));
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
  setPollRate(I.windowVisible(machine) || inHot ? POLL_LIVE : POLL_IDLE);

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
    if (data.ok) {
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
      lastData = lastGood
        ? { ...lastGood, stale: true, reason: data.reason, checkedAt: data.fetchedAt, retryAt: Date.now() + delay }
        : { ...data, retryAt: Date.now() + delay };
      // The plan comes from the credentials, not the endpoint, so a failed
      // fetch still knows it — and a restored reading from yesterday should
      // not claim a plan the account may have changed since.
      if (data.plan) lastData.plan = data.plan;
    }

    logState(data);
    if (data.ok && data.gauges.length) setRows(data.gauges.length);
    // The panel draws threshold marks where the alerts sit, so it needs to
    // know where they are.
    lastData.alertAt = Array.isArray(config.alertAt) ? config.alertAt : [];
    lastData.primeNote = primeNote();
    lastData.canPrime = data.ok && !sessionOpen();
    lastData.wingInfo = config.wingInfo;
    lastData.wingSources = config.wingSources;
    lastData.prime = {
      at: config.primeAt[0] || '',
      days: config.primeDays,
      chain: config.primeChain,
      model: config.primeModel
    };
    if (ready && win && !win.isDestroyed()) win.webContents.send('usage', lastData);
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
function queuePeek(item) {
  peekQueue.push(item);
  if (peekQueue.length > 2) {
    peekQueue.length = 0;
    const r = I.promote(machine);
    machine = r.m;
    applyEffects(r.effects);
    return;
  }
  if (!peekTimer) drainPeeks();
}

function drainPeeks() {
  const item = peekQueue.shift();
  clearTimeout(peekTimer);
  peekTimer = null;
  if (!item) return;

  const r = I.alert(machine, item.gauge.id, Date.now());
  machine = r.m;
  applyEffects(r.effects);
  notify(item);
  if (peekQueue.length) peekTimer = setTimeout(drainPeeks, I.T.peekMs + 400);
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
async function resolveClaude() {
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
    execFile(bin, ['auth', 'status'], { timeout: 5000 }, (err, stdout) => {
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

let signingIn = false;
let pendingTerminal = false;   // the first click nudges; a second opens Terminal

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

/** When the running window ends, for the menu to explain why it is disabled. */
function sessionEndsAt() {
  const g = (lastData.gauges || []).find((x) => x.id === 'session');
  if (!g || !g.resetsAt) return '';
  return new Date(g.resetsAt).toLocaleTimeString(app.getLocale() || undefined,
    { hour: '2-digit', minute: '2-digit' });
}

/**
 * Open a fresh window at a scheduled time, by sending one short message
 * through Claude Code. Checked on the refresh cadence, which is finer than
 * the grace window, so a slot cannot be stepped over.
 */
async function checkPrime() {
  if (priming) return;
  if (!config.primeAt.length && !config.primeChain) return;
  // Nothing to prime with, and nothing worth spending: a broken sign-in
  // would just produce a failed message.
  if (credProblem() || !lastData.ok) return;
  if (Date.now() < primeFailUntil) return;

  const now = new Date();
  const today = now.getDay();
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  const slot = prime.dueSlot({
    times: config.primeAt,
    days: config.primeDays,
    weekday: today,
    minutesNow,
    lastSlot: lastPrime.day === today ? lastPrime.slot : null,
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
    lastPrime = { day: today, slot };
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
      execFile(bin, primeArgs(), { timeout: 90000 }, (err) => {
        if (err) trace(`${what}: failed — ${err.message}`);
        resolve(Boolean(err));
      });
    });
    await refresh('prime', true);
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
      execFile(bin, primeArgs(), { timeout: 90000 }, (err) => {
        if (err) trace(`prime now: failed — ${err.message}`);
        resolve();
      });
    });
    await refresh('prime-now', true);
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
function setPrimeMode(mode) {
  const { chain, times } = prime.resolveMode(mode, config.primeAt);
  config.primeChain = chain;
  config.primeAt = times;
  saveConfig({ primeChain: chain, primeAt: times });
  primeFailUntil = 0;
  trace(chain ? 'auto-open: whenever the current window ends'
    : times.length ? `auto-open: ${times[0]}`
    : 'auto-open: off');
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
  d.canPrime = Boolean(d.ok) && !sessionOpen();
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

async function signInViaClaudeCode() {
  if (signingIn) return;
  signingIn = true;
  // Hold the panel open for the duration: collapse is cursor-driven, so the
  // only progress indicator vanished the moment the mouse moved off the
  // button — leaving the whole wait as apparent nothing.
  machine = { ...machine, busy: true };
  const r = I.promote(machine);
  machine = r.m;
  applyEffects(r.effects);
  sendSignIn('working');
  updateTray();
  try {
    const bin = await resolveClaude();
    // Nothing to refresh means nothing to nudge: with no credentials at all,
    // `claude -p ok` cannot log anyone in — that needs a browser — so trying
    // buys twenty seconds of waiting and the same answer. Straight to the
    // step that works, which the button has already named.
    // Ask Claude Code before spending twenty seconds guessing. Not logged in
    // at all means the nudge cannot work, whatever our own read said.
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
      await refresh('sign-in', true);
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
    if (!nothingToRefresh && !pendingTerminal) { pendingTerminal = true; return; }
    pendingTerminal = false;
    // A real login needs a human and a browser. The path is passed as an
    // argument rather than interpolated into the script: building AppleScript
    // by concatenation breaks on a space and quotes badly on anything worse.
    trace('sign-in: opening Terminal for an interactive login');
    // `claude auth login`, not bare `claude`. Opening a full session starts
    // the user's whole Claude Code environment — every MCP server — and
    // Terminal then asks, in its own name, for their Downloads, their music
    // library and whatever else those servers reach for. A login flow needs
    // none of it.
    execFile('/usr/bin/osascript', [
      '-e', 'on run argv',
      '-e', 'tell application "Terminal" to activate',
      '-e', 'tell application "Terminal" to do script ((quoted form of item 1 of argv) & " auth login")',
      '-e', 'end run',
      bin || 'claude'
    ], { timeout: 8000 }, (err) => {
      if (err) trace(`sign-in: could not open Terminal: ${err.message}`);
    });
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
  const label = session ? `${session.percent}%`
    : signingIn ? 'signing in…'
    : credProblem() ? 'sign in'
    : '–';
  // The tooltip is the accessible surface: the window is click-through and
  // unfocusable, so for a VoiceOver user this is the only place the numbers
  // exist at all. It used to be the constant string "Limen".
  const detail = (lastData.gauges || [])
    .map((g) => `${VM.rowLabel(g)}: ${g.percent}%`).join('\n');
  tray.setToolTip(detail ? `Limen\n${detail}` : 'Limen');
  if (process.platform === 'darwin') tray.setTitle(` ${label}`);
  buildMenu();
}

/** Rebuilding a context menu while it is open dismisses it under the cursor. */
let menuSignature = null;
function buildMenu(force = false) {
  if (!tray || tray.isDestroyed()) return;
  const paused = alertsPausedUntil > Date.now();
  const signature = [
    credProblem(), signingIn, machine.wings, paused, primeNote(), config.contentProtection,
    priming, sessionOpen(), config.primeAt[0] || '', config.primeDays.length,
    (lastData.gauges || []).length > 0, autostart.isEnabled()
  ].join('|');
  if (!force && signature === menuSignature) return;
  menuSignature = signature;

  tray.setContextMenu(Menu.buildFromTemplate([
    ...(credProblem() ? [
      {
        label: signingIn ? 'Signing in…' : 'Sign in with Claude Code',
        enabled: !signingIn,
        click: () => signInViaClaudeCode()
      },
      { type: 'separator' }
    ] : []),
    // The panel was hover-only and no menu item opened it, so a user who
    // never guessed the gesture could not reach the data at all.
    { label: 'Show usage', click: () => showPanel() },
    { label: 'Refresh now', click: () => refresh('tray', true) },
    { type: 'separator' },
    {
      label: 'Show chips in the menu bar',
      type: 'checkbox',
      checked: machine.wings,
      accelerator: config.shortcut || undefined,
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
          enabled: !priming && !sessionOpen() && !credProblem(),
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
        { label: 'Until tomorrow', click: () => pauseAlerts(60 * 12) },
        { label: 'Resume alerts', enabled: paused, click: () => pauseAlerts(0) }
      ]
    },
    { type: 'separator' },
    {
      label: 'Start at login',
      type: 'checkbox',
      checked: autostart.isEnabled() === true,
      enabled: autostart.isEnabled() !== null,
      click: (item) => { autostart.setEnabled(item.checked); buildMenu(true); }
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
    { label: 'Restart the island', click: () => autostart.restart() },
    { label: 'Quit (until next login)', click: () => app.quit() }
  ]));
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
  const r = I.promote(machine);
  machine = r.m;
  applyEffects(r.effects);
  refresh('shown');
}

/**
 * Two bindings, because hover was the only way in: a keyboard user, a
 * VoiceOver user, or anyone who cannot hold a cursor steady had no route to
 * their own quota at all.
 */
function registerShortcuts() {
  const bind = (accel, fn, what) => {
    if (!accel || !accel.trim()) return;
    try {
      // register() RETURNS false for a taken binding rather than throwing,
      // so a bare catch would report nothing and the shortcut would simply
      // not exist, with no diagnosis anywhere.
      if (!globalShortcut.register(accel, fn)) {
        trace(`shortcut "${accel}" (${what}) is already taken; use the tray menu`);
      }
    } catch (err) {
      trace(`shortcut "${accel}" (${what}) rejected: ${err.message}`);
    }
  };
  bind(config.shortcut, () => toggleWings(), 'menu-bar chips');
  bind(config.showShortcut, () => showPanel(), 'show usage');
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
  const before = { shortcut: config.shortcut, wings: config.wings };
  config = loadConfig();
  machine.wings = config.wings === true;

  if (before.shortcut !== config.shortcut) {
    globalShortcut.unregisterAll();
    registerShortcuts();
  }
  placeOn(currentDisplay() || islandDisplay());
  sendGeometry();
  if (ready && win && !win.isDestroyed()) win.webContents.send('wings', machine.wings);
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh('schedule'), 1000);
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

  registerShortcuts();

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
  clearTimeout(peekTimer);
  globalShortcut.unregisterAll();
});
