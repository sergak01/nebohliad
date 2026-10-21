'use strict';

// The "⋯" menu. Each item does one thing and closes the menu, except the two
// switches (alerts, stream), which stay open to show their new state.

const $ = (id) => document.getElementById(id);
const set = (key, value) => overlay.send('ui:toolbar-set', { key, value });
const action = (name, data) => overlay.send('ui:toolbar-action', { name, data });
const close = () => overlay.send('ui:menu-close');

let state = null;

new ResizeObserver(() => overlay.send('ui:menu-height', $('box').getBoundingClientRect().height)).observe($('box'));

// A display-only switch inside a menu item (the item itself is the button).
for (const holder of document.querySelectorAll('.switch-holder')) {
  const knob = document.createElement('span');
  knob.className = 'switch';
  knob.setAttribute('aria-hidden', 'true');
  holder.replaceWith(knob);
}

function render() {
  for (const el of document.querySelectorAll('[data-shortcut]')) el.textContent = shortcutLabel(el.dataset.shortcut);
  if (!state) return;
  const s = state.stream;
  $('alerts').setAttribute('aria-checked', String(state.alerts.enabled));
  $('alerts').querySelector('.switch').setAttribute('aria-checked', String(state.alerts.enabled));
  $('stream').setAttribute('aria-checked', String(s.enabled));
  $('stream').querySelector('.switch').setAttribute('aria-checked', String(s.enabled));
  $('stream-label').textContent = s.running && s.viewers ? `${t('menu.streamToggle')} · ${s.viewers}` : t('menu.streamToggle');
  $('copy-link').disabled = !(s.running && s.urls.length);
  $('about-update').hidden = !state.update?.attention;
}

$('settings').addEventListener('click', () => {
  action('settings');
  close();
});
$('alerts').addEventListener('click', () => set('alertsEnabled', !state.alerts.enabled));
$('stream').addEventListener('click', () => set('streamEnabled', !state.stream.enabled));
$('copy-link').addEventListener('click', () => {
  action('copy', state.stream.urls[0]?.url);
  close();
});
$('reload').addEventListener('click', () => {
  action('reload');
  close();
});
$('notice').addEventListener('click', () => {
  overlay.send('ui:notice-open');
  close();
});
$('about').addEventListener('click', () => {
  action('settings', 'about');
  close();
});
$('quit').addEventListener('click', () => action('quit'));

// Keyboard: arrows move between items, Enter/Space activate, Esc closes.
const items = () => [...document.querySelectorAll('.item')].filter((item) => !item.disabled);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') return close();
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return undefined;
  event.preventDefault();
  const list = items();
  const index = list.indexOf(document.activeElement);
  const next = event.key === 'ArrowDown' ? index + 1 : index - 1;
  list[(next + list.length) % list.length]?.focus();
  return undefined;
});
overlay.on('ui:menu-opened', () => items()[0]?.focus());

overlay.on('ui:state', (next) => {
  state = next;
  render();
});
onLangChange(render);
overlay.send('ui:toolbar-ready');
