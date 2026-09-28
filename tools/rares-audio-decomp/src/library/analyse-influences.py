#!/usr/bin/env python3
"""
analyse-influences.py — point the feature extractor at THE LANE.

WHY THIS EXISTS. `analyse.py` has only ever been run over `library/audio/` —
the 656-track broad favourites playlist, which also contains guided meditations
and affirmation recordings. The 504 tracks in `library/influences/` — the lane
Paul is actually trying to write in — have ML genre/mood tags and durations but
**no audio features at all**. Every "his taste" production target in PLAYBOOK
§7b (density 4.6 onsets/sec, the eta² analysis, the segmented house targets) was
therefore computed from the wrong population. This closes that.

WHAT IT DOES DIFFERENTLY FROM `analyse.py`, and why each difference exists:

 1. It imports `analyse.py`'s own functions rather than reimplementing them.
    The whole point is a like-for-like comparison against `tags.json`; a
    reimplementation would put a method difference inside every delta.

 2. It ALSO runs Essentia's `KeyExtractor(profileType='edma')`. STATUS.md:
    Essentia's default `bgate` and the tutorial-favourite `temperley` are both
    wrong for house. `analyse.py`'s hand-rolled bass-band Krumhansl-Schmuckler
    key is kept as `key` so the join against `tags.json` stays apples-to-apples;
    the edma answer is stored ALONGSIDE as `key_edma`. Two columns, no silent
    substitution — and the agreement rate between them is itself a measurement.

 3. It is keyed by the path relative to `influences/`, e.g.
    `ADID roster/Gorje Hewek/A Man.opus` — the same key `durations.json` uses
    and the same one `explore.py:load()` derives (it strips the `influences/`
    prefix off the ml-tags keys). `id` is the stem, as in `explore.py`.

 4. `energy` is a WITHIN-COLLECTION rank, exactly as in `analyse.py:report()`.
    That means influence-energy and playlist-energy are NOT comparable numbers —
    each is a rank inside its own population. Stated here so nobody compares
    them later.

CPU: one process, no workers. Run it under `nice`.

Usage:  python3 analyse-influences.py                 # the influences pass
        python3 analyse-influences.py --playlist-edma 200
              # re-key a random 200 of the PLAYLIST with edma too, so the key
              # comparison between populations is method-matched rather than
              # confounded. Writes data/playlist-edma-sample.json.
"""
import json
import os
import random
import subprocess
import sys
import tempfile
import time
from pathlib import Path

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
os.environ.setdefault("PYTHONWARNINGS", "ignore")

import warnings
warnings.filterwarnings("ignore")

import numpy as np
import soundfile as sf

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import analyse as A                                    # noqa: E402  the source of truth

import essentia                                        # noqa: E402
essentia.log.infoActive = False                        # 770 MB of INFO once. Never again.
essentia.log.warningActive = False
import essentia.standard as es                         # noqa: E402

DATA = HERE / "data"
INF = HERE / "influences"
OUT = DATA / "tags-influences.json"
KEY_SR = 44100

_key_extractor = es.KeyExtractor(profileType="edma", sampleRate=KEY_SR)


def decode(path, sr, seconds=180, skip=30):
    """Same window as analyse.py: 3 minutes starting 30 s in."""
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as t:
        tmp = t.name
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", str(skip), "-t", str(seconds),
                    "-i", str(path), "-ac", "1", "-ar", str(sr), tmp],
                   check=True, capture_output=True)
    x, _ = sf.read(tmp)
    Path(tmp).unlink(missing_ok=True)
    return x


def edma_key(path):
    """Essentia KeyExtractor with the EDM-A profile. Returns (key, strength)."""
    x = decode(path, KEY_SR).astype(np.float32)
    if len(x) < KEY_SR * 5:
        return "?", 0.0
    k, scale, strength = _key_extractor(x)
    return f"{k}{'m' if scale == 'minor' else ''}", float(strength)


def analyse_one(path):
    r = A.analyse(path)                                # identical code path to tags.json
    if not r:
        return None
    for k, v in list(r.items()):                       # numpy scalars -> json-safe
        if isinstance(v, (np.floating, np.integer)):
            r[k] = float(v)
    try:
        ke, se = edma_key(path)
    except Exception:
        ke, se = "?", 0.0
    r["key_edma"] = ke
    r["camelot_edma"] = A.camelot(ke)
    r["key_edma_strength"] = round(se, 3)
    return r


def main():
    durations = {}
    dp = DATA / "durations.json"
    if dp.exists():
        durations = json.loads(dp.read_text())

    tags = json.loads(OUT.read_text()) if OUT.exists() else {}
    files = sorted(INF.rglob("*.opus"))
    todo = [f for f in files if str(f.relative_to(INF)) not in tags]
    print(f"{len(files)} influence tracks · {len(tags)} already done · {len(todo)} to do",
          flush=True)

    t0 = time.time()
    for i, f in enumerate(todo, 1):
        rel = str(f.relative_to(INF))
        try:
            r = analyse_one(f)
            if not r:
                print(f"  [{i}/{len(todo)}] TOO SHORT {rel}", flush=True)
                continue
            parts = rel.split("/")
            r["id"] = f.stem
            r["title"] = f.stem
            r["artist"] = parts[-2] if len(parts) > 1 else ""
            r["collection"] = parts[0] if len(parts) > 1 else ""
            r["duration_s"] = durations.get(rel)
            tags[rel] = r
            el = time.time() - t0
            print(f"  [{i}/{len(todo)}] {r['tempo']:5.1f} BPM  {r['key']:>3s}/"
                  f"{r['key_edma']:>3s}  d{r['density']:4.1f}  {rel[:58]}"
                  f"   [{el/i:.1f}s/tk, {(len(todo)-i)*el/i/60:.0f}m left]", flush=True)
        except Exception as e:
            print(f"  [{i}/{len(todo)}] FAILED {rel}: {type(e).__name__}: {e}", flush=True)
        if i % 10 == 0:
            OUT.write_text(json.dumps(tags, indent=1))

    # energy: within-collection rank, same formula as analyse.py:report()
    v = list(tags.values())
    raw = np.array([t["density"] for t in v]) * np.array([t["weight"] for t in v]) ** 0.4
    rank = raw.argsort().argsort() / max(len(raw) - 1, 1)
    for t, e in zip(v, rank):
        t["energy"] = int(round(1 + e * 9))
    OUT.write_text(json.dumps(tags, indent=1))
    print(f"\nwrote {OUT}  ({len(tags)} tracks, {(time.time()-t0)/60:.1f} min)")


def playlist_edma(n):
    """Method-matched control: re-key a random sample of the PLAYLIST with edma,
    so any key-distribution difference between the two populations can be
    attributed to the music rather than to two different key algorithms."""
    out = DATA / "playlist-edma-sample.json"
    done = json.loads(out.read_text()) if out.exists() else {}
    files = sorted((HERE / "audio").glob("*.opus"))
    random.Random(0).shuffle(files)
    todo = [f for f in files[:n] if f.stem not in done]
    print(f"playlist edma control: {n} sampled · {len(todo)} to do", flush=True)
    for i, f in enumerate(todo, 1):
        try:
            k, s = edma_key(f)
            done[f.stem] = {"key_edma": k, "camelot_edma": A.camelot(k),
                            "key_edma_strength": round(s, 3)}
            print(f"  [{i}/{len(todo)}] {k:>3s}  {f.stem}", flush=True)
        except Exception as e:
            print(f"  [{i}/{len(todo)}] FAILED {f.stem}: {type(e).__name__}", flush=True)
        if i % 10 == 0:
            out.write_text(json.dumps(done, indent=1))
    out.write_text(json.dumps(done, indent=1))
    print(f"wrote {out} ({len(done)})")


if __name__ == "__main__":
    if "--playlist-edma" in sys.argv:
        playlist_edma(int(sys.argv[sys.argv.index("--playlist-edma") + 1]))
    else:
        main()
