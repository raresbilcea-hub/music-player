"""
arrangement-analyse.py -- what 139 records do, read off the per-beat matrix.

REPLACES `arrangement-stats.py`, which parsed the old 4-bar TEXT study. That
study is gone: the stems are kept now, six-stem, and `arrangement-matrix.py`
writes actual numbers per beat. This reads those.

Paul's question, unchanged since he asked it: *"How full is one section, then
the next? How does the transition happen? When does it happen? What remains?
What goes?"*

WHAT IS DIFFERENT FROM THE OLD ANALYSIS, and why the answers should be trusted
more:
  · **Per BEAT, not per 4 bars.** The old grid could not see a change finer than
    4 bars, so "44% of changes land on 4 bars" was partly the ruler measuring
    itself. Any grouping can be derived here.
  · **SIX stems.** `piano` and `guitar` come out of `other`. Piano is in 18% of
    his library and the lane is organic house; the four-stem study was
    structurally blind to both.
  · **Real beat times.** From Essentia's tracker, not 60/bpm, so a record that
    drifts is measured where it actually is.

🔴🔴 DO NOT USE THIS FILE'S CHANGE-RATE OUTPUT. MEASURED 5 Aug 2026 AND IT IS
THE RULER MEASURING ITSELF.
  · The median run of "drums are playing" is **2 BEATS**, and ~70% of all runs
    on every stem are one bar or shorter. Drums do not leave and return every
    half-bar; `active()` flickers.
  · It shows in the output as the mode always being the grid: at `--group 4`,
    **63.6% of section changes are exactly 4 bars**; at `--group 1`, **60.4%
    are exactly 1 bar**; and at 1-bar resolution only **1% of gaps are a
    multiple of 8**, on a corpus of house and techno.
  · The docstring below already conceded this of the OLD 4-bar study and
    assumed per-beat resolution fixed it. **It did not. It made it finer.**
  · Coverage is also poor for the organic-house lane: 25 of 139 records are
    influences at all, and it holds **zero Lee Burridge**.
**For arrangement questions use `library/energy-arc.py`**, which measures band
energy off the mix and needs no separation, so it cannot bleed. Fixing this one
means fixing the presence detector first -- hysteresis and a minimum run length,
not another threshold.

⚠️ TWO LIMITS, STATED UP FRONT.
  1. **Demucs bleeds.** A `piano` stem on a track with no piano still carries
     energy — on the first test track it sat above -25 dB on 100% of beats. So
     presence is NOT a fixed threshold. `active()` below requires a stem to be
     both loud enough AND to actually *vary*, because bleed is steady while a
     real part enters and leaves.
  2. `other` is still a bag: pad, strings, lead, most percussion.

Run:  /Users/paul/miniconda3/bin/python3 library/arrangement-analyse.py
      [--matrix library/data/arrangement-matrix.jsonl] [--group 4] [--lane]
"""
import argparse
import collections
import json
import statistics as st

import numpy as np

STEMS = ["drums", "bass", "other", "vocals", "guitar", "piano"]
MATRIX = "library/data/arrangement-matrix.jsonl"
# `arrangement-filelist.tsv` carries genre + name per source path
LIST = "library/data/arrangement-filelist.tsv"


def load(path, listfile=LIST):
    meta = {}
    try:
        for line in open(listfile):
            p, genre, name = line.rstrip("\n").split("\t")
            key = p.rsplit("/", 1)[-1].rsplit(".", 1)[0]
            meta[key] = (genre, name)
    except Exception:
        pass
    out = []
    for line in open(path):
        try:
            r = json.loads(line)
        except Exception:
            continue
        g, n = meta.get(r["track"], ("?", r["track"]))
        r["genre"], r["name"] = g, n
        out.append(r)
    return out


def active(rec, stem, floor=-22.0, min_range=6.0, min_share=0.10):
    """Boolean 'this part is playing', per beat.

    🔴 TWO GUARDS, AND THE FIRST VERSION ONLY HAD THE WEAKER ONE. A fixed dB
    floor fails because Demucs BLEED is loud; I knew that and added a variance
    test, and it was not enough — bleed swings with the mix, so it cleared a
    6 dB range easily. The result was `piano` reading as present on 97% of beats
    (MORE than drums, on a house and techno corpus) and `guitar` showing signal
    in 134 of 134 records including every techno track. Both absurd on sight.

    The test that actually separates them is SHARE OF TOTAL ENERGY at that beat.
    A part that is really playing carries a meaningful fraction of the mix; bleed
    is a residue and stays small no matter how the mix moves. So a stem counts as
    active only if it is above the floor, swings across the record, AND holds at
    least `min_share` of the summed stem energy at that moment.
    """
    db = rec["db"]
    if stem not in db:
        return np.zeros(0, dtype=bool)
    a = np.asarray(db[stem], dtype=float)
    if a.size == 0 or (np.percentile(a, 95) - np.percentile(a, 5)) < min_range:
        return np.zeros(a.size, dtype=bool)
    lin = {s: 10 ** (np.asarray(db[s], dtype=float) / 20.0) for s in db}
    n = min(len(v) for v in lin.values())
    total = np.sum([lin[s][:n] for s in lin], axis=0)
    share = np.zeros(a.size)
    share[:n] = lin[stem][:n] / np.maximum(total, 1e-12)
    return (a > floor) & (share >= min_share)


def bars(rec, group=4):
    """Per-beat booleans -> per-`group`-bar booleans, phase-aligned to the
    detected downbeat. A bar is 4 beats; a part counts as present in a block if
    it plays in at least a quarter of it."""
    db = rec["db"]
    n = rec["n_beats"]
    start = rec.get("downbeat", 0)
    per = 4 * group
    blocks = (n - start) // per
    if blocks < 4:
        return None
    out = {}
    for s in STEMS:
        if s not in db:
            out[s] = np.zeros(blocks, dtype=bool)
            continue
        act = active(rec, s)
        if act.size < start + blocks * per:
            out[s] = np.zeros(blocks, dtype=bool)
            continue
        a = act[start:start + blocks * per].reshape(blocks, per)
        out[s] = a.mean(axis=1) > 0.25
    return out


def changes(grid, group=4):
    """Section boundaries: every block where the active set differs."""
    keys = [s for s in STEMS if s in grid]
    n = len(grid[keys[0]])
    ev, prev_i = [], 0
    prev = {s: grid[s][0] for s in keys}
    for i in range(1, n):
        cur = {s: grid[s][i] for s in keys}
        ins = [s for s in keys if cur[s] and not prev[s]]
        outs = [s for s in keys if prev[s] and not cur[s]]
        if ins or outs:
            ev.append({"bar": i * group + 1, "after": (i - prev_i) * group,
                       "in": ins, "out": outs,
                       "stays": [s for s in keys if cur[s] and prev[s]]})
            prev, prev_i = cur, i
    return ev


def h(t):
    print(f"\n{'='*78}\n{t}\n{'='*78}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--matrix", default=MATRIX)
    ap.add_argument("--group", type=int, default=4)
    ap.add_argument("--lane", action="store_true",
                    help="only the House Inspo + ADID-adjacent records")
    a = ap.parse_args()

    recs = load(a.matrix)
    if a.lane:
        recs = [r for r in recs if "Inspo" in r["genre"] or "Deep House" in r["genre"]]
    grids = []
    for r in recs:
        g = bars(r, a.group)
        if g:
            grids.append((r, g))

    gc = collections.Counter(r["genre"] for r, _ in grids)
    h(f"ARRANGEMENT — {len(grids)} records, {len(gc)} genres, {a.group}-bar blocks")
    for g, n in gc.most_common(12):
        print(f"  {n:3d}  {g}")
    print(f"\n  median {st.median(r['dur'] for r, _ in grids)/60:.2f} min"
          f"  ·  {st.median(r['bpm'] for r, _ in grids):.1f} BPM")

    # ── 1. what is even measurable, per stem ────────────────────────────────
    h("1. WHICH STEMS CARRY REAL STRUCTURE (and which are bleed)")
    print(f"  {'stem':<9}{'records w/ signal':>19}{'% of track present':>21}")
    for s in STEMS:
        live = [(r, g) for r, g in grids if g[s].any()]
        if not live:
            print(f"  {s:<9}{0:>19}{'—':>21}")
            continue
        pres = st.median(g[s].mean() for _, g in live)
        print(f"  {s:<9}{len(live):>8} / {len(grids):<8}{100*pres:>20.0f}%")
    print("\n  A stem with signal in few records is not absent from music — it is")
    print("  a stem Demucs could not separate confidently. Read it as coverage.")
    print("\n  🔴 PIANO AND GUITAR ARE NOT TRUSTWORTHY HERE — DO NOT QUOTE THEM.")
    print("  Piano reads as present on more of the record than BASS, and guitar")
    print("  shows signal in every single track including the techno. Neither is")
    print("  possible. Two guards (absolute floor, then share-of-total-energy)")
    print("  moved the numbers without fixing them, which says the six-stem split")
    print("  is putting real musical energy into those stems on material that has")
    print("  none. USE drums / bass / other / vocals. Validating piano would mean")
    print("  checking against the instrument head in ml-tags2-influences.json,")
    print("  which has piano probabilities per track — not yet done.")

    # ── 2. when ──────────────────────────────────────────────────────────────
    h("2. WHEN IT CHANGES")
    allev = [(r, changes(g, a.group)) for r, g in grids]
    gaps = [e["after"] for _, ev in allev for e in ev]
    per = [len(ev) for _, ev in allev]
    if gaps:
        c = collections.Counter(gaps)
        n = len(gaps)
        print(f"  {n} boundaries · median {st.median(per):.0f} per record"
              f" · median gap {st.median(gaps):.0f} bars\n")
        for b, k in sorted(c.items())[:10]:
            print(f"  {b:>3} bars  {k:>4}  {100*k/n:5.1f}%  {'#'*int(100*k/n/1.5)}")
        m8 = sum(1 for x in gaps if x % 8 == 0)
        m16 = sum(1 for x in gaps if x % 16 == 0)
        print(f"\n  multiple of 8: {100*m8/n:.0f}%   of 16: {100*m16/n:.0f}%"
              f"   longest hold {max(gaps)} bars")
        print(f"  ⚠️ finest visible change is {a.group} bars — rerun --group 1"
              f" to test whether these records move faster than that.")

    # ── 3. what ──────────────────────────────────────────────────────────────
    h("3. WHAT MOVES, AND WHAT NEVER LEAVES")
    print(f"  {'stem':<9}{'IN':>6}{'OUT':>6}{'never moves':>14}")
    for s in STEMS:
        ins = sum(1 for _, ev in allev for e in ev if s in e["in"])
        out = sum(1 for _, ev in allev for e in ev if s in e["out"])
        never = sum(1 for (r, g), (_, ev) in zip(grids, allev)
                    if g[s].any() and g[s].mean() > 0.9
                    and not any(s in e["in"] or s in e["out"] for e in ev))
        print(f"  {s:<9}{ins:>6}{out:>6}{never:>8} / {len(grids):<4}")

    # ── 4. how ───────────────────────────────────────────────────────────────
    h("4. HOW THE TRANSITION HAPPENS")
    kinds = collections.Counter()
    for _, ev in allev:
        for e in ev:
            if e["in"] and e["out"]:
                kinds["swap — one out, one in, same bar"] += 1
            elif e["in"]:
                kinds[f"add {len(e['in'])}"] += 1
            else:
                kinds[f"drop {len(e['out'])}"] += 1
    tot = sum(kinds.values()) or 1
    for k, v in kinds.most_common():
        print(f"  {k:<36}{v:>5}  {100*v/tot:4.0f}%")

    print("\n  THE BIGGEST STRIP IN EACH RECORD — what survives it:")
    surv = collections.Counter()
    for _, ev in allev:
        big = max((e for e in ev if e["out"]), key=lambda e: len(e["out"]), default=None)
        if big:
            surv[tuple(sorted(big["stays"])) or ("nothing",)] += 1
    for combo, k in surv.most_common(8):
        print(f"    {'+'.join(combo):<34}{k:>3}  {100*k/max(len(grids),1):4.0f}%")

    # ── 5. density ───────────────────────────────────────────────────────────
    h("5. HOW FULL — density arc")
    dens = []
    for r, g in grids:
        d = np.sum([g[s] for s in STEMS if s in g], axis=0)
        dens.append(d)
    if dens:
        print(f"  {'':>10}{'start':>8}{'peak':>7}{'floor':>7}{'end':>6}")
        f = lambda fn: st.median(fn(d) for d in dens)
        mid = lambda d: d[max(1, len(d)//8):-max(1, len(d)//8)] if len(d) > 4 else d
        print(f"  {'median':>10}{f(lambda d: d[0]):>8.1f}{f(max):>7.1f}"
              f"{f(lambda d: min(mid(d))):>7.1f}{f(lambda d: d[-1]):>6.1f}")
        print("\n  share of the record at each part-count:")
        mx = max(int(d.max()) for d in dens)
        for k in range(1, mx + 1):
            share = st.median(100 * (d == k).mean() for d in dens)
            print(f"    {k} parts {share:>6.0f}%  {'#'*int(share/1.5)}")
        print("\n  'floor' ignores the first and last eighth, so it is the")
        print("  breakdown rather than the intro or the outro.")

    # ── 6. openings ──────────────────────────────────────────────────────────
    h("6. WHAT A RECORD OPENS AND CLOSES WITH")
    op = collections.Counter(tuple(sorted(s for s in STEMS if s in g and g[s][0]))
                             for _, g in grids)
    cl = collections.Counter(tuple(sorted(s for s in STEMS if s in g and g[s][-1]))
                             for _, g in grids)
    for label, cnt in (("OPENS", op), ("CLOSES", cl)):
        print(f"\n  {label}:")
        for combo, k in cnt.most_common(6):
            print(f"    {('+'.join(combo) or 'silence'):<40}{k:>3}"
                  f"  {100*k/max(len(grids),1):4.0f}%")


if __name__ == "__main__":
    main()
