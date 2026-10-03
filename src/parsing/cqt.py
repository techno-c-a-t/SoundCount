"""
Parsing module: Computes Constant-Q Transform (CQT) and STFT spectrograms.
"""

import numpy as np
import librosa
from src.utils.config import SAMPLE_RATE, HOP_SIZE, CQT_BINS, BINS_PER_OCTAVE, FMIN


def compute_cqt(
    y: np.ndarray,
    sr: int = SAMPLE_RATE,
    hop_length: int = HOP_SIZE,
    n_bins: int = CQT_BINS,
    bins_per_octave: int = BINS_PER_OCTAVE,
    fmin: float = FMIN
) -> dict:
    """
    Computes Constant-Q Transform (CQT) of input audio signal.

    Args:
        y (np.ndarray): Audio signal array.
        sr (int): Sampling rate.
        hop_length (int): Hop length in samples.
        n_bins (int): Number of frequency bins.
        bins_per_octave (int): Bins per octave (12 semitones).
        fmin (float): Lowest frequency (C1 = 32.7 Hz).

    Returns:
        dict containing:
            - 'C': Complex CQT matrix [n_bins x n_frames]
            - 'S': Magnitude spectrum |C| [n_bins x n_frames]
            - 'S_db': Log-scaled magnitude spectrum in dB
            - 'frequencies': Frequency in Hz for each bin
            - 'times': Time in seconds for each frame
    """
    # Complex CQT matrix
    C = librosa.cqt(
        y=y,
        sr=sr,
        hop_length=hop_length,
        fmin=fmin,
        n_bins=n_bins,
        bins_per_octave=bins_per_octave
    )

    # Magnitude spectrum (absolute value of complex numbers)
    S = np.abs(C)

    # Convert amplitude to dB scale
    S_db = librosa.amplitude_to_db(S, ref=np.max)

    # Frequency array for each CQT bin
    frequencies = librosa.cqt_frequencies(
        n_bins=n_bins,
        fmin=fmin,
        bins_per_octave=bins_per_octave
    )

    # Time array for each frame center
    n_frames = S.shape[1]
    times = librosa.frames_to_time(np.arange(n_frames), sr=sr, hop_length=hop_length)

    return {
        "C": C,
        "S": S,
        "S_db": S_db,
        "frequencies": frequencies,
        "times": times,
        "hop_length": hop_length,
        "sample_rate": sr
    }


def compute_stft(
    y: np.ndarray,
    sr: int = SAMPLE_RATE,
    hop_length: int = HOP_SIZE,
    n_fft: int = 1024
) -> dict:
    """
    Computes Short-Time Fourier Transform (STFT) of input audio signal.

    Args:
        y (np.ndarray): Audio signal array.
        sr (int): Sampling rate.
        hop_length (int): Hop length in samples.
        n_fft (int): FFT window size (1024 -> 513 linear frequency bins).

    Returns:
        dict containing:
            - 'D': Complex STFT matrix [n_bins x n_frames]
            - 'S': Magnitude spectrum |D| [n_bins x n_frames]
            - 'S_db': Log-scaled magnitude spectrum in dB
            - 'frequencies': Frequency in Hz for each bin
            - 'times': Time in seconds for each frame
    """
    D = librosa.stft(y=y, n_fft=n_fft, hop_length=hop_length)
    S = np.abs(D)
    S_db = librosa.amplitude_to_db(S, ref=np.max)
    frequencies = librosa.fft_frequencies(sr=sr, n_fft=n_fft)
    n_frames = S.shape[1]
    times = librosa.frames_to_time(np.arange(n_frames), sr=sr, hop_length=hop_length)

    return {
        "D": D,
        "S": S,
        "S_db": S_db,
        "frequencies": frequencies,
        "times": times,
        "hop_length": hop_length,
        "sample_rate": sr
    }

