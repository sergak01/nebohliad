'use strict';

const box = document.getElementById('rect');
let start = null;

function rectFrom(event) {
  const x = Math.min(start.x, event.clientX);
  const y = Math.min(start.y, event.clientY);
  return { x, y, width: Math.abs(event.clientX - start.x), height: Math.abs(event.clientY - start.y) };
}

window.addEventListener('mousedown', (event) => {
  if (event.button !== 0) return;
  start = { x: event.clientX, y: event.clientY };
  document.body.style.background = 'transparent';
  Object.assign(box.style, { display: 'block', left: `${start.x}px`, top: `${start.y}px`, width: '0', height: '0' });
});

window.addEventListener('mousemove', (event) => {
  if (!start) return;
  const r = rectFrom(event);
  Object.assign(box.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
});

window.addEventListener('mouseup', (event) => {
  if (!start || event.button !== 0) return;
  overlay.send('ui:select-done', rectFrom(event));
  start = null;
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') overlay.send('ui:select-cancel');
});
