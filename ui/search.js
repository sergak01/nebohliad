'use strict';

const input = document.getElementById('q');
const status = document.getElementById('status');
const list = document.getElementById('results');
const clearPin = document.getElementById('clear-pin');

let items = [];
let selected = -1;
// The text the current results belong to; Enter on unchanged text picks.
let resultsFor = null;
let history = [];

function reportHeight() {
  overlay.send('ui:search-height', document.getElementById('box').getBoundingClientRect().height);
}
new ResizeObserver(reportHeight).observe(document.getElementById('box'));

function setStatus(text, isError = false) {
  status.textContent = text;
  status.classList.toggle('error', isError);
}

function render(newItems, kind) {
  items = newItems;
  selected = items.length ? 0 : -1;
  list.replaceChildren(
    ...items.map((item, index) => {
      const li = document.createElement('li');
      const icon = document.createElement('span');
      icon.className = 'kind';
      icon.textContent = kind === 'history' ? '↺' : '•';
      const label = document.createElement('span');
      label.textContent = item.label;
      li.append(icon, label);
      li.addEventListener('mousedown', (event) => {
        event.preventDefault();
        pick(index);
      });
      return li;
    }),
  );
  highlight();
}

function highlight() {
  [...list.children].forEach((li, index) => li.classList.toggle('selected', index === selected));
  list.children[selected]?.scrollIntoView({ block: 'nearest' });
}

function pick(index) {
  const item = items[index];
  if (item) overlay.send('ui:search-pick', item);
}

async function runSearch(text) {
  setStatus(t('search.searching'));
  try {
    const results = await overlay.invoke('ui:search-query', text);
    if (input.value.trim() !== text) return; // Typed on meanwhile.
    resultsFor = text;
    render(results, 'results');
    setStatus(results.length ? '' : t('search.nothing'));
    // Coordinates resolve to one exact point: go straight there.
    if (results.length === 1 && !results[0].bbox) pick(0);
  } catch (error) {
    setStatus(searchErrorText(error), true);
  }
}

input.addEventListener('input', () => {
  resultsFor = null;
  setStatus('');
  if (input.value.trim() === '') render(history, 'history');
});

input.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    overlay.send('ui:search-close');
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!items.length) return;
    selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    highlight();
  } else if (event.key === 'Enter') {
    const text = input.value.trim();
    if (text === '' || text === resultsFor) pick(selected);
    else runSearch(text);
  }
});

clearPin.addEventListener('click', () => overlay.send('ui:search-clear-pin'));

overlay.on('ui:search-open', (state) => {
  history = state.history;
  clearPin.hidden = !state.hasPin;
  input.value = '';
  resultsFor = null;
  setStatus('');
  render(history, 'history');
  input.focus();
});
