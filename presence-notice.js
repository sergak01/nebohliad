'use strict';

// A Windows notification when a site starts waiting for its presence check
// (ukrainealarm's "Ви ще на мапі?", preload.js `presence`): the site shows no
// targets until the user ticks its box, and with the window in the tray or
// behind other windows nobody sees the toolbar chip. The notification only
// says so and brings the map back on a click; the check stays the user's.
// - A page that loads again says "not waiting" for a few seconds before the
//   site asks again (its 2-hour self-reload): a wait that resumes within
//   SAME_WAIT_MS is the same one.
// - Not while the user has the site's window in front of them (`seen`); if
//   they leave it unanswered, the notification comes once they look away
//   (checked every CHECK_MS).
// - Not while the screen is locked (`locked`): nobody would see it. It comes
//   when the user is back (`check({ returned: true })` on unlock / resume).
// - Reminders while the wait goes on: every REMIND_MS, and on the user's
//   return when the last one is older than RETURN_REMIND_MS. Found
//   2026-11-26: one notification, sent while the user was away, and the site
//   then showed no targets for 173 minutes.
// - One notification at a time: a reminder replaces the one before, and the
//   last one is taken down once the wait is over.
// - Silent in quiet hours (`quiet`).

const { Notification } = require('electron');
const log = require('./logger');

const SAME_WAIT_MS = 2 * 60_000;
const CHECK_MS = 60_000;
const REMIND_MS = 30 * 60_000;
const RETURN_REMIND_MS = 60_000;
// From this long on the text says how long the site has been waiting.
const SAY_HOW_LONG_MS = 2 * 60_000;

const STRINGS = {
  uk: {
    title: (site) => `${site}: підтвердьте, що ви на мапі`,
    body: 'Сайт не показує цілей, доки ви не поставите галочку в його вікні «Ви ще на мапі?». Сповіщень про цілі з нього теж немає. Натисніть, щоб відкрити мапу.',
    bodyLong: (time) => `Сайт чекає вже ${time} і весь цей час не показує цілей. Поставте галочку в його вікні «Ви ще на мапі?». Натисніть, щоб відкрити мапу.`,
    time: (h, m) => (h ? `${h} год ${m} хв` : `${m} хв`),
  },
  en: {
    title: (site) => `${site}: confirm you are at the map`,
    body: 'The site shows no targets until you tick the box in its “Are you still at the map?” window. No target notifications from it either. Click to open the map.',
    bodyLong: (time) => `The site has been waiting for ${time} and shows no targets meanwhile. Tick the box in its “Are you still at the map?” window. Click to open the map.`,
    time: (h, m) => (h ? `${h} h ${m} min` : `${m} min`),
  },
};

// options: lang() → 'uk' | 'en'; label(site) → the site's name; seen(site) →
// the user is looking at that site right now; locked() → the screen is
// locked; quiet() → quiet hours; open(site) → the notification was clicked;
// now() and timer: false for tests (they call check() themselves).
function setupPresenceNotice({ lang, label, seen, locked, quiet, open, now = Date.now, timer = true }) {
  const sites = {}; // site → { waiting, since, offAt, toldAt, notification, heldLogged }

  function dismiss(state) {
    const old = state.notification;
    state.notification = null;
    try {
      old?.close();
    } catch {
      // Already gone.
    }
  }

  function notify(site, state) {
    const reminder = state.toldAt !== null;
    const waitedMs = now() - state.since;
    state.toldAt = now();
    if (!Notification.isSupported()) return;
    const s = STRINGS[lang()] || STRINGS.uk;
    const minutes = Math.round(waitedMs / 60_000);
    const body = waitedMs >= SAY_HOW_LONG_MS ? s.bodyLong(s.time(Math.floor(minutes / 60), minutes % 60)) : s.body;
    dismiss(state);
    const notification = new Notification({ title: s.title(label(site)), body, silent: Boolean(quiet?.()) });
    notification.on('click', () => open(site));
    notification.show();
    state.notification = notification;
    if (reminder) log.info('page', 'reminded that the site still asks to confirm presence', { site, minutes });
    else log.info('page', 'notified that the site asks to confirm presence', { site });
  }

  // Waits nobody was told about (or not for a while) and nobody is looking
  // at. `returned`: the user is back at the PC (unlock, resume).
  function check({ returned = false } = {}) {
    let away; // asked only when something is due
    for (const [site, state] of Object.entries(sites)) {
      if (!state.waiting) {
        // Over for good (not a reload's pause): its notification says nothing true.
        if (state.notification && now() - state.offAt >= SAME_WAIT_MS) dismiss(state);
        continue;
      }
      const due = state.toldAt === null || now() - state.toldAt >= (returned ? RETURN_REMIND_MS : REMIND_MS);
      if (!due || seen(site)) continue;
      away ??= Boolean(locked?.());
      if (away) {
        // Once per wait in the log: a lock state read wrongly would otherwise
        // mean no notification and no trace of why.
        if (!state.heldLogged) log.info('page', 'held the presence notification back: the screen is locked', { site });
        state.heldLogged = true;
        continue;
      }
      notify(site, state);
    }
  }

  function set(site, waiting) {
    const state = (sites[site] ||= { waiting: false, since: 0, offAt: -Infinity, toldAt: null, notification: null, heldLogged: false });
    if (waiting === state.waiting) return;
    state.waiting = waiting;
    if (!waiting) {
      state.offAt = now();
      return;
    }
    // A new wait, unless the last one stopped only a moment ago (a reload).
    if (now() - state.offAt >= SAME_WAIT_MS) {
      dismiss(state);
      state.since = now();
      state.toldAt = null;
      state.heldLogged = false;
    }
    check();
  }

  if (timer) setInterval(check, CHECK_MS).unref?.();

  return { set, check };
}

module.exports = { setupPresenceNotice, SAME_WAIT_MS, CHECK_MS, REMIND_MS, RETURN_REMIND_MS, SAY_HOW_LONG_MS };
