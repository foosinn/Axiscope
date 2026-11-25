// Finds the nozzle hole in the camera image and moves the toolhead until
// the hole sits under the crosshair.

const AC_ROI = 0.8;            // ROI side, as part of the shorter frame side
const AC_LIVE_MS = 200;
const AC_SETTLE_MS = 300;      // camera latency after a move
const AC_APPROACH = 0.3;       // mm, every move ends from the -X/-Y side
const AC_CAL_STEP = 0.5;       // mm
const AC_DONE_MM = 0.005;
const AC_MAX_STEP = 1;         // mm per move
const AC_MAX_TRAVEL = 3;       // mm per auto center run
const AC_MAX_ITER = 8;
const AC_STORAGE_KEY = 'axiscope_cam_calib';

let acShowDetection = true;
let acRunning = false;
let acStop = false;

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

function grayRoi(imageData, target) {
  const { width: W, height: H, data } = imageData;
  const size = Math.round(Math.min(W, H) * AC_ROI);
  const x0 = clamp(Math.round(target.x - size / 2), 0, W - size);
  const y0 = clamp(Math.round(target.y - size / 2), 0, H - size);
  const gray = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = ((y0 + y) * W + x0 + x) * 4;
      gray[y * size + x] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
  }
  return { gray: gray, size: size, x0: x0, y0: y0 };
}

function blur3(src, size) {
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

// Thin edge points with their gradient direction. The threshold is a
// percentile of the gradient strength, so it adapts to the brightness.
function edgePoints(img, size) {
  const n = size * size;
  const gx = new Float32Array(n), gy = new Float32Array(n), mag = new Float32Array(n);
  let max = 0;
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const i = y * size + x;
      const a = img[i - size - 1], b = img[i - size], c = img[i - size + 1];
      const d = img[i - 1], f = img[i + 1];
      const g = img[i + size - 1], h = img[i + size], k = img[i + size + 1];
      gx[i] = (c + 2 * f + k) - (a + 2 * d + g);
      gy[i] = (g + 2 * h + k) - (a + 2 * b + c);
      mag[i] = Math.hypot(gx[i], gy[i]);
      if (mag[i] > max) max = mag[i];
    }
  }
  if (max < 20) return [];

  const hist = new Uint32Array(1024);
  for (let i = 0; i < n; i++) hist[Math.min(1023, Math.floor(mag[i] / max * 1023))]++;
  let count = 0, bin = 0, median = 0;
  while (bin < 1023 && count < n * 0.85) {
    count += hist[bin++];
    if (!median && count >= n * 0.5) median = bin / 1023 * max;
  }
  const threshold = bin / 1023 * max;

  const edges = [];
  for (let y = 2; y < size - 2; y++) {
    for (let x = 2; x < size - 2; x++) {
      const i = y * size + x, m = mag[i];
      if (m < threshold) continue;
      const ux = gx[i] / m, uy = gy[i] / m;
      if (m < mag[Math.round(y + uy) * size + Math.round(x + ux)]) continue;
      if (m < mag[Math.round(y - uy) * size + Math.round(x - ux)]) continue;
      edges.push({ x: x + 0.5, y: y + 0.5, ux: ux, uy: uy, m: m });
    }
  }
  edges.median = median;
  return edges;
}

// Every edge point votes for centers along its gradient line, in both
// directions, so dark and bright holes count the same. Face and hole are
// concentric and vote for the same spot.
function voteCenter(edges, size, rMin, rMax) {
  const acc = new Float32Array(size * size);
  for (const e of edges) {
    for (const dir of [1, -1]) {
      for (let r = rMin; r <= rMax; r++) {
        const cx = Math.floor(e.x + dir * e.ux * r);
        const cy = Math.floor(e.y + dir * e.uy * r);
        if (cx < 0 || cy < 0 || cx >= size || cy >= size) break;
        acc[cy * size + cx]++;
      }
    }
  }
  let best = 0, bestI = -1;
  for (let y = 2; y < size - 2; y++) {
    for (let x = 2; x < size - 2; x++) {
      let sum = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) sum += acc[(y + dy) * size + x + dx];
      }
      if (sum > best) {
        best = sum;
        bestI = y * size + x;
      }
    }
  }
  return bestI < 0 ? null : { x: bestI % size + 0.5, y: Math.floor(bestI / size) + 0.5 };
}

// Radii around the center where many edges point at the center.
function radiusPeaks(edges, center, rMin, rMax) {
  const hist = new Float32Array(rMax + 2);
  for (const e of edges) {
    const dx = e.x - center.x, dy = e.y - center.y, d = Math.hypot(dx, dy);
    if (d < rMin || d > rMax) continue;
    if (Math.abs((dx * e.ux + dy * e.uy) / d) > 0.9) hist[Math.round(d)] += 1 / d;
  }
  const peaks = [];
  for (let r = rMin + 1; r < rMax; r++) {
    if (hist[r] > 0 && hist[r] >= hist[r - 1] && hist[r] >= hist[r + 1]) {
      peaks.push({ r: r, score: hist[r - 1] + hist[r] + hist[r + 1] });
    }
  }
  return peaks.sort((a, b) => b.score - a.score).slice(0, 8).map(p => p.r);
}

function solve3(M, v) {
  const det = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
                 - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
                 + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(M);
  if (!D) return null;
  return [0, 1, 2].map(k => det(M.map((row, i) => row.map((val, j) => j === k ? v[i] : val))) / D);
}

// Least-squares circle fit on the edge points near a guess. Points that do
// not fit (smears, specks) drop out as the tolerance shrinks.
function fitCircle(edges, center, r0) {
  let c = { x: center.x, y: center.y, r: r0 };
  let pts = [];
  for (let it = 0; it < 6; it++) {
    const tol = it < 2 ? 4 : 2;
    pts = edges.filter(e => {
      const dx = e.x - c.x, dy = e.y - c.y, d = Math.hypot(dx, dy);
      return d > 0 && Math.abs(d - c.r) < tol && Math.abs((dx * e.ux + dy * e.uy) / d) > 0.85;
    });
    if (pts.length < 12) return null;
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
    for (const p of pts) {
      const z = p.x * p.x + p.y * p.y;
      sx += p.x; sy += p.y; sxx += p.x * p.x; syy += p.y * p.y; sxy += p.x * p.y;
      sxz += p.x * z; syz += p.y * z; sz += z;
    }
    const sol = solve3([[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, pts.length]], [sxz, syz, sz]);
    if (!sol) return null;
    const x = sol[0] / 2, y = sol[1] / 2;
    c = { x: x, y: y, r: Math.sqrt(sol[2] + x * x + y * y) };
  }
  const rms = Math.sqrt(pts.reduce((a, p) => a + (Math.hypot(p.x - c.x, p.y - c.y) - c.r) ** 2, 0) / pts.length);
  const sectors = new Set(pts.map(p => Math.floor((Math.atan2(p.y - c.y, p.x - c.x) + Math.PI) / (2 * Math.PI) * 36)));
  const contrast = pts.reduce((a, p) => a + p.m, 0) / pts.length;
  return { x: c.x, y: c.y, r: c.r, rms: rms, coverage: sectors.size / 36, contrast: contrast };
}

// Returns {x, y, r, coverage, face} in frame pixels, or null. The hole
// is the round outline inside the nozzle face, concentric with it and 0.15 to
// 0.65 of its radius. Its color does not matter, so empty, dark and white
// filled holes all work. At least 72% of its outline must be visible: with
// less, the fit can drift (e.g. overexposed white filament merging with a
// smear), so no hole is better than a wrong one. Circle edges must also be
// 3.5x stronger than the typical gradient, so noise and lens vignetting do
// not count as circles.
function detectHole(imageData, target) {
  const roi = grayRoi(imageData, target);
  const size = roi.size;
  const img = blur3(blur3(roi.gray, size), size);
  const edges = edgePoints(img, size);
  if (edges.length < 50) return null;

  const rMin = 4, rMax = Math.round(size / 3);
  const center = voteCenter(edges, size, rMin, rMax);
  if (!center) return null;
  const circles = radiusPeaks(edges, center, rMin, rMax)
    .map(r => fitCircle(edges, center, r))
    .filter(c => c && c.rms < 1.5 && c.contrast > edges.median * 3.5);

  const faces = circles.filter(c => c.coverage >= 0.85).sort((a, b) => b.r - a.r);
  for (const face of faces) {
    const holes = circles.filter(c =>
      c.r > face.r * 0.15 && c.r < face.r * 0.65 && c.coverage >= 0.72 &&
      Math.hypot(c.x - face.x, c.y - face.y) < face.r * 0.25);
    if (!holes.length) continue;
    holes.sort((a, b) => b.coverage - a.coverage || a.rms - b.rms);
    const hole = holes[0];
    return {
      x: hole.x + roi.x0, y: hole.y + roi.y0, r: hole.r,
      coverage: hole.coverage,
      face: { x: face.x + roi.x0, y: face.y + roi.y0, r: face.r }
    };
  }
  return null;
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
  ctx.strokeStyle = 'rgba(250, 204, 21, 0.6)';
  ctx.beginPath();
  ctx.arc(det.face.x, det.face.y, det.face.r, 0, 2 * Math.PI);
  ctx.stroke();
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
      ? `Hole Δ ${(det.x - target.x).toFixed(1)} / ${(det.y - target.y).toFixed(1)} px · outline ${Math.round(det.coverage * 100)}%`
      : 'No hole found');
  } catch (error) {
    $('#ac-live').text(error.message);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function detectStable() {
  const found = [];
  for (let i = 0; i < 3; i++) {
    if (i) await sleep(100);
    const frame = grabFrame();
    const target = crosshairTarget(frame.width, frame.height);
    const det = detectHole(frame, target);
    if (!det) throw new Error('No nozzle hole found');
    found.push(det);
  }
  const x = found.reduce((a, d) => a + d.x, 0) / found.length;
  const y = found.reduce((a, d) => a + d.y, 0) / found.length;
  if (found.some(d => Math.hypot(d.x - x, d.y - y) > 1.5)) {
    throw new Error('Detection is not stable, check light and focus');
  }
  return { x: x, y: y };
}

async function moveXY(dx, dy) {
  await $.get(gcodeUrl([
    'SAVE_GCODE_STATE NAME=autocenter',
    'G91',
    `G0 X${(dx - AC_APPROACH).toFixed(4)} Y${(dy - AC_APPROACH).toFixed(4)} F1200`,
    `G0 X${AC_APPROACH} Y${AC_APPROACH} F600`,
    'RESTORE_GCODE_STATE NAME=autocenter',
    'M400'
  ].join('\n')));
  await sleep(AC_SETTLE_MS);
}

function cameraKey() {
  return selectedCamera ? (selectedCamera.deviceId || selectedCamera.url) : '';
}

function loadCalibration() {
  try {
    const cal = JSON.parse(localStorage.getItem(AC_STORAGE_KEY));
    return cal && cal.camera === cameraKey() ? cal.J : null;
  } catch (e) {
    return null;
  }
}

function saveCalibration(J) {
  try {
    localStorage.setItem(AC_STORAGE_KEY, JSON.stringify({ camera: cameraKey(), J: J }));
  } catch (e) {
    console.error('Could not store camera calibration:', e);
  }
}

function requireReady() {
  if (!lastStatus || lastStatus.toolhead.homed_axes !== 'xyz') {
    throw new Error('Home the printer first');
  }
}

// J maps a toolhead move in mm to a hole move in frame pixels. It covers
// scale, rotation and mirroring of the camera.
async function calibrateCamera() {
  requireReady();
  await moveXY(0, 0);
  const p0 = await detectStable();
  await moveXY(AC_CAL_STEP, 0);
  const px = await detectStable();
  await moveXY(-AC_CAL_STEP, AC_CAL_STEP);
  const py = await detectStable();
  await moveXY(0, -AC_CAL_STEP);

  const J = [
    [(px.x - p0.x) / AC_CAL_STEP, (py.x - p0.x) / AC_CAL_STEP],
    [(px.y - p0.y) / AC_CAL_STEP, (py.y - p0.y) / AC_CAL_STEP]
  ];
  const lenX = Math.hypot(J[0][0], J[1][0]);
  const lenY = Math.hypot(J[0][1], J[1][1]);
  if (Math.min(lenX, lenY) < 2) throw new Error('The hole did not move in the image');
  if (Math.max(lenX, lenY) / Math.min(lenX, lenY) > 1.2) throw new Error('X and Y scale differ too much');
  const cos = (J[0][0] * J[0][1] + J[1][0] * J[1][1]) / (lenX * lenY);
  if (Math.abs(cos) > Math.sin(15 * Math.PI / 180)) throw new Error('X and Y are not at a right angle in the image');

  saveCalibration(J);
  return `Calibrated · ${((lenX + lenY) / 2).toFixed(1)} px/mm`;
}

async function autoCenter() {
  requireReady();
  const J = loadCalibration();
  if (!J) throw new Error('Calibrate the camera first');
  const det = J[0][0] * J[1][1] - J[0][1] * J[1][0];
  const inv = [[J[1][1] / det, -J[0][1] / det], [-J[1][0] / det, J[0][0] / det]];

  let travel = 0;
  for (let i = 1; i <= AC_MAX_ITER; i++) {
    if (acStop) throw new Error('Stopped');
    const p = await detectStable();
    const frame = activeFeed();
    const target = crosshairTarget(frame.w, frame.h);
    const ex = target.x - p.x, ey = target.y - p.y;
    let dx = inv[0][0] * ex + inv[0][1] * ey;
    let dy = inv[1][0] * ex + inv[1][1] * ey;
    const dist = Math.hypot(dx, dy);
    if (dist < AC_DONE_MM) return `Centered · ${dist.toFixed(4)} mm off`;
    setAcStatus(`Move ${i} · ${dist.toFixed(3)} mm off`);
    if (dist > AC_MAX_STEP) {
      dx *= AC_MAX_STEP / dist;
      dy *= AC_MAX_STEP / dist;
    }
    travel += Math.hypot(dx, dy);
    if (travel > AC_MAX_TRAVEL) throw new Error('Moved too far, stopped');
    if (acStop) throw new Error('Stopped');
    await moveXY(dx, dy);
  }
  throw new Error(`Not centered after ${AC_MAX_ITER} moves`);
}

function setAcStatus(text, cls) {
  $('#ac-status').text(text).attr('class', cls || 'text-secondary');
}

async function runAc(action) {
  if (acRunning) return;
  acRunning = true;
  acStop = false;
  $('#ac-calibrate, #ac-center').prop('disabled', true);
  $('#ac-stop').prop('disabled', false);
  setAcStatus('Working...');
  try {
    setAcStatus(await action(), 'text-success');
  } catch (error) {
    const msg = (error.responseJSON && error.responseJSON.error && error.responseJSON.error.message) || error.message;
    setAcStatus(msg, 'text-danger');
  }
  acRunning = false;
  $('#ac-calibrate, #ac-center').prop('disabled', false);
  $('#ac-stop').prop('disabled', true);
}

$(document).ready(function() {
  setInterval(detectLive, AC_LIVE_MS);

  $('#ac-calibrate').on('click', () => runAc(calibrateCamera));
  $('#ac-center').on('click', () => runAc(autoCenter));
  $('#ac-stop').on('click', () => { acStop = true; });

  $('#ac-show').on('change', function() {
    acShowDetection = this.checked;
  });
});
