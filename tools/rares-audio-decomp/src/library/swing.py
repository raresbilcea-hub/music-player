"""
swing.py -- how far behind the grid the OFF 16ths sit, measured so that the
answer means the same thing as `make_track.py`'s SWING dial.

🔴 THIS IS THE THIRD ATTEMPT AND THE FIRST TWO WERE BOTH WRONG IN THE SAME WAY:
they measured a quantity, reported it as swing, and it was not swing.

  ATTEMPT 1 reported "47%" from `50 + 12.5 * offset`, an invented scale, and I
  set it beside `make_track.py`'s SWING = 0.62 as though the two were
  comparable. They are not. **0.62 there means "delay every other 16th by 24%
  of a 16th"**; back-solving my 47% gives the off-beats landing 24% of a 16th
  EARLY, which is the onset detector's peak leading the attack. Two different
  quantities, compared. Master rule: re-derive a number from its definition
  rather than moving the figure around.

  ATTEMPT 2 fixed the detector-lead problem correctly -- lead cancels if you
  take the DIFFERENCE between on-beat and off-beat offsets -- but compared the
  wrong pair: the "&" (steps 2/6/10/14) against the beat (0/4/8/12).
  **Sixteenth swing delays neither of those.** It delays the "e" and the "a",
  the ODD 16ths. So attempt 2 was blind to the thing it was measuring and
  returned ~0 ms for every record, which I nearly reported as "these records
  are straight".

WHAT THIS ONE DOES. Offsets of the ODD 16ths (1,3,5,...,15 -- the "e"s and
"a"s) minus offsets of the EVEN 16ths (0,2,4,...,14). Detector lead is common
to both and cancels. The result is the delay applied to the off 16ths, which is
exactly what SWING controls, so it converts directly:

    SWING = 0.5 + (delay_as_fraction_of_a_16th) / 2

⚠️ RESOLUTION. The onset curve runs at a 128-sample hop = **2.9 ms per frame**,
so any answer is quantised to 2.9 ms and anything under ~±3 ms is
indistinguishable from straight. At 120 BPM a 16th is 125 ms, so 2.9 ms is
0.023 of a 16th, i.e. SWING resolution of about ±0.012. Report the spread.

⚠️ AND IT ONLY WORKS IF THE PART PLAYS 16ths AT ALL. A hat on 8ths has no odd
16ths to measure, and `n` will be small. Below MIN_N the record is reported as
"no 16th content", not as "straight".

Run: /Users/paul/miniconda3/bin/python3 library/swing.py
"""
import glob
import os
import subprocess
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib.util

spec = importlib.util.spec_from_file_location(
    "ge", os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "groove-extract.py"))
ge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ge)

STEMS = "library/inspo/stems-refs/htdemucs"
MIN_N = 60          # below this there is not enough 16th content to measure


def measure(stems_dir, mix=None):
    name = os.path.basename(stems_dir.rstrip("/"))
    drums = os.path.join(stems_dir, "drums.wav")
    bpm, beats = ge.beats_of(mix or drums)          # cached
    grid = ge.grid16(beats)
    x = ge.decode(drums)
    sixteenth = 60.0 / bpm / 4

    # compute the kick curve ONCE and reuse it for the downbeat
    kc, kfs = ge.band_flux(x, 30, 110)
    kick_on = ge.peaks(kc, kfs, min_gap_s=ge.MIN_GAP["kick"], thresh=2.0)
    db = ge.downbeat(kick_on, grid)

    out = {}
    for b, (lo, hi) in ge.BANDS.items():
        if b == "kick":
            continue                                 # the kick is not a swing carrier
        c, fs = ge.band_flux(x, lo, hi)
        on = ge.peaks(c, fs, min_gap_s=ge.MIN_GAP[b], thresh=2.0)
        if on.size < MIN_N:
            continue
        j = np.clip(np.searchsorted(grid, on), 0, len(grid) - 2)
        pv = np.clip(j - 1, 0, len(grid) - 2)
        i = np.where(np.abs(on - grid[pv]) < np.abs(on - grid[j]), pv, j)
        off = on - grid[i]
        rel = (i - db) % 16
        odd = (rel % 2) == 1                          # the "e"s and "a"s
        even = ~odd
        if odd.sum() < MIN_N or even.sum() < MIN_N:
            out[b] = None
            continue
        d = float(np.median(off[odd]) - np.median(off[even]))
        out[b] = (d * 1000, d / sixteenth, 0.5 + (d / sixteenth) / 2,
                  int(odd.sum()), int(even.sum()))
    return name, bpm, out


def main():
    rows = []
    for d in sorted(glob.glob(STEMS + "/*/")):
        n = os.path.basename(d.rstrip("/"))
        mix = subprocess.run(["find", "library/influences", "-name", n + ".opus"],
                             capture_output=True, text=True).stdout.strip()
        mix = mix.split("\n")[0] if mix else None
        rows.append(measure(d, mix))

    print(f"\n{'='*74}\nSWING — delay of the ODD 16ths, the 'e's and 'a's\n{'='*74}")
    print(f"  {'record':<24}{'part':<10}{'delay':>9}{'of a 16th':>11}"
          f"{'= SWING':>9}{'n odd/even':>13}")
    vals = []
    for name, bpm, out in rows:
        for b, v in out.items():
            if v is None:
                print(f"  {name[:22]:<24}{b:<10}{'no 16th content':>29}")
                continue
            ms, fr, sw, no, ne = v
            print(f"  {name[:22]:<24}{b:<10}{ms:>+7.1f}ms{fr:>+11.3f}"
                  f"{sw:>9.3f}{no:>7}/{ne:<6}")
            vals.append(sw)
    if vals:
        print(f"\n  mean SWING {np.mean(vals):.3f}   median {np.median(vals):.3f}"
              f"   range {min(vals):.3f}-{max(vals):.3f}   n={len(vals)}")
        print(f"  resolution of this measurement is ±0.012 SWING (one 2.9 ms frame)")
        print(f"  *Without Asking* was built at SWING = 0.62")
        if abs(np.mean(vals) - 0.5) < 0.02:
            print("  → indistinguishable from STRAIGHT at this resolution")
    print(f"\n  beat cache: ", end="")
    from beatcache import stats
    print(stats())


if __name__ == "__main__":
    main()
