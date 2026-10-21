'use strict';

// Is each site's data still coming in? All signs are passive:
// - stale: the site's data stopped coming. Two kinds of signs, counted only,
//   never read: the page's XHR/fetch requests to its own domain (seen
//   through its session's webRequest; analytics and Cloudflare's /cdn-cgi/
//   do not count, their rhythm says nothing about the data), and messages on
//   the page's WebSockets (preload.js `site-data`; ukrainealarm gets its
//   targets over one, which webRequest does not see). The site's usual
//   rhythm is learned first (median gap between signs); "stale" is silence
//   longer than max(STALE_MIN_MS, 5 × that gap). A site with neither sign is
//   never called stale.
// - realtime: the page's WebSockets (preload.js `site-socket`: how many are
//   open, how many attempts failed in the last 2 min). "failing" = none open
//   and FAILED_ATTEMPTS failures: the site then falls back to polling
//   (ukrainealarm polls every 5 s), so data still comes, only later. Seen
//   2026-10-21: ukrainealarm's own socket server refused the page's
//   connections, in a plain browser too.
// - challenge: preload.js reports a Cloudflare Turnstile check on screen
//   (war-monitor), which map-only mode or the click-through top layer can
//   hide from the user.
// Self-repair: a site in `autoReload` that stays stale for AUTO_RELOAD_AFTER_MS
// (and does not show its own "data paused" notice) is reloaded via
// `reload(site)`, at most once per AUTO_RELOAD_EVERY_MS. Not war-monitor: a
// reload can bring its Cloudflare check back, which needs the user.
// Changes call onChange(); status() gives per site { staleMinutes, challenge,
// realtime, lastDataAt, usualGapS, learning }.

const { session } = require('electron');
const log = require('./logger');

const STALE_MIN_MS = 3 * 60_000;
const LEARN_SIGNS = 5; // Signs seen before staleness is judged.
const GAPS_KEPT = 20;
const CHECK_MS = 15_000;
const BURST_MS = 3000;
const FAILED_ATTEMPTS = 3;
const AUTO_RELOAD_AFTER_MS = 2 * 60_000;
const AUTO_RELOAD_EVERY_MS = 15 * 60_000;

// The site's own domain: "https://map.war-monitor.org/" -> "war-monitor.org".
const domainOf = (url) => new URL(url).hostname.split('.').slice(-2).join('.');

function ownRequest(url, domain) {
  try {
    const { hostname, pathname } = new URL(url);
    return (hostname === domain || hostname.endsWith(`.${domain}`)) && !pathname.startsWith('/cdn-cgi/');
  } catch {
    return false;
  }
}

// sites: { id: { partition, url } }; options: { autoReload: { id: true },
// reload(site), paused(site) → the site shows its own data-paused notice }.
function setupSiteHealth(sites, onChange, options = {}) {
  const state = {};
  const lastAutoReload = {};

  for (const [site, { partition, url }] of Object.entries(sites)) {
    state[site] = { last: 0, count: 0, gaps: [], stale: false, staleSince: 0, challenge: false, realtime: null };
    const domain = domainOf(url);
    session.fromPartition(partition).webRequest.onCompleted({ urls: ['*://*/*'] }, (details) => {
      if (details.resourceType !== 'xhr' || details.statusCode >= 400 || !ownRequest(details.url, domain)) return;
      dataSeen(site);
    });
  }

  // A sign that the site's data is coming: one of its own requests done, or
  // messages on its WebSockets.
  function dataSeen(site) {
    const s = state[site];
    if (!s) return;
    const now = Date.now();
    // Signs close together (a page load, one poll fetching several things)
    // count as one: the gap between polls is what matters.
    if (s.last && now - s.last < BURST_MS) return;
    if (s.last) {
      s.gaps.push(now - s.last);
      if (s.gaps.length > GAPS_KEPT) s.gaps.shift();
    }
    s.last = now;
    s.count++;
    if (s.count === LEARN_SIGNS) log.info('site', 'watching its data', { site, usualGapS: Math.round(median(s.gaps) / 1000) });
    if (s.stale) {
      s.stale = false;
      log.info('site', 'data flowing again', { site });
      onChange();
    }
  }

  // { open, failed } from the page's socket watch.
  function setSocket(site, socket) {
    const s = state[site];
    if (!s || !socket) return;
    const open = Number(socket.open) || 0;
    const failed = Number(socket.failed) || 0;
    // Unchanged while neither condition holds (e.g. between reconnects).
    const next = open > 0 ? 'ok' : failed >= FAILED_ATTEMPTS ? 'failing' : s.realtime;
    if (next === s.realtime) return;
    if (next === 'failing') log.warn('site', 'realtime connection failing; the site polls instead', { site, failedIn2Min: failed });
    else if (s.realtime === 'failing') log.info('site', 'realtime connection back', { site });
    s.realtime = next;
    onChange();
  }

  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  }

  const limit = (s) => Math.max(STALE_MIN_MS, 5 * median(s.gaps));

  setInterval(() => {
    const now = Date.now();
    for (const [site, s] of Object.entries(state)) {
      if (s.count < LEARN_SIGNS) continue;
      if (!s.stale && now - s.last > limit(s)) {
        s.stale = true;
        s.staleSince = now;
        log.warn('site', 'no data for a while', { site, minutes: Math.round((now - s.last) / 60_000) });
        onChange();
      }
      if (
        s.stale &&
        options.autoReload?.[site] &&
        now - s.staleSince > AUTO_RELOAD_AFTER_MS &&
        now - (lastAutoReload[site] || 0) > AUTO_RELOAD_EVERY_MS &&
        !options.paused?.(site)
      ) {
        lastAutoReload[site] = now;
        log.warn('site', 'data still stopped: reloading the page', { site, minutes: Math.round((now - s.last) / 60_000) });
        options.reload?.(site);
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
    Object.assign(s, { last: 0, count: 0, gaps: [], stale: false, staleSince: 0, realtime: null });
    onChange();
  }

  function status() {
    const now = Date.now();
    return Object.fromEntries(
      Object.entries(state).map(([site, s]) => [
        site,
        {
          staleMinutes: s.stale ? Math.max(1, Math.round((now - s.last) / 60_000)) : null,
          challenge: s.challenge,
          realtime: s.realtime,
          lastDataAt: s.last || null,
          usualGapS: s.gaps.length ? Math.max(1, Math.round(median(s.gaps) / 1000)) : null,
          learning: s.count < LEARN_SIGNS,
        },
      ]),
    );
  }

  return { dataSeen, setSocket, setChallenge, reset, status };
}

module.exports = { setupSiteHealth };
