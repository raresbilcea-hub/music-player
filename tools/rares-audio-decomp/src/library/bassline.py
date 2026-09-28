#!/usr/bin/env python3
"""bassline.py — WHAT DO THE REFERENCES' BASSLINES ACTUALLY DO?

🔴 WHY THIS EXISTS, AND IT IS AN OWED MEASUREMENT. `STATUS.md`: *"THIS IS THE
AUDITION I OWED HIM. The groove reel carried a `bass=` field per variant and
NOTHING EVER READ IT — every groove played the same pedal while I described one
of them as 'bass busier'. So the bass has never actually been auditioned."*
Both finished records play **a single pitch class**, struck a few times a bar,
held under every chord. Paul, 6 Aug 2026: *"I luh da bass."*

The one number the record already has is from the deep-house lane and it is
explicitly flagged as a FLOOR, not a target: *"~5.0 notes/bar … ⚠️ it is a
FLOOR: the tracker segments on pitch change, so a repeated note at the same
pitch is merged and undercounted."* This script measures the TRIBAL lane, keeps
that caveat, and adds the thing that actually differs — **movement**.

METHOD, and what each choice is defending against:

 · **Band-limit to 35-180 Hz before pitch tracking.** The bass is the only
   thing down there in this music; above ~180 Hz the low mids of pads and
   drums start voting and the tracker follows them.

 · **Score each candidate on ITS OWN harmonic series.** Autocorrelation
   period-doubles on strong partials — that is what made an organ's top octave
   read as mistuned on 6 Aug, and a bass note's second harmonic is often
   louder than its fundamental. Same fix as `pipeline/survey.py`.

 · **Segment on pitch CHANGE, then despike.** A single-frame excursion is
   detector noise, not a note. Without this the "notes per bar" number is a
   measure of the tracker's jitter.

 · **Report pitch CLASSES, not MIDI numbers.** `STATUS.md` already logs that
   raw distinct-pitch counts are inflated by octave errors — *"MIDI 23 is
   22 Hz and is not a note."* Classes survive an octave mistake; absolute
   pitches do not.

⚠️ WHAT THIS CANNOT TELL YOU. Rhythmic placement against the bar needs
downbeats, and these are ~130 kbps YouTube rips analysed without a beat
tracker here. Density is per-bar from BPM alone and assumes no phase, which is
fine for counting and useless for "which 16th does it sit on". Do not read
step placement out of this.

Run:  python3 library/bassline.py [--n 40] [--dir influences/tribal]
"""
import argparse
import json
import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
LO, HI = 35.0, 180.0          # the bass window, in Hz
SR = 11025                    # plenty for 180 Hz, and 4x faster to decode


def decode(path, seconds=150, skip=45):
    """Mono, low sample rate, a slice from the middle — the intro of a house
    record is often bassless and would drag every average down."""
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as t:
        out = t.name
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", str(skip),
                    "-t", str(seconds), "-i", str(path),
                    "-ac", "1", "-ar", str(SR), out],
                   check=True, capture_output=True)
    import soundfile as sf
    x, sr = sf.read(out)
    Path(out).unlink(missing_ok=True)
    return x, sr


def track_pitch(x, sr, hop=0.05):
    """Fundamental per 50 ms frame, or None. Harmonic-series scored."""
    n = int(0.20 * sr)                       # 200 ms window: 7 cycles at 35 Hz
    step = int(hop * sr)
    out = []
    win = np.hanning(n)
    for i in range(0, max(len(x) - n, 1), step):
        f = x[i:i + n]
        if len(f) < n:
            break
        if np.sqrt((f ** 2).mean()) < 1e-4:  # silence -> no note, not a guess
            out.append(None)
            continue
        X = np.abs(np.fft.rfft(f * win, n=n * 4))
        fr = np.fft.rfftfreq(n * 4, 1 / sr)
        band = (fr >= LO) & (fr <= HI)
        if not band.any():
            out.append(None)
            continue
        idx = np.argsort(np.where(band, X, 0))[::-1][:8]
        best, bestscore = None, 0.0
        for j in idx:
            f0 = fr[j]
            if f0 < LO:
                continue
            h = []
            for k in range(1, 5):
                t = f0 * k
                if t > fr[-1]:
                    break
                jj = np.argmin(np.abs(fr - t))
                h.append(X[max(0, jj - 2):jj + 3].max())
            # a candidate with NOTHING at its own 2nd harmonic is a partial of
            # something lower, not a fundamental -- the period-doubling guard
            if len(h) < 2 or h[1] < 0.03 * h[0]:
                continue
            s = float(sum(h))
            if s > bestscore:
                best, bestscore = f0, s
        out.append(best)
    return out


def to_midi(f):
    return None if not f else 69 + 12 * np.log2(f / 440.0)


def segment(pitches, min_frames=3):
    """Contiguous runs of the same semitone. Runs shorter than `min_frames`
    (150 ms) are detector noise and are dropped rather than counted as notes."""
    sem = [None if p is None else int(round(to_midi(p))) for p in pitches]
    runs, cur, n = [], None, 0
    for s in sem + [object()]:
        if s == cur:
            n += 1
        else:
            if cur is not None and n >= min_frames:
                runs.append((cur, n))
            cur, n = (s if isinstance(s, (int, type(None))) else None), 1
    return runs


def analyse(path, bpm):
    x, sr = decode(path)
    runs = segment(track_pitch(x, sr))
    notes = [m for m, _ in runs if m is not None]
    if len(notes) < 4:
        return None
    dur_s = len(x) / sr
    bars = dur_s / (4 * 60.0 / bpm)
    classes = Counter(m % 12 for m in notes)
    moves = [b - a for a, b in zip(notes, notes[1:]) if a != b]
    holds = [n * 0.05 for m, n in runs if m is not None]
    return dict(
        notes_per_bar=len(notes) / bars,
        distinct_classes=len(classes),
        top_class_share=classes.most_common(1)[0][1] / len(notes),
        median_midi=float(np.median(notes)),
        median_hz=float(440 * 2 ** ((np.median(notes) - 69) / 12)),
        median_hold_s=float(np.median(holds)),
        move_abs_median=float(np.median([abs(m) for m in moves])) if moves else 0.0,
        moves=Counter(int(np.clip(m, -12, 12)) for m in moves),
        n_notes=len(notes),
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="influences/tribal")
    ap.add_argument("--n", type=int, default=40)
    a = ap.parse_args()

    tags = json.loads((HERE / "data" / "tags-influences.json").read_text())
    root = HERE / a.dir
    files = sorted(root.rglob("*.opus"))
    files = files[:: max(1, len(files) // a.n)][:a.n]

    rows, allmoves = [], Counter()
    for i, f in enumerate(files, 1):
        key = str(f.relative_to(HERE / "influences"))
        bpm = (tags.get(key) or {}).get("tempo")
        if not bpm:
            continue
        try:
            r = analyse(f, bpm)
        except Exception as e:                                  # noqa: BLE001
            print(f"  [{i}/{len(files)}] {f.name[:40]:40} FAILED {e}")
            continue
        if not r:
            continue
        rows.append(r)
        allmoves.update(r["moves"])
        print(f"  [{i}/{len(files)}] {f.name[:38]:38} "
              f"{r['notes_per_bar']:4.1f}/bar {r['distinct_classes']:2d} classes "
              f"{r['median_hz']:5.1f} Hz hold {r['median_hold_s']:.2f}s")

    if not rows:
        print("no usable tracks")
        return

    def med(k):
        return float(np.median([r[k] for r in rows]))

    print(f"\n{'=' * 70}\n  {a.dir} — {len(rows)} tracks\n{'=' * 70}")
    print(f"  notes per bar        {med('notes_per_bar'):6.2f}   "
          f"(⚠️ a FLOOR: repeats at one pitch merge)")
    print(f"  distinct pitch CLASSES {med('distinct_classes'):4.1f}")
    print(f"  top class share      {med('top_class_share'):6.2f}   "
          f"(1.00 = a one-note pedal, which is what OUR records play)")
    print(f"  median note length   {med('median_hold_s'):6.2f} s")
    print(f"  median register      {med('median_hz'):6.1f} Hz  "
          f"(MIDI {med('median_midi'):.1f})")
    print(f"  median |interval|    {med('move_abs_median'):6.1f} semitones")
    tot = sum(allmoves.values()) or 1
    print(f"\n  interval distribution (semitones, + = up):")
    for s, c in sorted(allmoves.items()):
        if c / tot > 0.02:
            print(f"    {s:+3d}  {c / tot * 100:5.1f}%  {'#' * int(c / tot * 120)}")
    out = HERE / "data" / f"bassline-{Path(a.dir).name}.json"
    out.write_text(json.dumps(dict(
        n=len(rows), dir=a.dir,
        notes_per_bar=med("notes_per_bar"),
        distinct_classes=med("distinct_classes"),
        top_class_share=med("top_class_share"),
        median_hold_s=med("median_hold_s"),
        median_hz=med("median_hz"),
        move_abs_median=med("move_abs_median"),
        intervals={str(k): v for k, v in sorted(allmoves.items())},
    ), indent=1))
    print(f"\n  wrote {out}")


if __name__ == "__main__":
    main()
