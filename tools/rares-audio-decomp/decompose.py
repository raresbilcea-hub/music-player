#!/usr/bin/env python3
"""
decompose.py — ONE FILE IN, A STRUCTURED READING OUT.

This is the front door of the package. Everything in `src/` is a research script
with hardcoded paths into a private 24 GB music library; THIS file is the part
you can run today on any audio file, and it is assembled from the methods in
those scripts that were actually verified.

    python3 decompose.py song.wav
    python3 decompose.py song.wav --json out.json
    python3 decompose.py song.wav --start 30 --dur 60      # analyse an excerpt

WHAT IT REPORTS
    tempo       BPM, with the half/double ambiguity stated rather than hidden
    beats       beat times (Essentia's tracker if installed, else onset-comb)
    key         tonic + mode, from TWO independent estimators when available,
                and it tells you when they disagree
    chords      one label per bar, Viterbi-smoothed, with the runner-up and the
                score margin printed beside every label
    sections    structural boundaries from a checkerboard novelty curve
    bands       octave-band energy split — where the record actually sits

WHAT IT DOES NOT DO
    No lyrics. No stems. No per-instrument transcription. No real-time.
    See docs/02-gaps.md — those are the gaps, and they are the interesting part.

HARD DEPENDENCIES:  python3, numpy, soundfile, ffmpeg on PATH
OPTIONAL:           essentia (better beats + a second key opinion)

🔴 READ docs/03-mir-lessons.md BEFORE TRUSTING ANY NUMBER THIS PRINTS.
Every field below has a documented failure mode, and most of them produce
perfectly plausible output when they are wrong. That is the whole problem.
"""
import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 22050
NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Krumhansl-Schmuckler key profiles.
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

# Chord vocabulary as pitch-class sets. Sevenths and sus voicings are included
# because in most contemporary popular music plain triads alone mislabel the
# majority of bars — a m7 read as a plain triad loses the flavour note that the
# listener is actually hearing.
QUALITIES = {
    "":      [0, 4, 7],        "m":     [0, 3, 7],
    "maj7":  [0, 4, 7, 11],    "m7":    [0, 3, 7, 10],
    "7":     [0, 4, 7, 10],    "m9":    [0, 3, 7, 10, 2],
    "maj9":  [0, 4, 7, 11, 2], "sus4":  [0, 5, 7],
    "sus2":  [0, 2, 7],        "m6":    [0, 3, 7, 9],
    "dim":   [0, 3, 6],        "aug":   [0, 4, 8],
}
TEMPLATES = []
for _root in range(12):
    for _q, _ivs in QUALITIES.items():
        _v = np.zeros(12)
        for _i, _iv in enumerate(_ivs):
            # The 3rd/5th define the chord; extensions weigh less so a m9 does
            # not beat a plain m every time the pad happens to hold a 9th.
            _v[(_root + _iv) % 12] = 1.0 if _i < 3 else 0.85
        TEMPLATES.append((_root, _q, _v / np.linalg.norm(_v)))


# ─────────────────────────────────────────────────────────────── loading ────
def load(path, start=0.0, dur=None):
    """One decode path for everything: mono, 22050, float.

    🔴 DO NOT ADD A FAST PATH THAT SKIPS FFMPEG. A whole comparison in the
    source repo was wrong because two sides were decoded at different sample
    rates — Opus at 48 kHz against WAV at 44.1. Anything computed over the
    whole spectrum (flatness, brightness, band shares) changes with Nyquist
    without a single musical thing being different.
    """
    cmd = ["ffmpeg", "-y", "-v", "error"]
    if start:
        cmd += ["-ss", str(start)]
    if dur:
        cmd += ["-t", str(dur)]
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as t:
        tmp = t.name
    cmd += ["-i", str(path), "-ac", "1", "-ar", str(SR), tmp]
    subprocess.run(cmd, check=True, capture_output=True)
    x, _ = sf.read(tmp)
    Path(tmp).unlink(missing_ok=True)
    return x.astype(np.float64)


# ──────────────────────────────────────────────────────────────── onsets ────
def onset_flux(x, n=1024, hop=256):
    """Half-wave-rectified spectral flux. The base of tempo and of onsets."""
    win = np.hanning(n)
    fr = np.array([np.abs(np.fft.rfft(x[i:i + n] * win))
                   for i in range(0, len(x) - n, hop)])
    flux = np.maximum(np.diff(fr, axis=0), 0).sum(axis=1)
    return flux - flux.mean(), SR / hop


def tempo_of(flux, fps, lo=60.0, hi=180.0):
    """Autocorrelation of the flux, over a WIDE range, reporting the ambiguity.

    🔴 THE LESSON THIS ENCODES. The original `analyse.py` searched a narrow
    window and its docstring had to be corrected: the lag bounds are INTEGER
    frame counts, so the estimator could only ever emit ten distinct values and
    11-17% of a corpus landed on a boundary — i.e. their true tempo was outside
    the window and got silently clamped. A tempo estimate is only meaningful
    together with the range it was allowed to search and the resolution of the
    bins it had. Both are returned here.
    """
    ac = np.correlate(flux, flux, "full")[len(flux) - 1:]
    lag_lo, lag_hi = int(fps * 60 / hi), int(fps * 60 / lo)
    lag_hi = min(lag_hi, len(ac) - 1)
    if lag_hi <= lag_lo:
        return {"bpm": 120.0, "confidence": 0.0, "alternatives": []}
    seg = ac[lag_lo:lag_hi]
    lag = lag_lo + int(np.argmax(seg))
    bpm = 60.0 * fps / lag
    peak = float(seg.max())
    conf = float(peak / (np.abs(ac[lag_lo:lag_hi]).mean() + 1e-12))

    # Metrical ambiguity is REAL, not noise. A tempo tracker cannot tell 70 from
    # 140 from the signal alone — that is a musical judgement about where the
    # beat is. Report the octaves rather than pretending to have chosen.
    alts = []
    for mult, label in ((0.5, "half-time"), (2.0, "double-time"),
                        (2 / 3, "2/3 (triplet feel)"), (1.5, "3/2")):
        cand = bpm * mult
        if lo <= cand <= hi:
            l2 = int(round(fps * 60 / cand))
            if lag_lo <= l2 < lag_hi:
                alts.append({"bpm": round(cand, 2), "reading": label,
                             "relative_strength": round(float(ac[l2] / (peak + 1e-12)), 3)})
    # Resolution: how far apart adjacent integer lags are, in BPM, right here.
    res = abs(60.0 * fps / lag - 60.0 * fps / (lag + 1))
    return {"bpm": round(bpm, 2), "confidence": round(conf, 2),
            "search_range_bpm": [lo, hi], "bin_resolution_bpm": round(res, 3),
            "alternatives": alts}


def beats_from_flux(flux, fps, bpm):
    """Phase-lock a fixed-period comb to the flux. The fallback beat tracker.

    ⚠️ THIS ASSUMES CONSTANT TEMPO. It is fine for a click-tracked record and
    wrong for anything played by a human without one — which, for an app that
    records via a microphone, is the normal case, not the edge case. Install
    Essentia (or beat_this / madmom) and use a real tracker in production.
    """
    period = fps * 60.0 / bpm
    n = int((len(flux) - 1) / period)
    if n < 4:
        return np.array([])
    best_phase, best_score = 0.0, -1e18
    for ph in np.arange(0, period, 0.25):
        idx = np.round(ph + period * np.arange(n)).astype(int)
        idx = idx[idx < len(flux)]
        s = float(flux[idx].sum())
        if s > best_score:
            best_score, best_phase = s, ph
    idx = np.round(best_phase + period * np.arange(n)).astype(int)
    return idx[idx < len(flux)] / fps


def beats_essentia(path, start, dur):
    """RhythmExtractor2013 if it is installed. Slow (60-90 s for 8 minutes).

    ⚠️ IT RETURNS BEATS, NOT DOWNBEATS. `ticks[0]` is *a* beat with no promise
    it is beat 1 of a bar. Anything you print as "bar N" downstream inherits
    that, and the source repo shipped a wrong table because of exactly this.
    """
    try:
        import essentia.standard as es
    except Exception:
        return None
    try:
        loader = es.MonoLoader(filename=str(path), sampleRate=44100)
        y = loader()
        if start:
            y = y[int(start * 44100):]
        if dur:
            y = y[:int(dur * 44100)]
        bpm, ticks, conf, _, _ = es.RhythmExtractor2013(method="multifeature")(y)
        return {"bpm": float(bpm), "beats": np.array(ticks, dtype=float),
                "confidence": float(conf)}
    except Exception as e:                                    # noqa: BLE001
        print(f"  (essentia beat tracking failed: {e})", file=sys.stderr)
        return None


# ──────────────────────────────────────────────────────────────── chroma ────
def chroma_frames(x, n=8192, hop=2048, lo_hz=150, hi_hz=1400):
    """Mid-band chroma — the band where chords actually live.

    Below ~150 Hz is the bassline, and including it is the single biggest cause
    of an inversion being labelled as a different chord (a iv inversion and a V7
    are near-indistinguishable once the bass note votes). Above ~1.4 kHz is hats
    and air, which is noise to a pitch-class histogram.
    """
    f = np.fft.rfftfreq(n, 1 / SR)
    band = (f >= lo_hz) & (f <= hi_hz)
    pc = (np.round(12 * np.log2(np.maximum(f[band], 1e-9) / 440.0) + 69).astype(int)) % 12
    win = np.hanning(n)
    out = []
    for i in range(0, len(x) - n, hop):
        S = np.abs(np.fft.rfft(x[i:i + n] * win))[band] ** 2
        c = np.zeros(12)
        np.add.at(c, pc, S)
        out.append(c)
    return np.array(out), SR / hop


def key_krumhansl(chroma):
    c = chroma.sum(axis=0)
    if c.sum() == 0:
        return {"key": "?", "confidence": 0.0}
    c = c / c.sum()
    ranked = []
    for shift in range(12):
        rot = np.roll(c, -shift)
        for prof, mode in ((MAJOR, ""), (MINOR, "m")):
            r = float(np.corrcoef(rot, prof)[0, 1])
            ranked.append((r, f"{NAMES[shift]}{mode}"))
    ranked.sort(reverse=True)
    margin = ranked[0][0] - ranked[1][0]
    return {"key": ranked[0][1], "correlation": round(ranked[0][0], 3),
            "runner_up": ranked[1][1], "margin": round(margin, 3)}


def key_essentia(path, start, dur, profile="edma"):
    """Essentia's KeyExtractor with the `edma` profile.

    🔴 WHY A SECOND OPINION IS NOT OPTIONAL. In the source repo a chroma-plus-
    Krumhansl key estimator — essentially the function above — returned **A
    minor for 41% of a 431-track corpus.** A real corpus is not 41% A minor;
    that was a property of the detector. `edma` on the same corpus put A minor
    at 9%. On the subset where a third method also ran, edma agreed 37% of the
    time and the Krumhansl one 19%. Neither is the truth. The USEFUL output is
    the AGREEMENT: when two independent estimators concur, you have something;
    when they do not, say so in your UI instead of picking one.
    """
    try:
        import essentia.standard as es
    except Exception:
        return None
    try:
        y = es.MonoLoader(filename=str(path), sampleRate=44100)()
        if start:
            y = y[int(start * 44100):]
        if dur:
            y = y[:int(dur * 44100)]
        k, scale, strength = es.KeyExtractor(profileType=profile)(y)
        mode = "" if scale == "major" else "m"
        return {"key": f"{k}{mode}", "strength": round(float(strength), 3),
                "profile": profile}
    except Exception as e:                                    # noqa: BLE001
        print(f"  (essentia key failed: {e})", file=sys.stderr)
        return None


# ──────────────────────────────────────────────────────────────── chords ────
def chord_scores(vec):
    """Cosine of one normalised chroma vector against every template."""
    v = vec / (np.linalg.norm(vec) + 1e-12)
    return np.array([float(np.dot(v, t[2])) for t in TEMPLATES])


def chords_per_bar(chroma, fps, bpm, beats_per_bar=4, self_transition=0.55):
    """One chord per bar, VITERBI-SMOOTHED.

    🔴 THIS IS THE ONE PLACE THIS FILE IMPROVES ON THE SOURCE SCRIPTS, AND IT
    MATTERS FOR A TRANSCRIPTION APP. `harmony.py` takes a per-bar argmax. Frame
    noise then produces a chord that flickers — Dm, Dm, F, Dm, Dm — and a user
    reading a chord chart sees the F and does not know it is an artefact. A
    Viterbi pass with a self-transition bonus says "changing chords costs
    something", which is true of music and false of argmax.

    `self_transition` is a plain log-probability bonus for staying put. Raise it
    for slow-moving material (house, ambient), lower it for a jazz standard.
    ⚠️ IT IS A TUNING KNOB, NOT A MEASUREMENT. It was set by ear on one corpus.
    """
    bar_s = beats_per_bar * 60.0 / bpm
    step = max(int(round(bar_s * fps)), 1)
    raw = []
    for i in range(0, len(chroma) - step + 1, step):
        c = chroma[i:i + step].sum(axis=0)
        if c.sum() <= 0:
            raw.append(None)
            continue
        raw.append(chord_scores(c))
    obs = [r for r in raw if r is not None]
    if not obs:
        return []
    E = np.array(obs)                              # bars x templates
    # Sharpen the cosine scores into something log-likelihood shaped. The scale
    # is arbitrary; it only sets how much evidence is needed to force a change.
    L = E * 12.0
    n_bars, n_t = L.shape
    dp = np.zeros_like(L)
    bp = np.zeros_like(L, dtype=int)
    dp[0] = L[0]
    for t in range(1, n_bars):
        prev = dp[t - 1]
        stay = prev + self_transition
        best_other = prev.max()
        arg_other = int(prev.argmax())
        for j in range(n_t):
            if stay[j] >= best_other:
                dp[t, j], bp[t, j] = stay[j] + L[t, j], j
            else:
                dp[t, j], bp[t, j] = best_other + L[t, j], arg_other
    path = [int(dp[-1].argmax())]
    for t in range(n_bars - 1, 0, -1):
        path.append(int(bp[t, path[-1]]))
    path.reverse()

    out = []
    for bar_i, (j, scores) in enumerate(zip(path, E)):
        order = np.argsort(scores)[::-1]
        root, qual, _ = TEMPLATES[j]
        r2, q2, _ = TEMPLATES[int(order[0])] if int(order[0]) != j else TEMPLATES[int(order[1])]
        top_pcs = [NAMES[k] for k in np.argsort(chroma[bar_i * step:(bar_i + 1) * step]
                                                .sum(axis=0))[::-1][:4]]
        out.append({
            "bar": bar_i + 1,
            "time_s": round(bar_i * bar_s, 2),
            "chord": f"{NAMES[root]}{qual}",
            "score": round(float(scores[j]), 3),
            "unsmoothed": f"{NAMES[TEMPLATES[int(order[0])][0]]}{TEMPLATES[int(order[0])][1]}",
            "runner_up": f"{NAMES[r2]}{q2}",
            "margin": round(float(scores[order[0]] - scores[order[1]]), 3),
            "top_pitch_classes": top_pcs,
        })
    return out


# ───────────────────────────────────────────────────────────── structure ────
def sections(chroma, fps, bpm, kernel_bars=8, beats_per_bar=4):
    """Checkerboard-kernel novelty over a bar-synchronous self-similarity matrix.

    ⚠️ THE KERNEL HALF-WIDTH SETS THE SMALLEST SECTION YOU CAN SEE. At 8 bars
    you cannot resolve a 4-bar section, by construction. If you report section
    lengths from this and then observe that "sections come in 8s", you have
    measured your own kernel. In the source repo that failure has a name — the
    ruler measuring itself — and it invalidated an entire 139-record study whose
    change-rate output had to be marked DO NOT USE.
    """
    bar_s = beats_per_bar * 60.0 / bpm
    step = max(int(round(bar_s * fps)), 1)
    F = []
    for i in range(0, len(chroma) - step + 1, step):
        c = chroma[i:i + step].sum(axis=0)
        F.append(c / (np.linalg.norm(c) + 1e-12))
    F = np.array(F)
    n = len(F)
    if n < 2 * kernel_bars + 2:
        return []
    S = F @ F.T
    L = kernel_bars
    K = np.ones((2 * L, 2 * L))
    K[:L, L:] = -1
    K[L:, :L] = -1
    nov = np.zeros(n)
    for i in range(L, n - L):
        nov[i] = float((S[i - L:i + L, i - L:i + L] * K).sum())
    nov = np.maximum(nov, 0)
    if nov.max() > 0:
        nov /= nov.max()
    thr = nov.mean() + nov.std()
    bounds = []
    for i in range(L, n - L):
        if nov[i] > thr and nov[i] == nov[max(0, i - L // 2):i + L // 2 + 1].max():
            bounds.append(i)
    return [{"bar": b + 1, "time_s": round(b * bar_s, 2),
             "novelty": round(float(nov[b]), 3)} for b in bounds]


# ───────────────────────────────────────────────────────────────── bands ────
def band_profile(x, n=8192):
    win = np.hanning(n)
    acc = np.zeros(n // 2 + 1)
    cnt = 0
    for i in range(0, len(x) - n, n):
        acc += np.abs(np.fft.rfft(x[i:i + n] * win)) ** 2
        cnt += 1
    acc /= max(cnt, 1)
    f = np.fft.rfftfreq(n, 1 / SR)
    tot = acc.sum() or 1
    bands = [(20, 60), (60, 130), (130, 260), (260, 520), (520, 1040),
             (1040, 2080), (2080, 4160), (4160, 11000)]
    return {f"{lo}-{hi}": round(100 * float(acc[(f >= lo) & (f < hi)].sum()) / tot, 2)
            for lo, hi in bands}


# ────────────────────────────────────────────────────────────────── main ────
def analyse(path, start=0.0, dur=None, beats_per_bar=4, self_transition=0.55):
    x = load(path, start, dur)
    if len(x) < SR * 4:
        raise SystemExit("less than 4 seconds of audio decoded — nothing to measure")

    flux, fps_f = onset_flux(x)
    tempo = tempo_of(flux, fps_f)

    ess_beats = beats_essentia(path, start, dur)
    if ess_beats:
        bpm = ess_beats["bpm"]
        beats = ess_beats["beats"]
        beat_source = "essentia RhythmExtractor2013 (multifeature)"
        beat_conf = ess_beats["confidence"]
    else:
        bpm = tempo["bpm"]
        beats = beats_from_flux(flux, fps_f, bpm)
        beat_source = "onset-comb fallback — ASSUMES CONSTANT TEMPO"
        beat_conf = None

    chroma, fps_c = chroma_frames(x)
    k1 = key_krumhansl(chroma)
    k2 = key_essentia(path, start, dur)
    key = {"krumhansl_midband": k1, "essentia_edma": k2}
    if k2:
        key["agreement"] = (k1["key"] == k2["key"])
        key["verdict"] = (k1["key"] if key["agreement"]
                          else f"DISPUTED: {k1['key']} vs {k2['key']} — do not present as fact")
    else:
        key["verdict"] = f"{k1['key']} (SINGLE ESTIMATOR — see docs/03-mir-lessons.md §key)"

    return {
        "file": str(path),
        "excerpt": {"start_s": start, "duration_s": dur},
        "tempo": tempo,
        "beats": {"source": beat_source, "bpm_used": round(float(bpm), 2),
                  "confidence": beat_conf, "count": int(len(beats)),
                  "first_10_s": [round(float(b), 3) for b in beats[:10]],
                  "warning": "these are BEATS, not DOWNBEATS — bar 1 is not established"},
        "key": key,
        "chords": chords_per_bar(chroma, fps_c, bpm, beats_per_bar, self_transition),
        "sections": sections(chroma, fps_c, bpm, beats_per_bar=beats_per_bar),
        "bands_pct": band_profile(x),
    }


def report(r):
    print(f"\n  FILE      {r['file']}")
    t = r["tempo"]
    print(f"  TEMPO     {t['bpm']} BPM   confidence {t['confidence']}   "
          f"(searched {t['search_range_bpm'][0]}-{t['search_range_bpm'][1]}, "
          f"bin resolution {t['bin_resolution_bpm']} BPM)")
    for a in t["alternatives"]:
        print(f"              also plausible: {a['bpm']} ({a['reading']}) "
              f"strength {a['relative_strength']}")
    b = r["beats"]
    print(f"  BEATS     {b['count']} via {b['source']}")
    print(f"              ⚠️  {b['warning']}")
    print(f"  KEY       {r['key']['verdict']}")
    for name, v in (("krumhansl", r["key"]["krumhansl_midband"]),
                    ("essentia ", r["key"]["essentia_edma"])):
        if v:
            print(f"              {name}: {v}")

    ch = r["chords"]
    if ch:
        print(f"\n  CHORDS    {len(ch)} bars")
        print("            smoothed | unsmoothed | runner-up | margin between the "
              "top two UNSMOOTHED candidates")
        print("            a margin under 0.02 means the frame does not actually "
              "distinguish them — show that in your UI")
        for c in ch[:48]:
            flag = "  <-- weak" if c["margin"] < 0.02 else ""
            print(f"    bar {c['bar']:>3} {c['time_s']:>7.2f}s   "
                  f"{c['chord']:<7} | {c['unsmoothed']:<7} | {c['runner_up']:<7} | "
                  f"{c['margin']:.3f}{flag}")
        if len(ch) > 48:
            print(f"    … {len(ch) - 48} more bars (use --json for all)")
        seq = []
        for c in ch:
            if not seq or seq[-1] != c["chord"]:
                seq.append(c["chord"])
        print(f"\n    collapsed: {' -> '.join(seq[:24])}")

    s = r["sections"]
    print(f"\n  SECTIONS  {len(s)} boundaries "
          f"(kernel = 8 bars, so nothing shorter than 8 bars is visible)")
    for x in s:
        print(f"    bar {x['bar']:>3}  {x['time_s']:>7.2f}s   novelty {x['novelty']}")

    print("\n  BANDS (% of energy)")
    for k, v in r["bands_pct"].items():
        print(f"    {k:<12} Hz  {v:>6.2f}  {'#' * int(v / 2)}")
    print()


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("audio")
    ap.add_argument("--start", type=float, default=0.0, help="skip N seconds")
    ap.add_argument("--dur", type=float, default=None, help="analyse N seconds only")
    ap.add_argument("--bpb", type=int, default=4, help="beats per bar (default 4)")
    ap.add_argument("--stay", type=float, default=0.55,
                    help="Viterbi self-transition bonus; higher = fewer chord changes")
    ap.add_argument("--json", help="write the full result here")
    a = ap.parse_args()
    r = analyse(a.audio, a.start, a.dur, a.bpb, a.stay)
    report(r)
    if a.json:
        Path(a.json).write_text(json.dumps(r, indent=2))
        print(f"  wrote {a.json}\n")


if __name__ == "__main__":
    main()
