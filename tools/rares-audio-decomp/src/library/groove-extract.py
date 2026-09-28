"""
groove-extract.py -- read the actual GROOVE off a separated reference record:
which 16th each drum lands on, how much swing is really there, and what the
bassline plays.

WHY THIS AND NOT MORE STATISTICS. Everything measured so far -- tempo, density,
crest, band balance, the energy arc -- is spectral or statistical, and **none of
it contains a rhythm.** Paul asked whether the groove would be based on the
records we analysed and the honest answer was "not yet, those numbers have no
rhythm in them". This is the file that closes that gap: it reads the pattern
itself, so the groove can be built from what these records do rather than from
my priors about house music.

WHAT IS RELIABLE HERE, AND WHAT IS NOT
  ✅ DRUMS. Onset detection per frequency band on an isolated drums stem is
     about as solid as MIR gets. Kick, snare/clap and hat separate cleanly by
     band and the 16th they land on is unambiguous.
  ✅ BASS. Monophonic pitch tracking on an isolated bass stem is reliable. A
     deep-house bassline is one note at a time by construction.
  ⚠️ SWING is measured as the mean timing offset of the OFF 16ths against a
     straight grid built from Essentia's beat times. It inherits any error in
     those beat times, so it is reported with a spread and a sample count, not
     as a single number.
  ❌ PADS AND KEYS. `other` is a bag -- pad, lead, most percussion, often
     several at once. Polyphonic transcription of it would produce a note list
     that looks authoritative and is not. NOT ATTEMPTED. If the harmony is
     wanted, `harmony.py` already estimates chords from the mix and states its
     own confidence.

🔴 AND THE RULE THAT APPLIES TO ALL OF IT: this reports what the DETECTOR found,
never what house music "should" do. Where a number looks wrong -- a kick on all
16 steps, a bass note below 30 Hz -- that is a detector artefact to investigate,
not a finding to tune until it matches my prior. That mistake is already in the
record twice (the piano stem, the arrangement grid).

Run: /Users/paul/miniconda3/bin/python3 library/groove-extract.py \
       --stems library/inspo/stems-refs/htdemucs/<name> [--mix <path.opus>]
"""
import argparse
import glob
import json
import os
import subprocess

import numpy as np

SR = 44100
HOP = 128                      # 2.9 ms -- fine enough to measure swing
# 🔴 THE CLAP BAND WAS 200-1200 Hz AND THAT IS THE KICK'S BODY. It read 95% on
# steps 1/5/9/13 -- a clap on every beat including 1 and 3, which house does not
# do -- because a house kick carries a strong 200-400 Hz "knock". Moved to
# 1.5-4 kHz, which is the band melody_extract.py's backbeat detector already
# uses for exactly this reason. The kick's body does not reach up there.
BANDS = {"kick": (30, 110), "mid-perc": (1500, 4000), "hat": (8000, 16000)}
# minimum time between two onsets of the same instrument. A 16th at 120 BPM is
# 125 ms; a kick that "retriggers" faster than 180 ms is the decay of the same
# hit being counted twice, which is what put a kick on all 16 steps.
MIN_GAP = {"kick": 0.180, "mid-perc": 0.150, "hat": 0.060}


def decode(path, sr=SR):
    p = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1",
                        "-ar", str(sr), "-f", "f32le", "-"],
                       capture_output=True, check=False)
    if p.returncode != 0 or not p.stdout:
        return None
    return np.frombuffer(p.stdout, dtype="<f4").copy()


def beats_of(path):
    """Essentia's multifeature tracker -- the same one arrangement-matrix.py
    uses. Beat times, not 60/bpm, so a record that drifts is measured where it
    actually is.

    CACHED. This is the slow step (60-90 s/record) and the beats of a finished
    record never change; see library/beatcache.py."""
    import sys, os
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from beatcache import beats_of as cached
    return cached(path)


def band_flux(x, lo, hi, sr=SR, hop=HOP, win=1024):
    """Half-wave-rectified spectral flux inside one band -- an onset strength
    curve for 'things that happen in this frequency range'."""
    n = (len(x) - win) // hop
    if n < 4:
        return np.zeros(0), hop / sr
    idx = np.arange(win)[None, :] + hop * np.arange(n)[:, None]
    S = np.abs(np.fft.rfft(x[idx] * np.hanning(win), axis=1))
    f = np.fft.rfftfreq(win, 1 / sr)
    m = (f >= lo) & (f < hi)
    b = S[:, m].sum(axis=1)
    d = np.diff(b, prepend=b[0])
    return np.maximum(d, 0), hop / sr


def assign(onsets, grid, db, n_bars):
    """Onset time -> (bar, step) on the NEAREST grid point.

    🔴 THE FIRST VERSION USED `searchsorted(...) - 1`, i.e. the grid step the
    onset falls *after*. Spectral flux peaks lead the perceived attack slightly,
    so a hit a few ms early lands in the PREVIOUS cell -- and the whole pattern
    came out one 16th flat. It was obvious in the output: the clap read 95% on
    steps 4, 8, 12 and 16, which is the "a" of every beat. House claps are on
    beats 2 and 4. Nearest-point assignment is the fix.

    It also returns a SET of (bar, step), so occupancy is "fraction of bars with
    at least one hit there" -- which is what the printout claims it is. Counting
    raw onsets instead produced **a kick at 107% of bars**, a number that cannot
    exist and that I should have caught before reading anything else off it.
    """
    if onsets.size == 0 or grid.size == 0:
        return set()
    i = np.clip(np.searchsorted(grid, onsets), 0, len(grid) - 1)
    prev = np.clip(i - 1, 0, len(grid) - 1)
    take_prev = np.abs(onsets - grid[prev]) < np.abs(onsets - grid[i])
    idx = np.where(take_prev, prev, i)
    rel = idx - db
    ok = (rel >= 0) & (rel < n_bars * 16)
    return set(zip((rel[ok] // 16).tolist(), (rel[ok] % 16).tolist()))


def peaks(curve, frame_s, min_gap_s=0.055, thresh=1.6):
    """Onsets = local maxima above `thresh` x the running median. A relative
    threshold, because these records move 20 dB between a breakdown and a drop
    and a fixed one would find nothing in half the record."""
    if curve.size == 0:
        return np.zeros(0)
    w = max(9, int(2.0 / frame_s) | 1)
    pad = np.pad(curve, w // 2, mode="edge")
    med = np.array([np.median(pad[i:i + w]) for i in range(len(curve))])
    ok = curve > np.maximum(med * thresh, curve.max() * 0.02)
    gap = int(min_gap_s / frame_s)
    out, last = [], -10**9
    for i in np.flatnonzero(ok):
        if i - last < gap:
            continue
        if i and i + 1 < len(curve) and curve[i] < max(curve[i-1], curve[i+1]):
            continue
        out.append(i)
        last = i
    return np.asarray(out) * frame_s


def grid16(beats):
    """A continuous 16th-note grid interpolated through the real beat times."""
    if len(beats) < 8:
        return np.zeros(0)
    steps = []
    for i in range(len(beats) - 1):
        a, b = beats[i], beats[i + 1]
        steps += [a + (b - a) * k / 4 for k in range(4)]
    steps.append(beats[-1])
    return np.asarray(steps)


def downbeat(kick_on, grid):
    """Which of the four 16th-phases within a bar carries the most kicks.
    Only the phase matters and only modulo 16."""
    if grid.size == 0 or kick_on.size == 0:
        return 0
    i = np.clip(np.searchsorted(grid, kick_on), 0, len(grid) - 1)
    prev = np.clip(i - 1, 0, len(grid) - 1)
    idx = np.where(np.abs(kick_on - grid[prev]) < np.abs(kick_on - grid[i]), prev, i)
    return int(np.bincount(idx % 16, minlength=16).argmax())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stems", required=True)
    ap.add_argument("--mix", default=None)
    ap.add_argument("--json", default=None)
    a = ap.parse_args()

    name = os.path.basename(a.stems.rstrip("/"))
    dr = os.path.join(a.stems, "drums.wav")
    bs = os.path.join(a.stems, "bass.wav")
    if not os.path.exists(dr):
        raise SystemExit(f"no drums.wav in {a.stems}")

    src = a.mix or dr
    bpm, beats = beats_of(src)
    grid = grid16(beats)
    print(f"\n{'='*76}\n{name}\n{'='*76}")
    print(f"  {bpm:.2f} BPM · {len(beats)} beats · {len(grid)} sixteenths"
          f" · beat grid from {'the MIX' if a.mix else 'the drums stem'}")

    x = decode(dr)
    onsets, offsets = {}, {}
    for b, (lo, hi) in BANDS.items():
        c, fs = band_flux(x, lo, hi)
        onsets[b] = peaks(c, fs, min_gap_s=MIN_GAP[b], thresh=2.0)

    db = downbeat(onsets["kick"], grid)
    n_bars = (len(grid) - db) // 16
    print(f"  downbeat phase {db} · {n_bars} full bars")

    # ── the 16-step grid ───────────────────────────────────────────────────
    print(f"\n  WHERE EACH DRUM LANDS — % of bars with a hit on that 16th")
    print(f"  {'':8}" + "".join(f"{i+1:>4}" for i in range(16)))
    occ, hits = {}, {}
    for b in BANDS:
        hits[b] = assign(onsets[b], grid, db, n_bars)
        cnt = np.bincount([s_ for _, s_ in hits[b]], minlength=16)
        pct = 100 * cnt / max(n_bars, 1)
        assert pct.max() <= 100.001, "occupancy over 100% -- assignment is wrong"
        occ[b] = pct.round(1).tolist()
        print(f"  {b:<8}" + "".join(f"{p:>4.0f}" for p in pct))
    print(f"  {'':8}" + "".join(f"{'.' if i%4 else '|':>4}" for i in range(16))
          + "    | = beat")

    # ── swing ──────────────────────────────────────────────────────────────
    print(f"\n  SWING — timing of the OFF 8ths against a straight grid")
    sw = {}
    for b in ("hat", "mid-perc"):
        if onsets[b].size == 0:
            continue
        j = np.clip(np.searchsorted(grid, onsets[b]), 0, len(grid) - 2)
        pv = np.clip(j - 1, 0, len(grid) - 2)
        i = np.where(np.abs(onsets[b] - grid[pv]) < np.abs(onsets[b] - grid[j]), pv, j)
        rel = (i - db) % 16
        off = onsets[b] - grid[i]                      # seconds past the step
        span = np.diff(grid)[np.clip(i, 0, len(grid) - 2)]
        frac = off / np.maximum(span, 1e-9)            # 0..1 within the 16th
        m = np.isin(rel, [2, 6, 10, 14])               # the off 8ths
        if m.sum() < 12:
            continue
        # swing % = where the off 8th sits between the two beats around it
        pos = 50.0 + 12.5 * np.median(frac[m])
        sw[b] = (float(pos), int(m.sum()),
                 float(np.percentile(frac[m], 75) - np.percentile(frac[m], 25)))
        print(f"    {b:<8}{pos:>6.1f}%   n={m.sum():<5}"
              f" IQR of the offset {sw[b][2]*100:.0f}% of a 16th")
    if not sw:
        print("    not enough off-8th hits to measure -- do not quote a swing value")

    # ── bass ───────────────────────────────────────────────────────────────
    notes = []
    if os.path.exists(bs):
        notes = bass_notes(bs, grid, db, n_bars)
        print(f"\n  BASS — {len(notes)} notes detected")
        if notes:
            pcs = np.array([n["midi"] for n in notes])
            print(f"    range MIDI {pcs.min()}-{pcs.max()}"
                  f"  ({40*2**((pcs.min()-33)/12):.0f}-{40*2**((pcs.max()-33)/12):.0f} Hz approx)")
            st = np.bincount([n["step"] for n in notes], minlength=16)
            print(f"    onsets per 16th:")
            print(f"    {'':4}" + "".join(f"{i+1:>4}" for i in range(16)))
            print(f"    {'':4}" + "".join(f"{100*v/max(n_bars,1):>4.0f}" for v in st))
            d = np.bincount([n["midi"] % 12 for n in notes], minlength=12)
            names = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"]
            top = np.argsort(d)[::-1][:5]
            print("    pitch classes: " + ", ".join(
                f"{names[i]} {100*d[i]/max(d.sum(),1):.0f}%" for i in top if d[i]))

    if a.json:
        json.dump({"name": name, "bpm": bpm, "bars": int(n_bars),
                   "occupancy": occ, "swing": sw,
                   "bass": notes}, open(a.json, "w"), indent=1)
        print(f"\n  → {a.json}")


def bass_notes(path, grid, db, n_bars):
    """Monophonic pitch track -> quantised notes.

    🔴 TWO WRONG ALGORITHMS BEFORE THIS ONE, and the diagnosis mattered more
    than either fix. (1) PredominantPitchMelodia returned 3 notes in 8.6
    minutes -- it is a MELODY tracker and a 40-80 Hz bass is outside what it is
    built for. (2) PitchYinFFT at 44.1 kHz with maxFrequency=400 returned a
    median detected pitch of **302 Hz on a bass stem**: it was locking onto the
    3rd and 4th HARMONIC, not the fundamental, and the resulting track jumped so
    much that the median segment was 6 ms.

    What works, and it is standard practice for bass: track at a LOW sample
    rate with a long frame, and cap maxFrequency below the second harmonic so
    the algorithm physically cannot choose one. Then quantise to semitones
    BEFORE smoothing, so a note survives vibrato and the odd octave slip
    instead of being cut into fragments.
    """
    import essentia.standard as es
    from scipy.signal import medfilt
    SR_B, FS, HS = 8000, 2048, 128        # 256 ms frame, 16 ms hop
    a = es.MonoLoader(filename=path, sampleRate=SR_B)()
    yin = es.PitchYin(frameSize=FS, sampleRate=SR_B,
                      minFrequency=30, maxFrequency=220)
    w = es.Windowing(type="hann")
    pv, cv = [], []
    for fr in es.FrameGenerator(a, frameSize=FS, hopSize=HS, startFromZero=True):
        f0, c = yin(w(fr))
        pv.append(f0); cv.append(c)
    pitch, conf = np.asarray(pv), np.asarray(cv)
    good = (pitch > 30) & (conf > 0.25)
    if good.sum() < 50:
        return []
    midi = np.full(len(pitch), np.nan)
    midi[good] = 69 + 12 * np.log2(pitch[good] / 440.0)
    q = medfilt(np.where(np.isnan(midi), -1, np.round(midi)), 11)   # 176 ms
    t = np.arange(len(q)) * HS / SR_B
    out, i = [], 0
    while i < len(q):
        if q[i] < 0:
            i += 1
            continue
        j = i
        while j < len(q) and q[j] == q[i]:
            j += 1
        dur = t[min(j, len(t) - 1)] - t[i]
        if dur >= 0.09:
            k = int(np.clip(np.searchsorted(grid, t[i]), 0, len(grid) - 1))
            pr = max(k - 1, 0)
            if abs(t[i] - grid[pr]) < abs(t[i] - grid[k]):
                k = pr
            if db <= k < db + n_bars * 16:
                out.append({"t": round(float(t[i]), 3), "midi": int(q[i]),
                            "dur": round(float(dur), 3),
                            "step": int((k - db) % 16)})
        i = j
    return out


if __name__ == "__main__":
    main()
