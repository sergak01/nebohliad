'use strict';

// Search box (Ctrl+Alt+F): coordinates are applied directly, anything else is
// geocoded (geocoder.js). The 'ui:search-query' handler also serves the
// location search in the settings panel.

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const geocoder = require('./geocoder');
const log = require('./logger');

const HISTORY_SIZE = 8;
const POINT_ZOOM = 11;
const WIDTH = 560;
const IDLE_CLOSE_MS = 2 * 60 * 1000;

// "50.45, 30.52", "50.45 30.52" or a Google Maps link with "@50.45,30.52".
function parseCoordinates(text) {
  const match =
    text.match(/@(-?\d{1,3}(?:\.\d+)?),\s*(-?\d{1,3}(?:\.\d+)?)/) ||
    text.match(/^\s*(-?\d{1,3}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  if (!match) return null;
  let lat = Number(match[1]);
  let lng = Number(match[2]);
  if (Math.abs(lat) > 90 && Math.abs(lng) <= 90) [lat, lng] = [lng, lat];
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { label: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, center: [lng, lat], zoom: POINT_ZOOM };
}

function setupSearch(overlay) {
  const historyFile = path.join(app.getPath('userData'), 'search-history.json');
  let history = [];
  try {
    history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
  } catch {
    // No history yet.
  }

  // Created when first opened and closed again after a while hidden (a
  // renderer process that would otherwise sit idle).
  let win = null;
  let idleTimer = null;
  const alive = () => win && !win.isDestroyed();

  function hide() {
    if (!alive() || !win.isVisible()) return;
    win.hide();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => alive() && !win.isVisible() && win.destroy(), IDLE_CLOSE_MS);
  }

  function create() {
    win = new BrowserWindow({
      width: WIDTH,
      height: 64,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      show: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: overlay.uiWebPreferences(),
    });
    win.loadFile(path.join(__dirname, 'ui', 'search.html'));
    win.on('blur', hide);
    win.on('closed', () => {
      win = null;
    });
    return new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  }

  function remember(place) {
    history = [place, ...history.filter((p) => p.label !== place.label)].slice(0, HISTORY_SIZE);
    // Synchronous, so quick successive picks cannot land out of order.
    try {
      fs.writeFileSync(historyFile, JSON.stringify(history));
    } catch (error) {
      log.warn('search', 'could not save history', error.message);
    }
  }

  ipcMain.handle('ui:search-query', async (_event, text) => {
    const point = parseCoordinates(text);
    return point ? [point] : geocoder.search(text, overlay.lang);
  });
  ipcMain.on('ui:search-pick', (_event, place) => {
    remember(place);
    hide();
    overlay.goTo(place);
  });
  ipcMain.on('ui:search-clear-pin', () => {
    overlay.setPin(null);
    if (alive()) win.webContents.send('ui:search-open', { history, hasPin: false });
  });
  ipcMain.on('ui:search-close', hide);
  ipcMain.on('ui:search-height', (_event, height) => {
    if (alive()) win.setContentSize(WIDTH, Math.max(48, Math.min(480, Math.ceil(height))));
  });

  async function toggle() {
    if (alive() && win.isVisible()) {
      hide();
      return;
    }
    clearTimeout(idleTimer);
    if (!alive()) await create();
    // The box sits over the map, so the map must be on screen (it may be in
    // the tray or minimized).
    overlay.restoreMain();
    const bounds = overlay.mapBounds();
    win.setPosition(Math.round(bounds.x + (bounds.width - WIDTH) / 2), bounds.y + 32);
    win.webContents.send('ui:search-open', { history, hasPin: Boolean(overlay.pin) });
    win.show();
    win.focus();
  }

  return { toggle };
}

module.exports = { setupSearch, parseCoordinates };
