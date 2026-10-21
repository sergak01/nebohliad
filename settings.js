'use strict';

// User settings, persisted as JSON in the app's userData folder.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const log = require('./logger');

const DEFAULTS = {
  base: 'ukrainealarm', // Site shown as the main (bottom) map.
  targetsOnly: true, // Top layer shows only its targets.
  hudHidden: false, // Both pages show only their map, without site UI.
  opacity: { targets: 1, full: 0.5 }, // Top layer opacity per mode.
  lang: 'uk', // 'uk' or 'en': the app, and the sites where they support it.
  theme: 'system', // 'system', 'light' or 'dark': the app and the sites.
  // Saved places: { id, name, center: [lng, lat], region, bbox }. The primary
  // one is the map's home view (its whole region).
  locations: [],
  primaryLocationId: null,
  // Notify when a target is within radiusKm of any location.
  alerts: { enabled: true, radiusKm: 30 },
  closeToTray: true, // Closing the main window hides it to the tray.
  fpsLimit: 20, // Max map redraws per second in both pages; 60 = no limit.
  // Nominatim server for search and locations; '' turns search off. Not in
  // the UI: lets search be switched or stopped without a new release.
  geocoderUrl: 'https://nominatim.openstreetmap.org',
  // Version of the safety notice the user confirmed (0 = none yet). Until
  // the current one is confirmed, the sites' own warnings are not dismissed.
  safetyNoticeVersion: 0,
  // LAN stream (stream-server.js). token: in the viewer link; regenerated
  // with "new link". area: full | pip; layers: both | base | top;
  // quality: low | standard | high.
  stream: { enabled: false, port: 47800, token: '', area: 'full', layers: 'both', quality: 'standard' },
  // Base map view, restored at start-up: { center, zoom, bearing, pitch }.
  mapView: null,
  // Center on a target near a location: 'off' | 'stream' (while someone
  // watches the LAN stream) | 'always' (follow.js).
  follow: 'off',
  // Compare the running code with the newest commit on GitHub (one public API
  // request on start and every 6 h; version-check.js).
  updateCheck: true,
  // A release version the user chose to skip (no dot, no notification), and
  // the last one a Windows notification was shown for.
  updateSkip: null,
  updateNotified: null,
  // Quiet hours: silent notifications, no vibration or sound on viewers,
  // except an air alert at the primary location (alerts.js quietNow).
  quiet: { enabled: false, from: '23:00', to: '07:00' },
  // Changed global shortcuts only: { id: accelerator }, '' = off
  // (shortcuts.js has the ids and defaults).
  shortcuts: {},
  bounds: null, // Main window bounds.
};
const LANGS = ['uk', 'en'];
const THEMES = ['system', 'light', 'dark'];
const FPS_LIMITS = [10, 15, 20, 30, 60];

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings(siteIds) {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    // First run or unreadable file: defaults.
  }
  const settings = {
    ...structuredClone(DEFAULTS),
    ...saved,
    opacity: { ...DEFAULTS.opacity, ...saved.opacity },
    alerts: { ...DEFAULTS.alerts, ...saved.alerts },
    stream: { ...DEFAULTS.stream, ...saved.stream },
  };
  const s = settings.stream;
  if (!['full', 'pip'].includes(s.area)) s.area = DEFAULTS.stream.area;
  if (!['both', 'base', 'top'].includes(s.layers)) s.layers = DEFAULTS.stream.layers;
  if (!['low', 'standard', 'high'].includes(s.quality)) s.quality = DEFAULTS.stream.quality;
  if (!(Number.isInteger(s.port) && s.port >= 1024 && s.port <= 65535)) s.port = DEFAULTS.stream.port;
  if (!Array.isArray(settings.locations)) settings.locations = [];
  if (!['off', 'stream', 'always'].includes(settings.follow)) settings.follow = DEFAULTS.follow;
  if (typeof settings.updateCheck !== 'boolean') settings.updateCheck = DEFAULTS.updateCheck;
  for (const key of ['updateSkip', 'updateNotified']) if (typeof settings[key] !== 'string') settings[key] = null;
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  const q = settings.quiet;
  settings.quiet = {
    enabled: typeof q?.enabled === 'boolean' ? q.enabled : DEFAULTS.quiet.enabled,
    from: time.test(q?.from) ? q.from : DEFAULTS.quiet.from,
    to: time.test(q?.to) ? q.to : DEFAULTS.quiet.to,
  };
  const v = settings.mapView;
  if (!(v && Array.isArray(v.center) && v.center.length === 2 && v.center.every(Number.isFinite) && Number.isFinite(v.zoom))) settings.mapView = null;
  if (!settings.shortcuts || typeof settings.shortcuts !== 'object' || Array.isArray(settings.shortcuts)) settings.shortcuts = {};
  if (!siteIds.includes(settings.base)) settings.base = DEFAULTS.base;
  if (!LANGS.includes(settings.lang)) settings.lang = DEFAULTS.lang;
  if (!THEMES.includes(settings.theme)) settings.theme = DEFAULTS.theme;
  if (!FPS_LIMITS.includes(settings.fpsLimit)) settings.fpsLimit = DEFAULTS.fpsLimit;
  return settings;
}

// Synchronous on purpose: changes come in bursts (several toggles, the opacity
// slider), and overlapping async writes can finish out of order, leaving an
// older state on disk. The file is tiny.
function saveSettings(settings) {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (error) {
    log.warn('settings', 'could not save', error.message);
  }
}

module.exports = { loadSettings, saveSettings, LANGS, THEMES, FPS_LIMITS };
