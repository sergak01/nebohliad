'use strict';

// LAN stream: the overlay (both layers blended, like PiP) as live video for
// phones, tablets or TVs on the same network.
//
// - Off by default; a small HTTP server runs only while it is on.
// - Only clients from private/local addresses, and only with the token from
//   the link (settings.stream.token); never meant for the internet.
// - Viewer page (viewer/*): WebRTC video (default, least traffic), MJPEG
//   video (also opens in VLC) or a snapshot every few seconds; fullscreen,
//   "keep screen on", installable to a phone's home screen.
// - Frames are captured only while someone watches (or on a snapshot
//   request), never faster than the app's frame limit.
// - Modes (settings.stream): area (whole map / PiP selection), layers (both
//   blended / base only / top only) and quality (width, fps, JPEG quality).
// - Blending runs in a hidden window (ui/compositor.*), which is also the
//   WebRTC sender; it draws the map attribution and, while targets are near
//   a saved location, an alert banner.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { BrowserWindow, ipcMain } = require('electron');
const QRCode = require('qrcode');
const log = require('./logger');

const BOUNDARY = 'nebohliadframe';
const MAX_VIEWERS = 8;
const SNAPSHOT_SECONDS = 10;
const MAX_SDP_BYTES = 64 * 1024;
const VIEWER_DIR = path.join(__dirname, 'viewer');
// Viewer icons (no data, no token); Chrome wants 192 and 512 px in the manifest.
const ICONS = {
  '/icon.png': path.join(__dirname, 'assets', 'icon.png'),
  '/icon-192.png': path.join(__dirname, 'assets', 'icon-192.png'),
  '/icon-512.png': path.join(__dirname, 'assets', 'icon-512.png'),
};

const QUALITY = {
  low: { maxWidth: 640, fps: 2, jpeg: 0.6 },
  standard: { maxWidth: 1280, fps: 5, jpeg: 0.72 },
  high: { maxWidth: 1920, fps: 10, jpeg: 0.82 },
};
const AREAS = ['full', 'pip'];
const LAYERS = ['both', 'base', 'top'];

// Static viewer files that carry no data: served without the token.
const STATIC = {
  '/viewer.js': ['viewer.js', 'text/javascript; charset=utf-8'],
  '/viewer.css': ['viewer.css', 'text/css; charset=utf-8'],
  // Service worker: only for showing browser notifications (Android Chrome
  // needs one); no fetch handler, so it never touches the streams.
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/login.js': ['login.js', 'text/javascript; charset=utf-8'],
};
const MAX_EVENT_CLIENTS = 16;
// One-time sign-in code shown in the app (for a device without the link):
// 6 digits, a new one every 2 minutes and after each use; the previous one
// still works for 30 s after it is replaced. Failed attempts are limited
// per device address and in total.
const CODE_TTL_MS = 120_000;
const CODE_GRACE_MS = 30_000;
const LOGIN_WINDOW_MS = 10 * 60_000;
const MAX_FAILS_PER_ADDRESS = 5;
const MAX_FAILS_TOTAL = 30;
const MAX_LOGIN_BYTES = 1024;
const EVENT_PING_MS = 25_000;

function newToken() {
  return crypto.randomBytes(12).toString('base64url');
}

// Private, loopback and link-local IPv4/IPv6 addresses.
function isLocalAddress(address) {
  const a = String(address || '').replace(/^::ffff:/, '');
  if (a === '::1' || /^127\./.test(a)) return true;
  if (/^10\./.test(a) || /^192\.168\./.test(a) || /^169\.254\./.test(a)) return true;
  const m = a.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return /^(fe8|fe9|fea|feb|fc|fd)/i.test(a);
}

// Adapters other devices are unlikely to reach this PC through: VPNs and
// virtual switches (by name, or by the MAC prefixes of VirtualBox host-only,
// VMware and Hyper-V adapters, which Windows often names just "Ethernet N").
const VIRTUAL_NAME = /vEthernet|VirtualBox|VMware|Hyper-V|WSL|Docker|Loopback|TAP|VPN|Tailscale|ZeroTier|Npcap|Bluetooth/i;
const VIRTUAL_MAC = /^(0a:00:27|00:50:56|00:0c:29|00:05:69|00:15:5d)/i;

// IPv4 addresses of this PC on its local networks, likely ones (Wi-Fi,
// Ethernet) first: [{ address, name, virtual }].
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family !== 'IPv4' || item.internal || !isLocalAddress(item.address)) continue;
      const virtual = VIRTUAL_NAME.test(name) || VIRTUAL_MAC.test(item.mac || '');
      out.push({ address: item.address, name, virtual });
    }
  }
  return out.sort((a, b) => a.virtual - b.virtual);
}

const VIEWER_STRINGS = {
  uk: {
    app: 'Небогляд',
    title: 'Небогляд — трансляція',
    waiting: 'Підключення…',
    lost: 'Зв’язок втрачено, повторюю…',
    webrtcFailed: 'WebRTC тут не працює — перемикаю на MJPEG.',
    notice: 'Не замінює офіційної тривоги. Під час тривоги — в укриття.',
    modes: { webrtc: 'Відео', mjpeg: 'MJPEG', snap: `Знімки ${SNAPSHOT_SECONDS} с` },
    modeTitles: {
      webrtc: 'Відео через WebRTC: найменше трафіку, телефон зазвичай не гасить екран',
      mjpeg: 'Відео MJPEG: працює майже скрізь, більше трафіку',
      snap: `Знімок кожні ${SNAPSHOT_SECONDS} с: найменше даних`,
    },
    updated: 'Оновлено',
    awake: '☀ Не гасити екран',
    awakeTitle: 'Не давати телефону вимикати екран, поки відкрита ця сторінка',
    awakeFailed: 'Браузер не дає тримати екран увімкненим. Вибери «Відео» або зміни час вимкнення екрана в налаштуваннях телефона.',
    autoFs: 'Авто ⛶',
    autoFsTitle: 'Розгортати на весь екран від першого дотику — зручно для ярлика на головному екрані',
    fullscreen: '⛶',
    fullscreenTitle: 'На весь екран (або двічі торкнись зображення)',
    fullscreenHint: 'На iPhone: «Поділитися» → «На початковий екран», тоді сторінка відкриватиметься без панелей браузера. Або вибери «Відео».',
    notifyTitle: 'Сповіщення: дрони, цілі й тривога біля твоїх локацій',
    notifyHeading: 'Як сповіщати',
    kindsHeading: 'Про що',
    notifyLabels: {
      toasts: 'Спливаючі повідомлення на сторінці',
      browser: 'Сповіщення браузера',
      sound: 'Звук (після першого дотику до сторінки)',
      drone: 'Дрони поблизу локацій',
      target: 'Ракети й інші цілі поблизу',
      alert: 'Повітряна тривога в районі локацій',
    },
    browserUnsupported: 'Цей браузер не показує сповіщень.',
    browserInsecure: 'Браузер дозволяє сповіщення лише на захищених сторінках. Для цієї адреси в локальній мережі: Chrome → chrome://flags → «Insecure origins treated as secure» → додай адресу трансляції. Спливаючі повідомлення працюють і без цього.',
    browserDenied: 'Сповіщення для цієї сторінки заборонено в налаштуваннях браузера.',
    notifyTest: 'Перевірити',
    notifyClose: 'Закрити',
    testTitle: 'Перевірка: дрон поблизу «Дім»',
    testBody: 'Так виглядатиме сповіщення. Не замінює офіційної тривоги.',
    loginTitle: 'Вхід до трансляції',
    loginText: 'Введи одноразовий код із Небогляду на комп’ютері: ⋯ → «Налаштування» → «Трансляція» → «Код для входу». Або встав звідти посилання.',
    loginExpired: 'Посилання застаріле або неправильне.',
    loginPlaceholder: 'Код із 6 цифр',
    loginSubmit: 'Увійти',
    loginWrong: 'Неправильний або прострочений код. Залишилося спроб: {n}.',
    loginLocked: 'Забагато спроб. Спробуй через {m} хв.',
    loginFailed: 'Не вдалося зв’язатися з Небоглядом. Чи він запущений і чи трансляція ввімкнена?',
    pairText: 'Або запроси цей пристрій із застосунку: ⋯ → «Налаштування» → «Трансляція» → «Пристрої, що чекають» → «Запросити».',
    pairPick: 'Обери число, яке показує Небогляд',
    pairWrong: 'Не те число. Запроси пристрій ще раз.',
    pairExpired: 'Запрошення минуло. Запроси пристрій ще раз.',
    pairLeft: 'Ще {n} с',
    updateTitle: 'Сторінку оновлено',
    updateText: 'Небогляд на комп’ютері має нову версію цієї сторінки. Онови її, щоб усе працювало правильно.',
    updateButton: 'Оновити сторінку',
  },
  en: {
    app: 'Nebohliad',
    title: 'Nebohliad stream',
    waiting: 'Connecting…',
    lost: 'Connection lost, retrying…',
    webrtcFailed: 'WebRTC does not work here; switching to MJPEG.',
    notice: 'Not a replacement for official alerts. During an alert, go to a shelter.',
    modes: { webrtc: 'Video', mjpeg: 'MJPEG', snap: `Snapshots ${SNAPSHOT_SECONDS} s` },
    modeTitles: {
      webrtc: 'WebRTC video: least traffic; phones usually keep the screen on',
      mjpeg: 'MJPEG video: works almost everywhere, more traffic',
      snap: `A snapshot every ${SNAPSHOT_SECONDS} s: least data`,
    },
    updated: 'Updated',
    awake: '☀ Keep screen on',
    awakeTitle: 'Keep the phone screen on while this page is open',
    awakeFailed: 'The browser does not allow keeping the screen on. Choose "Video", or change the screen timeout in the phone settings.',
    autoFs: 'Auto ⛶',
    autoFsTitle: 'Go fullscreen on the first tap: handy for a home-screen shortcut',
    fullscreen: '⛶',
    fullscreenTitle: 'Fullscreen (or double-tap the picture)',
    fullscreenHint: 'On iPhone: Share → Add to Home Screen, then the page opens without browser bars. Or choose "Video".',
    notifyTitle: 'Notifications: drones, targets and air alerts near your locations',
    notifyHeading: 'How to notify',
    kindsHeading: 'About what',
    notifyLabels: {
      toasts: 'Pop-up messages on the page',
      browser: 'Browser notifications',
      sound: 'Sound (after the first tap on the page)',
      drone: 'Drones near locations',
      target: 'Missiles and other targets near',
      alert: 'Air alert in a location’s area',
    },
    browserUnsupported: 'This browser does not show notifications.',
    browserInsecure: 'Browsers allow notifications only on secure pages. For this LAN address: Chrome → chrome://flags → "Insecure origins treated as secure" → add the stream address. Pop-up messages work without it.',
    browserDenied: 'Notifications for this page are blocked in the browser settings.',
    notifyTest: 'Test',
    notifyClose: 'Close',
    testTitle: 'Test: drone near “Home”',
    testBody: 'This is how a notification will look. Not a replacement for official alerts.',
    loginTitle: 'Sign in to the stream',
    loginText: 'Enter the one-time code from Nebohliad on the computer: ⋯ → "Settings" → "Stream" → "Sign-in code". Or paste the link from there.',
    loginExpired: 'The link is outdated or wrong.',
    loginPlaceholder: '6-digit code',
    loginSubmit: 'Sign in',
    loginWrong: 'Wrong or expired code. Attempts left: {n}.',
    loginLocked: 'Too many attempts. Try again in {m} min.',
    loginFailed: 'Could not reach Nebohliad. Is it running with the stream on?',
    pairText: 'Or invite this device from the app: ⋯ → \"Settings\" → \"Stream\" → \"Devices waiting\" → \"Invite\".',
    pairPick: 'Pick the number Nebohliad shows',
    pairWrong: 'Wrong number. Invite the device again.',
    pairExpired: 'The invite expired. Invite the device again.',
    pairLeft: '{n} s left',
    updateTitle: 'This page was updated',
    updateText: 'Nebohliad on the computer has a new version of this page. Reload it so everything works correctly.',
    updateButton: 'Reload page',
  },
};

// Fingerprint of the viewer page's code (its files, strings and the app
// version). An open page compares it with what the events stream reports and
// asks for a reload when it differs (app updated or restarted with new code,
// or a viewer file edited).
function viewerVersion() {
  const hash = crypto.createHash('sha256');
  hash.update(String(require('./package.json').version));
  hash.update(JSON.stringify(VIEWER_STRINGS));
  for (const file of fs.readdirSync(VIEWER_DIR).sort()) hash.update(file).update(fs.readFileSync(path.join(VIEWER_DIR, file)));
  return hash.digest('base64url').slice(0, 16);
}

function viewerHtml(lang, token) {
  const s = VIEWER_STRINGS[lang] || VIEWER_STRINGS.uk;
  // JSON inside <script>: no "</" may close the tag early.
  const config = JSON.stringify({ token, snapshotSeconds: SNAPSHOT_SECONDS, version: viewerVersion(), s }).replace(/</g, '\\u003c');
  return fs
    .readFileSync(path.join(VIEWER_DIR, 'viewer.html'), 'utf8')
    .replace(/__LANG__/g, lang)
    .replace(/__TOKEN__/g, token)
    .replace(/__TITLE__/g, s.title)
    .replace(/__APP__/g, s.app)
    .replace('__CONFIG__', config);
}

// Sign-in page for a request without a valid token (`expired`: it had one).
function loginHtml(lang, expired) {
  const s = VIEWER_STRINGS[lang] || VIEWER_STRINGS.uk;
  const config = JSON.stringify({ expired, s }).replace(/</g, '\\u003c');
  return fs
    .readFileSync(path.join(VIEWER_DIR, 'login.html'), 'utf8')
    .replace(/__LANG__/g, lang)
    .replace(/__TITLE__/g, s.loginTitle)
    .replace('__CONFIG__', config);
}

function manifest(lang, token) {
  const s = VIEWER_STRINGS[lang] || VIEWER_STRINGS.uk;
  return JSON.stringify({
    name: s.title,
    short_name: s.app,
    start_url: `/?t=${token}`,
    scope: '/',
    display: 'fullscreen',
    orientation: 'any',
    background_color: '#000000',
    theme_color: '#111318',
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: 'icon.png', sizes: '256x256', type: 'image/png' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  });
}

function setupStream(overlay, getPipArea) {
  const { settings } = overlay;
  let server = null;
  let serverPort = null;
  let error = null;
  const clients = new Set(); // MJPEG: { res, busy }
  let webrtcPeers = 0;
  let loopTimer = null;
  let looping = false;
  let latestFrame = null;

  const viewers = () => clients.size + webrtcPeers;

  // --- Compositor (hidden window) ----------------------------------------

  let compositor = null;
  let compositorReady = null;
  let nextRequest = 1;
  const pending = new Map(); // id -> { resolve, reject }

  function ensureCompositor() {
    if (compositor && !compositor.isDestroyed()) return compositorReady;
    compositor = new BrowserWindow({
      show: false,
      width: 320,
      height: 200,
      skipTaskbar: true,
      webPreferences: { ...overlay.uiWebPreferences(), backgroundThrottling: false },
    });
    compositorReady = compositor.loadFile(path.join(__dirname, 'ui', 'compositor.html'));
    compositor.on('closed', () => {
      compositor = null;
      webrtcPeers = 0;
      for (const { reject } of pending.values()) reject(new Error('compositor closed'));
      pending.clear();
    });
    return compositorReady;
  }

  function request(channel, payload, timeoutMs) {
    const id = nextRequest++;
    return new Promise((resolve, reject) => {
      // Closed meanwhile (a video reset, the app quitting).
      if (!compositor || compositor.isDestroyed()) {
        reject(new Error('compositor closed'));
        return;
      }
      pending.set(id, { resolve, reject });
      compositor.webContents.send(channel, { id, ...payload });
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${channel} timeout`));
      }, timeoutMs);
    });
  }

  function settle(id, value, failure) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (failure) entry.reject(new Error(failure));
    else entry.resolve(value);
  }

  ipcMain.on('ui:composed', (_event, { id, jpeg, error: e }) => settle(id, jpeg ? Buffer.from(jpeg) : null, e));
  ipcMain.on('ui:webrtc-answer', (_event, { id, sdp, error: e }) => settle(id, sdp, e));
  ipcMain.on('ui:webrtc-peers', (_event, count) => {
    if (count !== webrtcPeers) log.info('stream', 'WebRTC viewers', { count });
    webrtcPeers = count;
    overlay.streamChanged();
    if (count > 0) loop();
  });

  // --- Frames ------------------------------------------------------------

  const quality = () => QUALITY[settings.stream.quality] || QUALITY.standard;

  // The PiP selection when chosen and known, else the whole map area.
  function captureArea() {
    if (settings.stream.area === 'pip') return getPipArea() || undefined;
    return undefined;
  }

  // Draws a frame in the compositor (which feeds WebRTC); returns a JPEG
  // when `needJpeg` (MJPEG viewers, snapshots).
  // After sleep or a GPU reset the canvas's video track can go black while
  // JPEG readback of the same canvas still works (MJPEG fine, WebRTC black).
  // A fresh compositor (new canvas, GPU context and track) fixes it; WebRTC
  // viewers reconnect by themselves, MJPEG just gets the next frame.
  let lastVideoReset = 0;
  const VIDEO_RESET_MIN_MS = 20_000;

  function resetVideo(reason) {
    if (!compositor || compositor.isDestroyed()) return false;
    if (Date.now() - lastVideoReset < VIDEO_RESET_MIN_MS) return false;
    lastVideoReset = Date.now();
    log.warn('stream', 'video reset', { reason });
    // Close the peers properly first, so viewers see it at once instead of
    // after an ICE timeout, then drop the window ('closed' rejects pending
    // frames and clears the peer count).
    const old = compositor;
    old.webContents.send('ui:webrtc-close-all');
    setTimeout(() => {
      if (!old.isDestroyed()) old.destroy();
      overlay.streamChanged();
      if (clients.size) loop();
    }, 300);
    return true;
  }

  // The compositor is a renderer process (~100 MB with its canvas and video
  // encoder): closed after a minute with no viewers and no frame requests,
  // made again for the next one.
  const COMPOSITOR_IDLE_MS = 60_000;
  let lastFrameAt = 0;
  setInterval(() => {
    if (compositor && !compositor.isDestroyed() && viewers() === 0 && !pending.size && Date.now() - lastFrameAt > COMPOSITOR_IDLE_MS) {
      compositor.destroy();
    }
  }, 15_000).unref?.();

  // --- Health ------------------------------------------------------------
  // Each frame carries its number (seq) in a marker the viewer reads back
  // (compositor.js / viewer.js). Problems are found by:
  // - this side: a page capture that hangs (> CAPTURE_TIMEOUT_MS);
  // - the compositor: frames requested but not encoded ('ui:compositor-health');
  // - viewers: POST /health every 30 s with how long their marker has not
  //   changed (frozen) or whether the picture is black;
  // - silence: WebRTC viewers but no report for REPORT_SILENCE_MS.
  // Fixes go up a ladder, each step rate-limited: viewer reconnect (viewer's
  // own), new compositor (resetVideo), reload the map pages.
  const CAPTURE_TIMEOUT_MS = 10_000;
  const FROZEN_MS = 15_000;
  const REPORT_SILENCE_MS = 3 * 60_000;
  const SILENCE_FIX_EVERY_MS = 15 * 60_000;
  const RELOAD_EVERY_MS = 10 * 60_000;
  const WAKE_EVERY_MS = 60_000;
  let lastWake = 0;
  let frameSeq = 0;
  let lastComposedAt = 0;
  let captureTimeouts = 0;
  let lastReload = 0;
  let lastReportAt = 0;
  let lastSilenceFix = 0;
  let lastHealthPush = 0;
  // problem: { at, what, fix } as codes (encoder-stalled, no-reports,
  // viewer-black, viewer-frozen, capture-stalled / video-restarted,
  // windows-woken, pages-reloaded); the settings window words them.
  const health = { okAt: null, problem: null };

  function noteProblem(what, fix) {
    health.problem = { at: Date.now(), what, fix };
    log.warn('stream', `health: ${what}`, { fix });
    overlay.streamChanged();
  }

  function withTimeout(promise, ms, what) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timeout`)), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  ipcMain.on('ui:compositor-health', (event, report) => {
    if (!compositor || compositor.isDestroyed() || event.sender !== compositor.webContents) return;
    if (report?.stalled && resetVideo('encoder stalled')) noteProblem('encoder-stalled', 'video-restarted');
  });

  // WebRTC viewers that reported before have gone quiet while frames are
  // being made: their page may be stuck. Only for viewers that report at all
  // (lastReportAt set), so an old page without reports never triggers it.
  setInterval(() => {
    if (!server || webrtcPeers === 0 || !lastReportAt) return;
    const now = Date.now();
    const composing = now - lastComposedAt < 10_000;
    if (composing && now - lastReportAt > REPORT_SILENCE_MS && now - lastSilenceFix > SILENCE_FIX_EVERY_MS) {
      lastSilenceFix = now;
      if (resetVideo('no health report')) noteProblem('no-reports', 'video-restarted');
    }
  }, 30_000).unref?.();

  // Viewers' latest reports by their id: { at, ok }. A stuck picture on one
  // device while another reports a fine one is that device's own trouble
  // (e.g. a TV that cannot read its video back): it reconnects itself, and
  // the others keep their video. Seen 2026-10-21: one such viewer restarted
  // the video for everyone every 30 s.
  const viewerReports = new Map();
  const OTHERS_OK_MS = 45_000;

  // A viewer's report: { id, seq, frozenMs, black, mode, readable }.
  function healthReport(report) {
    const now = Date.now();
    lastReportAt = now;
    const frozen = Number(report?.frozenMs) >= FROZEN_MS;
    const stuck = frozen || Boolean(report?.black);
    const id = typeof report?.id === 'string' ? report.id.slice(0, 16) : null;
    if (id) viewerReports.set(id, { at: now, ok: !stuck });
    for (const [key, value] of viewerReports) if (now - value.at > 5 * 60_000) viewerReports.delete(key);
    const othersOk = [...viewerReports].some(([key, value]) => key !== id && value.ok && now - value.at < OTHERS_OK_MS);
    const composing = now - lastComposedAt < 10_000;
    if (stuck && othersOk) {
      log.info('stream', 'one viewer stuck while others are fine: it reconnects itself', { what: report?.black ? 'black' : 'frozen', readable: report?.readable ?? null });
      return { reset: false };
    }
    if (stuck && composing) {
      // Frames are made here, but the viewer's picture stands still or is
      // black: the video path is stuck.
      const what = report?.black ? 'viewer-black' : 'viewer-frozen';
      if (resetVideo(what)) {
        noteProblem(what, 'video-restarted');
        return { reset: true };
      }
      return { reset: false };
    }
    if (!frozen && !report?.black) {
      health.okAt = Date.now();
      // The settings window shows when the last good report came; once a minute is enough.
      if (health.okAt - lastHealthPush > 60_000) {
        lastHealthPush = health.okAt;
        overlay.streamChanged();
      }
    }
    return { reset: false };
  }

  async function capturePages(area, wantBase, wantTop) {
    try {
      const pages = await Promise.all([
        wantBase ? withTimeout(overlay.basePage.capturePage(area), CAPTURE_TIMEOUT_MS, 'base page capture') : null,
        wantTop ? withTimeout(overlay.overlayPage.capturePage(area), CAPTURE_TIMEOUT_MS, 'top page capture') : null,
      ]);
      captureTimeouts = 0;
      return pages;
    } catch (captureError) {
      if (/timeout/.test(captureError.message)) {
        captureTimeouts++;
        // Hidden windows (tray) may get no frames at all: show them for a
        // moment first; reload only if that did not help.
        if (captureTimeouts >= 2 && Date.now() - lastWake > WAKE_EVERY_MS && overlay.wakeHiddenWindows()) {
          lastWake = Date.now();
          captureTimeouts = 0;
          noteProblem('capture-stalled', 'windows-woken');
        } else if (captureTimeouts >= 2 && Date.now() - lastReload > RELOAD_EVERY_MS) {
          lastReload = Date.now();
          captureTimeouts = 0;
          noteProblem('capture-stalled', 'pages-reloaded');
          overlay.reloadMaps();
        }
      }
      throw captureError;
    }
  }

  async function captureFrame(needJpeg) {
    lastFrameAt = Date.now();
    await ensureCompositor();
    const area = captureArea();
    const layers = settings.stream.layers;
    const wantBase = layers !== 'top';
    // The top layer as the user sees it: only if it is shown, unless the
    // stream asks for the top layer alone.
    const wantTop = layers === 'top' || (layers === 'both' && overlay.topShown);
    const [bottom, top] = await capturePages(area, wantBase, wantTop);
    const q = quality();
    frameSeq = (frameSeq + 1) & 255;
    return request(
      'ui:compose',
      {
        // The base page shows the attribution in its bottom-right corner;
        // draw our own only when that corner is not in the frame.
        attribution: !(bottom && !area),
        banner: overlay.alertBanner(),
        notice: overlay.noticeBanner(),
        bottom: bottom ? bottom.toJPEG(90) : null,
        // PNG keeps the top layer's transparency: the page itself draws its
        // map at the user's opacity (preload.js topLayerCss), so it is
        // blended as it is (alone: on a dark background).
        top: top ? top.toPNG() : null,
        opacity: 1,
        maxWidth: q.maxWidth,
        quality: q.jpeg,
        seq: frameSeq,
        needJpeg,
      },
      5000,
    ).then((jpeg) => {
      lastComposedAt = Date.now();
      return jpeg;
    });
  }

  function frameIntervalMs() {
    const fps = Math.min(quality().fps, settings.fpsLimit || 60);
    return 1000 / Math.max(1, fps);
  }

  function writeFrame(client, jpeg) {
    if (client.busy) return; // Slow client: skip frames until it drains.
    const head = `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`;
    client.res.write(head);
    const ok = client.res.write(jpeg);
    client.res.write('\r\n');
    if (!ok) {
      client.busy = true;
      client.res.once('drain', () => {
        client.busy = false;
      });
    }
  }

  // The pause between frames; stop() wakes it (clearing the timer alone
  // would leave the loop waiting forever, and `looping` stuck on).
  let wakeLoop = null;

  function pause(ms) {
    return new Promise((resolve) => {
      wakeLoop = resolve;
      loopTimer = setTimeout(resolve, ms);
    });
  }

  // One loop per running server: a restart (new port) ends the old one.
  async function loop() {
    if (looping) return;
    looping = true;
    const own = server;
    try {
      while (viewers() > 0 && server && server === own) {
        const started = Date.now();
        try {
          const jpeg = await captureFrame(clients.size > 0);
          if (jpeg && server === own) {
            latestFrame = jpeg;
            for (const client of clients) writeFrame(client, jpeg);
          }
        } catch (frameError) {
          log.warn('stream', 'frame failed', frameError.message);
        }
        await pause(Math.max(10, frameIntervalMs() - (Date.now() - started)));
      }
    } finally {
      looping = false;
    }
    // Viewers may have arrived on a new server while this loop wound down.
    if (viewers() > 0 && server && server !== own) loop();
  }

  // --- HTTP ----------------------------------------------------------------

  function tokenMatches(value) {
    if (typeof value !== 'string' || !settings.stream.token) return false;
    const hash = (v) => crypto.createHash('sha256').update(v).digest();
    return crypto.timingSafeEqual(hash(value), hash(settings.stream.token));
  }

  // --- Sign-in with a one-time code ---------------------------------------

  let code = null; // { value, expiresAt }
  let previousCode = null; // { value, until }
  let codeTimer = null;
  const fails = []; // [{ address, at }]

  function newCode() {
    return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  }

  // keepPrevious: false after a use or a new link, so the old code dies now.
  function rotateCode({ keepPrevious = true } = {}) {
    const now = Date.now();
    previousCode = keepPrevious && code ? { value: code.value, until: now + CODE_GRACE_MS } : null;
    code = { value: newCode(), expiresAt: now + CODE_TTL_MS };
    clearTimeout(codeTimer);
    codeTimer = setTimeout(() => {
      rotateCode();
      overlay.streamChanged();
    }, CODE_TTL_MS);
  }

  function clearCode() {
    clearTimeout(codeTimer);
    codeTimer = null;
    code = null;
    previousCode = null;
  }

  function sameText(a, b) {
    const hash = (v) => crypto.createHash('sha256').update(String(v)).digest();
    return crypto.timingSafeEqual(hash(a), hash(b));
  }

  function codeMatches(value) {
    if (!/^\d{6}$/.test(value)) return false;
    const now = Date.now();
    const current = code && now < code.expiresAt && sameText(value, code.value);
    const previous = previousCode && now < previousCode.until && sameText(value, previousCode.value);
    return Boolean(current || previous);
  }

  // A pasted link or key also signs in: its token is checked like the link.
  function tokenFromInput(input) {
    const match = input.match(/[?&]t=([\w-]+)/);
    return match ? match[1] : input;
  }

  function recentFails(address) {
    const since = Date.now() - LOGIN_WINDOW_MS;
    while (fails.length && fails[0].at < since) fails.shift();
    return { address: fails.filter((f) => f.address === address).length, total: fails.length };
  }

  function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
  }

  async function handleLogin(req, res) {
    if (req.method !== 'POST') return res.writeHead(405).end();
    const address = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const count = recentFails(address);
    if (count.address >= MAX_FAILS_PER_ADDRESS || count.total >= MAX_FAILS_TOTAL) {
      const mine = fails.filter((f) => f.address === address);
      const oldest = (count.address >= MAX_FAILS_PER_ADDRESS ? mine[0] : fails[0]).at;
      return sendJson(res, 429, { retryInMs: Math.max(0, oldest + LOGIN_WINDOW_MS - Date.now()) });
    }
    let input = '';
    try {
      input = String(JSON.parse(await readBody(req, MAX_LOGIN_BYTES)).code || '').trim();
    } catch {
      return sendJson(res, 400, {});
    }
    const digits = input.replace(/[\s-]/g, '');
    if (codeMatches(digits)) {
      rotateCode({ keepPrevious: false }); // One use per code.
      overlay.streamChanged();
      return sendJson(res, 200, { token: settings.stream.token });
    }
    if (input && tokenMatches(tokenFromInput(input))) return sendJson(res, 200, { token: settings.stream.token });
    fails.push({ address, at: Date.now() });
    return sendJson(res, 401, { left: Math.max(0, MAX_FAILS_PER_ADDRESS - count.address - 1) });
  }

  // --- Pairing: invite a waiting device (like WPS on a router) ------------
  // A device on the sign-in page reports itself every couple of seconds
  // (`GET /pair?d=<its id>`); the app lists such devices and can invite one.
  // The device then gets three numbers and must pick the one the app shows:
  // the right one returns the stream key, a wrong one cancels the invite and
  // counts as a failed sign-in (same limits as the code).

  const PAIR_SEEN_MS = 10_000; // A waiting device polls every 2 s.
  const INVITE_TTL_MS = 60_000;
  const MAX_WAITING = 10;
  const waiting = new Map(); // id -> { id, address, device, lastSeen, invite }

  // "Android · Chrome" from a user agent.
  function deviceLabel(ua = '') {
    const os = /Android/i.test(ua) ? 'Android' : /iPhone/i.test(ua) ? 'iPhone' : /iPad/i.test(ua) ? 'iPad' : /Windows/i.test(ua) ? 'Windows' : /Mac OS X/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : '';
    const browser = /SamsungBrowser/i.test(ua) ? 'Samsung Internet' : /Edg\//i.test(ua) ? 'Edge' : /Firefox|FxiOS/i.test(ua) ? 'Firefox' : /Chrome|CriOS/i.test(ua) ? 'Chrome' : /Safari/i.test(ua) ? 'Safari' : '';
    return [os, browser].filter(Boolean).join(' · ') || '?';
  }

  function pruneWaiting() {
    const now = Date.now();
    let changed = false;
    for (const [id, entry] of waiting) {
      if (now - entry.lastSeen > PAIR_SEEN_MS) {
        waiting.delete(id);
        changed = true;
      } else if (entry.invite && now > entry.invite.expiresAt) {
        entry.invite = null;
        changed = true;
      }
    }
    if (changed) overlay.streamChanged();
  }
  setInterval(pruneWaiting, 2000).unref?.();

  // From the app: invite one waiting device. Returns its number or null.
  function invite(id) {
    pruneWaiting();
    const entry = waiting.get(id);
    if (!entry) return null;
    const number = crypto.randomInt(10, 100);
    const choices = new Set([number]);
    while (choices.size < 3) choices.add(crypto.randomInt(10, 100));
    const shuffled = [...choices];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = crypto.randomInt(0, i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    entry.invite = { number, choices: shuffled, expiresAt: Date.now() + INVITE_TTL_MS };
    overlay.streamChanged();
    return number;
  }

  function cancelInvite(id) {
    const entry = waiting.get(id);
    if (entry?.invite) {
      entry.invite = null;
      overlay.streamChanged();
    }
  }

  async function handlePair(req, res, url) {
    const address = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const count = recentFails(address);
    if (count.address >= MAX_FAILS_PER_ADDRESS || count.total >= MAX_FAILS_TOTAL) return sendJson(res, 429, {});
    if (req.method === 'GET') {
      const id = url.searchParams.get('d') || '';
      if (!/^[A-Za-z0-9_-]{8,40}$/.test(id)) return sendJson(res, 400, {});
      let entry = waiting.get(id);
      if (!entry) {
        if (waiting.size >= MAX_WAITING) return sendJson(res, 503, {});
        entry = { id, address, device: deviceLabel(req.headers['user-agent']), invite: null };
        waiting.set(id, entry);
        overlay.streamChanged();
      }
      entry.lastSeen = Date.now();
      entry.address = address;
      const active = entry.invite && Date.now() < entry.invite.expiresAt ? entry.invite : null;
      return sendJson(res, 200, { invite: active && { choices: active.choices, expiresInMs: active.expiresAt - Date.now() } });
    }
    if (req.method !== 'POST') return res.writeHead(405).end();
    let body = {};
    try {
      body = JSON.parse(await readBody(req, MAX_LOGIN_BYTES));
    } catch {
      return sendJson(res, 400, {});
    }
    const entry = waiting.get(String(body.d || ''));
    if (!entry?.invite || Date.now() > entry.invite.expiresAt) return sendJson(res, 409, {});
    if (Number(body.choice) === entry.invite.number) {
      waiting.delete(entry.id);
      overlay.streamChanged();
      return sendJson(res, 200, { token: settings.stream.token });
    }
    entry.invite = null;
    fails.push({ address, at: Date.now() });
    overlay.streamChanged();
    return sendJson(res, 401, { wrong: true });
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          reject(new Error('too large'));
          req.destroy();
        } else {
          chunks.push(chunk);
        }
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function handleWebRtc(req, res) {
    if (req.method !== 'POST') return res.writeHead(405).end();
    if (viewers() >= MAX_VIEWERS) return res.writeHead(503).end();
    try {
      const sdp = await readBody(req, MAX_SDP_BYTES);
      await ensureCompositor();
      const answer = await request('ui:webrtc-offer', { sdp, maxPeers: MAX_VIEWERS - clients.size }, 8000);
      res.writeHead(200, { 'Content-Type': 'application/sdp', 'Cache-Control': 'no-store' }).end(answer);
    } catch (e) {
      res.writeHead(e.message === 'busy' ? 503 : 500).end();
    }
  }

  function handle(req, res) {
    if (!isLocalAddress(req.socket.remoteAddress)) return res.writeHead(403).end();
    const url = new URL(req.url, 'http://localhost');
    const noStore = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

    if (STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      return res.writeHead(200, { ...noStore, 'Content-Type': type }).end(fs.readFileSync(path.join(VIEWER_DIR, file)));
    }
    if (ICONS[url.pathname]) {
      return res
        .writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' })
        .end(fs.readFileSync(ICONS[url.pathname]));
    }
    if (url.pathname === '/login') return handleLogin(req, res);
    if (url.pathname === '/pair') return handlePair(req, res, url);
    const token = url.searchParams.get('t');
    if (!tokenMatches(token)) {
      // The page itself offers to sign in with a code; everything else is closed.
      if (url.pathname === '/' && req.method === 'GET') {
        return res
          .writeHead(200, { ...noStore, 'Content-Type': 'text/html; charset=utf-8' })
          .end(loginHtml(settings.lang, token !== null));
      }
      return res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Forbidden');
    }

    if (url.pathname === '/health') {
      // A viewer's periodic report (viewer.js watchdog).
      if (req.method !== 'POST') return res.writeHead(405).end();
      readBody(req, MAX_LOGIN_BYTES).then(
        (text) => {
          let report = {};
          try {
            report = JSON.parse(text);
          } catch {
            // Empty or broken report: counts as a sign of life only.
          }
          sendJson(res, 200, healthReport(report));
        },
        () => res.writeHead(400).end(),
      );
    } else if (url.pathname === '/webrtc-reset') {
      // A viewer saw only black video for a while (pages from before /health).
      if (req.method !== 'POST') return res.writeHead(405).end();
      const reset = resetVideo('viewer saw black video');
      if (reset) noteProblem('viewer-black', 'video-restarted');
      res.writeHead(reset ? 204 : 429, noStore).end();
    } else if (url.pathname === '/auth') {
      // For a page to check a stored or current token.
      res.writeHead(204, noStore).end();
    } else if (url.pathname === '/') {
      res.writeHead(200, { ...noStore, 'Content-Type': 'text/html; charset=utf-8' });
      res.end(viewerHtml(settings.lang, settings.stream.token));
    } else if (url.pathname === '/manifest.webmanifest') {
      res.writeHead(200, { ...noStore, 'Content-Type': 'application/manifest+json' });
      res.end(manifest(settings.lang, settings.stream.token));
    } else if (url.pathname === '/webrtc') {
      handleWebRtc(req, res);
    } else if (url.pathname === '/events') {
      openEvents(req, res);
    } else if (url.pathname === '/stream.mjpg') {
      if (viewers() >= MAX_VIEWERS) return res.writeHead(503).end();
      res.writeHead(200, {
        ...noStore,
        Connection: 'close',
        'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      });
      res.flushHeaders(); // The viewer sees the stream open before frame one.
      const client = { res, busy: false };
      clients.add(client);
      if (latestFrame) writeFrame(client, latestFrame);
      overlay.streamChanged();
      req.on('close', () => {
        clients.delete(client);
        overlay.streamChanged();
      });
      loop();
    } else if (url.pathname === '/frame.jpg') {
      (latestFrame && looping && clients.size ? Promise.resolve(latestFrame) : captureFrame(true)).then(
        (jpeg) => res.writeHead(200, { ...noStore, 'Content-Type': 'image/jpeg' }).end(jpeg),
        () => res.writeHead(500).end(),
      );
    } else {
      res.writeHead(404).end();
    }
    return undefined;
  }

  // --- Events for viewers (Server-Sent Events) ---------------------------
  // Drones / other targets near a location, air alert start / change / end.
  // A new connection first gets the ongoing alerts (`ongoing: true`).

  const eventClients = new Set();
  let pingTimer = null;

  function sendEvent(res, event) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  function openEvents(req, res) {
    if (eventClients.size >= MAX_EVENT_CLIENTS) return res.writeHead(503).end();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    sendEvent(res, { kind: 'version', version: viewerVersion() });
    for (const event of overlay.alertSnapshot()) sendEvent(res, { ...event, at: new Date().toISOString() });
    eventClients.add(res);
    req.on('close', () => eventClients.delete(res));
    if (!pingTimer) {
      // Keeps proxies and phones from dropping an idle connection.
      pingTimer = setInterval(() => {
        for (const client of eventClients) client.write(': ping\n\n');
      }, EVENT_PING_MS);
    }
    return undefined;
  }

  function broadcast(event) {
    if (!server) return;
    const stamped = { ...event, at: new Date().toISOString() };
    for (const client of eventClients) sendEvent(client, stamped);
  }

  // Viewer files edited while the app runs (development): tell open pages.
  let viewerWatcher = null;
  let watchTimer = null;
  let lastVersion = null;

  function watchViewer() {
    lastVersion = viewerVersion();
    try {
      viewerWatcher = fs.watch(VIEWER_DIR, () => {
        clearTimeout(watchTimer);
        watchTimer = setTimeout(() => {
          const version = viewerVersion();
          if (version === lastVersion) return;
          lastVersion = version;
          for (const client of eventClients) sendEvent(client, { kind: 'version', version });
        }, 500);
      });
    } catch {
      viewerWatcher = null; // Inside app.asar there is nothing to watch.
    }
  }

  function unwatchViewer() {
    clearTimeout(watchTimer);
    viewerWatcher?.close();
    viewerWatcher = null;
  }

  function closeViewers() {
    for (const client of eventClients) client.destroy();
    eventClients.clear();
    clearInterval(pingTimer);
    pingTimer = null;
    for (const client of clients) client.res.destroy();
    clients.clear();
    if (compositor && !compositor.isDestroyed()) compositor.webContents.send('ui:webrtc-close-all');
  }

  function start() {
    if (server) return;
    error = null;
    if (!settings.stream.token) settings.stream.token = newToken();
    rotateCode({ keepPrevious: false });
    watchViewer();
    server = http.createServer(handle);
    serverPort = settings.stream.port;
    server.on('error', (serverError) => {
      error = serverError.code || serverError.message;
      log.error('stream', 'server error', serverError.message);
      stop({ keepError: true });
      overlay.streamChanged();
    });
    server.listen(serverPort, '0.0.0.0', () => overlay.streamChanged());
  }

  function stop({ keepError = false } = {}) {
    clearTimeout(loopTimer);
    wakeLoop?.();
    closeViewers();
    clearCode();
    waiting.clear();
    unwatchViewer();
    latestFrame = null;
    if (server) {
      server.close();
      server = null;
    }
    if (compositor && !compositor.isDestroyed()) compositor.destroy();
    webrtcPeers = 0;
    if (!keepError) error = null;
  }

  // Start, stop, or restart on a new port, to match the settings.
  function apply() {
    if (!settings.stream.enabled) {
      stop();
      return;
    }
    if (server && serverPort !== settings.stream.port) stop();
    start();
  }

  // Rotating the token cuts off everyone who has the old link.
  function newLink() {
    settings.stream.token = newToken();
    if (server) rotateCode({ keepPrevious: false });
    closeViewers();
  }

  // urls: [{ url, name, virtual }]; the QR code is for the first (likeliest).
  async function state() {
    const running = Boolean(server && server.listening);
    const urls = running
      ? lanAddresses().map(({ address, name, virtual }) => ({
          url: `http://${address}:${serverPort}/?t=${settings.stream.token}`,
          name,
          virtual,
        }))
      : [];
    const qr = urls[0] ? await QRCode.toDataURL(urls[0].url, { margin: 1, width: 180 }) : null;
    const signInCode = running && code ? { value: code.value, expiresAt: code.expiresAt } : null;
    // Devices waiting on the sign-in page; an invited one with its number.
    const devices = running
      ? [...waiting.values()].map(({ id, address, device, invite: inv }) => ({ id, address, device, invite: inv && { number: inv.number, expiresAt: inv.expiresAt } }))
      : [];
    // The video watchdog's last word, for Settings → Stream.
    const videoHealth = running ? { okAt: health.okAt, problem: health.problem, reportAt: lastReportAt || null } : null;
    return { running, error, viewers: viewers(), urls, qr, code: signInCode, devices, health: videoHealth };
  }

  return { apply, stop, newLink, state, broadcast, resetVideo, invite, cancelInvite };
}

module.exports = { setupStream, isLocalAddress, QUALITY, AREAS, LAYERS };
