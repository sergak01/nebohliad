'use strict';

// Is the internet there? After a long enough outage the map pages keep
// showing old data (their sockets and polling give up), and only a reload
// brings it back. So: probe the connection, and once it has been back for
// STABLE_MS after an outage of at least LONG_OUTAGE_MS, call back(outageMs).
// - Offline at once when Windows says no network (`net.isOnline()`), else
//   after FAILS_FOR_OFFLINE probes in a row got no answer at all (any HTTP
//   status, a captive portal's redirect too, counts as an answer).
// - Probes: HEAD to connectivity-check endpoints (the one Windows itself
//   uses, then Google's), never the map sites. Every CHECK_ONLINE_MS while
//   online, every CHECK_OFFLINE_MS while in doubt or offline.
// - The outage is measured from the first failed probe to the first good
//   one; a failure while waiting out STABLE_MS restarts that wait (the
//   outage goes on).
// status() → { online, offlineSince }; changed() on every switch.

const { net, powerMonitor } = require('electron');
const log = require('./logger');

const PROBE_URLS = ['http://www.msftconnecttest.com/connecttest.txt', 'https://www.gstatic.com/generate_204'];
const PROBE_TIMEOUT_MS = 5000;
const CHECK_ONLINE_MS = 15_000;
const CHECK_OFFLINE_MS = 5000;
const FAILS_FOR_OFFLINE = 2;
const STABLE_MS = 10_000;
const LONG_OUTAGE_MS = 30_000;

async function defaultReachable() {
  if (!net.isOnline()) return 'adapter';
  for (const url of PROBE_URLS) {
    try {
      await net.fetch(url, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      return true;
    } catch {
      // Try the next one.
    }
  }
  return false;
}

// options: { changed(), back(outageMs), reachable() → true | false |
// 'adapter' (tests replace it), timing overrides for tests }.
function setupConnectivity({ changed = () => {}, back = () => {}, reachable = defaultReachable, timing = {} } = {}) {
  const t = { CHECK_ONLINE_MS, CHECK_OFFLINE_MS, STABLE_MS, LONG_OUTAGE_MS, ...timing };
  let online = true;
  let fails = 0;
  let offlineSince = 0; // First failed probe of the current outage.
  let backSince = 0; // First good probe after it.
  let timer = null;
  let running = false;
  let stopped = false;

  function schedule(ms) {
    clearTimeout(timer);
    if (!stopped) timer = setTimeout(tick, ms);
  }

  async function tick() {
    if (running) return;
    running = true;
    let result;
    try {
      result = await reachable();
    } catch {
      result = false;
    }
    running = false;
    if (stopped) return;
    const now = Date.now();
    if (result === true) {
      if (online) {
        fails = 0;
        offlineSince = 0;
      } else {
        backSince ||= now;
        if (now - backSince >= t.STABLE_MS) {
          const outageMs = backSince - offlineSince;
          online = true;
          fails = 0;
          offlineSince = 0;
          backSince = 0;
          const long = outageMs >= t.LONG_OUTAGE_MS;
          log.info('net', 'internet back', { offlineS: Math.round(outageMs / 1000), reload: long });
          changed();
          if (long) back(outageMs);
        }
      }
    } else if (online) {
      offlineSince ||= now;
      fails += result === 'adapter' ? FAILS_FOR_OFFLINE : 1;
      if (fails >= FAILS_FOR_OFFLINE) {
        online = false;
        backSince = 0;
        log.warn('net', 'internet lost', { via: result === 'adapter' ? 'no network' : 'no answer' });
        changed();
      }
    } else {
      backSince = 0;
    }
    schedule(online && fails === 0 ? t.CHECK_ONLINE_MS : t.CHECK_OFFLINE_MS);
  }

  // After sleep the network takes a while to come back; look soon.
  const onResume = () => schedule(2000);
  try {
    powerMonitor.on('resume', onResume);
  } catch {
    // Not available (tests).
  }

  schedule(t.CHECK_ONLINE_MS);

  return {
    status: () => ({ online, offlineSince: online ? 0 : offlineSince }),
    offline: () => !online,
    stop() {
      stopped = true;
      clearTimeout(timer);
      try {
        powerMonitor.removeListener('resume', onResume);
      } catch {
        // Not available (tests).
      }
    },
  };
}

module.exports = { setupConnectivity, LONG_OUTAGE_MS, STABLE_MS };
