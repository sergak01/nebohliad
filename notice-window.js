'use strict';

// The app's own safety notice: shown at start until its current version is
// confirmed, and from the ⋯ menu any time. It says at least what the sites'
// own notices say; only after it is confirmed does preload.js dismiss those
// (page mode `dismissSafety`). Bump NOTICE_VERSION when the text changes in
// substance, so it is shown (and confirmed) again.

const path = require('path');
const { BrowserWindow, ipcMain } = require('electron');

const NOTICE_VERSION = 1;
const WIDTH = 580;

function setupNotice(overlay, onConfirmed) {
  let win = null;

  const confirmed = () => overlay.settings.safetyNoticeVersion >= NOTICE_VERSION;

  function show() {
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
      return;
    }
    win = new BrowserWindow({
      width: WIDTH,
      height: 480,
      parent: overlay.mainWindow,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      webPreferences: overlay.uiWebPreferences(),
    });
    win.loadFile(path.join(__dirname, 'ui', 'notice.html'));
    win.once('ready-to-show', () => {
      const b = overlay.mainWindow.getBounds();
      const [, height] = win.getSize();
      win.setPosition(Math.round(b.x + (b.width - WIDTH) / 2), Math.round(b.y + Math.max(40, (b.height - height) / 3)));
      win.show();
      win.focus();
    });
    win.on('closed', () => {
      win = null;
    });
  }

  ipcMain.handle('ui:notice-state', () => ({ confirmed: confirmed() }));
  ipcMain.on('ui:notice-height', (_event, height) => {
    if (win && !win.isDestroyed()) win.setContentSize(WIDTH, Math.max(200, Math.min(900, Math.ceil(height))));
  });
  ipcMain.on('ui:notice-confirm', () => {
    if (!confirmed()) {
      overlay.settings.safetyNoticeVersion = NOTICE_VERSION;
      onConfirmed();
    }
    win?.close();
  });
  ipcMain.on('ui:notice-close', () => win?.close());
  ipcMain.on('ui:notice-open', show);

  return { show, confirmed };
}

module.exports = { setupNotice, NOTICE_VERSION };
