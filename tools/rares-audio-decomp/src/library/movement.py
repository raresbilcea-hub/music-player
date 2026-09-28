#!/usr/bin/env python3
"""movement.py — DO HIS REFERENCES ACTUALLY MOVE, AND BY HOW MUCH?

🔴 THIS EXISTS BECAUSE HE ASKED WHERE THE IDEAS COME FROM. His words:
*"explain where you got the idea to build them from, so it's based on
something instead of just filling the mix with a bunch of stuff. I had the
thought of 'less is more' while listening to the mix."*

The honest position before this script: **automation as a category is
evidenced** — the research line naming "automations" as more important than
the melody, plus a measurement showing this record had ZERO parameter
automation while he described it as static — **but the specific list was
convention.** Reverb throws, width automation and resonance sweeps are
standard house technique that I had not measured in HIS lane.

So measure the lane instead of quoting the genre. Three things, per track,
against the same numbers from our own render:

  BRIGHTNESS MOVEMENT   spectral centroid per 2 s window. How much does the
                        TONE move over a record, in octaves? A filter sweep is
                        the main thing that moves it.
  WIDTH MOVEMENT        mid/side ratio per window. Does the stereo picture
                        open and close, or is it fixed?
  DYNAMIC MOVEMENT      short-window loudness spread — the arrangement arc.

⚠️ WHAT THIS CANNOT SEE. It measures the SUM of a finished master. It cannot
separate a filter sweep from an arrangement change, and it cannot prove which
technique produced the movement. It answers "how much does a record in his
lane move?" — which is the question that decides whether to build more
movement at all — and not "how did they do it."
"""
import subprocess
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
WIN = 2.0            # seconds per analysis window


def load(path, sr=22050, max_s=420):
    """Decode via ffmpeg — the opus files are not readable by soundfile."""
    cmd = ["ffmpeg", "-v", "quiet", "-i", str(path), "-t", str(max_s),
           "-ac", "2", "-ar", str(sr), "-f", "f32le", "-"]
    raw = subprocess.run(cmd, capture_output=True).stdout
    if len(raw) < sr * 8:
        return None, sr
    x = np.frombuffer(raw, dtype="<f4")
    return x.reshape(-1, 2), sr


def movement(x, sr):
    n = int(WIN * sr)
    L, R = x[:, 0], x[:, 1]
    mid, side = (L + R) / 2, (L - R) / 2
    cen, wid, rms = [], [], []
    for a in range(0, len(mid) - n, n):
        seg = mid[a:a + n]
        e = float(np.sqrt((seg ** 2).mean()))
        if e < 1e-4:
            continue                       # silence: not movement
        X = np.abs(np.fft.rfft(seg * np.hanning(n)))
        f = np.fft.rfftfreq(n, 1 / sr)
        cen.append(float((f * X).sum() / (X.sum() or 1)))
        s = float(np.sqrt((side[a:a + n] ** 2).mean()))
        wid.append(s / (e + 1e-9))
        rms.append(20 * np.log10(e))
    if len(cen) < 12:
        return None
    cen, wid, rms = np.array(cen), np.array(wid), np.array(rms)
    # 🔴 SEPARATE THE TWO TIMESCALES, OR THE NUMBER IS MEANINGLESS. Paul:
    # *"I think your numbers are being polluted by just the amount of stuff
    # going on in the track, particularly in the final section."* He is right,
    # and it is the third confounded measurement of the day. A whole-track
    # spread cannot tell a FILTER SWEEPING INSIDE A SECTION from ELEMENTS
    # PILING UP at the peak — and those are exactly the two things this
    # comparison is supposed to distinguish, because only the first one is
    # automation.
    #
    # So detrend at arrangement scale: subtract a moving median over ~40 s and
    # measure what is left. What remains is movement FASTER than a section,
    # which is what a filter sweep is and what an arrangement change is not.
    k = max(int(40.0 / WIN) | 1, 5)
    def _detrend(v):
        pad = np.pad(v, k // 2, mode="edge")
        trend = np.array([np.median(pad[i:i + k]) for i in range(len(v))])
        return v - trend, trend
    lc = np.log2(np.maximum(cen, 1.0))
    lc_d, lc_t = _detrend(lc)
    wd_d, _ = _detrend(np.log2(np.maximum(wid, 1e-6)))
    return dict(
        # octaves between the 10th and 90th percentile of brightness: a
        # percentile range rather than min/max so one crash cymbal cannot
        # define "how much this record moves"
        cen_oct=float(np.log2(np.percentile(cen, 90) / max(np.percentile(cen, 10), 1))),
        cen_med=float(np.median(cen)),
        wid_ratio=float(np.percentile(wid, 90) / max(np.percentile(wid, 10), 1e-6)),
        wid_med=float(np.median(wid)),
        dyn_db=float(np.percentile(rms, 90) - np.percentile(rms, 10)),
        # WITHIN-SECTION movement: p10-p90 of the detrended series, in
        # octaves. This is the automation-scale number.
        cen_fast=float(np.percentile(lc_d, 90) - np.percentile(lc_d, 10)),
        # ARRANGEMENT-scale movement: the spread of the trend itself.
        cen_slow=float(np.percentile(lc_t, 90) - np.percentile(lc_t, 10)),
        wid_fast=float(2 ** (np.percentile(wd_d, 90) - np.percentile(wd_d, 10))),
        n=len(cen))


def run(paths, label):
    rows = []
    for p in paths:
        x, sr = load(p)
        if x is None:
            continue
        m = movement(x, sr)
        if m:
            m["name"] = Path(p).stem[:38]
            rows.append(m)
    if not rows:
        print(f"{label}: nothing measurable")
        return None
    print(f"\n=== {label} — {len(rows)} tracks ===")
    med = lambda k: float(np.median([r[k] for r in rows]))       # noqa: E731
    print(f"  WITHIN-SECTION brightness (automation scale) {med('cen_fast'):.2f} oct")
    print(f"  ARRANGEMENT-SCALE brightness                 {med('cen_slow'):.2f} oct")
    print(f"  WITHIN-SECTION width                         {med('wid_fast'):.2f}x")
    print(f"  whole-track brightness (CONFOUNDED)          {med('cen_oct'):.2f} oct")
    print(f"  dynamic range                                {med('dyn_db'):.1f} dB")
    return dict(cen_oct=med("cen_oct"), wid_ratio=med("wid_ratio"),
                dyn_db=med("dyn_db"), cen_fast=med("cen_fast"),
                cen_slow=med("cen_slow"), wid_fast=med("wid_fast"))


if __name__ == "__main__":
    # --dir/--label added 6 Aug 2026 for the TRIBAL fork. The two folders below
    # were hardcoded, which meant this script could only ever answer the
    # deep-house question. `rglob`, not `glob`: a fetched reference set is one
    # folder per artist, so a flat glob finds nothing and reports it as an empty
    # lane rather than as a path error.
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", action="append", default=None,
                    help="folder of .opus to measure; repeatable. Default: inspo + by-name")
    ap.add_argument("--label", action="append", default=None)
    ap.add_argument("--n", type=int, default=40)
    a = ap.parse_args()

    if a.dir:
        labels = a.label or []
        results = []
        for i, d in enumerate(a.dir):
            files = sorted((HERE / d).rglob("*.opus"))[: a.n]
            if not files:
                print(f"!! no .opus under {HERE / d} — nothing measured"); continue
            lbl = labels[i] if i < len(labels) else d
            results.append((lbl, run(files, f"{lbl} — {len(files)} tracks")))
        ref = results[0][1] if results else None
        lane_m = results[1][1] if len(results) > 1 else ref
        if ref is None:
            sys.exit("no input measured")
    else:
        inspo = sorted((HERE / "inspo").glob("*.opus"))
        lane = sorted((HERE / "by-name").glob("*.opus"))[:40]
        ref = run(inspo, "HIS HOUSE INSPO — the four he named for this track")
        lane_m = run(lane, "THE LANE — 40 tracks from his collection")
    ours = HERE.parent / "tracks" / "current" / "Master.wav"
    if ours.exists():
        import soundfile as sf
        x, sr = sf.read(ours, always_2d=True)
        m = movement(x.astype("float32"), sr)
        print(f"\n{'='*74}\n=== OURS vs HIS — the confound separated\n{'='*74}")
        print(f"{'':<34}{'ours':>9}{'inspo':>9}{'lane':>9}")
        for lbl, k in [("WITHIN-SECTION brightness", "cen_fast"),
                       ("WITHIN-SECTION width", "wid_fast"),
                       ("arrangement-scale brightness", "cen_slow"),
                       ("whole-track brightness (confounded)", "cen_oct"),
                       ("dynamic range dB", "dyn_db")]:
            print(f"{lbl:<34}{m[k]:>9.2f}{ref[k]:>9.2f}{lane_m[k]:>9.2f}")
