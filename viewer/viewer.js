'use strict';

// Viewer for the Nebohliad LAN stream (served by stream-server.js).
// Modes: WebRTC video (default: least traffic, and a playing <video> keeps
// most phones awake), MJPEG video, or a snapshot every few seconds.
// Extras: fullscreen, "keep screen on", controls that hide after a while.

(() => {
  const { token, snapshotSeconds, version, s } = window.NEBOHLIAD;
  const $ = (id) => document.getElementById(id);
  const video = $('video');
  const img = $('img');
  const status = $('status');
  const updated = $('updated');
  const controls = $('controls');
  const notice = $('notice');

  const store = {
    get: (key, fallback) => {
      try {
        return localStorage.getItem(`nebohliad.${key}`) ?? fallback;
      } catch {
        return fallback;
      }
    },
    set: (key, value) => {
      try {
        localStorage.setItem(`nebohliad.${key}`, value);
      } catch {
        // Private mode: settings just are not remembered.
      }
    },
  };

  // Remembered for the sign-in page: the bare address then opens the viewer.
  store.set('token', token);

  let mode = store.get('mode', 'webrtc');
  let pc = null;
  let timer = null;

  function showStatus(text) {
    status.textContent = text;
    status.style.display = text ? 'block' : 'none';
  }

  // --- Modes ---------------------------------------------------------------

  function stopAll() {
    clearTimeout(timer);
    if (pc) {
      pc.close();
      pc = null;
    }
    video.srcObject = null;
    video.style.display = 'none';
    img.removeAttribute('src');
    img.style.display = 'none';
    updated.style.display = 'none';
  }

  function waitIce(peer, ms) {
    if (peer.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => resolve();
      peer.addEventListener('icegatheringstatechange', () => peer.iceGatheringState === 'complete' && done());
      setTimeout(done, ms);
    });
  }

  async function startWebRTC() {
    if (!window.RTCPeerConnection) {
      setMode('mjpeg');
      return;
    }
    showStatus(s.waiting);
    const peer = new RTCPeerConnection({ iceServers: [] });
    pc = peer;
    peer.addTransceiver('video', { direction: 'recvonly' });
    peer.ontrack = (event) => {
      video.srcObject = event.streams[0] || new MediaStream([event.track]);
      video.style.display = 'block';
      video.play().catch(() => {});
    };
    peer.onconnectionstatechange = () => {
      if (pc !== peer) return;
      if (peer.connectionState === 'connected') showStatus('');
      if (['failed', 'disconnected', 'closed'].includes(peer.connectionState)) {
        showStatus(s.lost);
        timer = setTimeout(() => mode === 'webrtc' && start(), 3000);
      }
    };
    try {
      await peer.setLocalDescription(await peer.createOffer());
      await waitIce(peer, 2000);
      const response = await fetch(`webrtc?t=${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: peer.localDescription.sdp,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await peer.setRemoteDescription({ type: 'answer', sdp: await response.text() });
    } catch {
      if (pc !== peer) return;
      // WebRTC unavailable here: fall back to MJPEG for this session.
      showStatus(s.webrtcFailed);
      setMode('mjpeg', { remember: false });
    }
  }

  function startImage(src, onLoad) {
    img.style.display = 'block';
    img.onload = onLoad;
    img.onerror = () => {
      showStatus(s.lost);
      timer = setTimeout(start, 2000);
    };
    img.src = `${src}?t=${token}&n=${Date.now()}`;
  }

  function startMjpeg() {
    showStatus(s.waiting);
    startImage('stream.mjpg', () => showStatus(''));
  }

  function startSnapshots() {
    showStatus(s.waiting);
    startImage('frame.jpg', () => {
      showStatus('');
      updated.textContent = `${s.updated} ${new Date().toLocaleTimeString(document.documentElement.lang)}`;
      updated.style.display = 'block';
      timer = setTimeout(startSnapshots, snapshotSeconds * 1000);
    });
  }

  function start() {
    stopAll();
    if (mode === 'webrtc') startWebRTC();
    else if (mode === 'mjpeg') startMjpeg();
    else startSnapshots();
  }

  // Black-video watchdog (WebRTC). After the PC wakes from sleep its video
  // can turn black while MJPEG still works. A real map frame is never all
  // black (labels, attribution), so two all-black checks in a row ask the
  // app for a fresh video source; it drops WebRTC viewers, and the
  // connection handler above reconnects.
  const probe = document.createElement('canvas');
  probe.width = 32;
  probe.height = 18;
  const probeCtx = probe.getContext('2d', { willReadFrequently: true });
  let blackChecks = 0;
  const BLACK_MAX = 10;
  setInterval(async () => {
    if (mode !== 'webrtc' || pc?.connectionState !== 'connected' || video.readyState < 2 || document.hidden) {
      blackChecks = 0;
      return;
    }
    probeCtx.drawImage(video, 0, 0, probe.width, probe.height);
    const data = probeCtx.getImageData(0, 0, probe.width, probe.height).data;
    let max = 0;
    for (let i = 0; i < data.length; i += 4) max = Math.max(max, data[i], data[i + 1], data[i + 2]);
    blackChecks = max < BLACK_MAX ? blackChecks + 1 : 0;
    if (blackChecks < 2) return;
    blackChecks = 0;
    try {
      const response = await fetch(`webrtc-reset?t=${token}`, { method: 'POST', cache: 'no-store' });
      // Reset just done for someone else: our connection may still carry the
      // old track, so reconnect ourselves.
      if (response.status === 429 && mode === 'webrtc') start();
    } catch {
      // The app is unreachable: the connection handler deals with it.
    }
  }, 5000);

  function setMode(next, { remember = true } = {}) {
    mode = next;
    if (remember) store.set('mode', mode);
    for (const button of $('modes').children) button.classList.toggle('active', button.dataset.mode === mode);
    start();
  }

  // --- Keep the screen on ---------------------------------------------------

  // The Wake Lock API exists only on HTTPS pages; on a plain LAN address the
  // fallback is a tiny video that keeps playing (browsers keep the screen on
  // while a video plays). A playing WebRTC stream usually does it by itself.
  let wakeLock = null;
  let awakeOn = store.get('awake', 'on') === 'on';
  let awakeCanvasTimer = null;

  async function startAwakeVideo() {
    const awake = $('awake');
    if (awake.srcObject) return awake.play();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 16;
    const ctx = canvas.getContext('2d');
    let flip = false;
    const paint = () => {
      flip = !flip;
      ctx.fillStyle = flip ? '#000' : '#010101';
      ctx.fillRect(0, 0, 16, 16);
    };
    paint();
    awakeCanvasTimer = setInterval(paint, 1000);
    awake.srcObject = canvas.captureStream(1);
    return awake.play();
  }

  async function keepAwake() {
    if ('wakeLock' in navigator) {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
          wakeLock = null;
        });
        return 'lock';
      } catch {
        // Not allowed here (insecure page, low battery): try the video.
      }
    }
    try {
      await startAwakeVideo();
      return 'video';
    } catch {
      return null;
    }
  }

  function releaseAwake() {
    wakeLock?.release().catch(() => {});
    wakeLock = null;
    clearInterval(awakeCanvasTimer);
    const awake = $('awake');
    awake.pause();
    awake.srcObject = null;
  }

  async function applyAwake() {
    $('awake-btn').classList.toggle('active', awakeOn);
    if (!awakeOn) {
      releaseAwake();
      return;
    }
    const how = await keepAwake();
    if (!how) showStatus(s.awakeFailed);
  }

  $('awake-btn').addEventListener('click', () => {
    awakeOn = !awakeOn;
    store.set('awake', awakeOn ? 'on' : 'off');
    applyAwake();
  });
  // Browsers drop the lock when the page is hidden; take it again.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && awakeOn && !wakeLock) applyAwake();
  });
  // Playing media needs a user gesture on most phones: (re)try on first tap.
  document.addEventListener('pointerdown', () => awakeOn && !wakeLock && applyAwake(), { once: true });

  // --- Fullscreen -------------------------------------------------------------

  async function toggleFullscreen() {
    const doc = document;
    const isFull = doc.fullscreenElement || doc.webkitFullscreenElement;
    if (isFull) {
      (doc.exitFullscreen || doc.webkitExitFullscreen).call(doc);
      return;
    }
    const root = doc.documentElement;
    const request = root.requestFullscreen || root.webkitRequestFullscreen;
    if (request) {
      try {
        await request.call(root, { navigationUI: 'hide' });
        screen.orientation?.lock?.('landscape').catch(() => {});
        return;
      } catch {
        // Fall through to the iPhone path.
      }
    }
    // iPhone: only a <video> can go fullscreen; otherwise suggest the home
    // screen app, which opens without browser bars.
    if (mode === 'webrtc' && video.webkitEnterFullscreen) video.webkitEnterFullscreen();
    else showStatus(s.fullscreenHint);
  }

  $('fullscreen-btn').addEventListener('click', toggleFullscreen);
  video.addEventListener('dblclick', toggleFullscreen);
  img.addEventListener('dblclick', toggleFullscreen);

  // "Auto fullscreen": a page opened from a home-screen shortcut (a plain
  // browser tab on an http page) goes fullscreen on the first tap. Browsers
  // allow fullscreen only from a user gesture, so it cannot happen on load.
  let autoFullscreen = store.get('autofs', 'off') === 'on';
  const renderAutoFs = () => $('autofs-btn').classList.toggle('active', autoFullscreen);
  $('autofs-btn').addEventListener('click', () => {
    autoFullscreen = !autoFullscreen;
    store.set('autofs', autoFullscreen ? 'on' : 'off');
    renderAutoFs();
  });
  document.addEventListener('click', (event) => {
    if (!autoFullscreen || event.target.closest('#controls')) return;
    if (!(document.fullscreenElement || document.webkitFullscreenElement)) toggleFullscreen();
  });
  renderAutoFs();

  // --- Controls that hide -------------------------------------------------

  let hideTimer = null;
  function showControls() {
    controls.classList.remove('hidden');
    notice.classList.remove('hidden');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      controls.classList.add('hidden');
      // The safety line stays unless the page is fullscreen.
      if (document.fullscreenElement || document.webkitFullscreenElement) notice.classList.add('hidden');
    }, 4000);
  }
  for (const type of ['pointerdown', 'pointermove', 'keydown']) document.addEventListener(type, showControls);

  // --- Notifications ------------------------------------------------------------
  // Events from the app (Server-Sent Events): drones / other targets near a
  // saved location, air alert start / change / end in a location's area.
  // Shown as toasts on the page and/or browser notifications; each channel
  // and each kind can be turned off here (stored in this browser only).

  const prefs = {
    toasts: store.get('n.toasts', 'on') === 'on',
    browser: store.get('n.browser', 'off') === 'on',
    drone: store.get('n.drone', 'on') === 'on',
    target: store.get('n.target', 'on') === 'on',
    alert: store.get('n.alert', 'on') === 'on',
  };
  const kindPref = { drone: 'drone', target: 'target', alert: 'alert', 'alert-change': 'alert', 'alert-end': 'alert' };
  const toasts = $('toasts');
  const browserHint = $('browser-hint');

  function showToast(event) {
    const el = document.createElement('div');
    el.className = `toast ${event.level || ''}`;
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = event.title;
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = event.body || '';
    const time = document.createElement('div');
    time.className = 'time';
    time.textContent = new Date(event.at || Date.now()).toLocaleTimeString(document.documentElement.lang);
    el.append(title, body, time);
    el.addEventListener('click', () => el.remove());
    // One toast per tag (location + kind): an alert's end replaces its start,
    // and a reconnect's snapshot does not add a copy.
    if (event.tag) {
      el.dataset.tag = event.tag;
      for (const old of [...toasts.children]) if (old.dataset.tag === event.tag) old.remove();
    }
    toasts.prepend(el);
    while (toasts.children.length > 4) toasts.lastChild.remove();
    const isAlert = event.level === 'red' || event.level === 'yellow';
    setTimeout(() => el.remove(), isAlert ? 60_000 : 15_000);
    if (!event.ongoing && navigator.vibrate) navigator.vibrate(isAlert ? [300, 150, 300, 150, 300] : [200]);
  }

  // Android Chrome shows notifications only through a service worker, and
  // browsers allow them only on secure pages (HTTPS, localhost).
  let swRegistration = null;
  async function ensureServiceWorker() {
    if (swRegistration || !('serviceWorker' in navigator)) return swRegistration;
    try {
      swRegistration = await navigator.serviceWorker.register('sw.js');
      await navigator.serviceWorker.ready;
    } catch {
      swRegistration = null;
    }
    return swRegistration;
  }

  function browserAvailable() {
    if (!('Notification' in window)) return s.browserUnsupported;
    if (!window.isSecureContext) return s.browserInsecure;
    if (Notification.permission === 'denied') return s.browserDenied;
    return '';
  }

  async function showBrowserNotification(event) {
    if (browserAvailable() || Notification.permission !== 'granted') return;
    const options = { body: event.body || '', tag: event.tag, renotify: true, icon: 'icon-192.png', badge: 'icon-192.png' };
    const registration = await ensureServiceWorker();
    if (registration) registration.showNotification(event.title, options).catch(() => {});
    else {
      try {
        new Notification(event.title, options);
      } catch {
        // No way to show it here; toasts still work.
      }
    }
  }

  // The app serves newer page code than this page runs: only a reload helps.
  function showUpdate() {
    if (!$('update').hidden) return;
    $('update-title').textContent = s.updateTitle;
    $('update-text').textContent = s.updateText;
    $('update-reload').textContent = s.updateButton;
    $('update').hidden = false;
    $('update-reload').focus();
  }
  $('update-reload').addEventListener('click', () => location.reload());

  function handleEvent(event) {
    if (event.kind === 'version') {
      if (version && event.version !== version) showUpdate();
      return;
    }
    if (!prefs[kindPref[event.kind]]) return;
    if (prefs.toasts) showToast(event);
    if (prefs.browser && !event.ongoing) showBrowserNotification(event);
  }

  let events = null;
  function connectEvents() {
    events?.close();
    events = new EventSource(`events?t=${token}`);
    events.onmessage = (message) => {
      try {
        handleEvent(JSON.parse(message.data));
      } catch {
        // Ignore malformed events.
      }
    };
    // EventSource reconnects by itself (retry: 3000 from the server). If the
    // key no longer works ("new link" in the app), go to the sign-in page.
    events.onerror = () => {
      fetch(`auth?t=${token}`, { cache: 'no-store' })
        .then((res) => {
          if (res.status === 403) location.replace(`./?t=${token}`);
        })
        .catch(() => {});
    };
  }

  function renderPrefs() {
    for (const key of Object.keys(prefs)) $(`opt-${key}`).checked = prefs[key];
    browserHint.textContent = prefs.browser || browserAvailable() ? browserAvailable() : '';
    $('notify-btn').classList.toggle('active', prefs.toasts || prefs.browser);
  }

  for (const key of Object.keys(prefs)) {
    $(`opt-${key}`).addEventListener('change', async (event) => {
      let value = event.target.checked;
      if (key === 'browser' && value) {
        const problem = browserAvailable();
        if (problem) {
          value = false;
        } else if (Notification.permission !== 'granted') {
          value = (await Notification.requestPermission()) === 'granted';
        }
        if (value) await ensureServiceWorker();
      }
      prefs[key] = value;
      store.set(`n.${key}`, value ? 'on' : 'off');
      renderPrefs();
    });
  }
  $('notify-btn').addEventListener('click', () => {
    $('notify-panel').hidden = !$('notify-panel').hidden;
    renderPrefs();
  });
  $('notify-close').addEventListener('click', () => {
    $('notify-panel').hidden = true;
  });
  $('notify-test').addEventListener('click', () => {
    const sample = { kind: 'drone', title: s.testTitle, body: s.testBody, level: 'warning', tag: 'test', at: new Date().toISOString() };
    if (prefs.toasts) showToast(sample);
    if (prefs.browser) showBrowserNotification(sample);
  });

  // --- Labels and start -----------------------------------------------------

  for (const button of $('modes').children) {
    button.textContent = s.modes[button.dataset.mode];
    button.title = s.modeTitles[button.dataset.mode];
    button.addEventListener('click', () => setMode(button.dataset.mode));
  }
  $('awake-btn').textContent = s.awake;
  $('awake-btn').title = s.awakeTitle;
  $('autofs-btn').textContent = s.autoFs;
  $('autofs-btn').title = s.autoFsTitle;
  $('fullscreen-btn').textContent = s.fullscreen;
  $('fullscreen-btn').title = s.fullscreenTitle;
  notice.textContent = s.notice;
  $('notify-btn').title = s.notifyTitle;
  $('notify-heading').textContent = s.notifyHeading;
  $('kinds-heading').textContent = s.kindsHeading;
  for (const key of ['toasts', 'browser', 'drone', 'target', 'alert']) $(`lbl-${key}`).textContent = s.notifyLabels[key];
  $('notify-test').textContent = s.notifyTest;
  $('notify-close').textContent = s.notifyClose;

  renderPrefs();
  connectEvents();
  if (prefs.browser && !browserAvailable()) ensureServiceWorker();
  setMode(mode);
  applyAwake();
  showControls();
})();
