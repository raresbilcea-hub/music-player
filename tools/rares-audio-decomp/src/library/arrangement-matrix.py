"""
arrangement-matrix.py -- the RAW arrangement data, extracted once and kept.

WHY THIS EXISTS. The first study ran Demucs, printed a 4-bar picture, and then
DELETED the stems. So when Paul asked for finer resolution there was nothing to
re-read and the whole 2-hour separation had to run again. Separation is the
expensive step (2:19 a track at 6 stems); measuring is free. So this does the
expensive thing once and writes the numbers, and every question after that is a
cheap read.

WHAT IT WRITES, per track, one JSON object per line:
  beats     actual beat times in seconds, from Essentia's tracker -- NOT a
            constant BPM. A record that drifts is measured where it actually is.
  db        {stem: [dB per beat, relative to that stem's own 95th percentile]}
  pk        {stem: [peak per beat, same reference]} -- RMS says how much is
            there, peak says whether it was a transient. A fill is visible in
            the gap between them and invisible in either alone.
  downbeat  index into `beats` of the first downbeat, so bars are derivable
            at any grouping without re-deciding the phase.

SIX STEMS, NOT FOUR. htdemucs_6s splits `piano` and `guitar` out of `other`.
That matters here specifically: piano is in 18% of Paul's library and his lane
is organic house, where guitar is a real instrument rather than a rounding
error. With four stems every one of those lived in one undifferentiated `other`
and the study was structurally unable to see them.

WHAT IT STILL CANNOT SAY. `other` remains a bag -- pad, strings, lead, most
percussion. Demucs also bleeds: a piano stem on a track with no piano is not
evidence of a piano. Treat a stem that never rises above about -25 dB as
absent rather than quiet.

Run:  /Users/paul/miniconda3/bin/python3 library/arrangement-matrix.py \
        --stems library/inspo/stems-study/htdemucs_6s \
        --out library/data/arrangement-matrix.jsonl
"""
import argparse
import glob
import json
import os

import numpy as np
import soundfile as sf

STEMS6 = ["drums", "bass", "other", "vocals", "guitar", "piano"]
SR = 44100


def beats_of(path):
    """Actual beat times and BPM. Essentia's multifeature tracker returns the
    ticks it found; using them instead of 60/bpm keeps a drifting record honest."""
    import essentia.standard as es
    a = es.MonoLoader(filename=path, sampleRate=SR)()
    bpm, ticks, _c, _e, _i = es.RhythmExtractor2013(method="multifeature")(a)
    return float(bpm), np.asarray(ticks, dtype=float), len(a) / SR


def downbeat_index(drums_path, beats):
    """Which of the first four beats carries the most low-end energy. Only the
    phase matters, and only to within a beat -- a half-bar error shifts every
    boundary equally and changes no conclusion."""
    x, sr = sf.read(drums_path, always_2d=True)
    x = x.mean(1)
    # crude low-pass: decimate-by-averaging is enough to rank kick weight
    best, bi = -1.0, 0
    for i in range(min(4, len(beats) - 1)):
        i0, i1 = int(beats[i] * sr), int(beats[i + 1] * sr)
        seg = x[max(0, i0):min(len(x), i1)]
        if not len(seg):
            continue
        e = float(np.sqrt(np.mean(seg[: len(seg) // 4] ** 2)))  # attack window
        if e > best:
            best, bi = e, i
    return bi


def per_beat(path, beats):
    x, sr = sf.read(path, always_2d=True)
    x = x.mean(1)
    rms, pk = [], []
    for i in range(len(beats) - 1):
        i0, i1 = int(beats[i] * sr), int(beats[i + 1] * sr)
        seg = x[max(0, i0):min(len(x), i1)]
        if not len(seg):
            rms.append(0.0)
            pk.append(0.0)
            continue
        rms.append(float(np.sqrt(np.mean(seg ** 2))))
        pk.append(float(np.max(np.abs(seg))))
    return np.array(rms), np.array(pk)


def to_db(v):
    """dB relative to this stem's own 95th percentile, so every stem is scaled
    against its own loudest moment and 0 dB means 'as loud as this part gets'."""
    nz = v[v > 0]
    ref = np.percentile(nz, 95) if len(nz) else 1.0
    return np.round(20 * np.log10(np.maximum(v, 1e-9) / max(ref, 1e-12)), 2)


def one(track_dir):
    files = {}
    for s in STEMS6:
        for ext in ("flac", "wav"):
            p = os.path.join(track_dir, f"{s}.{ext}")
            if os.path.exists(p):
                files[s] = p
                break
    if "drums" not in files:
        return None
    bpm, beats, dur = beats_of(files["drums"])
    if len(beats) < 8:
        return None
    rec = {
        "track": os.path.basename(track_dir),
        "bpm": round(bpm, 2),
        "dur": round(dur, 2),
        "n_beats": len(beats) - 1,
        "beats": [round(float(b), 4) for b in beats],
        "downbeat": downbeat_index(files["drums"], beats),
        "stems": sorted(files),
        "db": {},
        "pk": {},
    }
    for s, p in files.items():
        r, k = per_beat(p, beats)
        rec["db"][s] = to_db(r).tolist()
        rec["pk"][s] = to_db(k).tolist()
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stems", default="library/inspo/stems-study/htdemucs_6s")
    ap.add_argument("--out", default="library/data/arrangement-matrix.jsonl")
    ap.add_argument("--track", default=None)
    a = ap.parse_args()

    done = set()
    if os.path.exists(a.out):
        for line in open(a.out):
            try:
                done.add(json.loads(line)["track"])
            except Exception:
                pass
    dirs = sorted(d for d in glob.glob(os.path.join(a.stems, "*")) if os.path.isdir(d))
    if a.track:
        dirs = [d for d in dirs if a.track.lower() in os.path.basename(d).lower()]
    n = 0
    with open(a.out, "a") as fh:
        for d in dirs:
            if os.path.basename(d) in done:
                continue
            rec = one(d)
            if rec is None:
                print(f"  skip (no usable stems/beats): {os.path.basename(d)}")
                continue
            fh.write(json.dumps(rec) + "\n")
            fh.flush()
            n += 1
            print(f"  + {rec['track']}  {rec['bpm']:.1f} BPM  "
                  f"{rec['n_beats']} beats  {len(rec['stems'])} stems")
    print(f"wrote {n} tracks to {a.out}")


if __name__ == "__main__":
    main()
