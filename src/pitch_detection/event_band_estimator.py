"""
Event Band Estimator module: Implements 4 overlapping frequency bands,
dynamic unblocked peak search, time-decaying corridor blocking (1.0s -> 0.4s),
and Non-Adjacent Chording & 100ms Min-Gap Temporal Quantization.
"""

from dataclasses import dataclass
import numpy as np
from src.utils.config import SAMPLE_RATE, HOP_SIZE, CQT_BINS
from src.novelty.spectral_flux import pick_peaks


@dataclass
class MusicalEvent:
    time_sec: float
    frame_idx: int
    bin_idx: int
    pitch_freq: float
    band_idx: int
    amplitude: float


def extract_events_with_corridor_blocking(
    S: np.ndarray,
    C: np.ndarray,
    times: np.ndarray,
    frequencies: np.ndarray,
    n_bands: int = 4,
    overlap_ratio: float = 0.20,
    corridor_ratio: float = 0.20,
    block_start_sec: float = 1.000,
    block_end_sec: float = 0.400,
    min_amplitude_ratio: float = 0.05,
    chord_window_sec: float = 0.040,
    min_gap_sec: float = 0.100,
    sr: int = SAMPLE_RATE,
    hop_length: int = HOP_SIZE
) -> tuple[list[MusicalEvent], np.ndarray]:
    """
    Extracts musical event candidates using 4 overlapping frequency bands,
    dynamic unblocked peak search, time-decaying corridor blocking (1.0s at start -> 0.4s at end),
    and Chording without adjacent lanes + 100ms Min-Gap Quantization.
    """
    n_bins, n_frames = S.shape
    if n_frames == 0:
        return [], np.zeros((n_bins, 0), dtype=bool)

    # 1. Define 4 overlapping frequency bands across K=84 CQT bins
    band_ranges = define_overlapping_bands(n_bins=n_bins, n_bands=n_bands, overlap_ratio=overlap_ratio)

    # 2. Compute combined Spectral Flux + Phase Error per band
    diff_S = np.pad(np.maximum(0.0, np.diff(S, axis=1)), ((0, 0), (1, 0)), mode='constant')
    
    # Calculate Phase Error matrix E from complex CQT C
    E = np.zeros_like(S)
    if C is not None and n_frames >= 3:
        S_C = np.abs(C)
        phi = np.angle(C)
        for m in range(2, n_frames):
            phi_pred = 2.0 * phi[:, m - 1] - phi[:, m - 2]
            C_hat = S_C[:, m - 1] * np.exp(1j * phi_pred)
            E[:, m] = np.abs(C[:, m] - C_hat)
        max_E = np.max(E)
        if max_E > 0:
            E = E / max_E

    # Normalize diff_S
    max_diff = np.max(diff_S)
    if max_diff > 0:
        diff_S_norm = diff_S / max_diff
    else:
        diff_S_norm = diff_S

    # Combined novelty matrix per bin
    novelty_matrix = diff_S_norm + 0.5 * E

    # 3. Detect candidate attacks per band
    raw_candidates = []
    half_win_frames = max(1, int((3.0 * sr) / (2 * hop_length)))

    for b, (start_b, end_b) in enumerate(band_ranges):
        band_novelty = np.sum(novelty_matrix[start_b:end_b, :], axis=0)

        # 3-second local max normalization
        band_novelty_norm = np.zeros(n_frames)
        for m in range(n_frames):
            w_start = max(0, m - half_win_frames)
            w_end = min(n_frames, m + half_win_frames + 1)
            local_max = np.max(band_novelty[w_start:w_end])
            if local_max > 0:
                band_novelty_norm[m] = band_novelty[m] / local_max

        # Pick peaks in band novelty
        peak_data = pick_peaks(band_novelty_norm, times)
        for m_idx in peak_data["peaks_idx"]:
            raw_candidates.append((m_idx, b))

    # Sort raw candidates by frame index (chronological order)
    raw_candidates.sort(key=lambda x: x[0])

    # 4. Corridor Blocking Filter with Unblocked Peak Search & Time-Decaying Duration (1.0s -> 0.4s)
    corridor_half_width = max(1, int(corridor_ratio * n_bins / 2.0))
    blocked_mask = np.zeros((n_bins, n_frames), dtype=bool)
    global_max_amp = np.max(S)
    band_max_amps = [np.max(S[sb:eb, :]) if eb > sb else global_max_amp for sb, eb in band_ranges]

    accepted_events: list[MusicalEvent] = []

    for m_idx, band_idx in raw_candidates:
        start_b, end_b = band_ranges[band_idx]
        min_amp = min_amplitude_ratio * max(global_max_amp * 0.02, band_max_amps[band_idx])
        
        # Search for peak bin ONLY among UNBLOCKED bins in this band
        unblocked_bins = [k for k in range(start_b, end_b) if not blocked_mask[k, m_idx]]
        if not unblocked_bins:
            continue  # All bins in this band are currently blocked by corridors

        # Find max amplitude among unblocked bins
        unblocked_amps = [S[k, m_idx] for k in unblocked_bins]
        best_local_idx = int(np.argmax(unblocked_amps))
        peak_bin = unblocked_bins[best_local_idx]
        peak_amp = unblocked_amps[best_local_idx]

        if peak_amp < min_amp:
            continue

        # Create event
        event = MusicalEvent(
            time_sec=float(times[m_idx]),
            frame_idx=int(m_idx),
            bin_idx=int(peak_bin),
            pitch_freq=float(frequencies[peak_bin]),
            band_idx=int(band_idx),
            amplitude=float(peak_amp)
        )
        accepted_events.append(event)

        # Dynamic time-decaying blocking duration: 1.0s at start -> 0.4s at end of track
        t_ratio = float(m_idx) / float(max(1, n_frames - 1))
        curr_block_dur_sec = block_start_sec - (block_start_sec - block_end_sec) * t_ratio
        block_frames = max(1, int((curr_block_dur_sec * sr) / hop_length))

        # Apply Corridor Blocking across frequency bins and time frames
        c_start = max(0, peak_bin - corridor_half_width)
        c_end = min(n_bins, peak_bin + corridor_half_width + 1)
        m_end = min(n_frames, m_idx + block_frames)

        blocked_mask[c_start:c_end, m_idx:m_end] = True

    # 5. Chording (No Adjacent Bands/Lanes) & 100ms Min-Gap Quantization / Debouncing
    final_events = quantize_and_chord_events(
        accepted_events,
        chord_window_sec=chord_window_sec,
        min_gap_sec=min_gap_sec,
        max_chord_size=2
    )

    return final_events, blocked_mask


def quantize_and_chord_events(
    events: list[MusicalEvent],
    chord_window_sec: float = 0.040,
    min_gap_sec: float = 0.100,
    max_chord_size: int = 2
) -> list[MusicalEvent]:
    """
    Groups events within 40ms into simultaneous chords (1-in-1 vertical alignment),
    disallowing adjacent bands in chords (|b1 - b2| >= 2), and enforces a 100ms min gap.
    """
    if not events:
        return []

    # Pass 1: Group events within 40ms into chords (No adjacent bands!)
    chorted: list[MusicalEvent] = []
    i = 0
    N = len(events)

    while i < N:
        curr_e = events[i]
        chord_group = [curr_e]
        j = i + 1

        while j < N and (events[j].time_sec - curr_e.time_sec) <= chord_window_sec:
            cand = events[j]
            # Disallow adjacent bands in the same chord (|b1 - b2| >= 2)
            if not any(abs(e.band_idx - cand.band_idx) < 2 for e in chord_group):
                chord_group.append(cand)
            j += 1

        # Limit chord size to max 2 simultaneous notes
        if len(chord_group) > max_chord_size:
            chord_group.sort(key=lambda e: e.amplitude, reverse=True)
            chord_group = chord_group[:max_chord_size]

        # Snap all notes in chord to exact same timestamp
        chord_time = curr_e.time_sec
        for e in chord_group:
            e.time_sec = chord_time
            chorted.append(e)

        i = j

    # Pass 2: Enforce min 100ms gap between separate note groups
    final_list: list[MusicalEvent] = []
    for e in chorted:
        if not final_list:
            final_list.append(e)
            continue

        prev_time = final_list[-1].time_sec
        dt = e.time_sec - prev_time

        if dt == 0.0:
            # Note is part of the exact same chord -> keep!
            final_list.append(e)
        elif dt >= min_gap_sec:
            # Clean 100ms+ gap -> keep!
            final_list.append(e)
        else:
            # Near-collision gap (0ms < dt < 100ms)
            # If dt <= 60ms, attempt to snap to previous chord if non-adjacent
            same_chord = [x for x in final_list if x.time_sec == prev_time]
            if dt <= 0.060 and len(same_chord) < max_chord_size and not any(abs(x.band_idx - e.band_idx) < 2 for x in same_chord):
                e.time_sec = prev_time
                final_list.append(e)
            else:
                # Drop awkward near-collision micro-flam
                pass

    return final_list


def define_overlapping_bands(n_bins: int = CQT_BINS, n_bands: int = 4, overlap_ratio: float = 0.20) -> list[tuple[int, int]]:
    """
    Computes 4 overlapping bin ranges across K=84 CQT bins.
    """
    band_ranges = []
    base_width = n_bins / float(n_bands)
    overlap_bins = int(base_width * overlap_ratio * 2)

    for b in range(n_bands):
        start_bin = max(0, int(b * base_width - overlap_bins // 2))
        end_bin = min(n_bins, int((b + 1) * base_width + overlap_bins // 2))
        if b == n_bands - 1:
            end_bin = n_bins
        if b == 0:
            start_bin = 0
        band_ranges.append((start_bin, end_bin))

    return band_ranges
