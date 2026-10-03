/**
 * SoundCount Pure Sprint 1 DSP Math Visualizer (No Game Constraints)
 * High-performance 60 FPS Canvas renderer for:
 * 1. 2D CQT Spectrogram Heatmap
 * 2. 4 Parallel Multi-Band Spectral Flux Novelty Curves
 * 3. Dynamic 84-Bar Real-Time Frame Slice
 * 4. Raw Multi-Band Onset Peak Indicators (Pure DSP Signal, Zero Game Filters)
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

const cqtPlayhead = document.getElementById('cqtPlayhead');
const noveltyPlayhead = document.getElementById('noveltyPlayhead');

const indBands = [
  document.getElementById('indBand0'),
  document.getElementById('indBand1'),
  document.getElementById('indBand2'),
  document.getElementById('indBand3')
];

// Canvases
const cqtCanvas = document.getElementById('cqtCanvas');
const cqtCtx = cqtCanvas ? cqtCanvas.getContext('2d') : null;

const noveltyCanvas = document.getElementById('noveltyCanvas');
const noveltyCtx = noveltyCanvas ? noveltyCanvas.getContext('2d') : null;

const sliceCanvas = document.getElementById('sliceCanvas');
const sliceCtx = sliceCanvas ? sliceCanvas.getContext('2d') : null;

const rawBandsCanvas = document.getElementById('rawBandsCanvas');
const rawCtx = rawBandsCanvas ? rawBandsCanvas.getContext('2d') : null;

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
    r = Math.floor(10 * (1 - t)); g = Math.floor(15 * (1 - t) + 80 * t); b = Math.floor(45 * (1 - t) + 180 * t);
  } else if (val < 0.5) {
    const t = (val - 0.25) / 0.25;
    r = Math.floor(0 * (1 - t) + 56 * t); g = Math.floor(80 * (1 - t) + 189 * t); b = Math.floor(180 * (1 - t) + 248 * t);
  } else if (val < 0.75) {
    const t = (val - 0.5) / 0.25;
    r = Math.floor(56 * (1 - t) + 250 * t); g = Math.floor(189 * (1 - t) + 204 * t); b = Math.floor(248 * (1 - t) + 21 * t);
  } else {
    const t = (val - 0.75) / 0.25;
    r = Math.floor(250 * (1 - t) + 244 * t); g = Math.floor(204 * (1 - t) + 63 * t); b = Math.floor(21 * (1 - t) + 94 * t);
  }
  return `rgb(${r}, ${g}, ${b})`;
}

async function initMathDashboard() {
  try {
    const response = await fetch('/analysis.json');
    if (!response.ok) throw new Error("Could not load analysis.json");
    analysisData = await response.json();

    resizeCanvases();
    setupMetadata();
    setupAudioPlayer();
    buildOffscreenStaticSpectrogram();
    buildOffscreenStaticNovelty();

    drawStaticCanvasesOnce();
    startAnimationLoop();

    if (cqtCanvas) cqtCanvas.addEventListener('click', handleCanvasClick);
    if (noveltyCanvas) noveltyCanvas.addEventListener('click', handleCanvasClick);
    window.addEventListener('resize', onWindowResize);

  } catch (err) {
    console.error("Math Dashboard Init Error:", err);
    if (trackMeta) {
      trackMeta.innerHTML = `<span style="color: #f43f5e">Ошибка: ${err.message}. Запустите data_exporter.py!</span>`;
    }
  }
}

function resizeCanvases() {
  if (cqtCanvas && cqtCanvas.parentElement) {
    cqtCanvas.width = cqtCanvas.parentElement.clientWidth;
    cqtCanvas.height = 200;
  }
  if (noveltyCanvas && noveltyCanvas.parentElement) {
    noveltyCanvas.width = noveltyCanvas.parentElement.clientWidth;
    noveltyCanvas.height = 160;
  }
  if (rawBandsCanvas && rawBandsCanvas.parentElement) {
    rawBandsCanvas.width = rawBandsCanvas.parentElement.clientWidth;
    rawBandsCanvas.height = 220;
  }
  if (sliceCanvas && sliceCanvas.parentElement) {
    sliceCanvas.width = sliceCanvas.parentElement.clientWidth;
    sliceCanvas.height = 220;
  }
}

function drawStaticCanvasesOnce() {
  if (cqtCanvas && offscreenCqtCanvas.width > 0) {
    cqtCtx.clearRect(0, 0, cqtCanvas.width, cqtCanvas.height);
    cqtCtx.drawImage(offscreenCqtCanvas, 0, 0, cqtCanvas.width, cqtCanvas.height);
  }
  if (noveltyCanvas && offscreenNoveltyCanvas.width > 0) {
    noveltyCtx.clearRect(0, 0, noveltyCanvas.width, noveltyCanvas.height);
    noveltyCtx.drawImage(offscreenNoveltyCanvas, 0, 0, noveltyCanvas.width, noveltyCanvas.height);
  }
}

function onWindowResize() {
  resizeCanvases();
  if (analysisData) {
    buildOffscreenStaticNovelty();
    drawStaticCanvasesOnce();
  }
}

function setupMetadata() {
  if (!analysisData || !trackMeta) return;
  const meta = analysisData.metadata;

  trackMeta.innerHTML = `
    <span class="meta-tag">🎵 ${meta.title}</span>
    <span class="meta-tag">⏱ ${meta.duration_sec}с</span>
    <span class="meta-tag">📡 ${meta.sample_rate} Гц</span>
    <span class="meta-tag">📊 4 полосы (Pure DSP)</span>
  `;
}

function setupAudioPlayer() {
  const audioFile = analysisData.metadata.audio_filename;
  audioPlayer.src = `/audio/${audioFile}`;

  btnPlayPause.addEventListener('click', togglePlayPause);
}

function togglePlayPause() {
  if (audioPlayer.paused) {
    audioPlayer.play();
    btnPlayPause.textContent = "⏸ Пауза";
  } else {
    audioPlayer.pause();
    btnPlayPause.textContent = "▶ Воспроизведение";
  }
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
  const width = noveltyCanvas ? (noveltyCanvas.width || 1400) : 1400;
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
      updateMathUI60FPS();
    }
    animFrameId = requestAnimationFrame(render);
  }
  animFrameId = requestAnimationFrame(render);
}

function updateMathUI60FPS() {
  const curTime = audioPlayer.currentTime || 0;
  const dur = audioPlayer.duration || analysisData.metadata.duration_sec || 1;

  const hopSec = analysisData.metadata.hop_length / analysisData.metadata.sample_rate;
  currentFrameIdx = Math.min(
    analysisData.metadata.n_frames - 1,
    Math.max(0, Math.floor(curTime / hopSec))
  );

  // 1. Render 4 Raw Band Onset Lanes
  renderRawBandsVisualization(curTime);

  // 2. Update CSS Playheads
  updatePlayheads(curTime, dur);

  // 3. Render Live 84-Bar Frame Slice & Indicator Dots
  renderSlice(currentFrameIdx);

  // 4. Update DOM Text
  if (timeDisplay) timeDisplay.textContent = `${formatTime(curTime)} / ${formatTime(dur)}`;
  if (currentFrameText) currentFrameText.textContent = `Фрейм m = ${currentFrameIdx} | t = ${curTime.toFixed(3)} с`;
}

function updatePlayheads(curTime, dur) {
  if (!dur || dur <= 0) return;
  const ratio = Math.max(0, Math.min(1, curTime / dur));

  if (cqtPlayhead && cqtCanvas) {
    cqtPlayhead.style.transform = `translate3d(${ratio * cqtCanvas.width}px, 0, 0)`;
  }
  if (noveltyPlayhead && noveltyCanvas) {
    noveltyPlayhead.style.transform = `translate3d(${ratio * noveltyCanvas.width}px, 0, 0)`;
  }
}

/**
 * Renders 4 Raw Multi-Band Horizontal Onset Lanes (Pure DSP Signal, No Game Filters)
 */
function renderRawBandsVisualization(curTime) {
  if (!rawCtx || !rawBandsCanvas) return;
  const width = rawBandsCanvas.width;
  const height = rawBandsCanvas.height;

  rawCtx.clearRect(0, 0, width, height);

  const xHit = 95;
  const lookaheadSec = 3.0;
  const laneHeight = height / 4;
  const nowMs = performance.now();

  const activeHits = [false, false, false, false];

  // Draw 4 Horizontal Lanes Background
  for (let b = 0; b < 4; b++) {
    const yTop = b * laneHeight;
    const color = BAND_COLORS[b];

    rawCtx.fillStyle = (b % 2 === 0) ? 'rgba(15, 23, 42, 0.85)' : 'rgba(30, 41, 59, 0.55)';
    rawCtx.fillRect(0, yTop, width, laneHeight);

    rawCtx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    rawCtx.lineWidth = 1;
    rawCtx.strokeRect(0, yTop, width, laneHeight);

    rawCtx.fillStyle = color;
    rawCtx.font = '700 11px "JetBrains Mono", monospace';
    rawCtx.fillText(BAND_NAMES[b], 8, yTop + laneHeight / 2 + 4);
  }

  // Draw Hit Target Line
  rawCtx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  rawCtx.lineWidth = 3;
  rawCtx.beginPath();
  rawCtx.moveTo(xHit, 0);
  rawCtx.lineTo(xHit, height);
  rawCtx.stroke();

  // Render Pure DSP Onset Peaks
  if (analysisData && analysisData.multiband && analysisData.multiband.peaks_sec_bands) {
    const peaksBands = analysisData.multiband.peaks_sec_bands;
    const minTime = curTime - 0.5;
    const maxTime = curTime + lookaheadSec;

    for (let b = 0; b < 4; b++) {
      const bandPeaks = peaksBands[b];
      const yCenter = b * laneHeight + laneHeight / 2;
      const color = BAND_COLORS[b];

      bandPeaks.forEach(tPeak => {
        if (tPeak < minTime || tPeak > maxTime) return;

        const dt = tPeak - curTime;
        const xPos = xHit + (dt / lookaheadSec) * (width - xHit);

        if (dt >= -0.06 && dt <= 0.08) {
          activeHits[b] = true;
          lastAttackTimes[b] = nowMs;
        }

        if (xPos >= xHit - 15 && xPos <= width + 15) {
          rawCtx.fillStyle = color;
          rawCtx.beginPath();
          rawCtx.arc(xPos, yCenter, 8, 0, Math.PI * 2);
          rawCtx.fill();
          rawCtx.strokeStyle = '#ffffff';
          rawCtx.lineWidth = 1.5;
          rawCtx.stroke();
        }
      });
    }
  }

  // Indicator dots
  for (let b = 0; b < 4; b++) {
    const isHitActive = activeHits[b] || (nowMs - lastAttackTimes[b] < 120);
    const indBox = indBands[b];
    if (indBox) {
      if (isHitActive && !indBox.classList.contains('active')) indBox.classList.add('active');
      else if (!isHitActive && indBox.classList.contains('active')) indBox.classList.remove('active');
    }
  }
}

function renderSlice(frameIdx) {
  if (!sliceCtx || !sliceCanvas) return;
  const width = sliceCanvas.width;
  const height = sliceCanvas.height;
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

document.addEventListener('DOMContentLoaded', initMathDashboard);
