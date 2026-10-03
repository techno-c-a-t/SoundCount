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

// ⚡ Speed Configuration: Smooth progression 2.0x at start -> 3.5x at end
let speedMode = 'dynamic';
let fixedTileSpeedMultiplier = 2.75;
const gameSpeedLbl = document.getElementById('gameSpeedLbl');

function getCurrentSpeedMultiplier(curTime) {
  if (speedMode === 'dynamic') {
    const totalDur = (analysisData && analysisData.metadata && analysisData.metadata.duration_sec) ? analysisData.metadata.duration_sec : 1.0;
    const tRatio = Math.max(0, Math.min(1, curTime / totalDur));
    // Smooth progression: 2.0x at the start -> 3.5x at the end
    return 2.0 + 1.5 * tRatio;
  }
  return fixedTileSpeedMultiplier;
}

async function initDashboard() {
  try {
    const response = await fetch('/analysis.json');
    if (!response.ok) throw new Error("Could not load analysis.json");
    analysisData = await response.json();
    rebuildPianoChartFromGlobalBeat();
    rawFullChart = JSON.parse(JSON.stringify(analysisData.chart || []));

    preprocessBlockedBins();
    preprocessChartTileHeights();
    resizeCanvases();
    setupMetadata();
    setupAudioPlayer();
    setupGameFilterControls();
    setupSpeedControls();
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

/**
 * Generates an alternating, playable 4-lane piano chart from the Global Beat skeleton
 */
function rebuildPianoChartFromGlobalBeat() {
  if (!analysisData) return;
  const globalPeaks = (analysisData.global_track && analysisData.global_track.peaks_sec) ||
    analysisData.peaks_sec || [];
  if (!globalPeaks.length) return;

  const sfBands = analysisData.multiband ? analysisData.multiband.sf_bands : null;
  const sampleRate = (analysisData.metadata && analysisData.metadata.sample_rate) || 22050;
  const hopLength = (analysisData.metadata && analysisData.metadata.hop_length) || 512;
  const hopSec = hopLength / sampleRate;
  const nFrames = (analysisData.metadata && analysisData.metadata.n_frames) || (sfBands ? sfBands[0].length : 1000);
  const frequencies = analysisData.frequencies || [];

  // Higher sensitivity: 65ms debounce captures rapid 16th-note syncopations
  const minDtDebounce = 0.065;
  const rapidDtThreshold = 0.220;

  // Step 1: Debounce acoustic flutter (< 65ms)
  const debouncedPeaks = [];
  for (let i = 0; i < globalPeaks.length; i++) {
    const p = globalPeaks[i];
    if (debouncedPeaks.length === 0 || (p - debouncedPeaks[debouncedPeaks.length - 1]) >= minDtDebounce) {
      debouncedPeaks.push(p);
    }
  }

  const chart = [];
  let prevLane = 1;
  let prevTime = -999.0;
  let altDirection = 1;

  for (let i = 0; i < debouncedPeaks.length; i++) {
    const tPeak = debouncedPeaks[i];
    const dt = tPeak - prevTime;
    const frameIdx = Math.min(nFrames - 1, Math.max(0, Math.round(tPeak / hopSec)));

    let primaryBand = 1;
    let sortedBands = [0, 1, 2, 3];

    if (sfBands && sfBands.length >= 4) {
      const bFlux = [
        sfBands[0][frameIdx] || 0,
        sfBands[1][frameIdx] || 0,
        sfBands[2][frameIdx] || 0,
        sfBands[3][frameIdx] || 0
      ];
      let maxVal = -1;
      for (let b = 0; b < 4; b++) {
        if (bFlux[b] > maxVal) {
          maxVal = bFlux[b];
          primaryBand = b;
        }
      }
      sortedBands = [0, 1, 2, 3].sort((a, b) => (bFlux[b] - bFlux[a]));
    }

    let assignedLane = primaryBand;

    // ПЕРЕКИДЫВАНИЕ (Alternation / Anti-Repetition Rule):
    if (dt < rapidDtThreshold) {
      if (primaryBand === prevLane) {
        const secondBest = sortedBands[1];
        if (secondBest !== undefined && secondBest !== prevLane) {
          assignedLane = secondBest;
        } else {
          if (prevLane === 0) {
            assignedLane = 1;
            altDirection = 1;
          } else if (prevLane === 3) {
            assignedLane = 2;
            altDirection = -1;
          } else {
            assignedLane = prevLane + altDirection;
            if (assignedLane < 0 || assignedLane > 3) {
              altDirection = -altDirection;
              assignedLane = prevLane + altDirection;
            }
          }
        }
      } else {
        assignedLane = primaryBand;
      }
    } else {
      assignedLane = primaryBand;
    }

    const domFreq = (frequencies.length > 0) ? (frequencies[assignedLane * Math.floor(frequencies.length / 4)] || 440) : 440;

    chart.push({
      time: Math.round(tPeak * 1000) / 1000,
      lane: assignedLane,
      type: "tap",
      duration: 0.0,
      freq: Math.round(domFreq * 10) / 10,
      amplitude: 1.0
    });

    prevLane = assignedLane;
    prevTime = tPeak;
  }

  analysisData.chart = chart;
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

function setupSpeedControls() {
  const speedButtons = document.querySelectorAll('.game-speed-btn');
  speedButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      speedButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const val = btn.dataset.speed;
      if (val === 'dynamic') {
        speedMode = 'dynamic';
      } else {
        speedMode = 'fixed';
        fixedTileSpeedMultiplier = parseFloat(val) || 2.75;
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

  const speedMultiplier = getCurrentSpeedMultiplier(curTime);
  const secPerNote = 1.0 / speedMultiplier;
  const speed = yHit / secPerNote;
  // 🎹 Tile Height: exactly ~5 tiles fit vertically on the screen (height / 5.2), regardless of speed
  const tileHeight = height / 5.2;

  let closestNoteIndex = -1;
  let minDistance = 999999;

  for (let i = 0; i < chart.length; i++) {
    const note = chart[i];
    if (note.lane !== lane) continue;
    if (noteHitStates[i]) continue; // Already hit

    const dtStart = note.time - curTime;
    const yCenter = yHit - (dtStart * speed);
    const yTop = yCenter - tileHeight / 2;
    const yBottom = yCenter + tileHeight / 2;

    const absTimeDiff = Math.abs(dtStart);

    // High Sensitivity Touch Detection:
    // 1) Direct touch anywhere on tile with generous padding (±50px)
    // 2) Wide timing window near target line (|dt| <= 220ms)
    const isTouchOnTile = (touchY >= yTop - 50 && touchY <= yBottom + 50) || (absTimeDiff <= 0.220);

    if (isTouchOnTile) {
      if (absTimeDiff < minDistance) {
        minDistance = absTimeDiff;
        closestNoteIndex = i;
      }
    }
  }

  if (closestNoteIndex !== -1) {
    // REGISTER HIT!
    noteHitStates[closestNoteIndex] = true;
    const note = chart[closestNoteIndex];
    const dtHit = Math.abs(note.time - curTime);

    let scoreAdd = 100;
    let ratingText = "+100 PERFECT!";
    if (dtHit <= 0.085) {
      scoreAdd = 100;
      ratingText = "+100 PERFECT!";
    } else if (dtHit <= 0.160) {
      scoreAdd = 70;
      ratingText = "+70 GREAT!";
    } else {
      scoreAdd = 40;
      ratingText = "+40 GOOD";
    }

    gameScore += scoreAdd;
    gameCombo += 1;

    const xCenter = (lane + 0.5) * laneWidth;
    const yExplosion = (touchY !== undefined && touchY > 0) ? touchY : yHit;

    // Spawn hit effect explosion particles
    createHitParticles(xCenter, yExplosion, BAND_COLORS[lane]);

    // Floating text rating
    hitEffects.push({
      x: xCenter,
      y: yExplosion - 20,
      text: ratingText,
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
  const speedMultiplier = getCurrentSpeedMultiplier(curTime);
  const secPerNote = 1.0 / speedMultiplier;
  const speed = yHit / secPerNote;
  // 🎹 Tile Height: exactly ~5 tiles fit vertically on the screen (height / 5.2), regardless of speed
  const tileHeight = height / 5.2;

  // Live dynamic HUD speed text
  if (gameSpeedLbl && frameCount % 6 === 0) {
    if (speedMode === 'dynamic') {
      gameSpeedLbl.textContent = `⚡ Скорость: ${speedMultiplier.toFixed(2)}x (2x➔3.5x)`;
    } else {
      gameSpeedLbl.textContent = `⚡ Скорость: ${speedMultiplier.toFixed(1)}x`;
    }
  }

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
    const dtFallThrough = (height - yHit + tileHeight) / speed;
    const dtLookahead = (yHit + tileHeight) / speed;
    const minTime = curTime - dtFallThrough - 0.1;
    const maxTime = curTime + dtLookahead + 0.1;

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
 * Draws vertical piano tile with height = height / 5.2 (4-5 tiles per screen), sleek gradient & rounded corners
 */
function drawVerticalTilePill(ctx, x, y, width, height, color) {
  ctx.save();

  // Gradient fill: glossy, vibrant piano tile
  const grad = ctx.createLinearGradient(x, y, x, y + height);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.12, color);
  grad.addColorStop(0.85, color);
  grad.addColorStop(1.0, color + 'cc');

  ctx.fillStyle = grad;
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(x, y, width, height, 10);
  } else {
    ctx.rect(x, y, width, height);
  }
  ctx.fill();

  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Bottom piano key accent bar
  ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(x + 8, y + height - 12, width - 16, 5, 2);
  } else {
    ctx.rect(x + 8, y + height - 12, width - 16, 5);
  }
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
