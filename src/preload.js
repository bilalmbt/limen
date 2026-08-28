'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('island', {
  onGeometry: (fn) => ipcRenderer.on('geometry', (_e, g) => fn(g)),
  onUsage: (fn) => ipcRenderer.on('usage', (_e, d) => fn(d)),
  onPanel: (fn) => ipcRenderer.on('panel', (_e, v) => fn(v)),
  onPeek: (fn) => ipcRenderer.on('peek', (_e, v) => fn(v)),
  onWings: (fn) => ipcRenderer.on('wings', (_e, v) => fn(v)),
  act: (name) => ipcRenderer.send('island-action', String(name)),
  reportSurface: (rect) => ipcRenderer.send('island-surface', rect)
});
