#!/usr/bin/env python3
"""
danceability.py — WHAT IS "DANCEY", MECHANICALLY? And why do his records sit at
the 17th percentile of his own library while everything on House Inspo is at the
ceiling?

*Paul, 12 August 2026: "measure the danceability gap. I also want to understand
what danceability IS in this genre of my House inspo tracks, so that we can
recreate some backing for the piano."*

WHY THIS FILE EXISTS RATHER THAN A LOOKUP
─────────────────────────────────────────
`tag-ml2.py` reports a **danceability** number from an MTG-Jamendo head on the
Discogs-EffNet embedding. It is one opinion from one black box, and the whole
finding rests on it:

    The Deepest 0.942 · Without Asking 0.941   -> 17th percentile of his library
    House Inspo house tracks: median 0.997, MINIMUM 0.819

**A number that load-bearing has to be checked before anything is built on it**,
and this repo has three logged cases of a metric that was measuring something
other than its name. So this does two independent things:

1. **A SECOND OPINION.** Essentia's `Danceability` is a completely different
   algorithm — detrended fluctuation analysis over the loudness envelope, no
   neural net, no training set. If the two agree, the finding is real. If they
   disagree, the finding is about a model and not about the music.

2. **DECOMPOSE IT INTO THINGS WE CAN BUILD.** A score is useless for making a
   backing track. These features are all things `compose.py` can directly
   control, which is the point:

   | feature | what it is | the dial it maps to |
   |---|---|---|
   | `beat_conf` | RhythmExtractor2013's own confidence | how unambiguous the pulse is |
   | `beat_punch` | loudness AT beats vs between them | kick level, transient shape |
   | `low_lock` | 40-120 Hz envelope autocorrelation at the beat period | four-on-the-floor regularity |
   | `onset_rate` | onsets per second | percussion density |
   | `perc_ratio` | percussive energy / total, via HPSS | drums vs pads |
   | `crest` | peak / RMS in dB | how compressed it is |
   | `sub_share` | share of energy under 120 Hz | low-end weight |

⚠️ **EXCERPT, NOT WHOLE FILE.** 60 s from the middle. A 7-minute record with a
2-minute ambient intro would otherwise be scored mostly on its intro, which is
exactly the mistake that would flatter the playlist and punish his own records.
Stated because it changes the numbers.

Run:
    python3 danceability.py --dirs inspo ownrec          # the comparison
    python3 danceability.py --dirs audio --n 200 --out data/dance-lib.json
"""
import argparse
import json
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
SR = 44100
EXCERPT_S = 60.0


def load(path, sr=SR, seconds=EXCERPT_S):
    """Mono, middle `seconds`. Essentia's loader resamples for us."""
    import essentia.standard as es
    x = es.MonoLoader(filename=str(path), sampleRate=sr)()
    if len(x) > seconds * sr:
        mid = len(x) // 2
        half = int(seconds * sr / 2)
        x = x[mid - half: mid + half]
    return np.asarray(x, dtype=np.float32)


def band_env(x, lo, hi, sr=SR, hop=512):
    """RMS envelope of one band, at `hop` resolution."""
    from scipy.signal import butter, sosfiltfilt
    sos = butter(4, [lo / (sr / 2), min(hi / (sr / 2), 0.99)], btype="band", output="sos")
    y = sosfiltfilt(sos, x)
    n = len(y) // hop
    return np.sqrt((y[:n * hop].reshape(n, hop) ** 2).mean(axis=1) + 1e-12)


def measure(path):
    import essentia.standard as es
    x = load(path)
    out = {}

    # ── 1. the two independent danceability opinions ────────────────────────
    # Essentia's DFA-based one. Its scale is roughly 0-3; higher = more dancey.
    try:
        d, _ = es.Danceability()(x)
        out["dance_dfa"] = float(d)
    except Exception as e:
        out["dance_dfa"] = None
        out["dance_dfa_err"] = str(e)[:60]

    # ── 2. rhythm: a REAL tempo, not the ten-bin estimator in analyse.py ────
    bpm, beats, conf, _, _ = es.RhythmExtractor2013(method="multifeature")(x)
    out["bpm"] = float(bpm)
    out["beat_conf"] = float(conf)          # 0 = no pulse, >3.5 = very strong
    out["n_beats"] = int(len(beats))

    # ── 3. beat punch — how much louder is a beat than the gaps around it ───
    hop = 512
    env = band_env(x, 20, 20000, hop=hop)
    t = np.arange(len(env)) * hop / SR
    if len(beats) > 4:
        idx = np.clip((np.asarray(beats) * SR / hop).astype(int), 0, len(env) - 1)
        on = env[idx]
        off = np.delete(env, idx)
        out["beat_punch"] = float(20 * np.log10(on.mean() / (off.mean() + 1e-12)))
    else:
        out["beat_punch"] = None

    # ── 4. low_lock — is the LOW END locked to the beat period? ─────────────
    # The single most house-specific feature there is: a four-on-the-floor kick
    # makes the 40-120 Hz envelope periodic at exactly the beat period.
    low = band_env(x, 40, 120, hop=hop)
    low = low - low.mean()
    ac = np.correlate(low, low, mode="full")[len(low) - 1:]
    ac /= (ac[0] + 1e-12)
    if bpm > 0:
        lag = int(round((60.0 / bpm) * SR / hop))
        if 0 < lag < len(ac):
            out["low_lock"] = float(ac[lag])
            # and at the BAR period, which catches a kick that skips beats
            out["low_lock_bar"] = float(ac[min(lag * 4, len(ac) - 1)])
    out.setdefault("low_lock", None)
    out.setdefault("low_lock_bar", None)

    # ── 5. onset rate and percussive share ─────────────────────────────────
    try:
        out["onset_rate"] = float(es.OnsetRate()(x)[1])
    except Exception:
        out["onset_rate"] = None

    # HPSS via median filtering on the spectrogram — percussive energy share
    from scipy.ndimage import median_filter
    S = np.abs(np.fft.rfft(
        np.lib.stride_tricks.sliding_window_view(x, 2048)[::512] *
        np.hanning(2048), axis=1))
    H = median_filter(S, size=(17, 1))       # smooth in TIME  -> harmonic
    P = median_filter(S, size=(1, 17))       # smooth in FREQ  -> percussive
    out["perc_ratio"] = float((P ** 2).sum() / ((P ** 2).sum() + (H ** 2).sum() + 1e-12))

    # ── 6. level shape ──────────────────────────────────────────────────────
    rms = float(np.sqrt((x ** 2).mean()))
    pk = float(np.abs(x).max())
    out["crest_db"] = float(20 * np.log10(pk / (rms + 1e-12)))
    sub = band_env(x, 20, 120, hop=hop)
    out["sub_share"] = float((sub ** 2).sum() / ((env ** 2).sum() + 1e-12))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dirs", nargs="+", default=["inspo", "ownrec"])
    ap.add_argument("--n", type=int, default=0)
    ap.add_argument("--out", default="data/dance-features.json")
    a = ap.parse_args()

    res = {}
    for d in a.dirs:
        files = sorted((HERE / d).rglob("*.opus"))
        if a.n:
            files = files[:a.n]
        for i, f in enumerate(files, 1):
            key = f"{d}/{f.name}"
            try:
                res[key] = measure(f)
                r = res[key]
                print(f"  [{i}/{len(files)}] dfa {r['dance_dfa']:.3f}  "
                      f"conf {r['beat_conf']:.2f}  punch "
                      f"{(r['beat_punch'] or 0):5.2f}  lock "
                      f"{(r['low_lock'] or 0):5.2f}  perc {r['perc_ratio']:.3f}  "
                      f"{f.name[:44]}")
            except Exception as e:
                print(f"  [{i}/{len(files)}] FAILED {f.name[:40]}: {str(e)[:60]}")
    Path(HERE / a.out).write_text(json.dumps(res, indent=1))
    print(f"\nwrote {a.out} ({len(res)} tracks)")


if __name__ == "__main__":
    main()
