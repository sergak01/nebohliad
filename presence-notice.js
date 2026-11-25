'use strict';

// A Windows notification when a site starts waiting for its presence check
// (ukrainealarm's "Ви ще на мапі?", preload.js `presence`): the site shows no
// targets until the user ticks its box, and with the window in the tray or
// behind other windows nobody sees the toolbar chip. The notification only
// says so and brings the map back on a click; the check stays the user's.
// - One per wait. A page that loads again says "not waiting" for a few
//   seconds before the site asks again (its 2-hour self-reload): a wait that
//   resumes within SAME_WAIT_MS is the same one.
// - Not while the user has the site's window in front of them (`seen`); if
//   they leave it unanswered, the notification comes once they look away
//   (checked every CHECK_MS).
// - Silent in quiet hours (`quiet`).

const { Notification } = require('electron');
const log = require('./logger');

const SAME_WAIT_MS = 2 * 60_000;
const CHECK_MS = 60_000;

const STRINGS = {
  uk: {
    title: (site) => `${site}: підтвердьте, що ви на мапі`,
    body: 'Сайт не показує цілей, доки ви не поставите галочку в його вікні «Ви ще на мапі?». Сповіщень про цілі з нього теж немає. Натисніть, щоб відкрити мапу.',
  },
  en: {
    title: (site) => `${site}: confirm you are at the map`,
    body: 'The site shows no targets until you tick the box in its “Are you still at the map?” window. No target notifications from it either. Click to open the map.',
  },
};

// options: lang() → 'uk' | 'en'; label(site) → the site's name; seen(site) →
// the user is looking at that site right now; quiet() → quiet hours;
// open(site) → the notification was clicked; now() and timer: false for tests
// (they call check() themselves).
function setupPresenceNotice({ lang, label, seen, quiet, open, now = Date.now, timer = true }) {
  const sites = {}; // site → { waiting, offAt, told }

  function notify(site) {
    if (!Notification.isSupported()) return;
    const s = STRINGS[lang()] || STRINGS.uk;
    const notification = new Notification({ title: s.title(label(site)), body: s.body, silent: Boolean(quiet?.()) });
    notification.on('click', () => open(site));
    notification.show();
    log.info('page', 'notified that the site asks to confirm presence', { site });
  }

  // Waits nobody was told about and nobody is looking at.
  function check() {
    for (const [site, state] of Object.entries(sites)) {
      if (!state.waiting || state.told || seen(site)) continue;
      state.told = true;
      notify(site);
    }
  }

  function set(site, waiting) {
    const state = (sites[site] ||= { waiting: false, offAt: -Infinity, told: false });
    if (waiting === state.waiting) return;
    state.waiting = waiting;
    if (!waiting) {
      state.offAt = now();
      return;
    }
    // A new wait, unless the last one stopped only a moment ago (a reload).
    if (now() - state.offAt >= SAME_WAIT_MS) state.told = false;
    check();
  }

  if (timer) setInterval(check, CHECK_MS).unref?.();

  return { set, check };
}

module.exports = { setupPresenceNotice, SAME_WAIT_MS, CHECK_MS };
