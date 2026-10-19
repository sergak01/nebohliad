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

  // --- Invite from the app (like WPS) ----------------------------------------
  // This page tells the app it is waiting (every 2 s, with a random id kept
  // in this browser). When the app invites it, three numbers appear: the one
  // the app shows gives the key; a wrong one cancels the invite.

  const DEVICE_KEY = 'nebohliad.device';
  let deviceId = null;
  try {
    deviceId = localStorage.getItem(DEVICE_KEY);
  } catch {
    // Private mode: a new id for this page.
  }
  if (!deviceId) {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    deviceId = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    try {
      localStorage.setItem(DEVICE_KEY, deviceId);
    } catch {
      // Not remembered.
    }
  }

  $('pair-text').textContent = s.pairText;
  $('pair-title').textContent = s.pairPick;
  let shown = ''; // The choices on screen, so a poll does not redraw them.
  let leftTimer = null;
  let picking = false;

  function showInvite(invite) {
    const key = invite ? invite.choices.join(',') : '';
    if (key === shown) return;
    shown = key;
    clearInterval(leftTimer);
    $('pair').hidden = !invite;
    if (!invite) return;
    error.textContent = '';
    $('pair-choices').replaceChildren(
      ...invite.choices.map((choice) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = String(choice);
        button.addEventListener('click', () => pick(choice));
        return button;
      }),
    );
    const until = Date.now() + invite.expiresInMs;
    const tick = () => {
      const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      $('pair-left').textContent = s.pairLeft.replace('{n}', left);
      if (!left) showInvite(null);
    };
    tick();
    leftTimer = setInterval(tick, 1000);
    if (navigator.vibrate) navigator.vibrate(200);
  }

  async function pick(choice) {
    if (picking) return;
    picking = true;
    try {
      const res = await fetch('pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ d: deviceId, choice }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.token) {
        store.set(body.token);
        openViewer(body.token);
        return;
      }
      showInvite(null);
      error.textContent = res.status === 429 ? s.loginLocked.replace('{m}', 10) : res.status === 409 ? s.pairExpired : s.pairWrong;
    } catch {
      error.textContent = s.loginFailed;
    } finally {
      picking = false;
    }
  }

  async function poll() {
    try {
      const res = await fetch(`pair?d=${deviceId}`, { cache: 'no-store' });
      if (res.ok) showInvite((await res.json()).invite);
    } catch {
      // The app is unreachable: keep trying.
    }
    setTimeout(poll, 2000);
  }
  poll();
})();
