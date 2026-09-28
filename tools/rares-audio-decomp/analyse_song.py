#!/usr/bin/env python3
"""
analyse_song.py — THE WHOLE PIPELINE, ONE FILE IN, ONE JSON OUT.

`decompose.py` is the no-dependency version: numpy + soundfile + ffmpeg, and it
works anywhere. THIS file is the full stack — source separation, a real beat
tracker, chords, per-stem drum grid and bass line, and the Discogs-EffNet
tagging heads — assembled into a single command.

    python3 analyse_song.py song.wav                    # no separation, fast
    python3 analyse_song.py song.wav --separate         # + Demucs stems  (slow)
    python3 analyse_song.py song.wav --separate --tags  # + ML genre/mood/instrument
    python3 analyse_song.py song.wav --all              # everything
    python3 analyse_song.py song.wav --all --dur 60     # first 60 s only

Everything expensive is CACHED under `cache/`, keyed on the file's
path+size+mtime, so a second run is close to instant. That is the
`beatcache.py` pattern from `src/library/` and it is the single most important
architectural habit in this package — see docs/03-mir-lessons.md §12.

STAGES, and what each one needs:

  1. probe + capture gate    numpy, soundfile, ffmpeg          always
  2. separation              demucs                            --separate
  3. beats                   essentia                          always if installed
  4. key / chords / sections decompose.py                      always
  5. drum grid               (needs stems)                     --separate
  6. bass line               (needs stems)                     --separate
  7. ML tags                 essentia-tensorflow + models/     --tags

Any stage whose dependency is missing is SKIPPED with a printed reason, never
faked. The JSON records which stages ran.

🔴 READ docs/03-mir-lessons.md BEFORE TRUSTING ANY NUMBER HERE.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import decompose as D                                          # noqa: E402

CACHE = HERE / "cache"
MODELS = HERE / "models"
NAMES = D.NAMES


# ───────────────────────────────────────────────────────────────── cache ────
def cache_key(path, tag):
    """Identity = absolute path + size + mtime. A re-encode busts the cache.

    This is the one way a cache turns into a WRONG answer rather than a slow
    one, so it is worth the four lines. From `src/library/beatcache.py`.
    """
    st = os.stat(path)
    h = hashlib.sha1(
        f"{os.path.abspath(path)}|{st.st_size}|{int(st.st_mtime)}|{tag}".encode()
    ).hexdigest()[:20]
    return CACHE / f"{tag}-{h}.json"


def cached(path, tag, fn):
    CACHE.mkdir(exist_ok=True)
    p = cache_key(path, tag)
    if p.exists():
        print(f"    (cached) {tag}")
        return json.loads(p.read_text())
    v = fn()
    if v is not None:
        p.write_text(json.dumps(v))
    return v


# ─────────────────────────────────────────────── 1. probe + capture gate ────
def capture_gate(x, sr=D.SR):
    """Is this recording good enough to analyse? Cheap, and it prevents the
    worst failure mode — confident nonsense from a bad capture.

    🔴 THIS IS THE STAGE THIS PACKAGE'S SOURCE PROJECT NEVER NEEDED and a
    mic-input app cannot do without. Everything downstream was tuned on
    mastered studio files; see docs/02-gaps.md §2 for what each of these
    conditions actually breaks.
    """
    n = len(x)
    if n < 256:
        # An empty or near-empty array crashed this with
        # "Invalid number of FFT data points (0)". Found by the degenerate-input
        # suite, not by reading the code — which is the entire argument for
        # having one.
        return {"duration_s": round(n / sr, 3), "peak": 0.0, "peak_dbfs": -400.0,
                "clipping_pct": 0.0, "noise_floor_dbfs": -400.0,
                "median_rms_dbfs": -400.0, "dynamic_headroom_db": 0.0,
                "bandwidth_hz": 0.0, "rolloff_above_bandwidth_db": 0.0,
                "energy_p995_hz": 0.0, "energy_below_100hz_pct": 0.0,
                "warnings": [f"NO USABLE AUDIO: {n} samples decoded"],
                "verdict": "1 concern(s)"}
    peak = float(np.max(np.abs(x)))
    clip_pct = 100.0 * float(np.mean(np.abs(x) > 0.999))

    # Noise floor: the 5th percentile of frame RMS. In a clean studio file this
    # sits far below the median; in a room with a fridge it does not.
    fl = 2048
    frames = x[:n - n % fl].reshape(-1, fl) if n >= fl else np.zeros((1, fl))
    rms = np.sqrt((frames ** 2).mean(axis=1) + 1e-20)
    floor_db = 20 * np.log10(np.percentile(rms, 5) + 1e-20)
    med_db = 20 * np.log10(np.median(rms) + 1e-20)
    snr_est = med_db - floor_db

    # Usable bandwidth — and this needs care, because the obvious version is
    # WRONG. A cumulative-energy percentile ("where is 99.5% of the energy")
    # returns ~880 Hz for a dark, sustained piano pad and would report a
    # perfectly good recording as band-limited. That is a metric measuring the
    # MATERIAL when it claims to measure the CAPTURE — precisely the failure
    # docs/03-mir-lessons.md §10 is about, caught by running it on a known-good
    # file and disbelieving the answer.
    #
    # What actually distinguishes a band-limited capture is a CLIFF: a codec or
    # a microphone rolls off steeply, tens of dB inside a fraction of an octave.
    # A dark instrument slopes. So look for the cliff, not for the energy.
    m = min(n, sr * 20)
    spec = np.abs(np.fft.rfft(x[:m] * np.hanning(m))) ** 2
    f = np.fft.rfftfreq(m, 1 / sr)
    total = float(spec.sum())
    lo_share = 100 * float(spec[f < 100].sum()) / (total + 1e-20)

    # Third-octave band levels from 50 Hz to Nyquist.
    edges = 50 * 2 ** (np.arange(0, 40) / 3.0)
    edges = edges[edges <= sr / 2]
    lv, ctr = [], []
    for i in range(len(edges) - 1):
        b = (f >= edges[i]) & (f < edges[i + 1])
        if b.any():
            lv.append(10 * np.log10(float(spec[b].mean()) + 1e-20))
            ctr.append(float(np.sqrt(edges[i] * edges[i + 1])))
    lv, ctr = np.array(lv), np.array(ctr)

    # BANDWIDTH = the HIGHEST band still within 50 dB of the loudest band.
    #
    # ⚠️ THE FIRST VERSION OF THIS SEARCHED FOR THE STEEPEST DROP ANYWHERE AND
    # IT WAS WRONG TWICE OVER: on a 130 kbps Opus it returned 449 Hz, because
    # the steepest third-octave step in real music is a feature of the
    # ARRANGEMENT, not the codec — and it never even looked as high as the
    # actual 15-16 kHz cutoff, because the band array stopped at 12.8 kHz.
    # Searching downward from Nyquist for where the spectrum leaves the floor
    # is the question actually being asked.
    if len(lv) > 2 and np.isfinite(lv).all() and total > 0:
        peak_lv = float(lv.max())
        alive = np.where(lv > peak_lv - 50)[0]
        bandwidth_hz = float(ctr[alive[-1]]) if len(alive) else float(ctr[-1])
        # How abruptly does it end? A codec/mic cliff falls off a shelf; an
        # instrument that is merely dark slopes away gently.
        j = int(alive[-1]) if len(alive) else len(lv) - 1
        rolloff_db = float(lv[j] - lv[-1]) if j < len(lv) - 1 else 0.0
    else:
        bandwidth_hz, rolloff_db = 0.0, 0.0

    # Where 99.5% of the energy sits. REPORTED, NEVER WARNED ON — it describes
    # the material (a dark pad reads ~880 Hz and is a perfectly good recording),
    # so it is here for information and is not evidence about the capture.
    cum = np.cumsum(spec) / (total + 1e-20)
    idx = int(np.searchsorted(cum, 0.995))
    energy_p995_hz = float(f[min(idx, len(f) - 1)])

    warns = []
    if clip_pct > 0.1:
        warns.append(f"CLIPPING: {clip_pct:.2f}% of samples at full scale — "
                     "adds broadband harmonics that read as onsets and brightness")
    if peak < 0.05:
        warns.append(f"VERY QUIET: peak {20*np.log10(peak+1e-20):.1f} dBFS — "
                     "everything downstream loses resolution")
    if snr_est < 6:
        # NOTE the honest framing. This measures the gap between the median and
        # the quietest 5% of frames, which is LOW for two very different
        # reasons: a noisy room, or continuous heavily-compressed material with
        # no gaps in it. It cannot tell them apart without a silence detector,
        # so it says so rather than picking one.
        warns.append(f"LOW DYNAMIC HEADROOM: {snr_est:.1f} dB between the median "
                     "frame and the quietest 5% — EITHER a noisy room OR simply "
                     "continuous material with no gaps. Check by ear before acting")
    # 🔴 TWO CONDITIONS, AND THE SECOND ONE IS THE WHOLE POINT.
    #
    # Bandwidth alone is not evidence: a dark sustained piano reads 3592 Hz and
    # is a perfectly good recording. What separates it from a filtered capture
    # is HOW IT ENDS — measured, the dark piano rolls off 7 dB past its own
    # edge while the same file through an 8 kHz lowpass rolls off 22 dB and
    # through a 3.4 kHz one, 121 dB. Slope versus shelf.
    #
    # ⚠️ AND THE UPPER BOUND IS REAL: analysis runs at SR=22050, so the top
    # third-octave centre available is ~9 kHz. A 15-16 kHz codec cutoff CANNOT
    # BE SEEN AT THIS SAMPLE RATE AT ALL — the first version of this check
    # compared against 10 kHz, which is above the highest value the measurement
    # can ever return, so it fired on every file including a clean one.
    if bandwidth_hz and bandwidth_hz < 8000 and rolloff_db >= 20:
        warns.append(f"BAND-LIMITED CAPTURE: energy stops at ~{bandwidth_hz:.0f} Hz "
                     f"and falls {rolloff_db:.0f} dB beyond it — that shelf is a codec "
                     "or a microphone, not the instrument. Treat every HF measurement "
                     "above it as meaningless")
    if lo_share < 1.0:
        warns.append(f"NO LOW END: {lo_share:.2f}% of energy below 100 Hz — "
                     "bass-note detection will not work on this recording")
    if len(x) / sr < 15:
        warns.append(f"SHORT: {len(x)/sr:.1f} s — too little for stable "
                     "tempo/key estimates; treat every number as provisional")

    return {"duration_s": round(n / sr, 2), "peak": round(peak, 4),
            "peak_dbfs": round(20 * np.log10(peak + 1e-20), 2),
            "clipping_pct": round(clip_pct, 4),
            "noise_floor_dbfs": round(floor_db, 2),
            "median_rms_dbfs": round(med_db, 2),
            "dynamic_headroom_db": round(snr_est, 2),
            "bandwidth_hz": round(bandwidth_hz, 1),
            "rolloff_above_bandwidth_db": round(rolloff_db, 1),
            "energy_p995_hz": round(energy_p995_hz, 1),
            "energy_below_100hz_pct": round(lo_share, 3),
            "warnings": warns,
            "verdict": "OK" if not warns else f"{len(warns)} concern(s)"}


# ────────────────────────────────────────────────────────── 2. separation ────
def separate(path, model="htdemucs", device=None, out_root=None):
    """Demucs → drums / bass / other / vocals.

    🔴 THE HIGHEST-LEVERAGE STAGE IN THE WHOLE PIPELINE. Measured in the source
    project: a pitch tracker returned 11 chromatic pitch classes off a full mix
    and 7 diatonic ones off a separated stem — "the difference between a table
    of noise and a readable one." It is also what makes lyrics transcription
    work at all. See docs/03-mir-lessons.md §4.

    ⚠️ SLOW. ~2:19 per track for the 6-stem model on an M-series Mac. This is
    why the output directory is reused rather than regenerated, and why the
    source project's rule is: keep the expensive artefact, never delete stems.
    """
    if out_root is None:
        out_root = CACHE / "stems"
    out_root = Path(out_root)
    stem_dir = out_root / model / Path(path).stem
    if stem_dir.exists() and any(stem_dir.glob("*.wav")):
        print(f"    (cached) stems at {stem_dir}")
        return stem_dir
    if device is None:
        device = "mps" if sys.platform == "darwin" else "cpu"
    out_root.mkdir(parents=True, exist_ok=True)
    # ⚠️ MPS FALLS OVER ON SOME TORCH BUILDS. Measured here, on torch 2.6.0.dev:
    #    "NotImplementedError: Output channels > 65536 not supported at the MPS
    #    device". It is a torch/Metal limitation in the demucs convolutions, not
    #    a demucs bug and not something a flag fixes. CPU works and is slower.
    # So: try the fast device, and fall back rather than returning nothing. A
    # slow correct answer beats a skipped stage.
    for dev in ([device, "cpu"] if device != "cpu" else ["cpu"]):
        cmd = ["demucs", "-d", dev, "-n", model, "-o", str(out_root), str(path)]
        print(f"    running: {' '.join(cmd)}")
        t0 = time.time()
        r = subprocess.run(cmd, capture_output=True, text=True,
                           stdin=subprocess.DEVNULL)
        if r.returncode == 0:
            print(f"    separated on {dev} in {time.time()-t0:.0f} s")
            return stem_dir if stem_dir.exists() else None
        tail = r.stderr.strip().splitlines()[-1] if r.stderr.strip() else "(no stderr)"
        print(f"    ⚠️  demucs failed on {dev}: {tail}")
        if dev != "cpu":
            print("    retrying on cpu…")
    return None


# ─────────────────────────────────────────────────────────────── 3. beats ────
def beats_of(path, start, dur):
    def go():
        b = D.beats_essentia(path, start, dur)
        if not b:
            return None
        return {"bpm": b["bpm"], "beats": [float(x) for x in b["beats"]],
                "confidence": b["confidence"]}
    return cached(path, f"beats-{start}-{dur}", go)


# ──────────────────────────────────────────── 5. drum grid off the stem ────
def drum_grid(stem_dir, beats, bpm):
    """Which 16th does each drum land on? Onset detection per frequency band on
    an ISOLATED drums stem — per `groove-extract.py`, "about as solid as MIR
    gets", and only because the stem is isolated.

    Bands are the standard three: kick 30-120 Hz, snare/clap 150-800 Hz (the
    body, not the crack, which overlaps the hats), hats 6-14 kHz.

    ⚠️ THE PHASE PROBLEM. `beats` are BEATS, not DOWNBEATS. The 16th position
    WITHIN a beat is correct; which beat is beat 1 of the bar is not
    established. So this reports a 16-step grid whose ROTATION may be wrong.
    See docs/03-mir-lessons.md §5.
    """
    f = stem_dir / "drums.wav"
    if not f.exists() or len(beats) < 8:
        return None
    x, sr = sf.read(f)
    if x.ndim > 1:
        x = x.mean(axis=1)

    n, hop = 1024, 256
    win = np.hanning(n)
    spec = np.array([np.abs(np.fft.rfft(x[i:i + n] * win))
                     for i in range(0, len(x) - n, hop)])
    freqs = np.fft.rfftfreq(n, 1 / sr)
    fps = sr / hop

    out = {}
    for name, (lo, hi) in (("kick", (30, 120)), ("snare_clap", (150, 800)),
                           ("hats", (6000, 14000))):
        # ⚠️ THE SNARE/CLAP BAND CATCHES KICK HARMONICS. Measured on a house
        # record: this band reported hits on 1/5/9/13, i.e. the kick pattern,
        # because a kick's upper harmonics live at 150-800 Hz too. A clap on
        # beats 2 and 4 should read 5 and 13 alone. Treat `snare_clap` as
        # UNRELIABLE where a strong four-to-the-floor kick is present — the
        # proper fix is spectral subtraction of the kick band or a transient
        # classifier, neither of which is built here.
        b = (freqs >= lo) & (freqs < hi)
        env = spec[:, b].sum(axis=1)
        flux = np.maximum(np.diff(env), 0)
        if flux.max() <= 0:
            continue
        flux = flux / flux.max()
        thr = flux.mean() + 1.5 * flux.std()
        onsets = [i / fps for i in range(1, len(flux) - 1)
                  if flux[i] > thr and flux[i] >= flux[i - 1] and flux[i] > flux[i + 1]]
        # Fold each onset onto a 16-step grid built from the actual beat times,
        # so a drifting tempo does not smear the histogram.
        hist = np.zeros(16)
        beats = np.asarray(beats)
        for t in onsets:
            j = int(np.searchsorted(beats, t)) - 1
            if j < 0 or j + 1 >= len(beats):
                continue
            frac = (t - beats[j]) / max(beats[j + 1] - beats[j], 1e-9)
            step = (j % 4) * 4 + int(round(frac * 4)) % 4
            hist[step % 16] += 1
        if hist.sum() == 0:
            continue
        pct = (100 * hist / hist.sum()).round(1)
        out[name] = {"onsets": len(onsets),
                     "per_16th_pct": pct.tolist(),
                     "struck_steps": [i + 1 for i in range(16) if pct[i] >= 5.0]}
    return out or None


# ────────────────────────────────────────────── 6. bass line off the stem ────
def bass_notes(stem_dir, beats):
    """Note per beat off the isolated bass stem.

    THE DEFENCES, all from `src/library/bassline.py`, and each one is load-
    bearing (docs/03-mir-lessons.md §3):
      · band-limit to 35-180 Hz first, or pads and low mids vote;
      · score each candidate f0 on ITS OWN harmonic series — autocorrelation
        period-doubles on a weak fundamental with strong partials, which is
        exactly what a bass note is;
      · report the PITCH CLASS as well as the octave, because pitch classes
        survive an octave error and absolute pitches do not.
    """
    f = stem_dir / "bass.wav"
    if not f.exists() or len(beats) < 4:
        return None
    x, sr = sf.read(f)
    if x.ndim > 1:
        x = x.mean(axis=1)

    # Band-limit: naive FFT brick-wall is fine here, this is analysis not audio.
    N = 1 << (len(x) - 1).bit_length()
    X = np.fft.rfft(x, N)
    fr = np.fft.rfftfreq(N, 1 / sr)
    X[(fr < 35) | (fr > 400)] = 0                # keep partials up to 400 for scoring
    xb = np.fft.irfft(X, N)[:len(x)]

    notes = []
    for j in range(min(len(beats) - 1, 64)):
        a, b = int(beats[j] * sr), int(beats[j + 1] * sr)
        seg = xb[a:b]
        if len(seg) < 512 or np.sqrt((seg ** 2).mean()) < 1e-4:
            notes.append(None)
            continue
        w = seg * np.hanning(len(seg))
        S = np.abs(np.fft.rfft(w, 1 << 15)) ** 2
        ff = np.fft.rfftfreq(1 << 15, 1 / sr)
        best, best_score = None, 0.0
        for midi in range(24, 60):                       # C1..B3
            f0 = 440.0 * 2 ** ((midi - 69) / 12)
            if f0 < 35 or f0 > 250:
                continue
            # Score on this candidate's OWN harmonic series...
            score, first_partial = 0.0, 0.0
            for h in range(1, 6):
                k = np.argmin(np.abs(ff - f0 * h))
                e = float(S[max(k - 2, 0):k + 3].sum())
                score += e / h
                if h == 2:
                    first_partial = e
            # ...and reject any candidate with a hole at its own first partial.
            # This is the fix that made 81 disagreeing samples agree.
            if first_partial <= 0:
                continue
            if score > best_score:
                best_score, best = score, midi
        notes.append(best)

    named = [f"{NAMES[m % 12]}{m // 12 - 1}" if m else "-" for m in notes]
    from collections import Counter
    cnt = Counter(NAMES[m % 12] for m in notes if m)
    classes = sorted(cnt)
    out = {"note_per_beat": named,
           "distinct_pitch_classes": classes,
           "n_classes": len(classes),
           "class_counts": dict(cnt.most_common()),
           "caveat": "octave figures are the least reliable part — read the "
                     "pitch CLASSES (see docs/03-mir-lessons.md §3)"}

    # 🔴 A PLAUSIBILITY CHECK ON OUR OWN OUTPUT, because this one is weak and
    # saying so is the whole point of the package.
    #
    # A bass line in one key uses roughly 3-6 pitch classes. Ten out of twelve
    # means the tracker is emitting noise, not that the bassist is playing
    # chromatically. The source project's own stem analysis of this same track
    # returned 10 classes as well and printed it as a finding — with `D4` and
    # `G4` sitting in a BASS line, which are octave errors nobody caught.
    #
    # So the check is stated here rather than left for the reader to notice.
    if len(classes) > 7:
        out["reliability"] = (
            f"⚠️ LIKELY DETECTOR NOISE: {len(classes)} of 12 pitch classes. A "
            "bassline in one key normally uses 3-6. Trust the top few by count "
            "and treat the tail as artefact — or improve this stage before "
            "using it (docs/02-gaps.md §5)")
    else:
        out["reliability"] = f"{len(classes)} pitch classes — plausible for one key"
    return out


# ───────────────────────────────────────────────────────────── 7. ML tags ────
def ml_tags(path, top=15):
    """Discogs-EffNet embedding + genre / mood / instrument heads.

    ⚠️ LICENCE: Essentia is AGPL-3.0 and every model in `models/` is
    CC BY-NC-SA 4.0 (NON-COMMERCIAL). Read docs/04-licensing.md before this
    goes into a product.

    ⚠️ READ EVERY NUMBER AS A RANKING, NOT A PROBABILITY. The instrument head's
    own metadata reports PR-AUC 0.20 / ROC-AUC 0.78. "piano = 0.31" means this
    track sits high in the piano ordering, not 31% confidence.
    """
    if not (MODELS / "discogs-effnet-bs64-1.pb").exists():
        print("    skipped: models/ is missing — see docs/05-setup.md")
        return None
    try:
        from essentia.standard import (MonoLoader, TensorflowPredict2D,
                                       TensorflowPredictEffnetDiscogs)
    except Exception as e:                                     # noqa: BLE001
        print(f"    skipped: essentia-tensorflow not available ({e})")
        return None

    audio = MonoLoader(filename=str(path), sampleRate=16000, resampleQuality=4)()
    emb = TensorflowPredictEffnetDiscogs(
        graphFilename=str(MODELS / "discogs-effnet-bs64-1.pb"),
        output="PartitionedCall:1")(audio)

    # 🔴 THE HEADS DO NOT SHARE INPUT/OUTPUT NODE NAMES, and assuming they did
    # crashed this stage on the second head it tried. The Discogs-400 genre
    # graph exposes `serving_default_model_Placeholder` / `PartitionedCall:0`;
    # the MTG-Jamendo mood and instrument graphs expose `model/Placeholder` /
    # `model/Sigmoid`. Same publisher, same embedding, different graph.
    #
    # This is the "a parameter's name is not its behaviour" rule from the source
    # project, one level up: a MODEL'S INTERFACE IS NOT INHERITED FROM ITS
    # SIBLING. So try the known pairs and use whichever configures, instead of
    # hardcoding one and hoping.
    NODE_PAIRS = [("serving_default_model_Placeholder", "PartitionedCall:0"),
                  ("model/Placeholder", "model/Sigmoid"),
                  ("model/Placeholder", "model/Softmax")]

    def load_head(pb):
        errs = []
        for inp, out in NODE_PAIRS:
            try:
                return TensorflowPredict2D(graphFilename=str(MODELS / pb),
                                           input=inp, output=out)
            except Exception as e:                             # noqa: BLE001
                errs.append(f"{inp}->{out}")
        print(f"    ⚠️  {pb}: no known node pair worked (tried {', '.join(errs)})")
        return None

    def head(pb, js):
        m = load_head(pb)
        if m is None:
            return None
        meta = json.load(open(MODELS / js))
        p = m(emb).mean(axis=0)
        order = np.argsort(p)[::-1][:top]
        return [{"label": meta["classes"][i], "score": round(float(p[i]), 4)}
                for i in order]

    out = {"genre": head("genre_discogs400-discogs-effnet-1.pb",
                         "genre_discogs400-discogs-effnet-1.json"),
           "mood_theme": head("mtg_jamendo_moodtheme-discogs-effnet-1.pb",
                              "mtg_jamendo_moodtheme-discogs-effnet-1.json"),
           "instrument": head("mtg_jamendo_instrument-discogs-effnet-1.pb",
                              "mtg_jamendo_instrument-discogs-effnet-1.json")}

    # The four binary heads have no .json — index 0 is the positive class.
    binaries = {}
    for n in ("danceability", "mood_happy", "mood_sad", "mood_relaxed",
              "mood_aggressive"):
        if not (MODELS / f"{n}-discogs-effnet-1.pb").exists():
            continue
        m = load_head(f"{n}-discogs-effnet-1.pb")
        if m is None:
            continue
        binaries[n] = round(float(m(emb).mean(axis=0)[0]), 4)
    out["binary"] = binaries
    out["caveat"] = ("rankings, not probabilities; 'Organic House' and most "
                     "post-2015 subgenres are NOT in the 400-class vocabulary, "
                     "so their absence is not evidence")
    return out


# ────────────────────────────────────────────────────────────────── main ────
def materialise_excerpt(path, start, dur):
    """If an excerpt was requested, CUT IT TO A FILE and run everything on that.

    🔴 THIS FIXES A REAL BUG THAT SHIPPED PLAUSIBLE OUTPUT, which is the worst
    kind. Beats were tracked on the excerpt (t=0 at 45 s into the record) while
    Demucs separated the WHOLE file (t=0 at the start). The two time bases were
    45 seconds apart, so every beat time indexed into the wrong place in the
    drums and bass stems.

    The tell was musical, not technical: the kick came back on 16th-note steps
    3, 7, 11, 15. A four-to-the-floor house record puts its kick on 1, 5, 9, 13.
    Nothing errored, the bass line even came back with a plausible six pitch
    classes in the right key — the numbers were well-formed and measured against
    the wrong 40 seconds of audio.

    This is the source project's "a gain table is only valid against what it was
    measured against" rule, in the time domain. **One file, one time base, every
    stage.** Same principle as the single ffmpeg decode path.
    """
    if not start and dur is None:
        return path, False
    CACHE.mkdir(exist_ok=True)
    st = os.stat(path)
    h = hashlib.sha1(f"{os.path.abspath(path)}|{st.st_size}|{int(st.st_mtime)}"
                     f"|{start}|{dur}".encode()).hexdigest()[:16]
    out = CACHE / f"excerpt-{h}.wav"
    if not out.exists():
        cmd = ["ffmpeg", "-y", "-v", "error"]
        if start:
            cmd += ["-ss", str(start)]
        if dur:
            cmd += ["-t", str(dur)]
        cmd += ["-i", str(path), "-ac", "2", str(out)]
        subprocess.run(cmd, check=True, capture_output=True)
    print(f"    excerpt cut to {out.name} — ALL stages now share one time base")
    return str(out), True


def run(path, start=0.0, dur=None, do_sep=False, do_tags=False,
        bpb=4, stay=0.55, model="htdemucs"):
    source = str(path)
    result = {"file": source, "stages_run": [], "stages_skipped": {}}

    # Everything downstream runs on ONE file with ONE time base. Once the
    # excerpt is cut, start/dur are consumed and must not be applied again.
    path, is_excerpt = materialise_excerpt(source, start, dur)
    if is_excerpt:
        result["excerpt"] = {"source": source, "start_s": start, "duration_s": dur,
                             "materialised_to": path,
                             "note": "all stages ran on this cut, t=0 is the cut point"}
        start, dur = 0.0, None

    print(f"\n▶ 1/7  probe + capture gate")
    x = D.load(path, start, dur)
    result["capture"] = capture_gate(x)
    result["stages_run"].append("capture")
    for w in result["capture"]["warnings"]:
        print(f"    ⚠️  {w}")
    if not result["capture"]["warnings"]:
        print("    OK")

    stem_dir = None
    if do_sep:
        print(f"▶ 2/7  source separation ({model})")
        stem_dir = separate(path, model)
        if stem_dir:
            result["stems"] = str(stem_dir)
            result["stages_run"].append("separation")
        else:
            result["stages_skipped"]["separation"] = "demucs unavailable or failed"
    else:
        result["stages_skipped"]["separation"] = "not requested (--separate)"
        print("▶ 2/7  source separation — skipped (--separate to enable)")

    print("▶ 3/7  beat tracking")
    bt = beats_of(path, start, dur)
    if bt:
        bpm, beats = bt["bpm"], np.array(bt["beats"])
        result["beats"] = {"source": "essentia RhythmExtractor2013",
                           "bpm": round(bpm, 2), "confidence": round(bt["confidence"], 3),
                           "count": len(beats),
                           "warning": "BEATS, not DOWNBEATS — bar 1 is not established"}
        result["stages_run"].append("beats")
    else:
        flux, fps = D.onset_flux(x)
        bpm = D.tempo_of(flux, fps)["bpm"]
        beats = D.beats_from_flux(flux, fps, bpm)
        result["beats"] = {"source": "onset-comb fallback — ASSUMES CONSTANT TEMPO",
                           "bpm": round(bpm, 2), "count": len(beats),
                           "warning": "BEATS, not DOWNBEATS; and constant-tempo assumed"}
        result["stages_skipped"]["essentia_beats"] = "essentia not installed"
    print(f"    {result['beats']['bpm']} BPM, {result['beats']['count']} beats")

    print("▶ 4/7  key, chords, sections")
    flux, fps_f = D.onset_flux(x)
    result["tempo"] = D.tempo_of(flux, fps_f)
    chroma, fps_c = D.chroma_frames(x)
    k1 = D.key_krumhansl(chroma)
    k2 = D.key_essentia(path, start, dur)
    result["key"] = {"krumhansl_midband": k1, "essentia_edma": k2}
    if k2:
        agree = k1["key"] == k2["key"]
        result["key"]["agreement"] = agree
        result["key"]["verdict"] = (k1["key"] if agree else
                                    f"DISPUTED: {k1['key']} vs {k2['key']} — do not present as fact")
    else:
        result["key"]["verdict"] = f"{k1['key']} (SINGLE ESTIMATOR)"
    result["chords"] = D.chords_per_bar(chroma, fps_c, bpm, bpb, stay)
    result["sections"] = D.sections(chroma, fps_c, bpm, beats_per_bar=bpb)
    result["bands_pct"] = D.band_profile(x)
    result["stages_run"] += ["key", "chords", "sections"]
    print(f"    key {result['key']['verdict']} · {len(result['chords'])} bars · "
          f"{len(result['sections'])} boundaries")

    if stem_dir is not None and len(beats):
        print("▶ 5/7  drum grid (off drums stem)")
        g = drum_grid(stem_dir, beats, bpm)
        if g:
            result["drum_grid"] = g
            result["stages_run"].append("drum_grid")
            for k, v in g.items():
                print(f"    {k:<11} {v['onsets']:>4} onsets, steps {v['struck_steps']}")
        else:
            result["stages_skipped"]["drum_grid"] = "no usable drums stem"

        print("▶ 6/7  bass line (off bass stem)")
        bn = bass_notes(stem_dir, beats)
        if bn:
            result["bass"] = bn
            result["stages_run"].append("bass")
            print(f"    {bn['n_classes']} pitch classes: {' '.join(bn['distinct_pitch_classes'])}")
        else:
            result["stages_skipped"]["bass"] = "no usable bass stem"
    else:
        result["stages_skipped"]["drum_grid"] = "needs --separate"
        result["stages_skipped"]["bass"] = "needs --separate"
        print("▶ 5/7  drum grid — skipped (needs --separate)")
        print("▶ 6/7  bass line — skipped (needs --separate)")

    if do_tags:
        print("▶ 7/7  ML tagging (⚠️ non-commercial models)")
        # Every optional stage is wrapped. A crash here used to take the whole
        # run down AFTER the expensive stages had already succeeded, throwing
        # away separation and beat tracking to report a TensorFlow node name.
        try:
            t = ml_tags(path)
        except Exception as e:                                 # noqa: BLE001
            print(f"    ⚠️  ML tagging failed: {e}")
            t = None
        if t:
            result["ml_tags"] = t
            result["stages_run"].append("ml_tags")
            print(f"    top genre: {t['genre'][0]['label']} ({t['genre'][0]['score']})")
            print(f"    top instrument: {t['instrument'][0]['label']} "
                  f"({t['instrument'][0]['score']})")
        else:
            result["stages_skipped"]["ml_tags"] = "models or essentia-tensorflow missing"
    else:
        result["stages_skipped"]["ml_tags"] = "not requested (--tags)"
        print("▶ 7/7  ML tagging — skipped (--tags to enable)")

    return result


def main():
    ap = argparse.ArgumentParser(description="Full decomposition pipeline, one file.")
    ap.add_argument("audio")
    ap.add_argument("--separate", action="store_true", help="run Demucs (slow)")
    ap.add_argument("--tags", action="store_true", help="run the ML tagging heads")
    ap.add_argument("--all", action="store_true", help="--separate --tags")
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--dur", type=float, default=None)
    ap.add_argument("--bpb", type=int, default=4, help="beats per bar")
    ap.add_argument("--stay", type=float, default=0.55,
                    help="chord Viterbi self-transition; higher = fewer changes")
    ap.add_argument("--model", default="htdemucs",
                    help="demucs model (htdemucs | htdemucs_6s)")
    ap.add_argument("--json", default=None, help="where to write the result")
    a = ap.parse_args()

    r = run(a.audio, a.start, a.dur, a.separate or a.all, a.tags or a.all,
            a.bpb, a.stay, a.model)

    out = a.json or f"{Path(a.audio).stem}-analysis.json"
    Path(out).write_text(json.dumps(r, indent=2))
    print(f"\n  ran:     {', '.join(r['stages_run'])}")
    if r["stages_skipped"]:
        print("  skipped:")
        for k, v in r["stages_skipped"].items():
            print(f"    {k}: {v}")
    print(f"\n  → {out}\n")


if __name__ == "__main__":
    main()
