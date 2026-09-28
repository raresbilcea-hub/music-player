"""
groove-summary.py -- put the four extracted reference grooves side by side and
say which parts of them agree.

WHY AGREEMENT IS THE POINT. Any one of these numbers could be a detector
artefact -- four bugs turned up in `groove-extract.py` in twenty minutes, and
the audit debt logged in STATUS.md says the failure mode here is event
detection, which is exactly what produced these rows. **A pattern that four
independent records agree on is evidence; a pattern in one record is a
hypothesis.** So this file reports the spread as loudly as the mean, and marks
any row where the records disagree as NOT USABLE rather than averaging it into
a number that looks confident.

Run: /Users/paul/miniconda3/bin/python3 library/groove-summary.py
"""
import glob
import json

import numpy as np

STEPS = list(range(16))


def load(pattern="/tmp/g-*.json"):
    out = []
    for p in sorted(glob.glob(pattern)):
        try:
            out.append(json.load(open(p)))
        except Exception:
            pass
    return out


def row(vals):
    return "".join(f"{v:>4.0f}" for v in vals)


def main():
    recs = load()
    print(f"\n{'='*78}\nFOUR REFERENCE GROOVES — all at ~120 BPM\n{'='*78}")
    for r in recs:
        print(f"  {r['name'][:34]:<36}{r['bpm']:>7.2f} BPM   {r['bars']:>4} bars"
              f"   bass notes {len(r.get('bass') or []):>5}")

    for inst in ("kick", "mid-perc", "hat"):
        print(f"\n  {inst.upper()}  — % of bars with a hit on that 16th")
        print(f"  {'':22}" + "".join(f"{i+1:>4}" for i in STEPS))
        M = []
        for r in recs:
            v = (r.get("occupancy") or {}).get(inst)
            if not v:
                continue
            M.append(v)
            print(f"  {r['name'][:20]:<22}" + row(v))
        if len(M) < 2:
            continue
        M = np.array(M)
        print(f"  {'MEAN':<22}" + row(M.mean(axis=0)))
        print(f"  {'SPREAD (max-min)':<22}" + row(M.max(axis=0) - M.min(axis=0)))
        spread = float(np.median(M.max(axis=0) - M.min(axis=0)))
        agree = spread < 25
        print(f"  → median spread {spread:.0f} points across records — "
              + ("USABLE, they agree" if agree else
                 "🔴 NOT USABLE, the records disagree more than the pattern"))

    print(f"\n  SWING — where the off-8ths sit (50% = dead straight)")
    sw = []
    for r in recs:
        for k, v in (r.get("swing") or {}).items():
            print(f"  {r['name'][:20]:<22}{k:<10}{v[0]:>6.1f}%   n={v[1]}")
            sw.append(v[0])
    if sw:
        print(f"  → mean {np.mean(sw):.1f}%  ·  range {min(sw):.1f}-{max(sw):.1f}%")
        print(f"    *Without Asking* was built at 62%.")

    print(f"\n  BASS — onsets per 16th, % of bars")
    B = []
    for r in recs:
        n = r.get("bass") or []
        if not n:
            continue
        c = np.bincount([x["step"] for x in n], minlength=16)
        v = 100 * c / max(r["bars"], 1)
        B.append(v)
        print(f"  {r['name'][:20]:<22}" + row(v))
    if len(B) >= 2:
        B = np.array(B)
        print(f"  {'MEAN':<22}" + row(B.mean(axis=0)))
        k = [r for r in recs if r.get("occupancy", {}).get("kick")]
        if k:
            K = np.array([r["occupancy"]["kick"] for r in k]).mean(axis=0)
            on = [i for i in STEPS if K[i] > 60]
            print(f"  kick lands on steps {[i+1 for i in on]};"
                  f" bass mean on those steps {B.mean(axis=0)[on].mean():.0f}%"
                  f" vs {B.mean(axis=0)[[i for i in STEPS if i not in on]].mean():.0f}%"
                  f" elsewhere")
            print("  → if the second number is higher, the bass is playing AROUND"
                  " the kick, which is\n    the deep-house convention and the"
                  " opposite of doubling it.")

    print(f"\n  BASS REGISTER — ⚠️ read with suspicion")
    for r in recs:
        n = r.get("bass") or []
        if not n:
            continue
        m = np.array([x["midi"] for x in n])
        f = 440 * 2 ** ((m - 69) / 12)
        print(f"  {r['name'][:20]:<22}MIDI {m.min():>3}-{m.max():<3}"
              f"  {f.min():>5.0f}-{f.max():<5.0f} Hz"
              f"   median {np.median(f):>5.0f} Hz"
              f"   below 35 Hz: {100*(f<35).mean():>4.1f}%")
    print("  Anything under ~35 Hz is an octave error, not a note — no house"
          " record\n  has its bassline down there. The MEDIAN is the usable"
          " figure; the range is not.")


if __name__ == "__main__":
    main()
