'use strict';
/**
 * The M2 entry gate, kept runnable forever: `npm run spike`.
 *
 * Proves (or refutes, loudly) the two placement claims the island depends on:
 *
 *   1. A frameless, click-through window at the 'status' level can sit flush
 *      with the top of the display — over the menu bar strip — without macOS
 *      clamping it below the menu bar.
 *   2. The bounds survive being shown; any clamping is reported per display.
 *
 * Draws a translucent red band across the top of every display for two
 * seconds so a human can also see it with their own eyes, then prints a
 * JSON verdict and exits 0 (clean) or 1 (clamped somewhere).
 */

const { app, BrowserWindow, screen } = require('electron');

if (app.dock) app.dock.hide();

app.whenReady().then(() => {
  const results = [];
  const windows = [];

  for (const d of screen.getAllDisplays()) {
    const wanted = {
      x: d.bounds.x + Math.round(d.bounds.width / 2) - 220,
      y: d.bounds.y,
      width: 440,
      height: 120
    };
    const w = new BrowserWindow({
      ...wanted,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      focusable: false,
      show: false,
      roundedCorners: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });
    w.setAlwaysOnTop(true, 'status');
    w.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true
    });
    w.setIgnoreMouseEvents(true);
    w.loadURL('data:text/html,<body style="margin:0;height:100vh;background:rgba(255,59,48,0.7);' +
      'display:grid;place-items:center;font-family:sans-serif;color:white;font-size:14px">' +
      'claude-island placement spike</body>');
    w.showInactive();

    const got = w.getBounds();
    results.push({
      display: d.id,
      internal: d.internal === true,
      menuBar: d.workArea.y - d.bounds.y,
      wanted,
      got,
      clamped: got.y !== wanted.y || got.x !== wanted.x ||
        got.width !== wanted.width || got.height !== wanted.height
    });
    windows.push(w);
  }

  setTimeout(() => {
    // Read the bounds again after the window has lived a moment: silent
    // repositioning after show is exactly the failure mode to catch.
    results.forEach((r, i) => {
      const later = windows[i].getBounds();
      r.settled = later;
      r.clamped = r.clamped || later.y !== r.wanted.y;
    });
    const clamped = results.some((r) => r.clamped);
    console.log(JSON.stringify({ spike: 'placement', ok: !clamped, results }, null, 2));
    app.exit(clamped ? 1 : 0);
  }, 2000);
});
