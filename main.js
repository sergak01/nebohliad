'use strict';

// Window layout:
//  - main window (BaseWindow): toolbar view on top, the base map page below;
//  - overlay window (transparent BaseWindow, owned by main): the other map
//    page, exactly over the base map area, click-through by default.
// The two map pages are WebContentsViews; swapping the base map moves the
// views between the windows, so neither page reloads.

const fs = require('fs');
const path = require('path');
const { app, BaseWindow, WebContentsView, Menu, clipboard, globalShortcut, ipcMain, nativeTheme, powerMonitor, shell, webContents } = require('electron');
const { loadSettings, saveSettings, LANGS, THEMES, FPS_LIMITS } = require('./settings');
const { setupSearch } = require('./search-window');
const { setupPip } = require('./pip-window');
const { setupLocations } = require('./locations');
const { setupAlerts } = require('./alerts');
const { setupMenu } = require('./menu-window');
const { setupSettings } = require('./settings-window');
const { setupShortcuts } = require('./shortcuts');
const { setupFollow, MODES: FOLLOW_MODES } = require('./follow');
const { setupVersionCheck } = require('./version-check');
const { setupTray } = require('./tray');
const { setupNotice } = require('./notice-window');
const { setupStream, QUALITY, AREAS, LAYERS } = require('./stream-server');
const geocoder = require('./geocoder');
const { version: APP_VERSION, homepage: HOMEPAGE, license: LICENSE } = require('./package.json');

// Map data attribution, shown on the base map in every mode (preload.js).
const ATTRIBUTION_LINKS = [
  { text: '© OpenStreetMap contributors', href: 'https://www.openstreetmap.org/copyright' },
  { text: '© OpenMapTiles', href: 'https://www.openmaptiles.org/' },
  { text: 'OpenFreeMap', href: 'https://openfreemap.org/' },
];
const ATTRIBUTION_TARGETS = {
  uk: 'Цілі: map.ukrainealarm.com, map.war-monitor.org',
  en: 'Targets: map.ukrainealarm.com, map.war-monitor.org',
};

const SITES = {
  // Sites are named by their domains only (nominative use, no brands); UI
  // labels come from ui/i18n.js.
  ukrainealarm: {
    url: 'https://map.ukrainealarm.com/',
    label: 'ukrainealarm',
    title: 'map.ukrainealarm.com',
    partition: 'persist:bottom',
  },
  'war-monitor': {
    url: 'https://map.war-monitor.org/',
    label: 'war-monitor',
    title: 'map.war-monitor.org',
    partition: 'persist:top',
  },
};
const SITE_IDS = Object.keys(SITES);

const TOOLBAR_HEIGHT = 40;
const OPACITY_STEP = 0.1;
const OPACITY_MIN = 0.1;
const OPACITY_MAX = 1;

// Must match build.appId in package.json: the installer's shortcuts carry it,
// and Windows shows notifications only for that id.
const APP_ID = 'com.nebohliad.app';
const APP_NAMES = { uk: 'Небогляд', en: 'Nebohliad' };

// CalculateNativeWinOcclusion: keep the overlay rendering even when it is
// covered or not focused. WebRtcHideLocalIpsWithMdns: the LAN stream's
// WebRTC sender offers its real LAN address, so phones can connect without
// resolving an mDNS name.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,WebRtcHideLocalIpsWithMdns');

// The app used to be called "maps-overlay", so its data (settings, locations,
// site sessions) lived in %APPDATA%\maps-overlay. Copy it once into the new
// userData folder; caches are skipped and the old folder is left untouched.
const LEGACY_USER_DATA = 'maps-overlay';
const SKIP_ON_MIGRATION = new Set([
  'Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'ShaderCache', 'GPUPersistentCache',
  'DawnGraphiteCache', 'DawnWebGPUCache', 'Shared Dictionary', 'blob_storage',
  'lockfile', 'DevToolsActivePort', 'SingletonLock', 'SingletonCookie', 'SingletonSocket',
]);

function migrateLegacyUserData() {
  const target = app.getPath('userData');
  const legacy = path.join(app.getPath('appData'), LEGACY_USER_DATA);
  if (path.resolve(target) === path.resolve(legacy)) return;
  if (fs.existsSync(path.join(target, 'settings.json')) || !fs.existsSync(path.join(legacy, 'settings.json'))) return;
  try {
    fs.cpSync(legacy, target, { recursive: true, filter: (src) => !SKIP_ON_MIGRATION.has(path.basename(src)) });
  } catch (error) {
    console.warn('Could not copy data from the old maps-overlay folder:', error.message);
  }
}

// Before anything touches userData (the single-instance lock lives there).
migrateLegacyUserData();

let settings = null;
let mainWindow = null;
let overlayWindow = null;
let toolbarView = null;
const pages = {}; // site id -> WebContentsView
let topShown = true;
let clickThrough = true;
let pin = null;
let search = null;
let pip = null;
let locations = null;
let alerts = null;
let menu = null;
let settingsWin = null;
let shortcuts = null;
let nearby = []; // Targets near saved locations (alerts.js), for the toolbar.
const lastViews = {}; // site id -> last view the page reported
let tray = null;
let notice = null;
let stream = null;
let streamState = { running: false, error: null, viewers: 0, urls: [], qr: null, code: null };
let quitting = false; // Set on a real quit, so 'close' does not hide to tray.
let trayAnnounced = false;
let homeShown = false; // The start-up view is set once.
const HOME_DELAY_MS = 1500; // Let the base site finish restoring its own view.
let follow = null;
let versionCheck = null;
let viewSaveTimer = null;
// Views are saved only after the start-up view is set: before that the base
// site reports its own restored view, which must not replace ours.
let startupViewSet = false;
const VIEW_SAVE_DELAY_MS = 1500;

const overlayId = () => SITE_IDS.find((id) => id !== settings.base);
const basePage = () => pages[settings.base].webContents;
const overlayPage = () => pages[overlayId()].webContents;
const currentOpacity = () => settings.opacity[settings.targetsOnly ? 'targets' : 'full'];

function pageWebPreferences(partition) {
  return {
    partition,
    preload: path.join(__dirname, 'preload.js'),
    backgroundThrottling: false,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  };
}

// For our own UI (toolbar, search, area selection, PiP).
function uiWebPreferences() {
  return {
    preload: path.join(__dirname, 'ui', 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  };
}

// --- Layout ----------------------------------------------------------------

// Screen rectangle of the map area (main window content below the toolbar).
function mapBounds() {
  const b = mainWindow.getContentBounds();
  return { x: b.x, y: b.y + TOOLBAR_HEIGHT, width: b.width, height: Math.max(1, b.height - TOOLBAR_HEIGHT) };
}

let realignTimer = null;

function layout() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
  const { width, height } = mainWindow.getContentBounds();
  const mapHeight = Math.max(1, height - TOOLBAR_HEIGHT);
  toolbarView.setBounds({ x: 0, y: 0, width, height: TOOLBAR_HEIGHT });
  pages[settings.base].setBounds({ x: 0, y: TOOLBAR_HEIGHT, width, height: mapHeight });
  pages[overlayId()].setBounds({ x: 0, y: 0, width, height: mapHeight });
  overlayWindow.setBounds(mapBounds());
  // Both maps react to the resize on their own; re-align once it settles.
  clearTimeout(realignTimer);
  realignTimer = setTimeout(realignMaps, 300);
}

// Put the base page in the main window and the other one in the overlay.
function placePages() {
  for (const view of Object.values(pages)) {
    for (const win of [mainWindow, overlayWindow]) {
      if (win.contentView.children.includes(view)) win.contentView.removeChildView(view);
    }
  }
  pages[settings.base].setBackgroundColor('#000000');
  pages[overlayId()].setBackgroundColor('#00000000');
  mainWindow.contentView.addChildView(pages[settings.base]);
  overlayWindow.contentView.addChildView(pages[overlayId()]);
  layout();
  sendPageModes();
  locations?.redraw();
  overlayWindow.setOpacity(currentOpacity());
  applyClickThrough();
}

// --- Map sync (see preload.js) ---------------------------------------------

// The base map is the reference: ask it to broadcast its current view.
function realignMaps() {
  if (settings && pages[settings.base]) basePage().send('emit-map-view');
}

function otherPage(sender) {
  const [a, b] = SITE_IDS.map((id) => pages[id]?.webContents);
  if (sender === a) return b;
  if (sender === b) return a;
  return null;
}

function sendToPages(channel, data) {
  for (const view of Object.values(pages)) view.webContents.send(channel, data);
}

function siteOf(contents) {
  return SITE_IDS.find((id) => pages[id]?.webContents === contents) || null;
}

ipcMain.on('map-view', (event, view) => {
  const site = siteOf(event.sender);
  if (site) lastViews[site] = view;
  otherPage(event.sender)?.send('set-map-view', view);
  if (site && site === settings?.base) {
    // Echoes (re-sent views) and bounces are not moves by the user.
    if (!view.echo && !view.bounce) follow?.viewChanged();
    if (startupViewSet) scheduleViewSave();
  }
});

// The base map's view is kept in settings.mapView and restored at start-up.
// While following a target, the view from before is the one kept.
function saveMapView() {
  clearTimeout(viewSaveTimer);
  viewSaveTimer = null;
  const view = follow?.isFollowing() ? follow.savedView() : lastViews[settings.base];
  if (!view?.center) return;
  settings.mapView = { center: view.center, zoom: view.zoom, bearing: view.bearing || 0, pitch: view.pitch || 0 };
  saveSettings(settings);
}

function scheduleViewSave() {
  clearTimeout(viewSaveTimer);
  viewSaveTimer = setTimeout(saveMapView, VIEW_SAVE_DELAY_MS);
}

// The sites' own notices about their target data (preload.js `notice`):
// site id -> text. Shown in the toolbar and on the stream's frames, only for
// a site that is on screen there. The site clears its notice by itself when
// its data comes back (no reload needed).
const siteNotices = {};

function noticesFor(shown) {
  return Object.entries(siteNotices)
    .filter(([site]) => shown(site))
    .map(([site, text]) => ({ site, text }));
}

// The sites in the stream's frames (settings.stream.layers).
function streamShows(site) {
  const layers = settings.stream.layers;
  return layers === 'both' || (layers === 'base' ? site === settings.base : site !== settings.base);
}
ipcMain.on('site-notice', (event, text) => {
  const site = siteOf(event.sender);
  if (!site) return;
  const value = typeof text === 'string' && text ? text.slice(0, 300) : null;
  if ((siteNotices[site] || null) === value) return;
  if (value) siteNotices[site] = value;
  else delete siteNotices[site];
  pushState();
});

ipcMain.on('map-ready', (event) => {
  realignMaps();
  if (pin) event.sender.send('map-pin', pin);
  locations?.redraw();
  if (!homeShown && event.sender === basePage()) {
    homeShown = true;
    // The last view, else the primary location's region (first run).
    setTimeout(() => {
      if (settings.mapView) jumpTo(settings.mapView);
      else locations?.show();
      startupViewSet = true;
    }, HOME_DELAY_MS);
  } else if (viewBeforeReload && event.sender === basePage()) {
    // "Reload maps": the site comes back with its own saved view; put ours back.
    const view = viewBeforeReload;
    viewBeforeReload = null;
    setTimeout(() => {
      jumpTo(view);
      startupViewSet = true;
    }, HOME_DELAY_MS);
  }
});

// Our own move of the base map to a saved view (not a move by the user).
function jumpTo(view) {
  follow?.expectMove();
  basePage().send('map-command', { jump: true, center: view.center, zoom: view.zoom, bearing: view.bearing || 0, pitch: view.pitch || 0 });
}

// What each page shows: HUD on/off for both, targets-only for the overlay,
// and the language and resolved theme where the site supports them.
function pageMode(contents) {
  const isBase = contents === basePage();
  return {
    isBase,
    hudHidden: settings.hudHidden,
    targetsOnly: !isBase && settings.targetsOnly,
    attribution: isBase ? { parts: [...ATTRIBUTION_LINKS, { text: ATTRIBUTION_TARGETS[settings.lang] }] } : null,
    // The sites' safety notices are dismissed only once ours is confirmed.
    dismissSafety: Boolean(notice?.confirmed()),
    lang: settings.lang,
    theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    fps: settings.fpsLimit,
  };
}

function sendPageModes() {
  for (const view of Object.values(pages)) view.webContents.send('page-mode', pageMode(view.webContents));
}

// Asked synchronously by preload.js before the page paints.
ipcMain.on('get-page-mode', (event) => {
  event.returnValue = settings
    ? pageMode(event.sender)
    : { hudHidden: false, targetsOnly: false, lang: 'uk', theme: 'dark', fps: 20 };
});
ipcMain.handle('ui:get-lang', () => settings.lang);
// Links in our UI (About, sources) open in the system browser; https only.
ipcMain.on('ui:open-external', (_event, url) => {
  if (typeof url === 'string' && /^https:\/\//.test(url)) shell.openExternal(url);
});

// Center the maps on a place ({ center, zoom } or { center, bbox }) and pin it.
// Only the base map is moved; the sync carries the overlay map along.
function goTo(place) {
  restoreMain();
  const command = place.bbox ? { bbox: place.bbox } : { center: place.center, zoom: place.zoom };
  basePage().send('map-command', command);
  setPin({ center: place.center });
}

function setPin(value) {
  pin = value;
  sendToPages('map-pin', pin);
}

// Move the maps without a pin: { bbox } or { center, zoom }.
function showView(view) {
  restoreMain();
  basePage().send('map-command', view);
}

// --- Settings and state ----------------------------------------------------

// For the toolbar and the settings panel.
function pushState() {
  const state = {
    sites: SITE_IDS.map((id) => ({ id, label: SITES[id].label, title: SITES[id].title })),
    base: settings.base,
    overlay: overlayId(),
    targetsOnly: settings.targetsOnly,
    hudHidden: settings.hudHidden,
    opacity: currentOpacity(),
    topShown,
    clickThrough,
    lang: settings.lang,
    theme: settings.theme,
    locations: settings.locations.map((loc) => ({
      id: loc.id,
      name: loc.name,
      region: loc.region,
      primary: loc.id === settings.primaryLocationId,
    })),
    hasPrimary: Boolean(locations?.primary()),
    alerts: { ...settings.alerts },
    nearby,
  };
  state.closeToTray = settings.closeToTray;
  state.fpsLimit = settings.fpsLimit;
  state.shortcuts = shortcuts?.list() || [];
  state.follow = settings.follow;
  state.updateCheck = settings.updateCheck;
  state.siteNotices = noticesFor((site) => site === settings.base || topShown);
  state.update = versionCheck?.state() || null;
  state.about = { version: APP_VERSION, homepage: HOMEPAGE, license: LICENSE };
  const { token, ...streamSettings } = settings.stream; // The token is in the URLs.
  state.stream = { ...streamSettings, ...streamState };
  toolbarView?.webContents.send('ui:state', state);
  menu?.webContents.send('ui:state', state);
  settingsWin?.webContents?.send('ui:state', state);
  tray?.update({
    lang: settings.lang,
    visible: mainWindow?.isVisible() ?? true,
    hasPrimary: state.hasPrimary,
    alertsEnabled: settings.alerts.enabled,
    closeToTray: settings.closeToTray,
    streamEnabled: settings.stream.enabled,
    streamViewers: streamState.viewers,
    nearby,
  });
}

// The stream's state (URLs, QR code, viewers) is computed asynchronously.
async function refreshStream() {
  if (!stream) return;
  streamState = await stream.state();
  follow?.stopIfInactive(); // "For the stream" ends when nobody watches.
  pushState();
}

function setStreamOption(key, value) {
  const valid = { area: AREAS, layers: LAYERS, quality: Object.keys(QUALITY) };
  if (key === 'enabled') settings.stream.enabled = Boolean(value);
  else if (key === 'port' && Number.isInteger(value) && value >= 1024 && value <= 65535) settings.stream.port = value;
  else if (valid[key]?.includes(value)) settings.stream[key] = value;
  else return;
  stream.apply();
  stateChanged();
  refreshStream();
}

function stateChanged() {
  saveSettings(settings);
  pushState();
}

// Called after every alerts round (every 5 s), changed or not.
function nearbyChanged(list) {
  follow?.update(alerts?.nearby() || []);
  if (JSON.stringify(list) === JSON.stringify(nearby)) return;
  nearby = list;
  pushState();
}

function setAlertsEnabled(enabled) {
  settings.alerts.enabled = Boolean(enabled);
  locations.redraw();
  stateChanged();
}

function setAlertRadius(km) {
  const value = Math.round(Number(km));
  if (!(value >= 1 && value <= 500)) return;
  settings.alerts.radiusKm = value;
  locations.redraw();
  stateChanged();
}

function setLang(lang) {
  if (!LANGS.includes(lang)) return;
  settings.lang = lang;
  mainWindow.setTitle(APP_NAMES[lang]);
  // Our UI windows are the file:// pages.
  for (const contents of webContents.getAllWebContents()) {
    if (contents.getURL().startsWith('file:')) contents.send('ui:lang', lang);
  }
  sendPageModes();
  stateChanged();
}

// themeSource drives prefers-color-scheme in our UI and in the sites; the
// sites with their own theme switch also get it via sendPageModes().
function setTheme(theme) {
  if (!THEMES.includes(theme)) return;
  settings.theme = theme;
  nativeTheme.themeSource = theme;
  stateChanged();
}

// Also fires when the OS theme changes while on 'system'.
nativeTheme.on('updated', () => {
  if (settings && pages[settings.base]) sendPageModes();
});

function applyClickThrough() {
  overlayWindow.setIgnoreMouseEvents(clickThrough);
  overlayWindow.setFocusable(!clickThrough);
  if (clickThrough) {
    mainWindow.focus();
    basePage().focus();
  } else {
    overlayWindow.focus();
    overlayPage().focus();
  }
}

function setBase(siteId) {
  if (!SITES[siteId] || siteId === settings.base) return;
  settings.base = siteId;
  placePages();
  stateChanged();
}

function setTargetsOnly(enabled) {
  settings.targetsOnly = enabled;
  sendPageModes();
  overlayWindow.setOpacity(currentOpacity());
  stateChanged();
}

function setHudHidden(hidden) {
  settings.hudHidden = hidden;
  sendPageModes();
  stateChanged();
}

function setOpacity(value) {
  const mode = settings.targetsOnly ? 'targets' : 'full';
  const clamped = Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, value));
  settings.opacity[mode] = Math.round(clamped * 10) / 10;
  overlayWindow.setOpacity(settings.opacity[mode]);
  stateChanged();
}

function setTopShown(shown) {
  topShown = shown;
  if (topShown) {
    layout();
    overlayWindow.showInactive();
    applyClickThrough();
  } else {
    overlayWindow.hide();
    mainWindow.focus();
  }
  stateChanged();
}

function setClickThrough(enabled) {
  if (!topShown) return;
  clickThrough = enabled;
  applyClickThrough();
  stateChanged();
}

// The base map's view is kept and restored once it is ready again; until
// then its views are not saved (the site first shows its own saved view).
const RELOAD_RESTORE_GIVE_UP_MS = 30_000;
let viewBeforeReload = null;
let reloadGiveUpTimer = null;

function reloadPages() {
  viewBeforeReload = lastViews[settings.base] || settings.mapView;
  if (viewBeforeReload) {
    startupViewSet = false;
    clearTimeout(viewSaveTimer);
    // A page that never gets ready must not stop views being saved for good.
    clearTimeout(reloadGiveUpTimer);
    reloadGiveUpTimer = setTimeout(() => {
      viewBeforeReload = null;
      startupViewSet = true;
    }, RELOAD_RESTORE_GIVE_UP_MS);
  }
  for (const view of Object.values(pages)) view.webContents.reload();
}

function restoreMain() {
  if (!mainWindow.isVisible()) showMain();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

// --- Tray --------------------------------------------------------------------

function hideToTray() {
  overlayWindow.hide();
  mainWindow.hide();
  if (!trayAnnounced) {
    trayAnnounced = true;
    tray?.announceHidden();
  }
  pushState();
}

function showMain() {
  mainWindow.show();
  if (topShown) overlayWindow.showInactive();
  layout();
  mainWindow.focus();
  pushState();
}

function toggleMain() {
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) hideToTray();
  else restoreMain();
}

function setCloseToTray(enabled) {
  settings.closeToTray = Boolean(enabled);
  stateChanged();
}

function setFpsLimit(fps) {
  if (!FPS_LIMITS.includes(fps)) return;
  settings.fpsLimit = fps;
  sendPageModes();
  stateChanged();
}

function quit() {
  quitting = true;
  app.quit();
}

app.on('before-quit', () => {
  quitting = true;
  if (settings && viewSaveTimer) saveMapView();
  stream?.stop();
});

ipcMain.on('ui:toolbar-ready', stateChanged);
ipcMain.on('ui:toolbar-set', (_event, { key, value }) => {
  const setters = {
    base: setBase,
    targetsOnly: setTargetsOnly,
    hudHidden: setHudHidden,
    opacity: setOpacity,
    topShown: setTopShown,
    clickThrough: setClickThrough,
    lang: setLang,
    theme: setTheme,
    alertsEnabled: setAlertsEnabled,
    alertRadiusKm: setAlertRadius,
    closeToTray: setCloseToTray,
    fpsLimit: setFpsLimit,
    updateCheck: (enabled) => {
      settings.updateCheck = Boolean(enabled);
      stateChanged();
      versionCheck.check();
    },
    follow: (mode) => {
      if (!FOLLOW_MODES.includes(mode)) return;
      settings.follow = mode;
      follow.stopIfInactive();
      stateChanged();
    },
    streamEnabled: (v) => setStreamOption('enabled', v),
    streamArea: (v) => setStreamOption('area', v),
    streamLayers: (v) => setStreamOption('layers', v),
    streamQuality: (v) => setStreamOption('quality', v),
    streamPort: (v) => setStreamOption('port', Number(v)),
  };
  setters[key]?.(value);
});
ipcMain.on('ui:toolbar-action', (_event, { name, data }) => {
  const actions = {
    search: () => search.toggle(),
    pip: () => pip.toggle(),
    reload: reloadPages,
    menu: () => menu.toggle(data),
    settings: () => settingsWin.open(data),
    quit,
    'update-check': () => versionCheck.check(),
    home: () => locations.show(),
    'show-location': () => locations.show(data),
    'stream-new-link': () => {
      stream.newLink();
      stateChanged();
      refreshStream();
    },
    copy: () => typeof data === 'string' && clipboard.writeText(data),
  };
  actions[name]?.();
});

// --- Windows ---------------------------------------------------------------

// Open popups in the system browser instead of new Electron windows.
function routeExternalLinks(webContents) {
  webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function createPage(siteId) {
  const site = SITES[siteId];
  const view = new WebContentsView({ webPreferences: pageWebPreferences(site.partition) });
  routeExternalLinks(view.webContents);
  view.webContents.on('preload-error', (_event, _preloadPath, error) => {
    console.error(`Preload failed in ${site.url}:`, error);
  });
  view.webContents.loadURL(site.url);
  return view;
}

function createWindows() {
  const bounds = settings.bounds || { width: 1400, height: 940 };
  mainWindow = new BaseWindow({
    ...bounds,
    title: APP_NAMES[settings.lang] || APP_NAMES.uk,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    backgroundColor: '#111318',
  });

  toolbarView = new WebContentsView({ webPreferences: uiWebPreferences() });
  toolbarView.setBackgroundColor('#111318');
  toolbarView.webContents.loadFile(path.join(__dirname, 'ui', 'toolbar.html'));
  mainWindow.contentView.addChildView(toolbarView);

  overlayWindow = new BaseWindow({
    parent: mainWindow,
    frame: false,
    // No invisible resize border/shadow, so the window does not spill past
    // the map area.
    thickFrame: false,
    hasShadow: false,
    show: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    // Transparent, so in targets-only mode the base map shows through.
    transparent: true,
    backgroundColor: '#00000000',
  });

  for (const id of SITE_IDS) pages[id] = createPage(id);
  placePages();
  overlayWindow.showInactive();

  for (const event of ['resize', 'move', 'maximize', 'unmaximize', 'restore']) mainWindow.on(event, layout);
  // Windows normally re-shows owned windows on restore; make sure of it.
  mainWindow.on('restore', () => {
    if (topShown && !overlayWindow.isVisible()) overlayWindow.showInactive();
  });
  mainWindow.on('close', (event) => {
    if (!mainWindow.isMinimized() && !mainWindow.isMaximized()) settings.bounds = mainWindow.getBounds();
    saveSettings(settings);
    if (settings.closeToTray && !quitting) {
      event.preventDefault();
      hideToTray();
    }
  });
  mainWindow.on('closed', () => app.quit());
}

// What the search, PiP, locations, alerts and menu modules need.
const overlay = {
  get settings() {
    return settings;
  },
  get mainWindow() {
    return mainWindow;
  },
  get basePage() {
    return basePage();
  },
  get overlayPage() {
    return overlayPage();
  },
  get topShown() {
    return topShown;
  },
  get topOpacity() {
    return currentOpacity();
  },
  get pin() {
    return pin;
  },
  get lang() {
    return settings.lang;
  },
  dark: () => nativeTheme.shouldUseDarkColors,
  mapBounds,
  goTo,
  setPin,
  showView,
  restoreMain,
  uiWebPreferences,
  sendToPages,
  siteOf,
  siteLabel: (id) => SITES[id]?.label || id,
  // Center of the base map, from the last view it reported.
  baseCenter: () => lastViews[settings.base]?.center || null,
  settingsChanged: stateChanged,
  nearbyChanged,
  streamChanged: () => refreshStream(),
  alertBanner: () => alerts?.banner() || null,
  // "ukrainealarm: <the site's notice>" lines for the stream's frames.
  noticeBanner: () =>
    noticesFor(streamShows)
      .map(({ site, text }) => `${SITES[site]?.label || site}: ${text}`)
      .join('  ·  ') || null,
  // Events for LAN stream viewers (alerts.js → stream-server.js).
  streamEvent: (event) => stream?.broadcast(event),
  alertSnapshot: () => alerts?.snapshot() || [],
  sendToSite: (site, channel, data) => pages[site]?.webContents.send(channel, data),
};

// Global shortcuts (shortcuts.js); the keys are in settings.shortcuts.
const SHORTCUT_HANDLERS = {
  interact: () => setClickThrough(!clickThrough),
  opacityUp: () => setOpacity(currentOpacity() + OPACITY_STEP),
  opacityDown: () => setOpacity(currentOpacity() - OPACITY_STEP),
  topLayer: () => setTopShown(!topShown),
  targetsOnly: () => setTargetsOnly(!settings.targetsOnly),
  mapOnly: () => setHudHidden(!settings.hudHidden),
  swapBase: () => setBase(overlayId()),
  reload: reloadPages,
  search: () => search.toggle(),
  pip: () => pip.toggle(),
  home: () => locations.show(),
  settings: () => settingsWin.open(),
};

// Tooltips and menu labels in every UI window show the current keys.
function shortcutsChanged() {
  for (const contents of webContents.getAllWebContents()) {
    if (contents.getURL().startsWith('file:')) contents.send('ui:shortcuts', shortcuts.labels());
  }
  stateChanged();
}

ipcMain.handle('ui:get-shortcuts', () => shortcuts?.labels() || {});
ipcMain.handle('ui:shortcut-set', (_event, { id, accelerator }) => shortcuts.set(id, accelerator));
ipcMain.on('ui:shortcut-reset', (_event, id) => shortcuts.reset(id || undefined));
ipcMain.on('ui:shortcuts-pause', (_event, on) => shortcuts.pause(on));

// Windows shows notifications only for an AppUserModelID it can resolve. The
// installer's Start Menu shortcut registers APP_ID (and makes the taskbar
// group the running window with that shortcut). Without it (dev, portable,
// unpacked) the executable path works as the id instead: Windows then names
// the notifications after the .exe.
function appUserModelId() {
  if (!app.isPackaged) return process.execPath;
  const link = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Nebohliad.lnk');
  try {
    const shortcut = shell.readShortcutLink(link);
    if (shortcut.appUserModelId === APP_ID && path.resolve(shortcut.target) === path.resolve(process.execPath)) return APP_ID;
  } catch {
    // No shortcut: not installed by the installer.
  }
  return process.execPath;
}

app.setAppUserModelId(appUserModelId());

// One instance only: both would share the same site partitions, and a second
// launch while the app sits in the tray should just bring the window back.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) restoreMain();
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    settings = loadSettings(SITE_IDS);
    nativeTheme.themeSource = settings.theme;
    geocoder.configure(settings.geocoderUrl);
    notice = setupNotice(overlay, () => {
      sendPageModes();
      stateChanged();
    });
    createWindows();
    search = setupSearch(overlay);
    pip = setupPip(overlay);
    locations = setupLocations(overlay);
    alerts = setupAlerts(overlay, locations);
    versionCheck = setupVersionCheck({ settings, changed: pushState });
    follow = setupFollow({
      settings,
      // Straight to the page: following must not bring a hidden window back.
      mapCommand: (command) => basePage().send('map-command', command),
      currentView: () => lastViews[settings.base] || null,
      streamWatched: () => Boolean(streamState.running && streamState.viewers > 0),
    });
    menu = setupMenu(overlay);
    settingsWin = setupSettings(overlay, locations, alerts);
    stream = setupStream(overlay, () => pip.area());
    tray = setupTray({
      toggleMain,
      home: () => locations.show(),
      pip: () => pip.toggle(),
      settings: () => settingsWin.open(),
      setAlerts: setAlertsEnabled,
      setCloseToTray,
      setStream: (enabled) => setStreamOption('enabled', enabled),
      quit,
    });
    stream.apply();
    refreshStream();
    pushState();
    shortcuts = setupShortcuts(settings, SHORTCUT_HANDLERS, shortcutsChanged);
    shortcuts.register();
    // Until the current safety notice is confirmed, show it at start.
    if (!notice.confirmed()) setTimeout(() => notice.show(), 1500);
  });
}

app.on('will-quit', () => globalShortcut.unregisterAll());

// After sleep the GPU device is often reset: the stream's WebRTC video went
// black (MJPEG kept working) until the window was shown again. Give the
// stream a fresh compositor once the system has settled.
const RESUME_SETTLE_MS = 4000;
app.whenReady().then(() => {
  for (const event of ['resume', 'unlock-screen']) {
    powerMonitor.on(event, () => setTimeout(() => stream?.resetVideo(event), RESUME_SETTLE_MS));
  }
});
app.on('child-process-gone', (_event, details) => {
  if (details.type === 'GPU') stream?.resetVideo('GPU process gone');
});
app.on('window-all-closed', () => app.quit());
