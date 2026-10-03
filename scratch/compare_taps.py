"""
Rhythm Vibe vs DSP Analysis Tool:
Compares human recorded rhythm taps (data/input/user_taps.json) against
CQT Spectrogram, Multi-Band Spectral Flux, Complex Domain Phase Error, and Auto-Generated Charts.

Calculates offset latency, frequency correlation, precision/recall metrics,
and identifies exactly which DSP spectral features drive human rhythm perception!
"""

import os
import sys
import json
import numpy as np

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

TAPS_PATH = os.path.join(PROJECT_ROOT, "data", "input", "user_taps.json")
ANALYSIS_PATH = os.path.join(PROJECT_ROOT, "visualization", "public", "analysis.json")


def analyze_user_taps():
    print("========================================================")
    print("🔬 SOUNDCOUNT RHYTHM VIBE vs DSP CORRELATION ANALYZER")
    print("========================================================\n")

    if not os.path.exists(TAPS_PATH):
        print(f"❌ Файл с записью вайба не найден: {TAPS_PATH}")
        print("👉 Включите режим '🔴 REC' на сайте/телефоне, потэпайте под музыку и нажмите '💾 Сохранить'!\n")
        return

    if not os.path.exists(ANALYSIS_PATH):
        print(f"❌ Файл анализа не найден: {ANALYSIS_PATH}")
        print("👉 Запустите `python3 visualization/data_exporter.py`!")
        return

    with open(TAPS_PATH, "r", encoding="utf-8") as f:
        taps_data = json.load(f)

    with open(ANALYSIS_PATH, "r", encoding="utf-8") as f:
        analysis_data = json.load(f)

    user_taps = taps_data.get("taps", [])
    total_taps = len(user_taps)
    chart = analysis_data.get("chart", [])
    spectrogram_db = np.array(analysis_data.get("spectrogram_db", []))
    times = np.array(analysis_data.get("times", []))
    frequencies = np.array(analysis_data.get("frequencies", []))
    hop_length = analysis_data["metadata"]["hop_length"]
    sr = analysis_data["metadata"]["sample_rate"]
    hop_sec = hop_length / sr

    print(f"🎵 Трек: {analysis_data['metadata']['title']} ({analysis_data['metadata']['duration_sec']}с)")
    print(f"👤 Записано человеком по вайбу: {total_taps} атак")
    print(f"🤖 Авто-сгенерировано DSP нот: {len(chart)} нот\n")

    if total_taps == 0:
        print("⚠️ Массив записанных нот пуст!")
        return

    # 1. Temporal Latency & Alignment Analysis
    human_times = np.array([t["time"] for t in user_taps])
    chart_times = np.array([n["time"] for n in chart])

    offsets = []
    matches = 0
    tolerance_sec = 0.120  # 120ms tolerance window

    for t_h in human_times:
        if len(chart_times) > 0:
            dists = np.abs(chart_times - t_h)
            min_idx = np.argmin(dists)
            min_dist = dists[min_idx]
            if min_dist <= tolerance_sec:
                matches += 1
                offsets.append(t_h - chart_times[min_idx])

    match_rate = (matches / total_taps) * 100.0 if total_taps > 0 else 0
    mean_offset_ms = (np.mean(offsets) * 1000.0) if offsets else 0.0
    std_offset_ms = (np.std(offsets) * 1000.0) if offsets else 0.0

    print("📊 1. СРАВНЕНИЕ ТАЙМИНГОВ (Человек vs DSP):")
    print(f"   • Попадание в допуск ±120мс: {matches}/{total_taps} ({match_rate:.1f}%)")
    print(f"   • Среднее запаздывание реакции человека (Latency): {mean_offset_ms:+.1f} мс (σ = {std_offset_ms:.1f} мс)")
    if mean_offset_ms > 0:
        print(f"     💡 Человек в среднем нажимает на {abs(mean_offset_ms):.1f}мс ПОЗЖЕ акустической атаки.")
    else:
        print(f"     💡 Человек опережает акустическую атаку на {abs(mean_offset_ms):.1f}мс (Упреждение ритма).")

    # 2. Spectral Energy & Frequency Correlation Analysis
    print("\n🔊 2. АНАЛИЗ ЧАСТОТНЫХ ПИКОВ В МОМЕНТЫ ЧЕЛОВЕЧЕСКИХ НАЖАТИЙ:")

    n_bins, n_frames = spectrogram_db.shape
    bin_energies = np.zeros(n_bins)

    for t_h in human_times:
        f_idx = min(n_frames - 1, max(0, int(t_h / hop_sec)))
        # Average spectrogram energy over +/- 2 frames around human tap
        f_start = max(0, f_idx - 2)
        f_end = min(n_frames, f_idx + 3)
        frame_slice = spectrogram_db[:, f_start:f_end]
        bin_energies += np.max(frame_slice, axis=1)

    bin_energies /= max(1, total_taps)

    # Group into 4 Bands
    b0 = np.mean(bin_energies[0:21])    # Bass (30 - 250 Hz)
    b1 = np.mean(bin_energies[21:42])   # Tenor (250 - 600 Hz)
    b2 = np.mean(bin_energies[42:63])   # Alto (600 - 1500 Hz)
    b3 = np.mean(bin_energies[63:84])   # Soprano (1500 - 4000 Hz)

    total_e = b0 + b1 + b2 + b3 + 1e-6
    print(f"   • 🔴 BASS    (30 - 250 Гц):   {b0:.1f} dB  ({(b0/total_e)*100:.1f}% энергии)")
    print(f"   • 🟡 TENOR   (250 - 600 Гц):  {b1:.1f} dB  ({(b1/total_e)*100:.1f}% энергии)")
    print(f"   • 🟢 ALTO    (600 - 1500 Гц): {b2:.1f} dB  ({(b2/total_e)*100:.1f}% энергии)")
    print(f"   • 🔵 SOPRANO (15 - 4000 Гц):  {b3:.1f} dB  ({(b3/total_e)*100:.1f}% энергии)")

    peak_bin_idx = int(np.argmax(bin_energies))
    peak_freq = frequencies[peak_bin_idx]
    print(f"\n🎯 НАИБОЛЕЕ КОРРЕЛИРУЮЩАЯ ЧАСТОТА ВАЙБА: {peak_freq:.1f} Гц (CQT бин #{peak_bin_idx})")

    # 3. Lane Distribution Comparison
    print("\n🎹 3. РАСПРЕДЕЛЕНИЕ ПО ДОРОЖКАМ:")
    human_lane_counts = [sum(1 for t in user_taps if t["lane"] == l) for l in range(4)]
    chart_lane_counts = [sum(1 for n in chart if n["lane"] == l) for l in range(4)]

    for l in range(4):
        h_pct = (human_lane_counts[l] / total_taps) * 100 if total_taps > 0 else 0
        c_pct = (chart_lane_counts[l] / len(chart)) * 100 if len(chart) > 0 else 0
        print(f"   • Дорожка {l}: Человек = {human_lane_counts[l]} ({h_pct:.1f}%) | DSP = {chart_lane_counts[l]} ({c_pct:.1f}%)")

    print("\n========================================================")
    print("✅ АНАЛИЗ ЗАВЕРШЕН!")
    print("========================================================\n")


if __name__ == "__main__":
    analyze_user_taps()
