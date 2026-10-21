'use strict';

// Runs in both pages before their own scripts (sandboxed preload, isolated
// world). Jobs:
//  1. Capture the page's MapLibre map and keep its view in sync with the other
//     page (via the main process).
//  2. Dismiss known dialogs/banners that cover the map.
//  3. Page modes from the main process: hide the site UI (HUD), targets only
//     (overlay page: no basemap, transparent), and the site language.

// CSS goes through webFrame.insertCSS: a <style> element would be blocked by
// war-monitor's Content-Security-Policy.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

// --- Dialogs ---------------------------------------------------------------

const SITE_RULES = {
  // click / acceptedStorage: the site's safety notices (only after the app's
  // own notice is confirmed). hide / localStorage: promos and UI state.
  'map.war-monitor.org': {
    // The notice comes back daily; the targets panel state is remembered by
    // the site, so presetting it keeps the user's later choice.
    click: ['#wm-notice .notice-accept'],
    acceptedStorage: {},
    hide: [],
    localStorage: { 'wm.panel': 'closed' },
    // The sheet a click on a target opens (its details, close button), on
    // the base map and on the top layer alike.
    modals: ['dialog[open]', '#wm-details:not([hidden])'],
    // Cloudflare Turnstile's overlay: watched (never touched) to tell the user
    // when a check needs them.
    challenge: '.ts-overlay',
    overlayModals: ['#wm-details:not([hidden])'],
    // Style layers that draw targets: icons, trails, track points, routes.
    targetLayers: '^wm-(trail|route|arrows|icons|selected)',
    // The site stores its language and switches live with one button that
    // offers the other language.
    language: {
      storageKey: 'wm.lang',
      switchTo: { en: 'button.key[aria-label="English"]', uk: 'button.key[aria-label="Українська"]' },
    },
    // Stored as wm.theme; switched with buttons that exist only while the
    // "look" panel is open.
    theme: {
      storageKey: 'wm.theme',
      stored: { light: 'light', dark: 'dark' },
      current: () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'),
      switchTo(theme) {
        const look = document.querySelector('.look-key');
        if (!look) return;
        const wasOpen = look.getAttribute('aria-expanded') === 'true';
        if (!wasOpen) look.click();
        document.querySelector(`.look-theme.${theme}`)?.click();
        if (!wasOpen) look.click();
      },
    },
  },
  'map.ukrainealarm.com': {
    // The onboarding states the map's limits (a safety notice too).
    click: ['[data-detail-map-onboarding-accept]'],
    acceptedStorage: { 'detailMapOnboardingAccepted:v2:main': 'true' },
    hide: ['.bottom-banner'],
    localStorage: {},
    // Dialogs the user opens (region alert history, help). The history one is
    // modal: while open the rest of the page is inert, so map-only mode must
    // not hide it. Not `.popup`: `.popup.region` is a permanent full-page
    // container, and shown above the map it takes every click.
    // #detail-target-tooltip: the hover card of a target (appended to <body>,
    // so map-only mode would hide it); on the top page it shows with
    // "interact" on.
    modals: ['dialog[open]', '#detail-target-tooltip:not([hidden])'],
    overlayModals: ['#detail-target-tooltip:not([hidden])'],
    // Shown while the site's target data is paused (map maintenance).
    notice: '#public-target-data-status',
    // Targets are DOM markers inside the map container; no style layer is a
    // target except a possible heat layer.
    targetLayers: '(heat|target|cloud)',
    // Ukrainian only: no language switch.
    language: null,
    // Light is a class on <html> plus alarm-theme=light; dark is the default
    // (no stored value). One switch toggles between them.
    theme: {
      storageKey: 'alarm-theme',
      stored: { light: 'light', dark: null },
      current: () => (document.documentElement.classList.contains('light') ? 'light' : 'dark'),
      switchTo: () => document.querySelector('.theme-switcher')?.click(),
    },
  },
};

function presetStorage(values) {
  for (const [key, value] of Object.entries(values || {})) {
    try {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
    } catch {
      // Storage can be unavailable; the click rules still apply.
    }
  }
}

// Promo banners and plain UI state: always.
function setupPageCleanup(rules) {
  presetStorage(rules.localStorage);
  if (rules.hide.length) webFrame.insertCSS(`${rules.hide.join(', ')} { display: none !important; }`);
}

// The sites' safety notices (`click`, `acceptedStorage`) are dismissed only
// after the user confirmed the app's own safety notice, which says the same
// (main process: settings.safetyNoticeVersion → page mode `dismissSafety`).
let safetyDismissalOn = false;

function enableSafetyDismissal(rules) {
  if (safetyDismissalOn) return;
  safetyDismissalOn = true;
  presetStorage(rules.acceptedStorage);
  const dismiss = () => {
    for (const selector of rules.click) {
      const el = document.querySelector(selector);
      if (el && el.offsetParent !== null) el.click();
    }
  };
  const start = () => {
    dismiss();
    new MutationObserver(dismiss).observe(document.body, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}

const rules = SITE_RULES[location.hostname];
if (rules) setupPageCleanup(rules);

// The site's own notice about its target data (e.g. ukrainealarm: "Ми
// оновлюємо карту. Відображення цілей буде відновлено найближчим часом.").
// Map-only mode hides it, so its text goes to main, which shows it in the
// toolbar and the stream. Checked every few seconds; only changes are sent.
const SITE_NOTICE_MS = 3000;

function watchSiteNotice(selector) {
  let last;
  const read = () => {
    const el = document.querySelector(selector);
    if (!el || el.hidden || getComputedStyle(el).display === 'none' || !el.getBoundingClientRect().height) return null;
    // textContent: map-only mode makes it visibility:hidden, and innerText
    // skips hidden text.
    return el.textContent.replace(/\s+/g, ' ').trim() || null;
  };
  const check = () => {
    const text = read();
    if (text === last) return;
    last = text;
    ipcRenderer.send('site-notice', text);
  };
  const start = () => {
    check();
    setInterval(check, SITE_NOTICE_MS);
  };
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}

if (rules?.notice) watchSiteNotice(rules.notice);

// A Cloudflare Turnstile check on screen (war-monitor). Only read, never
// touched. After a passed check the overlay element stays in the page with
// aria-hidden="true", so an active check is a rendered overlay without it.
function watchChallenge(selector) {
  let last = false;
  const check = () => {
    const el = document.querySelector(selector);
    const on = Boolean(
      el && el.getAttribute('aria-hidden') !== 'true' && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0,
    );
    if (on === last) return;
    last = on;
    ipcRenderer.send('site-challenge', on);
  };
  const start = () => {
    check();
    setInterval(check, SITE_NOTICE_MS);
  };
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}

if (rules?.challenge) watchChallenge(rules.challenge);

// --- Map view sync -------------------------------------------------------

// Executed in the page's main world. MapLibre's Map constructor assigns
// `this._mapId`, so a one-shot setter on Object.prototype catches every map
// instance, whether maplibre-gl is a global or bundled into the page.
function installMapSync(sendView, sendReady) {
  const USER_MOVE_MS = 1500; // Moves this soon after input are the user's (incl. inertia).
  const maps = [];
  let applying = false;

  Object.defineProperty(Object.prototype, '_mapId', {
    configurable: true,
    get() {
      return undefined;
    },
    set(value) {
      Object.defineProperty(this, '_mapId', { value, writable: true, configurable: true, enumerable: true });
      // Called mid-constructor; finish wiring once the map is fully built.
      const map = this;
      if (typeof map.jumpTo === 'function' && typeof map.getContainer === 'function') queueMicrotask(() => onMap(map));
    },
  });

  // The largest visible map is the main one.
  function mainMap() {
    let best = null;
    let bestArea = 0;
    for (const map of maps) {
      const r = map.getContainer().getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) {
        best = map;
        bestArea = area;
      }
    }
    return best;
  }

  function viewOf(map) {
    const r = map.getContainer().getBoundingClientRect();
    const c = map.getCenter();
    return {
      center: [c.lng, c.lat],
      zoom: map.getZoom(),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
      // Container center in window coordinates; both windows share the same
      // client area, so the receiver can compensate for a different layout.
      cx: r.left + r.width / 2,
      cy: r.top + r.height / 2,
      minZoom: ownLimits.get(map)?.minZoom ?? map.getMinZoom(),
      maxZoom: ownLimits.get(map)?.maxZoom ?? map.getMaxZoom(),
      maxBounds: map.getMaxBounds()?.toArray() ?? null,
    };
  }

  // The page's own zoom limits, before we tighten them to match the other map.
  const ownLimits = new WeakMap();

  // Use the stricter of both maps' zoom limits, so neither map can go where
  // the other cannot follow.
  function matchLimits(map, view) {
    if (!ownLimits.has(map)) ownLimits.set(map, { minZoom: map.getMinZoom(), maxZoom: map.getMaxZoom() });
    const own = ownLimits.get(map);
    const minZoom = Math.max(own.minZoom, view.minZoom);
    const maxZoom = Math.min(own.maxZoom, view.maxZoom);
    if (minZoom <= maxZoom) {
      if (map.getMinZoom() !== minZoom) map.setMinZoom(minZoom);
      if (map.getMaxZoom() !== maxZoom) map.setMaxZoom(maxZoom);
    }
  }

  // The main map's container gets an attribute the HUD CSS keys on.
  function markMainMap() {
    const main = mainMap();
    for (const map of maps) map.getContainer().toggleAttribute('data-nebohliad-main', map === main);
  }

  function onMap(map) {
    maps.push(map);
    markMainMap();
    renderAttribution();
    map.on('styledata', scheduleLayerFilter);
    map.on('load', scheduleLayerFilter);
    // `user`: the move came right after the user's input on this map (a
    // drag, wheel, touch, double-click, keys, MapLibre's zoom buttons); moves
    // made by code (our commands, the site's own) do not. MapLibre's own
    // originalEvent is not enough: wheel-zoom animation frames carry none.
    let inputAt = 0;
    const markInput = () => {
      inputAt = Date.now();
    };
    const container = map.getContainer();
    const capture = { capture: true, passive: true };
    container.addEventListener('wheel', markInput, capture);
    container.addEventListener('pointermove', (event) => event.buttons && markInput(), capture);
    container.addEventListener('touchmove', markInput, capture);
    container.addEventListener('dblclick', markInput, capture);
    container.addEventListener('keydown', markInput, capture);
    container.addEventListener('click', (event) => event.target?.closest?.('.maplibregl-ctrl') && markInput(), capture);
    map.on('move', () => {
      if (map !== mainMap()) return;
      placePin();
      placeLocations();
      if (!applying) sendView({ ...viewOf(map), user: Date.now() - inputAt < USER_MOVE_MS });
    });
    map.on('resize', () => {
      markMainMap();
      placePin();
      placeLocations();
    });
    const ready = () => sendReady();
    if (map.loaded()) ready();
    else map.once('load', ready);
  }

  function setView(view) {
    const map = mainMap();
    if (!map) return false;
    const r = map.getContainer().getBoundingClientRect();
    applying = true;
    try {
      matchLimits(map, view);
      map.jumpTo({ center: view.center, zoom: view.zoom, bearing: view.bearing, pitch: view.pitch });
      // Shift so the source center lands on the same window pixel here.
      const dx = r.left + r.width / 2 - view.cx;
      const dy = r.top + r.height / 2 - view.cy;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        map.jumpTo({ center: map.unproject([r.width / 2 + dx, r.height / 2 + dy]) });
      }
    } finally {
      applying = false;
    }
    // If this map clamped the view (zoom limits, max bounds), send the actual
    // view back once so the source snaps to it instead of drifting apart.
    const p = map.project(view.center);
    const clamped =
      Math.abs(map.getZoom() - view.zoom) > 1e-6 ||
      Math.abs(r.left + p.x - view.cx) > 1 ||
      Math.abs(r.top + p.y - view.cy) > 1;
    if (clamped && !view.bounce) sendView({ ...viewOf(map), bounce: true });
    return true;
  }

  // Re-sent on request (realign, resize): `echo` tells main it is not a move.
  function emitView() {
    const map = mainMap();
    if (map) sendView({ ...viewOf(map), echo: true });
  }

  // Animated move requested by the user (search). Its move events are
  // synced to the other map like any other move.
  function runCommand(command) {
    const map = mainMap();
    if (!map) return;
    // Following a target (follow.js): centered on the location, zoomed from
    // "the whole circle in view" (closeness 0) to as close as this map goes
    // (1), but never so close that `keep` (the target) leaves the view.
    if (command.follow) {
      const { center, bbox, keep, closeness } = command.follow;
      const maxZoom = map.getMaxZoom();
      const zoomFor = (box) => Math.min(maxZoom, map.cameraForBounds(box, { padding: 60 })?.zoom ?? map.getZoom());
      const fitZoom = zoomFor(bbox);
      let zoom = fitZoom + (maxZoom - fitZoom) * Math.min(1, Math.max(0, closeness || 0));
      if (keep) zoom = Math.min(zoom, zoomFor(keep));
      map.flyTo({ center, zoom, duration: 800 });
      return;
    }
    if (command.bbox) map.fitBounds(command.bbox, { padding: 60, maxZoom: 12, duration: 800 });
    // Restoring a saved view at start-up: no animation.
    else if (command.jump) {
      map.jumpTo({ center: command.center, zoom: command.zoom, bearing: command.bearing ?? map.getBearing(), pitch: command.pitch ?? map.getPitch() });
    } else map.flyTo({ center: command.center, zoom: command.zoom ?? map.getZoom(), duration: 800 });
  }

  // A marker for the searched place, drawn as a plain element in the map
  // container so it does not depend on the page's MapLibre build.
  let pin = null;
  let pinEl = null;

  function setPin(value) {
    pin = value;
    pinEl?.remove();
    pinEl = null;
    const map = mainMap();
    if (!pin || !map) return;
    pinEl = document.createElement('div');
    pinEl.style.cssText = [
      'position:absolute', 'left:0', 'top:0', 'width:14px', 'height:14px', 'margin:-10px 0 0 -10px',
      'border-radius:50%', 'background:#ff2d55', 'border:3px solid #fff', 'pointer-events:none', 'z-index:1000',
      'box-shadow:0 0 0 2px rgba(0,0,0,.7),0 0 14px 5px rgba(255,45,85,.75)',
    ].join(';');
    map.getContainer().appendChild(pinEl);
    placePin();
  }

  function placePin() {
    const map = mainMap();
    if (!pinEl || !map) return;
    const p = map.project(pin.center);
    pinEl.style.transform = `translate(${p.x}px, ${p.y}px)`;
  }

  // Targets-only mode: hide every style layer whose id does not match
  // `keepPattern` (the basemap, labels, boundaries). Layers added later are
  // caught through 'styledata'.
  let keepPattern = null;
  const ownVisibility = new Map();
  let filterScheduled = false;

  function scheduleLayerFilter() {
    if (!keepPattern || filterScheduled) return;
    filterScheduled = true;
    requestAnimationFrame(() => {
      filterScheduled = false;
      applyLayerFilter();
    });
  }

  function applyLayerFilter() {
    const map = mainMap();
    // Not isStyleLoaded(): it stays false while sources update, which on a
    // live map is most of the time. Layers exist once the style is parsed.
    let ids;
    try {
      ids = map ? map.getLayersOrder() : [];
    } catch {
      return; // Style not parsed yet; 'styledata' will call again.
    }
    for (const id of ids) {
      // One odd layer must not stop the rest. Custom layers (ukrainealarm's
      // alert regions) throw from setLayoutProperty when shown again; their
      // `visibility` field is what MapLibre's renderer checks, so set it.
      const layer = map.getLayer(id);
      const current = layer?.visibility ?? map.getLayoutProperty(id, 'visibility') ?? 'visible';
      if (!ownVisibility.has(id)) ownVisibility.set(id, current);
      const wanted = !keepPattern || keepPattern.test(id) ? ownVisibility.get(id) : 'none';
      if (current === wanted) continue;
      try {
        map.setLayoutProperty(id, 'visibility', wanted);
      } catch (error) {
        if (layer) {
          layer.visibility = wanted;
          map.triggerRepaint();
        } else {
          console.warn(`[nebohliad] layer ${id}: ${error.message}`);
        }
      }
    }
  }

  function setLayerFilter(patternSource) {
    keepPattern = patternSource ? new RegExp(patternSource) : null;
    applyLayerFilter();
  }

  // Saved locations (base page only): a dot, a label and the alert radius.
  let locationsData = null;
  let locationsEl = null;

  function setLocations(data) {
    locationsData = data && data.locations.length ? data : null;
    locationsEl?.remove();
    locationsEl = null;
    const map = mainMap();
    if (!locationsData || !map) return;
    locationsEl = document.createElement('div');
    locationsEl.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:999';
    for (const loc of locationsData.locations) {
      const item = document.createElement('div');
      item.style.cssText = 'position:absolute;left:0;top:0';
      const ring = document.createElement('div');
      ring.style.cssText = [
        'position:absolute', 'border-radius:50%', 'border:2px dashed rgba(245,179,1,.9)',
        'background:rgba(245,179,1,.06)', `display:${loc.radiusKm ? 'block' : 'none'}`,
      ].join(';');
      const dot = document.createElement('div');
      dot.style.cssText = [
        'position:absolute', 'width:10px', 'height:10px', 'margin:-7px 0 0 -7px', 'border-radius:50%',
        `background:${loc.primary ? '#f5b301' : '#ffffff'}`, 'border:2px solid #111318',
        'box-shadow:0 0 0 2px rgba(255,255,255,.7)',
      ].join(';');
      const label = document.createElement('div');
      label.textContent = (loc.primary ? '⌂ ' : '') + loc.name;
      label.style.cssText = [
        'position:absolute', 'transform:translate(-50%,9px)', 'white-space:nowrap',
        'font:600 12px "Segoe UI",system-ui,sans-serif', 'color:#fff', 'text-shadow:0 0 3px #000,0 0 3px #000',
      ].join(';');
      item.append(ring, dot, label);
      locationsEl.appendChild(item);
    }
    map.getContainer().appendChild(locationsEl);
    placeLocations();
  }

  function placeLocations() {
    const map = mainMap();
    if (!locationsEl || !map) return;
    [...locationsEl.children].forEach((item, i) => {
      const loc = locationsData.locations[i];
      const p = map.project(loc.center);
      item.style.transform = `translate(${p.x}px, ${p.y}px)`;
      if (loc.radiusKm) {
        // Radius in pixels: project a point radiusKm to the north.
        const north = map.project([loc.center[0], loc.center[1] + loc.radiusKm / 111.32]);
        const r = Math.abs(p.y - north.y);
        Object.assign(item.firstChild.style, { width: `${2 * r}px`, height: `${2 * r}px`, left: `${-r}px`, top: `${-r}px` });
      }
    });
  }

  // Targets the page's map currently has, as [{ id, kind, center }], read
  // from the page itself. war-monitor keeps them in its GeoJSON source
  // 'wm-icons'; ukrainealarm draws them as DOM markers in the map container.
  function kindOfIcon(iconType) {
    const t = iconType.toLowerCase();
    if (/ballist/.test(t)) return 'ballistic';
    if (/kab|bomb|guided/.test(t)) return 'kab';
    if (/cruise|missile|rocket|kalibr|banderol/.test(t)) return 'cruise';
    if (/jet|reactive/.test(t)) return 'jet';
    if (/shahed|drone|uav|geran|gerbera|zala|orlan|supercam|lancet/.test(t)) return 'uav';
    if (/aviation|plane|aircraft|tactical/.test(t)) return 'aviation';
    return 'unknown';
  }

  async function readTargets() {
    const map = mainMap();
    if (!map) return [];
    if (window.location.hostname === 'map.war-monitor.org') {
      const source = map.getSource('wm-icons');
      if (!source?.getData) return [];
      const data = await source.getData();
      return (data?.features || [])
        .filter((f) => f.geometry?.type === 'Point' && !f.properties?.stale && f.properties?.main !== false)
        .map((f) => ({ id: String(f.properties.tid), kind: f.properties.cls || 'unknown', center: f.geometry.coordinates.slice(0, 2) }));
    }
    if (window.location.hostname === 'map.ukrainealarm.com') {
      return [...map.getContainer().querySelectorAll('.detailSatelliteTarget.maplibregl-marker')].flatMap((el) => {
        // MapLibre positions markers with the last translate(x px, y px).
        const match = [...el.style.transform.matchAll(/translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/g)].pop();
        if (!match) return [];
        const { lng, lat } = map.unproject([Number(match[1]), Number(match[2])]);
        const kind = kindOfIcon(el.dataset.iconType || '');
        // No ids on the page: type plus a ~20 km cell, so a moving target
        // keeps its id for a while.
        return [{ id: `${kind}:${Math.round(lat * 5)}:${Math.round(lng * 5)}`, kind, center: [lng, lat] }];
      });
    }
    return [];
  }

  // Map data attribution, on the base page only: OpenStreetMap (ODbL) and
  // OpenMapTiles (CC BY) require it, and map-only modes hide the sites' own.
  // `value`: { parts: [{ text, href? }] } or null.
  let attribution = null;
  let attributionEl = null;

  function setAttribution(value) {
    attribution = value;
    renderAttribution();
  }

  function renderAttribution() {
    attributionEl?.remove();
    attributionEl = null;
    const map = mainMap();
    if (!attribution || !map) return;
    attributionEl = document.createElement('div');
    attributionEl.style.cssText = [
      'position:absolute', 'right:0', 'bottom:0', 'z-index:1001', 'padding:2px 6px',
      'font:11px/1.4 "Segoe UI",system-ui,sans-serif', 'color:#1d2026',
      'background:rgba(255,255,255,.78)', 'border-top-left-radius:4px', 'pointer-events:auto',
    ].join(';');
    attribution.parts.forEach((part, i) => {
      if (i) attributionEl.append(' · ');
      if (part.href) {
        const link = document.createElement('a');
        link.href = part.href;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = part.text;
        link.style.cssText = 'color:inherit;text-decoration:underline';
        attributionEl.append(link);
      } else {
        attributionEl.append(part.text);
      }
    });
    map.getContainer().appendChild(attributionEl);
  }

  // Official air alerts for given points (ukrainealarm only). The page keeps
  // the current alerts in window.ukraineAlarmLatestAlerts (per State /
  // District / Community regionId, with level and reason) and loads the
  // region polygons through window.detailMapGeometry.load() (its own cached
  // static GeoJSON). Which regions contain a point is computed once.
  let geometryLoad = null;
  const regionsByPoint = new Map();
  const featureBox = new WeakMap();

  function ringContains(ring, x, y) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function polygonContains(polygon, x, y) {
    if (!ringContains(polygon[0], x, y)) return false;
    return !polygon.slice(1).some((hole) => ringContains(hole, x, y));
  }

  function boxOf(feature) {
    if (!featureBox.has(feature)) {
      let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
      const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
      for (const polygon of polygons) {
        for (const [x, y] of polygon[0]) {
          if (x < w) w = x;
          if (x > e) e = x;
          if (y < s) s = y;
          if (y > n) n = y;
        }
      }
      featureBox.set(feature, [w, s, e, n]);
    }
    return featureBox.get(feature);
  }

  function regionsContaining(collection, [x, y]) {
    return collection.features
      .filter((f) => {
        const type = f.geometry?.type;
        if (type !== 'Polygon' && type !== 'MultiPolygon') return false;
        const [w, s, e, n] = boxOf(f);
        if (x < w || x > e || y < s || y > n) return false;
        const polygons = type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
        return polygons.some((polygon) => polygonContains(polygon, x, y));
      })
      .map((f) => ({ regionId: String(f.properties?.regionId ?? f.id), name: f.properties?.name || '', rank: f.properties?.rank || 0 }));
  }

  // points: [{ id, center }] → [{ id, regions: [name], alerts: [{ region, rank, level, reason }] }],
  // or null when this page has no such data.
  async function readAirAlerts(points) {
    if (window.location.hostname !== 'map.ukrainealarm.com') return null;
    const alerts = window.ukraineAlarmLatestAlerts;
    if (!window.detailMapGeometry?.load || !Array.isArray(alerts)) return null;
    geometryLoad ||= window.detailMapGeometry.load();
    const collection = await geometryLoad;
    const byRegion = new Map(alerts.map((a) => [String(a.regionId), a]));
    return points.map(({ id, center }) => {
      const key = center.join(',');
      if (!regionsByPoint.has(key)) regionsByPoint.set(key, regionsContaining(collection, center));
      const regions = regionsByPoint.get(key);
      const active = regions.flatMap((r) =>
        (byRegion.get(r.regionId)?.activeAlerts || [])
          .filter((x) => x.type === 'AIR')
          .map((x) => ({
            region: byRegion.get(r.regionId).regionName || r.name,
            rank: r.rank,
            level: x.activeAlertLevels?.[0]?.alertLevel || null,
            reason: x.activeAlertLevels?.[0]?.reason || null,
          })),
      );
      return { id, regions: regions.map((r) => r.name), alerts: active };
    });
  }

  return { setView, emitView, runCommand, setPin, setLayerFilter, setLocations, readTargets, setAttribution, readAirAlerts };
}

// Executed in the page's main world before its scripts: caps how often
// requestAnimationFrame callbacks run, which is what MapLibre (and most page
// animation) draws through. Returns a setter; 0 or >= 60 means no limit.
function installFrameLimit() {
  const nativeRaf = window.requestAnimationFrame.bind(window);
  let intervalMs = 0;
  let queue = new Map();
  let nextId = 1;
  let scheduled = false;
  let lastRun = 0;

  function run(timestamp) {
    scheduled = false;
    lastRun = performance.now();
    const callbacks = queue;
    queue = new Map();
    for (const callback of callbacks.values()) {
      try {
        callback(timestamp);
      } catch (error) {
        setTimeout(() => {
          throw error;
        });
      }
    }
  }

  // The native frame after the timer adds up to one display frame (~16 ms);
  // waiting half a frame less keeps the average close to the limit.
  const HALF_FRAME_MS = 8;

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    const wait = lastRun + intervalMs - HALF_FRAME_MS - performance.now();
    if (intervalMs && wait > 1) setTimeout(() => nativeRaf(run), wait);
    else nativeRaf(run);
  }

  window.requestAnimationFrame = function requestAnimationFrame(callback) {
    const id = nextId++;
    queue.set(id, callback);
    schedule();
    return id;
  };
  window.cancelAnimationFrame = function cancelAnimationFrame(id) {
    queue.delete(id);
  };

  return {
    setFrameLimit(fps) {
      intervalMs = fps > 0 && fps < 60 ? 1000 / fps : 0;
    },
  };
}

const frameLimit = contextBridge.executeInMainWorld({ func: installFrameLimit });

// Executed in the page's main world before its scripts: notes when a message
// last arrived on any of the page's WebSockets (ukrainealarm's targets come
// over one). Only the time, never the contents.
function installSocketWatch() {
  const NativeWebSocket = window.WebSocket;
  let lastMessageAt = 0;
  class WebSocket extends NativeWebSocket {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', () => {
        lastMessageAt = Date.now();
      });
    }
  }
  window.WebSocket = WebSocket;
  return { lastMessageAt: () => lastMessageAt };
}

const socketWatch = contextBridge.executeInMainWorld({ func: installSocketWatch });

// Tells main (site-health.js) that data is arriving, at most every 15 s.
let socketReported = 0;
setInterval(() => {
  const at = socketWatch.lastMessageAt();
  if (at <= socketReported) return;
  socketReported = at;
  ipcRenderer.send('site-data');
}, 15_000);

const mapSync = contextBridge.executeInMainWorld({
  func: installMapSync,
  args: [
    (view) => ipcRenderer.send('map-view', view),
    () => ipcRenderer.send('map-ready'),
  ],
});

ipcRenderer.on('set-map-view', (_event, view) => mapSync.setView(view));
ipcRenderer.on('emit-map-view', () => mapSync.emitView());
ipcRenderer.on('map-command', (_event, command) => mapSync.runCommand(command));
ipcRenderer.on('map-pin', (_event, pin) => mapSync.setPin(pin));
ipcRenderer.on('map-locations', (_event, data) => mapSync.setLocations(data));
ipcRenderer.on('read-air-alerts', async (_event, points) => {
  let result = null;
  try {
    result = await mapSync.readAirAlerts(points);
  } catch {
    // Page not ready or changed: report nothing.
  }
  ipcRenderer.send('map-air-alerts', result);
});
ipcRenderer.on('read-targets', async () => {
  let targets = [];
  try {
    targets = await mapSync.readTargets();
  } catch {
    // Map not ready or the site changed: report nothing.
  }
  ipcRenderer.send('map-targets', targets);
});

// --- Page modes ------------------------------------------------------------

const MAIN_MAP = '[data-nebohliad-main]';

// Map only (HUD hidden, and always in targets-only mode): everything but the
// main map is invisible, and the map fills the page. The view sync works from
// the container's position, so the changed layout is fine. Turnstile's
// overlay stays visible and above the map.
const MAP_ONLY_CSS = `
  body * { visibility: hidden !important; }
  ${MAIN_MAP}, ${MAIN_MAP} * { visibility: visible !important; }
  ${MAIN_MAP} {
    position: fixed !important; inset: 0 !important; width: auto !important; height: auto !important;
    max-width: none !important; max-height: none !important; margin: 0 !important;
    transform: none !important; z-index: 2147483000 !important;
  }
  ${MAIN_MAP} .maplibregl-control-container { display: none !important; }
  .ts-overlay { z-index: 2147483647 !important; }
  .ts-overlay, .ts-overlay * { visibility: visible !important; }
`;

// Map only: the site's own popups stay visible and above the map. Hidden, an
// open one would still lock the map with no way to close it. On the overlay
// page only `overlayModals`: clicks pass through it unless "interact" is on,
// so only popups that are opened (and closed) with interact belong there.
function modalsCss(selectors) {
  if (!selectors?.length) return '';
  const all = selectors.join(', ');
  const withChildren = selectors.map((s) => `${s}, ${s} *`).join(', ');
  return `${withChildren} { visibility: visible !important; }\n  ${all} { z-index: 2147483001 !important; }`;
}

// Targets only (overlay page): no page backgrounds, so the base map shows
// through wherever no target is drawn.
const TRANSPARENT_CSS = `
  html, body, ${MAIN_MAP}, ${MAIN_MAP} .maplibregl-canvas-container { background: transparent !important; }
`;

const cssKeys = {};

function toggleCss(name, css, enabled) {
  if (enabled && !cssKeys[name]) cssKeys[name] = webFrame.insertCSS(css);
  if (!enabled && cssKeys[name]) {
    webFrame.removeInsertedCSS(cssKeys[name]);
    delete cssKeys[name];
  }
}

// Language and theme are stored where the site reads them on start-up; that
// covers page loads. Later changes also flip the site's own switch (`live`).
function setLanguage(lang, live) {
  const language = rules?.language;
  if (!language) return;
  try {
    localStorage.setItem(language.storageKey, lang);
  } catch {
    // Storage unavailable: the live switch still works.
  }
  // The button for `lang` is only there while the page shows the other one.
  if (live) document.querySelector(language.switchTo[lang])?.click();
}

// `theme` is 'light' or 'dark' (the main process resolves 'system').
function setTheme(theme, live) {
  const rule = rules?.theme;
  if (!rule) return;
  try {
    const value = rule.stored[theme];
    if (value === null) localStorage.removeItem(rule.storageKey);
    else localStorage.setItem(rule.storageKey, value);
  } catch {
    // Storage unavailable: the live switch still works.
  }
  if (live && rule.current() !== theme) rule.switchTo(theme);
}

function setPageMode(mode, live) {
  const targetsOnly = Boolean(mode.targetsOnly && rules?.targetLayers);
  // Each step on its own: a failure in one (a site changed) must not leave
  // the others (attribution, safety, theme…) unapplied.
  const steps = [
    () => toggleCss('mapOnly', MAP_ONLY_CSS, mode.hudHidden || targetsOnly),
    () => toggleCss('modals', modalsCss(rules?.modals), Boolean(mode.isBase && mode.hudHidden && rules?.modals?.length)),
    () => toggleCss('overlayModals', modalsCss(rules?.overlayModals), Boolean(!mode.isBase && (mode.hudHidden || targetsOnly) && rules?.overlayModals?.length)),
    () => toggleCss('transparent', TRANSPARENT_CSS, targetsOnly),
    () => mapSync.setLayerFilter(targetsOnly ? rules.targetLayers : null),
    () => mapSync.setAttribution(mode.attribution || null),
    () => mode.dismissSafety && rules && enableSafetyDismissal(rules),
    () => setLanguage(mode.lang, live),
    () => setTheme(mode.theme, live),
    () => frameLimit.setFrameLimit(mode.fps),
  ];
  for (const step of steps) {
    try {
      step();
    } catch (error) {
      console.warn(`[nebohliad] page mode: ${error.message}`);
    }
  }
}

ipcRenderer.on('page-mode', (_event, mode) => setPageMode(mode, document.readyState !== 'loading'));
// Apply before the page paints, so nothing flashes over the base map, and
// before its scripts read the stored language and theme.
setPageMode(ipcRenderer.sendSync('get-page-mode'), false);
