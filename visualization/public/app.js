/**
 * SoundCount Multi-Band DSP & Piano Tiles Gameplay Engine (60 FPS)
 * Renders 2D CQT Spectrogram, 4 parallel Multi-Band Spectral Flux curves,
 * 60 FPS Dynamic Real-Time Frame Slice, and 4-Lane Piano Tiles Gameplay Visualizer
 * (Right-to-Left scrolling notes with hit bursts).
 */

let analysisData = null;
let currentFrameIdx = 0;
let lastAttackTimes = [0, 0, 0, 0];
let animFrameId = null;

// DOM Elements
const audioPlayer = document.getElementById('audioPlayer');
const btnPlayPause = document.getElementById('btnPlayPause');
const timeDisplay = document.getElementById('timeDisplay');
const trackMeta = document.getElementById('trackMeta');
const currentFrameText = document.getElementById('currentFrameText');

const indBands = [
  document.getElementById('indBand0'),
  document.getElementById('indBand1'),
  document.getElementById('indBand2'),
  document.getElementById('indBand3')
];

// Canvases
const cqtCanvas = document.getElementById('cqtCanvas');
const cqtCtx = cqtCanvas.getContext('2d');

const noveltyCanvas = document.getElementById('noveltyCanvas');
const noveltyCtx = noveltyCanvas.getContext('2d');

const sliceCanvas = document.getElementById('sliceCanvas');
const sliceCtx = sliceCanvas.getContext('2d');

const pianoLanesCanvas = document.getElementById('pianoLanesCanvas');
const pianoCtx = pianoLanesCanvas.getContext('2d');

// Band Colors & Names
const BAND_COLORS = ['#f97316', '#eab308', '#10b981', '#06b6d4'];
const BAND_NAMES = ['🔴 BASS', '🟡 TENOR', '🟢 ALTO', '🔵 SOPRANO'];

// Offscreen buffers
let offscreenCqtCanvas = document.createElement('canvas');
let offscreenNoveltyCanvas = document.createElement('canvas');

function getHeatmapColor(db) {
  const val = Math.max(0, Math.min(1, (db + 80) / 80));
  let r, g, b;
  if (val < 0.25) {
    const t = val / 0.25;
    r = Math.floor(10 * (1 - t));
    g = Math.floor(15 * (1 - t) + 80 * t);
    b = Math.floor(45 * (1 - t) + 180 * t);
  } else if (val < 0.5) {
    const t = (val - 0.25) / 0.25;
    r = Math.floor(0 * (1 - t) + 56 * t);
    g = Math.floor(80 * (1 - t) + 189 * t);
    b = Math.floor(180 * (1 - t) + 248 * t);
  } else if (val < 0.75) {
    const t = (val - 0.5) / 0.25;
    r = Math.floor(56 * (1 - t) + 250 * t);
    g = Math.floor(189 * (1 - t) + 204 * t);
    b = Math.floor(248 * (1 - t) + 21 * t);
  } else {
    const t = (val - 0.75) / 0.25;
    r = Math.floor(250 * (1 - t) + 244 * t);
    g = Math.floor(204 * (1 - t) + 63 * t);
    b = Math.floor(21 * (1 - t) + 94 * t);
  }
  return `rgb(${r}, ${g}, ${b})`;
}

async function initDashboard() {
  try {
    const response = await fetch('/analysis.json');
    if (!response.ok) throw new Error("Could not load analysis.json");
    analysisData = await response.json();

    setupMetadata();
    setupAudioPlayer();
    buildOffscreenStaticSpectrogram();
    buildOffscreenStaticNovelty();
    
    startAnimationLoop();

    cqtCanvas.addEventListener('click', handleCanvasClick);
    noveltyCanvas.addEventListener('click', handleCanvasClick);

  } catch (err) {
    console.error("Dashboard Init Error:", err);
    trackMeta.innerHTML = `<span style="color: #f43f5e">Ошибка: ${err.message}. Запустите data_exporter.py!</span>`;
  }
}

function setupMetadata() {
  const meta = analysisData.metadata;
  const totalPeaks = analysisData.multiband.merged_peaks_sec.length;
  trackMeta.innerHTML = `
    <span class="meta-tag">🎵 ${meta.title}</span>
    <span class="meta-tag">⏱ ${meta.duration_sec}с</span>
    <span class="meta-tag">📡 ${meta.sample_rate} Гц</span>
    <span class="meta-tag">🎹 4 полосы</span>
    <span class="meta-tag">⚡ ${totalPeaks} атак</span>
  `;
}

function setupAudioPlayer() {
  const audioFile = analysisData.metadata.audio_filename;
  audioPlayer.src = `/audio/${audioFile}`;

  btnPlayPause.addEventListener('click', () => {
    if (audioPlayer.paused) {
      audioPlayer.play();
      btnPlayPause.textContent = "⏸ Пауза";
    } else {
      audioPlayer.pause();
      btnPlayPause.textContent = "▶ Воспроизведение";
    }
  });
}

function buildOffscreenStaticSpectrogram() {
  const nBins = analysisData.metadata.n_bins;
  const nFrames = analysisData.metadata.n_frames;
  const dbMatrix = analysisData.spectrogram_db;

  offscreenCqtCanvas.width = nFrames;
  offscreenCqtCanvas.height = nBins;
  const ctx = offscreenCqtCanvas.getContext('2d');
  const imgData = ctx.createImageData(nFrames, nBins);

  for (let b = 0; b < nBins; b++) {
    const yBin = nBins - 1 - b;
    for (let f = 0; f < nFrames; f++) {
      const db = dbMatrix[b][f];
      const idx = (yBin * nFrames + f) * 4;
      const rgb = parseRgb(getHeatmapColor(db));

      imgData.data[idx] = rgb.r;
      imgData.data[idx + 1] = rgb.g;
      imgData.data[idx + 2] = rgb.b;
      imgData.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);

  const bandRanges = analysisData.metadata.band_ranges;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
  ctx.lineWidth = 1;
  bandRanges.forEach(([startBin, endBin]) => {
    const yLine = nBins - endBin;
    ctx.beginPath();
    ctx.moveTo(0, yLine);
    ctx.lineTo(nFrames, yLine);
    ctx.stroke();
  });
}

function parseRgb(rgbStr) {
  const match = rgbStr.match(/\d+/g);
  return { r: parseInt(match[0]), g: parseInt(match[1]), b: parseInt(match[2]) };
}

function buildOffscreenStaticNovelty() {
  const width = 1400;
  const height = 160;
  offscreenNoveltyCanvas.width = width;
  offscreenNoveltyCanvas.height = height;
  const ctx = offscreenNoveltyCanvas.getContext('2d');

  const nFrames = analysisData.metadata.n_frames;
  const sfBands = analysisData.multiband.sf_bands;
  const thBands = analysisData.multiband.thresholds_bands;
  const peaksBands = analysisData.multiband.peaks_sec_bands;
  const bandHeight = height / 4;

  ctx.clearRect(0, 0, width, height);

  for (let b = 0; b < 4; b++) {
    const yOffset = b * bandHeight;
    const color = BAND_COLORS[b];

    ctx.fillStyle = 'rgba(255, 255, 255, 0.02)';
    if (b % 2 === 0) ctx.fillRect(0, yOffset, width, bandHeight);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, yOffset, width, bandHeight);

    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    for (let f = 0; f < nFrames; f++) {
      const x = (f / nFrames) * width;
      const y = yOffset + bandHeight - (sfBands[b][f] * (bandHeight - 4));
      if (f === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.beginPath();
    ctx.strokeStyle = '#f43f5e';
    ctx.lineWidth = 1.0;
    ctx.setLineDash([3, 3]);
    for (let f = 0; f < nFrames; f++) {
      const x = (f / nFrames) * width;
      const y = yOffset + bandHeight - (thBands[b][f] * (bandHeight - 4));
      if (f === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    peaksBands[b].forEach(tPeak => {
      const x = (tPeak / analysisData.metadata.duration_sec) * width;
      ctx.beginPath();
      ctx.moveTo(x, yOffset);
      ctx.lineTo(x, yOffset + bandHeight);
      ctx.stroke();
    });
  }
}

function startAnimationLoop() {
  function render() {
    if (analysisData) {
      updateUI60FPS();
    }
    animFrameId = requestAnimationFrame(render);
  }
  animFrameId = requestAnimationFrame(render);
}

// Main 60 FPS Loop
function updateUI60FPS() {
  const curTime = audioPlayer.currentTime || 0;
  const dur = audioPlayer.duration || analysisData.metadata.duration_sec || 1;

  timeDisplay.textContent = `${formatTime(curTime)} / ${formatTime(dur)}`;

  const hopSec = analysisData.metadata.hop_length / analysisData.metadata.sample_rate;
  currentFrameIdx = Math.min(
    analysisData.metadata.n_frames - 1,
    Math.max(0, Math.floor(curTime / hopSec))
  );

  currentFrameText.textContent = `Фрейм m = ${currentFrameIdx} | t = ${curTime.toFixed(3)} с`;

  // 1. Draw Piano Lanes Gameplay Visualizer (4 Horizontal Lanes, Right-to-Left Scroll)
  renderPianoLanesGameplay(curTime);

  // 2. Draw 2D Spectrogram Canvas + Red Cursor
  const w1 = cqtCanvas.width = cqtCanvas.parentElement.clientWidth;
  const h1 = cqtCanvas.height = 200;
  cqtCtx.drawImage(offscreenCqtCanvas, 0, 0, w1, h1);

  const xPlayhead = (curTime / dur) * w1;
  cqtCtx.strokeStyle = '#ef4444';
  cqtCtx.lineWidth = 2;
  cqtCtx.beginPath();
  cqtCtx.moveTo(xPlayhead, 0);
  cqtCtx.lineTo(xPlayhead, h1);
  cqtCtx.stroke();

  // 3. Draw 4 Multi-Band Novelty Canvas + Red Cursor
  const w2 = noveltyCanvas.width = noveltyCanvas.parentElement.clientWidth;
  const h2 = noveltyCanvas.height = 160;
  noveltyCtx.drawImage(offscreenNoveltyCanvas, 0, 0, w2, h2);

  const xPlayheadNovelty = (curTime / dur) * w2;
  noveltyCtx.strokeStyle = '#ef4444';
  noveltyCtx.lineWidth = 2;
  noveltyCtx.beginPath();
  noveltyCtx.moveTo(xPlayheadNovelty, 0);
  noveltyCtx.lineTo(xPlayheadNovelty, h2);
  noveltyCtx.stroke();

  // 4. Draw Dynamic Live Slice Canvas (Canvas 3)
  renderSlice(currentFrameIdx);

  // 5. Check 4 Multi-Band Onset Hits
  const nowMs = performance.now();
  const peaksBands = analysisData.multiband.peaks_sec_bands;

  for (let b = 0; b < 4; b++) {
    const isBandHit = peaksBands[b].some(tPeak => {
      const diff = curTime - tPeak;
      return diff >= -0.040 && diff <= 0.060;
    });

    if (isBandHit) {
      lastAttackTimes[b] = nowMs;
    }

    const indBox = indBands[b];
    if (nowMs - lastAttackTimes[b] < 150) {
      indBox.classList.add('active');
    } else {
      indBox.classList.remove('active');
    }
  }
}

/**
 * 🎮 Renders 4-Lane Piano Tiles Gameplay Visualizer
 * - 4 Horizontal Lanes (Bass, Tenor, Alto, Soprano)
 * - Hit Target Line at X_hit = 80px
 * - Attack note lines travel Right-to-Left from X_max to X_hit
 * - Flash & Glow Burst on Hit Line at exact moment of audio impact!
 */
function renderPianoLanesGameplay(curTime) {
  const width = pianoLanesCanvas.width = pianoLanesCanvas.parentElement.clientWidth;
  const height = pianoLanesCanvas.height = 220;

  pianoCtx.clearRect(0, 0, width, height);

  const xHit = 90; // Target Hit Line X position
  const lookaheadSec = 3.0; // 3-second lookahead window
  const laneHeight = height / 4;
  const peaksBands = analysisData.multiband.peaks_sec_bands;
  const nowMs = performance.now();

  // Draw 4 Horizontal Lanes
  for (let b = 0; b < 4; b++) {
    const yTop = b * laneHeight;
    const color = BAND_COLORS[b];

    // Background lane fill
    pianoCtx.fillStyle = (b % 2 === 0) ? 'rgba(15, 23, 42, 0.8)' : 'rgba(30, 41, 59, 0.5)';
    pianoCtx.fillRect(0, yTop, width, laneHeight);

    // Lane border
    pianoCtx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    pianoCtx.lineWidth = 1;
    pianoCtx.strokeRect(0, yTop, width, laneHeight);

    // Lane Label Text
    pianoCtx.fillStyle = color;
    pianoCtx.font = '600 11px "JetBrains Mono", monospace';
    pianoCtx.fillText(BAND_NAMES[b], 10, yTop + laneHeight / 2 + 4);
  }

  // Draw Target Hit Line (Vertical Glowing Bar at xHit)
  pianoCtx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
  pianoCtx.lineWidth = 3;
  pianoCtx.beginPath();
  pianoCtx.moveTo(xHit, 0);
  pianoCtx.lineTo(xHit, height);
  pianoCtx.stroke();

  // Draw Target Rings on Hit Line for each lane
  for (let b = 0; b < 4; b++) {
    const yCenter = b * laneHeight + laneHeight / 2;
    const color = BAND_COLORS[b];
    const isHitActive = (nowMs - lastAttackTimes[b] < 150);

    // Draw Target Hit Circle
    pianoCtx.beginPath();
    pianoCtx.arc(xHit, yCenter, isHitActive ? 16 : 10, 0, Math.PI * 2);
    pianoCtx.fillStyle = isHitActive ? color : 'rgba(15, 23, 42, 0.9)';
    pianoCtx.fill();
    pianoCtx.strokeStyle = color;
    pianoCtx.lineWidth = 2;
    pianoCtx.stroke();

    // Burst glow effect when note hits target!
    if (isHitActive) {
      pianoCtx.beginPath();
      pianoCtx.arc(xHit, yCenter, 28, 0, Math.PI * 2);
      pianoCtx.strokeStyle = color;
      pianoCtx.lineWidth = 3;
      pianoCtx.stroke();
    }
  }

  // Draw Traveling Attack Note Lines (Right-to-Left Scroll)
  for (let b = 0; b < 4; b++) {
    const yTop = b * laneHeight;
    const color = BAND_COLORS[b];
    const peaks = peaksBands[b];

    peaks.forEach(tPeak => {
      const deltaTime = tPeak - curTime;

      // Render notes that are within the 3-second lookahead window
      if (deltaTime >= -0.05 && deltaTime <= lookaheadSec) {
        // Linear interpolation from far right (X = width) to target line (X = xHit)
        const progress = deltaTime / lookaheadSec; // 1.0 = far right, 0.0 = hit line
        const xNote = xHit + progress * (width - xHit);

        // Note Vertical Line / Bar
        pianoCtx.strokeStyle = color;
        pianoCtx.lineWidth = 4;
        pianoCtx.beginPath();
        pianoCtx.moveTo(xNote, yTop + 6);
        pianoCtx.lineTo(xNote, yTop + laneHeight - 6);
        pianoCtx.stroke();

        // Note Head Glow Circle
        pianoCtx.fillStyle = '#ffffff';
        pianoCtx.beginPath();
        pianoCtx.arc(xNote, yTop + laneHeight / 2, 5, 0, Math.PI * 2);
        pianoCtx.fill();
      }
    });
  }
}

// Render Dynamic Live Frame Slice (Canvas 3)
function renderSlice(frameIdx) {
  const width = sliceCanvas.width = sliceCanvas.parentElement.clientWidth;
  const height = sliceCanvas.height = 220;
  sliceCtx.clearRect(0, 0, width, height);

  if (!analysisData) return;

  const nBins = analysisData.metadata.n_bins;
  const dbMatrix = analysisData.spectrogram_db;
  const barWidth = width / nBins;
  const bandRanges = analysisData.metadata.band_ranges;

  for (let b = 0; b < nBins; b++) {
    const db = dbMatrix[b][frameIdx] || -80;
    const norm = Math.max(0, Math.min(1, (db + 80) / 80));
    const barHeight = norm * (height - 30);
    const x = b * barWidth;
    const y = height - barHeight - 20;

    let bandIdx = 0;
    for (let band = 0; band < bandRanges.length; band++) {
      if (b >= bandRanges[band][0] && b < bandRanges[band][1]) {
        bandIdx = band;
        break;
      }
    }

    sliceCtx.fillStyle = BAND_COLORS[bandIdx];
    sliceCtx.fillRect(x, y, barWidth - 1, barHeight);
  }

  sliceCtx.strokeStyle = '#94a3b8';
  sliceCtx.lineWidth = 1;
  sliceCtx.beginPath();
  sliceCtx.moveTo(0, height - 20);
  sliceCtx.lineTo(width, height - 20);
  sliceCtx.stroke();
}

function handleCanvasClick(e) {
  if (!analysisData) return;
  const rect = e.target.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const width = rect.width;
  const targetTime = (clickX / width) * analysisData.metadata.duration_sec;

  audioPlayer.currentTime = targetTime;
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(3);
  return `${m.toString().padStart(2, '0')}:${s.padStart(6, '0')}`;
}

window.addEventListener('resize', () => {
  if (analysisData) {
    buildOffscreenStaticNovelty();
  }
});

document.addEventListener('DOMContentLoaded', initDashboard);
