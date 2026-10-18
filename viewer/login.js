'use strict';

// Sign-in page, served instead of the viewer when the link has no valid key.
// Takes the one-time code shown in the app (or a pasted link / key), gets the
// stream key back and opens the viewer with it. A key this browser stored
// earlier is tried first, so a bookmark of the bare address keeps working.

(() => {
  const { expired, s } = window.NEBOHLIAD;
  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = 'nebohliad.token';
  const store = {
    get: () => {
      try {
        return localStorage.getItem(TOKEN_KEY);
      } catch {
        return null;
      }
    },
    set: (value) => {
      try {
        if (value) localStorage.setItem(TOKEN_KEY, value);
        else localStorage.removeItem(TOKEN_KEY);
      } catch {
        // Private mode: sign in again next time.
      }
    },
  };

  const openViewer = (token) => location.replace(`./?t=${encodeURIComponent(token)}`);

  $('login-title').textContent = s.loginTitle;
  $('login-text').textContent = s.loginText;
  $('login-code').placeholder = s.loginPlaceholder;
  $('login-submit').textContent = s.loginSubmit;
  $('notice').textContent = s.notice;
  if (expired) {
    $('login-expired').textContent = s.loginExpired;
    $('login-expired').hidden = false;
  }

  // A stored key that still works opens the viewer straight away.
  const stored = store.get();
  const fromLink = new URLSearchParams(location.search).get('t');
  if (stored && stored !== fromLink) {
    fetch(`auth?t=${encodeURIComponent(stored)}`, { cache: 'no-store' })
      .then((res) => (res.status === 204 ? openViewer(stored) : store.set(null)))
      .catch(() => {});
  } else if (stored) {
    store.set(null); // The same key just failed.
  }

  const error = $('login-error');
  $('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const code = $('login-code').value.trim();
    if (!code) return;
    $('login-submit').disabled = true;
    error.textContent = '';
    try {
      const res = await fetch('login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.token) {
        store.set(body.token);
        openViewer(body.token);
        return;
      }
      if (res.status === 429) error.textContent = s.loginLocked.replace('{m}', Math.max(1, Math.ceil(body.retryInMs / 60000)));
      else error.textContent = s.loginWrong.replace('{n}', body.left ?? '?');
      $('login-code').select();
    } catch {
      error.textContent = s.loginFailed;
    }
    $('login-submit').disabled = false;
  });
})();
