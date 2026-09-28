#!/usr/bin/env python3
"""
tag-ml.py — genre, mood and vibe tags for the library, from pretrained models.

WHY THIS AND NOT AN API: MusicBrainz has the releases but returns EMPTY genre
tags for every one of these artists (tested). Discogs has the vocabulary but
needs a token and only covers commercial releases. These models ARE the Discogs
taxonomy -- 400 genre classes -- applied to the audio itself, so they work on
anything, including a track that was never catalogued.

Models: MTG/UPF EffnetDiscogs embeddings + classification heads.
⚠️ LICENCE: Essentia is AGPL-3.0 and these model weights are CC BY-NC-SA 4.0 --
NON-COMMERCIAL. Fine for a personal library. If any of this ever touches paid
client work, that is the first question, not the last.

Usage: python3 tag-ml.py --dir influences [--n 0] [--out ml-tags.json]
"""
import argparse, json, warnings
from pathlib import Path
warnings.filterwarnings("ignore")
import numpy as np
from essentia.standard import MonoLoader, TensorflowPredictEffnetDiscogs, TensorflowPredict2D

HERE = Path(__file__).parent; M = HERE / "models"
EMB = TensorflowPredictEffnetDiscogs(graphFilename=str(M/"discogs-effnet-bs64-1.pb"), output="PartitionedCall:1")
def head(pb):
    """Node names differ between the model families: genre_discogs400 was frozen
    with the TF2 serving signature, the mood/binary heads with the older graph
    naming. Try both rather than hardcode one and guess wrong."""
    # Three different graph signatures across the model families, probed from the
    # frozen graphs rather than assumed: genre_discogs400 uses the TF2 serving
    # signature; the multi-label moodtheme head ends in Sigmoid; the 2-class
    # binary heads end in Softmax.
    for i, o in (("serving_default_model_Placeholder", "PartitionedCall:0"),
                 ("model/Placeholder", "model/Sigmoid"),
                 ("model/Placeholder", "model/Softmax")):
        try:
            return TensorflowPredict2D(graphFilename=str(M/pb), input=i, output=o)
        except RuntimeError:
            continue
    raise RuntimeError(f"no known node names matched {pb}")
GENRE, GENRE_C = head("genre_discogs400-discogs-effnet-1.pb"), json.load(open(M/"genre_discogs400-discogs-effnet-1.json"))["classes"]
MOOD,  MOOD_C  = head("mtg_jamendo_moodtheme-discogs-effnet-1.pb"), json.load(open(M/"mtg_jamendo_moodtheme-discogs-effnet-1.json"))["classes"]
BINARY = {n: head(f"{n}-discogs-effnet-1.pb") for n in
          ("danceability","mood_happy","mood_relaxed","mood_aggressive","mood_sad")}

def tag(path):
    audio = MonoLoader(filename=str(path), sampleRate=16000, resampleQuality=4)()
    if len(audio) < 16000 * 20: return None
    e = EMB(audio)
    g = GENRE(e).mean(axis=0); m = MOOD(e).mean(axis=0)
    out = {
        "genres": [{"tag": GENRE_C[i].split("---")[-1], "top": GENRE_C[i].split("---")[0],
                    "p": round(float(g[i]), 3)} for i in np.argsort(g)[::-1][:5]],
        "moods":  [{"tag": MOOD_C[i], "p": round(float(m[i]), 3)} for i in np.argsort(m)[::-1][:6]],
    }
    # 🔴 THE CLASS ORDER IS NOT THE SAME FOR ALL FIVE HEADS, and there is no
    # metadata JSON shipped with these .pb files to read it from. Assuming
    # "index 0 is the positive class" was right for danceability, mood_happy and
    # mood_aggressive and WRONG for mood_relaxed and mood_sad, which list the
    # negative class first. Caught by testing against tracks whose character is
    # not in doubt: guided sleep meditations scored 0.032 on "relaxed" while
    # techno scored 0.796. See fix-mood-polarity.py.
    NEG_FIRST = {"mood_relaxed", "mood_sad"}
    for n, h in BINARY.items():
        v = float(h(e).mean(axis=0)[0])
        out[n] = round(1.0 - v if n in NEG_FIRST else v, 3)
    return out

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="influences"); ap.add_argument("--n", type=int, default=0)
    ap.add_argument("--out", default="data/ml-tags.json")
    a = ap.parse_args()
    files = sorted((HERE / a.dir).rglob("*.opus"))
    if a.n: files = files[::max(len(files)//a.n, 1)][:a.n]
    outp = HERE / a.out
    tags = json.load(open(outp)) if outp.exists() else {}
    todo = [f for f in files if str(f.relative_to(HERE)) not in tags]
    print(f"{len(files)} files · {len(tags)} tagged · {len(todo)} to do")
    for i, f in enumerate(todo, 1):
        try:
            r = tag(f)
            if r:
                tags[str(f.relative_to(HERE))] = r
                gs = "/".join(x["tag"] for x in r["genres"][:2])
                ms = "/".join(x["tag"] for x in r["moods"][:3])
                print(f"  [{i}/{len(todo)}] {gs:28} | {ms:26} | dance {r['danceability']:.2f} relax {r['mood_relaxed']:.2f} | {f.name[:32]}")
        except Exception as ex:
            print(f"  [{i}/{len(todo)}] FAILED {f.name[:40]}: {type(ex).__name__}")
        if i % 10 == 0: json.dump(tags, open(outp, "w"), indent=1)
    json.dump(tags, open(outp, "w"), indent=1)
    print(f"wrote {outp}")
