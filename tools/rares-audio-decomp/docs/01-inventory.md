# 01 — What is actually in here

Three kinds of thing:

1. **`decompose.py`** — written for this handoff. Runs on any audio file with
   nothing but numpy + soundfile + ffmpeg. Tempo, beats, key (two estimators),
   chords per bar with Viterbi smoothing, structural boundaries, band profile.
2. **`analyse_song.py`** — the whole pipeline in one command: capture gate →
   Demucs separation → beat tracking → key/chords/sections → drum grid → bass
   line → ML tagging. Model weights ship in `models/`, so it runs out of the
   box. Every stage caches; any stage whose dependency is missing is **skipped
   with a printed reason, never faked**. See `docs/06-runbook.md`.
3. **`src/`** — the research scripts, copied verbatim. Every one of them has
   hardcoded paths into a private 24 GB music library and **will not run as-is.**
   They are here for their *methods* and their *docstrings*, which are unusually
   detailed about what each measurement can and cannot support.

> **Read the docstrings.** They are the real documentation. Most of them open
> with why the file exists, what it got wrong before, and what it refuses to
> claim. That is where the value is — not in the code, which is mostly 200 lines
> of numpy.

---

## Relevance key

| | meaning |
|---|---|
| 🟢 | directly reusable for a record-a-song-get-chords app |
| 🟡 | the *method* transfers, the code needs work |
| ⚪ | included for completeness; specific to making dance records |

---

## The front door

### `decompose.py` 🟢
**One audio file in, a structured reading out.** Written for this package,
tested on both a mastered commercial record and a raw solo-piano take.

| output | method | trust |
|---|---|---|
| tempo | onset-flux autocorrelation, 60-180 BPM, **reports its own bin resolution and the half/double alternatives** | medium — see lessons §2 |
| beats | Essentia `RhythmExtractor2013` if installed, else a phase-locked comb | good on click-tracked audio, poor on human timing |
| key | Krumhansl on mid-band chroma **and** Essentia `edma`, with an explicit agree/disagree verdict | use the *agreement*, not either number — lessons §1 |
| chords | 12 qualities × 12 roots, cosine to chroma, **Viterbi-smoothed with a self-transition bonus**; prints smoothed, unsmoothed, runner-up and margin | medium; the margin field is the honest part |
| sections | checkerboard novelty over a bar-synchronous self-similarity matrix | coarse — cannot see anything shorter than the kernel |
| bands | octave-band energy shares | reliable |

**Its own known limitations, stated plainly:**
- Bars are cut from a **constant BPM starting at sample 0** of the excerpt, not
  from the tracked beat times. So the bar grid **drifts on human-played material
  and has arbitrary phase.** Fixing this is job #1 if you build on it — snap
  chroma frames to the actual `beats` array and estimate the downbeat.
- No bass/inversion handling — chroma is band-limited to 150-1400 Hz to keep the
  bass out of the chord frame, which helps, but a slash chord is invisible.
- The Viterbi `self_transition` weight (`--stay`, default 0.55) was **set by ear
  on one corpus**. It is a tuning knob, not a measurement. Raise it for
  slow-moving material, lower it for jazz.

Run:
```
python3 decompose.py song.wav
python3 decompose.py song.wav --start 30 --dur 60 --json out.json
python3 decompose.py song.wav --stay 0.8      # fewer chord changes
```

### `analyse_song.py` 🟢
Seven stages, one command, JSON out. Beyond what `decompose.py` does it adds:

| stage | what it gives you | how far to trust it |
|---|---|---|
| **capture gate** | clipping, headroom, bandwidth, duration — with a verdict | good, and **validated against degenerate inputs** by `tests/validate_capture_gate.py` |
| **separation** | Demucs 4- or 6-stem; auto-falls back MPS → CPU | the highest-leverage stage in the package |
| **drum grid** | which 16th the kick / snare / hats land on | kick and hats good; **`snare_clap` is unreliable under a four-to-the-floor kick** — the 150-800 Hz band catches kick harmonics |
| **bass line** | note per beat, pitch-class counts | weak, **and it says so**: >7 pitch classes triggers a `LIKELY DETECTOR NOISE` flag in the JSON |
| **ML tagging** | 400 genres, mood themes, 40 instruments, 5 binary heads | rankings, never probabilities ⚠️ non-commercial |

**One bug in its history is worth knowing**, because it is the archetype for
this whole package: with `--start/--dur`, beats were tracked on the excerpt
while Demucs separated the *whole file*, putting the two time bases 45 seconds
apart. Every number was well-formed and measured against the wrong audio. **The
tell was musical** — the kick came back on 16th steps 3, 7, 11, 15, and no house
record does that. Now the excerpt is cut to a file once and every stage runs on
it. `docs/06-runbook.md` §3 has the detail.

---

## Harmony and pitch

### `src/library/harmony.py` 🟢
Chord progressions off a full mix. Chroma → template match against 10 chord
qualities → **expressed as Roman numerals relative to a detected key**, so
tracks in different keys can be pooled and compared.

Also computes **harmonic rhythm** (how many bars a chord is held, how often it
changes) — and the docstring makes an important point: those numbers are
**key-independent**, so they survive a wrong tonic when the Roman numerals do
not. If your key detection is shaky, harmonic rhythm is still trustworthy.

`decompose.py` supersedes the chord path with Viterbi smoothing, but this file
has the Roman-numeral and progression-counting layer that it does not.

### `src/library/deconstruct-breakbot.py` 🟢 — **read this one**
The same question asked off **separated stems** instead of the mix, and it is
the clearest demonstration in the package of why separation matters.

Per stem: `other` → chord per beat + voicing register + attack density; `bass` →
note per beat, register, octave-leap rate; `drums` → which 16ths are struck +
swing; `vocals` → presence, for an arrangement map.

**Its honesty is the model to copy:** where a chord label is a guess between two
readings, **both are printed with their scores.** See
`examples/breakbot-stems.txt` for the output format — every bar has a best
reading, a runner-up, both scores, and the top pitch classes that produced them.
A user can see for themselves that bar 10's `A#` at 0.455 and `Dm` at 0.451 is a
coin flip.

### `src/library/deconstruct-lujon.py` 🟡
Same idea on a 1961 orchestral recording — useful as a second worked example on
completely different material. Contains the **consensus-across-windows** pattern
that works around Melodia's non-determinism (lessons §6).

### `src/library/bassline.py` 🟢
Monophonic bass pitch tracking, and its docstring is a compact list of every
defence you need:
- band-limit to 35-180 Hz before tracking, or pads and low mids vote;
- **score candidates on their own harmonic series** to defeat period-doubling;
- segment on pitch *change* then despike, or you measure tracker jitter;
- **report pitch classes, not MIDI numbers**, so an octave error doesn't destroy
  the result.

States clearly what it cannot do: no rhythmic placement without downbeats.

### `src/library/melody_extract.py` 🟡
Melodia f0 tracking on a separated `other` stem, reduced to pitches, scale
degrees, intervals and contour.

**Its disclaimer is the important part:** *"It does not know which notes are 'the
melody'. A pitch tracker returns the most salient f0 frame by frame; over a
record that is sometimes the lead, sometimes the top of a chord, sometimes a
vocal. The output is a menu to listen against, not a transcription."*

If your app promises "the melody", this is the honest ceiling of the
salience-based approach. Move to a trained transcription model (see
`docs/02-gaps.md`).

### `src/pipeline/survey.py` 🟢
Measures a folder of audio samples: **sounding pitch vs. the filename**, onset
time in ms, sustain-RMS spread, spectral centroid. The harmonic-series pitch
scorer lives here and is the most reusable single function in the package.

### `src/pipeline/verify_pitch.py` 🟡
Renders single notes and measures the fundamental that actually sounds. The
pattern generalises: **verify the output of the thing you changed, not the
input.** A tuning error is invisible to every spectral, distortion and balance
test — it is clean audio in the wrong key.

---

## Rhythm

### `src/library/beatcache.py` 🟢 — **copy this pattern**
Beat tracking, cached. Key is `abspath | size | mtime`, SHA1'd, so re-encoding a
file cannot silently serve stale beats. Twenty-eight lines of docstring
explaining why, and it is worth the read.

### `src/library/groove-extract.py` 🟢
Reads the actual rhythm off separated stems: **which 16th each drum lands on**,
how much swing there is, what the bassline plays.

Its reliability table should be your default expectation for any of this work:

| | |
|---|---|
| ✅ **drums** | onset detection per band on an isolated drums stem — "about as solid as MIR gets" |
| ✅ **bass** | monophonic pitch tracking on an isolated bass stem |
| ⚠️ **swing** | inherits any error in the beat times; reported with a spread and a sample count, never as one number |
| ❌ **pads and keys** | `other` is a bag. Polyphonic transcription of it "would produce a note list that looks authoritative and is not." **NOT ATTEMPTED.** |

### `src/library/groove-summary.py` 🟢
Puts four extracted grooves side by side and **marks any row where the records
disagree as NOT USABLE rather than averaging it.** The principle: *a pattern four
independent records agree on is evidence; a pattern in one record is a
hypothesis.* Directly applicable to any confidence UI you build.

### `src/library/swing.py` 🟡
Microtiming. Third attempt; the first two measured something else. See
lessons §8 — it is the best short lesson in the package on designing a
measurement so that detector bias cancels.

---

## Structure and arrangement

### `src/library/structure.py` 🟢
The most substantial file here (~1,300 lines). Per track: bar count on a fitted
uniform bar grid, section lengths in bars, a **Rayleigh-Z periodicity ladder**
that discriminates 8-bar from 16-bar from 32-bar phrasing rather than just
confirming "some grid exists", first energy lift, longest breakdown, number of
distinct energy plateaus, intro/outro length, melodic entry point, and the whole
energy curve resampled to 100 points so tracks of different lengths can be
averaged.

Downbeats come from **`beat_this` (ISMIR 2024)** on Apple MPS. Boundaries are
snapped to bar lines and **nothing else** — snapping to an 8- or 16-bar grid
would make "do sections come in 16s?" circular.

Has a `--selftest` mode that proves the periodicity ladder works on synthetic
input. **Copy that habit.**

### `src/library/arrangement-matrix.py` 🟡
Six-stem Demucs separation → per-beat dB and peak for every stem, one JSON line
per track, plus the downbeat index. The expensive thing done once and written
down.

### `src/library/arrangement-analyse.py` ⚠️ **read the warning, not the code**
Its change-rate output is marked **DO NOT USE** by its own author, with the
measurements proving why. This is lessons §7 in its original form. Included
deliberately as a worked example of catching your own broken finding.

### `src/library/arrangement-map.py` 🟡
Per-bar RMS of each Demucs stem, in dB relative to that stem's own loudest bar —
a grid of **what is playing when**. The simplest useful arrangement
representation in the package, and it needs no onset or activity detector, which
is what makes it immune to the flicker problem in lessons §7.

### `src/library/energy-arc.py` 🟡
Answers the same "where does the low end drop out" question **without
separating anything** — whether the kick and bass are playing is a band-energy
question and the band is right there in the mix. No Demucs, no bleed, no
threshold on a manufactured stem. A good reminder that separation is not always
the answer.

---

## Timbre, loudness, stereo

### `src/pipeline/measure.py` 🟢
LUFS (BS.1770), true peak, octave bands. The workhorse.

### `src/library/texture.py` 🟡
Spectral flatness and HF-noise share. Contains the one-decode-path rule
(lessons §9) as its central design constraint.

### `src/library/width.py` 🟡
Stereo width **and** width *movement*, on the same windows with the same
decoder — written because two analyses reported opposite conclusions about the
same files and turned out to be measuring different quantities. If your app ever
reports a "stereo" number, read this first.

### `src/library/dynamics.py`, `movement.py`, `reference-envelope.py` ⚪
Loudness range, brightness/width movement over a track, and a per-band
p10/median/p90 envelope built from a 341-track corpus. Music-production
oriented, but `reference-envelope.py` has a transferable idea: **build the
tolerance from the corpus rather than assuming it.**

---

## Machine-learning tagging

### `src/library/tag-ml.py`, `tag-ml2.py`, `similar.py` ⚠️ **licence blocker**
Discogs-EffNet embeddings + classification heads: 400 genres, mood themes, 40
instruments, danceability. `tag-ml2.py` persists the 1280-d embedding so
"find more like this" becomes a cosine distance instead of a re-run
(`similar.py`).

**🔴 These weights are CC BY-NC-SA 4.0 — NON-COMMERCIAL — and Essentia itself is
AGPL-3.0. Both are blockers for a commercial product. See `docs/04-licensing.md`
before you touch this directory.**

Two other caveats worth carrying: the instrument head's own scores are
**PR-AUC 0.20 / ROC-AUC 0.78** — read it as a ranking, never a probability
(lessons §11). And the embeddings were trained on editorial metadata (artist,
label, release), so nearest neighbours encode **scene as much as sound** — two
tracks on the same label sit close even when they differ musically.

### `src/library/tag-one.py` 🟢
The same tagger pointed at **a single file** rather than a corpus — structurally
the closest thing in the package to what your app does, one recording at a time.
It exists because a genre label had been *asserted* in a release script and
never measured; the obvious question ("is this actually organic house? ask the
classifier") had never been put to a model that was sitting on disk.

### `src/library/danceability.py` 🟢 — **read this for the method, not the feature**
Nobody building a transcription app needs a danceability score. **Read it for
what it does to one.**

A single black-box model head reported a number that an entire finding rested
on. Rather than build on it, this script does two things: runs a **completely
independent, non-neural algorithm** (detrended fluctuation analysis over the
loudness envelope) as a second opinion — *if the two agree the finding is real,
if they disagree the finding is about a model and not about the music* — and
then **decomposes the score into seven measurable component features** so it
becomes something you can act on rather than just rank by.

That is the correct treatment of any model output you plan to show a user, and
it is the pattern to copy for a chord or key confidence score.

### `src/library/analyse.py` 🟡
The original whole-library pass: tempo, key, energy, brightness, weight, crest,
density. **Its key column carries a 🔴 DO NOT USE banner** with the measurement
that killed it (lessons §1), and its tempo docstring carries the correction
described in lessons §2. Both banners are more useful than the code.

### `src/library/lane-vs-playlist.py`, `analyse-influences.py` ⚪
Corpus comparison. Included because `lane-vs-playlist.py` is where the key
detector was caught.

---

## `examples/`

| file | what it is |
|---|---|
| `breakbot-stems.txt` | Real stem-derived output: chord per bar with runner-up and score, bass note per beat, register profile. **Note the bass line reads `D4 G4 A3 D4 C#1 A1 …` — those D4/G4 readings are octave errors sitting in a shipped result** (lessons §3). |
| `decompose-output-breakbot.json` | Full JSON from `decompose.py` on the same track, so you can see the schema. |
