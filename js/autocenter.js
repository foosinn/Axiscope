// Finds the dark nozzle hole in the camera image and moves the toolhead
// until the hole sits under the crosshair.

const AC_ROI = 0.6;            // ROI side, as part of the shorter frame side
const AC_LIVE_MS = 200;

let acShowDetection = true;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function activeFeed() {
  const video = document.getElementById('zoom-video');
  if (video.srcObject && video.videoWidth) {
    return { el: video, w: video.videoWidth, h: video.videoHeight };
  }
  const img = document.getElementById('zoom-image');
  if (img.getAttribute('src') && img.naturalWidth) {
    return { el: img, w: img.naturalWidth, h: img.naturalHeight };
  }
  return null;
}

const acGrabCanvas = document.createElement('canvas');

function grabFrame() {
  const feed = activeFeed();
  if (!feed) throw new Error('No camera image');
  if (acGrabCanvas.width !== feed.w || acGrabCanvas.height !== feed.h) {
    acGrabCanvas.width = feed.w;
    acGrabCanvas.height = feed.h;
  }
  const ctx = acGrabCanvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(feed.el, 0, 0, feed.w, feed.h);
  try {
    return ctx.getImageData(0, 0, feed.w, feed.h);
  } catch (e) {
    throw new Error("Can't read this camera's image (cross-origin stream)");
  }
}

// Frame pixel under the crosshair center. Zoom and flip scale around the
// crosshair, so only object-fit: cover has to be undone.
function crosshairTarget(fw, fh) {
  const box = document.getElementById('camContainer').getBoundingClientRect();
  if (!box.width || !box.height) return null;
  const c = document.querySelector('.img-overlay-wrap svg circle').getBoundingClientRect();
  const cx = c.left + c.width / 2 - box.left;
  const cy = c.top + c.height / 2 - box.top;
  const s = Math.max(box.width / fw, box.height / fh);
  return {
    x: (cx - (box.width - fw * s) / 2) / s,
    y: (cy - (box.height - fh * s) / 2) / s
  };
}

function percentile(hist, count) {
  let sum = 0;
  for (let v = 0; v < 256; v++) {
    sum += hist[v];
    if (sum >= count) return v;
  }
  return 255;
}

function otsu(values) {
  const hist = new Float64Array(256);
  values.forEach(v => hist[v | 0]++);
  const total = values.length;
  let sumAll = 0;
  for (let v = 0; v < 256; v++) sumAll += v * hist[v];
  let sumB = 0, weightB = 0, best = 0, threshold = 128;
  for (let v = 0; v < 256; v++) {
    weightB += hist[v];
    if (!weightB) continue;
    const weightF = total - weightB;
    if (!weightF) break;
    sumB += v * hist[v];
    const diff = sumB / weightB - (sumAll - sumB) / weightF;
    const between = weightB * weightF * diff * diff;
    if (between > best) {
      best = between;
      threshold = v;
    }
  }
  return threshold + 0.5;
}

function boxBlur3(src, size) {
  const out = new Float32Array(src.length);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0, count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= size) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= size) continue;
          sum += src[yy * size + xx];
          count++;
        }
      }
      out[y * size + x] = sum / count;
    }
  }
  return out;
}

function ringMean(img, size, cx, cy, r1, r2) {
  let sum = 0, count = 0;
  const x0 = Math.max(0, Math.floor(cx - r2)), x1 = Math.min(size - 1, Math.ceil(cx + r2));
  const y0 = Math.max(0, Math.floor(cy - r2)), y1 = Math.min(size - 1, Math.ceil(cy + r2));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d >= r1 && d <= r2) {
        sum += img[y * size + x];
        count++;
      }
    }
  }
  return count ? sum / count : 0;
}

// Returns the hole center {x, y, r} in frame pixels, or null.
function detectHole(imageData, target) {
  const { width: W, height: H, data } = imageData;
  const size = Math.round(Math.min(W, H) * AC_ROI);
  const x0 = clamp(Math.round(target.x - size / 2), 0, W - size);
  const y0 = clamp(Math.round(target.y - size / 2), 0, H - size);
  const n = size * size;

  const gray = new Float32Array(n);
  const hist = new Uint32Array(256);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = ((y0 + y) * W + x0 + x) * 4;
      const v = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      gray[y * size + x] = v;
      hist[v | 0]++;
    }
  }

  // Brightness normalization: stretch the 2nd..98th percentile to 0..255.
  const lo = percentile(hist, n * 0.02);
  const hi = percentile(hist, n * 0.98);
  if (hi - lo < 10) return null;
  for (let i = 0; i < n; i++) gray[i] = clamp((gray[i] - lo) * 255 / (hi - lo), 0, 255);

  const img = boxBlur3(gray, size);
  const t = otsu(img);

  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  const tx = target.x - x0, ty = target.y - y0;
  let best = null;

  for (let start = 0; start < n; start++) {
    if (seen[start] || img[start] >= t) continue;

    let top = 0, area = 0, border = false, sumW = 0, sumX = 0, sumY = 0, sumV = 0;
    let minX = size, maxX = 0, minY = size, maxY = 0;
    stack[top++] = start;
    seen[start] = 1;
    while (top) {
      const i = stack[--top];
      const x = i % size, y = (i - x) / size;
      const w = t - img[i];
      area++;
      sumW += w; sumX += w * (x + 0.5); sumY += w * (y + 0.5); sumV += img[i];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x === 0 || y === 0 || x === size - 1 || y === size - 1) border = true;
      const next = [x > 0 ? i - 1 : -1, x < size - 1 ? i + 1 : -1, y > 0 ? i - size : -1, y < size - 1 ? i + size : -1];
      for (const j of next) {
        if (j >= 0 && !seen[j] && img[j] < t) {
          seen[j] = 1;
          stack[top++] = j;
        }
      }
    }

    if (border || area < 15 || area > n * 0.15) continue;
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const aspect = bw / bh;
    const fill = area / (Math.PI * bw / 2 * bh / 2);
    if (aspect < 0.6 || aspect > 1.6 || fill < 0.7 || fill > 1.25) continue;

    const cx = sumX / sumW, cy = sumY / sumW;
    const r = Math.sqrt(area / Math.PI);
    if (ringMean(img, size, cx, cy, r * 1.3, r * 2) - sumV / area < 60) continue;

    const score = 1 - Math.abs(fill - 1) - Math.abs(aspect - 1) / 2 - Math.hypot(cx - tx, cy - ty) / size;
    if (!best || score > best.score) best = { score: score, x: cx + x0, y: cy + y0, r: r };
  }

  return best && { x: best.x, y: best.y, r: best.r };
}

function drawOverlay(det, target, w, h) {
  const canvas = document.getElementById('detect-overlay');
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  if (!acShowDetection || !det) return;

  const lw = Math.max(1, w / 400);
  ctx.lineWidth = lw;
  ctx.strokeStyle = '#22c55e';
  ctx.beginPath();
  ctx.arc(det.x, det.y, det.r, 0, 2 * Math.PI);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(det.x - det.r / 2, det.y);
  ctx.lineTo(det.x + det.r / 2, det.y);
  ctx.moveTo(det.x, det.y - det.r / 2);
  ctx.lineTo(det.x, det.y + det.r / 2);
  ctx.stroke();

  ctx.strokeStyle = '#3b82f6';
  ctx.setLineDash([4 * lw, 3 * lw]);
  ctx.beginPath();
  ctx.moveTo(target.x, target.y);
  ctx.lineTo(det.x, det.y);
  ctx.stroke();
  ctx.setLineDash([]);
}

function detectLive() {
  if (!activeFeed() || !$('#camContainer').is(':visible')) return;
  try {
    const frame = grabFrame();
    const target = crosshairTarget(frame.width, frame.height);
    if (!target) return;
    const det = detectHole(frame, target);
    drawOverlay(det, target, frame.width, frame.height);
    $('#ac-live').text(det
      ? `Hole Δ ${(det.x - target.x).toFixed(1)} / ${(det.y - target.y).toFixed(1)} px`
      : 'No hole found');
  } catch (error) {
    $('#ac-live').text(error.message);
  }
}

$(document).ready(function() {
  setInterval(detectLive, AC_LIVE_MS);

  $('#ac-show').on('change', function() {
    acShowDetection = this.checked;
  });
});
