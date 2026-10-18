'use strict';

// The "⋯" menu: a short list of actions (settings window, alerts and stream
// on/off, copy the stream link, reload, safety notice, about, quit). It is a
// separate window because the overlay window covers the map area, so a
// dropdown inside the toolbar view would be hidden under it.

const path = require('path');
const { BrowserWindow, ipcMain } = require('electron');

const WIDTH = 280;
const MAX_HEIGHT = 520;

function setupMenu(overlay) {
  const win = new BrowserWindow({
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

  // Clicking "⋯" while the menu is open blurs (hides) it first; that same
  // click must not open it again.
  let hiddenAt = 0;
  win.on('blur', () => {
    win.hide();
    hiddenAt = Date.now();
  });

  ipcMain.on('ui:menu-height', (_event, height) => {
    win.setContentSize(WIDTH, Math.max(60, Math.min(MAX_HEIGHT, Math.ceil(height))));
  });
  ipcMain.on('ui:menu-close', () => win.hide());

  // `anchor`: the "⋯" button's rectangle in toolbar (window content) DIP.
  function toggle(anchor) {
    if (win.isVisible()) {
      win.hide();
      return;
    }
    if (Date.now() - hiddenAt < 300) return;
    const content = overlay.mainWindow.getContentBounds();
    const right = anchor ? anchor.x + anchor.width : content.width - 8;
    const x = content.x + Math.max(4, Math.min(right - WIDTH, content.width - WIDTH - 4));
    const y = content.y + (anchor ? anchor.y + anchor.height + 4 : 44);
    win.setPosition(Math.round(x), Math.round(y));
    win.show();
    win.focus();
    win.webContents.send('ui:menu-opened');
  }

  return { toggle, hide: () => win.hide(), webContents: win.webContents };
}

module.exports = { setupMenu };
