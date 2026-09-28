# 00 — Manifest: everything in the source project, in or out, with a reason

**Why this file exists.** The first cut of this package was assembled by
judgement and shipped without saying what had been left behind. That is exactly
the failure this handoff warns about elsewhere — a curated result presented as a
complete one. So: every analysis file in the source project is listed below,
marked IN or OUT, with the reason. **If something marked OUT sounds useful,
ask — it takes thirty seconds to add.**

---

## Size accounting

The zip is ~30 MB, of which 27 MB is model weights. The CODE and DOCS are
~470 KB, which is correct and not a mistake — it is all plain text:

| | size | in the zip? |
|---|---|---|
| analysis source code (`.py`, `.sh`) | ~360 KB | ✅ all of it that is relevant |
| documentation written for this handoff | ~85 KB | ✅ |
| one example output + one example ground-truth file | ~20 KB | ✅ |
| **pretrained model weights** (`models/`) | **27 MB** | ✅ **included** — the full pipeline runs with no downloads |
| **cached analysis results** (`library/data/*.json`) | **22 MB** | ❌ findings about a private library, not about your problem |
| the audio corpus (`audio/`, `influences/`, `inspo/`, `sets/`) | **~24 GB** | ❌ obviously |

**The code half is all plain text and compresses ~2.8×**, which is why it looks
small. That is not a sign anything is missing — the "ML pipeline" is a few
hundred lines of Python that load weights from disk. **The intelligence is in
the weights, and the weights are the 27 MB.**

### The model weights, specifically

**✅ All twelve files are in `models/`**, so separation, beats, chords, drum
grid, bass line and tagging all run with no downloads. `bash setup.sh` checks
every one by name.

| file | what it is |
|---|---|
| `discogs-effnet-bs64-1.pb` | 18 MB — the 1280-d embedding. **~95% of the compute.** Every head below reads it |
| `genre_discogs400-…pb` + `.json` | 400-class Discogs genre taxonomy |
| `mtg_jamendo_moodtheme-…pb` + `.json` | mood / theme tags |
| `mtg_jamendo_instrument-…pb` + `.json` | 40 instrument classes |
| `danceability-…pb` | binary head |
| `mood_happy` / `mood_sad` / `mood_relaxed` / `mood_aggressive` | binary heads |

⚠️ **CC BY-NC-SA 4.0 — non-commercial**, and Essentia which loads them is
AGPL-3.0. Bundled so the pipeline runs out of the box for evaluation; that is
not a licence assessment for a product. `models/LICENCE-NOTICE.md` has the
detail, including two measured traps (the graphs do **not** share node names,
and the scores are rankings rather than probabilities).

---

## IN — the analysis code

### Harmony, pitch, melody
| file | why it's in |
|---|---|
| `harmony.py` | chord recognition from a mix; Roman numerals; harmonic rhythm |
| `deconstruct-breakbot.py` | the same off separated stems, with both readings printed |
| `deconstruct-lujon.py` | second worked example, different material; consensus-across-windows pattern |
| `bassline.py` | monophonic bass tracking with octave-error defences |
| `melody_extract.py` | Melodia f0 on a stem, with an honest ceiling stated |
| `pipeline/survey.py` | the harmonic-series pitch scorer — most reusable function here |
| `pipeline/verify_pitch.py` | measuring what pitch actually sounds vs. what was intended |

### Rhythm
| file | why it's in |
|---|---|
| `beatcache.py` | the cache-the-expensive-artefact pattern |
| `groove-extract.py` | drum grid + swing + bass off stems, with a reliability table |
| `groove-summary.py` | marks disagreement as NOT USABLE rather than averaging it |
| `swing.py` | microtiming; three attempts, two wrong, all documented |

### Structure and arrangement
| file | why it's in |
|---|---|
| `structure.py` | the big one — bar grids, section lengths, periodicity ladder, energy curves; has a `--selftest` |
| `arrangement-matrix.py` | 6-stem separation → per-beat dB/peak, written once and kept |
| `arrangement-map.py` | per-bar RMS per stem = "what is playing when", read off the record |
| `arrangement-analyse.py` | **included for its DO-NOT-USE warning**, which is a worked example of catching your own broken finding |
| `energy-arc.py` | the same question answered *without* separating anything |

### Timbre, loudness, stereo
| file | why it's in |
|---|---|
| `pipeline/measure.py` | LUFS, true peak, octave bands — the workhorse |
| `texture.py` | spectral flatness; the one-decode-path rule |
| `width.py` | stereo width vs. width *movement*, written to settle a contradiction |
| `dynamics.py`, `movement.py`, `reference-envelope.py` | loudness range, brightness/width movement, corpus-derived tolerance envelope |

### Machine learning (⚠️ licence-blocked — see `04-licensing.md`)
| file | why it's in |
|---|---|
| `tag-one.py` | **single-file** tagging — the closest thing here to your app's shape, one recording at a time |
| `tag-ml.py`, `tag-ml2.py` | the corpus taggers; `tag-ml2` persists embeddings and documents the licence and calibration traps |
| `similar.py` | nearest-neighbour "sounds like" over persisted embeddings |
| `danceability.py` | **validating a black-box ML score against an independent non-neural algorithm, and decomposing it into buildable features.** On-theme for the whole lessons file |
| `analyse.py` | the original feature pass; its `key` column carries a 🔴 DO NOT USE banner with the measurement that killed it |
| `analyse-influences.py`, `lane-vs-playlist.py` | corpus comparison; the second is where the key detector was caught |

### Batch driver
| file | why it's in |
|---|---|
| `run-arrangement-study.sh` | working Demucs batch loop, including the stdin gotcha |

---

## OUT — and why

These are all specific to running a private 640-track music-production library.
None of them contain a method you would want.

| file | what it does | why it's out |
|---|---|---|
| `explore.py` | joins six JSON result files into one dataframe and asks taste questions | corpus bookkeeping; no transferable method |
| `segment.py` | separates personal taste from genre convention by eta² | corpus statistics — **and it carries a known bug**: it scores `crest` and `rms_db` as two features when they are one, and its headline result was run on the wrong track set |
| `find-references.py` | picks reference tracks matching target criteria | library curation |
| `pick-arrangement-set.py` | chooses a stratified sample for a study | study plumbing |
| `arrangement-stats.py` | parses a superseded text-format study | dead code; replaced by `arrangement-analyse.py` |
| `reference-melodies.py` | extracts melodies from four named reference tracks | hardcoded to four specific files |
| `fix-mood-polarity.py` | one-off repair of a mislabelled field | one-off |
| `name-view.py`, `split-sets.py` | filename views, DJ-set splitting | file management |
| `workbook.py` | writes an Excel view of the library | reporting |
| `chain-tag.sh`, `run-tribal-analysis.sh` | job runners for the above | orchestration of excluded scripts |

Also out, from the wider project: the whole music *generation* pipeline
(`compose.py`, `rpp.py`, `synths.py`, `instruments.py`, `tribalfunk.py`,
`vox.py`, artwork and release tooling). That is REAPER project generation and
sound design — the opposite direction from analysis, and of no use to a
transcription app.
