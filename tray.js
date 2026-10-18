'use strict';

// System tray. With "close to tray" on, closing the main window only hides
// it: the pages keep running (their document stays 'visible', and
// background throttling is off), so alerts and PiP keep working. The icon turns red while
// targets are within the alert radius of a location.

const path = require('path');
const { Tray, Menu, nativeImage } = require('electron');

const TOOLTIP_MAX = 127; // Windows truncates longer tray tooltips.

const STRINGS = {
  uk: {
    appName: 'Небогляд',
    show: 'Показати вікно',
    hide: 'Сховати в трей',
    home: 'Основна локація',
    pip: 'PiP — винести область',
    settings: 'Налаштування…',
    alerts: 'Сповіщення про цілі',
    closeToTray: 'Закриття ховає в трей',
    stream: (n) => `Трансляція в мережу${n ? ` (дивляться: ${n})` : ''}`,
    quit: 'Вийти',
    nearby: (n) => `⚠ ${n} поблизу`,
    km: 'км',
    hiddenTitle: 'Небогляд працює в треї',
    hiddenBody: 'Сповіщення та PiP працюють далі. Клік по іконці — показати вікно; «Вийти» — у меню іконки.',
  },
  en: {
    appName: 'Nebohliad',
    show: 'Show window',
    hide: 'Hide to tray',
    home: 'Primary location',
    pip: 'PiP: pop out an area',
    settings: 'Settings…',
    alerts: 'Target alerts',
    closeToTray: 'Close hides to tray',
    stream: (n) => `LAN stream${n ? ` (${n} watching)` : ''}`,
    quit: 'Quit',
    nearby: (n) => `⚠ ${n} nearby`,
    km: 'km',
    hiddenTitle: 'Nebohliad keeps running in the tray',
    hiddenBody: 'Alerts and PiP keep working. Click the icon to show the window; Quit is in its menu.',
  },
};

function loadIcon(name) {
  // Picks up name@2x.png too, for high-DPI tray sizes.
  return nativeImage.createFromPath(path.join(__dirname, 'assets', `${name}.png`));
}

// `actions`: { toggleMain, home, pip, settings, setAlerts, setCloseToTray, setStream, quit }.
function setupTray(actions) {
  const icons = { normal: loadIcon('tray'), alert: loadIcon('tray-alert') };
  const tray = new Tray(icons.normal);
  tray.setToolTip(STRINGS.uk.appName);
  tray.on('click', () => actions.toggleMain());
  let lang = 'uk';

  // `state`: { lang, visible, hasPrimary, alertsEnabled, closeToTray,
  // streamEnabled, streamViewers, nearby }.
  function update(state) {
    lang = state.lang;
    const s = STRINGS[lang] || STRINGS.uk;
    const nearby = state.nearby || [];
    tray.setImage(nearby.length ? icons.alert : icons.normal);
    const details = nearby.slice(0, 3).map((n) => `${n.location} ~${n.km} ${s.km}`);
    const tooltip = nearby.length ? `${s.appName} · ${s.nearby(nearby.length)}\n${details.join('\n')}` : s.appName;
    tray.setToolTip(tooltip.slice(0, TOOLTIP_MAX));
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: state.visible ? s.hide : s.show, click: () => actions.toggleMain() },
        { label: s.home, enabled: state.hasPrimary, click: () => actions.home() },
        { label: s.pip, click: () => actions.pip() },
        { label: s.settings, click: () => actions.settings() },
        { type: 'separator' },
        { label: s.alerts, type: 'checkbox', checked: state.alertsEnabled, click: (item) => actions.setAlerts(item.checked) },
        { label: s.stream(state.streamViewers), type: 'checkbox', checked: state.streamEnabled, click: (item) => actions.setStream(item.checked) },
        { label: s.closeToTray, type: 'checkbox', checked: state.closeToTray, click: (item) => actions.setCloseToTray(item.checked) },
        { type: 'separator' },
        { label: s.quit, click: () => actions.quit() },
      ]),
    );
  }

  // Shown the first time the window goes to the tray in a session.
  function announceHidden() {
    const s = STRINGS[lang] || STRINGS.uk;
    tray.displayBalloon({ title: s.hiddenTitle, content: s.hiddenBody, iconType: 'info' });
  }

  return { update, announceHidden, destroy: () => tray.destroy() };
}

module.exports = { setupTray };
