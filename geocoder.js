'use strict';

// OpenStreetMap Nominatim client shared by search and locations. Usage
// policy: at most 1 request/s (enforced here for every caller), an
// identifying User-Agent with a contact URL, no search-as-you-type, and the
// app must be able to switch servers or stop without a new release: the
// server comes from settings.geocoderUrl ('' turns search off).

const { app, net } = require('electron');
const { homepage } = require('./package.json');

const DEFAULT_URL = 'https://nominatim.openstreetmap.org';
const USER_AGENT = `Nebohliad/${app.getVersion()} (+${homepage})`;
const MIN_REQUEST_INTERVAL_MS = 1100;
// Thrown when settings.geocoderUrl is empty; the UI shows its own message.
const DISABLED = 'GEOCODER_DISABLED';

let baseUrl = DEFAULT_URL;

function configure(url) {
  baseUrl = typeof url === 'string' ? url.trim() : DEFAULT_URL;
}
// Prefer results in and around Ukraine (west, north, east, south).
const VIEWBOX = '22,52.5,40.5,44';
// Cities with special status are their own top-level region in OSM; their
// "whole region" view is the surrounding one.
const REGION_OF_CITY = { 'Київ': 'Київська область', 'Севастополь': 'Автономна Республіка Крим' };

let queue = Promise.resolve();
let lastRequestAt = 0;

// Requests run one at a time with the minimum interval between them.
function request(path, params) {
  if (!baseUrl) return Promise.reject(new Error(DISABLED));
  const run = async () => {
    const wait = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
    const url = new URL(path, baseUrl);
    url.search = new URLSearchParams({ format: 'jsonv2', ...params }).toString();
    const response = await net.fetch(url.toString(), { headers: { 'User-Agent': USER_AGENT } });
    if (!response.ok) throw new Error(`Nominatim HTTP ${response.status}`);
    return response.json();
  };
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  return result;
}

function toBbox(boundingbox) {
  const [south, north, west, east] = boundingbox.map(Number);
  return [
    [west, south],
    [east, north],
  ];
}

// Places for a free-text query: [{ label, center: [lng, lat], bbox }].
async function search(query, lang, limit = 6) {
  const items = await request('/search', {
    q: query,
    limit: String(limit),
    'accept-language': lang,
    viewbox: VIEWBOX,
    bounded: '0',
  });
  // Nominatim often returns several objects at one address (building, shop).
  const unique = items.filter((item, i) => items.findIndex((other) => other.display_name === item.display_name) === i);
  return unique.map((item) => ({
    label: item.display_name,
    center: [Number(item.lon), Number(item.lat)],
    bbox: toBbox(item.boundingbox),
  }));
}

// A short name for a point (town, village or district), or null.
async function placeName([lng, lat], lang) {
  const item = await request('/reverse', {
    lat: String(lat),
    lon: String(lng),
    zoom: '12',
    'accept-language': lang,
  });
  if (!item || item.error) return null;
  const a = item.address || {};
  return a.city || a.town || a.village || a.hamlet || a.suburb || item.name || null;
}

// The region (oblast) containing a point: { name, bbox } or null.
async function regionOf([lng, lat]) {
  const item = await request('/reverse', {
    lat: String(lat),
    lon: String(lng),
    zoom: '5',
    'accept-language': 'uk',
  });
  if (!item || item.error) return null;
  const name = item.name || item.address?.state;
  const parent = REGION_OF_CITY[name];
  if (parent) {
    const [region] = await search(parent, 'uk', 1);
    return region ? { name: parent, bbox: region.bbox } : null;
  }
  return { name, bbox: toBbox(item.boundingbox) };
}

module.exports = { configure, search, placeName, regionOf, DEFAULT_URL, DISABLED };
