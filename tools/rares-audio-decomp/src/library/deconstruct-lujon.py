#!/usr/bin/env python3
"""
deconstruct-lujon.py — HENRY MANCINI, "LUJON" (1961, *Mr. Lucky Goes Latin*).

**Paul named it, 7 August 2026:** *"Here's also a track we should take
inspiration from and completely deconstruct"*, and separately, of the Acid Pauli
jungle set he was listening to at the time: ***"He samples it."***

🔴 THAT ONE FACT COLLAPSES FIVE SEPARATE OBSERVATIONS INTO ONE. Across ten
minutes he reported Acid Pauli using a low viola/violin drone, a vibraphone for
light melodies, a synth for chords, an acoustic guitar, and in-bar bass rhythm.
**Lujon is scored for exactly that band** — Mancini's exotica instrumentation is
bass marimba, vibraphone, guitar and sustained strings. So those are very
plausibly not five production choices to copy one at a time; they are **one
sample, and its arrangement.** Verify before treating it as settled — this is
an inference from his own report, not a measurement.

What this measures, and every number is from the audio:
  * tempo, key, and the harmonic rhythm
  * the melodic line off the Demucs `other` stem (`writing-a-tune.md` §6b-bis:
    separation takes the pitch track from 11 chromatic classes to 7 diatonic
    ones, and it is the difference between a table of noise and a readable one)
  * the interval profile — step / leap share, span, contour — which is what
    `tune3.py`'s filters should be set FROM, rather than from my priors
  * the bass figure's note-ons per bar, which is his in-bar-rhythm note

⚠️ Melodia is NOT reproducible run-to-run on this material — `melody.py` logged
the same five seconds returning three different note lists including octave
disagreements. So every note here is a CONSENSUS across overlapping windows,
carrying how many runs agreed, and anything under a majority is not reported.
"""
import sys
from collections import Counter
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
STEM = HERE / "inspo" / "stems" / "htdemucs" / "Lujon [RjsG3i6L9vw]"
NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def nm(m):
    return f"{NAMES[int(m) % 12]}{int(m) // 12 - 1}"


import essentia.standard as es       # noqa: E402


def load(p):
    return es.MonoLoader(filename=str(p), sampleRate=44100)()


def main():
    full = load(HERE / "inspo" / "Lujon [RjsG3i6L9vw].opus")
    other = load(STEM / "other.wav")
    bass = load(STEM / "bass.wav")

    print("=" * 92)
    print("  HENRY MANCINI — LUJON (1961).  Deconstruction, measured.")
    print("=" * 92)

    key, scale, strength = es.KeyExtractor(profileType="edma")(full)
    bpm, ticks, conf, _, _ = es.RhythmExtractor2013(method="multifeature")(full)
    print(f"  duration      {len(full) / 44100:.1f} s")
    print(f"  key           {key} {scale}   (edma profile, strength {strength:.2f})")
    print(f"  tempo         {bpm:.2f} BPM   (confidence {conf:.1f})")
    print(f"  bar length    {4 * 60.0 / bpm:.2f} s   ->  "
          f"{len(full) / 44100 / (4 * 60.0 / bpm):.0f} bars")
    print(f"  ⚠️  our record runs 123 BPM; Lujon is {bpm:.0f}. "
          f"Ratio {123.0 / bpm:.2f} — "
          f"{'roughly half-time' if bpm < 80 else 'comparable'}")

    # ── THE MELODIC LINE, by consensus across overlapping windows ───────────
    print("\n  ── THE MELODY (Demucs `other` stem, consensus of 9 windows) ──")
    votes = Counter()
    allnotes = []
    for k in range(9):
        off = int(k * 0.37 * 44100)
        seg = other[off:off + int(30 * 44100)]
        if len(seg) < 44100:
            continue
        p, _c = es.PredominantPitchMelodia(frameSize=2048, hopSize=128,
                                           minFrequency=180, maxFrequency=1400,
                                           voicingTolerance=0.4)(seg)
        on, dur, mid = es.PitchContourSegmentation(hopSize=128,
                                                   minDuration=0.12)(p, seg)
        for t, d, m in zip(on, dur, mid):
            votes[(round((t + off / 44100) * 8) / 8, int(round(m)))] += 1
        if k == 0:
            allnotes = list(zip(on, dur, mid))
    agreed = [(t, m, v) for (t, m), v in votes.items() if v >= 5]
    agreed.sort()
    print(f"     note events with >=5 of 9 windows agreeing: {len(agreed)}")
    pcs = Counter(int(m) % 12 for _t, m, _v in agreed)
    print(f"     pitch classes used: {len(pcs)} — "
          + " ".join(f"{NAMES[p]}({n})" for p, n in pcs.most_common()))
    if agreed:
        ms = [m for _t, m, _v in agreed]
        print(f"     range: {nm(min(ms))} - {nm(max(ms))}  "
              f"({max(ms) - min(ms)} semitones)")
        # interval profile — what tune3.py's filters should be set from
        seq = [m for _t, m, _v in agreed]
        iv = [b - a for a, b in zip(seq, seq[1:]) if abs(b - a) <= 12]
        if iv:
            n = len(iv)
            print(f"     intervals: {n}   "
                  f"step(<=2) {100.0 * sum(1 for i in iv if abs(i) <= 2) / n:.0f}%   "
                  f"leap(>=4) {100.0 * sum(1 for i in iv if abs(i) >= 4) / n:.0f}%   "
                  f"median |i| {sorted(abs(i) for i in iv)[n // 2]}")
            print(f"     ascending {100.0 * sum(1 for i in iv if i > 0) / n:.0f}%  "
                  f"descending {100.0 * sum(1 for i in iv if i < 0) / n:.0f}%  "
                  f"repeat {100.0 * sum(1 for i in iv if i == 0) / n:.0f}%")
        durs = [d for _o, d, _m in allnotes]
        if durs:
            sixteenth = 60.0 / bpm / 4
            print(f"     note length: median {np.median(durs):.2f} s = "
                  f"{np.median(durs) / sixteenth:.1f} sixteenths at {bpm:.0f} BPM")
        print(f"     notes/sec: {len(agreed) / (len(other) / 44100):.2f}")

    # ── THE BASS FIGURE — his in-bar rhythm note ───────────────────────────
    print("\n  ── THE BASS (Demucs `bass` stem) ──")
    env = np.abs(es.OnsetDetection(method="hfc")(*[]) ) if False else None
    ons = es.OnsetRate()(bass)
    rate, onsets = ons[1], ons[0]
    spb = 4 * 60.0 / bpm
    print(f"     onsets detected: {len(onsets)}   "
          f"= {len(onsets) / (len(bass) / 44100 / spb):.2f} per bar")
    print(f"     ⚠️  an onset detector has misread decay tails as strikes three "
          f"times in this project — treat as an upper bound")
    bp, _bc = es.PredominantPitchMelodia(frameSize=4096, hopSize=256,
                                         minFrequency=40, maxFrequency=350,
                                         voicingTolerance=0.6)(bass)
    v = bp[bp > 0]
    if len(v):
        bm = 69 + 12 * np.log2(v / 440.0)
        bpcs = Counter(int(round(x)) % 12 for x in bm)
        print(f"     bass pitch classes: "
              + " ".join(f"{NAMES[p]}({n})" for p, n in bpcs.most_common(6)))
        print(f"     bass range: {nm(np.percentile(bm, 5))} - "
              f"{nm(np.percentile(bm, 95))}")

    # ── HARMONIC RHYTHM ────────────────────────────────────────────────────
    print("\n  ── HARMONY ──")
    hpcp = es.HPCP()
    frames = []
    w, spec = es.Windowing(type="blackmanharris62"), es.Spectrum()
    peaks = es.SpectralPeaks(magnitudeThreshold=0.001, maxFrequency=3500,
                             minFrequency=60)
    for fr in es.FrameGenerator(full, frameSize=8192, hopSize=4096):
        f, m = peaks(spec(w(fr)))
        frames.append(hpcp(f, m))
    frames = np.array(frames)
    hop_s = 4096 / 44100.0
    per_bar = max(1, int(round(spb / hop_s)))
    chords, strengths = es.ChordsDetection(hopSize=4096)(frames.astype(np.float32))
    runs, cur, n = [], None, 0
    for c in chords:
        if c == cur:
            n += 1
        else:
            if cur:
                runs.append((cur, n * hop_s))
            cur, n = c, 1
    if cur:
        runs.append((cur, n * hop_s))
    runs = [(c, d) for c, d in runs if d >= 0.6]
    print(f"     chord segments (>=0.6 s): {len(runs)}")
    print(f"     mean hold: {np.mean([d for _c, d in runs]):.2f} s = "
          f"{np.mean([d for _c, d in runs]) / spb:.2f} bars")
    print("     sequence: " + " -> ".join(c for c, _d in runs[:24]))
    top = Counter(c for c, _d in runs)
    print("     most common: " + "  ".join(f"{c}({n})" for c, n in top.most_common(8)))


if __name__ == "__main__":
    main()
