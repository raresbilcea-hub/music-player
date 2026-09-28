# Audio decomposition toolkit — handoff to Rares

**From:** Paul's music-production project
**For:** a music transcription app — record a song via microphone, get back
chords, lyrics and structure
**Date:** 12 August 2026

---

## What this is

Over about ten days of building electronic music with AI agents, this project
accumulated a working body of audio-analysis code: chord recognition, key and
tempo detection, beat and downbeat tracking, source separation, structural
segmentation, bass-line and melody extraction, groove and swing measurement,
loudness and spectral analysis. It was all built for a different purpose — to
analyse a 640-track reference library in order to *make* records — but a large
part of it is exactly the decomposition layer a transcription app needs.

This package is that code, plus honest documentation of what works, what
doesn't, and what is missing for your specific use case.

**What you are getting that has real value, in order:**

0. **`setup.sh` then `docs/06-runbook.md`** — the whole thing runs out of the
   box, weights included. Start there if you want to see output before reading.
1. **`docs/03-mir-lessons.md`** — fifteen documented ways an audio analysis
   returns a confident, plausible, wrong answer, each one learned by shipping it
   and getting caught. **This is the most valuable file here** and it is worth
   reading even if you use none of the code. Music information retrieval has an
   unusually nasty property: when it fails, nothing raises, nothing looks wrong,
   and the output is entirely believable.
2. **`decompose.py`** — a working, tested, single-file analyser. Point it at any
   audio file and get tempo, key, chords per bar and structural boundaries, with
   confidence figures attached to each.
3. **`docs/02-gaps.md`** — an honest audit of the distance between this code and
   your product, with a suggested build order.
4. **`src/`** — twenty-five research scripts, verbatim. They won't run without
   their private 640-track corpus, but their docstrings are unusually candid
   about method and limits.
5. **`docs/04-licensing.md`** — **read this before writing any code.** Two of
   the best tools in this package are AGPL and non-commercial respectively, and
   both would be blockers for a commercial product.

---

## What this is NOT

Said plainly so nobody wastes a week finding out:

- **There is no lyrics capability whatsoever.** Not partial — zero. No file here
  touches speech or language. `docs/02-gaps.md` §1 lays out the pipeline to
  build, and it is the most solved of your problems.
- **It has never seen a microphone recording.** Every assumption in this code is
  about a mastered, click-tracked, full-bandwidth studio file. Room reverb,
  automatic gain control, band-limited phone mics and a human playing without a
  click each break something specific. `docs/02-gaps.md` §2 is a table of what
  breaks and why.
- **There is no evaluation, no ground truth and no accuracy number for
  anything.** The source project had one user who could hear, and that was the
  test. For a product it isn't, and closing that gap is the first thing I would
  do.
- **Nothing is real-time.** Beat tracking is 60-90 s for an 8-minute file;
  separation is minutes. The architecture is batch, with aggressive caching of
  the expensive artefacts.

---

## Sixty-second start

```bash
cd rares-audio-decomp
bash setup.sh                              # installs, then VERIFIES by analysing
                                           # a synthetic Dm/120 BPM signal
python3 decompose.py    your-recording.wav        # fast path
python3 analyse_song.py your-recording.wav --all  # everything
```

`setup.sh` checks ffmpeg, Python, five packages and twelve model files, installs
what is missing, and then proves it works by generating a D-minor chord at
exactly 120 BPM, analysing it, and **checking the answers come back Dm and 120**
— rather than trusting that `pip` exited 0.

**The model weights are in the box** (`models/`, 27 MB, twelve files), so the
full pipeline — separation, beats, chords, drum grid, bass line and ML tagging —
runs without downloading anything. ⚠️ They are non-commercial; see
`docs/04-licensing.md`.

Full runbook, with real output and what each number means:
**`docs/06-runbook.md`**.

---

## Contents

```
README.md                     you are here
setup.sh                      install + VERIFY. run this first
requirements.txt              exact versions verified working
decompose.py                  minimal analyser: numpy + soundfile + ffmpeg
analyse_song.py               the WHOLE pipeline, one file in, one JSON out
models/                       27 MB of pretrained weights (⚠️ non-commercial)
tests/validate_capture_gate.py   metric sanity checks on degenerate inputs

docs/
  00-manifest.md              every file in the source project, IN or OUT with a
                              reason, and what each model weight is for
  01-inventory.md             every script: what it does, how far to trust it
  02-gaps.md                  what's missing for your app, and a build order
  03-mir-lessons.md           🔴 the failure catalogue — read this first
  04-licensing.md             AGPL and non-commercial blockers
  05-setup.md                 dependencies, and how to run the src/ scripts
  06-runbook.md               🟢 every command, real output, and what the
                              numbers actually mean

src/library/                  corpus-analysis scripts (chords, structure,
                              groove, bass, melody, tagging, spectral)
src/pipeline/                 sample and render measurement (pitch verification,
                              LUFS/bands, instrument surveying)

examples/
  breakbot-stems.txt          real stem-derived output: chord per bar with
                              runner-up and score, bass note per beat
  decompose-output-breakbot.json    the JSON schema decompose.py emits
```

---

## Notes for the AI agent reading this

If you are Codex, Claude Code or similar and someone has handed you this
directory, some orientation:

**Read `docs/03-mir-lessons.md` in full before writing or modifying any analysis
code.** It is not background — it is a list of specific traps, most of which are
invisible to testing because the wrong output is well-formed. Several of them
are already avoided in this code in ways that look arbitrary until you know why
(the 150-1400 Hz chroma band, the single ffmpeg decode path, the harmonic-series
pitch scorer, differencing odd against even 16ths).

**Three things here run; the `src/` scripts do not.** `setup.sh`,
`decompose.py` and `analyse_song.py` are self-contained and need no external
data — start by running them. Everything under `src/` references a private
640-track library that is not in this zip, so do not spend cycles trying to
execute it; read it for the methods and lift the functions you need.

**Do not delete the caveats.** These files are full of docstrings saying "this
number is a floor, not a target", "DO NOT USE this column", "reported with a
spread, not as a single number", and "this is a hypothesis, not a finding". They
are there because each one was learned the hard way. When you refactor, carry
the warning with the code.

**Verify before asserting.** Two rules from the source project that apply
directly to this material:
- *Reason from the thing, not from a description of the thing.* A field name, a
  selector match or a summary is not evidence about the audio. Measure the
  rendered output, not the source that produced it.
- *When a fix lands and the symptom survives, re-open the attribution rather
  than applying a second fix.* Two real fixes that don't move the problem mean
  you're looking at the wrong thing.

**Check licences before adopting anything.** `docs/04-licensing.md` marks its
own confidence per item, and several entries are explicitly unverified. Treat
those as research tasks, not as facts.

---

## A note on where this came from

The source project's central constraint was that the AI building it **cannot
hear.** Every judgement had to be made from numbers — LUFS, spectral balance,
onset timing, pitch measurement — with a trained musician as the only ground
truth in the loop.

That constraint is why the documentation is the way it is. When you cannot
verify anything by listening, you learn very quickly which measurements lie to
you, and you write it down. That accumulated caution is what is actually being
handed over here. The code is replaceable; the catalogue of ways it goes wrong
is not.
