"""
Data Exporter: Processes an audio file through the full Sprint 1 & Sprint 2 DSP pipeline
(ingest -> CQT -> Multi-Band Spectral Flux -> Complex Domain Novelty ->
 Overlapping Bands with Corridor Blocking -> Hold Notes Detection -> Viterbi Lane Mapper)
and exports full analysis data, blocked corridor mask, and 4-lane gameplay chart to JSON format.
"""

import os
import sys
import json
import numpy as np

# Add project root to sys.path
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from src.preprocessing import load_audio, save_wav
from src.parsing import compute_cqt
from src.novelty.spectral_flux import compute_spectral_flux, pick_peaks, compute_multiband_spectral_flux
from src.novelty.complex_domain import compute_complex_domain_novelty
from src.pitch_detection.event_band_estimator import extract_events_with_corridor_blocking
from src.pitch_detection.hold_detector import detect_hold_notes
from src.chart_generator.viterbi_mapper import generate_chart_with_viterbi, generate_relative_pitch_direction_chart
from src.chart_generator.beat_mapper import generate_piano_chart_from_global_beat
from src.utils.config import SAMPLE_RATE, HOP_SIZE, CQT_BINS


def create_synthetic_demo_audio(filename: str = "demo_piano.wav") -> str:
    """Generates a synthetic demo piano-like scale WAV file if no input audio is provided."""
    data_dir = os.path.join(PROJECT_ROOT, "data", "input")
    os.makedirs(data_dir, exist_ok=True)
    filepath = os.path.join(data_dir, filename)

    sr = SAMPLE_RATE
    duration_sec = 4.0
    t = np.linspace(0, duration_sec, int(sr * duration_sec), endpoint=False)
    y = np.zeros_like(t)

    # Piano scale notes (C4, E4, G4, C5) with sharp exponential decay attacks
    freqs = [261.63, 329.63, 392.00, 523.25]
    start_times = [0.2, 1.0, 1.8, 2.6]

    for f_note, t_start in zip(freqs, start_times):
        mask = t >= t_start
        t_note = t[mask] - t_start
        note_wave = (
            1.0 * np.sin(2 * np.pi * f_note * t_note) +
            0.5 * np.sin(2 * np.pi * 2 * f_note * t_note) +
            0.25 * np.sin(2 * np.pi * 3 * f_note * t_note)
        ) * np.exp(-4.0 * t_note)
        y[mask] += note_wave

    y = y / np.max(np.abs(y))
    save_wav(y, filepath, sr)
    print(f"Generated demo audio: {filepath}")
    return filepath


def export_analysis_to_json(audio_path: str, output_json_path: str) -> str:
    """Runs full DSP pipeline on audio_path and writes analysis.json."""
    print(f"1. Loading audio from: {audio_path}...")
    y, sr, duration = load_audio(audio_path)

    print("2. Computing Constant-Q Transform (CQT)...")
    cqt_data = compute_cqt(y, sr=sr)
    C = cqt_data["C"]
    S = cqt_data["S"]
    S_db = cqt_data["S_db"]
    frequencies = cqt_data["frequencies"]
    times = cqt_data["times"]

    print("3. Computing Global Spectral Flux Novelty (ReLU)...")
    SF = compute_spectral_flux(S)
    peak_data = pick_peaks(SF, times)

    print("4. Computing Multi-Band Spectral Flux with 3s Sliding Window Normalization...")
    mb_data = compute_multiband_spectral_flux(S, times, n_bands=4, win_sec=3.0, sr=sr, hop_length=HOP_SIZE)

    print("5. Computing Complex Domain Phase Tracking Novelty...")
    cd_data = compute_complex_domain_novelty(C, times, win_sec=3.0, sr=sr, hop_length=HOP_SIZE)

    print("6. Extracting Events with Overlapping Bands & Frequency Corridor Blocking...")
    events, blocked_mask = extract_events_with_corridor_blocking(
        S, C, times, frequencies, n_bands=4, corridor_ratio=0.20, block_start_sec=1.000, block_end_sec=0.400, sr=sr, hop_length=HOP_SIZE
    )

    print("7. Detecting Hold Notes (> 0.7s sustain)...")
    processed_notes = detect_hold_notes(events, S, times, gamma=0.40, hold_threshold_sec=0.700, sr=sr, hop_length=HOP_SIZE)

    print("8. Generating 4-lane Piano Gameplay Chart via Global Beat + Alternation...")
    chart = generate_piano_chart_from_global_beat(
        global_peaks_sec=mb_data["global_peaks_sec"],
        sf_bands=mb_data["sf_bands"],
        times=times,
        frequencies=frequencies,
        S=S,
        n_lanes=4
    )

    taps_count = sum(1 for n in chart if n["type"] == "tap")
    holds_count = sum(1 for n in chart if n["type"] == "hold")
    print(f"   Chart generated: {len(chart)} total notes ({taps_count} Taps, {holds_count} Hold Sliders).")

    # Prepare serializable arrays
    spectrogram_db_list = np.round(S_db, 2).tolist()
    spectral_flux_list = np.round(SF, 4).tolist()
    threshold_list = np.round(peak_data["threshold"], 4).tolist()
    times_list = np.round(times, 3).tolist()
    frequencies_list = np.round(frequencies, 1).tolist()
    peaks_sec_list = np.round(peak_data["peaks_sec"], 3).tolist()

    # Multi-band serializable arrays
    sf_bands_list = np.round(mb_data["sf_bands"], 4).tolist()
    thresholds_bands_list = np.round(mb_data["thresholds_bands"], 4).tolist()
    peaks_sec_bands_list = [np.round(p, 3).tolist() for p in mb_data["peaks_sec_bands"]]
    merged_peaks_sec_list = np.round(mb_data["merged_peaks_sec"], 3).tolist()

    # Complex domain serializable arrays
    cd_norm_list = np.round(cd_data["cd_norm"], 4).tolist()
    cd_peaks_sec_list = np.round(cd_data["peaks_sec"], 3).tolist()

    # Blocked corridor bins per frame
    blocked_bins_list = [[int(b) for b in np.where(blocked_mask[:, m])[0]] for m in range(len(times))]

    export_payload = {
        "metadata": {
            "title": os.path.basename(audio_path),
            "duration_sec": round(duration, 3),
            "sample_rate": sr,
            "hop_length": HOP_SIZE,
            "n_bins": len(frequencies),
            "n_frames": len(times),
            "audio_filename": os.path.basename(audio_path),
            "n_bands": 4,
            "band_names": mb_data["band_names"],
            "band_ranges": mb_data["band_ranges"],
            "total_notes": len(chart),
            "tap_notes_count": taps_count,
            "hold_notes_count": holds_count
        },
        "frequencies": frequencies_list,
        "times": times_list,
        "spectrogram_db": spectrogram_db_list,
        "spectral_flux": spectral_flux_list,
        "threshold": threshold_list,
        "peaks_sec": peaks_sec_list,
        "complex_domain": cd_norm_list,
        "cd_peaks_sec": cd_peaks_sec_list,
        "blocked_bins": blocked_bins_list,
        "global_track": {
            "name": f"🌐 Весь диапазон ({frequencies[0]:.0f} — {frequencies[-1]:.0f} Гц)",
            "f_start": round(float(frequencies[0]), 1),
            "f_end": round(float(frequencies[-1]), 1),
            "sf": np.round(mb_data["global_sf"], 4).tolist(),
            "threshold": np.round(mb_data["global_threshold"], 4).tolist(),
            "peaks_sec": np.round(mb_data["global_peaks_sec"], 3).tolist()
        },
        "multiband": {
            "sf_bands": sf_bands_list,
            "thresholds_bands": thresholds_bands_list,
            "peaks_sec_bands": peaks_sec_bands_list,
            "merged_peaks_sec": merged_peaks_sec_list,
            "global_peaks_sec": np.round(mb_data["global_peaks_sec"], 3).tolist()
        },
        "chart": chart
    }

    os.makedirs(os.path.dirname(output_json_path), exist_ok=True)
    with open(output_json_path, "w", encoding="utf-8") as f:
        json.dump(export_payload, f, indent=2)

    print(f"Full Sprint 1 & 2 analysis successfully exported to: {output_json_path}")
    return output_json_path


if __name__ == "__main__":
    if len(sys.argv) > 1:
        input_file = sys.argv[1]
    else:
        input_dir = os.path.join(PROJECT_ROOT, "data", "input")
        os.makedirs(input_dir, exist_ok=True)
        files = [os.path.join(input_dir, f) for f in os.listdir(input_dir) if f.endswith(('.mp3', '.m4a', '.wav'))]
        test_music = [f for f in files if os.path.basename(f) == "test_music.mp3"]
        if test_music:
            input_file = test_music[0]
        elif files:
            input_file = files[0]
        else:
            input_file = create_synthetic_demo_audio()

    output_json = os.path.join(PROJECT_ROOT, "visualization", "public", "analysis.json")
    export_analysis_to_json(input_file, output_json)
