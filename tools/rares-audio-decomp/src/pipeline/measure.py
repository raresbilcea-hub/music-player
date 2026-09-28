"""
bands.py — where is the energy, per bus, per octave band?

The substitute for the fact that I cannot hear. `report()` in make_track.py scores
the master against the envelope measured from 341 of Paul's own house-lane influence tracks;
this does the same per BUS, which is what turns "the mix is dark" into "the pad
bus has nothing above 500 Hz, so no EQ will ever fix it."

That distinction is the single most useful thing measurement has produced here:
a missing band is an ARRANGEMENT problem, not a mixing one, and no amount of
shelving invents content that was never played.

Run: python3 measure.py [file.wav ...]
"""
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

TRACKS = Path(__file__).parent.parent / "tracks" / "current"
SR = 44100
EDGES = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
# Medians from library/reference-envelope.py. `MED` is what levels.py solves
# every fader against, so whichever lane is selected here IS the record's
# target spectrum.
#
# 🔴 THE TRAP, LOGGED 6 AUG: this array is the live target, NOT the JSON.
# Running reference-envelope.py rewrites library/data/*.json and changes
# nothing about the mix while looking exactly as though it had. Both lanes
# below are copied from those files; re-run the script and copy again.
#
# HOUSE LANE -- 341 tracks: ADID roster, Lee Burridge, Solomun, RUFUS DU SOL.
# (5 Aug: rebuilt from 51 noisy tracks to the full folder, and restricted to
# the house lane because the old figure averaged in Tame Impala and Dope Lemon,
# which put 16% and 13% of their energy below 63 Hz against Lee's 54%.)
# Working: references/genre-research/the-lane-measured.md §6.
LANE_HOUSE = [48.74, 23.48, 7.93, 5.63, 3.48, 1.96, 1.07, 1.33, 1.04]

# TRIBAL LANE -- 129 tracks from library/influences/tribal/.
# ⚠️ LOPSIDED, and say so before citing it: Nicola Cruz 77 · Bedouin 35 ·
# Acid Pauli 15 · Armen Miran 10. Any "the lane says..." number is mostly
# Cruz and Bedouin.
# Against the house lane it wants MUCH LESS SUB (-12.6 at 31-63), MUCH MORE
# BASS BODY (+7.4 at 63-125, +3.5 at 125-250) and LESS TREBLE (-0.7 at 4-8k,
# -0.6 above 8k). Tilt steepens -4.64 -> -5.60 dB/oct and the sides narrow
# (side_frac 0.199 -> 0.142). LUFS and crest are effectively identical
# (-10.36/-10.59, 11.36/11.90 dB), so this is a spectral move, not a
# loudness one.
LANE_TRIBAL = [36.17, 30.90, 11.42, 7.23, 4.04, 1.78, 0.83, 0.68, 0.41]

# ▶ SELECTED BY PAUL, 6 Aug 2026, for the new D-minor tribal record.
# The handoff's warning was that leaving the house lane in place would
# silently pull a tribal record back toward deep house. Switch this line to
# LANE_HOUSE to put breathe-v1/v2 back on their own target.
MED = LANE_TRIBAL
LANE_NAME = "tribal lane, 129 tracks"


def lufs(x, sr=SR):
    """Gated integrated loudness, ITU-R BS.1770-4.

    The headline number the mixing targets are written in: streaming wants
    -9 to -11 LUFS, club -7 to -9, and Paul's own 341 house-lane influence
    tracks measure a median of **-10.4** (p10 -14.0, p90 -8.3; remeasured 5 Aug
    2026 over 341 tracks -- the old -10.7 came from a 51-track subsample).
    Peak dBFS says nothing about any of that -- a track can peak
    at -0.1 and be 6 dB quieter than the reference.

    K-weighting is the two-stage filter from the spec (a high-shelf and a
    high-pass), then mean square over 400 ms blocks with 75% overlap, an
    absolute gate at -70 LUFS and a relative gate 10 LU below the ungated mean.
    """
    from scipy.signal import lfilter
    x = np.atleast_2d(x.T if x.ndim > 1 else x)
    # stage 1 high-shelf, stage 2 high-pass — coefficients for 48 kHz in the
    # spec, re-derived here for the actual sample rate.
    f0, G, Q = 1681.974450955533, 3.999843853973347, 0.7071752369554196
    K = np.tan(np.pi * f0 / sr)
    Vh = 10 ** (G / 20.0)
    Vb = Vh ** 0.4996667741545416
    a0 = 1.0 + K / Q + K * K
    # ⚠️ a[0] MUST STAY 1.0. Dividing the whole `a` array by a0 -- including the
    # leading 1 -- leaves lfilter to renormalise by a[0]=1/a0, which cancels the
    # division on a1/a2 only. The filter goes unstable, the samples overflow to
    # inf, and the function returns -inf instead of a loudness. It did.
    b = np.array([(Vh + Vb * K / Q + K * K), 2 * (K * K - Vh),
                  (Vh - Vb * K / Q + K * K)]) / a0
    a = np.array([1.0, 2 * (K * K - 1.0) / a0, (1.0 - K / Q + K * K) / a0])
    f0, Q = 38.13547087602444, 0.5003270373238773
    K = np.tan(np.pi * f0 / sr)
    d0 = 1 + K / Q + K * K
    b2 = np.array([1.0, -2.0, 1.0])
    a2 = np.array([1.0, 2 * (K * K - 1.0) / d0, (1 - K / Q + K * K) / d0])
    y = np.array([lfilter(b2, a2, lfilter(b, a, ch)) for ch in x])

    T = int(0.4 * sr)
    hop = T // 4
    n = (y.shape[1] - T) // hop + 1
    if n < 1:
        return float("-inf")
    z = np.array([[np.mean(ch[i * hop:i * hop + T] ** 2) for i in range(n)]
                  for ch in y])
    Lj = -0.691 + 10 * np.log10(np.maximum(z.sum(axis=0), 1e-30))
    keep = Lj > -70.0
    if not keep.any():
        return float("-inf")
    rel = -0.691 + 10 * np.log10(z[:, keep].sum(axis=0).mean()) - 10.0
    keep &= Lj > rel
    if not keep.any():
        return float("-inf")
    return float(-0.691 + 10 * np.log10(z[:, keep].sum(axis=0).mean()))


def true_peak_db(x, sr=SR, os=4):
    """Inter-sample peak. A sample peak of -1.0 dBFS can be a true peak above 0
    once a D/A reconstructs between samples, which is what dBTP limits are for."""
    from scipy.signal import resample_poly
    x = np.atleast_2d(x.T if x.ndim > 1 else x)
    up = np.array([resample_poly(ch, os, 1) for ch in x])
    return float(20 * np.log10(max(np.max(np.abs(up)), 1e-9)))


def spectrum(m, n=1 << 16, frames=24):
    step = max(len(m) // frames, n)
    fr = [m[i:i + n] for i in range(0, max(len(m) - n, 1), step)]
    P = np.mean([np.abs(np.fft.rfft(f * np.hanning(len(f)), n)) ** 2 for f in fr],
                axis=0)
    return P, np.fft.rfftfreq(n, 1 / SR)


def bands(path):
    x, sr = sf.read(path, always_2d=True)
    m = x.mean(axis=1)
    pk = float(np.max(np.abs(m)))
    rms = float(np.sqrt(np.mean(m ** 2)))
    P, f = spectrum(m)
    tot = P[(f >= EDGES[0]) & (f < EDGES[-1])].sum() or 1.0
    pct = [P[(f >= EDGES[i]) & (f < EDGES[i + 1])].sum() / tot * 100
           for i in range(len(EDGES) - 1)]
    return pk, rms, pct


def main(paths):
    print(f"{'file':10} {'peak':>7} {'rms':>7} " +
          " ".join(f"{EDGES[i]:>5}" for i in range(len(EDGES) - 1)))
    print(f"{'':10} {'dBFS':>7} {'dBFS':>7} " +
          " ".join(f"{'-'+str(EDGES[i+1]):>5}" for i in range(len(EDGES) - 1)))
    print("-" * 96)
    for p in paths:
        p = Path(p)
        if not p.exists():
            continue
        pk, rms, pct = bands(p)
        print(f"{p.stem:10} {20*np.log10(max(pk,1e-9)):7.1f} "
              f"{20*np.log10(max(rms,1e-9)):7.1f} " +
              " ".join(f"{v:5.1f}" for v in pct))
    print(f"{'HIS LANE':10} {'':>7} {'':>7} " + " ".join(f"{v:5.1f}" for v in MED))


if __name__ == "__main__":
    args = sys.argv[1:] or sorted(TRACKS.rglob("*.wav"))
    main(args)
