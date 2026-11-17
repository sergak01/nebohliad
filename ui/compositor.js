'use strict';

// Hidden window for the LAN stream (stream-server.js):
// - blends the base and top captures like PiP does, scales to the stream
//   width, draws the map data attribution and an alert banner;
// - returns a JPEG when MJPEG viewers or snapshots need one;
// - is the WebRTC sender: the canvas itself is the video track
//   (captureStream, one frame per composed image), one peer per viewer.
//
// The frame is drawn with WebGL: each layer is one texture that a new
// capture overwrites. A 2D canvas drawing the captures with drawImage made
// Chromium keep every one of them (8 MB at 1906×1100) in the GPU process
// until its image caches were full: about 450 MB more there while someone
// watched (measured 2026-11-17).

const canvas = document.createElement('canvas');
canvas.width = 1280;
canvas.height = 720;
document.body.appendChild(canvas); // Captured canvases are kept in the DOM.
// preserveDrawingBuffer: the picture must still be there when the video
// track and toDataURL read it.
const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true });
const BACKGROUND = [0x11 / 255, 0x13 / 255, 0x18 / 255];
const ATTRIBUTION = '© OpenStreetMap contributors · © OpenMapTiles';

const stream = canvas.captureStream(0);
const [track] = stream.getVideoTracks();
// A map with small labels: keep resolution, let the frame rate drop instead
// (WebRTC's default for camera-like video is the opposite).
track.contentHint = 'detail';
const MAX_BITRATE = 3_000_000;
const peers = new Set();

// --- Drawing -------------------------------------------------------------------

// A rectangle of the picture (pixels, y down) filled with a texture whose
// first row is its top. Colors are premultiplied by alpha everywhere.
const VERTEX_SHADER = `#version 300 es
in vec2 corner;
uniform vec4 rect; // left, top (clip space), width, height
out vec2 uv;
void main() {
  uv = corner;
  gl_Position = vec4(rect.x + corner.x * rect.z, rect.y - corner.y * rect.w, 0.0, 1.0);
}`;

// Four samples around the pixel's center (each one already the mean of 2×2
// texels): a picture scaled down to a half or a third stays smooth, as
// imageSmoothingQuality 'high' kept it. `spread` is how far apart they are:
// nothing for a picture drawn at its own size (small labels stay sharp), a
// whole pixel of the result from a scale of one half down.
const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D image;
uniform float alpha;
uniform vec2 spread;
out vec4 color;
void main() {
  vec4 sum = texture(image, uv + spread * vec2(0.125, 0.375)) + texture(image, uv + spread * vec2(-0.375, 0.125))
    + texture(image, uv + spread * vec2(0.375, -0.125)) + texture(image, uv + spread * vec2(-0.125, -0.375));
  color = sum * (0.25 * alpha);
}`;

function compileShader(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(shader)}`);
  return shader;
}

function newTexture() {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  // width 0: nothing uploaded yet.
  return { texture, width: 0, height: 0 };
}

// Everything that lives in the GL context; made again when the context comes
// back after a loss (the textures, and so the kept layers, are gone then).
function newScene() {
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl.VERTEX_SHADER, VERTEX_SHADER));
  gl.attachShader(program, compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(program)}`);
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  const corner = gl.getAttribLocation(program, 'corner');
  gl.enableVertexAttribArray(corner);
  gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
  gl.uniform1i(gl.getUniformLocation(program, 'image'), 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  // The strips' 2D canvases; captures are premultiplied when decoded.
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  return {
    rect: gl.getUniformLocation(program, 'rect'),
    alpha: gl.getUniformLocation(program, 'alpha'),
    spread: gl.getUniformLocation(program, 'spread'),
    // The layers of the frame before. Main sends a page's capture again only
    // when the page may have changed (stream-server.js); otherwise it asks
    // to keep the layer, and its texture is drawn as it is.
    layers: { bottom: newTexture(), top: newTexture() },
    strips: { head: newTexture(), foot: newTexture() },
  };
}

let scene = null;
let sceneError = gl ? null : 'WebGL is not available';
function makeScene() {
  try {
    scene = newScene();
    sceneError = null;
  } catch (error) {
    scene = null;
    sceneError = error.message;
  }
}
if (gl) makeScene();

// A lost context usually comes back by itself (a new scene; main sends both
// layers again after the frames that failed meanwhile). One that stays lost
// is reported, and main replaces this window.
const CONTEXT_WAIT_MS = 5000;
canvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  scene = null;
  sceneError = 'the drawing context is lost';
  setTimeout(() => {
    if (!scene) overlay.send('ui:compositor-health', { stalled: true, contextLost: true });
  }, CONTEXT_WAIT_MS);
});
canvas.addEventListener('webglcontextrestored', makeScene);

function upload(target, source, width, height) {
  gl.bindTexture(gl.TEXTURE_2D, target.texture);
  if (target.width === width && target.height === height) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  target.width = width;
  target.height = height;
}

// x, y, width, height: where in the picture (pixels, y down).
function drawTexture(target, x, y, width, height, alpha) {
  const spread = Math.min(1, Math.max(0, target.width / width - 1, target.height / height - 1));
  gl.bindTexture(gl.TEXTURE_2D, target.texture);
  gl.uniform4f(scene.rect, (x / canvas.width) * 2 - 1, 1 - (y / canvas.height) * 2, (width / canvas.width) * 2, (height / canvas.height) * 2);
  gl.uniform1f(scene.alpha, alpha);
  gl.uniform2f(scene.spread, spread / width, spread / height);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

// bytes: a new capture (or null: no such layer now); keep: the one held.
// Returns the layer to draw, or null.
async function layerOf(name, bytes, keep) {
  if (keep) {
    if (!scene?.layers[name].width) throw new Error(`no kept ${name} layer`);
    return scene.layers[name];
  }
  if (!bytes) {
    if (scene) scene.layers[name].width = 0; // Not kept any more (the texture stays for the next capture).
    return null;
  }
  // The decoded bitmap lives only until it is in the texture. Colors are
  // converted as drawImage did (a capture carries the display's color space).
  const bitmap = await createImageBitmap(new Blob([bytes]), { premultiplyAlpha: 'premultiply' });
  try {
    if (!scene) throw new Error(sceneError);
    upload(scene.layers[name], bitmap, bitmap.width, bitmap.height);
    return scene.layers[name];
  } finally {
    bitmap.close();
  }
}

// --- Text strips ---------------------------------------------------------------

// Texts are drawn on two small software 2D canvases, each a strip across the
// picture, uploaded only when what they show changes: `head` at the top (the
// alert banner and a site's notice), `foot` at the bottom (the clock and the
// map data attribution).
function newStrip() {
  const element = document.createElement('canvas');
  return { element, ctx: element.getContext('2d', { willReadFrequently: true }), key: '' };
}
const strips = { head: newStrip(), foot: newStrip() };

// Draws the strip `name` at row `y` of the picture; `paint(ctx, width,
// height)` fills it when `key` (all it depends on) is new.
function drawStrip(name, y, width, height, key, paint) {
  const strip = strips[name];
  const target = scene.strips[name];
  const fullKey = `${width}x${height}|${key}`;
  if (strip.key !== fullKey || !target.width) {
    strip.element.width = width; // Also clears it.
    strip.element.height = height;
    paint(strip.ctx, width, height);
    upload(target, strip.element, width, height);
    strip.key = fullKey;
  }
  drawTexture(target, 0, y, width, height, 1);
}

// A red strip across the top while targets are near a saved location.
const bannerHeight = (scale) => Math.round(30 * scale);

function paintBanner(ctx, text, scale, width) {
  const height = bannerHeight(scale);
  ctx.fillStyle = 'rgba(198, 40, 40, 0.92)';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#ffffff';
  ctx.font = `600 ${Math.round(15 * scale)}px "Segoe UI", system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, Math.round(10 * scale), height / 2, width - Math.round(20 * scale));
}

// An amber strip with a site's own notice (e.g. its targets are paused),
// under the alert banner when there is one.
const noticeHeight = (scale) => Math.round(26 * scale);

function paintNotice(ctx, text, scale, y, width) {
  const height = noticeHeight(scale);
  ctx.fillStyle = 'rgba(245, 179, 1, 0.92)';
  ctx.fillRect(0, y, width, height);
  ctx.fillStyle = '#111318';
  ctx.font = `600 ${Math.round(13 * scale)}px "Segoe UI", system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText(`⏸ ${text}`, Math.round(10 * scale), y + height / 2, width - Math.round(20 * scale));
}

// The PC's time, at the left of the foot strip with its bottom at `bottom`.
const clockHeight = (scale) => Math.max(16, Math.round(20 * scale));

function paintClock(ctx, text, scale, bottom) {
  ctx.font = `600 ${Math.max(11, Math.round(13 * scale))}px "Segoe UI", system-ui, sans-serif`;
  const pad = Math.round(5 * scale);
  const width = ctx.measureText(text).width + 2 * pad;
  const height = clockHeight(scale);
  ctx.fillStyle = 'rgba(17, 19, 24, 0.78)';
  ctx.fillRect(0, bottom - height, width, height);
  ctx.fillStyle = '#e8e9ec';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, pad, bottom - height / 2);
}

// In the bottom-right corner of the foot strip.
function paintAttribution(ctx, scale, stripWidth, stripHeight) {
  ctx.font = `${Math.max(10, Math.round(11 * scale))}px "Segoe UI", system-ui, sans-serif`;
  const pad = Math.round(4 * scale);
  const width = ctx.measureText(ATTRIBUTION).width + 2 * pad;
  const height = Math.max(14, Math.round(16 * scale));
  ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
  ctx.fillRect(stripWidth - width, stripHeight - height, width, height);
  ctx.fillStyle = '#1d2026';
  ctx.textBaseline = 'middle';
  ctx.fillText(ATTRIBUTION, stripWidth - width + pad, stripHeight - height / 2);
}

// Frame marker: a strip of square cells at the bottom-left edge that encodes
// the frame number (seq, 0..255): white, black (to find and check it), then
// 8 bits, highest first. Cell size is width / 160, so the viewer can find it
// at any quality. The viewer reads it back from the video to tell a frozen
// picture from a map that simply does not change (viewer.js).
const MARKER_CELLS_PER_WIDTH = 160;
const markerCell = (width) => Math.max(4, Math.round(width / MARKER_CELLS_PER_WIDTH));

function drawMarker(seq, cell) {
  const bits = [1, 0, ...Array.from({ length: 8 }, (_, i) => (seq >> (7 - i)) & 1)];
  gl.enable(gl.SCISSOR_TEST);
  bits.forEach((bit, i) => {
    gl.scissor(i * cell, 0, cell, cell); // From the bottom-left corner.
    gl.clearColor(bit, bit, bit, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  });
  gl.disable(gl.SCISSOR_TEST);
}

// One frame at a time: frames share the canvas and the kept layers.
let composing = Promise.resolve();
overlay.on('ui:compose', (frame) => {
  composing = composing.then(() => compose(frame));
});

async function compose({ id, bottom, top, keepBottom, keepTop, opacity, maxWidth, quality, attribution, banner, notice, seq, needJpeg }) {
  try {
    if (!scene) throw new Error(sceneError);
    const [base, layer] = await Promise.all([layerOf('bottom', bottom, keepBottom), layerOf('top', top, keepTop)]);
    // Lost while the captures were decoded.
    if (!scene) throw new Error(sceneError);
    const source = base || layer;
    const scale = Math.min(1, maxWidth / source.width);
    // Even sizes: video encoders need them.
    const width = Math.round((source.width * scale) / 2) * 2;
    const height = Math.round((source.height * scale) / 2) * 2;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.clearColor(...BACKGROUND, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (base) drawTexture(base, 0, 0, width, height, 1);
    if (layer) drawTexture(layer, 0, 0, width, height, opacity);

    const uiScale = Math.max(1, width / 1280);
    const cell = markerCell(width);
    const headHeight = (banner ? bannerHeight(uiScale) : 0) + (notice ? noticeHeight(uiScale) : 0);
    if (headHeight) {
      drawStrip('head', 0, width, headHeight, JSON.stringify([uiScale, banner, notice]), (ctx) => {
        if (banner) paintBanner(ctx, banner, uiScale, width);
        if (notice) paintNotice(ctx, notice, uiScale, banner ? bannerHeight(uiScale) : 0, width);
      });
    }
    // The clock sits just above the marker; the attribution reaches the
    // bottom edge at the other end.
    const clock = new Date().toLocaleTimeString('uk-UA', { hour12: false });
    const footHeight = clockHeight(uiScale) + cell;
    drawStrip('foot', height - footHeight, width, footHeight, JSON.stringify([uiScale, clock, Boolean(attribution)]), (ctx, w, h) => {
      if (attribution) paintAttribution(ctx, uiScale, w, h);
      paintClock(ctx, clock, uiScale, h - cell);
    });
    drawMarker(seq || 0, cell);
    if (gl.isContextLost()) throw new Error('the drawing context is lost');

    if (peers.size) {
      track.requestFrame();
      framesRequested++;
    }
    // JPEG as base64 (main decodes it). Synchronous toDataURL, not toBlob:
    // Chromium encodes toBlob (and OffscreenCanvas.convertToBlob) in idle
    // time, which this hidden window hardly gets, so every 3rd–4th frame
    // waited ~1 s for the fallback timeout (measured 2026-10-23: toBlob
    // ~35 ms or ~950 ms, toDataURL 28–35 ms).
    let jpeg = null;
    if (needJpeg) {
      const url = canvas.toDataURL('image/jpeg', quality);
      jpeg = url.slice(url.indexOf(',') + 1);
    }
    overlay.send('ui:composed', { id, jpeg });
  } catch (error) {
    overlay.send('ui:composed', { id, error: error.message });
  }
}

// --- WebRTC sender -------------------------------------------------------------

function reportPeers() {
  overlay.send('ui:webrtc-peers', peers.size);
}

function waitIce(peer, ms) {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    peer.addEventListener('icegatheringstatechange', () => peer.iceGatheringState === 'complete' && resolve());
    setTimeout(resolve, ms);
  });
}

// One viewer's offer → our answer. LAN only: no STUN/TURN; ICE candidates
// are gathered fully before answering (no trickle over HTTP).
overlay.on('ui:webrtc-offer', async ({ id, sdp, maxPeers }) => {
  if (peers.size >= maxPeers) {
    overlay.send('ui:webrtc-answer', { id, error: 'busy' });
    return;
  }
  const peer = new RTCPeerConnection({ iceServers: [] });
  peers.add(peer);
  reportPeers();
  const drop = () => {
    if (!peers.delete(peer)) return;
    peer.close();
    reportPeers();
  };
  peer.onconnectionstatechange = () => {
    if (['failed', 'closed', 'disconnected'].includes(peer.connectionState)) drop();
  };
  try {
    const sender = peer.addTrack(track, stream);
    await peer.setRemoteDescription({ type: 'offer', sdp });
    await peer.setLocalDescription(await peer.createAnswer());
    try {
      const params = sender.getParameters();
      params.degradationPreference = 'maintain-resolution';
      if (params.encodings?.[0]) params.encodings[0].maxBitrate = MAX_BITRATE;
      await sender.setParameters(params);
    } catch {
      // Older engines: defaults still work.
    }
    await waitIce(peer, 2000);
    overlay.send('ui:webrtc-answer', { id, sdp: peer.localDescription.sdp });
    // A viewer that never connects is dropped.
    setTimeout(() => peer.connectionState !== 'connected' && drop(), 15000);
    track.requestFrame();
  } catch (error) {
    drop();
    overlay.send('ui:webrtc-answer', { id, error: error.message });
  }
});

// Encoder check: frames are asked for, but are they encoded? If a connected
// peer's framesEncoded has not grown over a check while frames were
// requested, the video path is stuck; main then replaces this window.
const ENCODER_CHECK_MS = 15_000;
let framesRequested = 0;
const lastEncoded = new WeakMap(); // peer -> framesEncoded at the last check

setInterval(async () => {
  const requested = framesRequested;
  framesRequested = 0;
  if (requested < 3) return; // Too few frames asked for to judge.
  for (const peer of peers) {
    if (peer.connectionState !== 'connected') continue;
    let encoded = null;
    try {
      const stats = await peer.getStats();
      stats.forEach((s) => {
        if (s.type === 'outbound-rtp' && s.kind === 'video') encoded = s.framesEncoded;
      });
    } catch {
      continue;
    }
    if (encoded === null) continue;
    const before = lastEncoded.get(peer);
    lastEncoded.set(peer, encoded);
    if (before !== undefined && encoded === before) {
      overlay.send('ui:compositor-health', { stalled: true, requested });
      return;
    }
  }
}, ENCODER_CHECK_MS);

// Main asks to drop everyone (new link, stream off).
overlay.on('ui:webrtc-close-all', () => {
  for (const peer of [...peers]) peer.close();
  peers.clear();
  reportPeers();
});
