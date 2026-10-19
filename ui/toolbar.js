'use strict';

const $ = (id) => document.getElementById(id);
const set = (key, value) => overlay.send('ui:toolbar-set', { key, value });
const action = (name, data) => overlay.send('ui:toolbar-action', { name, data });

let state = null;

function render() {
  if (!state) return;
  const base = $('base');
  base.replaceChildren(
    ...state.sites.map((site) => {
      const button = document.createElement('button');
      button.textContent = t(`site.${site.id}`);
      button.title = t(`site.${site.id}.title`);
      button.classList.toggle('active', site.id === state.base);
      button.addEventListener('click', () => set('base', site.id));
      return button;
    }),
  );
  $('top-shown').title = t('toolbar.layer.title').replace('{site}', t(`site.${state.overlay}`));
  $('top-shown').classList.toggle('active', state.topShown);
  $('interact').classList.toggle('active', !state.clickThrough);
  $('interact').disabled = !state.topShown;
  $('map-only').classList.toggle('active', state.hudHidden);
  $('home').disabled = !state.hasPrimary;
  // The sites' own notices (their target data paused and the like).
  const notices = state.siteNotices || [];
  $('site-notice').hidden = notices.length === 0;
  if (notices.length) {
    $('site-notice-text').textContent = notices.map((n) => `${t(`site.${n.site}`)}: ${n.text}`).join(' · ');
    $('site-notice').title = `${t('toolbar.siteNotice.title')}\n\n${notices.map((n) => `${t(`site.${n.site}`)}: ${n.text}`).join('\n')}`;
  }
  const updateReady =['behind', 'diverged'].includes(state.update?.status);
  $('menu').classList.toggle('has-update', updateReady);
  $('menu').title = updateReady ? `${t('toolbar.menu.title')} · ${t('update.badge')}` : t('toolbar.menu.title');
  $('home').title = t(state.hasPrimary ? 'toolbar.home.title' : 'toolbar.home.none');
  renderNearby();
}

function renderNearby() {
  const nearby = state.nearby || [];
  $('nearby').hidden = nearby.length === 0;
  if (!nearby.length) return;
  $('nearby-count').textContent = String(nearby.length);
  $('nearby').title = nearby
    .slice(0, 8)
    .map((n) => `${n.location}: ${t(`kind.${n.kind}`)} ~${n.km} ${t('menu.km')} (${t(`site.${n.site}`)})`)
    .join('\n');
}

$('top-shown').addEventListener('click', () => set('topShown', !state.topShown));
$('interact').addEventListener('click', () => set('clickThrough', !state.clickThrough));
$('map-only').addEventListener('click', () => set('hudHidden', !state.hudHidden));
$('home').addEventListener('click', () => action('home'));
$('nearby').addEventListener('click', () => action('show-location', state.nearby[0]?.locationId));
$('search').addEventListener('click', () => action('search'));
$('pip').addEventListener('click', () => action('pip'));
$('menu').addEventListener('click', () => {
  const { x, y, width, height } = $('menu').getBoundingClientRect();
  action('menu', { x, y, width, height });
});

overlay.on('ui:state', (next) => {
  state = next;
  render();
});
onLangChange(render);
overlay.send('ui:toolbar-ready');
