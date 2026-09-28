#!/usr/bin/env python3
"""
lane-vs-playlist.py — the comparison the missing data was hiding.

`tags.json` = the 656-track PLAYLIST (broad favourites, and it contains guided
meditations and affirmation recordings). `tags-influences.json` = the 504-track
LANE (ADID roster, Lee Burridge, Solomun, RÜFÜS DU SOL, Tame Impala, Dope Lemon).

Every "his taste" production target in PLAYBOOK §7b was computed from the first
file. This scores both populations on the same features, with the same code, and
re-runs `segment.py`'s eta² logic against the lane to test whether density is
really the invariant.

⚠️ THE FOLDER IS NOT A RANKING OF TASTE. Artist counts in influences/ reflect
YouTube catalogue availability and the order a scraper ran in. His NAMED
influences are Lee Burridge / All Day I Dream, Solomun, Tame Impala, Dope Lemon.
It is a reasonable sample OF THE LANE, not a portrait of him.

Usage: python3 lane-vs-playlist.py
"""
import json
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
DATA = HERE / "data"
MIN_CLUSTER = 12
FEATS = ["tempo", "density", "brightness", "weight", "crest", "rms_db", "energy"]
HOUSE_WORDS = ("house", "techno", "deep", "progressive", "melodic", "downtempo",
               "ambient")
NAMED_HOUSE = ("ADID roster", "Lee Burridge", "Solomun", "RUFUS DU SOL")


def load():
    pl = json.loads((DATA / "tags.json").read_text())
    inf = json.loads((DATA / "tags-influences.json").read_text())
    titles = json.loads((DATA / "titles.json").read_text())
    mlp = json.loads((DATA / "ml-tags-playlist.json").read_text())
    mli = json.loads((DATA / "ml-tags-influences.json").read_text())

    prows = []
    for tid, t in pl.items():
        r = dict(t, id=tid, source="playlist")
        r["duration_s"] = titles.get(tid, {}).get("duration")
        m = mlp.get(f"audio/{tid}.opus") or mlp.get(tid) or {}
        g = m.get("genres", [])
        r["genre"] = g[0]["tag"] if g else None
        r["mood"] = m["moods"][0]["tag"] if m.get("moods") else None
        for k in ("danceability", "mood_happy", "mood_relaxed", "mood_sad",
                  "mood_aggressive"):
            r[k] = m.get(k)
        prows.append(r)

    irows = []
    for rel, t in inf.items():
        r = dict(t, source="influences", path=rel)
        m = mli.get(f"influences/{rel}") or {}
        g = m.get("genres", [])
        r["genre"] = g[0]["tag"] if g else None
        r["mood"] = m["moods"][0]["tag"] if m.get("moods") else None
        for k in ("danceability", "mood_happy", "mood_relaxed", "mood_sad",
                  "mood_aggressive"):
            r[k] = m.get(k)
        irows.append(r)
    return prows, irows


def pct(rows, f):
    v = np.array([r[f] for r in rows if r.get(f) is not None], dtype=float)
    if not len(v):
        return None
    return np.percentile(v, [10, 50, 90]), len(v)


def eta_squared(rows, feature, by="genre"):
    groups = defaultdict(list)
    for r in rows:
        v, g = r.get(feature), r.get(by)
        if v is not None and g:
            groups[g].append(float(v))
    groups = {k: np.array(v) for k, v in groups.items() if len(v) >= MIN_CLUSTER}
    if len(groups) < 2:
        return None, 0, 0
    allv = np.concatenate(list(groups.values()))
    grand = allv.mean()
    ssb = sum(len(v) * (v.mean() - grand) ** 2 for v in groups.values())
    sst = ((allv - grand) ** 2).sum()
    return (ssb / sst if sst else 0.0), len(groups), len(allv)


def rule(t):
    print(f"\n{'=' * 78}\n  {t}\n{'=' * 78}")


def table(pops, feats):
    print(f"  {'feature':12} " + "".join(f"{n[:22]:>26}" for n in pops))
    print(f"  {'':12} " + "".join(f"{'p10':>8}{'med':>9}{'p90':>9}" for _ in pops))
    for f in feats:
        line = f"  {f:12} "
        for _, rows in pops.items():
            p = pct(rows, f)
            line += (f"{p[0][0]:8.2f}{p[0][1]:9.2f}{p[0][2]:9.2f}" if p
                     else f"{'—':>26}")
        print(line)


def main():
    prows, irows = load()
    p_house = [r for r in prows
               if r.get("genre") and any(w in r["genre"].lower() for w in HOUSE_WORDS)]
    i_house = [r for r in irows if r.get("collection") in NAMED_HOUSE]
    i_guitar = [r for r in irows if r.get("collection") not in NAMED_HOUSE]

    rule("THE TWO POPULATIONS")
    print(f"  playlist            {len(prows):>4} tracks   (broad favourites; "
          f"includes meditations/affirmations)")
    print(f"    house-adjacent    {len(p_house):>4}   <- what PLAYBOOK §7b's segmented "
          f"targets were built from")
    print(f"  influences (LANE)   {len(irows):>4} tracks")
    print(f"    house collections {len(i_house):>4}   ADID roster, Lee Burridge, "
          f"Solomun, RÜFÜS DU SOL")
    print(f"    guitar/psych      {len(i_guitar):>4}   Tame Impala, Dope Lemon "
          f"— NOT house, and they move the averages")

    rule("FEATURE BY FEATURE — p10 / median / p90")
    table({"PLAYLIST (all)": prows, "INFLUENCES (all)": irows,
           "INF house only": i_house}, FEATS + ["duration_s"])
    print("\n  and the two sub-populations inside the lane:")
    table({"INF house": i_house, "INF guitar/psych": i_guitar}, FEATS)
    print("\n  ⚠️ `energy` is a WITHIN-population rank (analyse.py:report). The two")
    print("     energy columns are not on the same scale and must not be compared.")
    print("  ⚠️ `crest` and `rms_db` are near-mirror images here because the decode")
    print("     peaks at full scale on almost every track — check before treating")
    print("     them as two independent features.")

    rule("PLAYBOOK §7b — WHICH NUMBERS CHANGE")
    old = {"tempo": (120.2, 126.0, 132.5), "density": (3.634, 4.6, 5.776),
           "weight": (58.306, 76.86, 88.868), "crest": (8.9, 10.5, 12.78),
           "brightness": (0.37, 1.22, 2.916)}
    print(f"  {'feature':12} {'OLD (playlist house, 443)':>30}   "
          f"{'NEW (lane house, %d)' % len(i_house):>28}   Δmedian")
    for f, o in old.items():
        p = pct(i_house, f)
        if not p:
            continue
        n = p[0]
        d = n[1] - o[1]
        print(f"  {f:12} {o[0]:9.2f}{o[1]:9.2f}{o[2]:9.2f}   "
              f"{n[0]:9.2f}{n[1]:9.2f}{n[2]:9.2f}   {d:+8.2f}"
              f"  ({100*d/o[1]:+.0f}%)")

    rule("IS DENSITY THE INVARIANT? — eta² re-run ON THE LANE")
    print("  eta² = share of a feature's variance explained by its genre cluster.")
    print("  segment.py ran this on the PLAYLIST and got density 0.029 -> 'his taste'.\n")
    ETA = ["tempo", "density", "brightness", "weight", "crest", "rms_db", "energy",
           "danceability", "mood_relaxed", "mood_happy", "mood_sad", "mood_aggressive"]
    oldeta = json.loads((DATA / "segmentation.json").read_text())["eta_squared"]
    print(f"  {'feature':14} {'playlist eta²':>14} {'LANE eta²':>11} {'k':>4} {'n':>5}"
          f"   {'lane median':>12}  {'lane IQR':>14}")
    res = []
    for f in ETA:
        e, k, n = eta_squared(irows, f)
        if e is None:
            continue
        v = np.array([r[f] for r in irows if r.get(f) is not None], dtype=float)
        q1, q3 = np.percentile(v, [25, 75])
        res.append((e, f))
        print(f"  {f:14} {oldeta.get(f, float('nan')):14.3f} {e:11.3f} {k:4d} {n:5d}"
              f"   {np.median(v):12.2f}  {q1:6.2f}-{q3:<6.2f}")
    res.sort()
    print(f"\n  lane ranking, most invariant first: "
          f"{', '.join(f'{f} {e:.3f}' for e, f in res[:5])}")

    print("\n  GENRE CLUSTERS INSIDE THE LANE (>= %d tracks):" % MIN_CLUSTER)
    gc = Counter(r["genre"] for r in irows if r.get("genre"))
    for g, n in gc.most_common(12):
        sub = [r for r in irows if r.get("genre") == g]
        d = np.median([r["density"] for r in sub])
        t = np.median([r["tempo"] for r in sub])
        print(f"    {n:>4}  {g:<20} density {d:5.2f}   tempo {t:5.1f}"
              f"{'' if n >= MIN_CLUSTER else '   (below threshold)'}")

    print("\n  DENSITY, the direct test — is 4.6 the same number in both?")
    for lbl, rows in (("playlist all", prows), ("playlist house", p_house),
                      ("LANE all", irows), ("LANE house", i_house),
                      ("LANE guitar", i_guitar)):
        v = np.array([r["density"] for r in rows if r.get("density") is not None])
        print(f"    {lbl:16} n={len(v):>4}  median {np.median(v):5.2f}  "
              f"IQR {np.percentile(v,25):.2f}-{np.percentile(v,75):.2f}  "
              f"p10-p90 {np.percentile(v,10):.2f}-{np.percentile(v,90):.2f}  "
              f"CV {np.std(v)/np.mean(v):.3f}")

    rule("KEY — and the method caveat, which is bigger than the finding")
    agree = sum(1 for r in irows if r.get("key") == r.get("key_edma"))
    print(f"  analyse.py's bass-band Krumhansl-Schmuckler key and Essentia's edma key")
    print(f"  agree on {agree}/{len(irows)} lane tracks ({100*agree/len(irows):.0f}%).")
    pcam = Counter(r.get("key") for r in prows)
    icam = Counter(r.get("key") for r in irows)
    ecam = Counter(r.get("key_edma") for r in irows)
    sp = DATA / "playlist-edma-sample.json"
    pe = Counter(v["key_edma"] for v in json.loads(sp.read_text()).values()) if sp.exists() else None
    print(f"\n  {'key':6} {'PLAYLIST (KS)':>15} {'LANE (KS)':>12} {'LANE (edma)':>13}"
          + (f" {'PL sample (edma)':>18}" if pe else ""))
    allk = [k for k, _ in (icam + ecam).most_common(12)]
    for k in allk:
        line = (f"  {str(k):6} {100*pcam[k]/len(prows):14.1f}% "
                f"{100*icam[k]/len(irows):11.1f}% {100*ecam[k]/len(irows):12.1f}%")
        if pe:
            line += f" {100*pe[k]/sum(pe.values()):17.1f}%"
        print(line)
    for lbl, c, tot in (("playlist KS", pcam, len(prows)), ("lane KS", icam, len(irows)),
                        ("lane edma", ecam, len(irows))) + (
                        (("playlist edma sample", pe, sum(pe.values())),) if pe else ()):
        mn = sum(n for k, n in c.items() if k and k.endswith("m"))
        print(f"    {lbl:22} minor {100*mn/tot:.0f}%")

    rule("DURATION")
    for lbl, rows in (("playlist", prows), ("LANE", irows), ("LANE house", i_house)):
        v = np.array([r["duration_s"] for r in rows if r.get("duration_s")], dtype=float) / 60
        print(f"  {lbl:12} n={len(v):>4}  p10 {np.percentile(v,10):5.1f}  "
              f"median {np.median(v):5.1f}  p90 {np.percentile(v,90):5.1f} min")

    out = {
        "n_playlist": len(prows), "n_influences": len(irows),
        "n_influences_house": len(i_house), "n_influences_guitar": len(i_guitar),
        "percentiles": {
            pop: {f: (list(map(float, pct(rows, f)[0])) if pct(rows, f) else None)
                  for f in FEATS + ["duration_s"]}
            for pop, rows in (("playlist", prows), ("playlist_house", p_house),
                              ("influences", irows), ("influences_house", i_house),
                              ("influences_guitar", i_guitar))},
        "eta_squared_lane": {f: round(float(e), 4) for e, f in res},
        "eta_squared_playlist": oldeta,
        "key_method_agreement": round(agree / len(irows), 3),
    }
    (DATA / "lane-vs-playlist.json").write_text(json.dumps(out, indent=1))
    print(f"\nwrote {DATA / 'lane-vs-playlist.json'}")


if __name__ == "__main__":
    main()
