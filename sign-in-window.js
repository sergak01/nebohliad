'use strict';

// Windows for a map site's sign-in (ukrainealarm, since 2026-11):
// - The site's own popups (its Diia pages: window.open with a frame name):
//   the map page polls its server meanwhile, so such a window only has to go
//   away once it comes back to the site (`watchReturn`).
// - An account provider (Google, Apple): the map page sends ITSELF there
//   (location.assign) and expects to come back with the answer, as a tab in
//   a browser does. A map page must not leave its site (main.js keepOnSite),
//   and in the system browser the answer lands in the browser, not here. So
//   that address opens in a window of its own with the page's session
//   (`openProviderWindow`); it completes the provider's callback itself
//   (one-time code, Apple's form post, cookies into the shared session), and
//   the first step back to one of the site's pages (a redirect, a link, a
//   button, a new tab) is handed to the map page instead.
// Nothing is typed, clicked or read in these windows, and the user agent is
// Electron's own. A provider may refuse an embedded browser; the window's
// menu then opens the same address in the system browser, as before this
// window existed (whether a sign-in finished there reaches the map page is
// not known: the page asks its server, see main.js openAccountSignIn).
// Never log addresses from here: they carry the sign-in's one-time values.

const { BrowserWindow, Menu, shell } = require('electron');

// The providers the site itself accepts (its diiaAuthorization.js checks the
// same two hosts before going there).
const PROVIDERS = { 'accounts.google.com': 'google', 'appleid.apple.com': 'apple' };
// The site's pages a sign-in may return to (the site's own list).
const RETURN_PATHS = new Set(['/', '/index', '/onlyMap', '/onlyMap_en']);

const STRINGS = {
  uk: { title: (site) => `вхід для ${site}`, browser: 'Відкрити в браузері', close: 'Закрити' },
  en: { title: (site) => `sign-in for ${site}`, browser: 'Open in the browser', close: 'Close' },
};

function parse(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

// → 'google' | 'apple' | null
function providerOf(url) {
  const u = parse(url);
  if (!u || u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  return Object.hasOwn(PROVIDERS, u.hostname) ? PROVIDERS[u.hostname] : null;
}

// A page of the site itself (not its API: the callback stays in the window).
function isReturnUrl(url, siteUrl) {
  const u = parse(url);
  const site = parse(siteUrl);
  return Boolean(u && site && u.protocol === 'https:' && u.host === site.host && !u.username && !u.password && RETURN_PATHS.has(u.pathname));
}

// Calls onReturn(url) once, when the window heads back to one of the site's
// pages; that navigation itself is stopped, so the window never runs the map
// page. Other new windows go to the system browser.
function watchReturn(contents, siteUrl, onReturn) {
  let done = false;
  const back = (url) => {
    if (done || !isReturnUrl(url, siteUrl)) return false;
    done = true;
    onReturn(url);
    return true;
  };
  for (const name of ['will-navigate', 'will-redirect']) {
    contents.on(name, (event) => {
      if (event.isMainFrame === false) return;
      if (isReturnUrl(event.url, siteUrl)) event.preventDefault();
      back(event.url);
    });
  }
  // Whatever got past the two above (e.g. a server-side step we cannot stop).
  contents.on('did-navigate', (_event, url) => back(url));
  contents.setWindowOpenHandler(({ url }) => {
    if (!back(url) && /^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// options: url (the provider's address the map page wanted to go to),
// session (the map page's), parent, siteUrl, siteLabel, lang() → 'uk' | 'en',
// icon, modal; onReturn(url) → the sign-in came back to the site with this
// address; onClosed(how) → 'returned' | 'browser' | 'closed' (by the user,
// unfinished).
function openProviderWindow({ url, session, parent, siteUrl, siteLabel, lang, icon, modal = true, onReturn, onClosed }) {
  if (!providerOf(url)) return null;
  const s = STRINGS[lang?.()] || STRINGS.uk;
  const win = new BrowserWindow({
    parent,
    modal: Boolean(modal && parent),
    width: 520,
    height: 760,
    minWidth: 360,
    minHeight: 480,
    icon,
    backgroundColor: '#ffffff',
    title: s.title(siteLabel),
    webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  let how = 'closed';
  const close = (why) => {
    how = why;
    if (!win.isDestroyed()) win.close();
  };
  win.setMenu(
    Menu.buildFromTemplate([
      {
        label: s.browser,
        click: () => {
          shell.openExternal(url);
          close('browser');
        },
      },
      { label: s.close, click: () => close('closed') },
    ]),
  );
  // The user types a password here: the title always says whose page it is.
  const showHost = () => {
    const host = parse(win.webContents.getURL())?.host;
    win.setTitle(host ? `${host} — ${s.title(siteLabel)}` : s.title(siteLabel));
  };
  win.on('page-title-updated', (event) => {
    event.preventDefault();
    showHost();
  });
  win.webContents.on('did-navigate', showHost);
  watchReturn(win.webContents, siteUrl, (back) => {
    onReturn?.(back);
    close('returned');
  });
  win.on('closed', () => onClosed?.(how));
  win.loadURL(url).catch(() => {});
  return win;
}

module.exports = { openProviderWindow, watchReturn, providerOf, isReturnUrl, PROVIDERS, RETURN_PATHS };
