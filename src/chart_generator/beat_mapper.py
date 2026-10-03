"""
Beat Mapper: Generates a playable, musical 4-lane Piano Chart
driven strictly by the Global Spectral Flux Beat skeleton.

Architecture:
1. Timing (When to tap): Defined by Global Spectral Flux attack peaks.
   Guarantees 100% synchronization with the audible groove and rhythm.
2. Lane Assignment (Where to tap: Lanes 0, 1, 2, 3):
   Determined by dominant sub-band energy at the moment of the beat.
3. Перекидывание (Alternation & Finger Ergonomics):
   For rapid consecutive notes (dt < 220ms), avoids repeating the same lane
   by smoothly alternating to complementary/adjacent lanes (trill/roll flow).
4. Accents & Chords:
   Dual-register impacts (e.g. Kick + Crash on beat 1) trigger 2-finger chords.
"""

import numpy as np


def generate_piano_chart_from_global_beat(
    global_peaks_sec: list[float] | np.ndarray,
    sf_bands: np.ndarray,
    times: np.ndarray,
    frequencies: np.ndarray,
    S: np.ndarray = None,
    n_lanes: int = 4,
    min_dt_debounce: float = 0.080,
    rapid_dt_threshold: float = 0.220,
    chord_min_gap: float = 0.250
) -> list[dict]:
    """
    Generates a 4-lane piano chart from global beat attack timestamps.
    """
    if len(global_peaks_sec) == 0:
        return []

    peaks = sorted(list(global_peaks_sec))
    times_arr = np.asarray(times)
    n_frames = sf_bands.shape[1]
    hop_sec = float(times[1] - times[0]) if len(times) > 1 else 0.0232

    # Step 1: Debounce acoustic flutter (< 80ms)
    debounced_peaks = []
    for p in peaks:
        if not debounced_peaks or (p - debounced_peaks[-1]) >= min_dt_debounce:
            debounced_peaks.append(float(p))

    chart = []
    prev_lane = 1
    prev_time = -999.0
    alt_direction = 1  # For rolling alternation

    for i, t_peak in enumerate(debounced_peaks):
        dt = t_peak - prev_time
        frame_idx = min(n_frames - 1, max(0, int(round(t_peak / hop_sec))))

        # Measure attack flux across the 4 frequency sub-bands at this moment
        band_flux = sf_bands[:, frame_idx]  # Shape: (4,)
        primary_band = int(np.argmax(band_flux))
        sorted_bands = [int(b) for b in np.argsort(-band_flux)]

        # Check for potential chord (Kick + Cymbal / Dual Register Accent)
        is_chord = False
        chord_lane = None
        if dt >= chord_min_gap and (i < len(debounced_peaks) - 1 and (debounced_peaks[i + 1] - t_peak) >= chord_min_gap):
            # Check if both bass (band 0) and high (band 2 or 3) are strong
            if band_flux[0] > 0.45 and (band_flux[2] > 0.40 or band_flux[3] > 0.40):
                is_chord = True
                assigned_lane = 0
                chord_lane = 2 if band_flux[2] >= band_flux[3] else 3

        if not is_chord:
            # Step 3: Перекидывание (Alternation & Anti-Repetition Rule)
            if dt < rapid_dt_threshold:
                # FAST NOTES (< 220ms): Player cannot smash same key easily!
                if primary_band == prev_lane:
                    # Alternation triggered!
                    # Option A: Take 2nd highest energy band if different
                    second_best = sorted_bands[1] if len(sorted_bands) > 1 else -1
                    if second_best != prev_lane and second_best >= 0:
                        assigned_lane = second_best
                    else:
                        # Option B: Alternate left/right
                        if prev_lane == 0:
                            assigned_lane = 1
                            alt_direction = 1
                        elif prev_lane == n_lanes - 1:
                            assigned_lane = n_lanes - 2
                            alt_direction = -1
                        else:
                            assigned_lane = prev_lane + alt_direction
                            if assigned_lane < 0 or assigned_lane >= n_lanes:
                                alt_direction = -alt_direction
                                assigned_lane = prev_lane + alt_direction
                else:
                    assigned_lane = primary_band
            else:
                # COMFORTABLE PAUSE (>= 220ms): Natural acoustic pitch home!
                assigned_lane = primary_band

        # Get dominant frequency for display/sound feedback
        if S is not None:
            col = S[:, frame_idx]
            max_b = int(np.argmax(col))
            dom_freq = float(frequencies[max_b]) if max_b < len(frequencies) else 440.0
            amp = float(col[max_b])
        else:
            dom_freq = float(frequencies[primary_band * (len(frequencies) // n_lanes)]) if len(frequencies) > 0 else 440.0
            amp = float(band_flux[primary_band])

        # Add main note
        chart.append({
            "time": float(round(t_peak, 3)),
            "lane": int(assigned_lane),
            "type": "tap",
            "duration": 0.0,
            "freq": float(round(dom_freq, 1)),
            "amplitude": float(round(amp, 4))
        })

        # If chord, add second simultaneous note
        if is_chord and chord_lane is not None:
            chart.append({
                "time": float(round(t_peak, 3)),
                "lane": int(chord_lane),
                "type": "tap",
                "duration": 0.0,
                "freq": float(round(frequencies[-1] if len(frequencies) > 0 else 2000.0, 1)),
                "amplitude": float(round(amp, 4))
            })

        prev_lane = assigned_lane
        prev_time = t_peak

    return chart
