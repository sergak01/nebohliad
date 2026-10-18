'use strict';

const box = document.getElementById('box');
const confirmButton = document.getElementById('confirm');
let confirmed = false;

new ResizeObserver(() => overlay.send('ui:notice-height', box.getBoundingClientRect().height)).observe(box);

function render() {
  confirmButton.textContent = t(confirmed ? 'notice.close' : 'notice.confirm');
  for (const button of document.getElementById('lang').children) {
    button.classList.toggle('active', button.dataset.lang === document.documentElement.lang);
  }
}

confirmButton.addEventListener('click', () => overlay.send(confirmed ? 'ui:notice-close' : 'ui:notice-confirm'));
for (const button of document.getElementById('lang').children) {
  button.addEventListener('click', () => overlay.send('ui:toolbar-set', { key: 'lang', value: button.dataset.lang }));
}
// Esc closes only an already confirmed notice; the first one needs the button.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && confirmed) overlay.send('ui:notice-close');
});

onLangChange(render);
overlay.invoke('ui:notice-state').then((state) => {
  confirmed = state.confirmed;
  render();
});
