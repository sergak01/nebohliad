'use strict';

// A demonstration of following a target (Settings → Locations): a made-up
// target, clearly marked "DEMO", flies past a saved location (the primary
// one) through its alert radius, and a separate instance of the real follow
// logic (follow.js) moves the base map as it would for a real one. Captions
// in the toolbar (and, for stream viewers, on the frames) say what happens;
// viewers also get the notifications they would get, marked "DEMO", without
// sound, vibration or browser notifications.
//
// The demo never touches alerts.js: no Windows notification, no ⚠ counter,
// no log of targets. It does not start while real targets are in range, and
// stops as soon as one comes (main.js), or when the user moves the map.

const { setupFollow, closeness } = require('./follow');
const { distanceKm } = require('./alerts');

const DURATION_MS = 30_000; // From 1.5 radii out, past the point, 1.5 radii out.
const PASS_MS = 26_000;
const DONE_MS = 4_000; // The last caption stays this long.
const FOLLOW_EVERY_MS = 1000;
const MARKER_EVERY_MS = 200;
const START_SHARE = 1.5; // Starts and ends this many radii away.
const PASS_SHARE = 0.12; // Passes this share of the radius from the point.
const BEARING = 250; // Flies toward west-south-west.
const CLOSER_T = 0.15; // follow.js closeness from which "closer" is said.
const INSIDE_CAPTION_MS = 3000; // "Within the radius" is said at least this long.

const STRINGS = {
  uk: {
    label: 'ДЕМО · БпЛА',
    approach: (name, r) => `Ціль ще за межами радіуса «${name}» (${r} км): мапа не рухається`,
    inside: (name) => `Ціль у радіусі: мапа центрується на «${name}» і показує все коло`,
    closer: (km) => `Ціль ближче (~${km} км): мапа наближається, ціль лишається в кадрі`,
    left: 'Ціль вийшла з радіуса: мапа повертається туди, де була',
    tookOver: 'Мапу зсунуто вручну: слідкування відпускає її й не повертає назад',
    done: 'Демонстрацію завершено',
    doneOff: 'Демонстрацію завершено. Слідкування вмикається в Налаштуваннях → Локації',
    stopped: 'Демонстрацію зупинено',
    strip: (caption) => `ДЕМОНСТРАЦІЯ, ціль не справжня · ${caption}`,
    banner: (km, name) => `ДЕМО · ⚠ БпЛА ~${km} км від «${name}»`,
    alertTitle: (name) => `ДЕМО · Повітряна тривога: «${name}»`,
    alertBody: 'Так виглядає початок тривоги в районі локації.',
    droneTitle: (name) => `ДЕМО · Дрон поблизу «${name}»`,
    droneBody: (km) => `БпЛА · ~${km} км · це демонстрація, не справжня ціль`,
    endTitle: (name) => `ДЕМО · Відбій тривоги: «${name}»`,
    endBody: 'Демонстрацію завершено.',
  },
  en: {
    label: 'DEMO · Drone',
    approach: (name, r) => `The target is still outside the radius of “${name}” (${r} km): the map stays`,
    inside: (name) => `The target is within the radius: the map centers on “${name}” with the whole circle in view`,
    closer: (km) => `The target is closer (~${km} km): the map zooms in, the target stays in view`,
    left: 'The target left the radius: the map goes back to where it was',
    tookOver: 'The map was moved by hand: following lets go and does not move it back',
    done: 'The demonstration is over',
    doneOff: 'The demonstration is over. Following is turned on in Settings → Locations',
    stopped: 'The demonstration was stopped',
    strip: (caption) => `DEMONSTRATION, not a real target · ${caption}`,
    banner: (km, name) => `DEMO · ⚠ Drone ~${km} km from “${name}”`,
    alertTitle: (name) => `DEMO · Air alert: “${name}”`,
    alertBody: 'This is how an air alert in a location’s area begins.',
    droneTitle: (name) => `DEMO · Drone near “${name}”`,
    droneBody: (km) => `Drone · ~${km} km · a demonstration, not a real target`,
    endTitle: (name) => `DEMO · All clear: “${name}”`,
    endBody: 'The demonstration is over.',
  },
};

// The point `km` away from [lng, lat] in direction `bearing` (degrees).
function offset([lng, lat], km, bearing) {
  const rad = Math.PI / 180;
  const b = bearing * rad;
  const dLat = (km * Math.cos(b)) / 111.32;
  const dLng = (km * Math.sin(b)) / (111.32 * Math.cos(lat * rad));
  return [lng + dLng, lat + dLat];
}

// overlay: { settings, locations, mapCommand(command), currentView(),
// sendToBase(channel, data), streamEvent(event), changed() }.
function setupDemo(overlay) {
  const { settings } = overlay;
  let run = null; // { location, radius, startedAt, timers, caption, inside, ... }

  const strings = () => STRINGS[settings.lang] || STRINGS.uk;

  // The real follow logic on its own state, always on, not logged.
  const follow = setupFollow({
    settings: {
      follow: 'always',
      get alerts() {
        return settings.alerts;
      },
    },
    mapCommand: (command) => overlay.mapCommand(command),
    currentView: () => overlay.currentView(),
    streamWatched: () => false,
    quiet: true,
  });

  function location() {
    return overlay.locations.primary() || overlay.locations.list()[0] || null;
  }

  // Where the target is `ms` into the pass: a straight line past the point.
  function targetAt(ms) {
    const r = run.radius;
    const half = Math.sqrt(START_SHARE ** 2 - PASS_SHARE ** 2) * r;
    const along = -half + (2 * half * Math.min(ms, PASS_MS)) / PASS_MS;
    const side = offset(run.location.center, PASS_SHARE * r, BEARING - 90);
    return offset(side, along, BEARING);
  }

  function setCaption(text) {
    if (run.caption === text) return;
    run.caption = text;
    overlay.changed();
  }

  function event(kind, title, body, level) {
    overlay.streamEvent({ kind, title, body, level, tag: `demo:${kind === 'alert-end' ? 'alert' : kind}`, demo: true, quiet: true });
  }

  function tickMarker() {
    if (!run || run.finished) return;
    const center = targetAt(Date.now() - run.startedAt);
    overlay.sendToBase('map-demo-target', { center, label: strings().label });
  }

  function tickFollow() {
    if (!run || run.finished) return;
    const s = strings();
    const ms = Date.now() - run.startedAt;
    const center = targetAt(ms);
    const km = distanceKm(center, run.location.center);
    const inside = km <= run.radius;
    run.km = km;
    run.inside = inside;
    if (inside) {
      if (!run.entered) {
        run.entered = true;
        run.enteredAt = ms;
        event('drone', s.droneTitle(run.location.name), s.droneBody(Math.round(km)), 'warning');
      }
      follow.update([{ target: { center, kind: 'uav' }, location: run.location, km, radius: run.radius }]);
    } else {
      follow.update([]);
    }
    if (run.tookOver) setCaption(s.tookOver);
    else if (!run.entered) setCaption(s.approach(run.location.name, run.radius));
    else if (!inside) setCaption(s.left);
    else {
      const closer = closeness(km, run.radius) >= CLOSER_T && ms - run.enteredAt >= INSIDE_CAPTION_MS;
      setCaption(closer ? s.closer(Math.max(1, Math.round(km))) : s.inside(run.location.name));
    }
    if (ms >= DURATION_MS) finish(settings.follow === 'off' ? s.doneOff : s.done);
  }

  // The demo's end: the marker goes, the last caption stays a little.
  function finish(caption) {
    if (!run || run.finished) return;
    const s = strings();
    run.finished = true;
    for (const timer of run.timers) clearInterval(timer);
    follow.update([]); // Back to the view from before, unless taken over.
    overlay.sendToBase('map-demo-target', null);
    event('alert-end', s.endTitle(run.location.name), s.endBody, 'clear');
    setCaption(caption);
    const ended = run;
    setTimeout(() => {
      if (run === ended) {
        run = null;
        overlay.changed();
      }
    }, DONE_MS);
  }

  // Returns null when started, else why not: 'no-location' | 'targets-near'.
  function start(realTargetsNear) {
    if (realTargetsNear) return 'targets-near';
    const loc = location();
    if (!loc) return 'no-location';
    if (run && !run.finished) return null; // Already running.
    const s = strings();
    run = {
      location: loc,
      radius: overlay.locations.radiusOf(loc),
      startedAt: Date.now(),
      caption: '',
      entered: false,
      inside: false,
      tookOver: false,
      finished: false,
    };
    run.timers = [setInterval(tickMarker, MARKER_EVERY_MS), setInterval(tickFollow, FOLLOW_EVERY_MS)];
    event('alert', s.alertTitle(loc.name), s.alertBody, 'yellow');
    tickMarker();
    tickFollow();
    return null;
  }

  function stop() {
    if (run && !run.finished) finish(strings().stopped);
  }

  // The user moved a map (or went somewhere): following lets go, as it would.
  function userMoved() {
    if (!run || run.finished || run.tookOver) return;
    follow.userMoved();
    if (follow.isFollowing()) {
      run.tookOver = true;
      setCaption(strings().tookOver);
    }
  }

  // For the toolbar and settings: { running, caption } or null.
  function state() {
    return run ? { running: !run.finished, caption: run.caption } : null;
  }

  // For the stream's frames: the red banner while the demo target is in
  // range, and the amber strip with the caption.
  function banner() {
    if (!run || run.finished || !run.inside) return null;
    return strings().banner(Math.max(1, Math.round(run.km)), run.location.name);
  }
  function strip() {
    return run?.caption ? strings().strip(run.caption) : null;
  }

  return {
    start,
    stop,
    userMoved,
    state,
    banner,
    strip,
    running: () => Boolean(run && !run.finished),
    // While the demo follows, the map view to save is the one from before.
    savedView: () => (follow.isFollowing() ? follow.savedView() : null),
  };
}

module.exports = { setupDemo };
