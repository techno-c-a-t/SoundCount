/**
 * SoundCount Mobile Piano Tiles Playable Engine & Multi-Band DSP Profiler
 * Vertical falling tiles (Height = 2.0x Width) with touch/click interaction,
 * score/combo tracking, full screen responsiveness, and DSP analytics toggle.
 */

let analysisData = null;
let currentFrameIdx = 0;
let animFrameId = null;
let activeChartStartIndex = 0;

// Game State
let gameScore = 0;
let gameCombo = 0;
let hitEffects = []; // Particle effects & floating score text
let noteHitStates = {}; // Map noteId/index -> boolean

// Profiler / Trace variables
let frameCount = 0;
let lastFpsTime = performance.now();
let lastDomUpdateTime = 0;
let lastProfilerUpdateTime = 0;

let traceHistory = {
  piano: [],
  slice: [],
  playhead: [],
  dom: [],
  total: [],
  fps: 60
};

// DOM Elements
const audioPlayer = document.getElementById('audioPlayer');
const btnPlayPause = document.getElementById('btnPlayPause');
const btnToggleMode = document.getElementById('btnToggleMode');
const timeDisplay = document.getElementById('timeDisplay');
const trackProgressFill = document.getElementById('trackProgressFill');
const gameScoreText = document.getElementById('gameScoreText');
const gameComboText = document.getElementById('gameComboText');
const fpsTagElem = document.getElementById('fpsTag');
const trackMeta = document.getElementById('trackMeta');

const dspDashboardContainer = document.getElementById('dspDashboardContainer');

// Canvases
const mobileGameCanvas = document.getElementById('mobileGameCanvas');
const mobileCtx = mobileGameCanvas ? mobileGameCanvas.getContext('2d') : null;

const pianoLanesCanvas = document.getElementById('pianoLanesCanvas');
const pianoCtx = pianoLanesCanvas ? pianoLanesCanvas.getContext('2d') : null;

const cqtCanvas = document.getElementById('cqtCanvas');
const cqtCtx = cqtCanvas ? cqtCanvas.getContext('2d') : null;

const noveltyCanvas = document.getElementById('noveltyCanvas');
const noveltyCtx = noveltyCanvas ? noveltyCanvas.getContext('2d') : null;

const sliceCanvas = document.getElementById('sliceCanvas');
const sliceCtx = sliceCanvas ? sliceCanvas.getContext('2d') : null;

const cqtPlayhead = document.getElementById('cqtPlayhead');
const noveltyPlayhead = document.getElementById('noveltyPlayhead');

// Trace HUD Elements
const tracePianoElem = document.getElementById('tracePiano');
const traceSliceElem = document.getElementById('traceSlice');
const tracePlayheadElem = document.getElementById('tracePlayhead');
const traceDomElem = document.getElementById('traceDom');
const traceTotalElem = document.getElementById('traceTotal');
const boxTotalElem = document.getElementById('boxTotal');

const indBands = [
  document.getElementById('indBand0'),
  document.getElementById('indBand1'),
  document.getElementById('indBand2'),
  document.getElementById('indBand3')
];

// Colors & Themes
const BAND_COLORS = ['#f97316', '#eab308', '#10b981', '#06b6d4'];
const BAND_COLORS_TRANSPARENT = [
  'rgba(249, 115, 22, 0.4)',
  'rgba(234, 179, 8, 0.4)',
  'rgba(16, 185, 129, 0.4)',
  'rgba(6, 182, 212, 0.4)'
];
const BAND_NAMES = ['🔴 BASS', '🟡 TENOR', '🟢 ALTO', '🔵 SOPRANO'];

// Offscreen static buffers
let offscreenCqtCanvas = document.createElement('canvas');
let offscreenNoveltyCanvas = document.createElement('canvas');
let precomputedBlockedSets = [];

let rawFullChart = [];
let gameAudioCtx = null;
let gameHighpass1 = null, gameHighpass2 = null;
let gameLowpass1 = null, gameLowpass2 = null;
let filterGameLow = 20, filterGameHigh = 11025, isGameFilterActive = false;

async function initDashboard() {
  try {
    const response = await fetch('/analysis.json');
    if (!response.ok) throw new Error("Could not load analysis.json");
    analysisData = await response.json();
    rawFullChart = JSON.parse(JSON.stringify(analysisData.chart || []));

    preprocessBlockedBins();
    preprocessChartTileHeights();
    resizeCanvases();
    setupMetadata();
    setupAudioPlayer();
    setupGameFilterControls();
    buildOffscreenStaticSpectrogram();
    buildOffscreenStaticNovelty();

    drawStaticCanvasesOnce();
    setupMobileControls();

    startAnimationLoop();

    window.addEventListener('resize', onWindowResize);

  } catch (err) {
    console.error("Dashboard Init Error:", err);
    if (trackMeta) {
      trackMeta.innerHTML = `<span style="color: #f43f5e">Ошибка: ${err.message}. Запустите data_exporter.py!</span>`;
    }
  }
}

function preprocessChartTileHeights() {
  if (!analysisData || !analysisData.chart) return;
  const chart = analysisData.chart;
  
  for (let i = 0; i < chart.length; i++) {
    const note = chart[i];
    note.dtNextSameLane = 999.0;
    for (let j = i + 1; j < chart.length; j++) {
      if (chart[j].lane === note.lane) {
        note.dtNextSameLane = Math.max(0.001, chart[j].time - note.time);
        break;
      }
    }
  }
}

function preprocessBlockedBins() {
  precomputedBlockedSets = [];
  if (analysisData && analysisData.blocked_bins) {
    const nBins = analysisData.metadata.n_bins || 84;
    analysisData.blocked_bins.forEach(bins => {
      const arr = new Uint8Array(nBins);
      if (bins) {
        for (let i = 0; i < bins.length; i++) {
          arr[bins[i]] = 1;
        }
      }
      precomputedBlockedSets.push(arr);
    });
  }
}

function resizeCanvases() {
  // Mobile Game Canvas (Full Screen width & height)
  const container = document.getElementById('mobileGameContainer');
  if (container && mobileGameCanvas) {
    const rect = container.getBoundingClientRect();
    mobileGameCanvas.width = rect.width || window.innerWidth;
    mobileGameCanvas.height = rect.height || (window.innerHeight - 50);
  }

  if (pianoLanesCanvas && pianoLanesCanvas.parentElement) {
    pianoLanesCanvas.width = pianoLanesCanvas.parentElement.clientWidth;
    pianoLanesCanvas.height = 180;
  }
  if (cqtCanvas && cqtCanvas.parentElement) {
    cqtCanvas.width = cqtCanvas.parentElement.clientWidth;
    cqtCanvas.height = 180;
  }
  if (noveltyCanvas && noveltyCanvas.parentElement) {
    noveltyCanvas.width = noveltyCanvas.parentElement.clientWidth;
    noveltyCanvas.height = 140;
  }
  if (sliceCanvas && sliceCanvas.parentElement) {
    sliceCanvas.width = sliceCanvas.parentElement.clientWidth;
    sliceCanvas.height = 200;
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
  const total = meta.total_notes || (analysisData.chart ? analysisData.chart.length : 0);

  trackMeta.innerHTML = `
    <span class="meta-tag">🎵 ${meta.title}</span>
    <span class="meta-tag">⏱ ${meta.duration_sec}с</span>
    <span class="meta-tag">🎹 4 дорожки (Витерби)</span>
    <span class="meta-tag">⚡ ${total} нот</span>
  `;
}

let isRecordingVibe = false;
let userRecordedTaps = [];

const btnRecMode = document.getElementById('btnRecMode');
const btnSaveTaps = document.getElementById('btnSaveTaps');
const recBanner = document.getElementById('recBanner');
const recCountText = document.getElementById('recCountText');

function setupAudioPlayer() {
  const audioFile = analysisData.metadata.audio_filename;
  audioPlayer.crossOrigin = "anonymous";
  audioPlayer.src = `/audio/${audioFile}`;

  btnPlayPause.addEventListener('click', togglePlayPause);
  audioPlayer.addEventListener('play', () => {
    initGameWebAudio();
    if (gameAudioCtx && gameAudioCtx.state === 'suspended') gameAudioCtx.resume();
    btnPlayPause.textContent = "⏸";
  });
  audioPlayer.addEventListener('pause', () => {
    btnPlayPause.textContent = "▶";
  });

  audioPlayer.addEventListener('seeking', () => {
    activeChartStartIndex = 0;
  });

  if (btnToggleMode) {
    btnToggleMode.addEventListener('click', () => {
      dspDashboardContainer.classList.toggle('hidden');
      btnToggleMode.textContent = dspDashboardContainer.classList.contains('hidden') ? '📊 DSP' : '📱 Игра';
      resizeCanvases();
      drawStaticCanvasesOnce();
    });
  }

  setupVibeRecordingControls();
}

function initGameWebAudio() {
  if (gameAudioCtx) return;
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    gameAudioCtx = new AudioContext();
    const source = gameAudioCtx.createMediaElementSource(audioPlayer);

    gameHighpass1 = gameAudioCtx.createBiquadFilter();
    gameHighpass1.type = 'highpass';
    gameHighpass2 = gameAudioCtx.createBiquadFilter();
    gameHighpass2.type = 'highpass';

    gameLowpass1 = gameAudioCtx.createBiquadFilter();
    gameLowpass1.type = 'lowpass';
    gameLowpass2 = gameAudioCtx.createBiquadFilter();
    gameLowpass2.type = 'lowpass';

    applyGameAudioFilter();

    source.connect(gameHighpass1);
    gameHighpass1.connect(gameHighpass2);
    gameHighpass2.connect(gameLowpass1);
    gameLowpass1.connect(gameLowpass2);
    gameLowpass2.connect(gameAudioCtx.destination);
    console.log("Game Web Audio Bandpass Filter initialized.");
  } catch (e) {
    console.warn("Game Web Audio init error:", e);
  }
}

function applyGameAudioFilter() {
  if (!gameAudioCtx || !gameHighpass1) return;
  const now = gameAudioCtx.currentTime;
  if (!isGameFilterActive || (filterGameLow <= 25 && filterGameHigh >= 11000)) {
    gameHighpass1.frequency.setValueAtTime(10, now);
    gameHighpass2.frequency.setValueAtTime(10, now);
    gameLowpass1.frequency.setValueAtTime(22050, now);
    gameLowpass2.frequency.setValueAtTime(22050, now);
  } else {
    gameHighpass1.frequency.setValueAtTime(filterGameLow, now);
    gameHighpass2.frequency.setValueAtTime(filterGameLow, now);
    gameLowpass1.frequency.setValueAtTime(filterGameHigh, now);
    gameLowpass2.frequency.setValueAtTime(filterGameHigh, now);
  }
}

function setupGameFilterControls() {
  const filterBtns = [
    { id: 'btnGameFilterAll', low: 20, high: 11025, active: false },
    { id: 'btnGameFilterBass', low: 30, high: 250, active: true },
    { id: 'btnGameFilterMids', low: 250, high: 2500, active: true },
    { id: 'btnGameFilterHighs', low: 2500, high: 11025, active: true }
  ];

  filterBtns.forEach(({ id, low, high, active }) => {
    const btn = document.getElementById(id);
    if (!btn) return;

    btn.addEventListener('click', () => {
      document.querySelectorAll('.game-filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      filterGameLow = low;
      filterGameHigh = high;
      isGameFilterActive = active;

      initGameWebAudio();
      if (gameAudioCtx && gameAudioCtx.state === 'suspended') gameAudioCtx.resume();
      applyGameAudioFilter();

      // Filter and remap chart notes for game tiles
      if (rawFullChart && rawFullChart.length > 0) {
        if (!active) {
          analysisData.chart = JSON.parse(JSON.stringify(rawFullChart));
        } else {
          const filtered = rawFullChart.filter(n => (n.freq >= low && n.freq <= high));
          const r = Math.pow(high / low, 0.25);
          const f0 = low, f1 = f0 * r, f2 = f1 * r, f3 = f2 * r;
          filtered.forEach(note => {
            const f = note.freq || 200;
            if (f < f1) note.lane = 0;
            else if (f < f2) note.lane = 1;
            else if (f < f3) note.lane = 2;
            else note.lane = 3;
          });
          analysisData.chart = filtered;
        }
        preprocessChartTileHeights();
        activeChartStartIndex = 0;
      }
    });
  });
}

function setupVibeRecordingControls() {
  if (btnRecMode) {
    btnRecMode.addEventListener('click', toggleVibeRecording);
  }

  if (btnSaveTaps) {
    btnSaveTaps.addEventListener('click', saveUserRecordedTaps);
  }

  // PC Keyboard listeners for 4 lanes (D, F, J, K or 1, 2, 3, 4)
  const KEY_LANE_MAP = {
    'd': 0, 'D': 0, '1': 0, 'a': 0, 'A': 0, 'в': 0, 'В': 0,
    'f': 1, 'F': 1, '2': 1, 's': 1, 'S': 1, 'а': 1, 'А': 1,
    'j': 2, 'J': 2, '3': 2, 'k': 2, 'K': 2, 'о': 2, 'О': 2,
    'l': 3, 'L': 3, '4': 3, ';': 3, ':': 3, 'л': 3, 'Л': 3
  };

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      togglePlayPause();
      return;
    }

    if (KEY_LANE_MAP.hasOwnProperty(e.key)) {
      const lane = KEY_LANE_MAP[e.key];
      recordUserTap(lane);
    }
  });
}

function toggleVibeRecording() {
  isRecordingVibe = !isRecordingVibe;

  if (isRecordingVibe) {
    btnRecMode.classList.add('recording');
    btnRecMode.textContent = "⏹ STOP";
    if (recBanner) recBanner.classList.remove('hidden');
    if (btnSaveTaps) btnSaveTaps.classList.remove('hidden');

    if (audioPlayer.paused) {
      audioPlayer.play();
      btnPlayPause.textContent = "⏸";
    }
  } else {
    btnRecMode.classList.remove('recording');
    btnRecMode.textContent = "🔴 REC";
    if (recBanner) recBanner.classList.add('hidden');
  }
}

function recordUserTap(lane) {
  const curTime = audioPlayer.currentTime || 0;
  const tap = {
    time: parseFloat(curTime.toFixed(3)),
    lane: lane
  };

  userRecordedTaps.push(tap);

  if (recCountText) {
    recCountText.textContent = `${userRecordedTaps.length} нот`;
  }

  // Visual tap feedback
  if (mobileGameCanvas) {
    const width = mobileGameCanvas.width;
    const height = mobileGameCanvas.height;
    const laneWidth = width / 4;
    const xCenter = (lane + 0.5) * laneWidth;
    const yHit = height * 0.50;

    createHitParticles(xCenter, yHit, BAND_COLORS[lane]);
    hitEffects.push({
      x: xCenter,
      y: yHit - 20,
      text: `REC L${lane + 1}`,
      color: BAND_COLORS[lane],
      life: 0.8
    });
  }

  // Check collision in game mode
  if (mobileGameCanvas) {
    const height = mobileGameCanvas.height;
    const laneWidth = mobileGameCanvas.width / 4;
    checkTileHit(lane, height * 0.50, height, laneWidth);
  }
}

async function saveUserRecordedTaps() {
  if (!userRecordedTaps.length) {
    alert("Нет записанных нот! Запустите запись REC и нажимайте по дорожкам.");
    return;
  }

  const exportPayload = {
    audio_filename: analysisData ? analysisData.metadata.audio_filename : "test_music.mp3",
    total_taps: userRecordedTaps.length,
    duration_sec: analysisData ? analysisData.metadata.duration_sec : 1.0,
    taps: userRecordedTaps
  };

  try {
    const response = await fetch('/api/save_taps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(exportPayload, null, 2)
    });

    if (!response.ok) throw new Error("Could not save taps");

    alert(`✅ Успешно сохранено ${userRecordedTaps.length} нот вайба в data/input/user_taps.json! Теперь можно запустить скрипт сравнения.`);
  } catch (err) {
    console.error("Save Taps Error:", err);
    alert(`Ошибка сохранения: ${err.message}`);
  }
}

function togglePlayPause() {
  if (audioPlayer.paused) {
    audioPlayer.play();
    btnPlayPause.textContent = "⏸";
  } else {
    audioPlayer.pause();
    btnPlayPause.textContent = "▶";
  }
}

/**
 * 📱 Touch / Click interaction handler for mobile playable canvas
 */
function setupMobileControls() {
  if (!mobileGameCanvas) return;

  const handlePointerDown = (e) => {
    e.preventDefault();
    if (audioPlayer.paused) {
      audioPlayer.play();
      btnPlayPause.textContent = "⏸";
    }

    const rect = mobileGameCanvas.getBoundingClientRect();
    const touchX = e.clientX - rect.left;
    const touchY = e.clientY - rect.top;

    const width = mobileGameCanvas.width;
    const height = mobileGameCanvas.height;
    const laneWidth = width / 4;
    const clickedLane = Math.floor(touchX / laneWidth);

    if (clickedLane >= 0 && clickedLane < 4) {
      if (isRecordingVibe) {
        recordUserTap(clickedLane);
      } else {
        checkTileHit(clickedLane, touchY, height, laneWidth);
      }
    }
  };

  mobileGameCanvas.addEventListener('pointerdown', handlePointerDown);
}

/**
 * Checks if a falling tile was tapped in `clickedLane` strictly inside its bounding box
 */
function checkTileHit(lane, touchY, height, laneWidth) {
  if (!analysisData || !analysisData.chart) return;
  const chart = analysisData.chart;
  const curTime = audioPlayer.currentTime || 0;
  const yHit = height * 0.50; // Hit Target Line in EXACT CENTER of screen!

  const totalDur = (analysisData && analysisData.metadata && analysisData.metadata.duration_sec) ? analysisData.metadata.duration_sec : 1.0;
  const tRatio = Math.max(0, Math.min(1, curTime / totalDur));
  const secPerNote = 1.0 - 0.6 * tRatio; // Smoothly accelerates from 1.0s to 0.4s
  const speed = yHit / secPerNote;
  const maxTileH = 1.5 * laneWidth;

  let closestNoteIndex = -1;
  let minDistance = 999999;

  for (let i = 0; i < chart.length; i++) {
    const note = chart[i];
    if (note.lane !== lane) continue;
    if (noteHitStates[i]) continue; // Already hit

    const dtNext = note.dtNextSameLane || 999.0;
    const tileHeight = Math.min(maxTileH, dtNext * speed);

    const dtStart = note.time - curTime;
    const yCenter = yHit - (dtStart * speed);
    const yTop = yCenter - tileHeight / 2;
    const yBottom = yCenter + tileHeight / 2;

    // Strict bounding-box check: touchY must be ON the tile or within 35px hit window near target line
    const isTouchOnTile = (touchY >= yTop - 35 && touchY <= yBottom + 35);

    if (isTouchOnTile) {
      const dist = Math.abs(touchY - yCenter);
      if (dist < minDistance) {
        minDistance = dist;
        closestNoteIndex = i;
      }
    }
  }

  if (closestNoteIndex !== -1) {
    // REGISTER HIT!
    noteHitStates[closestNoteIndex] = true;
    const note = chart[closestNoteIndex];
    gameScore += 100;
    gameCombo += 1;

    const xCenter = (lane + 0.5) * laneWidth;

    // Spawn hit effect explosion particles
    createHitParticles(xCenter, touchY, BAND_COLORS[lane]);

    // Floating text rating (+100 PERFECT)
    hitEffects.push({
      x: xCenter,
      y: touchY - 20,
      text: "+100 PERFECT!",
      color: BAND_COLORS[lane],
      life: 1.0
    });

  } else {
    // Tap on empty space: Reset combo & create red miss indicator
    gameCombo = 0;
    const xCenter = (lane + 0.5) * laneWidth;
    hitEffects.push({
      x: xCenter,
      y: touchY,
      text: "MISS",
      color: "#f43f5e",
      life: 0.6
    });
  }

  if (gameScoreText) gameScoreText.textContent = `SCORE: ${gameScore}`;
  if (gameComboText) gameComboText.textContent = `COMBO x${gameCombo}`;
}

function createHitParticles(x, y, color) {
  for (let p = 0; p < 12; p++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 2 + Math.random() * 6;
    hitEffects.push({
      isParticle: true,
      x: x,
      y: y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      radius: 3 + Math.random() * 5,
      color: color,
      life: 1.0
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

/**
 * ⚡ Main High-Performance 60 FPS Render Loop
 */
function updateUI60FPS() {
  const t0 = performance.now();

  const curTime = audioPlayer.currentTime || 0;
  const dur = audioPlayer.duration || analysisData.metadata.duration_sec || 1;

  const hopSec = analysisData.metadata.hop_length / analysisData.metadata.sample_rate;
  currentFrameIdx = Math.min(
    analysisData.metadata.n_frames - 1,
    Math.max(0, Math.floor(curTime / hopSec))
  );

  // 1. Mobile Vertical Falling Piano Tiles Game Render
  const tPianoStart = performance.now();
  renderMobilePlayableGame(curTime);
  if (!dspDashboardContainer.classList.contains('hidden')) {
    renderPianoLanesGameplay(curTime);
  }
  const tPiano = performance.now() - tPianoStart;

  // 2. CSS Playhead Updates (0ms cost)
  const tPlayheadStart = performance.now();
  if (!dspDashboardContainer.classList.contains('hidden')) {
    updatePlayheads(curTime, dur);
  }
  const tPlayhead = performance.now() - tPlayheadStart;

  // 3. Live 84-Bar Spectrogram Slice Render
  const tSliceStart = performance.now();
  if (!dspDashboardContainer.classList.contains('hidden')) {
    renderSlice(currentFrameIdx);
  }
  const tSlice = performance.now() - tSliceStart;

  // 4. Throttled Top Progress Bar & DOM Updates
  const tDomStart = performance.now();
  if (trackProgressFill) {
    trackProgressFill.style.width = `${Math.min(100, (curTime / dur) * 100)}%`;
  }
  if (t0 - lastDomUpdateTime >= 100) {
    if (timeDisplay) timeDisplay.textContent = `${formatTime(curTime)} / ${formatTime(dur)}`;
    if (currentFrameText) currentFrameText.textContent = `Фрейм m = ${currentFrameIdx} | t = ${curTime.toFixed(3)} с`;
    lastDomUpdateTime = t0;
  }
  const tDom = performance.now() - tDomStart;

  const tTotal = performance.now() - t0;

  // Profiler metrics
  traceHistory.piano.push(tPiano);
  traceHistory.slice.push(tSlice);
  traceHistory.playhead.push(tPlayhead);
  traceHistory.dom.push(tDom);
  traceHistory.total.push(tTotal);

  if (traceHistory.total.length > 30) {
    traceHistory.piano.shift();
    traceHistory.slice.shift();
    traceHistory.playhead.shift();
    traceHistory.dom.shift();
    traceHistory.total.shift();
  }

  updateProfilerHUD(t0);
}

/**
 * 🎮 Renders Vertical Falling Tiles Mobile Game (Tile Height = 2x Lane Width)
 */
function renderMobilePlayableGame(curTime) {
  if (!mobileCtx || !mobileGameCanvas) return;

  const width = mobileGameCanvas.width;
  const height = mobileGameCanvas.height;

  mobileCtx.clearRect(0, 0, width, height);

  const laneWidth = width / 4;
  const yHit = height * 0.50; // Hit Target Line in EXACT CENTER of screen!

  // Dynamic Stream Acceleration: secPerNote decays smoothly from 1.0s (start) to 0.4s (end)
  const totalDur = (analysisData && analysisData.metadata && analysisData.metadata.duration_sec) ? analysisData.metadata.duration_sec : 1.0;
  const tRatio = Math.max(0, Math.min(1, curTime / totalDur));
  const secPerNote = 1.0 - 0.6 * tRatio; // Smoothly accelerates from 1.0s to 0.4s
  const speed = yHit / secPerNote; // Speed increases by 2.5x towards end of track!
  const maxTileH = 1.5 * laneWidth;

  // 1. Draw 4 Vertical Columns Background
  for (let b = 0; b < 4; b++) {
    const xLeft = b * laneWidth;
    const color = BAND_COLORS[b];

    mobileCtx.fillStyle = (b % 2 === 0) ? 'rgba(15, 23, 42, 0.65)' : 'rgba(30, 41, 59, 0.45)';
    mobileCtx.fillRect(xLeft, 0, laneWidth, height);

    mobileCtx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    mobileCtx.lineWidth = 1;
    mobileCtx.strokeRect(xLeft, 0, laneWidth, height);

    // Lane Name Label at bottom
    mobileCtx.fillStyle = color;
    mobileCtx.font = '700 12px "JetBrains Mono", monospace';
    mobileCtx.textAlign = 'center';
    mobileCtx.fillText(BAND_NAMES[b], xLeft + laneWidth / 2, height - 15);
  }

  // 2. Draw Target Hit Line Across EXACT CENTER
  mobileCtx.strokeStyle = 'rgba(56, 189, 248, 0.8)';
  mobileCtx.lineWidth = 4;
  mobileCtx.beginPath();
  mobileCtx.moveTo(0, yHit);
  mobileCtx.lineTo(width, yHit);
  mobileCtx.stroke();

  // Center Hit Line Glow
  mobileCtx.strokeStyle = 'rgba(56, 189, 248, 0.3)';
  mobileCtx.lineWidth = 14;
  mobileCtx.beginPath();
  mobileCtx.moveTo(0, yHit);
  mobileCtx.lineTo(width, yHit);
  mobileCtx.stroke();

  // 3. Render Falling Notes (Top -> Center Hit Line) - HIDDEN DURING VIBE RECORDING!
  if (!isRecordingVibe && analysisData && analysisData.chart) {
    const chart = analysisData.chart;
    const minTime = curTime - 0.5;
    const maxTime = curTime + secPerNote;

    for (let i = 0; i < chart.length; i++) {
      if (noteHitStates[i]) continue; // Tile disappeared on hit!

      const note = chart[i];
      const tStart = note.time;

      if (tStart < minTime) continue;
      if (tStart > maxTime) break;

      const lane = note.lane;
      const xLeft = lane * laneWidth + 4;
      const actualTileWidth = laneWidth - 8;
      const color = BAND_COLORS[lane];

      const dtNext = note.dtNextSameLane || 999.0;
      const tileHeight = Math.min(maxTileH, dtNext * speed);

      const dtStart = tStart - curTime;
      const yStart = yHit - (dtStart * speed);

      // --- TAP NOTE TILE (CENTER HIT LINE ALIGNMENT) ---
      if (yStart >= -tileHeight && yStart <= height + tileHeight) {
        drawVerticalTilePill(mobileCtx, xLeft, yStart - tileHeight / 2, actualTileWidth, tileHeight, color);
      }
    }
  }

  // 4. Update and Render Hit Particle Effects & Floating Rating Text
  for (let i = hitEffects.length - 1; i >= 0; i--) {
    const fx = hitEffects[i];
    fx.life -= 0.04;

    if (fx.life <= 0) {
      hitEffects.splice(i, 1);
      continue;
    }

    if (fx.isParticle) {
      fx.x += fx.vx;
      fx.y += fx.vy;
      mobileCtx.fillStyle = fx.color;
      mobileCtx.globalAlpha = fx.life;
      mobileCtx.beginPath();
      mobileCtx.arc(fx.x, fx.y, fx.radius, 0, Math.PI * 2);
      mobileCtx.fill();
      mobileCtx.globalAlpha = 1.0;
    } else {
      fx.y -= 1.5;
      mobileCtx.fillStyle = fx.color;
      mobileCtx.globalAlpha = fx.life;
      mobileCtx.font = '800 16px "Inter", sans-serif';
      mobileCtx.textAlign = 'center';
      mobileCtx.fillText(fx.text, fx.x, fx.y);
      mobileCtx.globalAlpha = 1.0;
    }
  }
}

/**
 * Draws vertical piano tile with height = 2x width, sleek gradient, rounded corners & inner glow
 */
function drawVerticalTilePill(ctx, x, y, width, height, color) {
  ctx.save();

  // Gradient fill
  const grad = ctx.createLinearGradient(x, y, x, y + height);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.2, color);
  grad.addColorStop(1.0, color + 'cc');

  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 8);
  ctx.fill();

  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Inner glowing core dot
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(x + width / 2, y + height / 2, Math.min(8, width / 6), 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function updateProfilerHUD(nowMs) {
  frameCount++;
  if (nowMs - lastFpsTime >= 500) {
    traceHistory.fps = Math.round((frameCount * 1000) / (nowMs - lastFpsTime));
    frameCount = 0;
    lastFpsTime = nowMs;
  }

  if (nowMs - lastProfilerUpdateTime >= 200) {
    const avg = arr => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
    const avgPiano = avg(traceHistory.piano);
    const avgSlice = avg(traceHistory.slice);
    const avgPlayhead = avg(traceHistory.playhead);
    const avgDom = avg(traceHistory.dom);
    const avgTotal = avg(traceHistory.total);

    if (tracePianoElem) tracePianoElem.textContent = `${avgPiano.toFixed(2)} ms`;
    if (traceSliceElem) traceSliceElem.textContent = `${avgSlice.toFixed(2)} ms`;
    if (tracePlayheadElem) tracePlayheadElem.textContent = `${avgPlayhead.toFixed(2)} ms`;
    if (traceDomElem) traceDomElem.textContent = `${avgDom.toFixed(2)} ms`;
    if (traceTotalElem) traceTotalElem.textContent = `${avgTotal.toFixed(2)} ms`;

    if (fpsTagElem) {
      fpsTagElem.textContent = `⚡ ${traceHistory.fps} FPS`;
    }

    if (boxTotalElem) {
      if (avgTotal > 16.6 || (traceHistory.fps > 0 && traceHistory.fps < 45)) {
        boxTotalElem.classList.add('warning');
      } else {
        boxTotalElem.classList.remove('warning');
      }
    }

    lastProfilerUpdateTime = nowMs;
  }
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

function renderPianoLanesGameplay(curTime) {
  if (!pianoCtx || !pianoLanesCanvas) return;
  const width = pianoLanesCanvas.width;
  const height = pianoLanesCanvas.height;

  pianoCtx.clearRect(0, 0, width, height);
  const xHit = 80;
  const lookaheadSec = 3.0;
  const laneHeight = height / 4;

  for (let b = 0; b < 4; b++) {
    const yTop = b * laneHeight;
    pianoCtx.fillStyle = (b % 2 === 0) ? 'rgba(15, 23, 42, 0.85)' : 'rgba(30, 41, 59, 0.55)';
    pianoCtx.fillRect(0, yTop, width, laneHeight);
    pianoCtx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    pianoCtx.strokeRect(0, yTop, width, laneHeight);
    pianoCtx.fillStyle = BAND_COLORS[b];
    pianoCtx.font = '700 10px "JetBrains Mono", monospace';
    pianoCtx.fillText(BAND_NAMES[b], 6, yTop + laneHeight / 2 + 4);
  }

  pianoCtx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  pianoCtx.lineWidth = 2;
  pianoCtx.beginPath();
  pianoCtx.moveTo(xHit, 0);
  pianoCtx.lineTo(xHit, height);
  pianoCtx.stroke();
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
}

function parseRgb(rgbStr) {
  const match = rgbStr.match(/\d+/g);
  return { r: parseInt(match[0]), g: parseInt(match[1]), b: parseInt(match[2]) };
}

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

function buildOffscreenStaticNovelty() {
  const width = noveltyCanvas ? (noveltyCanvas.width || 1400) : 1400;
  const height = 140;
  offscreenNoveltyCanvas.width = width;
  offscreenNoveltyCanvas.height = height;
  const ctx = offscreenNoveltyCanvas.getContext('2d');

  const nFrames = analysisData.metadata.n_frames;
  const sfBands = analysisData.multiband.sf_bands;
  const bandHeight = height / 4;

  ctx.clearRect(0, 0, width, height);

  for (let b = 0; b < 4; b++) {
    const yOffset = b * bandHeight;
    const color = BAND_COLORS[b];

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
  const blockedArr = precomputedBlockedSets[frameIdx];

  for (let b = 0; b < nBins; b++) {
    const db = dbMatrix[b][frameIdx] || -80;
    const norm = Math.max(0, Math.min(1, (db + 80) / 80));
    const barHeight = norm * (height - 30);
    const x = b * barWidth;
    const y = height - barHeight - 20;

    const isBlocked = blockedArr ? (blockedArr[b] === 1) : false;

    let bandIdx = 0;
    for (let band = 0; band < bandRanges.length; band++) {
      if (b >= bandRanges[band][0] && b < bandRanges[band][1]) {
        bandIdx = band;
        break;
      }
    }

    if (isBlocked) {
      sliceCtx.fillStyle = '#475569';
      sliceCtx.fillRect(x, y, barWidth - 1, barHeight);
    } else {
      sliceCtx.fillStyle = BAND_COLORS[bandIdx];
      sliceCtx.fillRect(x, y, barWidth - 1, barHeight);
    }
  }
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(1);
  return `${m.toString().padStart(2, '0')}:${s.padStart(4, '0')}`;
}

document.addEventListener('DOMContentLoaded', initDashboard);
