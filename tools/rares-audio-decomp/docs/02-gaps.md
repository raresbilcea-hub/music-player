# 02 — The gaps, and what to do about them

This package was built to analyse **finished, mastered, studio recordings** for
the purpose of **making dance music**. Your app records **a live performance
through a microphone** and needs **chords and lyrics**.

Those are different problems. Here is honestly where the overlap ends.

---

## Gap 1 — LYRICS. There is nothing. Zero coverage.

Not a partial implementation, not a weak one — **no file in this package touches
speech or language at all.** The only vocal-related code (`vox.py` in the source
repo, not included) slices pre-existing spoken-word samples by hand-written
timestamps.

**This is your largest single build, and the good news is that it is the most
solved problem of the five.** The pipeline that works:

```
mic recording
  └─ source separation (Demucs)  ──►  isolated vocal stem
        └─ ASR with word timestamps (Whisper / WhisperX)
              └─ forced alignment  ──►  words + start/end times
                    └─ line grouping against the beat grid  ──►  a lyric sheet
```

**Four things to know before you start:**

1. **Separate first, always.** This is not an optimisation. Lessons §4 measured
   the effect on *pitch* tracking — 11 chromatic pitch classes off the mix
   versus 7 diatonic ones off a stem. ASR degrades at least as badly against a
   full band. Run Demucs, take the `vocals` stem, transcribe that.
2. **Singing is not speech, and ASR is trained on speech.** Sustained vowels,
   melisma, wide pitch range and unusual phrasing all hurt. Expect materially
   worse word error rates than the headline numbers you will read. Look for
   models or fine-tunes trained on sung material, and for the lyrics-specific
   datasets (DALI, Jamendo-Lyrics) if you want to evaluate properly.
3. **Language matters a lot, and it probably matters to you specifically.**
   Whisper is multilingual, but its Romanian word error rate is substantially
   worse than its English one, and that gap widens on singing. If a meaningful
   share of your users sing in Romanian, **measure that case separately from day
   one** — do not let an English demo set your expectations.
4. **Word-level timestamps are a separate capability from transcription.** Plain
   Whisper gives segment-level times that are approximate. WhisperX (or
   whisper-timestamped) adds a forced-alignment pass that gets you per-word
   timing, which is what you need to lay lyrics against bars.

> **Verify every tool and licence yourself before committing.** This section
> reflects the landscape as I understand it in mid-2026; models in this space
> turn over every few months.

---

## Gap 2 — Every assumption in this code is about a studio file, not a microphone

This is the subtle one, and it will bite you in ways that look like bugs in your
code.

Everything here was tuned on **~130 kbps Opus rips of mastered commercial
releases**: stereo, full-bandwidth, click-tracked, loudness-normalised, with a
professionally balanced spectrum. A phone or laptop microphone in a room gives
you almost the inverse.

| what changes | what it breaks |
|---|---|
| **Room reverb** smears every transient | Onset detection, which is the base of tempo, beats, swing and drum grids. Smeared onsets shift the detector peak — and lessons §8 shows that detector *lead* alone was enough to invert a swing measurement's sign. |
| **Background noise** (HVAC, traffic, fridge) | Spectral flux never returns to a floor, so onset thresholds tuned on clean audio fire constantly or never. Band-share statistics become statements about the room. |
| **Band-limited capture** — many phone mics roll off hard below ~150-300 Hz and above ~8 kHz | The 150-1400 Hz chroma band survives this reasonably well, **which is lucky and is why chords are your most tractable feature.** But bass note detection (35-180 Hz) becomes near-impossible, and anything using energy above 8 kHz is meaningless. |
| **Automatic gain control** on phone/laptop mics | AGC pumps the level continuously. Every dynamics, crest-factor, energy-arc and loudness measurement in this package is invalidated. It also breaks the "is this section quiet" heuristics that structural segmentation leans on. |
| **Clipping** from a close-miked loud source | Adds broadband harmonic garbage that reads as brightness and as onsets. |
| **Mono, one channel** | Everything stereo (`width.py`, correlation, mid/side) is not applicable. Not a loss — just delete those features from your plan. |
| **A human playing without a click** | 🔴 **The big one.** Tempo drifts continuously. Every bar grid in this package is fitted as a *uniform* grid, and `decompose.py` cuts bars from a constant BPM. Over 100 bars of human playing, a constant-BPM grid will be a full bar out by the end, and your chord chart will be silently misaligned. |
| **One take, 30-90 seconds** | No corpus statistics, no median-across-the-track smoothing, no "measure the middle 60 seconds and skip the intro" trick. Every technique here that leans on length is unavailable. |

**What to do:**

- **Add a capture-quality gate before analysis.** Measure noise floor, clipping
  percentage, bandwidth (highest frequency with real energy) and duration.
  Refuse or warn rather than returning confident nonsense. This is cheap and it
  is the highest-value defensive feature you can ship.
- **Replace every uniform bar grid with a beat-synchronous one.** Track beats
  with a model that handles tempo variation, then cut chroma frames *at beat
  boundaries* rather than at fixed time intervals. This is the single most
  important change to make to `decompose.py`.
- **Build your own small test set of real mic recordings** on day one, and run
  every change against it. Numbers from commercial recordings will not transfer.

---

## Gap 3 — Nothing here is real-time, and some of it is very slow

| step | cost |
|---|---|
| Essentia `RhythmExtractor2013` | **60-90 s for an 8-minute track** |
| Demucs 6-stem separation | **~2:19 per track** on the machine this was built on |
| EffNet embedding + heads | ~95% of tagging wall time is the embedding |
| Everything downstream of those | milliseconds |

Two consequences:

1. **Architect around the expensive artefact.** Beats, stems and embeddings are
   computed once and cached; every question after that is a cheap read.
   `src/library/beatcache.py` is the pattern — cache key is
   `path | size | mtime`, so a re-encode cannot serve stale results.
2. **A 60-second mic recording is a much smaller job than an 8-minute master**,
   so these numbers are pessimistic for you. But if you want *live* feedback
   while recording, none of this architecture applies — that is a streaming
   problem with a different toolset, and I would treat it as a separate product
   decision rather than an optimisation of this one.

---

## Gap 4 — Downbeats, and beat-synchronous chord segmentation

Two related holes, and together they are why a chord chart from this code is not
yet a chord chart a person can play from.

**Downbeats are unsolved here.** Beat trackers return beats, not downbeats
(lessons §5). `structure.py` uses `beat_this` for downbeats and its own
docstring says that model "quantises to 20 ms" and "intermittently emits a
downbeat half a bar early." Nothing else in the package establishes bar 1 at
all — `decompose.py` prints a warning saying so.

**Chord segmentation is time-based, not beat-based.** `decompose.py` sums chroma
over fixed-duration windows derived from a constant BPM. Correct would be:
detect beats → detect downbeats → sum chroma **between beat boundaries** →
segment chords on the beat grid.

**What to look at:** `madmom`'s downbeat tracking (RNN + dynamic Bayesian
network) has been the workhorse for years; `beat_this` is the recent one this
project already uses; and the "All-In-One" family of models emits beats,
downbeats, tempo *and* functional structure labels from a single pass, which
would close this gap and part of Gap 7 together. **Check licences** — madmom in
particular has historically carried a non-commercial restriction, and that is
exactly the trap `docs/04-licensing.md` is about.

---

## Gap 5 — No bass note, no inversions, no slash chords

`decompose.py` band-limits chroma to 150-1400 Hz specifically to keep the bass
*out* of the chord frame, because the bass voting is the largest single source
of chord-label error (lessons §4). That is the right call for identifying the
chord — and it means the bass note is thrown away, so you can never output
`C/E`.

**The correct architecture is two streams:**
- harmonic stem (or 150-1400 Hz band) → the chord quality,
- bass stem (or 35-180 Hz band) → the bass note,
- combined → root position or inversion.

`src/library/bassline.py` is the second stream, already written, with its
octave-error defences in place. It has never been joined to the chord stream —
that join is a genuine, well-defined piece of work and it would visibly improve
your output.

⚠️ On mic input, see Gap 2: the bass may simply not be in the recording.

---

## Gap 6 — No polyphonic note transcription

Explicitly refused. `groove-extract.py`:

> ❌ **PADS AND KEYS.** `other` is a bag — pad, lead, most percussion, often
> several at once. Polyphonic transcription of it would produce a note list that
> looks authoritative and is not. **NOT ATTEMPTED.**

That was the correct decision for a signal-processing-only toolkit. It is not
the correct decision for you, because **the field has moved to trained models
and they are much better than DSP at this.**

Worth evaluating: **Basic Pitch** (Spotify) — small, CPU-friendly, polyphonic,
handles pitch bends, **and Apache-2.0 licensed, which makes it one of the few
commercially safe options in this whole space**. For piano specifically, the
Onsets-and-Frames lineage is strong. **MT3** is multi-instrument.

If you ever want notes rather than chord labels, start with Basic Pitch on a
separated stem and measure it before building anything around it.

---

## Gap 7 — Structural segmentation is coarse, and unlabelled

`decompose.py`'s section detection finds *boundaries*, not *sections*, and
cannot see anything shorter than its 8-bar kernel (lessons §7). It has no idea
which part is a verse and which is a chorus.

`structure.py` goes considerably further — energy plateaus, breakdown detection,
intro/outro length, melodic entry, a Rayleigh-Z periodicity ladder — but still
produces unlabelled boundaries.

For a song-transcription app, **functional labels (intro / verse / chorus /
bridge) are probably more valuable to the user than precise boundaries.** That
is a supervised problem with public datasets (SALAMI, Harmonix); models in the
All-In-One family emit these directly.

---

## Gap 8 — 🔴 There is no evaluation. None. Anywhere.

**No ground truth. No annotated test set. No accuracy figure for any output of
any script in this package.**

Every reliability judgement in this documentation is either the author's
reasoning about a method, or an internal-consistency check (two estimators
disagreeing, four records agreeing), or a trained musician listening and saying
it was wrong. That was adequate for a project with exactly one user who could
hear.

**It is not adequate for a product**, and this is the gap I would close first —
before adding a single feature. Without it you cannot tell an improvement from a
regression, you cannot set a confidence threshold, and you cannot answer "how
good is it?" when someone asks.

**What that looks like concretely:**

- **Use `mir_eval`.** It implements the standard metrics for chord, beat,
  downbeat, structure and melody evaluation. Do not write your own scorer.
- **Get annotated data.** Isophonics (Beatles/Queen/Zweieck), the McGill
  Billboard set and RWC-Popular are the standard chord-annotated corpora;
  SALAMI and Harmonix for structure; check each one's licence and access terms.
- **Understand that chord accuracy is vocabulary-dependent.** The same output
  scores very differently under major/minor, triads, sevenths and full-tetrad
  evaluation. Pick a vocabulary that matches what your users actually want to
  play and report against it consistently.
- **Then build your own mic-recorded set**, because published corpora are all
  studio recordings and Gap 2 says those numbers will not transfer.

**Do this before optimising anything.** Lessons §10 and §14 are both about
metrics that measured the wrong thing while looking healthy — with no ground
truth you have no way to catch that.

---

## Gap 9 — Confidence exists in the data and not in the interface

The scripts here are unusually good at *producing* uncertainty and have nowhere
to *put* it. `decompose.py` prints a `margin` per chord and flags anything under
0.02 as weak. On a real commercial record, **roughly half the bars come back
weak** — bar 10 in `examples/breakbot-stems.txt` is `A#` at 0.455 against `Dm`
at 0.451, which is a coin flip presented as a chord.

**That is not a bug. It is the truth about chord estimation, and your UI is
where it has to be handled.** Some options, in rough order of how much I would
trust them:

- Show the runner-up when the margin is small. Users who play will recognise the
  right one instantly.
- Fall back to a coarser label — output `Dm` rather than choosing between `Dm7`
  and `Dm9` when the frame does not distinguish them. A less specific correct
  answer beats a specific wrong one.
- Let the user correct a chord, and **propagate the correction** to every other
  bar the detector labelled the same way. This turns a weakness into your best
  data-collection loop, and eventually into training data.
- Use repetition: most songs repeat their progression. Two bars that are
  acoustically near-identical should get the same label, and voting across
  repetitions is free accuracy.

---

## Gap 10 — Licensing is a product blocker, not a footnote

`docs/04-licensing.md`. Read it before you write any code that imports Essentia.

---

## If I were sequencing this

1. **Evaluation harness first** (Gap 8) — `mir_eval` plus a public chord corpus,
   plus 20 of your own mic recordings hand-annotated. Nothing else is measurable
   until this exists.
2. **Capture-quality gate** (Gap 2) — cheap, and it prevents your worst failure
   mode, which is confident garbage from a bad recording.
3. **Beat-synchronous everything** (Gaps 2, 4) — replace the constant-BPM grid
   with tracked beats and real downbeats. This is the highest-value fix to the
   existing chord path.
4. **Lyrics pipeline** (Gap 1) — Demucs → vocal stem → word-timestamped ASR. It
   is a separate, largely independent build, and it is the feature users will
   describe the app by.
5. **Bass stream joined to the chord stream** (Gap 5) — inversions and slash
   chords, using code that already exists.
6. **Confidence UI and the correction loop** (Gap 9) — the thing that makes an
   imperfect transcriber genuinely useful, and the thing that generates your
   training data.
