# 06 — Runbook: install it, run it, understand the output

Every command here was executed on the machine that built this package
(macOS, Apple silicon, Python 3.12.7, ffmpeg 8.1). Where something failed, the
failure and the workaround are written down rather than tidied away.

---

## 0. One command

```bash
cd rares-audio-decomp
bash setup.sh
```

It checks ffmpeg, Python, five packages and twelve model files; installs what's
missing; then **verifies by generating a synthetic D-minor chord at exactly
120 BPM, analysing it, and checking that the answers come back Dm and 120** —
not by trusting that `pip` exited 0.

`bash setup.sh --check` inspects without installing anything.

Expected output when everything is present:

```
▶ 1/5  ffmpeg — every decode in this package goes through it
  ✓ ffmpeg 8.1
▶ 2/5  Python
  ✓ python3  (3.12.7)
▶ 3/5  Python packages
  ✓ numpy (2.0.1)   ✓ scipy (1.14.1)   ✓ soundfile (0.12.1)
  ✓ essentia (2.1-beta6-dev)   ✓ demucs (4.1.0)
▶ 4/5  model weights (27 MB, shipped in this package)
  ✓ all 12 model files present
▶ 5/5  verify — run it, do not trust the exit codes above
  ✓ decompose.py runs
      TEMPO     120.19 BPM   confidence 7.64
      KEY       Dm
  ✓ key = Dm on a synthetic D-minor chord
  ✓ tempo = 120.19 BPM on a 120 BPM click track
  ✓ analyse_song.py runs with the ML heads
```

---

## 1. Manual install, if you'd rather

```bash
# ffmpeg — every decode in this package goes through it, by design
brew install ffmpeg                       # macOS
sudo apt-get install -y ffmpeg            # Debian/Ubuntu

# core only — decompose.py needs nothing else
python3 -m pip install numpy scipy soundfile

# full stack
python3 -m pip install essentia-tensorflow demucs
```

**Three install gotchas, all real:**

1. **Install `essentia-tensorflow`, NOT `essentia`.** The plain package has the
   DSP but not `TensorflowPredictEffnetDiscogs`, so `models/` never loads and
   the tagging stage silently skips with a misleading message.
2. **`demucs` pulls `torch` + `torchaudio` — around 2 GB.** That's the long part
   of the install, not a hang.
3. **"No matching distribution" for `essentia-tensorflow` is a Python-version
   problem, not a network problem.** Wheels exist for a limited range; 3.10-3.12
   is the safe band. Verified working on 3.12.7.

Everything is pinned in `requirements.txt` to the versions actually in use here,
so a future breakage can be bisected against a known-good set.

---

## 2. The two entry points

### `decompose.py` — fast, minimal dependencies

```bash
python3 decompose.py song.wav
python3 decompose.py song.wav --start 30 --dur 60      # a 60 s excerpt from 0:30
python3 decompose.py song.wav --json out.json          # full result to disk
python3 decompose.py song.wav --stay 0.8               # fewer chord changes
python3 decompose.py song.wav --bpb 3                  # 3/4 time
```

Needs only numpy + soundfile + ffmpeg. Runs in ~6 s on a 60-second excerpt.
Gives tempo, beats, key, chords per bar, sections, band profile.

### `analyse_song.py` — the whole pipeline

```bash
python3 analyse_song.py song.wav                       # ~5 s, no separation
python3 analyse_song.py song.wav --separate            # + Demucs stems
python3 analyse_song.py song.wav --tags                # + ML genre/mood/instrument
python3 analyse_song.py song.wav --all                 # everything
python3 analyse_song.py song.wav --all --start 45 --dur 40
python3 analyse_song.py song.wav --all --model htdemucs_6s   # 6 stems: + piano, guitar
```

Seven stages. **Any stage whose dependency is missing is skipped with a printed
reason and recorded in the JSON — never faked.**

| stage | needs | cost (40 s excerpt, measured) |
|---|---|---|
| 1 probe + capture gate | numpy, ffmpeg | instant |
| 2 source separation | demucs | **24 s on CPU** |
| 3 beat tracking | essentia | ~3 s, then cached |
| 4 key / chords / sections | — | ~2 s |
| 5 drum grid | stems from stage 2 | instant |
| 6 bass line | stems from stage 2 | ~1 s |
| 7 ML tagging | essentia-tensorflow + `models/` | ~4 s |

Full `--all` run on a 40-second excerpt: **31 s cold, ~7 s warm.**

### Caching

Everything expensive lands in `cache/`, keyed on the input file's
**path + size + mtime**. Re-running is near-instant; re-encoding the input busts
the key, so the cache can never serve a stale answer for different audio. Delete
`cache/` to force a full recompute.

---

## 3. Reading the output

Real output, on Breakbot's *Baby I'm Yours*, 40 seconds from 0:45:

```
    excerpt cut to excerpt-e6f03da72f7482d8.wav — ALL stages now share one time base
▶ 1/7  probe + capture gate
    OK
▶ 2/7  source separation (htdemucs)
    ⚠️  demucs failed on mps: NotImplementedError: Output channels > 65536 …
    retrying on cpu…
    separated on cpu in 24 s
▶ 3/7  beat tracking
    117.97 BPM, 78 beats
▶ 4/7  key, chords, sections
    key Dm · 19 bars · 1 boundaries
▶ 5/7  drum grid (off drums stem)
    kick         182 onsets, steps [1, 5, 9, 13]
    snare_clap    78 onsets, steps [1, 5, 9, 13]
    hats         107 onsets, steps [1, 5, 7, 9, 13]
▶ 6/7  bass line (off bass stem)
    10 pitch classes: A A# B C C# D D# E G G#
▶ 7/7  ML tagging (⚠️ non-commercial models)
    top genre: Funk / Soul---Funk (0.2372)
    top instrument: synthesizer (0.4603)
```

**Four things in that output worth understanding, because three of them are
limitations and one is a bug that already got fixed:**

### `kick … steps [1, 5, 9, 13]` — right, and it wasn't at first
Four-to-the-floor: the kick on every beat. **Before a fix, this read
`[3, 7, 11, 15]`.** Beats were being tracked on the 40-second excerpt while
Demucs separated the *whole file*, so the two time bases were 45 seconds apart
and every beat index pointed at the wrong audio. Nothing errored; the bass even
returned a plausible key. **The tell was musical, not technical** — no house
record puts its kick on the "e" of every beat.

The fix is `materialise_excerpt()`: when `--start`/`--dur` are given, the
excerpt is cut to a file once and **every stage runs on that one file**. Same
principle as the single ffmpeg decode path.

### `snare_clap … steps [1, 5, 9, 13]` — this one is still wrong
A clap sits on beats 2 and 4, i.e. steps 5 and 13. Reading the kick pattern
means the 150-800 Hz band is catching the **kick's upper harmonics**. The band
split is too crude to separate them. Documented in the code; the real fix is
spectral subtraction or a transient classifier, neither of which is built.

### `10 pitch classes` — flagged in the JSON as unreliable
A bassline in one key uses 3-6 pitch classes. Ten out of twelve is the tracker
emitting noise. The JSON says so:

```json
"reliability": "⚠️ LIKELY DETECTOR NOISE: 10 of 12 pitch classes …",
"class_counts": {"D":29,"A#":12,"A":7,"C":5,"G":5,"B":2,"G#":1,"D#":1,"C#":1,"E":1}
```

**The counts are where the truth is:** D, A#, A, C, G carry it — a D-minor
bassline — and the tail of single hits is artefact. Worth knowing that the
source project's own stem analysis of this same track *also* returned 10
classes, printed it as a finding, and shipped octave errors (`D4` and `G4` in a
bass line) that nobody caught. Same detector, same weakness; the difference is
that this one says so.

### `demucs failed on mps → retrying on cpu`
Not a configuration error. On this torch build, Demucs' convolutions exceed a
Metal limit: `Output channels > 65536 not supported at the MPS device`. CPU is
slower and correct, so the code falls back automatically rather than skipping
the stage. If you have CUDA, `-d cuda` is the fast path.

---

## 4. Getting audio in

The package ships **no audio** (the source library is ~24 GB). Anything ffmpeg
can read works — wav, mp3, m4a, opus, flac.

```bash
# record straight from the default mic — the case your app actually cares about
ffmpeg -f avfoundation -i ":0" -t 30 -ac 1 -ar 44100 take.wav     # macOS
ffmpeg -f alsa -i default -t 30 -ac 1 -ar 44100 take.wav          # Linux

python3 analyse_song.py take.wav --all
```

**Do this early and often.** Everything in `src/` was tuned on mastered studio
files, and `docs/02-gaps.md` §2 is a table of what a microphone breaks. The
capture gate in stage 1 exists precisely for this input and will tell you when a
recording is not analysable — clipping, band-limiting, low headroom, too short.

---

## 5. Sanity-checking the tools themselves

```bash
python3 tests/validate_capture_gate.py                  # self-contained
python3 tests/validate_capture_gate.py your-song.wav    # + your own files
```

Self-contained — it synthesises its own signals, so it runs anywhere. It checks
the capture gate against material whose answer is known: a **dark but
full-bandwidth** chord (must NOT be flagged), the same signal through **8 kHz
and 3.4 kHz lowpasses** (must be flagged), and **degenerate inputs — silence, a
pure sine, white noise, a single impulse, 0.3 seconds, a clipped signal, DC
offset, and an empty array.** Exits non-zero on failure.

This is `docs/03-mir-lessons.md` §10 as an executable test, and it earned its
place immediately. It found **three** bugs in the gate — a crash on digital
silence, a good dark recording reported as band-limited (the metric was
measuring the *material* while claiming to measure the *capture*), and a cliff
detector that found the steepest step in the *arrangement* rather than the codec
cutoff while comparing it against a threshold above its own maximum possible
value. **It then found a fourth bug in itself**: the "dark but full-bandwidth"
fixture was built from sine pairs topping out at 440 Hz, so it *was* band-limited
and the gate was right to say so. The instinct on a red test is to change the
code; here the correct move was to fix the fixture.

None of the four would have been caught by reading the code or by testing on a
single real file.

---

## 6. Running the `src/` research scripts

**They will not run as-is.** Each hardcodes paths into the private corpus:

| path expected | what it was |
|---|---|
| `library/influences/` | ~2.9 GB of artist-foldered Opus |
| `library/inspo/stems/htdemucs/<track>/` | pre-separated stems |
| `library/audio/` | 3.3 GB of playlist tracks |
| `library/data/*.json` | cached results from prior runs |
| `library/models/*.pb` | model weights — **these ARE included, at `models/`** |

To use one, change the path constants at the top and the corpus loop in
`main()`. **The functions inside are the reusable part.** `analyse_song.py`
already lifts the ones that matter: the chroma band choice, the harmonic-series
pitch scorer, the cache key, the per-band drum onset method.

Two run without a corpus:

```bash
python3 src/library/structure.py --selftest    # proves the periodicity ladder
python3 src/library/structure.py --plan        # prints the sampling plan
```

To build your own corpus in the layout the scripts expect:

```bash
mkdir -p library/influences/SomeArtist library/data
cp /path/to/*.opus library/influences/SomeArtist/
python3 src/library/harmony.py --dir influences --n 40 --out data/harmony.json
```

Separation for the stem-based scripts:

```bash
demucs -d cpu -n htdemucs  song.wav -o library/inspo/stems/
demucs -d cpu -n htdemucs_6s song.wav -o library/inspo/stems/   # + piano, guitar
```

`src/library/run-arrangement-study.sh` is a working batch driver, including one
gotcha worth reading: `demucs` inherits stdin from the loop, so a naive
`while read` silently eats the file list. It redirects `< /dev/null`.

---

## 7. Where to go next

`docs/02-gaps.md` closes with a suggested build order. The short version:

1. **Evaluation harness** — `mir_eval` + an annotated corpus + 20 of your own
   hand-annotated mic recordings. Nothing else is measurable until this exists.
2. **Beat-synchronous chords** — cut chroma at tracked beat boundaries instead
   of at constant-BPM intervals, and get real downbeats. Biggest quality win
   available on the existing chord path.
3. **Lyrics** — Demucs vocal stem → word-timestamped ASR. Zero coverage here,
   and the most solved of your problems.
