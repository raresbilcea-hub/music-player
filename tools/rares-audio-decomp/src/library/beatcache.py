"""
beatcache.py -- work out where the beats are ONCE, then never again.

WHY. Essentia's RhythmExtractor2013 is the slow step in every rhythm question we
ask: 60-90 s for an 8-minute record, because it is a model listening to the whole
thing. Everything downstream -- which 16th a drum lands on, swing, where the bass
sits -- is milliseconds once the beat times exist. Across one evening the four
reference records were beat-tracked THREE times for three different questions,
which is roughly fifteen minutes of the same computation.

**The beats of a finished record never change.** Paul's instruction, 5 Aug 2026:
cache them.

This is the same lesson as LEARNINGS.md §7 -- the arrangement study deleted each
track's stems after measuring, on a note about disk being tight, and when finer
resolution was wanted the entire two-hour separation had to run again.
**Separation is expensive and measurement is free; beat tracking is expensive and
reading a JSON is free.** Keep the expensive artefact.

INVALIDATION. The key is the file's path, size and mtime. If any of those change
the entry is recomputed, so re-downloading or re-encoding a track cannot silently
serve stale beats -- which is the one way a cache turns into a wrong answer
rather than a slow one.

Use:
    from beatcache import beats_of
    bpm, beats = beats_of("library/influences/Lee Burridge/Botanic.opus")
"""
import hashlib
import json
import os

import numpy as np

CACHE = "library/data/beats"


def _key(path):
    st = os.stat(path)
    h = hashlib.sha1(
        f"{os.path.abspath(path)}|{st.st_size}|{int(st.st_mtime)}".encode()
    ).hexdigest()[:20]
    return os.path.join(CACHE, h + ".json")


def beats_of(path, force=False, verbose=True):
    """(bpm, beat_times). Cached on disk, keyed by path+size+mtime."""
    ck = _key(path)
    if not force and os.path.exists(ck):
        try:
            d = json.load(open(ck))
            if verbose:
                print(f"  [beats: cached] {os.path.basename(path)}"
                      f" {d['bpm']:.2f} BPM, {len(d['beats'])} beats")
            return float(d["bpm"]), np.asarray(d["beats"], dtype=float)
        except Exception:
            pass                       # a corrupt entry is a recompute, not a crash

    import essentia.standard as es
    a = es.MonoLoader(filename=path, sampleRate=44100)()
    bpm, ticks, conf, _e, _i = es.RhythmExtractor2013(method="multifeature")(a)
    beats = np.asarray(ticks, dtype=float)
    os.makedirs(CACHE, exist_ok=True)
    json.dump({"path": os.path.abspath(path), "bpm": float(bpm),
               "confidence": float(conf), "beats": beats.tolist()},
              open(ck, "w"))
    if verbose:
        print(f"  [beats: COMPUTED] {os.path.basename(path)}"
              f" {bpm:.2f} BPM, {len(beats)} beats, confidence {conf:.2f}"
              f"  → {ck}")
    return float(bpm), beats


def stats():
    if not os.path.isdir(CACHE):
        return "no cache yet"
    f = [x for x in os.listdir(CACHE) if x.endswith(".json")]
    mb = sum(os.path.getsize(os.path.join(CACHE, x)) for x in f) / 1e6
    return f"{len(f)} records cached, {mb:.1f} MB"


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        for p in sys.argv[1:]:
            beats_of(p)
    print(stats())
