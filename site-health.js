'use strict';

// Is each site's data still coming in? Two signs, both passive:
// - stale: the page's own XHR/fetch requests (seen through its session's
//   webRequest, counted only, never read) stopped. The site's usual rhythm
//   is learned first (median gap between requests); "stale" is silence longer
//   than max(STALE_MIN_MS, 5 × that gap). A site that never polls this way
//   (e.g. it uses a WebSocket) is never called stale.
// - challenge: preload.js reports a Cloudflare Turnstile check on screen
//   (war-monitor), which map-only mode or the click-through top layer can
//   hide from the user.
// Changes call onChange(); status() gives { site: { staleMinutes, challenge } }.

const { session } = require('electron');
const log = require('./logger');

const STALE_MIN_MS = 3 * 60_000;
const LEARN_REQUESTS = 5; // Requests seen before staleness is judged.
const GAPS_KEPT = 20;
const CHECK_MS = 15_000;
const BURST_MS = 3000;

// sites: { id: partition }.
function setupSiteHealth(sites, onChange) {
  const state = {};

  for (const [site, partition] of Object.entries(sites)) {
    state[site] = { last: 0, count: 0, gaps: [], stale: false, challenge: false };
    session.fromPartition(partition).webRequest.onCompleted({ urls: ['*://*/*'] }, (details) => {
      if (details.resourceType !== 'xhr' || details.statusCode >= 400) return;
      const s = state[site];
      const now = Date.now();
      // Requests close together (a page load, one poll fetching several
      // things) count as one: the gap between polls is what matters.
      if (s.last && now - s.last < BURST_MS) return;
      if (s.last) {
        s.gaps.push(now - s.last);
        if (s.gaps.length > GAPS_KEPT) s.gaps.shift();
      }
      s.last = now;
      s.count++;
      if (s.count === LEARN_REQUESTS) log.info('site', 'watching its data', { site, usualGapS: Math.round(median(s.gaps) / 1000) });
      if (s.stale) {
        s.stale = false;
        log.info('site', 'data flowing again', { site });
        onChange();
      }
    });
  }

  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  }

  const limit = (s) => Math.max(STALE_MIN_MS, 5 * median(s.gaps));

  setInterval(() => {
    const now = Date.now();
    for (const [site, s] of Object.entries(state)) {
      if (s.count < LEARN_REQUESTS || s.stale) continue;
      if (now - s.last > limit(s)) {
        s.stale = true;
        log.warn('site', 'no data for a while', { site, minutes: Math.round((now - s.last) / 60_000) });
        onChange();
      }
    }
  }, CHECK_MS).unref?.();

  function setChallenge(site, on) {
    const s = state[site];
    if (!s || s.challenge === Boolean(on)) return;
    s.challenge = Boolean(on);
    log.info('site', on ? 'Cloudflare check on screen' : 'Cloudflare check gone', { site });
    onChange();
  }

  // After a reload the learned rhythm starts over.
  function reset(site) {
    const s = state[site];
    if (!s) return;
    Object.assign(s, { last: 0, count: 0, gaps: [], stale: false });
    onChange();
  }

  function status() {
    const now = Date.now();
    return Object.fromEntries(
      Object.entries(state).map(([site, s]) => [
        site,
        { staleMinutes: s.stale ? Math.max(1, Math.round((now - s.last) / 60_000)) : null, challenge: s.challenge },
      ]),
    );
  }

  return { setChallenge, reset, status };
}

module.exports = { setupSiteHealth };
