"""
arrangement-map.py -- how do the records Paul actually likes ADD and REMOVE
things across a track?

Paul, 5 Aug 2026: *"I'm very interested in the way that they vary sections of
the song. Both with layering, and with sequencing. Like how full is one section,
then the next? How does the transition happen? When does it happen? What
remains? What goes?"*

THE METHOD. The four House Inspo tracks are already Demucs-separated into
drums / bass / other / vocals. Per-bar RMS of each stem, in dB relative to that
stem's own loudest bar, gives a grid of what is playing when -- which is the
arrangement, measured off the record rather than read off a blog.

WHAT IT CANNOT DO, said up front. Four stems is not four instruments: `other`
holds the pad, the keys, the strings, the lead and most percussion all at once,
so "other is on" says nothing about WHICH of them is on. The grid is therefore
honest about ENTRIES, EXITS and DENSITY, and silent about instrumentation. For
anything finer the `other` stem has to be listened to, which is Paul's job.

A bar is taken from Essentia's tempo estimate, four beats per bar, with the
downbeat pinned to the first strong kick. A half-bar error shifts every boundary
by half a bar and would not change any conclusion here.

Run:  /Users/paul/miniconda3/bin/python3 library/arrangement-map.py
      [--track NAME] [--bars 8]
"""
import argparse
import glob
import os

import numpy as np
import soundfile as sf

STEMS = "library/inspo/stems/htdemucs"
PARTS = ["drums", "bass", "other", "vocals"]
SR = 44100


def per_bar_rms(path, bar_s, n_bars, t0):
    x, sr = sf.read(path, always_2d=True)
    x = x.mean(1)
    out = []
    for b in range(n_bars):
        i0 = int((t0 + b * bar_s) * sr)
        i1 = int((t0 + (b + 1) * bar_s) * sr)
        seg = x[max(0, i0):min(len(x), i1)]
        out.append(float(np.sqrt(np.mean(seg ** 2))) if len(seg) else 0.0)
    return np.array(out)


def tempo_and_downbeat(drums_path):
    """BPM from Essentia; downbeat from the loudest low-band onset in the first
    8 seconds. Only the phase matters and only to within a beat."""
    import essentia.standard as es
    a = es.MonoLoader(filename=drums_path, sampleRate=SR)()
    bpm, ticks, _c, _e, _i = es.RhythmExtractor2013(method="multifeature")(a)
    t0 = float(ticks[0]) if len(ticks) else 0.0
    while t0 > 60.0 / bpm * 4:
        t0 -= 60.0 / bpm * 4
    return float(bpm), t0, len(a) / SR


def grid(track_dir, group=4):
    bpm, t0, dur = tempo_and_downbeat(os.path.join(track_dir, "drums.wav"))
    bar_s = 60.0 / bpm * 4
    n_bars = int((dur - t0) // bar_s)
    lv = {}
    for p in PARTS:
        f = os.path.join(track_dir, f"{p}.wav")
        r = per_bar_rms(f, bar_s, n_bars, t0)
        ref = np.percentile(r[r > 0], 95) if (r > 0).any() else 1.0
        lv[p] = 20 * np.log10(np.maximum(r, 1e-9) / ref)
    # average over `group` bars so the picture is sections, not bar noise
    g = n_bars // group
    for p in PARTS:
        lv[p] = np.array([lv[p][i * group:(i + 1) * group].mean() for i in range(g)])
    return bpm, bar_s, g, group, lv


def symbol(db):
    if db < -30:
        return "."          # silent
    if db < -18:
        return "-"          # present but way down (filtered / distant)
    if db < -9:
        return "+"          # playing, not at full
    if db < -3:
        return "#"          # full
    return "@"              # loudest it gets


def report(name, bpm, bar_s, g, group, lv, bars_per_col):
    print(f"\n{'='*94}\n{name}")
    print(f"  {bpm:.1f} BPM · bar = {bar_s:.2f}s · one column = {bars_per_col} bars "
          f"= {bar_s*bars_per_col:.1f}s")
    print(f"  legend  . silent   - way down   + playing   # full   @ peak\n")
    ruler_bar, ruler_min = "", ""
    for i in range(g):
        b = i * bars_per_col + 1
        ruler_bar += "|" if b % 32 == 1 else " "
        t = (b - 1) * bar_s
        ruler_min += (f"{int(t//60)}" if b % 32 == 1 else " ")
    print(f"  {'bar 1':<10}{ruler_bar}")
    for p in PARTS:
        print(f"  {p:<10}" + "".join(symbol(v) for v in lv[p]))
    print(f"  {'minute':<10}{ruler_min}")

    # total density: how many parts are audibly playing
    dens = np.array([sum(1 for p in PARTS if lv[p][i] > -18) for i in range(g)])
    print(f"  {'#parts':<10}" + "".join(str(d) for d in dens))

    # where does the count change? that is a section boundary
    print("\n  SECTION CHANGES — what enters, what leaves")
    prev = {p: lv[p][0] > -18 for p in PARTS}
    prev_bar = 1
    for i in range(1, g):
        cur = {p: lv[p][i] > -18 for p in PARTS}
        ins = [p for p in PARTS if cur[p] and not prev[p]]
        outs = [p for p in PARTS if prev[p] and not cur[p]]
        if ins or outs:
            b = i * bars_per_col + 1
            t = (b - 1) * bar_s
            held = [p for p in PARTS if cur[p] and prev[p]]
            print(f"    bar {b:>3}  {int(t//60)}:{int(t%60):02d}  "
                  f"after {b-prev_bar:>3} bars   "
                  + (f"IN {'+'.join(ins):<14}" if ins else " " * 18)
                  + (f"OUT {'+'.join(outs):<14}" if outs else " " * 19)
                  + f"stays: {'+'.join(held) if held else 'nothing'}")
            prev, prev_bar = cur, b


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--track", default=None)
    ap.add_argument("--bars", type=int, default=4)
    ap.add_argument("--stems", default=STEMS)
    a = ap.parse_args()
    dirs = sorted(glob.glob(os.path.join(a.stems, "*")))
    if a.track:
        dirs = [d for d in dirs if a.track.lower() in os.path.basename(d).lower()]
    for d in dirs:
        if not os.path.exists(os.path.join(d, "drums.wav")):
            continue
        bpm, bar_s, g, grp, lv = grid(d, a.bars)
        report(os.path.basename(d), bpm, bar_s, g, grp, lv, a.bars)


if __name__ == "__main__":
    main()
