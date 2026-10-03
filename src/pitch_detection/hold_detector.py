"""
Hold Detector module: Classifies extracted musical events into Tap Notes (tap)
and Hold Notes (hold) based on energy sustain tracking > 1.0 second.
"""

from dataclasses import dataclass
import numpy as np
from src.pitch_detection.event_band_estimator import MusicalEvent
from src.utils.config import SAMPLE_RATE, HOP_SIZE


@dataclass
class ProcessedNote:
    time_sec: float
    duration_sec: float
    note_type: str  # "tap" or "hold"
    bin_idx: int
    pitch_freq: float
    band_idx: int
    amplitude: float


def detect_hold_notes(
    events: list[MusicalEvent],
    S: np.ndarray,
    times: np.ndarray,
    gamma: float = 0.40,
    hold_threshold_sec: float = 0.700,
    min_isolation_sec: float = 0.500,
    sr: int = SAMPLE_RATE,
    hop_length: int = HOP_SIZE
) -> list[ProcessedNote]:
    """
    Traces energy decay for each musical event and classifies it as either
    a Tap Note (duration = 0.0s) or a Hold Note (duration >= 1.0s).

    Args:
        events (list[MusicalEvent]): Accepted events from event_band_estimator.
        S (np.ndarray): Magnitude spectrum matrix [n_bins x n_frames].
        times (np.ndarray): Array of timestamps in seconds.
        gamma (float): Minimum sustain energy threshold relative to onset amplitude.
        hold_threshold_sec (float): Minimum duration in seconds to qualify as Hold Note (default 1.0s).
        sr (int): Sampling rate.
        hop_length (int): Hop size.

    Returns:
        list[ProcessedNote]: List of classified notes with duration_sec and note_type.
    """
    n_bins, n_frames = S.shape
    if not events:
        return []

    # Map onset frame indices to avoid extending hold past a subsequent onset
    onset_frames_set = set(e.frame_idx for e in events)

    processed_notes: list[ProcessedNote] = []

    for idx, event in enumerate(events):
        m_start = event.frame_idx
        k_peak = event.bin_idx
        A_0 = event.amplitude

        m_end = m_start

        # Trace energy sustain across subsequent frames
        for m in range(m_start + 1, n_frames):
            # Stop if another onset starts at or near this frame
            if m in onset_frames_set and m > m_start + 2:
                # Check if next onset is nearby in pitch
                next_events = [e for e in events if e.frame_idx == m]
                if any(abs(e.bin_idx - k_peak) <= 2 for e in next_events):
                    break

            # Local energy check around k_peak (+/- 1 bin to account for vibrato)
            k_min = max(0, k_peak - 1)
            k_max = min(n_bins, k_peak + 2)
            current_energy = np.max(S[k_min:k_max, m])

            if current_energy >= gamma * A_0:
                m_end = m
            else:
                break

        duration_sec = float(times[m_end] - times[m_start])

        # Check gap before and gap after
        gap_before = float(event.time_sec - events[idx - 1].time_sec) if idx > 0 else 1.0
        gap_after = float(events[idx + 1].time_sec - event.time_sec) if idx < len(events) - 1 else 1.0

        if duration_sec >= hold_threshold_sec and gap_before >= min_isolation_sec and gap_after >= min_isolation_sec:
            note_type = "hold"
            duration = float(np.round(duration_sec, 3))
        else:
            note_type = "tap"
            duration = 0.0

        processed_notes.append(ProcessedNote(
            time_sec=float(np.round(event.time_sec, 3)),
            duration_sec=duration,
            note_type=note_type,
            bin_idx=event.bin_idx,
            pitch_freq=float(np.round(event.pitch_freq, 2)),
            band_idx=event.band_idx,
            amplitude=float(np.round(event.amplitude, 4))
        ))

    # Hold Exclusion Zone: Remove any note that falls inside an active Hold Note window [tStart - 0.15s, tEnd + 0.15s]
    hold_spans = [(n.time_sec - 0.150, n.time_sec + n.duration_sec + 0.150, n) for n in processed_notes if n.note_type == "hold"]

    final_notes: list[ProcessedNote] = []
    for note in processed_notes:
        if note.note_type == "hold":
            final_notes.append(note)
        else:
            # Drop tap note if it occurs during any hold note span
            is_occluded = any(span_start <= note.time_sec <= span_end and note is not note_ref for span_start, span_end, note_ref in hold_spans)
            if not is_occluded:
                final_notes.append(note)

    return final_notes
