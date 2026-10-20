'use strict';

// Picture-in-picture (Ctrl+Alt+P): the user drags a rectangle over the
// overlay, and an always-on-top widget shows that area of both layers,
// blended like the overlay itself. Frames are captured from both pages, so
// no extra copies of the sites are loaded. The area is in window pixels:
// panning the main maps changes what the widget shows.

const path = require('path');
const { BrowserWindow, ipcMain, screen } = require('electron');
const log = require('./logger');

const FRAME_INTERVAL_MS = 1000;
const MAX_INITIAL_SIDE = 420;
const MIN_AREA = 40;
const MARGIN = 16;

function setupPip(overlay) {
  let selector = null;
  let pip = null;
  let area = null;
  let timer = null;

  function toggle() {
    if (pip) closePip();
    else if (selector) closeSelector();
    else startSelection();
  }

  function startSelection() {
    overlay.restoreMain();
    selector = new BrowserWindow({
      ...overlay.mapBounds(),
      frame: false,
      transparent: true,
      thickFrame: false,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: overlay.uiWebPreferences(),
    });
    selector.loadFile(path.join(__dirname, 'ui', 'select.html'));
    selector.on('blur', closeSelector);
    selector.on('closed', () => {
      selector = null;
    });
  }

  function closeSelector() {
    if (selector && !selector.isDestroyed()) selector.close();
    selector = null;
  }

  function openPip(rect) {
    area = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
    const scale = Math.min(1, MAX_INITIAL_SIDE / Math.max(area.width, area.height));
    const width = Math.round(area.width * scale);
    const height = Math.round(area.height * scale);
    const workArea = screen.getDisplayMatching(overlay.mainWindow.getBounds()).workArea;

    pip = new BrowserWindow({
      width,
      height,
      x: workArea.x + workArea.width - width - MARGIN,
      y: workArea.y + workArea.height - height - MARGIN,
      title: 'Nebohliad PiP',
      frame: false,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      minWidth: 120,
      minHeight: 80,
      alwaysOnTop: true,
      skipTaskbar: true,
      backgroundColor: '#000000',
      webPreferences: overlay.uiWebPreferences(),
    });
    // Stay above other always-on-top windows and full-screen apps.
    pip.setAlwaysOnTop(true, 'screen-saver');
    pip.setAspectRatio(area.width / area.height);
    pip.loadFile(path.join(__dirname, 'ui', 'pip.html'));
    pip.webContents.once('did-finish-load', captureFrame);
    pip.on('closed', () => {
      pip = null;
      clearTimeout(timer);
    });
  }

  function closePip() {
    if (pip && !pip.isDestroyed()) pip.close();
  }

  async function captureFrame() {
    if (!pip || pip.isDestroyed()) return;
    try {
      const [bottomImage, topImage] = await Promise.all([
        overlay.basePage.capturePage(area),
        overlay.topShown ? overlay.overlayPage.capturePage(area) : null,
      ]);
      if (pip && !pip.isDestroyed()) {
        pip.webContents.send('ui:pip-frame', {
          bottom: bottomImage.toJPEG(85),
          // PNG keeps the transparency of the targets-only top layer.
          top: topImage ? topImage.toPNG() : null,
          opacity: overlay.topOpacity,
        });
      }
    } catch (error) {
      log.warn('pip', 'capture failed', error.message);
    }
    if (pip) timer = setTimeout(captureFrame, FRAME_INTERVAL_MS);
  }

  ipcMain.on('ui:select-done', (_event, rect) => {
    closeSelector();
    if (rect.width >= MIN_AREA && rect.height >= MIN_AREA) openPip(rect);
  });
  ipcMain.on('ui:select-cancel', closeSelector);
  ipcMain.on('ui:pip-close', closePip);
  ipcMain.on('ui:pip-show-main', () => overlay.restoreMain());

  // The last selected area (kept after PiP closes); the LAN stream can use it.
  return { toggle, area: () => area };
}

module.exports = { setupPip };
