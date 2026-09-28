#!/usr/bin/env python3
"""
tag-one.py — run the library's own ML tagger against a SINGLE file.

WHY. `GENRE = "Organic House"` in `release.py` was asserted, never measured.
Paul asked the obvious question — "is the genre of this track really organic
house? How about you get our ML pipeline to analyze it and see what it says?"
The Discogs-400 classifier that tagged all 1,139 library tracks is sitting on
disk and had never once been pointed at our own record.

Same models, same preprocessing as `tag-ml2.py`, so the numbers are directly
comparable to every tag in `data/tags*.json`.

⚠️ READ IT AS A RANKING, NOT A PROBABILITY. The Discogs-400 head is trained on
Discogs release genres/styles, and its calibration is poor. "Deep House 0.21"
means this track sits high in the deep-house ordering, not that there is a 21%
chance it is deep house.

⚠️ AND IT HAS NEVER HEARD ORGANIC HOUSE. The Discogs-400 vocabulary is fixed
and predates the label's popularisation; "Organic House" is not one of the 400
classes. So the classifier structurally CANNOT return it, and its absence from
the output is not evidence. What the ranking can tell us is which of the
genres it DOES know our record sits nearest to.

Run: /Users/paul/miniconda3/bin/python3 library/tag-one.py <file> [--top 20]
"""
import argparse
import json
from pathlib import Path

M = Path(__file__).parent / "models"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--top", type=int, default=20)
    a = ap.parse_args()

    from essentia.standard import (MonoLoader, TensorflowPredict2D,
                                   TensorflowPredictEffnetDiscogs)
    import numpy as np

    audio = MonoLoader(filename=a.path, sampleRate=16000, resampleQuality=4)()
    emb = TensorflowPredictEffnetDiscogs(
        graphFilename=str(M / "discogs-effnet-bs64-1.pb"),
        output="PartitionedCall:1")(audio)

    meta = json.load(open(M / "genre_discogs400-discogs-effnet-1.json"))
    head = TensorflowPredict2D(
        graphFilename=str(M / "genre_discogs400-discogs-effnet-1.pb"),
        input="serving_default_model_Placeholder",
        output="PartitionedCall:0")
    pred = head(emb).mean(axis=0)
    classes = meta["classes"]

    order = np.argsort(pred)[::-1]
    print(f"\n{Path(a.path).name}\n{'-'*62}")
    for i in order[:a.top]:
        bar = "#" * int(pred[i] * 120)
        print(f"  {pred[i]:6.4f}  {classes[i]:<38} {bar}")

    # the house family specifically, wherever it ranks
    print(f"\n  WHERE THE HOUSE FAMILY LANDS (rank of 400)")
    rank = {c: int(np.where(order == j)[0][0]) + 1 for j, c in enumerate(classes)}
    for c in classes:
        if "House" in c or "Techno" in c or "Downtempo" in c or "Ambient" in c:
            j = classes.index(c)
            print(f"    #{rank[c]:<4} {pred[j]:6.4f}  {c}")


if __name__ == "__main__":
    main()
