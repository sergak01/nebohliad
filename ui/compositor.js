'use strict';

// Hidden window for the LAN stream (stream-server.js):
// - blends the base and top captures like PiP does, scales to the stream
//   width, draws the map data attribution and an alert banner;
// - returns a JPEG when MJPEG viewers or snapshots need one;
// - is the WebRTC sender: the canvas itself is the video track
//   (captureStream, one frame per composed image), one peer per viewer.

const canvas = document.createElement('canvas');
canvas.width = 1280;
canvas.height = 720;
document.body.appendChild(canvas); // Captured canvases are kept in the DOM.
const ctx = canvas.getContext('2d');
const BACKGROUND = '#111318';
const ATTRIBUTION = '© OpenStreetMap contributors · © OpenMapTiles';

const stream = canvas.captureStream(0);
const [track] = stream.getVideoTracks();
// A map with small labels: keep resolution, let the frame rate drop instead
// (WebRTC's default for camera-like video is the opposite).
track.contentHint = 'detail';
const MAX_BITRATE = 3_000_000;
const peers = new Set();

function decode(bytes) {
  return bytes ? createImageBitmap(new Blob([bytes])) : null;
}

function drawAttribution(scale) {
  ctx.globalAlpha = 1;
  ctx.font = `${Math.max(10, Math.round(11 * scale))}px "Segoe UI", system-ui, sans-serif`;
  const pad = Math.round(4 * scale);
  const width = ctx.measureText(ATTRIBUTION).width + 2 * pad;
  const height = Math.max(14, Math.round(16 * scale));
  ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
  ctx.fillRect(canvas.width - width, canvas.height - height, width, height);
  ctx.fillStyle = '#1d2026';
  ctx.textBaseline = 'middle';
  ctx.fillText(ATTRIBUTION, canvas.width - width + pad, canvas.height - height / 2);
}

// A red strip across the top while targets are near a saved location.
function drawBanner(text, scale) {
  ctx.globalAlpha = 1;
  const height = Math.round(30 * scale);
  ctx.fillStyle = 'rgba(198, 40, 40, 0.92)';
  ctx.fillRect(0, 0, canvas.width, height);
  ctx.fillStyle = '#ffffff';
  ctx.font = `600 ${Math.round(15 * scale)}px "Segoe UI", system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, Math.round(10 * scale), height / 2, canvas.width - Math.round(20 * scale));
}

overlay.on('ui:compose', async ({ id, bottom, top, opacity, maxWidth, quality, attribution, banner, needJpeg }) => {
  try {
    const [base, layer] = await Promise.all([decode(bottom), decode(top)]);
    const source = base || layer;
    const scale = Math.min(1, maxWidth / source.width);
    // Even sizes: video encoders need them.
    const width = Math.round((source.width * scale) / 2) * 2;
    const height = Math.round((source.height * scale) / 2) * 2;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    ctx.imageSmoothingQuality = 'high';
    ctx.globalAlpha = 1;
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, width, height);
    if (base) ctx.drawImage(base, 0, 0, width, height);
    if (layer) {
      ctx.globalAlpha = opacity;
      ctx.drawImage(layer, 0, 0, width, height);
    }
    const uiScale = Math.max(1, width / 1280);
    if (attribution) drawAttribution(uiScale);
    if (banner) drawBanner(banner, uiScale);
    base?.close();
    layer?.close();
    if (peers.size) track.requestFrame();
    let jpeg = null;
    if (needJpeg) {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
      jpeg = new Uint8Array(await blob.arrayBuffer());
    }
    overlay.send('ui:composed', { id, jpeg });
  } catch (error) {
    overlay.send('ui:composed', { id, error: error.message });
  }
});

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

// Main asks to drop everyone (new link, stream off).
overlay.on('ui:webrtc-close-all', () => {
  for (const peer of [...peers]) peer.close();
  peers.clear();
  reportPeers();
});
