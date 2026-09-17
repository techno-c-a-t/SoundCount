# Configuration constants for SoundCount DSP Pipeline

SAMPLE_RATE = 22050      # Standard sampling rate in Hz
HOP_SIZE = 512           # Frame hop size in samples (~23 ms per frame)
N_FFT = 2048             # FFT window length
CQT_BINS = 84            # 7 octaves x 12 semitones (MIDI 24/C1 to MIDI 107/B7)
BINS_PER_OCTAVE = 12     # 12 semitones per octave
FMIN = 32.70             # Frequency of C1 note in Hz

# Adaptive Peak Picker Defaults
PEAK_ALPHA = 1.0         # Standard deviation multiplier
PEAK_BETA = 0.05         # Constant offset multiplier
PEAK_WIN_SIZE = 9        # Moving window size for local median/mean
