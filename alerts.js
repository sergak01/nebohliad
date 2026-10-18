'use strict';

// Proximity and air-alert events. Every few seconds both pages report the
// targets their map currently shows, and the ukrainealarm page reports the
// official air alerts covering each saved location (preload.js reads both
// from the pages themselves: no extra network requests).
// - A Windows notification fires when a new target comes within the alert
//   radius of a location (if alerts are on); the toolbar counts targets near.
// - The LAN stream's viewers get events (overlay.streamEvent): drones near,
//   other targets near, air alert started / changed / ended in a location's
//   area. Whether they show them is each viewer's choice.

const { Notification, ipcMain } = require('electron');

const POLL_MS = 5000;
const STALE_REPORT_MS = 30_000; // Ignore a page that stopped reporting.
const MIN_NOTIFY_INTERVAL_MS = 3 * 60_000; // Per location, after the first one.
const MIN_STREAM_EVENT_INTERVAL_MS = 60_000; // Per location and kind, for viewers.
const FORGET_TARGET_MS = 15 * 60_000; // A target unseen this long is new again.
const MAX_LINES = 4;
const DRONE_KINDS = new Set(['uav', 'jet']);

const STRINGS = {
  uk: {
    title: (name, count) => `${count === 1 ? 'Ціль' : `Цілей: ${count}`} поблизу «${name}»`,
    line: (kind, km, site) => `${kind} · ~${km} км · ${site}`,
    more: (n) => `і ще ${n}`,
    tail: 'Не замінює офіційної тривоги.',
    // The nearest target first, then how many there are.
    banner: (n, kind, km, name) => `⚠ ${kind} ~${km} км від «${name}»${n > 1 ? ` · усього поблизу: ${n}` : ''}`,
    testTitle: 'Небогляд: перевірка сповіщень',
    testBody: 'Так виглядатиме сповіщення про ціль поблизу локації.',
    droneTitle: (name, count) => `${count === 1 ? 'Дрон' : `Дронів: ${count}`} поблизу «${name}»`,
    alertTitle: (name) => `Повітряна тривога: «${name}»`,
    alertChangeTitle: (name) => `Тривога змінилась: «${name}»`,
    alertEndTitle: (name) => `Відбій тривоги: «${name}»`,
    alertBody: (region, reason) => (reason ? `${region}: ${reason}` : region),
    kinds: {
      uav: 'БпЛА', jet: 'Реактивний БпЛА', cruise: 'Крилата ракета', ballistic: 'Балістична ракета',
      aviation: 'Авіація', kab: 'КАБ', unknown: 'Ціль',
    },
  },
  en: {
    title: (name, count) => `${count === 1 ? 'Target' : `${count} targets`} near “${name}”`,
    line: (kind, km, site) => `${kind} · ~${km} km · ${site}`,
    more: (n) => `and ${n} more`,
    tail: 'Not a replacement for official alerts.',
    banner: (n, kind, km, name) => `⚠ ${kind} ~${km} km from “${name}”${n > 1 ? ` · ${n} near in all` : ''}`,
    testTitle: 'Nebohliad: notification test',
    testBody: 'This is how a target near a location will be announced.',
    droneTitle: (name, count) => `${count === 1 ? 'Drone' : `${count} drones`} near “${name}”`,
    alertTitle: (name) => `Air alert: “${name}”`,
    alertChangeTitle: (name) => `Alert changed: “${name}”`,
    alertEndTitle: (name) => `All clear: “${name}”`,
    alertBody: (region, reason) => (reason ? `${region}: ${reason}` : region),
    kinds: {
      uav: 'Drone', jet: 'Jet drone', cruise: 'Cruise missile', ballistic: 'Ballistic missile',
      aviation: 'Aircraft', kab: 'Guided bomb', unknown: 'Target',
    },
  },
};

function distanceKm([lng1, lat1], [lng2, lat2]) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

function setupAlerts(overlay, locations) {
  const { settings } = overlay;
  const reports = {}; // site id -> { at, targets: [{ id, kind, center }] }
  const perLocation = new Map(); // location id -> { seen: Map(key -> at), notifiedAt }
  let nearby = [];

  const strings = () => STRINGS[settings.lang] || STRINGS.uk;

  ipcMain.on('map-targets', (event, targets) => {
    const site = overlay.siteOf(event.sender);
    if (site && Array.isArray(targets)) reports[site] = { at: Date.now(), targets };
  });

  function evaluate() {
    const now = Date.now();
    const radius = settings.alerts.radiusKm;
    const hits = [];
    for (const [site, report] of Object.entries(reports)) {
      if (now - report.at > STALE_REPORT_MS) continue;
      for (const target of report.targets) {
        for (const location of locations.list()) {
          const km = distanceKm(location.center, target.center);
          if (km <= radius) hits.push({ site, target, location, km, key: `${site}:${target.id}` });
        }
      }
    }
    hits.sort((a, b) => a.km - b.km);
    nearby = hits;
    overlay.nearbyChanged(hits.map((h) => ({ locationId: h.location.id, location: h.location.name, kind: h.target.kind, km: Math.round(h.km), site: h.site })));
    handleNew(hits, now);
  }

  // New targets per location: a desktop notification (when alerts are on)
  // and events for stream viewers (drones and other targets separately).
  function handleNew(hits, now) {
    for (const location of locations.list()) {
      const state = perLocation.get(location.id) || { seen: new Map(), notifiedAt: 0, streamAt: {} };
      perLocation.set(location.id, state);
      const here = hits.filter((h) => h.location.id === location.id);
      const fresh = here.filter((h) => !state.seen.has(h.key));
      for (const h of here) state.seen.set(h.key, now);
      for (const [key, at] of state.seen) if (now - at > FORGET_TARGET_MS) state.seen.delete(key);
      if (!fresh.length) continue;
      const canNotify = state.notifiedAt === 0 || now - state.notifiedAt >= MIN_NOTIFY_INTERVAL_MS;
      if (settings.alerts.enabled && canNotify) {
        state.notifiedAt = now;
        notify(location, here);
      }
      for (const kind of ['drone', 'target']) {
        const isDrone = (h) => DRONE_KINDS.has(h.target.kind);
        const group = here.filter((h) => (kind === 'drone' ? isDrone(h) : !isDrone(h)));
        const groupFresh = fresh.filter((h) => (kind === 'drone' ? isDrone(h) : !isDrone(h)));
        if (!groupFresh.length || now - (state.streamAt[kind] || 0) < MIN_STREAM_EVENT_INTERVAL_MS) continue;
        state.streamAt[kind] = now;
        streamTargets(kind, location, group);
      }
    }
  }

  function targetLines(here, s) {
    const lines = here
      .slice(0, MAX_LINES)
      .map((h) => s.line(s.kinds[h.target.kind] || s.kinds.unknown, Math.round(h.km), overlay.siteLabel(h.site)));
    if (here.length > MAX_LINES) lines.push(s.more(here.length - MAX_LINES));
    return lines;
  }

  function streamTargets(kind, location, group) {
    const s = strings();
    overlay.streamEvent({
      kind,
      title: kind === 'drone' ? s.droneTitle(location.name, group.length) : s.title(location.name, group.length),
      body: targetLines(group, s).join('\n'),
      level: 'warning',
      tag: `${kind}:${location.id}`,
    });
  }

  // --- Official air alerts in each location's area (ukrainealarm) ----------

  const airState = new Map(); // location id -> { active, level, region, reason }

  // The most significant alert: red over yellow, then the most specific
  // region (community > district > oblast).
  function summarize(list) {
    if (!list?.length) return { active: false };
    const order = (a) => (a.level === 'Red' ? 2 : a.level === 'Yellow' ? 1 : 0) * 10 + a.rank;
    const top = [...list].sort((a, b) => order(b) - order(a))[0];
    return { active: true, level: top.level, region: top.region, reason: top.reason };
  }

  function alertEvent(kind, location, info) {
    const s = strings();
    const title = { alert: s.alertTitle, 'alert-change': s.alertChangeTitle, 'alert-end': s.alertEndTitle }[kind](location.name);
    return {
      kind,
      title,
      body: s.alertBody(info.region, kind === 'alert-end' ? null : info.reason),
      level: kind === 'alert-end' ? 'clear' : info.level === 'Red' ? 'red' : 'yellow',
      tag: `alert:${location.id}`,
    };
  }

  ipcMain.on('map-air-alerts', (event, list) => {
    if (overlay.siteOf(event.sender) !== 'ukrainealarm' || !Array.isArray(list)) return;
    for (const item of list) {
      const location = locations.find(item.id);
      if (!location) continue;
      const before = airState.get(location.id) || { active: false };
      const now = summarize(item.alerts);
      airState.set(location.id, now);
      if (!before.active && now.active) overlay.streamEvent(alertEvent('alert', location, now));
      else if (before.active && !now.active) overlay.streamEvent(alertEvent('alert-end', location, before));
      else if (before.active && now.active && (before.level !== now.level || before.region !== now.region)) {
        overlay.streamEvent(alertEvent('alert-change', location, now));
      }
    }
  });

  function pollAirAlerts() {
    const points = locations.list().map((l) => ({ id: l.id, center: l.center }));
    if (points.length) overlay.sendToSite('ukrainealarm', 'read-air-alerts', points);
  }

  // Ongoing alerts, for a viewer that just connected.
  function snapshot() {
    return locations
      .list()
      .filter((l) => airState.get(l.id)?.active)
      .map((l) => ({ ...alertEvent('alert', l, airState.get(l.id)), ongoing: true }));
  }

  function notify(location, here) {
    const s = strings();
    const lines = targetLines(here, s);
    lines.push(s.tail);
    show(s.title(location.name, here.length), lines.join('\n'), () => {
      overlay.restoreMain();
      locations.show(location.id);
    });
  }

  function show(title, body, onClick) {
    if (!Notification.isSupported()) return false;
    const notification = new Notification({ title, body });
    if (onClick) notification.on('click', onClick);
    notification.show();
    return true;
  }

  function test() {
    const s = strings();
    return show(s.testTitle, s.testBody);
  }

  const timer = setInterval(() => {
    evaluate(); // On the reports from the previous round.
    overlay.sendToPages('read-targets');
    pollAirAlerts();
  }, POLL_MS);
  timer.unref?.();

  // One line for the LAN stream's frames while targets are in range.
  function banner() {
    if (!nearby.length) return null;
    const s = strings();
    const nearest = nearby[0];
    return s.banner(nearby.length, s.kinds[nearest.target.kind] || s.kinds.unknown, Math.round(nearest.km), nearest.location.name);
  }

  return { test, banner, snapshot, nearby: () => nearby, supported: () => Notification.isSupported() };
}

module.exports = { setupAlerts, distanceKm };
