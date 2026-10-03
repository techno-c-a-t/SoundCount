"""
Complex Domain Novelty module: Computes Phase-Based Soft Attack Novelty curves
by measuring the deviation between actual and phase-predicted complex CQT values.
"""

import numpy as np
from src.utils.config import SAMPLE_RATE, HOP_SIZE, PEAK_ALPHA, PEAK_BETA, PEAK_WIN_SIZE
from src.novelty.spectral_flux import pick_peaks


def compute_complex_domain_novelty(
    C: np.ndarray,
    times: np.ndarray,
    win_sec: float = 3.0,
    sr: int = SAMPLE_RATE,
    hop_length: int = HOP_SIZE
) -> dict:
    """
    Computes Complex Domain Novelty function from complex CQT matrix C [n_bins x n_frames].

    For frame m and bin k:
    1. Expected phase angle: phi_pred(m, k) = 2 * phi(m-1, k) - phi(m-2, k)
    2. Expected complex value: C_hat(m, k) = |C(m-1, k)| * exp(i * phi_pred(m, k))
    3. Complex Domain Error: E(m, k) = |C(m, k) - C_hat(m, k)|
    4. CD[m] = sum_k E(m, k)

    Args:
        C (np.ndarray): Complex CQT matrix [n_bins x n_frames].
        times (np.ndarray): Timestamps array in seconds.
        win_sec (float): Sliding window size for local normalization in seconds.
        sr (int): Sample rate.
        hop_length (int): Hop size.

    Returns:
        dict containing:
            - 'cd_raw': Raw 1D Complex Domain Error array [n_frames]
            - 'cd_norm': 3s local window normalized CD array [n_frames]
            - 'matrix': 2D Complex Domain Error matrix [n_bins x n_frames]
            - 'peaks_sec': Detected attack timestamps in seconds
            - 'threshold': Adaptive threshold curve
    """
    n_bins, n_frames = C.shape

    if n_frames < 3:
        cd_raw = np.zeros(n_frames)
        return {
            "cd_raw": cd_raw,
            "cd_norm": cd_raw,
            "matrix": np.zeros((n_bins, n_frames)),
            "peaks_sec": np.array([]),
            "threshold": cd_raw
        }

    # Extract magnitude and phase
    S = np.abs(C)
    phi = np.angle(C)

    # Matrix for error per bin and frame
    E = np.zeros((n_bins, n_frames), dtype=np.float64)

    # Calculate predicted phase and complex error for frame m >= 2
    for m in range(2, n_frames):
        # Phase extrapolation: phi_pred = 2 * phi_{m-1} - phi_{m-2}
        phi_pred = 2.0 * phi[:, m - 1] - phi[:, m - 2]
        
        # Expected complex value with magnitude of m-1 and predicted phase
        C_hat = S[:, m - 1] * np.exp(1j * phi_pred)
        
        # Complex Euclidean distance |C(m) - C_hat(m)|
        E[:, m] = np.abs(C[:, m] - C_hat)

    # Sum across frequency bins
    cd_raw = np.sum(E, axis=0)

    # 3-second local max normalization over [m - W, m + W]
    half_win_frames = max(1, int((win_sec * sr) / (2 * hop_length)))
    cd_norm = np.zeros(n_frames, dtype=np.float64)

    for m in range(n_frames):
        w_start = max(0, m - half_win_frames)
        w_end = min(n_frames, m + half_win_frames + 1)
        local_max = np.max(cd_raw[w_start:w_end])
        if local_max > 0:
            cd_norm[m] = cd_raw[m] / local_max

    # Pick attack peaks
    peak_data = pick_peaks(cd_norm, times)

    return {
        "cd_raw": cd_raw,
        "cd_norm": cd_norm,
        "matrix": E,
        "peaks_sec": peak_data["peaks_sec"],
        "peaks_idx": peak_data["peaks_idx"],
        "threshold": peak_data["threshold"]
    }
