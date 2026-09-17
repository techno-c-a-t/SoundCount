"""
Novelty module: Computes Multi-Band Spectral Flux onset novelty curves
with local sliding-window energy normalization (3-5s lookahead/lookbehind)
and per-band adaptive peak picking.
"""

import numpy as np
from src.utils.config import PEAK_ALPHA, PEAK_BETA, PEAK_WIN_SIZE, SAMPLE_RATE, HOP_SIZE


def compute_spectral_flux(S: np.ndarray) -> np.ndarray:
    """
    Computes global 1D Spectral Flux novelty function from magnitude spectrum S [n_bins x n_frames].
    """
    diff = np.diff(S, axis=1)
    relu_diff = np.maximum(0.0, diff)
    SF = np.sum(relu_diff, axis=0)
    SF = np.pad(SF, (1, 0), mode='constant', constant_values=0.0)

    max_flux = np.max(SF)
    if max_flux > 0:
        SF = SF / max_flux

    return SF


def compute_multiband_spectral_flux(
    S: np.ndarray,
    times: np.ndarray,
    n_bands: int = 4,
    win_sec: float = 3.0,
    sr: int = SAMPLE_RATE,
    hop_length: int = HOP_SIZE
) -> dict:
    """
    Computes Multi-Band Spectral Flux with local sliding-window normalization.

    Divides 84 CQT bins into 4 frequency bands (Bass, Tenor, Alto, Soprano)
    and normalizes each band's flux using a local 3-second sliding window
    to balance soft melodic attacks against heavy drums.

    Args:
        S (np.ndarray): Magnitude spectrum matrix [n_bins x n_frames].
        times (np.ndarray): Array of timestamps in seconds.
        n_bands (int): Number of frequency bands (default 4).
        win_sec (float): Local sliding window size in seconds (default 3.0s).
        sr (int): Sample rate.
        hop_length (int): Hop length.

    Returns:
        dict containing multi-band flux curves, per-band peaks, and thresholds.
    """
    n_bins, n_frames = S.shape
    diff = np.diff(S, axis=1)
    relu_diff = np.maximum(0.0, diff)
    relu_diff = np.pad(relu_diff, ((0, 0), (1, 0)), mode='constant', constant_values=0.0)

    # Define 4 frequency sub-bands across 84 CQT bins
    bins_per_band = n_bins // n_bands
    band_ranges = []
    band_names = ["Bass (Бас)", "Tenor (Тенор)", "Alto (Альт)", "Soprano (Сопрано)"]

    for b in range(n_bands):
        start_bin = b * bins_per_band
        end_bin = (b + 1) * bins_per_band if b < n_bands - 1 else n_bins
        band_ranges.append((start_bin, end_bin))

    sf_bands = np.zeros((n_bands, n_frames))
    sf_bands_norm = np.zeros((n_bands, n_frames))
    thresholds_bands = np.zeros((n_bands, n_frames))
    peaks_sec_bands = []

    half_win_frames = max(1, int((win_sec * sr) / (2 * hop_length)))

    # Compute per-band Spectral Flux and Local Sliding Window Normalization
    for b, (start_b, end_b) in enumerate(band_ranges):
        # Raw flux for band b
        raw_flux = np.sum(relu_diff[start_b:end_b, :], axis=0)
        sf_bands[b, :] = raw_flux

        # Local max normalization over [m - W, m + W] (3-second window)
        for m in range(n_frames):
            w_start = max(0, m - half_win_frames)
            w_end = min(n_frames, m + half_win_frames + 1)
            local_max = np.max(raw_flux[w_start:w_end])
            if local_max > 0:
                sf_bands_norm[b, m] = raw_flux[m] / local_max
            else:
                sf_bands_norm[b, m] = 0.0

        # Per-band peak picking
        band_peak_data = pick_peaks(sf_bands_norm[b, :], times)
        thresholds_bands[b, :] = band_peak_data["threshold"]
        peaks_sec_bands.append(band_peak_data["peaks_sec"].tolist())

    # Merge all band peaks into global peaks with 40ms debouncing
    all_peaks = []
    for p_list in peaks_sec_bands:
        all_peaks.extend(p_list)
    all_peaks = sorted(all_peaks)

    merged_peaks = []
    for t_peak in all_peaks:
        if not merged_peaks or (t_peak - merged_peaks[-1]) >= 0.040:
            merged_peaks.append(t_peak)

    return {
        "n_bands": n_bands,
        "band_names": band_names,
        "band_ranges": band_ranges,
        "sf_bands": sf_bands_norm,
        "thresholds_bands": thresholds_bands,
        "peaks_sec_bands": peaks_sec_bands,
        "merged_peaks_sec": merged_peaks
    }


def pick_peaks(
    SF: np.ndarray,
    times: np.ndarray,
    alpha: float = PEAK_ALPHA,
    beta: float = PEAK_BETA,
    win_size: int = PEAK_WIN_SIZE
) -> dict:
    """
    Applies adaptive thresholding to detect attack peaks in Spectral Flux novelty curve.
    """
    n_frames = len(SF)
    threshold = np.zeros(n_frames)
    half_win = win_size // 2

    for m in range(n_frames):
        start_idx = max(0, m - half_win)
        end_idx = min(n_frames, m + half_win + 1)
        window = SF[start_idx:end_idx]

        mu = np.mean(window)
        sigma = np.std(window)
        threshold[m] = mu + alpha * sigma + beta

    peaks_idx = []
    for m in range(1, n_frames - 1):
        if SF[m] > threshold[m] and SF[m] > SF[m - 1] and SF[m] >= SF[m + 1]:
            peaks_idx.append(m)

    peaks_idx = np.array(peaks_idx, dtype=int)
    peaks_sec = times[peaks_idx] if len(peaks_idx) > 0 else np.array([])

    return {
        "peaks_idx": peaks_idx,
        "peaks_sec": peaks_sec,
        "threshold": threshold
    }
