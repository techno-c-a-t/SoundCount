"""
Preprocessing module: Loads audio (.mp3, .m4a, .wav), converts to mono,
normalizes amplitude, and resamples to target sample rate (22050 Hz).
"""

import os
import numpy as np
import librosa
import soundfile as sf
from src.utils.config import SAMPLE_RATE


def load_audio(file_path: str, target_sr: int = SAMPLE_RATE) -> tuple[np.ndarray, int, float]:
    """
    Loads an audio file, converts it to mono, resamples to target_sr,
    and normalizes amplitude to range [-1.0, 1.0].

    Returns:
        y (np.ndarray): Mono audio time-series array.
        sr (int): Sample rate (target_sr).
        duration (float): Duration in seconds.
    """
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"Audio file not found: {file_path}")

    # Load audio using librosa (handles mp3, m4a, wav automatically)
    y, sr = librosa.load(file_path, sr=target_sr, mono=True)

    # Normalize amplitude
    max_val = np.max(np.abs(y))
    if max_val > 0:
        y = y / max_val

    duration = float(len(y)) / float(sr)
    return y, sr, duration


def save_wav(y: np.ndarray, output_path: str, sr: int = SAMPLE_RATE) -> None:
    """Saves normalized mono audio signal to a PCM WAV file."""
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    sf.write(output_path, y, sr)
