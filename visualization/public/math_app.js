/**
 * SoundCount Pure Sprint 1 DSP Math Dashboard
 * With Real-Time Frequency Range Isolation & Physical Audio Filtering:
 * 1. Restrict analysis & audio playback to ANY frequency range [filterLow, filterHigh]
 * 2. Physical zero-phase brickwall audio filtering: plays pre-filtered / on-demand filtered audio files
 *    (Listen to ONLY the bass, ONLY the vocals, or ONLY the highs with 0% leak!)
 * 3. 4 Parallel lanes display pure DSP spectral flux onsets (multiband.peaks_sec_bands)
 *    - Inactive lanes outside the frequency range are dimmed & muted
 *    - Active lanes pulse on attack hits
 * 4. Dynamic 512-bin continuous Fourier curve with HARD ZERO cutoff outside [filterLow, filterHigh]
 * 5. Sliding 2D Spectrogram highlights the active frequency corridor and dims the rest
 * 6. Synchronized 60 FPS waterfall timeline aligned at X = 95px
 */

let analysisData = null;
let currentFrameIdx = 0;
let lastAttackTimes = [0, 0, 0, 0];
let animFrameId = null;
let viewMode = 'curve'; // 'curve' | 'bars' | 'cqt'

// Frequency Range Isolation Filter State
let filterLow = 20;
let filterHigh = 11025;
let isFilterActive = false;
let currentAudioUrl = '';

// Web Audio API Hardware Analyser
let audioCtx = null;
let analyser = null;
let sourceNode = null;
let fftBuffer = null;
const FFT_SIZE = 1024; // Yields 512 frequency bins
const N_FFT_BINS = FFT_SIZE / 2; // 512

// DOM Elements
const audioPlayer = document.getElementById('audioPlayer');
const btnPlayPause = document.getElementById('btnPlayPause');
const timeDisplay = document.getElementById('timeDisplay');
const trackMeta = document.getElementById('trackMeta');
const currentFrameText = document.getElementById('currentFrameText');
const globalTimelineTrack = document.getElementById('globalTimelineTrack');
const globalTimelineFill = document.getElementById('globalTimelineFill');
const dominantPeakText = document.getElementById('dominantPeakText');
const fftFpsTag = document.getElementById('fftFpsTag');

const tabModeCurve = document.getElementById('tabModeCurve');
const tabModeBars = document.getElementById('tabModeBars');
const tabModeCqt = document.getElementById('tabModeCqt');

// Filter UI Elements
const filterAudioBadge = document.getElementById('filterAudioBadge');
const filterStatsText = document.getElementById('filterStatsText');
const btnPresetAll = document.getElementById('btnPresetAll');
const btnPresetBass = document.getElementById('btnPresetBass');
const btnPresetMids = document.getElementById('btnPresetMids');
const btnPresetHighs = document.getElementById('btnPresetHighs');
const btnPresetCustom = document.getElementById('btnPresetCustom');
const sliderFlow = document.getElementById('sliderFlow');
const sliderFhigh = document.getElementById('sliderFhigh');
const valFlow = document.getElementById('valFlow');
const valFhigh = document.getElementById('valFhigh');

const indBands = [
  document.getElementById('indBand0'),
  document.getElementById('indBand1'),
  document.getElementById('indBand2'),
  document.getElementById('indBand3')
];

// Canvases
const rawBandsCanvas = document.getElementById('rawBandsCanvas');
const rawCtx = rawBandsCanvas ? rawBandsCanvas.getContext('2d') : null;

const cqtCanvas = document.getElementById('cqtCanvas');
const cqtCtx = cqtCanvas ? cqtCanvas.getContext('2d') : null;

const noveltyCanvas = document.getElementById('noveltyCanvas');
const noveltyCtx = noveltyCanvas ? noveltyCanvas.getContext('2d') : null;

const sliceCanvas = document.getElementById('sliceCanvas');
const sliceCtx = sliceCanvas ? sliceCanvas.getContext('2d') : null;

// Pure Sprint 1 DSP 4-Band Constants
const BAND_COLORS = ['#f97316', '#eab308', '#10b981', '#06b6d4'];
const BAND_NAMES = ['🔴 BASS (32-130 Hz)', '🟡 TENOR (130-520 Hz)', '🟢 ALTO (520-2000 Hz)', '🔵 SOPRANO (2-11 kHz)'];
const BAND_FREQ_RANGES = [
  [32.7, 130.8],
  [130.8, 523.2],
  [523.2, 2093.0],
  [2093.0, 11025.0]
];

// Offscreen Pre-rendered Heatmap
let offscreenCqtCanvas = document.createElement('canvas');

// FPS counter
let lastFpsTime = performance.now();
let frameCount = 0;
let currentFps = 60;

// Debounce timer for custom filter API
let customFilterDebounceTimer = null;

// Musical Note Frequency Lookup (Equal Temperament A4 = 440 Hz)
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function freqToNoteName(freq) {
  if (freq < 20) return "Sub-bass";
  const noteNum = 12 * (Math.log2(freq / 440)) + 69;
  const rounded = Math.round(noteNum);
  const octave = Math.floor(rounded / 12) - 1;
  const noteIdx = ((rounded % 12) + 12) % 12;
  return `${NOTE_NAMES[noteIdx]}${octave}`;
}

/**
 * Color map for spectrogram dB values (-80 dB to 0 dB)
 */
function getHeatmapRgb(db) {
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
  return { r, g, b };
}

/**
 * Checks if a frequency band [bandLow, bandHigh] overlaps with the active filter range [filterLow, filterHigh]
 */
function isBandActive(bandLow, bandHigh) {
  if (!isFilterActive) return true;
  return !(bandHigh < filterLow || bandLow > filterHigh);
}

/**
 * Initializes the pure Math dashboard
 */
async function initMathDashboard() {
  try {
    const response = await fetch('/analysis.json');
    if (!response.ok) throw new Error("Could not load analysis.json");
    analysisData = await response.json();

    resizeCanvases();
    setupMetadata();
    setupAudioPlayer();
    setupTimelineScrubber();
    setupModeTabs();
    setupBandpassFilterControls();
    buildOffscreenSpectrogramHeatmap();

    startAnimationLoop();

    window.addEventListener('resize', onWindowResize);
  } catch (err) {
    console.error("Math Dashboard Init Error:", err);
    if (trackMeta) {
      trackMeta.innerHTML = `<span style="color: #f43f5e">Ошибка: ${err.message}. Проверьте сервер и analysis.json!</span>`;
    }
  }
}

/**
 * Initialize Web Audio API hardware AnalyserNode
 */
function initWebAudio() {
  if (audioCtx) return;
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContext();

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = FFT_SIZE; // 1024 -> 512 frequency bins
    analyser.smoothingTimeConstant = 0.60;
    analyser.minDecibels = -85;
    analyser.maxDecibels = -10;

    sourceNode = audioCtx.createMediaElementSource(audioPlayer);
    sourceNode.connect(analyser);
    analyser.connect(audioCtx.destination);

    fftBuffer = new Uint8Array(analyser.frequencyBinCount);
    console.log("Hardware Web Audio FFT Analyser initialized: 512 frequency bins.");
  } catch (err) {
    console.warn("Web Audio API init:", err);
  }
}

/**
 * Seamlessly switch audio player source while maintaining currentTime & play state
 */
function switchAudioSource(newUrl) {
  if (currentAudioUrl === newUrl) return;
  currentAudioUrl = newUrl;

  const curTime = audioPlayer.currentTime || 0;
  const isPlaying = !audioPlayer.paused;

  audioPlayer.src = newUrl;
  audioPlayer.currentTime = curTime;

  if (isPlaying) {
    audioPlayer.play().catch(e => console.warn("Audio play error:", e));
  }
}

/**
 * Applies current filter range:
 * 1. Switches audio to physically brickwall filtered audio (scipy zero-phase filter)
 * 2. Updates badges and UI indicators
 */
async function applyFilterRange(low, high, isActive) {
  filterLow = low;
  filterHigh = high;
  isFilterActive = isActive;

  if (!isFilterActive || (filterLow <= 25 && filterHigh >= 11000)) {
    if (filterAudioBadge) {
      filterAudioBadge.className = 'filter-audio-badge bypass';
      filterAudioBadge.textContent = '🔊 АУДИОФИЛЬТР: ВЫКЛ (Весь спектр)';
    }
    if (filterStatsText) {
      filterStatsText.textContent = 'Активны все 4 полосы (Bass, Tenor, Alto, Soprano) | Исходный трек';
    }
    switchAudioSource('/audio/test_music.mp3');
  } else {
    if (filterAudioBadge) {
      filterAudioBadge.className = 'filter-audio-badge active';
      filterAudioBadge.textContent = `🔊 АУДИОФИЛЬТР: АКТИВЕН [${filterLow} Гц — ${filterHigh} Гц]`;
    }

    // Determine active bands
    let activeBandsCount = 0;
    for (let b = 0; b < 4; b++) {
      if (isBandActive(BAND_FREQ_RANGES[b][0], BAND_FREQ_RANGES[b][1])) activeBandsCount++;
    }

    if (filterStatsText) {
      filterStatsText.textContent = `Диапазон: ${filterLow} — ${filterHigh} Гц | Активно полос: ${activeBandsCount} из 4 | Обрезано всё остальное`;
    }

    // Request brickwall filtered audio from server
    try {
      const resp = await fetch(`/api/filter_audio?low=${filterLow}&high=${filterHigh}`);
      if (resp.ok) {
        const data = await resp.json();
        if (data.url) {
          switchAudioSource(data.url);
        }
      }
    } catch (err) {
      console.warn("Could not fetch filtered audio:", err);
    }
  }
}

/**
 * Setup Bandpass Filter Controls & Presets
 */
function setupBandpassFilterControls() {
  const presets = [
    { btn: btnPresetAll, low: 20, high: 11025, active: false },
    { btn: btnPresetBass, low: 30, high: 250, active: true },
    { btn: btnPresetMids, low: 250, high: 2500, active: true },
    { btn: btnPresetHighs, low: 2500, high: 11025, active: true }
  ];

  presets.forEach(({ btn, low, high, active }) => {
    if (!btn) return;
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      if (sliderFlow) sliderFlow.value = low;
      if (sliderFhigh) sliderFhigh.value = high;
      if (valFlow) valFlow.textContent = `${low} Гц`;
      if (valFhigh) valFhigh.textContent = `${high} Гц`;

      applyFilterRange(low, high, active);
    });
  });

  if (btnPresetCustom) {
    btnPresetCustom.addEventListener('click', () => {
      document.querySelectorAll('.filter-preset-btn').forEach(b => b.classList.remove('active'));
      btnPresetCustom.classList.add('active');
      applyFilterRange(filterLow, filterHigh, true);
    });
  }

  function onSliderChange() {
    isFilterActive = true;
    document.querySelectorAll('.filter-preset-btn').forEach(b => b.classList.remove('active'));
    if (btnPresetCustom) btnPresetCustom.classList.add('active');

    if (valFlow) valFlow.textContent = `${filterLow} Гц`;
    if (valFhigh) valFhigh.textContent = `${filterHigh} Гц`;

    if (customFilterDebounceTimer) clearTimeout(customFilterDebounceTimer);
    customFilterDebounceTimer = setTimeout(() => {
      applyFilterRange(filterLow, filterHigh, true);
    }, 350);
  }

  if (sliderFlow) {
    sliderFlow.addEventListener('input', (e) => {
      filterLow = parseInt(e.target.value);
      if (filterLow >= filterHigh) filterLow = filterHigh - 20;
      onSliderChange();
    });
  }

  if (sliderFhigh) {
    sliderFhigh.addEventListener('input', (e) => {
      filterHigh = parseInt(e.target.value);
      if (filterHigh <= filterLow) filterHigh = filterLow + 20;
      onSliderChange();
    });
  }
}

function resizeCanvases() {
  const containerWidth = rawBandsCanvas && rawBandsCanvas.parentElement ? rawBandsCanvas.parentElement.clientWidth : 1200;

  if (rawBandsCanvas) {
    rawBandsCanvas.width = containerWidth;
    rawBandsCanvas.height = 200;
  }
  if (cqtCanvas) {
    cqtCanvas.width = containerWidth;
    cqtCanvas.height = 180;
  }
  if (noveltyCanvas) {
    noveltyCanvas.width = containerWidth;
    noveltyCanvas.height = 150;
  }
  if (sliceCanvas && sliceCanvas.parentElement) {
    sliceCanvas.width = sliceCanvas.parentElement.clientWidth;
    sliceCanvas.height = 230;
  }
}

function onWindowResize() {
  resizeCanvases();
}

function setupMetadata() {
  if (!analysisData || !trackMeta) return;
  const meta = analysisData.metadata;

  trackMeta.innerHTML = `
    <span class="meta-tag">🎵 ${meta.title}</span>
    <span class="meta-tag">⏱ ${meta.duration_sec}с</span>
    <span class="meta-tag">📡 ${meta.sample_rate} Гц</span>
    <span class="meta-tag">⚡ 512 полос Фурье (FFT)</span>
    <span class="meta-tag">🎛️ Фильтр Баттерворта (Brickwall)</span>
  `;
}

function setupAudioPlayer() {
  const audioFile = analysisData.metadata.audio_filename;
  currentAudioUrl = `/audio/${audioFile}`;
  audioPlayer.crossOrigin = "anonymous";
  audioPlayer.src = currentAudioUrl;

  btnPlayPause.addEventListener('click', togglePlayPause);
  audioPlayer.addEventListener('play', () => {
    btnPlayPause.textContent = "⏸ Пауза";
    initWebAudio();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  });
  audioPlayer.addEventListener('pause', () => {
    btnPlayPause.textContent = "▶ Воспроизведение";
  });
}

function togglePlayPause() {
  initWebAudio();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();

  if (audioPlayer.paused) {
    audioPlayer.play();
  } else {
    audioPlayer.pause();
  }
}

function setupTimelineScrubber() {
  if (!globalTimelineTrack) return;

  function seekToPosition(e) {
    if (!analysisData) return;
    const rect = globalTimelineTrack.getBoundingClientRect();
    const clickX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const ratio = clickX / rect.width;
    const dur = audioPlayer.duration || analysisData.metadata.duration_sec || 1;
    audioPlayer.currentTime = ratio * dur;
  }

  globalTimelineTrack.addEventListener('click', seekToPosition);
}

function setupModeTabs() {
  const tabs = [
    { btn: tabModeCurve, mode: 'curve' },
    { btn: tabModeBars, mode: 'bars' },
    { btn: tabModeCqt, mode: 'cqt' }
  ];

  tabs.forEach(({ btn, mode }) => {
    if (!btn) return;
    btn.addEventListener('click', () => {
      tabs.forEach(t => t.btn && t.btn.classList.remove('active'));
      btn.classList.add('active');
      viewMode = mode;
    });
  });
}

/**
 * Pre-renders the full 2D CQT spectrogram matrix onto an offscreen canvas
 */
function buildOffscreenSpectrogramHeatmap() {
  const nBins = analysisData.metadata.n_bins;
  const nFrames = analysisData.metadata.n_frames;
  const dbMatrix = analysisData.spectrogram_db;

  offscreenCqtCanvas.width = nFrames;
  offscreenCqtCanvas.height = nBins;
  const ctx = offscreenCqtCanvas.getContext('2d');
  const imgData = ctx.createImageData(nFrames, nBins);

  for (let b = 0; b < nBins; b++) {
    const yBin = nBins - 1 - b; // High freqs at top, low freqs at bottom
    for (let f = 0; f < nFrames; f++) {
      const db = dbMatrix[b][f];
      const idx = (yBin * nFrames + f) * 4;
      const rgb = getHeatmapRgb(db);

      imgData.data[idx] = rgb.r;
      imgData.data[idx + 1] = rgb.g;
      imgData.data[idx + 2] = rgb.b;
      imgData.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);

  // Band separator lines
  const bandRanges = analysisData.metadata.band_ranges;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
  ctx.lineWidth = 1;
  bandRanges.forEach(([startBin, endBin]) => {
    const yLine = nBins - endBin;
    ctx.beginPath();
    ctx.moveTo(0, yLine);
    ctx.lineTo(nFrames, yLine);
    ctx.stroke();
  });
}

/**
 * 60 FPS Main Render Loop
 */
function startAnimationLoop() {
  function render(time) {
    if (analysisData) {
      updateMathDashboard60FPS(time);
    }
    animFrameId = requestAnimationFrame(render);
  }
  animFrameId = requestAnimationFrame(render);
}

function updateMathDashboard60FPS(timestamp) {
  const curTime = audioPlayer.currentTime || 0;
  const dur = audioPlayer.duration || analysisData.metadata.duration_sec || 1;

  // FPS calculation
  frameCount++;
  if (timestamp - lastFpsTime >= 500) {
    currentFps = Math.round((frameCount * 1000) / (timestamp - lastFpsTime));
    frameCount = 0;
    lastFpsTime = timestamp;
    if (fftFpsTag) fftFpsTag.textContent = `⚡ ${currentFps} FPS FFT`;
  }

  const hopSec = analysisData.metadata.hop_length / analysisData.metadata.sample_rate;
  currentFrameIdx = Math.min(
    analysisData.metadata.n_frames - 1,
    Math.max(0, Math.floor(curTime / hopSec))
  );

  const xHit = 95;
  const lookaheadSec = 3.0;

  // 1. Render Top Visualizer: 4 Raw Frequency Lanes (Sprint 1 DSP multiband.peaks_sec_bands)
  renderRawBandsVisualization(curTime, xHit, lookaheadSec);

  // 2. Render Synchronized Sliding 2D Spectrogram (Highlighted to Active Corridor)
  renderSlidingSpectrogram(curTime, xHit, lookaheadSec);

  // 3. Render Synchronized Sliding 4-Band Novelty Curves
  renderSlidingNovelty(curTime, xHit, lookaheadSec);

  // 4. Render Dynamic 512-bin Fast Fourier Transform (FFT) Continuous Curve (Strict zero outside range!)
  renderDynamicFourierSlice(currentFrameIdx);

  // 5. Update Global Progress Fill & Time Display
  if (globalTimelineFill) {
    const ratio = Math.max(0, Math.min(1, curTime / dur));
    globalTimelineFill.style.width = `${(ratio * 100).toFixed(2)}%`;
  }
  if (timeDisplay) timeDisplay.textContent = `${formatTime(curTime)} / ${formatTime(dur)}`;
  if (currentFrameText) currentFrameText.textContent = `Фрейм m = ${currentFrameIdx} | t = ${curTime.toFixed(3)} с`;
}

/**
 * 1. 4 Frequency Lanes (Sprint 1 Pure DSP Multi-Band Spectral Flux Onsets)
 * Uses analysisData.multiband.peaks_sec_bands[b] directly.
 * Zero game restrictions, zero corridor decay, zero debouncing.
 * When frequency isolation is active:
 * - Inactive bands outside [filterLow, filterHigh] are dimmed and silenced.
 * - Active bands pulse on attack hits.
 */
function renderRawBandsVisualization(curTime, xHit, lookaheadSec) {
  if (!rawCtx || !rawBandsCanvas) return;
  const width = rawBandsCanvas.width;
  const height = rawBandsCanvas.height;

  rawCtx.clearRect(0, 0, width, height);

  const laneHeight = height / 4;
  const nowMs = performance.now();
  const activeHits = [false, false, false, false];

  const minTime = curTime - (xHit / (width - xHit)) * lookaheadSec;
  const maxTime = curTime + lookaheadSec;

  // Draw 4 Horizontal Lanes Background
  for (let b = 0; b < 4; b++) {
    const yTop = b * laneHeight;
    const color = BAND_COLORS[b];
    const isBandInFilter = isBandActive(BAND_FREQ_RANGES[b][0], BAND_FREQ_RANGES[b][1]);

    // Lane background
    if (isBandInFilter) {
      rawCtx.fillStyle = (b % 2 === 0) ? 'rgba(15, 23, 42, 0.85)' : 'rgba(30, 41, 59, 0.55)';
    } else {
      rawCtx.fillStyle = 'rgba(10, 15, 28, 0.95)'; // Dimmed inactive lane
    }
    rawCtx.fillRect(0, yTop, width, laneHeight);

    rawCtx.strokeStyle = isBandInFilter ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.03)';
    rawCtx.lineWidth = 1;
    rawCtx.strokeRect(0, yTop, width, laneHeight);

    // Lane title
    rawCtx.fillStyle = isBandInFilter ? color : 'rgba(148, 163, 184, 0.3)';
    rawCtx.font = '700 11px "JetBrains Mono", monospace';
    const labelText = isBandInFilter ? BAND_NAMES[b] : `${BAND_NAMES[b]} [ОТФИЛЬТРОВАНО]`;
    rawCtx.fillText(labelText, 8, yTop + laneHeight / 2 + 4);
  }

  // Draw Vertical Hit Target Line
  rawCtx.strokeStyle = '#ef4444';
  rawCtx.lineWidth = 2.5;
  rawCtx.beginPath();
  rawCtx.moveTo(xHit, 0);
  rawCtx.lineTo(xHit, height);
  rawCtx.stroke();

  // Render Pure Sprint 1 DSP Onset Peaks
  if (analysisData && analysisData.multiband && analysisData.multiband.peaks_sec_bands) {
    const peaksBands = analysisData.multiband.peaks_sec_bands;

    for (let b = 0; b < 4; b++) {
      const isBandInFilter = isBandActive(BAND_FREQ_RANGES[b][0], BAND_FREQ_RANGES[b][1]);
      if (!isBandInFilter) continue; // Skip onsets for inactive filtered bands!

      const bandPeaks = peaksBands[b];
      const yCenter = b * laneHeight + laneHeight / 2;
      const color = BAND_COLORS[b];

      for (let i = 0; i < bandPeaks.length; i++) {
        const tPeak = bandPeaks[i];
        if (tPeak < minTime || tPeak > maxTime) continue;

        const dt = tPeak - curTime;
        const xPos = xHit + (dt / lookaheadSec) * (width - xHit);

        if (dt >= -0.05 && dt <= 0.06) {
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
      }
    }
  }

  // Update Band Indicator Badges
  for (let b = 0; b < 4; b++) {
    const isBandInFilter = isBandActive(BAND_FREQ_RANGES[b][0], BAND_FREQ_RANGES[b][1]);
    const isHitActive = isBandInFilter && (activeHits[b] || (nowMs - lastAttackTimes[b] < 120));
    const indBox = indBands[b];
    if (indBox) {
      if (!isBandInFilter) {
        indBox.style.opacity = '0.3';
        indBox.classList.remove('active');
      } else {
        indBox.style.opacity = '1.0';
        if (isHitActive && !indBox.classList.contains('active')) indBox.classList.add('active');
        else if (!isHitActive && indBox.classList.contains('active')) indBox.classList.remove('active');
      }
    }
  }
}

/**
 * 2. Synchronized Sliding 2D Spectrogram (Waterfall)
 * When frequency isolation is active:
 * - Highlights the active frequency corridor [filterLow, filterHigh]
 * - Dims out frequencies outside the range
 */
function renderSlidingSpectrogram(curTime, xHit, lookaheadSec) {
  if (!cqtCtx || !cqtCanvas || offscreenCqtCanvas.width === 0) return;
  const width = cqtCanvas.width;
  const height = cqtCanvas.height;

  cqtCtx.clearRect(0, 0, width, height);

  const sampleRate = analysisData.metadata.sample_rate;
  const hopLength = analysisData.metadata.hop_length;
  const hopSec = hopLength / sampleRate;
  const nFrames = analysisData.metadata.n_frames;
  const nBins = analysisData.metadata.n_bins;

  const dtLeft = (xHit / (width - xHit)) * lookaheadSec;
  const tStart = curTime - dtLeft;
  const tEnd = curTime + lookaheadSec;

  const fStart = tStart / hopSec;
  const fEnd = tEnd / hopSec;

  // Render the precomputed spectrogram slice
  if (tStart < 0) {
    const xZero = xHit + (-curTime / lookaheadSec) * (width - xHit);
    cqtCtx.fillStyle = '#020617';
    cqtCtx.fillRect(0, 0, Math.max(0, xZero), height);

    const srcX = 0;
    const srcW = Math.min(nFrames, fEnd);
    const destX = Math.max(0, xZero);
    const destW = width - destX;

    if (srcW > 0 && destW > 0) {
      cqtCtx.imageSmoothingEnabled = true;
      cqtCtx.drawImage(offscreenCqtCanvas, srcX, 0, srcW, nBins, destX, 0, destW, height);
    }
  } else {
    const srcX = Math.max(0, Math.min(nFrames - 1, fStart));
    const srcW = Math.max(1, Math.min(nFrames - srcX, fEnd - fStart));

    cqtCtx.imageSmoothingEnabled = true;
    cqtCtx.drawImage(offscreenCqtCanvas, srcX, 0, srcW, nBins, 0, 0, width, height);
  }

  // If Frequency Range Isolation is Active:
  // Shade out frequencies outside [filterLow, filterHigh]
  if (isFilterActive && analysisData.frequencies) {
    const freqs = analysisData.frequencies;
    let binLow = 0;
    let binHigh = nBins - 1;

    for (let b = 0; b < nBins; b++) {
      if (freqs[b] <= filterLow) binLow = b;
      if (freqs[b] <= filterHigh) binHigh = b;
    }

    const yHigh = height - (binHigh / nBins) * height; // Top of active corridor
    const yLow = height - (binLow / nBins) * height;   // Bottom of active corridor

    // Dim region ABOVE filterHigh
    if (yHigh > 0) {
      cqtCtx.fillStyle = 'rgba(2, 6, 23, 0.85)';
      cqtCtx.fillRect(0, 0, width, yHigh);

      cqtCtx.strokeStyle = '#38bdf8';
      cqtCtx.lineWidth = 1.5;
      cqtCtx.setLineDash([4, 4]);
      cqtCtx.beginPath();
      cqtCtx.moveTo(0, yHigh);
      cqtCtx.lineTo(width, yHigh);
      cqtCtx.stroke();
      cqtCtx.setLineDash([]);

      cqtCtx.fillStyle = '#38bdf8';
      cqtCtx.font = '700 10px "JetBrains Mono", monospace';
      cqtCtx.fillText(`▼ F max: ${filterHigh} Гц`, width - 130, yHigh + 12);
    }

    // Dim region BELOW filterLow
    if (yLow < height) {
      cqtCtx.fillStyle = 'rgba(2, 6, 23, 0.85)';
      cqtCtx.fillRect(0, yLow, width, height - yLow);

      cqtCtx.strokeStyle = '#f97316';
      cqtCtx.lineWidth = 1.5;
      cqtCtx.setLineDash([4, 4]);
      cqtCtx.beginPath();
      cqtCtx.moveTo(0, yLow);
      cqtCtx.lineTo(width, yLow);
      cqtCtx.stroke();
      cqtCtx.setLineDash([]);

      cqtCtx.fillStyle = '#f97316';
      cqtCtx.font = '700 10px "JetBrains Mono", monospace';
      cqtCtx.fillText(`▲ F min: ${filterLow} Гц`, width - 130, yLow - 4);
    }
  }

  // Draw Synchronized Vertical Hit Target Line (Matching X = 95px)
  cqtCtx.strokeStyle = '#ef4444';
  cqtCtx.lineWidth = 2.5;
  cqtCtx.beginPath();
  cqtCtx.moveTo(xHit, 0);
  cqtCtx.lineTo(xHit, height);
  cqtCtx.stroke();
}

/**
 * 3. Synchronized Sliding 4-Band Spectral Flux Novelty Curves
 */
function renderSlidingNovelty(curTime, xHit, lookaheadSec) {
  if (!noveltyCtx || !noveltyCanvas) return;
  const width = noveltyCanvas.width;
  const height = noveltyCanvas.height;

  noveltyCtx.clearRect(0, 0, width, height);

  const sampleRate = analysisData.metadata.sample_rate;
  const hopLength = analysisData.metadata.hop_length;
  const hopSec = hopLength / sampleRate;
  const nFrames = analysisData.metadata.n_frames;

  const dtLeft = (xHit / (width - xHit)) * lookaheadSec;
  const tStart = curTime - dtLeft;
  const tEnd = curTime + lookaheadSec;

  const fStart = Math.max(0, Math.floor(tStart / hopSec));
  const fEnd = Math.min(nFrames - 1, Math.ceil(tEnd / hopSec));

  const sfBands = analysisData.multiband.sf_bands;
  const thBands = analysisData.multiband.thresholds_bands;
  const bandHeight = height / 4;

  for (let b = 0; b < 4; b++) {
    const yOffset = b * bandHeight;
    const color = BAND_COLORS[b];
    const isBandInFilter = isBandActive(BAND_FREQ_RANGES[b][0], BAND_FREQ_RANGES[b][1]);

    // Background lane
    noveltyCtx.fillStyle = isBandInFilter
      ? ((b % 2 === 0) ? 'rgba(15, 23, 42, 0.75)' : 'rgba(30, 41, 59, 0.45)')
      : 'rgba(10, 15, 28, 0.95)';
    noveltyCtx.fillRect(0, yOffset, width, bandHeight);

    noveltyCtx.strokeStyle = isBandInFilter ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.03)';
    noveltyCtx.lineWidth = 1;
    noveltyCtx.strokeRect(0, yOffset, width, bandHeight);

    // Label
    noveltyCtx.fillStyle = isBandInFilter ? color : 'rgba(148, 163, 184, 0.3)';
    noveltyCtx.font = '700 10px "JetBrains Mono", monospace';
    noveltyCtx.fillText(isBandInFilter ? (BAND_NAMES[b].split(' ')[1] || `Band ${b+1}`) : `${BAND_NAMES[b].split(' ')[1]} [CUT]`, 8, yOffset + 14);

    if (!isBandInFilter) continue; // Don't draw curve for filtered out bands!

    // Draw Novelty Curve
    noveltyCtx.beginPath();
    noveltyCtx.strokeStyle = color;
    noveltyCtx.lineWidth = 1.6;

    let firstPoint = true;
    for (let f = fStart; f <= fEnd; f++) {
      const t = f * hopSec;
      const x = xHit + ((t - curTime) / lookaheadSec) * (width - xHit);
      const val = sfBands[b][f] || 0;
      const y = yOffset + bandHeight - (val * (bandHeight - 6));

      if (firstPoint) {
        noveltyCtx.moveTo(x, y);
        firstPoint = false;
      } else {
        noveltyCtx.lineTo(x, y);
      }
    }
    noveltyCtx.stroke();

    // Draw Dynamic Adaptive Threshold (Dashed Red Line)
    noveltyCtx.beginPath();
    noveltyCtx.strokeStyle = '#f43f5e';
    noveltyCtx.lineWidth = 1.0;
    noveltyCtx.setLineDash([3, 3]);

    firstPoint = true;
    for (let f = fStart; f <= fEnd; f++) {
      const t = f * hopSec;
      const x = xHit + ((t - curTime) / lookaheadSec) * (width - xHit);
      const th = thBands[b][f] || 0;
      const y = yOffset + bandHeight - (th * (bandHeight - 6));

      if (firstPoint) {
        noveltyCtx.moveTo(x, y);
        firstPoint = false;
      } else {
        noveltyCtx.lineTo(x, y);
      }
    }
    noveltyCtx.stroke();
    noveltyCtx.setLineDash([]);
  }

  // Draw Vertical Hit Target Line (Matching X = 95px)
  noveltyCtx.strokeStyle = '#ef4444';
  noveltyCtx.lineWidth = 2.5;
  noveltyCtx.beginPath();
  noveltyCtx.moveTo(xHit, 0);
  noveltyCtx.lineTo(xHit, height);
  noveltyCtx.stroke();
}

/**
 * 4. Dynamic Live Fast Fourier Transform (FFT / STFT) Slice
 * - 512 Frequency Bins (6x more bars than 84 CQT)
 * - Silky smooth continuous glowing spectral envelope curve
 * - HARD ZERO cutoff outside active frequency range [filterLow, filterHigh]!
 */
function renderDynamicFourierSlice(frameIdx) {
  if (!sliceCtx || !sliceCanvas) return;
  const width = sliceCanvas.width;
  const height = sliceCanvas.height;
  sliceCtx.clearRect(0, 0, width, height);

  if (!analysisData) return;

  const sr = analysisData.metadata.sample_rate || 22050;

  // 1. Get 512-point frequency amplitudes:
  const amplitudes = new Float32Array(N_FFT_BINS);
  let maxAmp = 0;
  let maxBin = 0;

  if (analyser && !audioPlayer.paused && fftBuffer) {
    analyser.getByteFrequencyData(fftBuffer);
    for (let i = 0; i < N_FFT_BINS; i++) {
      const freq = (i / N_FFT_BINS) * (sr / 2);

      // HARD CUTOFF: If frequency isolation is active, strictly zero out outside [filterLow, filterHigh]!
      if (isFilterActive && (freq < filterLow || freq > filterHigh)) {
        amplitudes[i] = 0;
        continue;
      }

      const val = fftBuffer[i] / 255.0;
      amplitudes[i] = val;
      if (val > maxAmp) {
        maxAmp = val;
        maxBin = i;
      }
    }
  } else {
    // Interpolate from 84 CQT bins to 512 points
    const nCqt = analysisData.metadata.n_bins;
    const dbMatrix = analysisData.spectrogram_db;

    for (let i = 0; i < N_FFT_BINS; i++) {
      const freq = (i / N_FFT_BINS) * (sr / 2);

      // HARD CUTOFF outside active range
      if (isFilterActive && (freq < filterLow || freq > filterHigh)) {
        amplitudes[i] = 0;
        continue;
      }

      const cqtPos = (i / N_FFT_BINS) * (nCqt - 1);
      const idxLow = Math.floor(cqtPos);
      const idxHigh = Math.min(nCqt - 1, idxLow + 1);
      const frac = cqtPos - idxLow;

      const dbLow = dbMatrix[idxLow][frameIdx] || -80;
      const dbHigh = dbMatrix[idxHigh][frameIdx] || -80;

      const mu = (1 - Math.cos(frac * Math.PI)) / 2;
      const db = dbLow * (1 - mu) + dbHigh * mu;

      const norm = Math.max(0, Math.min(1, (db + 80) / 80));
      amplitudes[i] = norm;

      if (norm > maxAmp) {
        maxAmp = norm;
        maxBin = i;
      }
    }
  }

  // Dominant Peak Frequency & Note Name
  const domFreq = (maxBin / N_FFT_BINS) * (sr / 2);
  const domNote = freqToNoteName(domFreq);
  if (dominantPeakText && maxAmp > 0.06) {
    dominantPeakText.innerHTML = `🎯 Фурье-пик: <span class="peak-tag">${domFreq.toFixed(1)} Гц (${domNote})</span> | Уровень: ${(maxAmp * 100).toFixed(0)}% | ${isFilterActive ? `Полоса: ${filterLow} — ${filterHigh} Гц (Обрезано снаружи)` : 'Весь спектр'}`;
  }

  // Render Based on Selected View Mode:
  if (viewMode === 'cqt') {
    renderOriginalCqtBars(frameIdx, width, height);
    return;
  }

  const usableHeight = height - 35;
  const barWidth = width / N_FFT_BINS;

  // Active range pixel bounds on X axis
  const xFilterLow = (filterLow / (sr / 2)) * width;
  const xFilterHigh = (filterHigh / (sr / 2)) * width;

  // MODE 1 & 2: 512 Dense Micro-Bars
  for (let b = 0; b < N_FFT_BINS; b++) {
    const freq = (b / N_FFT_BINS) * (sr / 2);
    const amp = amplitudes[b];
    if (amp <= 0.001) continue; // Don't draw bars outside range!

    const barHeight = amp * usableHeight;
    const x = b * barWidth;
    const y = height - 25 - barHeight;

    // Multi-band color matching
    let color = BAND_COLORS[3];
    if (freq < BAND_FREQ_RANGES[0][1]) color = BAND_COLORS[0];
    else if (freq < BAND_FREQ_RANGES[1][1]) color = BAND_COLORS[1];
    else if (freq < BAND_FREQ_RANGES[2][1]) color = BAND_COLORS[2];

    if (viewMode === 'curve') {
      sliceCtx.fillStyle = colorWithAlpha(color, 0.45);
    } else {
      sliceCtx.fillStyle = color;
    }
    sliceCtx.fillRect(x, y, Math.max(1, barWidth - 0.4), barHeight);
  }

  // MODE 1: Smooth Continuous Spectral Envelope Curve
  if (viewMode === 'curve') {
    const grad = sliceCtx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, 'rgba(56, 189, 248, 0.45)');
    grad.addColorStop(0.5, 'rgba(16, 185, 129, 0.20)');
    grad.addColorStop(1, 'rgba(15, 23, 42, 0.0)');

    sliceCtx.beginPath();
    sliceCtx.moveTo(0, height - 25);

    const step = 2;
    for (let b = 0; b < N_FFT_BINS; b += step) {
      const x = b * barWidth;
      const amp = amplitudes[b];
      const y = height - 25 - (amp * usableHeight);
      sliceCtx.lineTo(x, y);
    }
    sliceCtx.lineTo(width, height - 25);
    sliceCtx.closePath();
    sliceCtx.fillStyle = grad;
    sliceCtx.fill();

    // Continuous Glowing Line
    sliceCtx.beginPath();
    sliceCtx.strokeStyle = '#38bdf8';
    sliceCtx.lineWidth = 2.2;
    sliceCtx.shadowColor = '#38bdf8';
    sliceCtx.shadowBlur = 8;

    for (let b = 0; b < N_FFT_BINS; b += step) {
      const x = b * barWidth;
      const amp = amplitudes[b];
      const y = height - 25 - (amp * usableHeight);
      if (b === 0) sliceCtx.moveTo(x, y);
      else sliceCtx.lineTo(x, y);
    }
    sliceCtx.stroke();
    sliceCtx.shadowBlur = 0;

    // Peak Marker Pin (Only within active range!)
    if (maxAmp > 0.08 && domFreq >= filterLow && domFreq <= filterHigh) {
      const peakX = maxBin * barWidth;
      const peakY = height - 25 - (maxAmp * usableHeight);

      sliceCtx.fillStyle = '#f43f5e';
      sliceCtx.beginPath();
      sliceCtx.arc(peakX, peakY, 4.5, 0, Math.PI * 2);
      sliceCtx.fill();
      sliceCtx.strokeStyle = '#ffffff';
      sliceCtx.lineWidth = 1.5;
      sliceCtx.stroke();

      sliceCtx.fillStyle = '#ffffff';
      sliceCtx.font = '700 10px "JetBrains Mono", monospace';
      sliceCtx.fillText(`${domFreq.toFixed(0)} Hz (${domNote})`, Math.min(width - 80, Math.max(10, peakX - 25)), Math.max(20, peakY - 8));
    }
  }

  // Draw Active Bandpass Corridor Boundary Lines
  if (isFilterActive) {
    sliceCtx.strokeStyle = '#10b981';
    sliceCtx.lineWidth = 1.8;
    sliceCtx.setLineDash([4, 4]);

    // F min boundary line
    sliceCtx.beginPath();
    sliceCtx.moveTo(xFilterLow, 0);
    sliceCtx.lineTo(xFilterLow, height - 25);
    sliceCtx.stroke();

    // F max boundary line
    sliceCtx.beginPath();
    sliceCtx.moveTo(xFilterHigh, 0);
    sliceCtx.lineTo(xFilterHigh, height - 25);
    sliceCtx.stroke();
    sliceCtx.setLineDash([]);

    // Highlight active zone
    sliceCtx.fillStyle = 'rgba(16, 185, 129, 0.06)';
    sliceCtx.fillRect(xFilterLow, 0, xFilterHigh - xFilterLow, height - 25);

    // Text labels at boundaries
    sliceCtx.fillStyle = '#10b981';
    sliceCtx.font = '700 9px "JetBrains Mono", monospace';
    sliceCtx.fillText(`[F min: ${filterLow}Hz]`, Math.max(5, xFilterLow + 4), 14);
    sliceCtx.fillText(`[F max: ${filterHigh}Hz]`, Math.min(width - 95, xFilterHigh - 95), 14);
  }

  // Draw Bottom Base Axis Line
  sliceCtx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
  sliceCtx.lineWidth = 1;
  sliceCtx.beginPath();
  sliceCtx.moveTo(0, height - 25);
  sliceCtx.lineTo(width, height - 25);
  sliceCtx.stroke();
}

/**
 * Original CQT 84-note bar visualizer
 */
function renderOriginalCqtBars(frameIdx, width, height) {
  const nBins = analysisData.metadata.n_bins;
  const dbMatrix = analysisData.spectrogram_db;
  const barWidth = width / nBins;
  const bandRanges = analysisData.metadata.band_ranges;
  const freqs = analysisData.frequencies || [];

  for (let b = 0; b < nBins; b++) {
    const f = freqs[b] || 200;
    if (isFilterActive && (f < filterLow || f > filterHigh)) continue;

    const db = dbMatrix[b][frameIdx] || -80;
    const norm = Math.max(0, Math.min(1, (db + 80) / 80));
    const barHeight = norm * (height - 35);
    const x = b * barWidth;
    const y = height - barHeight - 25;

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

function colorWithAlpha(hexColor, alpha) {
  const r = parseInt(hexColor.slice(1, 3), 16);
  const g = parseInt(hexColor.slice(3, 5), 16);
  const b = parseInt(hexColor.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(3);
  return `${m.toString().padStart(2, '0')}:${s.padStart(6, '0')}`;
}

document.addEventListener('DOMContentLoaded', initMathDashboard);
