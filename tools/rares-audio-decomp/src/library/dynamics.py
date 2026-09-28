"""dynamics.py — how far DOES a record in his lane drop in its quiet sections?

🔴 HIS NOTE, 7 Aug 2026: *"The break-outs are too quiet, by the way. Feels like
the whole record dropped out. Could use a bit of a boost."*

Measured on our own record first: the breakdowns average **-23.9 dB** against
the dense sections' **-13.4**, a gap of **10.5 dB**, and three of the four sit
14.5-16.4 dB under the peak. Tonight's FX work did not cause it — the
breakdowns actually rose +0.64 dB while the dense sections fell 1.83.

⚠️ AND THIS IS NOT THE NUMBER ALREADY CHECKED. On 7 Aug I measured that the
master chain flattens 8.08 dB of section arc into 1.14, went looking for a fix,
then measured the lane and found 1.14 was genre-correct — **but that comparison
was among each track's own LOUD half only**. The loud-to-QUIET span is a
different quantity and has never been measured against his library. A statistic
that settles one question does not settle its neighbour.

▶ **So: run this BEFORE proposing the boost, not after.** The rule this file
exists to honour is the one that stopped a bad change to the master chain — a
measurement saying "we are unlike X" is half an argument, and the other half is
what his own 641 tracks do.

Method, deliberately the same one `width.py` uses so the two are comparable:
everything through ffmpeg at ONE rate, 4-second windows, and for each track the
gap between the median of its LOUD half and the median of its QUIET half.

Run: python3 library/dynamics.py [n_tracks]
"""
import subprocess
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
INFL = HERE / "influences"
OURS = HERE.parent / "tracks" / "current" / "Master.wav"
SR = 44100
WIN = 4.0
MAX_S = 420


def load(path, sr=SR, max_s=MAX_S):
    cmd = ["ffmpeg", "-v", "quiet", "-i", str(path), "-t", str(max_s),
           "-f", "f32le", "-acodec", "pcm_f32le", "-ac", "1", "-ar", str(sr), "-"]
    raw = subprocess.run(cmd, capture_output=True).stdout
    x = np.frombuffer(raw, dtype=np.float32)
    return None if len(x) < sr * 60 else x.astype(np.float64)


def levels(x, sr=SR):
    """Per-window RMS in dB, silence dropped."""
    n = int(WIN * sr)
    out = []
    for a in range(0, len(x) - n, n):
        e = float(np.sqrt((x[a:a + n] ** 2).mean()))
        if e > 1e-4:
            out.append(20 * np.log10(e))
    return np.array(out)


def span(lv):
    """The gap that matters: median of the loud half minus median of the quiet
    half. ⚠️ NOT max-minus-min, which is one window of silence away from
    meaningless — the degenerate-input check this project keeps paying for."""
    if len(lv) < 12:
        return None
    med = np.median(lv)
    loud, quiet = lv[lv >= med], lv[lv < med]
    return (float(np.median(loud) - np.median(quiet)),
            float(np.median(loud) - np.percentile(lv, 10)),
            float(np.median(loud) - lv.min()))


def main(limit=None):
    files = sorted(p for p in INFL.rglob("*")
                   if p.suffix.lower() in (".opus", ".m4a", ".mp3", ".wav",
                                           ".flac", ".webm"))
    if limit:
        files = files[::max(1, len(files) // limit)][:limit]
    rows = []
    for i, f in enumerate(files):
        x = load(f)
        if x is None:
            continue
        s = span(levels(x))
        if s:
            rows.append((s, f))
        if (i + 1) % 25 == 0:
            print(f"  ... {i + 1}/{len(files)}", file=sys.stderr)
    if not rows:
        print("no lane tracks decoded")
        return
    half = np.array([r[0][0] for r in rows])
    p10 = np.array([r[0][1] for r in rows])
    mn = np.array([r[0][2] for r in rows])

    ours = load(OURS)
    o = span(levels(ours)) if ours is not None else None

    print(f"\n  {len(rows)} lane tracks, 4-second windows, one decoder\n")
    print(f"  {'':34}{'p10':>8}{'median':>9}{'p90':>8}{'OURS':>9}{'pct':>7}")
    for lbl, arr, mine in (("loud half vs QUIET half", half, o and o[0]),
                           ("loud half vs its 10th pct", p10, o and o[1]),
                           ("loud half vs its quietest", mn, o and o[2])):
        pct = float((arr < mine).mean() * 100) if mine is not None else float("nan")
        print(f"  {lbl:34}{np.percentile(arr, 10):8.1f}{np.median(arr):9.1f}"
              f"{np.percentile(arr, 90):8.1f}{mine:9.1f}{pct:6.0f}%")
    print("\n  'pct' = the share of his own lane we are ABOVE. Over ~75% means"
          "\n  our quiet sections drop further than his lane's do, which is what"
          "\n  he is describing; under ~50% means the fault is elsewhere.")


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else None)
