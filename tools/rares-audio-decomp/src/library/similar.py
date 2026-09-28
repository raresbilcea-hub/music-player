#!/usr/bin/env python3
"""
similar.py — "find me more tracks that sound like this", over the whole library.

WHAT THIS IS. `tag-ml2.py` persists the mean 1280-d Discogs-EffNet embedding of
every track to `data/embeddings.npz`. That embedding is what the genre, mood and
instrument heads are all reading — it is the model's compressed opinion of what
a track *is*. Cosine distance in that space is therefore a far better "sounds
like" than any tag comparison, because it uses all 1280 dimensions instead of
the handful that survived being projected onto a 400-word vocabulary.

WHY IT MATTERS HERE. Paul's actual question was *"there are more things like
'jazzy piano' in my library, I just want to know what they are."* `explore.py`
answers a generalisation of it via genre tags; the instrument head answers the
literal version. **This answers the version he can act on**: point it at the one
track he already loves and get the fourteen nearest things he owns.

THE HONEST LIMIT. EffNet-Discogs was trained on editorial metadata (artist,
label, release), so its neighbourhoods encode *scene* as much as *sound*: two
tracks on the same label with the same producer will sit close even if they
differ musically. Read a result as "same corner of music", not "same texture".
Cross-check anything surprising by ear — that has always been the arrangement.

⚠️ The embeddings come from CC BY-NC-SA 4.0 (non-commercial) MTG models.

Usage
  python3 similar.py "Nightmare"            # title substring, playlist + influences
  python3 similar.py 5Kh6nZq3TZs -n 20      # by YouTube id
  python3 similar.py "A Man" --source playlist
  python3 similar.py "Rhodes" --centroid    # average several matches, search near that
  python3 similar.py --instrument piano     # no query: rank the library by one tag
  python3 similar.py --list "burridge"      # just resolve, don't search
"""
import argparse
import json
import pathlib
import sys

import numpy as np

HERE = pathlib.Path(__file__).parent
DATA = HERE / "data"
EMB_FILE = DATA / "embeddings.npz"


# ── names ───────────────────────────────────────────────────────────────────
def names():
    """key_path -> (source, artist, title). Same join `explore.py` does, kept
    here so this file stands alone and can be run before/without pandas."""
    titles = json.loads((DATA / "titles.json").read_text())
    try:
        pl = json.loads((DATA / "playlist-full.json").read_text())
        uploader = {e["id"]: (e.get("uploader") or e.get("channel") or "")
                    for e in pl.get("entries", []) if e}
    except Exception:
        uploader = {}
    out = {}

    def add(key):
        stem = key.split("/")[-1].replace(".opus", "")
        if key.startswith("influences/"):
            parts = key[len("influences/"):].split("/")
            out[key] = ("influences",
                        parts[-2] if len(parts) > 1 else "",
                        parts[-1].replace(".opus", ""))
        else:
            out[key] = ("playlist",
                        uploader.get(stem, "").replace(" - Topic", ""),
                        titles.get(stem, {}).get("title", stem))
    return add, out


def load(source=None):
    """Returns (keys, unit-normalised matrix, meta dict)."""
    if not EMB_FILE.exists():
        sys.exit(f"no embeddings at {EMB_FILE} — run:  nice -n 10 python3 tag-ml2.py --all")
    z = np.load(EMB_FILE)
    keys = sorted(z.files)
    add, meta = names()
    for k in keys:
        add(k)
    if source:
        keys = [k for k in keys if meta[k][0] == source]
    X = np.stack([z[k] for k in keys]).astype(np.float32)
    X /= (np.linalg.norm(X, axis=1, keepdims=True) + 1e-9)
    return keys, X, meta


def resolve(query, keys, meta):
    """A track id, a full key path, or a case-insensitive substring of the
    title / artist / path. Returns every match — the caller decides."""
    q = query.lower()
    exact = [k for k in keys if k == query
             or k.split("/")[-1].replace(".opus", "") == query]
    if exact:
        return exact
    return [k for k in keys
            if q in k.lower() or q in meta[k][2].lower() or q in meta[k][1].lower()]


def label(k, meta, width=46):
    src, artist, title = meta[k]
    tag = "PL" if src == "playlist" else "IN"
    a = f"  · {artist[:22]}" if artist else ""
    return f"[{tag}] {title[:width]:<{width}}{a}"


# ── the two queries ─────────────────────────────────────────────────────────
def nearest(vec, keys, X, exclude=(), n=15):
    sims = X @ (vec / (np.linalg.norm(vec) + 1e-9))
    order = np.argsort(sims)[::-1]
    out = []
    for i in order:
        if keys[i] in exclude:
            continue
        out.append((float(sims[i]), keys[i]))
        if len(out) >= n:
            break
    return out


def by_instrument(tag, source=None, n=25):
    """No embedding involved — straight ranking on one instrument head output.
    Lives here because it is the other half of the same question."""
    rows = []
    for f in ("ml-tags2-playlist.json", "ml-tags2-influences.json"):
        p = DATA / f
        if not p.exists():
            continue
        for k, v in json.loads(p.read_text()).items():
            if k.startswith("_") or "instruments" not in v:
                continue
            if tag not in v["instruments"]:
                sys.exit(f"unknown instrument '{tag}'. "
                         f"try one of: {', '.join(sorted(v['instruments']))}")
            rows.append((v["instruments"][tag], k))
    add, meta = names()
    for _, k in rows:
        add(k)
    if source:
        rows = [r for r in rows if meta[r[1]][0] == source]
    rows.sort(reverse=True)
    return rows[:n], meta


def main():
    ap = argparse.ArgumentParser(description="nearest neighbours in EffNet space")
    ap.add_argument("query", nargs="?", help="track id, key path, or title substring")
    ap.add_argument("-n", type=int, default=15)
    ap.add_argument("--source", choices=["playlist", "influences"],
                    help="restrict the RESULTS to one population")
    ap.add_argument("--centroid", action="store_true",
                    help="average all matching seeds and search near the average")
    ap.add_argument("--instrument", help="rank by one instrument tag instead")
    ap.add_argument("--list", dest="just_list", action="store_true")
    a = ap.parse_args()

    if a.instrument:
        rows, meta = by_instrument(a.instrument, a.source, a.n)
        print(f"\n  top {len(rows)} by '{a.instrument}' "
              f"(ranking, NOT a calibrated probability — PR-AUC 0.20)\n")
        for p, k in rows:
            print(f"  {p:.3f}  {label(k, meta)}")
        return

    if not a.query:
        ap.error("give a query, or use --instrument")

    all_keys, all_X, meta = load()
    seeds = resolve(a.query, all_keys, meta)
    if not seeds:
        sys.exit(f"nothing matches {a.query!r}")
    if a.just_list or (len(seeds) > 1 and not a.centroid):
        print(f"\n  {len(seeds)} match {a.query!r}:")
        for k in seeds[:40]:
            print(f"    {label(k, meta)}   ({k})")
        if a.just_list:
            return
        if len(seeds) > 1:
            print("\n  more than one seed — using the FIRST. "
                  "Pass an id, or --centroid to average them.\n")
    idx = {k: i for i, k in enumerate(all_keys)}
    if a.centroid:
        vec = all_X[[idx[k] for k in seeds]].mean(axis=0)
        head = f"centroid of {len(seeds)} tracks matching {a.query!r}"
    else:
        vec = all_X[idx[seeds[0]]]
        head = label(seeds[0], meta).strip()

    keys, X = all_keys, all_X
    if a.source:
        sel = [i for i, k in enumerate(all_keys) if meta[k][0] == a.source]
        keys, X = [all_keys[i] for i in sel], all_X[sel]

    print(f"\n  nearest to  {head}\n")
    for s, k in nearest(vec, keys, X, exclude=set(seeds), n=a.n):
        print(f"  {s:.3f}  {label(k, meta)}")
    print()


if __name__ == "__main__":
    main()
