/**
 * SoundCount Pure Sprint 1 DSP Math Dashboard
 * With Real-Time Frequency Range Isolation & Hardware Audio Bandpass Filter:
 * 1. Restrict analysis & gameplay to ANY frequency range [f_low, f_high]
 * 2. Real-time audio playback isolation: steep 24/48 dB/oct BiquadFilter cascade
 *    (Listen to ONLY the bass, ONLY the vocals, or any custom bandpass slice)
 * 3. 4 Parallel lanes dynamically partition the active band into 4 sub-ranges
 * 4. 2D Spectrogram highlights the isolated frequency corridor and dims the rest
 * 5. Dynamic 512-bin continuous Fourier curve with glowing boundary markers
 * 6. Synchronized 60 FPS sliding window waterfall timeline aligned at X = 95px
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

// Web Audio API Hardware Audio Chain & FFT
let audioCtx = null;
let analyser = null;
let sourceNode = null;
let highpass1 = null;
let highpass2 = null;
let lowpass1 = null;
let lowpass2 = null;
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

// Band Styling Constants
const BAND_COLORS = ['#f97316', '#eab308', '#10b981', '#06b6d4'];
const DEFAULT_BAND_NAMES = ['🔴 BASS (32-130 Hz)', '🟡 TENOR (130-520 Hz)', '🟢 ALTO (520-2000 Hz)', '🔵 SOPRANO (2-11 kHz)'];
const DEFAULT_FREQ_RANGES = [
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
 * Calculates 4 dynamic sub-bands for the currently active frequency range
 */
function getActiveSubBands() {
  if (!isFilterActive) {
    return {
      names: DEFAULT_BAND_NAMES,
      ranges: DEFAULT_FREQ_RANGES
    };
  }

  const fLow = Math.max(20, filterLow);
  const fHigh = Math.max(fLow + 20, filterHigh);
  const r = Math.pow(fHigh / fLow, 0.25);
  const f0 = fLow;
  const f1 = f0 * r;
  const f2 = f1 * r;
  const f3 = f2 * r;
  const f4 = fHigh;

  return {
    names: [
      `🔴 Sub 1 (${f0.toFixed(0)} - ${f1.toFixed(0)} Гц)`,
      `🟡 Sub 2 (${f1.toFixed(0)} - ${f2.toFixed(0)} Гц)`,
      `🟢 Sub 3 (${f2.toFixed(0)} - ${f3.toFixed(0)} Гц)`,
      `🔵 Sub 4 (${f3.toFixed(0)} - ${f4.toFixed(0)} Гц)`
    ],
    ranges: [
      [f0, f1],
      [f1, f2],
      [f2, f3],
      [f3, f4]
    ]
  };
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
 * Setup Real-time Hardware Bandpass Filter & Web Audio API
 * Chain: source -> highpass1 -> highpass2 -> lowpass1 -> lowpass2 -> analyser -> destination
 * Provides 24 dB/octave brickwall frequency isolation!
 */
function initWebAudio() {
  if (audioCtx) return;
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContext();

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = FFT_SIZE; // 1024 -> 512 frequency bins
    analyser.smoothingTimeConstant = 0.65;
    analyser.minDecibels = -85;
    analyser.maxDecibels = -10;

    sourceNode = audioCtx.createMediaElementSource(audioPlayer);

    // Cascaded Highpass filters
    highpass1 = audioCtx.createBiquadFilter();
    highpass1.type = 'highpass';
    highpass2 = audioCtx.createBiquadFilter();
    highpass2.type = 'highpass';

    // Cascaded Lowpass filters
    lowpass1 = audioCtx.createBiquadFilter();
    lowpass1.type = 'lowpass';
    lowpass2 = audioCtx.createBiquadFilter();
    lowpass2.type = 'lowpass';

    applyFilterFrequencies();

    // Connect full DSP chain
    sourceNode.connect(highpass1);
    highpass1.connect(highpass2);
    highpass2.connect(lowpass1);
    lowpass1.connect(lowpass2);
    lowpass2.connect(analyser);
    analyser.connect(audioCtx.destination);

    fftBuffer = new Uint8Array(analyser.frequencyBinCount);
    console.log("Hardware Web Audio Bandpass Filter & FFT initialized: 512 frequency bins.");
  } catch (err) {
    console.warn("Web Audio API not supported or autoplay restriction:", err);
  }
}

/**
 * Applies current filterLow & filterHigh to the real-time audio playback filters
 */
function applyFilterFrequencies() {
  if (!audioCtx || !highpass1) return;

  const now = audioCtx.currentTime;

  if (!isFilterActive || (filterLow <= 25 && filterHigh >= 11000)) {
    // Transparent bypass
    highpass1.frequency.setValueAtTime(10, now);
    highpass2.frequency.setValueAtTime(10, now);
    lowpass1.frequency.setValueAtTime(22050, now);
    lowpass2.frequency.setValueAtTime(22050, now);

    if (filterAudioBadge) {
      filterAudioBadge.className = 'filter-audio-badge bypass';
      filterAudioBadge.textContent = '🔊 АУДИОФИЛЬТР: ВЫКЛ (Весь спектр)';
    }
    if (filterStatsText) {
      filterStatsText.textContent = 'Активны все частоты 20 Гц — 11 025 Гц | Все дорожки и ноты';
    }
  } else {
    // Active sharp bandpass filter
    highpass1.frequency.setValueAtTime(filterLow, now);
    highpass2.frequency.setValueAtTime(filterLow, now);
    lowpass1.frequency.setValueAtTime(filterHigh, now);
    lowpass2.frequency.setValueAtTime(filterHigh, now);

    if (filterAudioBadge) {
      filterAudioBadge.className = 'filter-audio-badge active';
      filterAudioBadge.textContent = `🔊 АУДИОФИЛЬТР: АКТИВЕН [${filterLow} Гц — ${filterHigh} Гц]`;
    }

    // Count how many notes in the chart fall within the isolated range
    let activeNotes = 0;
    let totalNotes = 0;
    if (analysisData && analysisData.chart) {
      totalNotes = analysisData.chart.length;
      activeNotes = analysisData.chart.filter(n => (n.freq >= filterLow && n.freq <= filterHigh)).length;
    }
    const hiddenNotes = totalNotes - activeNotes;

    if (filterStatsText) {
      filterStatsText.textContent = `Активно: ${activeNotes} нот в полосе [${filterLow} Гц — ${filterHigh} Гц] (скрыто: ${hiddenNotes} нот вне диапазона)`;
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

  function setFilterRange(low, high, isActive, activeBtn) {
    filterLow = low;
    filterHigh = high;
    isFilterActive = isActive;

    document.querySelectorAll('.filter-preset-btn').forEach(b => b.classList.remove('active'));
    if (activeBtn) activeBtn.classList.add('active');

    if (sliderFlow) sliderFlow.value = filterLow;
    if (sliderFhigh) sliderFhigh.value = filterHigh;
    if (valFlow) valFlow.textContent = `${filterLow} Гц`;
    if (valFhigh) valFhigh.textContent = `${filterHigh} Гц`;

    applyFilterFrequencies();
  }

  presets.forEach(({ btn, low, high, active }) => {
    if (!btn) return;
    btn.addEventListener('click', () => {
      setFilterRange(low, high, active, btn);
    });
  });

  if (btnPresetCustom) {
    btnPresetCustom.addEventListener('click', () => {
      isFilterActive = true;
      document.querySelectorAll('.filter-preset-btn').forEach(b => b.classList.remove('active'));
      btnPresetCustom.classList.add('active');
      applyFilterFrequencies();
    });
  }

  if (sliderFlow) {
    sliderFlow.addEventListener('input', (e) => {
      filterLow = parseInt(e.target.value);
      if (filterLow >= filterHigh) filterLow = filterHigh - 20;
      if (valFlow) valFlow.textContent = `${filterLow} Гц`;
      isFilterActive = true;
      document.querySelectorAll('.filter-preset-btn').forEach(b => b.classList.remove('active'));
      if (btnPresetCustom) btnPresetCustom.classList.add('active');
      applyFilterFrequencies();
    });
  }

  if (sliderFhigh) {
    sliderFhigh.addEventListener('input', (e) => {
      filterHigh = parseInt(e.target.value);
      if (filterHigh <= filterLow) filterHigh = filterLow + 20;
      if (valFhigh) valFhigh.textContent = `${filterHigh} Гц`;
      isFilterActive = true;
      document.querySelectorAll('.filter-preset-btn').forEach(b => b.classList.remove('active'));
      if (btnPresetCustom) btnPresetCustom.classList.add('active');
      applyFilterFrequencies();
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
    <span class="meta-tag">🎛️ Полосовой Фильтр (Bandpass)</span>
  `;
}

function setupAudioPlayer() {
  const audioFile = analysisData.metadata.audio_filename;
  audioPlayer.src = `/audio/${audioFile}`;

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

  // Synchronized sliding window coordinates
  const xHit = 95;
  const lookaheadSec = 3.0;

  // 1. Render Top Visualizer: 4 Band Onset Lanes (Filtered to Active Range)
  renderRawBandsVisualization(curTime, xHit, lookaheadSec);

  // 2. Render Synchronized Sliding 2D Spectrogram (Highlighted to Active Corridor)
  renderSlidingSpectrogram(curTime, xHit, lookaheadSec);

  // 3. Render Synchronized Sliding 4-Band Novelty Curves
  renderSlidingNovelty(curTime, xHit, lookaheadSec);

  // 4. Render Dynamic 512-bin Fast Fourier Transform (FFT) Continuous Curve
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
 * 1. 4 Frequency Lanes (Sliding Window, xHit = 95px)
 * When frequency isolation is active:
 * - Dynamically re-labels the 4 lanes to 4 sub-bands of [filterLow, filterHigh]
 * - Renders ONLY the notes/onsets falling within the active frequency range!
 */
function renderRawBandsVisualization(curTime, xHit, lookaheadSec) {
  if (!rawCtx || !rawBandsCanvas) return;
  const width = rawBandsCanvas.width;
  const height = rawBandsCanvas.height;

  rawCtx.clearRect(0, 0, width, height);

  const laneHeight = height / 4;
  const nowMs = performance.now();
  const activeHits = [false, false, false, false];

  const subBands = getActiveSubBands();

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
    rawCtx.fillText(subBands.names[b], 8, yTop + laneHeight / 2 + 4);
  }

  // Draw Vertical Hit Target Line
  rawCtx.strokeStyle = '#ef4444';
  rawCtx.lineWidth = 2.5;
  rawCtx.beginPath();
  rawCtx.moveTo(xHit, 0);
  rawCtx.lineTo(xHit, height);
  rawCtx.stroke();

  const minTime = curTime - (xHit / (width - xHit)) * lookaheadSec;
  const maxTime = curTime + lookaheadSec;

  // Render notes filtered to the isolated frequency range
  if (analysisData && analysisData.chart) {
    const chart = analysisData.chart;

    for (let i = 0; i < chart.length; i++) {
      const note = chart[i];
      if (note.time < minTime || note.time > maxTime) continue;

      const freq = note.freq || 200;

      // Filter: Skip notes outside active frequency range!
      if (isFilterActive && (freq < filterLow || freq > filterHigh)) {
        continue;
      }

      // Determine which of the 4 sub-bands this note belongs to
      let laneIdx = 0;
      for (let b = 0; b < 4; b++) {
        const [lowB, highB] = subBands.ranges[b];
        if (freq >= lowB && freq <= highB) {
          laneIdx = b;
          break;
        }
      }

      const dt = note.time - curTime;
      const xPos = xHit + (dt / lookaheadSec) * (width - xHit);
      const yCenter = laneIdx * laneHeight + laneHeight / 2;
      const color = BAND_COLORS[laneIdx];

      if (dt >= -0.05 && dt <= 0.06) {
        activeHits[laneIdx] = true;
        lastAttackTimes[laneIdx] = nowMs;
      }

      if (xPos >= xHit - 15 && xPos <= width + 15) {
        rawCtx.fillStyle = color;
        rawCtx.beginPath();
        rawCtx.arc(xPos, yCenter, 8, 0, Math.PI * 2);
        rawCtx.fill();
        rawCtx.strokeStyle = '#ffffff';
        rawCtx.lineWidth = 1.5;
        rawCtx.stroke();

        // Optional frequency text tag on note
        if (xPos >= xHit && xPos <= xHit + 120) {
          rawCtx.fillStyle = 'rgba(255, 255, 255, 0.7)';
          rawCtx.font = '600 9px "JetBrains Mono", monospace';
          rawCtx.fillText(`${freq.toFixed(0)}Hz`, xPos + 10, yCenter + 3);
        }
      }
    }
  }

  // Update Band Indicator Badges
  for (let b = 0; b < 4; b++) {
    const isHitActive = activeHits[b] || (nowMs - lastAttackTimes[b] < 120);
    const indBox = indBands[b];
    if (indBox) {
      if (isHitActive && !indBox.classList.contains('active')) indBox.classList.add('active');
      else if (!isHitActive && indBox.classList.contains('active')) indBox.classList.remove('active');
    }
  }
}

/**
 * 2. Synchronized Sliding 2D Spectrogram (Waterfall)
 * When frequency isolation is active:
 * - Highlights the active frequency corridor [filterLow, filterHigh]
 * - Dims / masks out frequencies outside the range
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
  // Mask out frequencies outside [filterLow, filterHigh]
  if (isFilterActive && analysisData.frequencies) {
    const freqs = analysisData.frequencies;
    const fMinFreq = freqs[0];
    const fMaxFreq = freqs[freqs.length - 1];

    // Compute pixel Y coordinates for filterLow and filterHigh:
    // CQT bins: bin 0 (lowest freq) is at bottom, bin 83 is at top
    let binLow = 0;
    let binHigh = nBins - 1;

    for (let b = 0; b < nBins; b++) {
      if (freqs[b] <= filterLow) binLow = b;
      if (freqs[b] <= filterHigh) binHigh = b;
    }

    const yHigh = height - (binHigh / nBins) * height; // Top of active corridor
    const yLow = height - (binLow / nBins) * height;   // Bottom of active corridor

    // Dim region ABOVE filterHigh (High frequencies out of range)
    if (yHigh > 0) {
      cqtCtx.fillStyle = 'rgba(2, 6, 23, 0.78)';
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
      cqtCtx.fillText(`▼ F max: ${filterHigh} Гц`, width - 120, yHigh + 12);
    }

    // Dim region BELOW filterLow (Low frequencies out of range)
    if (yLow < height) {
      cqtCtx.fillStyle = 'rgba(2, 6, 23, 0.78)';
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
      cqtCtx.fillText(`▲ F min: ${filterLow} Гц`, width - 120, yLow - 4);
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
  const subBands = getActiveSubBands();

  for (let b = 0; b < 4; b++) {
    const yOffset = b * bandHeight;
    const color = BAND_COLORS[b];

    // Background lane
    noveltyCtx.fillStyle = (b % 2 === 0) ? 'rgba(15, 23, 42, 0.75)' : 'rgba(30, 41, 59, 0.45)';
    noveltyCtx.fillRect(0, yOffset, width, bandHeight);

    noveltyCtx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    noveltyCtx.lineWidth = 1;
    noveltyCtx.strokeRect(0, yOffset, width, bandHeight);

    // Label
    noveltyCtx.fillStyle = color;
    noveltyCtx.font = '700 10px "JetBrains Mono", monospace';
    noveltyCtx.fillText(subBands.names[b].split(' ')[1] || `Band ${b+1}`, 8, yOffset + 14);

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
 * - Highlights active frequency range [filterLow, filterHigh]
 */
function renderDynamicFourierSlice(frameIdx) {
  if (!sliceCtx || !sliceCanvas) return;
  const width = sliceCanvas.width;
  const height = sliceCanvas.height;
  sliceCtx.clearRect(0, 0, width, height);

  if (!analysisData) return;

  const sr = analysisData.metadata.sample_rate || 22050;

  // 1. Get 512-point frequency amplitudes:
  // Hardware FFT directly reflects the active bandpass filter in real time!
  const amplitudes = new Float32Array(N_FFT_BINS);
  let maxAmp = 0;
  let maxBin = 0;

  if (analyser && !audioPlayer.paused && fftBuffer) {
    analyser.getByteFrequencyData(fftBuffer);
    for (let i = 0; i < N_FFT_BINS; i++) {
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

      // If filter active, zero out offline amplitudes outside range
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
  if (dominantPeakText && maxAmp > 0.08) {
    dominantPeakText.innerHTML = `🎯 Фурье-пик: <span class="peak-tag">${domFreq.toFixed(1)} Гц (${domNote})</span> | Амплитуда: ${(maxAmp * 100).toFixed(0)}% | ${isFilterActive ? `Полоса: ${filterLow}-${filterHigh} Гц` : 'Весь спектр'}`;
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
    const barHeight = amp * usableHeight;
    const x = b * barWidth;
    const y = height - 25 - barHeight;

    const inRange = !isFilterActive || (freq >= filterLow && freq <= filterHigh);

    // Multi-band color matching
    let color = inRange ? BAND_COLORS[3] : 'rgba(148, 163, 184, 0.2)';
    if (inRange) {
      if (freq < DEFAULT_FREQ_RANGES[0][1]) color = BAND_COLORS[0];
      else if (freq < DEFAULT_FREQ_RANGES[1][1]) color = BAND_COLORS[1];
      else if (freq < DEFAULT_FREQ_RANGES[2][1]) color = BAND_COLORS[2];
    }

    if (viewMode === 'curve') {
      sliceCtx.fillStyle = inRange ? colorWithAlpha(color, 0.40) : 'rgba(255, 255, 255, 0.05)';
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
      if (b === 0) sliceCtx.lineTo(x, y);
      else sliceCtx.lineTo(x, y);
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

    // Peak Marker Pin
    if (maxAmp > 0.10) {
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

    // F min line
    sliceCtx.beginPath();
    sliceCtx.moveTo(xFilterLow, 0);
    sliceCtx.lineTo(xFilterLow, height - 25);
    sliceCtx.stroke();

    // F max line
    sliceCtx.beginPath();
    sliceCtx.moveTo(xFilterHigh, 0);
    sliceCtx.lineTo(xFilterHigh, height - 25);
    sliceCtx.stroke();
    sliceCtx.setLineDash([]);

    // Highlight zone
    sliceCtx.fillStyle = 'rgba(16, 185, 129, 0.05)';
    sliceCtx.fillRect(xFilterLow, 0, xFilterHigh - xFilterLow, height - 25);
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

  for (let b = 0; b < nBins; b++) {
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
