"""
energy-arc.py -- how a record's energy actually moves: where the low end drops
out, how long it stays out, and what the arc looks like end to end.

WHY NOT THE ARRANGEMENT STUDY. `arrangement-matrix.jsonl` has 139 records at
per-beat six-stem resolution and is the obvious tool for this. It cannot be
used, for two independent reasons:

  1. **COVERAGE.** Only 25 of its 139 records are influences at all, and of the
     cluster this track is aimed at it holds 3 Volen Sentir, 3 Gorje Hewek and
     **zero Lee Burridge**.

  2. **🔴 ITS PRESENCE DETECTOR FLICKERS, and the numbers it produces are the
     ruler measuring itself.** Measured 5 Aug 2026: the median run of "drums
     are playing" is **2 BEATS**, and ~70% of all runs across every stem are
     one bar or shorter. Drums do not leave and return every half-bar. It shows
     up in the output as a distribution whose mode is always the grid: at
     `--group 4`, **63.6% of section changes are exactly 4 bars**; at
     `--group 1`, **60.4% are exactly 1 bar**; and at 1-bar resolution only
     **1% of gaps are a multiple of 8**, on a corpus of house and techno. The
     file's own docstring already conceded this about the OLD 4-bar study --
     "partly the ruler measuring itself" -- and assumed per-beat resolution
     fixed it. It did not; it made it finer.

THIS FILE AVOIDS THE PROBLEM BY NOT SEPARATING ANYTHING. Whether the bass and
kick are playing is not a source-separation question -- it is a band-energy
question, and the band is right there in the mix. No Demucs, no bleed, no
threshold on a manufactured stem.

WHAT IT MEASURES, per record
  · full-band RMS per 0.25 s frame, in dB, normalised to the track's own p95
  · LOW-BAND (<120 Hz) RMS the same way -- this is the kick and bass
  · a BREAKDOWN = a run where the low band sits >`DROP_DB` under its own p90
    for at least `MIN_S` seconds. That is "the drums and bass went away",
    which is what Paul means by "take away".

⚠️ TEMPO CAVEAT. Bar counts are derived from `tags-influences.json`, whose
estimator emits only ten discrete values. Section-scale conclusions survive a
1-2% tempo error; anything bar-exact does not. Durations are therefore reported
in SECONDS first and bars second.

Run: /Users/paul/miniconda3/bin/python3 library/energy-arc.py --n 12
"""
import argparse
import json
import subprocess
import statistics as st

import numpy as np

FEAT = "library/data/tags-influences.json"
ROOT = "library/influences/"
SR = 22050
HOP = 0.25          # s
DROP_DB = 9.0       # how far under its own p90 the low band must fall
MIN_S = 6.0         # and for how long, to count as a breakdown rather than a gap


def decode(path):
    p = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR),
         "-f", "f32le", "-"],
        capture_output=True, check=False)
    if p.returncode != 0 or not p.stdout:
        return None
    return np.frombuffer(p.stdout, dtype="<f4")


def bands(x):
    from scipy.signal import butter, sosfiltfilt
    sos = butter(4, 120 / (SR / 2), btype="low", output="sos")
    return sosfiltfilt(sos, x).astype("float32")


def frames(x, hop_s=HOP):
    h = int(hop_s * SR)
    n = len(x) // h
    if n == 0:
        return np.zeros(0)
    return 20 * np.log10(np.maximum(
        np.sqrt(np.mean(x[:n * h].reshape(n, h) ** 2, axis=1)), 1e-9))


def breakdowns(low_db, hop_s=HOP):
    """Runs where the low end is gone. Returns (start_s, dur_s, depth_db)."""
    ref = np.percentile(low_db, 90)
    out = low_db < ref - DROP_DB
    res, i = [], 0
    while i < len(out):
        if not out[i]:
            i += 1
            continue
        j = i
        while j < len(out) and out[j]:
            j += 1
        dur = (j - i) * hop_s
        if dur >= MIN_S:
            res.append((i * hop_s, dur, float(ref - low_db[i:j].mean())))
        i = j
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=12)
    ap.add_argument("--artists", default="Volen Sentir,Gorje Hewek,Lee Burridge")
    a = ap.parse_args()

    feat = json.load(open(FEAT))
    want = [s.strip() for s in a.artists.split(",")]

    # rank with the same filters find-references.py uses, then take the top n
    cands = []
    for k, r in feat.items():
        if r.get("artist") not in want:
            continue
        t = r.get("tempo")
        if t in (114.8, 143.6) or t is None or not (114 <= t <= 124):
            continue
        if r.get("density", 99) > 4.4 or r.get("crest", 0) < 10.5:
            continue
        cands.append((r.get("density", 9), k, r))
    cands.sort()
    cands = cands[:a.n]

    print(f"{len(cands)} reference records\n")
    rows = []
    for _, k, r in cands:
        x = decode(ROOT + k)
        if x is None or len(x) < SR * 30:
            print(f"  ⚠️ could not decode {k}")
            continue
        full = frames(x)
        low = frames(bands(x))
        dur = len(x) / SR
        bpm = r.get("tempo") or 120.0
        bar_s = 4 * 60.0 / bpm
        bd = breakdowns(low)
        rows.append({"k": k, "r": r, "dur": dur, "bar_s": bar_s,
                     "full": full, "low": low, "bd": bd})
        print(f"  {r['artist'][:16]:<17}{r['title'][:36]:<38}"
              f"{dur/60:>5.2f}min  {len(bd)} breakdown(s)")

    if not rows:
        return

    print(f"\n{'='*76}\nBREAKDOWNS — 'the take away'\n{'='*76}")
    print(f"  {'when (% in)':<14}{'length':>10}{'= bars':>9}{'depth':>9}   record")
    allbd = []
    for d in rows:
        for s, ln, dp in d["bd"]:
            allbd.append((s / d["dur"], ln, ln / d["bar_s"], dp, d))
    for pos, ln, bars, dp, d in sorted(allbd):
        print(f"  {100*pos:>6.0f}%       {ln:>7.1f}s{bars:>9.1f}{dp:>8.1f}dB"
              f"   {d['r']['artist'][:14]} — {d['r']['title'][:28]}")

    # 🔴 THE INTRO AND THE OUTRO ARE NOT BREAKDOWNS. A record whose low end has
    # not arrived yet, or has already gone for good, trips the same detector --
    # 9 of the runs above start at 0%. Counting those as "take aways" would have
    # inflated the per-record figure by roughly half and put a phantom breakdown
    # at the top of every record.
    mid = [x for x in allbd if 0.08 <= x[0] <= 0.88]
    print(f"\n  of {len(allbd)} runs, {len(allbd)-len(mid)} are the intro or the"
          f" outro (start <8% or >88%) and are NOT take-aways")
    per = {}
    for x in mid:
        per[id(x[4])] = per.get(id(x[4]), 0) + 1
    counts = [per.get(id(d), 0) for d in rows]
    if mid:
        L = [x[1] for x in mid]; B = [x[2] for x in mid]
        print(f"\n  MID-RECORD TAKE-AWAYS ONLY ({len(mid)} of them):")
        print(f"    per record: median {st.median(counts):.0f}  ·  range {min(counts)}-{max(counts)}")
        print(f"    length: median {st.median(L):.0f}s = {st.median(B):.1f} bars"
              f"  ·  p10 {np.percentile(L,10):.0f}s  p90 {np.percentile(L,90):.0f}s")
        print(f"    depth:  median {st.median([x[3] for x in mid]):.1f} dB")
        print(f"    positions: {', '.join(f'{100*x[0]:.0f}%' for x in sorted(mid))}")

    n_bd = [len(d["bd"]) for d in rows]
    print(f"\n  breakdowns per record: median {st.median(n_bd):.0f}"
          f"  ·  range {min(n_bd)}-{max(n_bd)}")
    if allbd:
        L = [x[1] for x in allbd]
        B = [x[2] for x in allbd]
        print(f"  length: median {st.median(L):.0f}s = {st.median(B):.1f} bars"
              f"  ·  p10 {np.percentile(L,10):.0f}s  p90 {np.percentile(L,90):.0f}s")
        print(f"  depth:  median {st.median([x[3] for x in allbd]):.1f} dB below"
              f" the track's own low-end level")
        print(f"  position: {', '.join(f'{100*x[0]:.0f}%' for x in sorted(allbd)[:14])}")

    print(f"\n{'='*76}\nTHE ARC — full-band energy at each point of the record\n{'='*76}")
    grid = np.linspace(0, 1, 21)
    curves = []
    for d in rows:
        f = d["full"]
        f = f - np.percentile(f, 95)
        curves.append(np.interp(grid, np.linspace(0, 1, len(f)), f))
    med = np.median(np.array(curves), axis=0)
    for g, v in zip(grid, med):
        bar = "█" * max(0, int((v + 24) / 1.2))
        print(f"  {100*g:>4.0f}%  {v:>6.1f} dB  {bar}")
    print("\n  0 dB = the record's own loudest moment (p95). This is the shape"
          "\n  a listener actually experiences, measured off the mix itself.")


if __name__ == "__main__":
    main()
