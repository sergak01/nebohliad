'use strict';

// Settings window: pages in a sidebar. State arrives as 'ui:state' (the same
// object the toolbar gets); changes go out as 'ui:toolbar-set' and
// 'ui:toolbar-action'.

const $ = (id) => document.getElementById(id);
const set = (key, value) => overlay.send('ui:toolbar-set', { key, value });
const action = (name, data) => overlay.send('ui:toolbar-action', { name, data });

let state = null;
let results = [];

// --- Pages ---------------------------------------------------------------------

function showPage(page) {
  if (!document.querySelector(`section[data-page="${page}"]`)) page = 'maps';
  for (const section of document.querySelectorAll('section.page')) section.hidden = section.dataset.page !== page;
  for (const button of $('nav').children) button.classList?.toggle('active', button.dataset.page === page);
  document.querySelector('main').scrollTop = 0;
  overlay.send('ui:settings-page-shown', page);
}

for (const button of $('nav').querySelectorAll('button')) button.addEventListener('click', () => showPage(button.dataset.page));
showPage(new URLSearchParams(location.search).get('page') || 'maps');
overlay.on('ui:settings-page', showPage);

function setSwitch(id, on) {
  $(id).setAttribute('aria-checked', String(Boolean(on)));
}

// --- Render ------------------------------------------------------------------------

function render() {
  if (!state) return;
  $('base').replaceChildren(
    ...state.sites.map((site) => {
      const button = document.createElement('button');
      button.textContent = t(`site.${site.id}`);
      button.title = t(`site.${site.id}.title`);
      button.classList.toggle('active', site.id === state.base);
      button.addEventListener('click', () => set('base', site.id));
      return button;
    }),
  );
  $('targets-only').classList.toggle('active', state.targetsOnly);
  $('full-page').classList.toggle('active', !state.targetsOnly);
  $('opacity').value = Math.round(state.opacity * 100);
  $('opacity-value').textContent = `${Math.round(state.opacity * 100)}%`;
  for (const button of $('theme').children) button.classList.toggle('active', button.dataset.theme === state.theme);
  for (const button of $('lang').children) button.classList.toggle('active', button.dataset.lang === state.lang);
  setSwitch('alerts-enabled', state.alerts.enabled);
  if (document.activeElement !== $('radius')) $('radius').value = state.alerts.radiusKm;
  setSwitch('close-to-tray', state.closeToTray);
  for (const button of $('follow').children) button.classList.toggle('active', button.dataset.value === state.follow);
  setSwitch('quiet-enabled', state.quiet?.enabled);
  if (document.activeElement !== $('quiet-from')) $('quiet-from').value = state.quiet?.from || '23:00';
  if (document.activeElement !== $('quiet-to')) $('quiet-to').value = state.quiet?.to || '07:00';
  for (const button of $('fps').children) button.classList.toggle('active', Number(button.dataset.fps) === state.fpsLimit);
  $('about-name').textContent = t('app.name');
  $('about-version').textContent = state.about.version;
  $('nav-version').textContent = `${t('app.name')} ${state.about.version}`;
  $('about-license').textContent = state.about.license;
  $('about-homepage').href = state.about.homepage;
  $('about-homepage').title = state.about.homepage;
  document.title = `${t('settings.title')} — ${t('app.name')}`;
  renderLocations();
  renderStream();
  renderShortcuts();
  renderUpdate();
}

// Whether this is the newest code on GitHub (version-check.js).
function renderUpdate() {
  const u = state.update;
  setSwitch('update-enabled', state.updateCheck);
  const local = u?.local;
  const date = local?.date ? ` · ${new Date(local.date).toLocaleDateString(document.documentElement.lang)}` : '';
  $('update-commit').textContent = local ? `${local.commit.slice(0, 7)}${date}${local.dirty ? ` ${t('update.dirty')}` : ''}` : '—';
  let text = t(`update.status.${u?.status || 'unknown'}`).replace('{n}', u?.behindBy ?? '').replace('{error}', u?.error || '');
  if (u?.checkedAt && u.status !== 'checking') {
    text += ` · ${t('update.checked').replace('{time}', new Date(u.checkedAt).toLocaleTimeString(document.documentElement.lang, { hour: '2-digit', minute: '2-digit' }))}`;
  }
  $('update-status').textContent = text;
  $('update-status').classList.toggle('accent', ['behind', 'diverged'].includes(u?.status));
  const changes = ['behind', 'diverged'].includes(u?.status) && u.compareUrl;
  $('update-changes').hidden = !changes;
  if (changes) $('update-changes').href = u.compareUrl;
  $('update-check').disabled = !state.updateCheck || u?.status === 'checking';
}

function iconButton(name, title, onClick, extraClass = '') {
  const button = document.createElement('button');
  button.className = `icon ${extraClass}`.trim();
  button.title = title;
  button.setAttribute('aria-label', title);
  button.append(icon(name));
  button.addEventListener('click', onClick);
  return button;
}

function renderLocations() {
  const list = $('locations');
  // Keep a name or radius being edited untouched. Only for inputs: a clicked
  // button (remove, primary) keeps the focus too, and skipping then left a
  // removed location on screen.
  if (list.contains(document.activeElement) && document.activeElement.matches('input')) return;
  $('no-locations').hidden = state.locations.length > 0;
  list.replaceChildren(
    ...state.locations.map((loc) => {
      const li = document.createElement('li');
      const primary = iconButton(
        'star',
        t(loc.primary ? 'menu.locations.isPrimary' : 'menu.locations.makePrimary'),
        () => overlay.send('ui:location-primary', loc.id),
        `star${loc.primary ? ' active' : ''}`,
      );
      const name = document.createElement('input');
      name.type = 'text';
      name.value = loc.name;
      name.title = t('menu.locations.rename');
      name.addEventListener('change', () => overlay.send('ui:location-rename', { id: loc.id, name: name.value }));
      name.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') name.blur();
      });
      const region = document.createElement('span');
      region.className = 'region';
      region.textContent = loc.region || '';
      region.title = loc.region || '';
      // Its own alert radius; empty = the common one (shown as the placeholder).
      const radius = document.createElement('input');
      radius.type = 'number';
      radius.className = 'radius';
      radius.min = '1';
      radius.max = '500';
      radius.step = '1';
      radius.value = loc.radiusKm ?? '';
      radius.placeholder = String(state.alerts.radiusKm);
      radius.title = t('settings.locations.radius');
      radius.addEventListener('change', () => {
        const km = radius.value === '' ? null : Math.round(Number(radius.value));
        if (km !== null && !(km >= 1 && km <= 500)) {
          radius.value = loc.radiusKm ?? '';
          return;
        }
        overlay.send('ui:location-radius', { id: loc.id, km });
      });
      const km = document.createElement('span');
      km.className = 'region';
      km.textContent = t('menu.km');
      const show = iconButton('target', t('menu.locations.show'), () => overlay.send('ui:location-show', loc.id));
      const remove = iconButton('trash', t('menu.locations.remove'), () => overlay.send('ui:location-remove', loc.id));
      li.append(primary, name, region, radius, km, show, remove);
      return li;
    }),
  );
}

function renderStream() {
  const s = state.stream;
  setSwitch('stream-enabled', s.enabled);
  if (document.activeElement !== $('stream-port')) $('stream-port').value = s.port;
  for (const [id, key] of [['stream-area', 'area'], ['stream-layers', 'layers'], ['stream-quality', 'quality']]) {
    for (const button of $(id).children) button.classList.toggle('active', button.dataset.value === s[key]);
  }
  let status = t('settings.stream.off');
  if (s.error) status = t('stream.error').replace('{error}', s.error);
  else if (s.running) status = t('stream.running').replace('{n}', s.viewers);
  else if (s.enabled) status = t('stream.starting');
  $('stream-status').textContent = status;
  $('stream-status').classList.toggle('error', Boolean(s.error));
  $('stream-links').hidden = !(s.running && s.urls.length);
  // Likely addresses (Wi-Fi, Ethernet) in view; VPN / virtual ones folded.
  const urlItem = ({ url, name }) => {
    const li = document.createElement('li');
    const text = document.createElement('span');
    text.className = 'url';
    text.textContent = url.replace(/\?t=.*$/, '');
    text.title = url;
    const label = document.createElement('span');
    label.className = 'name';
    label.textContent = name;
    label.title = name;
    const copy = iconButton('copy', t('stream.copy'), () => {
      action('copy', url);
      copy.title = t('settings.copied');
      setTimeout(() => (copy.title = t('stream.copy')), 1200);
    });
    li.append(copy, text, label);
    return li;
  };
  const main = s.urls.filter((u) => !u.virtual);
  const virtual = s.urls.filter((u) => u.virtual);
  $('stream-urls').replaceChildren(...(main.length ? main : virtual.slice(0, 1)).map(urlItem));
  const folded = main.length ? virtual : virtual.slice(1);
  $('stream-more').hidden = folded.length === 0;
  $('stream-more-label').textContent = t('stream.more').replace('{n}', folded.length);
  $('stream-urls-virtual').replaceChildren(...folded.map(urlItem));
  if (s.qr) $('stream-qr').src = s.qr;
  renderStreamCode();
  renderDevices();
  renderHealth();
}

// The video watchdog (stream-server.js): the last problem it fixed, else
// when a viewer last reported that all was fine.
function renderHealth() {
  const h = state?.stream?.health;
  $('stream-health-row').hidden = !h;
  if (!h) return;
  const time = (at) => new Date(at).toLocaleTimeString(document.documentElement.lang, { hour: '2-digit', minute: '2-digit' });
  let text = t('stream.health.none');
  const recentProblem = h.problem && (!h.okAt || h.problem.at > h.okAt - 10 * 60_000);
  if (recentProblem) {
    text = t('stream.health.problem')
      .replace('{time}', time(h.problem.at))
      .replace('{what}', t(`stream.health.${h.problem.what}`))
      .replace('{fix}', t(`stream.health.${h.problem.fix}`));
  } else if (h.okAt) {
    text = t('stream.health.ok').replace('{time}', time(h.reportAt || h.okAt));
  }
  $('stream-health').textContent = text;
  $('stream-health').classList.toggle('accent', Boolean(recentProblem));
}

// Devices waiting on the stream's sign-in page: invite one, and it must pick
// the number shown here.
function renderDevices() {
  const devices = state?.stream?.devices || [];
  $('stream-devices-none').hidden = devices.length > 0;
  $('stream-devices').replaceChildren(
    ...devices.map((d) => {
      const li = document.createElement('li');
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = d.device;
      const ip = document.createElement('span');
      ip.className = 'ip';
      ip.textContent = ` ${d.address}`;
      who.append(ip);
      li.append(who);
      if (d.invite) {
        const number = document.createElement('span');
        number.className = 'number';
        number.textContent = String(d.invite.number);
        number.title = t('stream.pair.number');
        const left = document.createElement('span');
        left.className = 'value';
        left.textContent = `${Math.max(0, Math.ceil((d.invite.expiresAt - Date.now()) / 1000))} ${t('stream.pair.seconds')}`;
        const cancel = document.createElement('button');
        cancel.className = 'bordered';
        cancel.textContent = t('stream.pair.cancel');
        cancel.addEventListener('click', () => action('stream-invite-cancel', d.id));
        li.append(number, left, cancel);
      } else {
        const invite = document.createElement('button');
        invite.className = 'bordered';
        invite.textContent = t('stream.pair.invite');
        invite.addEventListener('click', () => action('stream-invite', d.id));
        li.append(invite);
      }
      return li;
    }),
  );
}

// The sign-in code changes every 2 minutes (main pushes the new one); the
// countdown ticks here.
function renderStreamCode() {
  const code = state?.stream?.code;
  $('stream-code').textContent = code ? `${code.value.slice(0, 3)} ${code.value.slice(3)}` : '';
  const left = code ? Math.max(0, Math.ceil((code.expiresAt - Date.now()) / 1000)) : 0;
  $('stream-code-left').textContent = code ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : '';
}
setInterval(() => {
  if (state?.stream?.code) renderStreamCode();
  if (state?.stream?.devices?.some((d) => d.invite)) renderDevices();
}, 1000);

// --- Shortcuts -----------------------------------------------------------------
// "Change" records the next combination. Keys come from event.code, so they
// do not depend on the keyboard layout (a Cyrillic layout still gives "S").
// Global shortcuts are paused meanwhile, or pressing one would trigger it.

let recording = null; // Id being recorded.
const shortcutNotes = {}; // id → { text, error } shown under a row.

const CODE_KEYS = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', Delete: 'Delete', Space: 'Space',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'",
  Comma: ',', Period: '.', Slash: '/', Backquote: '`',
};

function keyFromCode(code) {
  let m;
  if ((m = code.match(/^Key([A-Z])$/))) return m[1];
  if ((m = code.match(/^Digit([0-9])$/))) return m[1];
  if ((m = code.match(/^Numpad([0-9])$/))) return `num${m[1]}`;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return CODE_KEYS[code] || null;
}

function accelerator(event) {
  const key = keyFromCode(event.code);
  if (!key) return null;
  const mods = [];
  if (event.ctrlKey) mods.push('Control');
  if (event.altKey) mods.push('Alt');
  if (event.shiftKey) mods.push('Shift');
  if (event.metaKey) mods.push('Super');
  return [...mods, key].join('+');
}

function stopRecording() {
  if (!recording) return;
  recording = null;
  overlay.send('ui:shortcuts-pause', false);
  renderShortcuts();
}

function startRecording(id) {
  stopRecording();
  recording = id;
  delete shortcutNotes[id];
  overlay.send('ui:shortcuts-pause', true);
  renderShortcuts();
}

async function saveShortcut(id, value) {
  const result = await overlay.invoke('ui:shortcut-set', { id, accelerator: value });
  if (!result.ok) {
    const text =
      result.error === 'conflict'
        ? t('settings.shortcuts.conflict').replace('{action}', t(`shortcut.${result.with}`))
        : t('settings.shortcuts.invalid');
    shortcutNotes[id] = { text, error: true };
    renderShortcuts();
    return false;
  }
  delete shortcutNotes[id];
  return true;
}

document.addEventListener(
  'keydown',
  async (event) => {
    if (!recording) return;
    event.preventDefault();
    event.stopPropagation();
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return; // Wait for the main key.
    if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      stopRecording();
      return;
    }
    const id = recording;
    const value = accelerator(event);
    if (!value) return;
    stopRecording();
    await saveShortcut(id, value);
  },
  true,
);
window.addEventListener('blur', stopRecording);
window.addEventListener('beforeunload', stopRecording);

function renderShortcuts() {
  const rows = state?.shortcuts || [];
  $('shortcuts').replaceChildren(
    ...rows.map((row) => {
      const tr = document.createElement('tr');
      const name = document.createElement('td');
      name.textContent = t(`shortcut.${row.id}`);
      const keys = document.createElement('td');
      keys.className = 'keys';
      const kbd = document.createElement('kbd');
      if (recording === row.id) {
        kbd.className = 'recording';
        kbd.textContent = t('settings.shortcuts.recording');
      } else if (!row.accelerator) {
        kbd.className = 'off';
        kbd.textContent = t('settings.shortcuts.off');
      } else {
        kbd.textContent = keyLabel(row.accelerator);
      }
      keys.append(kbd);
      const note = shortcutNotes[row.id] || (row.failed && row.accelerator ? { text: t('settings.shortcuts.failed'), error: true } : null);
      if (note) {
        const small = document.createElement('span');
        small.className = `note${note.error ? ' error' : ''}`;
        small.textContent = note.text;
        keys.append(small);
      }
      const actions = document.createElement('td');
      actions.className = 'actions';
      const change = document.createElement('button');
      change.className = 'bordered';
      change.textContent = t('settings.shortcuts.change');
      change.addEventListener('click', () => (recording === row.id ? stopRecording() : startRecording(row.id)));
      const off = iconButton('ban', t('settings.shortcuts.disable'), () => saveShortcut(row.id, ''));
      off.disabled = !row.accelerator;
      const reset = iconButton('undo', t('settings.shortcuts.reset'), () => {
        delete shortcutNotes[row.id];
        overlay.send('ui:shortcut-reset', row.id);
      });
      reset.disabled = row.isDefault;
      actions.append(change, off, reset);
      tr.append(name, keys, actions);
      return tr;
    }),
  );
}

$('shortcuts-reset-all').addEventListener('click', () => {
  for (const key of Object.keys(shortcutNotes)) delete shortcutNotes[key];
  overlay.send('ui:shortcut-reset', null);
});

// --- Locations: adding ----------------------------------------------------------

function setLocationStatus(text, isError = false) {
  $('location-status').textContent = text;
  $('location-status').classList.toggle('error', isError);
}

async function addLocation(place) {
  setLocationStatus(t('menu.locations.adding'));
  try {
    await overlay.invoke('ui:location-add', place);
    $('location-query').value = '';
    results = [];
    renderResults();
    setLocationStatus('');
  } catch (error) {
    setLocationStatus(searchErrorText(error), true);
  }
}

// The query the current results came from: it names the added location.
let resultsQuery = '';

function renderResults() {
  $('results').replaceChildren(
    ...results.map((place) => {
      const li = document.createElement('li');
      li.textContent = place.label;
      li.addEventListener('click', () => addLocation({ ...place, name: resultsQuery }));
      return li;
    }),
  );
}

$('location-query').addEventListener('keydown', async (event) => {
  if (event.key !== 'Enter') return;
  const text = event.target.value.trim();
  if (!text) return;
  setLocationStatus(t('search.searching'));
  try {
    results = await overlay.invoke('ui:search-query', text);
    resultsQuery = text;
    setLocationStatus(results.length ? t('menu.locations.pick') : t('search.nothing'));
    // Coordinates are one exact point: add it directly.
    if (results.length === 1 && !results[0].bbox) await addLocation(results[0]);
    else renderResults();
  } catch (error) {
    setLocationStatus(searchErrorText(error), true);
  }
});

$('add-center').addEventListener('click', async () => {
  setLocationStatus(t('menu.locations.adding'));
  try {
    const added = await overlay.invoke('ui:location-add-center');
    setLocationStatus(added ? '' : t('menu.locations.noMap'), !added);
  } catch (error) {
    setLocationStatus(error.message, true);
  }
});

// --- Controls ------------------------------------------------------------------

$('targets-only').addEventListener('click', () => set('targetsOnly', true));
$('full-page').addEventListener('click', () => set('targetsOnly', false));
$('opacity').addEventListener('input', (event) => set('opacity', Number(event.target.value) / 100));
$('reload').addEventListener('click', () => action('reload'));
for (const button of $('theme').children) button.addEventListener('click', () => set('theme', button.dataset.theme));
for (const button of $('lang').children) button.addEventListener('click', () => set('lang', button.dataset.lang));
$('alerts-enabled').addEventListener('click', () => set('alertsEnabled', !state.alerts.enabled));
$('radius').addEventListener('change', (event) => {
  const value = Math.round(Number(event.target.value));
  if (value >= 1 && value <= 500) set('alertRadiusKm', value);
  else event.target.value = state.alerts.radiusKm;
});
$('alerts-test').addEventListener('click', async () => {
  const shown = await overlay.invoke('ui:alerts-test');
  $('alerts-status').textContent = t(shown ? 'menu.alerts.testSent' : 'menu.alerts.unsupported');
});
$('close-to-tray').addEventListener('click', () => set('closeToTray', !state.closeToTray));
for (const button of $('follow').children) button.addEventListener('click', () => set('follow', button.dataset.value));
$('quiet-enabled').addEventListener('click', () => set('quiet', { enabled: !state.quiet?.enabled }));
$('quiet-from').addEventListener('change', (event) => set('quiet', { from: event.target.value }));
$('quiet-to').addEventListener('change', (event) => set('quiet', { to: event.target.value }));
for (const button of $('fps').children) button.addEventListener('click', () => set('fpsLimit', Number(button.dataset.fps)));
$('show-notice').addEventListener('click', () => overlay.send('ui:notice-open'));
$('open-logs').addEventListener('click', () => action('open-logs'));
$('update-check').addEventListener('click', () => action('update-check'));
$('update-enabled').addEventListener('click', () => set('updateCheck', !state.updateCheck));
$('stream-enabled').addEventListener('click', () => set('streamEnabled', !state.stream.enabled));
for (const [id, key] of [['stream-area', 'streamArea'], ['stream-layers', 'streamLayers'], ['stream-quality', 'streamQuality']]) {
  for (const button of $(id).children) button.addEventListener('click', () => set(key, button.dataset.value));
}
$('stream-new-link').addEventListener('click', () => action('stream-new-link'));
$('stream-port').addEventListener('change', (event) => {
  const port = Math.round(Number(event.target.value));
  if (port >= 1024 && port <= 65535) set('streamPort', port);
  else event.target.value = state.stream.port;
});
// Links open in the system browser, never in an app window.
document.addEventListener('click', (event) => {
  const link = event.target.closest('a[href]');
  if (!link) return;
  event.preventDefault();
  overlay.send('ui:open-external', link.href);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !recording && !event.target.matches('input')) overlay.send('ui:settings-close');
});

overlay.on('ui:state', (next) => {
  state = next;
  render();
});
onLangChange(render);
overlay.send('ui:toolbar-ready');
