#!/usr/bin/env python3
"""
harmony.py — extract the ACTUAL chord progressions and voicing registers from
the organic-house tracks in Paul's library.

WHY THIS EXISTS. He asked, correctly: "Where are you pulling these notes from?
How are you deciding how to structure them? Shouldn't we base it off of some
source of truth that tells us WHAT SOUNDS GOOD?"

The honest answer was that I invented them. I picked a common progression and
hand-built voicings from theory, and he heard that they didn't cohere. Meanwhile
1,100 tracks of exactly the music he wants to sound like are sitting on disk.

So: chroma per bar -> template-match to chord types -> express as Roman numerals
relative to the detected key -> count what actually occurs. Plus the register
histogram, because WHERE the harmony sits is as much of the sound as WHAT it is,
and that is the part I kept guessing wrong.

Pure numpy/scipy, same approach as analyse.py's key detection. No new deps.

Usage:  python3 harmony.py [--dir library/influences] [--n 40]
"""
import argparse
import json
import subprocess
import tempfile
from collections import Counter
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 22050
NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

# Chord templates as pitch-class sets. Deep/organic house is overwhelmingly
# seventh chords and sus voicings, so plain triads alone would mis-label most of it.
QUALITIES = {
    "":      [0, 4, 7],            "m":     [0, 3, 7],
    "maj7":  [0, 4, 7, 11],        "m7":    [0, 3, 7, 10],
    "7":     [0, 4, 7, 10],        "m9":    [0, 3, 7, 10, 2],
    "maj9":  [0, 4, 7, 11, 2],     "sus4":  [0, 5, 7],
    "sus2":  [0, 2, 7],            "m6":    [0, 3, 7, 9],
}
TEMPLATES = []
for root in range(12):
    for q, ivs in QUALITIES.items():
        v = np.zeros(12)
        for i, iv in enumerate(ivs):
            v[(root + iv) % 12] = 1.0 if i < 3 else 0.85   # extensions weigh less
        TEMPLATES.append((root, q, v / np.linalg.norm(v)))

ROMAN = ["I", "bII", "II", "bIII", "III", "IV", "bV", "V", "bVI", "VI", "bVII", "VII"]


def load(path, seconds=100, skip=45):
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as t:
        tmp = t.name
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", str(skip), "-t", str(seconds),
                    "-i", str(path), "-ac", "1", "-ar", str(SR), tmp],
                   check=True, capture_output=True)
    x, _ = sf.read(tmp)
    Path(tmp).unlink(missing_ok=True)
    return x.astype(np.float64)


def tempo_of(x):
    n, hop = 1024, 256
    win = np.hanning(n)
    fr = np.array([np.abs(np.fft.rfft(x[i:i + n] * win)) for i in range(0, len(x) - n, hop)])
    flux = np.maximum(np.diff(fr, axis=0), 0).sum(axis=1)
    flux -= flux.mean()
    fps = SR / hop
    ac = np.correlate(flux, flux, "full")[len(flux) - 1:]
    lo, hi = int(fps * 60 / 132), int(fps * 60 / 108)
    if hi >= len(ac):
        return 120.0
    return 60.0 * fps / (lo + int(np.argmax(ac[lo:hi])))


def chroma_frames(x, n=8192, hop=2048, lo_hz=150, hi_hz=1400):
    """
    Mid-band chroma. Chords live between roughly 150 Hz and 1.4 kHz; the sub is
    the bassline and the top is hats and air, and both mislead the matcher.
    """
    f = np.fft.rfftfreq(n, 1 / SR)
    band = (f >= lo_hz) & (f <= hi_hz)
    pc = (np.round(12 * np.log2(np.maximum(f[band], 1e-9) / 440.0) + 69).astype(int)) % 12
    win = np.hanning(n)
    out = []
    for i in range(0, len(x) - n, hop):
        S = np.abs(np.fft.rfft(x[i:i + n] * win))[band] ** 2
        c = np.zeros(12)
        np.add.at(c, pc, S)
        out.append(c)
    return np.array(out), SR / hop


def key_of(chroma):
    c = chroma.sum(axis=0)
    if c.sum() == 0:
        return 0, "m"
    c = c / c.sum()
    best, score = (0, "m"), -9
    for shift in range(12):
        rot = np.roll(c, -shift)
        for prof, mode in ((MAJOR, ""), (MINOR, "m")):
            r = float(np.corrcoef(rot, prof)[0, 1])
            if r > score:
                score, best = r, (shift, mode)
    return best


def chords_per_bar(chroma, fps, bpm):
    """One chord label per bar. Bars, not beats — house harmony moves slowly."""
    bar_s = 4 * 60.0 / bpm
    step = max(int(round(bar_s * fps)), 1)
    labels = []
    for i in range(0, len(chroma) - step, step):
        c = chroma[i:i + step].sum(axis=0)
        if c.sum() <= 0:
            continue
        c = c / np.linalg.norm(c)
        root, qual, _ = max(TEMPLATES, key=lambda t: float(np.dot(c, t[2])))
        labels.append((root, qual))
    return labels


def register_profile(x):
    """Where the harmonic energy actually sits, in octave bands."""
    n = 8192
    win = np.hanning(n)
    acc = np.zeros(n // 2 + 1)
    cnt = 0
    for i in range(0, len(x) - n, n):
        acc += np.abs(np.fft.rfft(x[i:i + n] * win)) ** 2
        cnt += 1
    acc /= max(cnt, 1)
    f = np.fft.rfftfreq(n, 1 / SR)
    tot = acc.sum() or 1
    bands = [(40, 80), (80, 160), (160, 320), (320, 640), (640, 1280), (1280, 2560), (2560, 11000)]
    return {f"{lo}-{hi}": round(100 * acc[(f >= lo) & (f < hi)].sum() / tot, 2) for lo, hi in bands}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="influences")
    ap.add_argument("--n", type=int, default=40)
    ap.add_argument("--out", default="data/harmony.json")
    a = ap.parse_args()

    here = Path(__file__).parent
    files = sorted((here / a.dir).rglob("*.opus"))
    if not files:
        print(f"no .opus under {here / a.dir}")
        return
    step = max(len(files) // a.n, 1)
    files = files[::step][:a.n]

    prog_counter = Counter()
    pair_counter = Counter()
    qual_counter = Counter()
    regs = []
    rows = []

    for i, f in enumerate(files, 1):
        try:
            x = load(f)
            if len(x) < SR * 20:
                continue
            bpm = tempo_of(x)
            ch, fps = chroma_frames(x)
            tonic, mode = key_of(ch)
            labels = chords_per_bar(ch, fps, bpm)
            if len(labels) < 8:
                continue
            # relative to the key, so tracks in different keys can be pooled
            rel = [(ROMAN[(r - tonic) % 12], q) for r, q in labels]
            deg = [f"{r}{q}" for r, q in rel]
            for d in deg:
                qual_counter[d] += 1
            for j in range(len(deg) - 1):
                if deg[j] != deg[j + 1]:
                    pair_counter[(deg[j], deg[j + 1])] += 1
            # collapse repeats, then count 4-chord loops
            collapsed = [d for j, d in enumerate(deg) if j == 0 or d != deg[j - 1]]
            for j in range(len(collapsed) - 3):
                prog_counter[tuple(collapsed[j:j + 4])] += 1

            # HARMONIC RHYTHM — added 6 Aug 2026 for the tribal fork, because
            # Paul asked whether tribal harmony differs and the script could not
            # answer it. Everything above is expressed in ROMAN NUMERALS, so it
            # inherits every key-detection error; `key_of` is Krumhansl-
            # Schmuckler on summed chroma and STATUS.md already records a key
            # detector reading 41% A-minor across a library.
            # These three numbers are KEY-INDEPENDENT — they count changes and
            # run lengths of whatever the labels are — so they survive a wrong
            # tonic, and they are the ones that answer "does the harmony sit
            # still?". Read these before the roman numerals.
            # ⚠️ MEASURE THE ROOT, NOT THE FULL LABEL. The first version of this
            # counted a change whenever the full `deg` label changed and
            # reported 1.5 bars per chord — i.e. harmony moving almost every
            # bar, which is not what this music does. The loop table showed why:
            # "Im9 → Imaj9 → Im9 → Imaj9", the SAME ROOT flickering between
            # minor and major. Template matching on one bar of chroma is
            # unstable between qualities that differ by a single pitch class;
            # it is not unstable about the root. So the full-label rate measures
            # the DETECTOR and the root rate measures the MUSIC. Both are kept
            # and reported, because the gap between them is the honest error bar.
            # (CLAUDE.md, "verify the verifier" — autocorrelation once reported
            # an organ's own partials as mistuning.)
            root_deg = [ROMAN[(r - tonic) % 12] for r, q in labels]

            # despike: a single bar sandwiched between two identical roots is a
            # detector blip, not a passing chord. Only length-1 runs are touched.
            sm = list(root_deg)
            for j in range(1, len(sm) - 1):
                if sm[j] != sm[j - 1] and sm[j - 1] == sm[j + 1]:
                    sm[j] = sm[j - 1]

            def runs_of(seq):
                rs, cur = [], 1
                for j in range(1, len(seq)):
                    if seq[j] == seq[j - 1]:
                        cur += 1
                    else:
                        rs.append(cur); cur = 1
                rs.append(cur)
                return rs

            runs = runs_of(sm)
            hr = {"distinct": len(set(sm)),
                  "distinct_with_quality": len(set(deg)),
                  "bars_per_chord": float(np.mean(runs)),
                  "longest_hold_bars": int(max(runs)),
                  "change_rate": (len(runs) - 1) / max(len(sm) - 1, 1),
                  "change_rate_full_label": (len(runs_of(deg)) - 1) / max(len(deg) - 1, 1)}

            regs.append(register_profile(x))
            rows.append({"file": f.name, "bpm": round(bpm, 1),
                         "key": f"{NAMES[tonic]}{mode}", "chords": deg[:16],
                         **hr})
            print(f"  [{i}/{len(files)}] {bpm:5.1f} {NAMES[tonic]}{mode:1}  {' '.join(deg[:8])}  {f.name[:38]}")
        except Exception as e:
            print(f"  [{i}/{len(files)}] skipped {f.name[:40]}: {type(e).__name__}")

    if not rows:
        print("nothing analysed")
        return

    print("\n" + "=" * 74)
    print(f"HARMONY OF {len(rows)} TRACKS FROM {a.dir} — relative to each track's own key")
    print("=" * 74)
    print("\nMOST COMMON CHORDS (degree + quality):")
    for d, n in qual_counter.most_common(12):
        print(f"   {d:9} {n:5}  {'#' * int(40 * n / qual_counter.most_common(1)[0][1])}")
    print("\nMOST COMMON CHORD-TO-CHORD MOVES:")
    for (a_, b_), n in pair_counter.most_common(12):
        print(f"   {a_:9} -> {b_:9} {n:5}")
    print("\nMOST COMMON 4-CHORD LOOPS:")
    for p, n in prog_counter.most_common(10):
        print(f"   {' → '.join(p):44} {n:4}")
    print("\nHARMONIC RHYTHM — key-independent, so a wrong tonic cannot corrupt it:")
    for lbl, k, fmt in [("distinct ROOTS per track", "distinct", "5.1f"),
                        ("bars held per root", "bars_per_chord", "5.1f"),
                        ("longest single hold (bars)", "longest_hold_bars", "5.1f"),
                        ("bars where the ROOT changes", "change_rate", "5.2f"),
                        ("  same, full chord label (detector-noisy)",
                         "change_rate_full_label", "5.2f"),
                        ("distinct chords incl. quality", "distinct_with_quality", "5.1f")]:
        v = np.array([r[k] for r in rows], dtype=float)
        print(f"   {lbl:<30} median {np.median(v):{fmt}}   "
              f"p10 {np.percentile(v, 10):{fmt}}  p90 {np.percentile(v, 90):{fmt}}")

    print("\nWHERE THE ENERGY SITS (mean %, octave bands in Hz):")
    keys = list(regs[0].keys())
    for k in keys:
        m = float(np.mean([r[k] for r in regs]))
        print(f"   {k:>10} Hz  {m:5.1f}%  {'#' * int(m)}")

    (here / a.out).write_text(json.dumps(
        {"tracks": rows,
         "harmonic_rhythm": {
             k: {"median": float(np.median([r[k] for r in rows])),
                 "p10": float(np.percentile([r[k] for r in rows], 10)),
                 "p90": float(np.percentile([r[k] for r in rows], 90))}
             for k in ("distinct", "distinct_with_quality", "bars_per_chord", "longest_hold_bars", "change_rate", "change_rate_full_label")},
         "chords": qual_counter.most_common(),
         "moves": [[list(k), v] for k, v in pair_counter.most_common()],
         "loops": [[list(k), v] for k, v in prog_counter.most_common(30)],
         "register": {k: float(np.mean([r[k] for r in regs])) for k in keys}}, indent=1))
    print(f"\nwrote {here / a.out}")


if __name__ == "__main__":
    main()
