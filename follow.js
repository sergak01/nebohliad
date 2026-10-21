'use strict';

// Following a target near a location. While a target is within the alert
// radius of a saved location, the base map centers on that location (the
// point, not the target). The closer the nearest target is to the point, the
// closer the zoom: at the edge of the radius the whole circle is in view,
// within CLOSEST_SHARE of the radius the map zooms in as far as it can, and in
// between the zoom moves evenly from one to the other; the target always
// stays in the picture (the page works out the zoom levels, see preload.js
// `runCommand` {follow}). When no target is near any more, the map goes back
// to the view it had before. settings.follow: 'off' | 'stream' (only while
// someone watches the LAN stream) | 'always'.
//
// If the user moves either map while it follows (the page marks moves that
// come from input, see preload.js), or goes somewhere with search, home or a
// location, they have taken over: the map is left where they put it, and is
// not moved back at the end either. Moves made by code never count: a time
// window after our own commands was not enough, since in a hidden window the
// map's animation runs at ~1 frame/s and its last moves came late.

const { distanceKm } = require('./alerts');
const log = require('./logger');

const MODES = ['off', 'stream', 'always'];
const MARGIN = 1.1; // A little room around the circle.
const RECENTER_SHARE = 0.15; // Re-center when the target moved this share of the view.
const CLOSEST_SHARE = 0.2; // Closer than this share of the radius: the closest zoom.
const CLOSEST_VIEW_KM = 0.5; // Rough half-width of the view at the closest zoom.
const ZOOM_STEP = 0.05; // Re-zoom when the closeness changed this much.
const KEEP_MARGIN = 1.3; // The target and some room around it stay in view.
const KEEP_MIN_KM = 0.3;

// 0 at the edge of the radius (or beyond), 1 within CLOSEST_SHARE of it.
function closeness(distance, radius) {
  if (!(radius > 0)) return 0;
  return Math.min(1, Math.max(0, (radius - distance) / (radius * (1 - CLOSEST_SHARE))));
}

function squareAround([lng, lat], halfKm) {
  const dLat = halfKm / 111.32;
  const dLng = halfKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  return [
    [lng - dLng, lat - dLat],
    [lng + dLng, lat + dLat],
  ];
}

// overlay: { settings, mapCommand(command), currentView(), streamWatched() }.
function setupFollow(overlay) {
  const { settings } = overlay;
  let following = false;
  let savedView = null; // The view before following started.
  let tookOver = false;
  let last = null; // { location, t, distance } of the last view we set.

  const mode = () => (MODES.includes(settings.follow) ? settings.follow : 'off');
  const active = () => mode() === 'always' || (mode() === 'stream' && overlay.streamWatched());

  const move = (command) => overlay.mapCommand(command);

  // hits: alerts.js nearby list, nearest first: [{ target, location, km, key }].
  function update(hits) {
    const nearest = active() ? hits?.[0] : null;
    if (!nearest) {
      stop();
      return;
    }
    if (!following) {
      log.info('follow', 'start', { location: nearest.location.name });
      following = true;
      tookOver = false;
      savedView = overlay.currentView();
      last = null;
    }
    if (tookOver) return;
    const radius = nearest.radius || settings.alerts.radiusKm;
    const point = nearest.location.center;
    const distance = distanceKm(nearest.target.center, point);
    // The square that shows the whole circle around the point, how far to
    // zoom in from it, and the square that must stay in view (the target).
    const halfKm = radius * MARGIN;
    const t = closeness(distance, radius);
    const keepKm = Math.max(distance * KEEP_MARGIN, KEEP_MIN_KM);
    // Roughly how wide the view will be, so small moves are not chased when
    // zoomed out but are when zoomed in.
    const viewKm = Math.max(halfKm ** (1 - t) * CLOSEST_VIEW_KM ** t, keepKm);
    if (
      last &&
      last.location === nearest.location.id &&
      Math.abs(t - last.t) < ZOOM_STEP &&
      Math.abs(distance - last.distance) < viewKm * RECENTER_SHARE
    ) {
      return;
    }
    last = { location: nearest.location.id, t, distance };
    move({
      follow: { center: point, bbox: squareAround(point, halfKm), keep: squareAround(point, keepKm), closeness: t },
    });
  }

  function stop() {
    if (!following) return;
    log.info('follow', tookOver ? 'end (the user had moved the map)' : 'end, view restored');
    following = false;
    if (!tookOver && savedView) move({ center: savedView.center, zoom: savedView.zoom });
    savedView = null;
    last = null;
  }

  function userMoved() {
    if (following && !tookOver) tookOver = true;
  }

  return {
    update,
    userMoved,
    // While following, the saved map view is the one from before.
    isFollowing: () => following,
    savedView: () => savedView,
    // Mode changed (or the stream's viewers): re-evaluate on the next update.
    stopIfInactive: () => !active() && stop(),
  };
}

module.exports = { setupFollow, closeness, MODES };
