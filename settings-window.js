'use strict';

// Settings window: everything that is not needed all the time, on pages with
// a sidebar (maps, locations and alerts, LAN stream, look, system, about).
// A normal window of its own, opened from the ⋯ menu, the tray or
// Ctrl+Alt+S; it is created on demand and destroyed when closed.

const path = require('path');
const { BrowserWindow, ipcMain } = require('electron');

const PAGES = ['maps', 'locations', 'stream', 'look', 'shortcuts', 'system', 'about'];
const WIDTH = 780;
const HEIGHT = 580;

function setupSettings(overlay, locations, alerts) {
  let win = null;
  let page = 'maps'; // The last page shown, for the next opening.

  function open(target) {
    if (PAGES.includes(target)) page = target;
    if (win && !win.isDestroyed()) {
      win.webContents.send('ui:settings-page', page);
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      return;
    }
    const b = overlay.mainWindow.getBounds();
    win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      minWidth: 620,
      minHeight: 420,
      x: Math.round(b.x + Math.max(0, (b.width - WIDTH) / 2)),
      y: Math.round(b.y + Math.max(0, (b.height - HEIGHT) / 3)),
      title: overlay.lang === 'en' ? 'Settings — Nebohliad' : 'Налаштування — Небогляд',
      icon: path.join(__dirname, 'assets', 'icon.png'),
      backgroundColor: overlay.dark() ? '#111318' : '#f4f5f7',
      autoHideMenuBar: true,
      show: false,
      webPreferences: overlay.uiWebPreferences(),
    });
    win.setMenu(null);
    win.loadFile(path.join(__dirname, 'ui', 'settings.html'), { query: { page } });
    win.once('ready-to-show', () => win.show());
    win.on('closed', () => {
      win = null;
    });
  }

  ipcMain.on('ui:settings-page-shown', (_event, shown) => {
    if (PAGES.includes(shown)) page = shown;
  });
  ipcMain.on('ui:settings-close', () => win?.close());

  ipcMain.handle('ui:location-add', (_event, place) => locations.add(place));
  // Adds the point at the center of the base map.
  ipcMain.handle('ui:location-add-center', () => {
    const center = overlay.baseCenter();
    if (!center) return null;
    const label = `${center[1].toFixed(4)}, ${center[0].toFixed(4)}`;
    return locations.add({ label, center });
  });
  ipcMain.on('ui:location-remove', (_event, id) => locations.remove(id));
  ipcMain.on('ui:location-rename', (_event, { id, name }) => locations.rename(id, name));
  ipcMain.on('ui:location-primary', (_event, id) => locations.setPrimary(id));
  ipcMain.on('ui:location-show', (_event, id) => locations.show(id));
  ipcMain.handle('ui:alerts-test', () => alerts.test());

  return {
    open,
    get webContents() {
      return win && !win.isDestroyed() ? win.webContents : null;
    },
    setTitle: (title) => win?.setTitle(title),
  };
}

module.exports = { setupSettings, PAGES };
