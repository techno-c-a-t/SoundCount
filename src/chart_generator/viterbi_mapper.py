"""
Viterbi Lane Mapper module: Uses Dynamic Programming (Viterbi Algorithm)
to map extracted musical events to 4 gameplay lanes (0, 1, 2, 3)
minimizing pitch affinity costs and transition playability penalties.
"""

import numpy as np
from src.pitch_detection.hold_detector import ProcessedNote
from src.utils.config import CQT_BINS


def generate_chart_with_viterbi(
    notes: list[ProcessedNote],
    n_lanes: int = 4,
    lambda_trans: float = 1.5,
    bind_pitch_to_lane: bool = False,
    n_bins: int = CQT_BINS
) -> list[dict]:
    """
    Maps a sequence of ProcessedNote objects to 4 gameplay lanes via Viterbi DP.

    Args:
        notes (list[ProcessedNote]): Chronologically sorted list of processed notes.
        n_lanes (int): Number of game lanes (default 4).
        lambda_trans (float): Weight for transition cost.
        bind_pitch_to_lane (bool): If False, pitch-to-lane binding is disabled, allowing
                                   bass and attack hits to be mapped dynamically across all 4 lanes.
        n_bins (int): Total number of CQT frequency bins (default 84).

    Returns:
        list[dict]: List of chart note objects ready for export.
    """
    if not notes:
        return []

    N = len(notes)
    L = n_lanes

    # DP tables: V[n, l] is min cost, backptr[n, l] is previous lane index
    V = np.zeros((N, L), dtype=np.float64)
    backptr = np.zeros((N, L), dtype=np.int32)

    # Base case: note 0
    for l in range(L):
        V[0, l] = compute_pitch_cost(notes[0].bin_idx, l, n_bins=n_bins, n_lanes=L) if bind_pitch_to_lane else 0.0

    # Forward DP pass
    for n in range(1, N):
        dt = max(0.001, notes[n].time_sec - notes[n - 1].time_sec)
        prev_note = notes[n - 1]

        for l_curr in range(L):
            pitch_c = compute_pitch_cost(notes[n].bin_idx, l_curr, n_bins=n_bins, n_lanes=L) if bind_pitch_to_lane else 0.0

            min_cost = float('inf')
            best_prev_l = 0

            for l_prev in range(L):
                trans_c = compute_transition_cost(
                    l_prev=l_prev,
                    l_curr=l_curr,
                    dt=dt,
                    prev_note_time=prev_note.time_sec,
                    prev_note_dur=prev_note.duration_sec,
                    curr_note_time=notes[n].time_sec
                )

                total_c = V[n - 1, l_prev] + pitch_c + lambda_trans * trans_c
                if total_c < min_cost:
                    min_cost = total_c
                    best_prev_l = l_prev

            V[n, l_curr] = min_cost
            backptr[n, l_curr] = best_prev_l

    # Backtracking pass
    assigned_lanes = [0] * N
    best_last_l = int(np.argmin(V[N - 1, :]))
    assigned_lanes[N - 1] = best_last_l

    for n in range(N - 1, 0, -1):
        best_last_l = backptr[n, best_last_l]
        assigned_lanes[n - 1] = best_last_l

    # Construct final chart list
    chart = []
    for n in range(N):
        note = notes[n]
        chart.append({
            "time": float(np.round(note.time_sec, 3)),
            "lane": int(assigned_lanes[n]),
            "type": note.note_type,
            "duration": float(np.round(note.duration_sec, 3)),
            "freq": float(np.round(note.pitch_freq, 2)),
            "amplitude": float(np.round(note.amplitude, 4))
        })

    # Post-processing sanitization pass: guarantee chain generator rules
    sanitized_chart = []
    for note in chart:
        keep = True
        for prev in sanitized_chart:
            dt = abs(note["time"] - prev["time"])
            dl = abs(note["lane"] - prev["lane"])

            # 1. Chord Rule: If simultaneous (<= 0.040s), lanes MUST be separated by at least 2 (|l1 - l2| >= 2)
            if dt <= 0.040 and dl < 2:
                keep = False
                break

            # 2. Adjacent Lane Spacing Rule: If adjacent lanes (|l1 - l2| == 1), dt MUST be >= 0.150s
            if dl == 1 and dt < 0.150:
                keep = False
                break

        if keep:
            note_copy = dict(note)
            note_copy["type"] = "tap"
            note_copy["duration"] = 0.0
            sanitized_chart.append(note_copy)

    return sanitized_chart


def generate_relative_pitch_direction_chart(notes: list[ProcessedNote], n_lanes: int = 4) -> list[dict]:
    """
    Generates a 4-lane chart based on RELATIVE PITCH DIRECTION:
    - Same pitch (within ~0.8 semitones tolerance): place on SAME LANE (l_next = l_prev).
    - Higher pitch: place on RIGHT LANE (l_next = l_prev + 1).
    - Lower pitch: place on LEFT LANE (l_next = l_prev - 1).
    """
    if not notes:
        return []

    chart = []
    curr_lane = 1

    for i, note in enumerate(notes):
        if i == 0:
            assigned_lane = min(n_lanes - 1, max(0, note.bin_idx // 21))
        else:
            prev_note = notes[i - 1]
            dt = note.time_sec - prev_note.time_sec

            if dt <= 0.040:
                # Simultaneous chord note: place non-adjacent (|l1 - l2| >= 2)
                assigned_lane = (curr_lane + 2) % n_lanes
            else:
                f_prev = prev_note.pitch_freq
                f_curr = note.pitch_freq

                if f_prev > 0 and f_curr > 0:
                    semitone_diff = 12.0 * np.log2(f_curr / f_prev)
                else:
                    semitone_diff = 0.0

                if abs(semitone_diff) <= 0.8:
                    # SAME PITCH -> SAME LANE!
                    assigned_lane = curr_lane
                elif semitone_diff > 0.8:
                    # HIGHER PITCH -> MOVE RIGHT!
                    assigned_lane = (curr_lane + 1) if curr_lane < n_lanes - 1 else 0
                else:
                    # LOWER PITCH -> MOVE LEFT!
                    assigned_lane = (curr_lane - 1) if curr_lane > 0 else (n_lanes - 1)

        curr_lane = assigned_lane

        chart.append({
            "time": float(np.round(note.time_sec, 3)),
            "lane": int(assigned_lane),
            "type": "tap",
            "duration": 0.0,
            "freq": float(np.round(note.pitch_freq, 2)),
            "amplitude": float(np.round(note.amplitude, 4))
        })

    # Post-processing sanitization pass
    sanitized_chart = []
    for note in chart:
        keep = True
        for prev in sanitized_chart:
            dt = abs(note["time"] - prev["time"])
            dl = abs(note["lane"] - prev["lane"])

            # 1. Chord Rule: If simultaneous (<= 0.040s), lanes MUST be separated by at least 2 (|l1 - l2| >= 2)
            if dt <= 0.040 and dl < 2:
                keep = False
                break

            # 2. Adjacent Lane Spacing Rule: If adjacent lanes (|l1 - l2| == 1), dt MUST be >= 0.150s
            if dl == 1 and dt < 0.150:
                keep = False
                break

        if keep:
            sanitized_chart.append(note)

    return sanitized_chart


def generate_relative_pitch_direction_chart(notes: list[ProcessedNote], n_lanes: int = 4) -> list[dict]:
    """
    Generates a 4-lane chart based on RELATIVE PITCH DIRECTION:
    - Same pitch (within ~0.8 semitone tolerance): place on SAME LANE (l_next = l_prev).
    - Higher pitch: place on RIGHT LANE (l_next = l_prev + 1).
    - Lower pitch: place on LEFT LANE (l_next = l_prev - 1).
    """
    if not notes:
        return []

    chart = []
    curr_lane = 1

    for i, note in enumerate(notes):
        if i == 0:
            assigned_lane = min(n_lanes - 1, max(0, note.bin_idx // 21))
        else:
            prev_note = notes[i - 1]
            dt = note.time_sec - prev_note.time_sec

            if dt <= 0.040:
                # Simultaneous chord note: place non-adjacent (|l1 - l2| >= 2)
                assigned_lane = (curr_lane + 2) % n_lanes
            else:
                f_prev = prev_note.pitch_freq
                f_curr = note.pitch_freq

                if f_prev > 0 and f_curr > 0:
                    semitone_diff = 12.0 * np.log2(f_curr / f_prev)
                else:
                    semitone_diff = 0.0

                if abs(semitone_diff) <= 0.8:
                    # SAME PITCH -> SAME LANE!
                    assigned_lane = curr_lane
                elif semitone_diff > 0.8:
                    # HIGHER PITCH -> MOVE RIGHT!
                    assigned_lane = (curr_lane + 1) if curr_lane < n_lanes - 1 else 0
                else:
                    # LOWER PITCH -> MOVE LEFT!
                    assigned_lane = (curr_lane - 1) if curr_lane > 0 else (n_lanes - 1)

        curr_lane = assigned_lane

        chart.append({
            "time": float(np.round(note.time_sec, 3)),
            "lane": int(assigned_lane),
            "type": "tap",
            "duration": 0.0,
            "freq": float(np.round(note.pitch_freq, 2)),
            "amplitude": float(np.round(note.amplitude, 4))
        })

    # Post-processing sanitization pass
    sanitized_chart = []
    for note in chart:
        keep = True
        for prev in sanitized_chart:
            dt = abs(note["time"] - prev["time"])
            dl = abs(note["lane"] - prev["lane"])

            # 1. Chord Rule: If simultaneous (<= 0.040s), lanes MUST be separated by at least 2 (|l1 - l2| >= 2)
            if dt <= 0.040 and dl < 2:
                keep = False
                break

            # 2. Adjacent Lane Spacing Rule: If adjacent lanes (|l1 - l2| == 1), dt MUST be >= 0.150s
            if dl == 1 and dt < 0.150:
                keep = False
                break

        if keep:
            sanitized_chart.append(note)

    return sanitized_chart


def compute_pitch_cost(bin_idx: int, lane: int, n_bins: int = CQT_BINS, n_lanes: int = 4) -> float:
    """
    Computes pitch affinity penalty.
    Maps lower frequencies (bass) to left lanes (0, 1) and higher frequencies to right lanes (2, 3).
    """
    ideal_lane = min(n_lanes - 1, int(floor_div(n_lanes * bin_idx, n_bins)))
    return float((lane - ideal_lane) ** 2)


def compute_transition_cost(
    l_prev: int,
    l_curr: int,
    dt: float,
    prev_note_time: float,
    prev_note_dur: float,
    curr_note_time: float
) -> float:
    """
    Computes playability transition penalty between consecutive notes in the chain.
    """
    # 1. Simultaneous Chord Check (dt <= 0.040s): STRICTLY NO ADJACENT LANES (|l_curr - l_prev| >= 2)
    if abs(curr_note_time - prev_note_time) <= 0.040:
        if abs(l_curr - l_prev) < 2:
            return 10000.0  # Impossible to stack same or adjacent lanes in a chord!
        return 0.1

    # 2. Same Lane Rule: Consecutive single notes on same lane forbidden if dt < 0.350s (allowed if dt >= 0.350s gap)
    if l_curr == l_prev and dt < 0.350:
        return 8000.0

    # 3. Adjacent Lane Rapid Spacing Check: Adjacent lanes (|l_curr - l_prev| == 1) must be separated by >= 150ms
    if abs(l_curr - l_prev) == 1 and dt < 0.150:
        return 5000.0

    # 4. Distance Jump Penalty
    dist = abs(l_curr - l_prev)
    return float(dist * np.exp(-2.0 * dt))


def floor_div(a: int, b: int) -> int:
    return a // b
