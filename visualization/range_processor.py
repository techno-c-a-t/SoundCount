"""
Range Processor: Recomputes DSP analysis (Brickwall bandpass, CQT, and 4-band spectral flux)
dynamically for any requested frequency range [f_low, f_high].
Distributes the 4 parallel frequency lanes logarithmically across the selected range.
"""

import os
import sys
import numpy as np
import soundfile as sf

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from src.preprocessing import load_audio, apply_bandpass_filter
from src.parsing import compute_cqt
from src.novelty.spectral_flux import compute_multiband_spectral_flux
from src.utils.config import SAMPLE_RATE, HOP_SIZE

DATA_INPUT_DIR = os.path.join(PROJECT_ROOT, "data", "input")

# In-memory audio cache to avoid re-reading MP3 from disk
_CACHED_AUDIO = {
    "path": None,
    "y": None,
    "sr": None,
    "duration": None
}


def get_cached_audio(audio_filename: str = "test_music.mp3"):
    audio_path = os.path.join(DATA_INPUT_DIR, audio_filename)
    if _CACHED_AUDIO["path"] != audio_path or _CACHED_AUDIO["y"] is None:
        y, sr, duration = load_audio(audio_path)
        _CACHED_AUDIO["path"] = audio_path
        _CACHED_AUDIO["y"] = y
        _CACHED_AUDIO["sr"] = sr
        _CACHED_AUDIO["duration"] = duration
    return _CACHED_AUDIO["y"], _CACHED_AUDIO["sr"], _CACHED_AUDIO["duration"]


def recompute_dsp_for_range(f_low: float = 30.0, f_high: float = 2000.0, audio_filename: str = "test_music.mp3") -> dict:
    """
    Physically filters audio to [f_low, f_high], computes CQT for that range,
    and partitions the 4 lanes logarithmically across the requested range.
    """
    y_raw, sr, duration = get_cached_audio(audio_filename)

    f_low = max(20.0, float(f_low))
    f_high = min(float(sr) / 2.0 - 50.0, float(f_high))
    if f_low >= f_high:
        f_low = max(20.0, f_high - 100.0)

    is_full_spectrum = (f_low <= 25.0 and f_high >= 11000.0)

    # 1. Physical audio filtering (Order 6 zero-phase Butterworth filter)
    if is_full_spectrum:
        y_filt = y_raw
        audio_name = audio_filename
    else:
        y_filt = apply_bandpass_filter(y_raw, sr, f_low, f_high, order=6)
        audio_name = f"range_{int(f_low)}_{int(f_high)}.wav"
        out_wav_path = os.path.join(DATA_INPUT_DIR, audio_name)
        if not os.path.exists(out_wav_path):
            sf.write(out_wav_path, y_filt, sr, subtype="PCM_16")

    # 2. CQT tuned to [f_low, f_high]
    fmin = max(20.0, f_low)
    n_octaves = np.log2(max(f_low + 20.0, f_high) / fmin)
    n_bins = max(24, min(120, int(np.ceil(n_octaves * 12))))
    
    cqt_res = compute_cqt(y_filt, sr=sr, fmin=fmin, n_bins=n_bins, bins_per_octave=12)
    S = cqt_res["S"]
    S_db = cqt_res["S_db"]
    times = cqt_res["times"]
    frequencies = cqt_res["frequencies"]

    # 3. 4-Band Spectral Flux log-distributed across [f_low, f_high]
    mb_data = compute_multiband_spectral_flux(S, times, n_bands=4, win_sec=3.0, sr=sr, hop_length=HOP_SIZE)

    # 4. Generate clean human-readable log-spaced band titles
    band_names = []
    color_emojis = ["🔴", "🟡", "🟢", "🔵"]
    band_ranges = mb_data["band_ranges"]
    for b in range(4):
        s_bin, e_bin = band_ranges[b]
        e_bin = min(len(frequencies) - 1, max(s_bin, e_bin - 1))
        f_start = frequencies[s_bin]
        f_end = frequencies[e_bin]
        band_names.append(f"{color_emojis[b]} Полоса {b+1} ({f_start:.0f} — {f_end:.0f} Гц)")

    global_name = f"🌐 Весь диапазон ({frequencies[0]:.0f} — {frequencies[-1]:.0f} Гц)"

    # Prepare serializable response
    return {
        "status": "ok",
        "audio_url": f"/audio/{audio_name}",
        "f_low": f_low,
        "f_high": f_high,
        "metadata": {
            "title": audio_filename,
            "duration_sec": round(duration, 3),
            "sample_rate": sr,
            "hop_length": HOP_SIZE,
            "n_bins": len(frequencies),
            "n_frames": len(times),
            "audio_filename": audio_name,
            "n_bands": 4,
            "band_names": band_names,
            "band_ranges": band_ranges,
            "global_band_name": global_name
        },
        "frequencies": np.round(frequencies, 1).tolist(),
        "times": np.round(times, 3).tolist(),
        "spectrogram_db": np.round(S_db, 2).tolist(),
        "global_track": {
            "name": global_name,
            "f_start": round(float(frequencies[0]), 1),
            "f_end": round(float(frequencies[-1]), 1),
            "sf": np.round(mb_data["global_sf"], 4).tolist(),
            "threshold": np.round(mb_data["global_threshold"], 4).tolist(),
            "peaks_sec": np.round(mb_data["global_peaks_sec"], 3).tolist()
        },
        "multiband": {
            "sf_bands": np.round(mb_data["sf_bands"], 4).tolist(),
            "thresholds_bands": np.round(mb_data["thresholds_bands"], 4).tolist(),
            "peaks_sec_bands": [np.round(p, 3).tolist() for p in mb_data["peaks_sec_bands"]],
            "merged_peaks_sec": np.round(mb_data["merged_peaks_sec"], 3).tolist(),
            "global_peaks_sec": np.round(mb_data["global_peaks_sec"], 3).tolist()
        }
    }
