'use strict';

// Global keyboard shortcuts, changeable in Settings → Shortcuts.
// settings.shortcuts holds only the changes: { id: accelerator }, where ''
// means "off"; anything missing uses the default. While the settings window
// records a new combination, all shortcuts are paused, so pressing one does
// not trigger it.

const { globalShortcut } = require('electron');
const log = require('./logger');

// In the order of the settings table.
const SHORTCUTS = [
  { id: 'settings', key: 'Control+Alt+S' },
  { id: 'search', key: 'Control+Alt+F' },
  { id: 'home', key: 'Control+Alt+Home' },
  { id: 'pip', key: 'Control+Alt+P' },
  { id: 'swapBase', key: 'Control+Alt+B' },
  { id: 'topLayer', key: 'Control+Alt+H' },
  { id: 'interact', key: 'Control+Alt+T' },
  { id: 'targetsOnly', key: 'Control+Alt+M' },
  { id: 'mapOnly', key: 'Control+Alt+U' },
  { id: 'opacityUp', key: 'Control+Alt+Up' },
  { id: 'opacityDown', key: 'Control+Alt+Down' },
  { id: 'reload', key: 'Control+Alt+R' },
];
const IDS = SHORTCUTS.map((s) => s.id);
const MODIFIERS = ['Control', 'Alt', 'Shift', 'Super'];
const KEY = /^([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Up|Down|Left|Right|Home|End|PageUp|PageDown|Insert|Delete|Space|num[0-9]|[-=[\];',./`\\])$/;
const PAUSE_LIMIT_MS = 30_000; // Recording never leaves the shortcuts off for long.

// "Control+Alt+S" with modifiers in a fixed order, or null if not allowed.
// Without Control, Alt or Super only F-keys are allowed (Shift+letter would
// take a letter away from typing everywhere).
function normalize(accelerator) {
  if (accelerator === '') return '';
  if (typeof accelerator !== 'string') return null;
  const parts = accelerator.split('+');
  const key = parts.pop();
  if (!KEY.test(key) || parts.some((p) => !MODIFIERS.includes(p)) || new Set(parts).size !== parts.length) return null;
  const strong = parts.some((p) => p !== 'Shift');
  if (!strong && !/^F\d+$/.test(key)) return null;
  return [...MODIFIERS.filter((m) => parts.includes(m)), key].join('+');
}

function setupShortcuts(settings, handlers, onChange) {
  let failed = new Set(); // Ids whose combination another program holds.
  let paused = false;
  let pauseTimer = null;

  const current = (id) => {
    const saved = settings.shortcuts?.[id];
    return typeof saved === 'string' ? saved : SHORTCUTS.find((s) => s.id === id).key;
  };

  function register() {
    globalShortcut.unregisterAll();
    failed = new Set();
    if (paused) return;
    for (const id of IDS) {
      const accelerator = current(id);
      if (!accelerator) continue;
      try {
        if (!globalShortcut.register(accelerator, handlers[id])) failed.add(id);
      } catch {
        failed.add(id);
      }
    }
    if (failed.size) log.warn('shortcuts', 'taken by other programs', [...failed].join(', '));
  }

  function changed() {
    register();
    onChange();
  }

  // → { ok: true } or { ok: false, error: 'invalid' | 'conflict', with: id }.
  function set(id, accelerator) {
    if (!IDS.includes(id)) return { ok: false, error: 'invalid' };
    const value = normalize(accelerator);
    if (value === null) return { ok: false, error: 'invalid' };
    const other = value && IDS.find((o) => o !== id && current(o) === value);
    if (other) return { ok: false, error: 'conflict', with: other };
    settings.shortcuts = { ...settings.shortcuts };
    if (value === SHORTCUTS.find((s) => s.id === id).key) delete settings.shortcuts[id];
    else settings.shortcuts[id] = value;
    changed();
    return { ok: true, failed: failed.has(id) };
  }

  // One shortcut, or all when id is omitted. A default that another
  // shortcut now uses is not restored over it.
  function reset(id) {
    const ids = id ? [id] : IDS;
    settings.shortcuts = { ...settings.shortcuts };
    for (const one of ids) {
      const key = SHORTCUTS.find((s) => s.id === one)?.key;
      if (!key) continue;
      delete settings.shortcuts[one];
      const clash = IDS.find((o) => o !== one && current(o) === key);
      if (clash && settings.shortcuts[clash]) settings.shortcuts[one] = ''; // The clash is a custom one.
    }
    if (!id) settings.shortcuts = {};
    changed();
  }

  function pause(on) {
    clearTimeout(pauseTimer);
    paused = Boolean(on);
    if (paused) pauseTimer = setTimeout(() => pause(false), PAUSE_LIMIT_MS);
    register();
  }

  // For the settings table: [{ id, accelerator, isDefault, failed }].
  function list() {
    return SHORTCUTS.map(({ id, key }) => ({ id, accelerator: current(id), isDefault: current(id) === key, failed: failed.has(id) }));
  }

  // { id: accelerator } for tooltips and menu labels ('' = off).
  function labels() {
    return Object.fromEntries(IDS.map((id) => [id, current(id)]));
  }

  return { register, set, reset, pause, list, labels, unregisterAll: () => globalShortcut.unregisterAll() };
}

module.exports = { setupShortcuts, normalize, SHORTCUTS };
