# 03 — The failure catalogue

**Read this one first. It is the most valuable file in the package.**

Everything here was learned by getting it wrong on real audio, noticing, and
measuring the cause. None of it is textbook material — the textbooks describe
the algorithms, and every item below is about the gap between what an algorithm
is called and what it returns.

**The single unifying property:** *almost every failure in this list produced
perfectly plausible output.* No exception was raised, no number looked absurd,
nothing in the pipeline complained. That is what makes MIR bugs expensive — the
feedback loop that catches an ordinary bug does not exist here. In the source
project the errors were caught by a trained musician listening, days later, and
saying "that chord is wrong."

**For a transcription app this is the core product risk.** A user cannot tell a
confident wrong chord from a confident right one, and a wrong chord chart is
worse than no chord chart, because they will spend twenty minutes trying to
play it before concluding the app is broken.

---

## 1. Key detectors lie, and they lie confidently

A chroma + Krumhansl-Schmuckler key estimator — the standard, textbook,
everybody-implements-this method — was run over a 431-track corpus of house
music.

**It returned A minor for 41% of the corpus.** A different corpus of 400+ tracks
came back 39% A minor.

No real corpus is 41% A minor. That number is a property of the detector, not of
the music. Essentia's `KeyExtractor(profileType='edma')` on the same files put A
minor at 9%. On the subset where a third method also ran, `edma` agreed with it
37% of the time and the Krumhansl one 19%.

**Neither number is "the accuracy."** Nobody in that project had annotated
ground truth. All that was established is that two respected methods disagree
about two thirds of the time on real material.

**What to do:**
- Run **two independent estimators** and treat *agreement* as the signal.
- When they disagree, say so in the UI. "We think Dm, possibly F" is honest and
  useful. A single confident wrong key propagates into every chord label you
  express in Roman numerals.
- Published free-tool key accuracy sits around 70-75%. The paid standard (Mixed
  In Key) is quoted around 89%. If your product promises key, you are promising
  something the field does not reliably deliver.

`decompose.py` implements the two-estimator pattern.

---

## 2. A tempo estimate is meaningless without its search range and its bin width

The original tempo function in this codebase had a docstring saying it "searched
110-140 BPM". It did not. The lag bounds were **integer frame counts** at 86.13
frames/sec, so:

- The reachable range was actually 114.8-143.6 BPM.
- The estimator could only ever emit **ten distinct values**: 114.8, 117.5,
  120.2, 123.0, 126.0, 129.2, 132.5, 136.0, 139.7, 143.6.
- Adjacent bins near house tempo are ~3 BPM apart, so **a "3 BPM difference"
  between two populations is one bin** — i.e. noise.
- **11% of one corpus and 17% of another landed on a boundary value**, meaning
  their true tempo was outside the window and had been silently clamped. All
  tempi for two of the four named artists were unusable and nobody knew.

**What to do:**
- Report the search range and the bin resolution alongside the BPM, always.
  `decompose.py` prints both.
- Flag boundary hits as failures, not results.
- **Metrical ambiguity is real, not noise.** A tracker cannot distinguish 70
  from 140 from the signal — that is a musical judgement about where the beat
  is. Report the octave alternatives rather than pretending to have chosen.

---

## 3. Autocorrelation period-doubles, and it looks exactly like a tuning error

Measuring the sounding pitch of every sample in an organ library,
autocorrelation returned **exact 1/2 and 1/3 frequency ratios on the brightest
samples.** Read naively, that says "the top octave of this instrument is
mistuned."

It was not. **Period-doubling is what autocorrelation does to a sound with a
weak fundamental and strong upper partials** — which is precisely what an organ
mixture stop *is*. And a bass note's second harmonic is very often louder than
its fundamental, so basslines have this problem constantly.

**The fix, and it works:** score each candidate f0 on **its own harmonic
series**, and reject any candidate that has a hole at its own first partial.
After that change all 81 samples agreed.

Implementation: `src/pipeline/survey.py`, and `src/library/bassline.py` uses the
same defence.

**Why this matters for you:** an octave-wrong note produces perfectly clean
audio and a perfectly clean-looking number. Look at
`examples/breakbot-stems.txt` — the bass line reads `D4 G4 A3 D4 C#1 A1 …`.
Bass notes at D4 and G4 next to C#1 are octave errors sitting in a shipped
result. Nobody caught them at the time.

---

## 4. Separate the source first. It is the single largest accuracy win available.

Measured, on the same material:

| input | what a pitch tracker returned |
|---|---|
| full mix | **11 chromatic pitch classes** — noise |
| Demucs `other` stem | **7 diatonic pitch classes** — readable |

The project's own note: *"the difference between a table of noise and a readable
one."*

The same applies to chords. Chroma over a full mix sums bass, drums, vocal and
keys into one histogram, and **the bass note voting in the chord frame is the
biggest single source of chord-label error** — a `iv` in first inversion and a
`V7` are near-indistinguishable once it does. That specific confusion put a
wrong `V7` into a shipped analysis.

**For your app this is the highest-leverage architectural decision.** Separating
first costs wall-clock and a dependency and buys you:
- chords read off the harmonic stem with the bass removed,
- the bass line read off the bass stem, monophonic and reliable,
- the drum grid read off the drums stem, unambiguous,
- **and the vocal isolated, which is what makes lyrics transcription work at
  all** (see `docs/02-gaps.md`).

---

## 5. Beat trackers return BEATS, not DOWNBEATS

`RhythmExtractor2013` returns beat times. `ticks[0]` is *a* beat, with no
guarantee whatsoever that it is beat 1 of a bar.

Consequences, all of which happened:
- The 16th position *within a beat* (1 = on, 2 = e, 3 = &, 4 = a) is correct.
- The bar-relative step (1-16) is **only correct modulo 4** unless something
  else pins the bar phase.
- Anything printed as "bar N" inherits this, and a wrong table shipped because
  of it.

Partial fixes used here: a backbeat detector looking for clap/snare energy
(1.5-4 kHz) on alternating beats pins the phase modulo 2. Beyond that, use a
model that emits downbeats directly — `beat_this` (ISMIR 2024) is what
`src/library/structure.py` uses, and even it "quantises to 20 ms" and
"intermittently emits a downbeat half a bar early."

**For a chord app the downbeat is not optional.** A chord chart with the bar
lines in the wrong place is unusable even when every chord label is correct.

---

## 6. Some detectors are not reproducible run to run

Essentia's Melodia pitch tracker, given **the same five seconds of the same
file**, returned **three different note lists across three runs**, including
octave disagreements.

The fix used: run overlapping windows, take a **consensus**, carry how many runs
agreed, and **do not report anything under a majority.**

**Before you build on any detector, run it twice on the same input.** This takes
thirty seconds and there is no reason to assume determinism.

---

## 7. Presence / activity detectors flicker, and the flicker becomes your finding

A 139-record study measured which stems were active per beat. Its output was
marked **DO NOT USE**, because:

- The median run of *"the drums are playing"* was **2 beats**.
- **~70% of all activity runs on every stem were one bar or shorter.**

Drums do not leave and return every half-bar. The detector was flickering.

The way it showed up in the results is the part worth internalising — **the mode
of the output distribution was always the analysis grid**:

| grouping used | "% of section changes at exactly that length" |
|---|---|
| 4-bar groups | **63.6% land on exactly 4 bars** |
| 1-bar groups | **60.4% land on exactly 1 bar** |

And at 1-bar resolution, only **1%** of gaps were a multiple of 8 — on a corpus
of house and techno, where 8- and 16-bar phrases are close to universal.

**This is the ruler measuring itself.** The first version of the study assumed
finer resolution would fix it. It did not; it made the artefact finer.

**Test for it:** if your result's modal value equals your analysis window, your
analysis window is your result. Re-run at a different resolution and see whether
the finding moves with it.

The same trap is built into structural segmentation: **a checkerboard kernel of
half-width L cannot resolve a section shorter than L.** If you use an 8-bar
kernel and conclude "sections come in 8s", you have measured your kernel.

---

## 8. Three attempts at "swing", two of them measured something else

Worth reading in full in `src/library/swing.py`. Compressed:

- **Attempt 1** reported "47%" from an invented scale, and compared it against a
  synth parameter that meant something different. Back-solving showed it had the
  off-beats landing *early*, which was the **onset detector's peak leading the
  attack** — a systematic detector bias, reported as a musical property.
- **Attempt 2** correctly cancelled the detector lead by taking a *difference*
  between on-beat and off-beat offsets — but differenced the wrong pair. It
  compared the "&" (steps 2/6/10/14) against the beat (0/4/8/12).
  **Sixteenth-note swing delays neither of those.** It delays the "e" and the
  "a" — the ODD 16ths. So it returned ~0 ms for every record and nearly shipped
  as "these records are all straight."
- **Attempt 3** differences odd 16ths against even 16ths. Detector lead is
  common to both and cancels; what remains is the actual delay.

**Two general rules fall out:**
1. **Systematic detector bias cancels under a difference and not under an
   average.** Design the measurement so the bias appears on both sides.
2. **Re-derive the quantity from its definition before comparing it to
   anything.** Two numbers with the same name are routinely different
   quantities.

---

## 9. One decode path, or your spectral statistics are fiction

A comparison of spectral flatness between two sets of tracks was wrong because
one side was Opus decoded at 48 kHz and the other WAV at 44.1 kHz.

Flatness — and brightness, band shares, centroid, anything computed over the
whole spectrum — **changes with Nyquist**, without a single musical thing being
different.

**Everything through one ffmpeg decode, at one rate, in mono. Do not add a fast
path that skips it.**

Related: the same project quoted the same load-bearing flatness figure in three
places with two different values, because it had never existed as a runnable
script. **A load-bearing measurement that cannot be re-run is an anecdote with a
decimal point.**

---

## 10. Validate the metric before you validate the thing it measures

Three broken metrics in a row, in one session of measuring one plugin:

- *"Time to fall 40 dB"* on a repeatedly-tapped signal measured **the gap
  between taps**, not the decay. All 24 settings returned an identical 0.13 s.
- A trough-ratio returned **exactly 1.00** on three settings, because p10 == p50
  once the envelope hit an arbitrary -60 dB floor. Not smoothness — an artefact
  of a clamp.
- A frame-to-frame dB standard deviation of **50** turned out to be near-silent
  frames exploding the logarithm.

**The checks that work:**
- Ask what the metric returns for a **degenerate input** — silence, a single
  impulse, a constant tone, a pure sine. Run those first.
- **An implausibly uniform result across genuinely different inputs is the
  tell.** 24 distinct algorithms do not share a decay time.
- Print an absolute-level sanity value beside every ratio, so a near-silent
  block cannot masquerade as a well-behaved one.

---

## 11. A model score is a ranking, not a probability

The MTG-Jamendo instrument classifier reports its own test scores as
**PR-AUC 0.20 / ROC-AUC 0.78** across 25,135 tracks. That is respectable
*ranking* performance and poor *calibration*.

So `piano = 0.31` does **not** mean 31% confidence that a piano is present. It
means this track sits high in the piano ordering relative to the rest of the
corpus you ran.

**Every threshold you set on a model output like this is a percentile of your
own corpus, not an absolute.** Move to a different corpus and your thresholds
are wrong.

---

## 12. Cache the expensive artefact, and key the cache on the file's identity

Beat tracking with `RhythmExtractor2013` costs 60-90 seconds for an 8-minute
track. Everything downstream of the beat times — which 16th a drum lands on,
swing, where the bass sits — is milliseconds.

In one evening four reference records were beat-tracked **three times** for
three different questions. **The beats of a finished record never change.**

`src/library/beatcache.py` is the pattern: cache key is
`abspath | file size | mtime`, SHA1'd. If any of those change, recompute — so
re-encoding or re-downloading a file cannot silently serve stale beats, which is
the one way a cache turns into a *wrong* answer rather than a *slow* one.

Same reasoning applies harder to source separation: an arrangement study deleted
each track's stems after measuring, to save disk, and when finer resolution was
wanted **the entire two-hour separation had to run again.**

> Separation is expensive and measurement is free. Beat tracking is expensive
> and reading a JSON is free. **Keep the expensive artefact.**

---

## 13. Analysing an excerpt biases the result; analysing the whole file biases it differently

Scoring tracks on a 60-second excerpt from the middle is deliberate: a 7-minute
record with a 2-minute ambient intro would otherwise be scored mostly on its
intro.

But excerpting has its own bias — you will systematically miss intros, outros,
breakdowns and anything that only happens once.

Related: **a whole-track band average is driven by sustained content.** A tick
that fires twice a bar cannot move a band average whatever its spectrum. If you
are asking "is there enough energy at 1-2 kHz", a percussive hit in that band is
not the answer even when its spectrum looks perfect.

**State which window you measured and why. It is a choice, not a default.**

---

## 14. A measurement describes. It does not prescribe.

*"52.4% of this record's keys energy sits in 260-520 Hz"* is a fact about where
energy is. It was turned into a rule that every chord voicing must fit inside
one octave — which produced tone clusters and sounded terrible.

Similarly: melodies generated to match the measured statistics of four
well-liked melodies (4 distinct pitches, 28% repeated notes, 1.19 notes/sec)
were rated the *worst* of three approaches. **A bar repeating one note forever
scores perfectly on all three metrics and is nothing.**

**Ask what would have to be true for a measurement to be a constraint. Usually
it isn't one.** The honest use of a target number is to check that a change
*moved*, never to optimise toward the number.

For your app: a confidence score, a chord-change rate, a "complexity" number are
all descriptions. Do not build a scoring or ranking feature on one without
asking what it would say about material you already know is good.

---

## 15. The user's localisation of a problem is a real observation and never a diagnosis

Repeatedly, in the source project: *"the bass sounds wrong"* → it was the pad.
*"the piano is out of tune"* → three rounds of piano fixes, and it was a
deliberately detuned synth pad underneath setting the pitch centre. *"the track
is too fast"* → the tempo was correct; the density was too high.

**Take the symptom seriously and the attribution loosely.** And:

> **When a fix lands and the symptom survives, re-open the attribution — do not
> apply a second fix.** Two real fixes that do not move the symptom mean you are
> looking at the wrong thing. What makes this hard is that both early fixes were
> *genuine* — each explained part of what was heard, so fixing it felt like
> progress.

This is bug-report triage advice, and it will apply to your users the day you
have any.
