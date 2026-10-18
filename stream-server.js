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
  async function captureFrame(needJpeg) {
    await ensureCompositor();
    const area = captureArea();
    const layers = settings.stream.layers;
    const wantBase = layers !== 'top';
    // The top layer as the user sees it: only if it is shown, unless the
    // stream asks for the top layer alone.
    const wantTop = layers === 'top' || (layers === 'both' && overlay.topShown);
    const [bottom, top] = await Promise.all([
      wantBase ? overlay.basePage.capturePage(area) : null,
      wantTop ? overlay.overlayPage.capturePage(area) : null,
    ]);
    const q = quality();
    return request(
      'ui:compose',
      {
        // The base page shows the attribution in its bottom-right corner;
        // draw our own only when that corner is not in the frame.
        attribution: !(bottom && !area),
        banner: overlay.alertBanner(),
        bottom: bottom ? bottom.toJPEG(90) : null,
        // PNG keeps the transparency of the targets-only top layer.
        top: top ? top.toPNG() : null,
        // Alone, the top layer is drawn fully opaque on a dark background.
        opacity: layers === 'top' ? 1 : overlay.topOpacity,
        maxWidth: q.maxWidth,
        quality: q.jpeg,
        needJpeg,
      },
      5000,
    );
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
          console.warn('Stream frame failed:', frameError.message);
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

    if (url.pathname === '/auth') {
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
      console.warn('Stream server error:', serverError.message);
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
    return { running, error, viewers: viewers(), urls, qr, code: signInCode };
  }

  return { apply, stop, newLink, state, broadcast };
}

module.exports = { setupStream, isLocalAddress, QUALITY, AREAS, LAYERS };
