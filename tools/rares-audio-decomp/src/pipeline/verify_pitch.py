#!/usr/bin/env python3
"""
verify_pitch.py — render single notes and MEASURE what pitch actually sounds.

WHY THIS EXISTS. Paul, on the piano: *"I literally think you might be rendering
it wrong in the code... They sound off, like a semitone off sort of way, like
happened to an earlier instance of this track with the keys."*

He is describing the exact failure that cost an entire evening on 4 August: the
pad ran a semitone sharp for four rounds because `detune=0.545` was assumed to
be a subtle width control when it is a ±1200-cent transposer. **Every spectral
test said the audio was clean, and it was — it was in the wrong key.** No
measurement of distortion, balance or spectrum can see a tuning error.

So: play a note, render it, find the fundamental, compare to what was intended.
This is the only test that can catch it, and it should have existed already.

ReaSamplOmatic5000 pitches a sample across its note range with two parameters,
"Pitch for start note" and "Pitch for end note", measured as linear over ±80
semitones (v=0 → −80, v=0.5 → 0, v=1 → +80). The pipeline computes

    pitch_lo = 0.5 + (lo - S) / 160
    pitch_hi = 0.5 + (hi - S) / 160

for a sample recorded at note S covering lo..hi. **That is a hypothesis until it
is measured**, and the assumption hiding inside it is that RS5k interpolates
pitch LINEARLY IN SEMITONES across the note range. If it interpolates across
the range differently — or if the endpoints are inclusive/exclusive by one —
every note in the middle of a zone comes out off.

Run: python3 verify_pitch.py          (ONE REAPER launch)
"""
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

import instruments
import rpp

HERE = Path(__file__).parent
OUT = (HERE / "out-pitchtest").resolve()
REAPER = "/Applications/REAPER.app/Contents/MacOS/REAPER"
PPQ, SR, BPM = 960, 44100, 120

# every note the piano actually plays, plus the melody
TEST_NOTES = [59, 60, 62, 64, 67, 69, 71, 76, 79, 81, 83]
NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def nm(n):
    return f"{NAMES[n % 12]}{n // 12 - 1}"


def hz(n):
    return 440.0 * 2 ** ((n - 69) / 12.0)


def fundamental(x, sr=SR, lo=80, hi=1600, expect=None):
    """Pitch by harmonic product spectrum, searched AROUND THE EXPECTED PITCH.

    ⚠️ HPS OCTAVE-ERRORS, and it did: it reported B5 as 498 Hz — exactly half —
    and the raw spectrum showed the real peak sitting at 992.5 Hz, correct. An
    unbounded search made a working renderer look broken. **A measurement tool
    that cries wolf is worse than none**, because the next real failure gets
    argued with. Searching ±6 semitones around the intended note removes the
    ambiguity entirely, and the test is checking a small error anyway."""
    if expect:
        lo, hi = expect * 2 ** (-6 / 12), expect * 2 ** (6 / 12)
    x = x[: sr * 2] * np.hanning(min(len(x), sr * 2))
    n = 1 << 18
    S = np.abs(np.fft.rfft(x, n))
    f = np.fft.rfftfreq(n, 1 / sr)
    hps = S.copy()
    for k in (2, 3, 4):
        d = S[::k]
        hps[: len(d)] *= d
    band = (f >= lo) & (f <= hi)
    return float(f[band][np.argmax(hps[band])])


def main():
    OUT.mkdir(exist_ok=True)
    zones = instruments.salamander_zones()
    tracks = []
    for i, note in enumerate(TEST_NOTES):
        # one track per note, each holding the SAME multisample the track uses
        fx = instruments.multisample(zones, [note], vel_layer=10,
                                     volume=1.0, min_vel_gain=1.0)
        ev = [(0, 0x90, note, 100), (PPQ * 2, 0x80, note, 0)]
        tracks.append(rpp.Track(
            f"n{note}", fx=fx, sel=True, vol=1.0,
            items=rpp.midi_item(ev, f"n{note}", 3.0, PPQ * 4, PPQ)))

    proj = OUT / "pitchtest.rpp"
    proj.write_text(rpp.project(tracks, BPM, 3.0, OUT, master_fx=[]))
    for t in tracks:
        f = OUT / f"{t.name}.wav"
        if f.exists():
            f.unlink()

    while subprocess.run(["pgrep", "-x", "REAPER"],
                         capture_output=True).returncode == 0:
        print("  waiting for REAPER to exit…"); time.sleep(2)
    print(f"ONE launch · {len(tracks)} notes")
    subprocess.run([REAPER, "-nosplash", "-noactivate", "-renderproject",
                    str(proj)], capture_output=True, timeout=600)

    print(f"\n  {'note':6} {'intended':>10} {'measured':>10} {'error':>9}   verdict")
    print("  " + "─" * 58)
    bad = 0
    for note in TEST_NOTES:
        f = OUT / f"n{note}.wav"
        if not f.exists():
            print(f"  {nm(note):6} {'—':>10} {'MISSING':>10}")
            bad += 1
            continue
        x, _ = sf.read(f, always_2d=True)
        x = x.mean(axis=1)
        if np.max(np.abs(x)) < 1e-4:
            print(f"  {nm(note):6} {hz(note):10.1f} {'SILENT':>10}")
            bad += 1
            continue
        got = fundamental(x, expect=hz(note))
        cents = 1200 * np.log2(got / hz(note))
        ok = abs(cents) < 35          # a semitone is 100 cents; 35 is generous
        bad += not ok
        print(f"  {nm(note):6} {hz(note):10.1f} {got:10.1f} {cents:+8.0f}¢   "
              f"{'ok' if ok else '🔴 OFF by ' + f'{cents/100:+.2f} semitones'}")
    print(f"\n  {len(TEST_NOTES)-bad}/{len(TEST_NOTES)} correct")
    return bad


if __name__ == "__main__":
    sys.exit(1 if main() else 0)
