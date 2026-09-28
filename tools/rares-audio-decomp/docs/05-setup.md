# 05 — Setup

## Minimum, to run `decompose.py`

```bash
# ffmpeg must be on PATH — everything decodes through it, by design
brew install ffmpeg          # macOS
# apt install ffmpeg         # Debian/Ubuntu

pip install numpy soundfile
```

That is the whole hard dependency list. `decompose.py` will run with just this:
tempo, key (one estimator), chords, sections and bands all work. It will print a
warning where a better tool would have been used.

```bash
python3 decompose.py song.wav
python3 decompose.py song.wav --start 30 --dur 60 --json out.json
python3 decompose.py song.wav --stay 0.8       # fewer chord changes
python3 decompose.py song.wav --bpb 3          # 3/4 time
```

## Optional: Essentia

Gets you a real beat tracker (`RhythmExtractor2013`) and a second, independent
key estimator — and per lessons §1 the second key opinion is the point, not a
luxury.

```bash
pip install essentia          # or essentia-tensorflow for the ML models
```

**🔴 AGPL-3.0. Read `docs/04-licensing.md` before this goes anywhere near a
product.**

On the machine this was built on, Essentia lives under a miniconda install and
several scripts hardcode `/Users/paul/miniconda3/bin/python3` in their usage
lines. Ignore that; use your own interpreter.

## Optional: source separation

Not required by anything in this package, but **lessons §4 and Gap 1 both say it
is the highest-leverage thing you can add.**

```bash
uvx --with numpy demucs -d cpu -n htdemucs song.wav -o stems/
# -d mps on Apple silicon, -d cuda with an NVIDIA GPU
# -n htdemucs_6s splits piano and guitar out of `other`
```

`src/library/run-arrangement-study.sh` is a working batch driver for this,
including a gotcha worth reading: `demucs` inherits stdin from the loop, so a
naive `while read` loop silently consumes the file list. It redirects
`< /dev/null` to fix that.

## Optional: the ML tagging models

**✅ INCLUDED — all twelve files, 27 MB, in `models/`.** The full pipeline runs
with no downloads. `bash setup.sh` verifies they are all present.

⚠️ **They are CC BY-NC-SA 4.0 — non-commercial.** Bundled for evaluation, not as
a licence assessment for your product. `models/LICENCE-NOTICE.md` and
`docs/04-licensing.md`. If you need to re-fetch them, they come from
https://essentia.upf.edu/models.html.

---

## Running the `src/` scripts

**They will not run as-is.** Every one has hardcoded paths into a private 24 GB
library that is not in this zip:

| path they expect | what it was |
|---|---|
| `library/influences/` | ~2.9 GB, artist-foldered Opus rips |
| `library/inspo/stems/htdemucs/<track>/` | pre-separated stems, 4- or 6-stem |
| `library/audio/` | 3.3 GB of playlist tracks |
| `library/data/*.json` | cached results from previous runs |
| `library/models/*.pb` | the MTG model weights |

To use one, expect to change the path constants at the top of the file and the
`main()` corpus-iteration logic. **The methods inside the functions are the
reusable part** — `chroma_frames()`, `key_of()`, `chords_per_bar()`, the
harmonic-series pitch scorer in `survey.py`, the cache key in `beatcache.py`.

Several scripts have a `--selftest` or `--plan` mode that runs without a corpus.
`structure.py --selftest` proves its periodicity ladder works on synthetic
input, and is worth running just to see the habit.

---

## Verified working

Both of these were run while assembling this package, on macOS with
Python 3, numpy 2.0.1, Essentia installed, ffmpeg 7.x:

```
decompose.py "Baby I'm Yours.opus" --start 45 --dur 60
  → 117.45 BPM · key Dm (both estimators agree) · Dm9/Gm9/A#/A progression
  → matches an independent stem-derived analysis of the same track
  → 6.2 s wall clock

decompose.py pianobed-01.wav --dur 45
  → solo piano take · key F (both agree) · Gm9 → Dm → Fmaj9 → C → Dm → Gm9
  → high margins throughout, as you would expect from an isolated instrument
```

The second is the closest thing here to your use case — a single instrument,
recorded directly, no mastering — and it is visibly the cleaner result. **A
sparse, isolated source is the easy case for chord recognition.** A full band
through a phone mic in a room is the hard one, and neither of these tests it.
