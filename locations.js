'use strict';

// Saved locations. The primary one is the map's home view: its whole region
// (oblast), shown at start-up and with the home button. All locations are
// drawn on the base map with the alert radius, and watched by alerts.js.

const crypto = require('crypto');
const geocoder = require('./geocoder');
const log = require('./logger');

// Home view when the region lookup fails: a square this far around the point.
const FALLBACK_HALF_SIZE_KM = 120;

function squareAround([lng, lat], halfKm) {
  const dLat = halfKm / 111.32;
  const dLng = halfKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  return [
    [lng - dLng, lat - dLat],
    [lng + dLng, lat + dLat],
  ];
}

function setupLocations(overlay) {
  const { settings } = overlay;

  const list = () => settings.locations;
  const find = (id) => settings.locations.find((loc) => loc.id === id) || null;
  const primary = () => find(settings.primaryLocationId);
  // A location's own alert radius, else the common one.
  const radiusOf = (loc) => (loc?.radiusKm >= 1 ? loc.radiusKm : settings.alerts.radiusKm);

  function changed() {
    overlay.settingsChanged();
    redraw();
  }

  // Markers and radius circles go to the base page only, so they are not
  // drawn twice on top of each other.
  function redraw() {
    const data = {
      locations: list().map((loc) => ({
        name: loc.name,
        center: loc.center,
        primary: loc.id === settings.primaryLocationId,
        radiusKm: settings.alerts.enabled ? radiusOf(loc) : null,
      })),
      radiusKm: settings.alerts.enabled ? settings.alerts.radiusKm : null,
    };
    overlay.basePage.send('map-locations', data);
    overlay.overlayPage.send('map-locations', null);
  }

  // `place`: { label, center } from search, optionally { name } (what the
  // user typed). Without a name, the nearest town's name is looked up.
  async function add(place) {
    let region = null;
    let name = place.name?.trim();
    try {
      region = await geocoder.regionOf(place.center);
      if (!name) name = await geocoder.placeName(place.center, settings.lang);
    } catch (error) {
      log.warn('locations', 'lookup failed', error.message);
    }
    const location = {
      id: crypto.randomUUID(),
      name: (name || place.label).slice(0, 60),
      center: place.center,
      region: region?.name || null,
      bbox: region?.bbox || squareAround(place.center, FALLBACK_HALF_SIZE_KM),
    };
    settings.locations.push(location);
    if (!primary()) settings.primaryLocationId = location.id;
    changed();
    return location;
  }

  function remove(id) {
    settings.locations = settings.locations.filter((loc) => loc.id !== id);
    if (settings.primaryLocationId === id) settings.primaryLocationId = settings.locations[0]?.id || null;
    changed();
  }

  function rename(id, name) {
    const location = find(id);
    if (!location || !name.trim()) return;
    location.name = name.trim().slice(0, 60);
    changed();
  }

  // km: 1..500, or null for the common radius.
  function setRadius(id, km) {
    const location = find(id);
    if (!location) return;
    const value = Math.round(Number(km));
    if (km === null || km === '' || !value) delete location.radiusKm;
    else if (value >= 1 && value <= 500) location.radiusKm = value;
    else return;
    changed();
  }

  function setPrimary(id) {
    if (!find(id)) return;
    settings.primaryLocationId = id;
    changed();
  }

  // Fit a location's whole region; the primary one when no id is given.
  function show(id) {
    const location = id ? find(id) : primary();
    if (location) overlay.showView({ bbox: location.bbox });
    return Boolean(location);
  }

  return { list, find, primary, radiusOf, add, remove, rename, setPrimary, setRadius, show, redraw };
}

module.exports = { setupLocations };
