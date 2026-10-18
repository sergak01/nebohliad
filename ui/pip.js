'use strict';

const canvas = document.getElementById('view');
const ctx = canvas.getContext('2d');
const stale = document.getElementById('stale');
const STALE_AFTER_MS = 5000;

let lastFrame = null;
let lastFrameAt = 0;

function decode(bytes) {
  return bytes ? createImageBitmap(new Blob([bytes])) : null;
}

function draw() {
  if (!lastFrame) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * ratio);
  canvas.height = Math.round(canvas.clientHeight * ratio);
  ctx.imageSmoothingQuality = 'high';
  ctx.globalAlpha = 1;
  ctx.drawImage(lastFrame.bottom, 0, 0, canvas.width, canvas.height);
  if (lastFrame.top) {
    ctx.globalAlpha = lastFrame.opacity;
    ctx.drawImage(lastFrame.top, 0, 0, canvas.width, canvas.height);
  }
  drawAttribution(ratio);
}

// Map data attribution on every frame (OSM / OpenMapTiles require it).
const ATTRIBUTION = '© OpenStreetMap contributors · © OpenMapTiles';

function drawAttribution(ratio) {
  ctx.globalAlpha = 1;
  ctx.font = `${Math.round(10 * ratio)}px "Segoe UI", system-ui, sans-serif`;
  const pad = Math.round(3 * ratio);
  const width = ctx.measureText(ATTRIBUTION).width + 2 * pad;
  const height = Math.round(14 * ratio);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
  ctx.fillRect(canvas.width - width, canvas.height - height, width, height);
  ctx.fillStyle = '#1d2026';
  ctx.textBaseline = 'middle';
  ctx.fillText(ATTRIBUTION, canvas.width - width + pad, canvas.height - height / 2);
}

overlay.on('ui:pip-frame', async (frame) => {
  const [bottom, top] = await Promise.all([decode(frame.bottom), decode(frame.top)]);
  lastFrame?.bottom.close();
  lastFrame?.top?.close();
  lastFrame = { bottom, top, opacity: frame.opacity };
  lastFrameAt = Date.now();
  draw();
});

new ResizeObserver(draw).observe(canvas);

setInterval(() => {
  stale.style.display = lastFrameAt && Date.now() - lastFrameAt > STALE_AFTER_MS ? 'block' : 'none';
}, 1000);

document.getElementById('close').addEventListener('click', () => overlay.send('ui:pip-close'));
document.getElementById('show-main').addEventListener('click', () => overlay.send('ui:pip-show-main'));
