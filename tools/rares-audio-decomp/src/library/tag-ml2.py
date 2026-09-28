#!/usr/bin/env python3
"""
tag-ml2.py — the second-generation tagging pass. One embedding, five answers.

WHAT CHANGED FROM tag-ml.py, and why each change exists
───────────────────────────────────────────────────────
`tag-ml.py` computes a 1280-d Discogs-EffNet embedding per track — which is
~95% of the wall time — runs seven cheap heads off it, writes five genre tags,
and **throws the embedding away.** Three consequences, all fixed here:

1. **INSTRUMENTS.** Adds the MTG-Jamendo *instrument* head (40 classes:
   piano, electricpiano, rhodes, organ, synthesizer, pad, strings, brass,
   voice, …). `explore.py` states as its honest limit that "nothing in the
   current model set can hear a piano" and infers jazzy-piano from genre tags.
   This is the direct fix: the classifier is another 2.7 MB head on an
   embedding we are already paying for.

2. **TOP 20 GENRES, NOT TOP 5.** The Discogs-400 vocabulary carries a ~60-tag
   jazz/soul/funk taxonomy. Storing five tags discarded 395 of 400 numbers at
   write time, and the interesting ones — Neo Soul, Jazz-Funk, Nu-Disco,
   Deep House — routinely sit at ranks 6-15 on a track whose top 5 are all
   coarse Electronic labels.

3. **THE EMBEDDING IS PERSISTED** to `data/embeddings.npz`, keyed by the same
   relative path used in the JSON. That makes nearest-neighbour search
   ("more tracks that sound like this") a cosine distance instead of a
   re-run. See `similar.py`.

⚠️ LICENCE — NON-COMMERCIAL, and it is load-bearing
   Essentia is AGPL-3.0. **Every MTG model here is CC BY-NC-SA 4.0**, stated
   at https://essentia.upf.edu/models.html: "All the models created by the MTG
   are licensed under CC BY-NC-SA 4.0 and are also available under proprietary
   license upon request." That covers discogs-effnet, genre_discogs400, the
   moodtheme head, the five binary heads AND the new instrument head.
   Fine for a personal library. **If any output of this ever touches paid
   client work, that is the first question, not the last.**

⚠️ THE INSTRUMENT MODEL IS THE WEAKEST OF THE SET. Its own metadata reports
   **test PR-AUC 0.20 / ROC-AUC 0.78** on 25,135 tracks — respectable ranking,
   poor calibration. So: **read it as a ranking, never as a probability.**
   "piano = 0.31" does not mean 31% confidence; it means this track sits high
   in the piano ordering relative to the rest of the library. Every threshold
   in `instrument-census.md` is a library percentile, not an absolute.

CPU: single process on purpose. Other analysis may be running. Run it under
`nice -n 10` and let it take the time it takes.

Usage:
  nice -n 10 python3 tag-ml2.py --dir audio       --out data/ml-tags2-playlist.json
  nice -n 10 python3 tag-ml2.py --dir influences  --out data/ml-tags2-influences.json
  nice -n 10 python3 tag-ml2.py --all             # both, one process, models loaded once
"""
import argparse
import json
import os
import time
import warnings
from pathlib import Path

# Silence TensorFlow before it is imported by essentia. A previous tagging run
# in this project wrote 770 MB of TF INFO spam into a log file.
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
os.environ.setdefault("TF_ENABLE_ONEDNN_OPTS", "0")
# Be a good neighbour: this box is an M1 Pro (10 cores) and other analysis jobs
# may be running. Cap TF's thread pools rather than letting it take everything.
os.environ.setdefault("OMP_NUM_THREADS", "4")
os.environ.setdefault("TF_NUM_INTRAOP_THREADS", "4")
os.environ.setdefault("TF_NUM_INTEROP_THREADS", "1")
warnings.filterwarnings("ignore")

import numpy as np  # noqa: E402
import essentia  # noqa: E402
from essentia.standard import (  # noqa: E402
    MonoLoader,
    TensorflowPredictEffnetDiscogs,
    TensorflowPredict2D,
)

# Essentia's own per-frame INFO logging is the other half of the noise.
essentia.log.infoActive = False
essentia.log.warningActive = False

HERE = Path(__file__).parent
M = HERE / "models"
N_GENRES = 20   # was 5 in tag-ml.py
N_MOODS = 8

EMB = TensorflowPredictEffnetDiscogs(
    graphFilename=str(M / "discogs-effnet-bs64-1.pb"), output="PartitionedCall:1")


def head(pb):
    """Node names differ between the model families — probed from the frozen
    graphs rather than assumed. genre_discogs400 uses the TF2 serving
    signature; the multi-label heads (moodtheme, instrument) end in Sigmoid;
    the 2-class binary heads end in Softmax."""
    for i, o in (("serving_default_model_Placeholder", "PartitionedCall:0"),
                 ("model/Placeholder", "model/Sigmoid"),
                 ("model/Placeholder", "model/Softmax")):
        try:
            return TensorflowPredict2D(graphFilename=str(M / pb), input=i, output=o)
        except RuntimeError:
            continue
    raise RuntimeError(f"no known node names matched {pb}")


def classes(js):
    return json.load(open(M / js))["classes"]


GENRE = head("genre_discogs400-discogs-effnet-1.pb")
GENRE_C = classes("genre_discogs400-discogs-effnet-1.json")
MOOD = head("mtg_jamendo_moodtheme-discogs-effnet-1.pb")
MOOD_C = classes("mtg_jamendo_moodtheme-discogs-effnet-1.json")
INST = head("mtg_jamendo_instrument-discogs-effnet-1.pb")
INST_C = classes("mtg_jamendo_instrument-discogs-effnet-1.json")
BINARY = {n: head(f"{n}-discogs-effnet-1.pb") for n in
          ("danceability", "mood_happy", "mood_relaxed", "mood_aggressive", "mood_sad")}

# 🔴 CLASS ORDER IS NOT THE SAME FOR ALL FIVE BINARY HEADS and no metadata JSON
# ships with those .pb files. Index 0 is the positive class for danceability,
# mood_happy and mood_aggressive, and the NEGATIVE class for mood_relaxed and
# mood_sad. Stored inverted until 5 Aug 2026; fixed in tag-ml.py and carried
# here. Do not double-flip: a fresh run through this file is already correct.
NEG_FIRST = {"mood_relaxed", "mood_sad"}


def tag(path):
    audio = MonoLoader(filename=str(path), sampleRate=16000, resampleQuality=4)()
    if len(audio) < 16000 * 20:
        return None, None
    e = EMB(audio)                      # (frames, 1280) — the expensive part
    emb = e.mean(axis=0).astype(np.float32)
    g = GENRE(e).mean(axis=0)
    m = MOOD(e).mean(axis=0)
    ins = INST(e).mean(axis=0)
    out = {
        "genres": [{"tag": GENRE_C[i].split("---")[-1],
                    "top": GENRE_C[i].split("---")[0],
                    "p": round(float(g[i]), 4)}
                   for i in np.argsort(g)[::-1][:N_GENRES]],
        "moods": [{"tag": MOOD_C[i], "p": round(float(m[i]), 4)}
                  for i in np.argsort(m)[::-1][:N_MOODS]],
        # All 40 instrument classes kept — the vocabulary is small enough that
        # truncating it would repeat exactly the mistake this pass exists to fix.
        "instruments": {INST_C[i]: round(float(ins[i]), 4)
                        for i in np.argsort(ins)[::-1]},
    }
    for n, h in BINARY.items():
        v = float(h(e).mean(axis=0)[0])
        out[n] = round(1.0 - v if n in NEG_FIRST else v, 4)
    return out, emb


META = {
    "_polarity_corrected": True,   # mood_relaxed / mood_sad — see NEG_FIRST above
    "_schema": 2,
    "_n_genres": N_GENRES,
    "_instrument_model": "mtg_jamendo_instrument-discogs-effnet-1",
    "_licence": "CC BY-NC-SA 4.0 (non-commercial) — all MTG models; Essentia AGPL-3.0",
}


def save(tags, outp, embs, embp):
    tags.update(META)
    json.dump(tags, open(outp, "w"), indent=1)
    if embs:
        np.savez_compressed(embp, **embs)


def run(subdir, out, embfile, limit=0):
    files = sorted((HERE / subdir).rglob("*.opus"))
    if limit:
        files = files[:limit]
    outp, embp = HERE / out, HERE / embfile
    tags = json.load(open(outp)) if outp.exists() else {}
    embs = dict(np.load(embp)) if embp.exists() else {}
    todo = [f for f in files
            if str(f.relative_to(HERE)) not in tags
            or str(f.relative_to(HERE)) not in embs]
    print(f"\n=== {subdir}: {len(files)} files · "
          f"{len([k for k in tags if not k.startswith('_')])} tagged · {len(todo)} to do",
          flush=True)
    t0 = time.time()
    for i, f in enumerate(todo, 1):
        rel = str(f.relative_to(HERE))
        try:
            r, emb = tag(f)
            if r:
                tags[rel] = r
                embs[rel] = emb
                top_inst = [k for k, v in list(r["instruments"].items())[:3]]
                gs = "/".join(x["tag"] for x in r["genres"][:2])
                el = (time.time() - t0) / i
                print(f"  [{i}/{len(todo)}] {el:4.1f}s/tr {gs:26} | "
                      f"{'/'.join(top_inst):30} | piano {r['instruments']['piano']:.3f} "
                      f"ep {r['instruments']['electricpiano']:.3f} | {f.name[:30]}",
                      flush=True)
            else:
                print(f"  [{i}/{len(todo)}] SKIP (<20s) {f.name[:40]}", flush=True)
        except Exception as ex:
            print(f"  [{i}/{len(todo)}] FAILED {f.name[:40]}: {type(ex).__name__}: {ex}",
                  flush=True)
        if i % 10 == 0:
            save(tags, outp, embs, embp)
    save(tags, outp, embs, embp)
    print(f"wrote {outp} ({len(tags)-len(META)} tracks) and {embp} "
          f"({len(embs)} vectors) in {time.time()-t0:.0f}s", flush=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=None)
    ap.add_argument("--out", default=None)
    ap.add_argument("--emb", default="data/embeddings.npz")
    ap.add_argument("--n", type=int, default=0, help="limit, for smoke tests")
    ap.add_argument("--all", action="store_true",
                    help="audio/ then influences/, one process, models loaded once")
    a = ap.parse_args()
    jobs = ([("audio", "data/ml-tags2-playlist.json"),
             ("influences", "data/ml-tags2-influences.json")] if a.all
            else [(a.dir, a.out)])
    for d, o in jobs:
        run(d, o, a.emb, a.n)
