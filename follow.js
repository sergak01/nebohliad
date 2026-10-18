'use strict';

// Following a target near a location. While a target is within the alert
// radius of a saved location, the base map centers on the nearest such
// target, zoomed so that the location's whole radius circle stays in view;
// when no target is near any more, the map goes back to the view it had
// before. settings.follow: 'off' | 'stream' (only while someone watches the
// LAN stream) | 'always'.
//
// If the user moves the map while it follows, they have taken over: the map
// is left where they put it, and is not moved back at the end either.

const { distanceKm } = require('./alerts');

const MODES = ['off', 'stream', 'always'];
const MARGIN = 1.1; // A little room around the circle.
const OWN_MOVE_MS = 2500; // Our fitBounds animation and its sync settle.
const RECENTER_SHARE = 0.15; // Re-center when the target moved this share of the view.

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
  let ownMoveUntil = 0;
  let last = null; // { key, center, halfKm } of the last view we set.

  const mode = () => (MODES.includes(settings.follow) ? settings.follow : 'off');
  const active = () => mode() === 'always' || (mode() === 'stream' && overlay.streamWatched());

  function move(command) {
    ownMoveUntil = Date.now() + OWN_MOVE_MS;
    overlay.mapCommand(command);
  }

  // hits: alerts.js nearby list, nearest first: [{ target, location, km, key }].
  function update(hits) {
    const nearest = active() ? hits?.[0] : null;
    if (!nearest) {
      stop();
      return;
    }
    if (!following) {
      following = true;
      tookOver = false;
      savedView = overlay.currentView();
      last = null;
    }
    if (tookOver) return;
    const halfKm = (distanceKm(nearest.target.center, nearest.location.center) + settings.alerts.radiusKm) * MARGIN;
    const moved = last ? distanceKm(last.center, nearest.target.center) : Infinity;
    if (last && last.key === nearest.key && moved < last.halfKm * RECENTER_SHARE && Math.abs(halfKm - last.halfKm) < last.halfKm * RECENTER_SHARE) return;
    last = { key: nearest.key, center: nearest.target.center, halfKm };
    move({ bbox: squareAround(nearest.target.center, halfKm) });
  }

  function stop() {
    if (!following) return;
    following = false;
    if (!tookOver && savedView) move({ center: savedView.center, zoom: savedView.zoom });
    savedView = null;
    last = null;
  }

  // Every view the base map reports: a move we did not make means the user
  // took over.
  function viewChanged() {
    if (following && !tookOver && Date.now() > ownMoveUntil) tookOver = true;
  }

  return {
    update,
    viewChanged,
    // While following, the saved map view is the one from before.
    isFollowing: () => following,
    savedView: () => savedView,
    // Mode changed (or the stream's viewers): re-evaluate on the next update.
    stopIfInactive: () => !active() && stop(),
  };
}

module.exports = { setupFollow, MODES };
