'use strict';

// The "⋯" menu: a short list of actions (settings window, alerts and stream
// on/off, copy the stream link, reload, safety notice, about, quit). It is a
// separate window because the overlay window covers the map area, so a
// dropdown inside the toolbar view would be hidden under it.
//
// Created when first opened and closed again after a while hidden: each
// window is a renderer process (~30 MB) that would otherwise sit idle.

const path = require('path');
const { BrowserWindow, ipcMain } = require('electron');

const WIDTH = 280;
const MAX_HEIGHT = 520;
const IDLE_CLOSE_MS = 2 * 60 * 1000;

function setupMenu(overlay) {
  let win = null;
  let idleTimer = null;
  // Clicking "⋯" while the menu is open blurs (hides) it first; that same
  // click must not open it again.
  let hiddenAt = 0;

  const alive = () => win && !win.isDestroyed();

  function hide() {
    if (!alive() || !win.isVisible()) return;
    win.hide();
    hiddenAt = Date.now();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => alive() && !win.isVisible() && win.destroy(), IDLE_CLOSE_MS);
  }

  function create() {
    win = new BrowserWindow({
      width: WIDTH,
      height: 200,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      show: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: overlay.uiWebPreferences(),
    });
    win.loadFile(path.join(__dirname, 'ui', 'menu.html'));
    win.on('blur', hide);
    win.on('closed', () => {
      win = null;
    });
    return new Promise((resolve) => win.once('ready-to-show', resolve));
  }

  ipcMain.on('ui:menu-height', (_event, height) => {
    if (alive()) win.setContentSize(WIDTH, Math.max(60, Math.min(MAX_HEIGHT, Math.ceil(height))));
  });
  ipcMain.on('ui:menu-close', hide);

  // `anchor`: the "⋯" button's rectangle in toolbar (window content) DIP.
  async function toggle(anchor) {
    if (alive() && win.isVisible()) {
      hide();
      return;
    }
    if (Date.now() - hiddenAt < 300) return;
    clearTimeout(idleTimer);
    if (!alive()) await create();
    const content = overlay.mainWindow.getContentBounds();
    const right = anchor ? anchor.x + anchor.width : content.width - 8;
    const x = content.x + Math.max(4, Math.min(right - WIDTH, content.width - WIDTH - 4));
    const y = content.y + (anchor ? anchor.y + anchor.height + 4 : 44);
    win.setPosition(Math.round(x), Math.round(y));
    win.show();
    win.focus();
    win.webContents.send('ui:menu-opened');
  }

  return {
    toggle,
    hide,
    get webContents() {
      return alive() ? win.webContents : null;
    },
  };
}

module.exports = { setupMenu };
