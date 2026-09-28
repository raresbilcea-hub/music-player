#!/usr/bin/env python3
"""survey.py — MEASURE a sample folder before anything plays a note of it.

🔴 THIS EXISTS BECAUSE OF A STANDING RULE, NOT AS A CONVENIENCE. Every
instrument gets documented before it gets used, with real units, and *"where
the docs don't say — and they usually don't — MEASURE IT."* Most of what is on
disk here has **no `.sfz` at all** (the sparse checkouts took WAVs only), so a
filename's octave number is a claim and nothing more. An octave-wrong or
semitone-wrong sample map produces perfectly clean audio in the wrong key,
which is the one fault no spectral test has ever caught here.

WHAT IT REPORTS, per folder:
  · sampled pitch count, and the octave offset that reconciles the filenames
    with the MEASURED fundamentals — plus the residual, so a single bad file
    shows up instead of hiding in an average
  · onset in ms (15% of peak) — a pad re-articulates every bar, so an
    instrument that speaks late cannot hold one, and no fader fixes it
  · sustain-RMS spread — 20+ dB of it means the set MUST be level-prepped or a
    chord will have notes 20 dB apart
  · spectral centroid — bright or dark, which is what "too synthetic" is
    usually about
  · note length, and whether round robins exist

🔴 THE PITCH METHOD, AND WHY NOT AUTOCORRELATION. Autocorrelation reported
exact 1/2 and 1/3 ratios on the brightest organ samples, which reads as "the
top of the instrument is mistuned." It is not — period-doubling is what
autocorrelation does to a sound with a weak fundamental and strong upper
partials. So candidates are scored on the energy of THEIR OWN harmonic series,
and any candidate with no energy at its own first partial scores zero.
"""
import re
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

HERE = Path(__file__).parent
INSTR = HERE.parent / "references" / "instruments"
_N = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5, "F#": 6,
      "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}
NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
FLAT = {"Db": "C#", "Eb": "D#", "Gb": "F#", "Ab": "G#", "Bb": "A#"}

# note name + octave anywhere in the stem, the loosest pattern that still
# cannot match a velocity field (`_v3`) or a round robin (`_rr2`).
NOTE_RE = re.compile(r"(?<![A-Za-z])([A-G][#b]?)(-?\d)(?![\d])")


def note_of(stem):
    """(pitch_class, octave) from a filename, or None. Last match wins —
    prefixes like `BKCtbss` and `RenOrgan_8foot` are ahead of the note."""
    ms = NOTE_RE.findall(stem)
    if not ms:
        return None
    nm, oct_ = ms[-1]
    nm = FLAT.get(nm, nm)
    if nm not in _N:
        return None
    return _N[nm], int(oct_)


def spectrum(x, sr, nfft=1 << 18):
    start = int(len(x) * 0.30)
    seg = x[start:start + int(sr * 0.8)]
    if len(seg) < 2048:
        seg = x
    X = np.abs(np.fft.rfft(seg * np.hanning(len(seg)), nfft))
    return np.fft.rfftfreq(nfft, 1 / sr), X


def _peak_near(f, X, hz, cents=40):
    if hz <= 0 or hz > f[-1]:
        return 0.0
    m = (f >= hz * 2 ** (-cents / 1200)) & (f <= hz * 2 ** (cents / 1200))
    return float(X[m].max()) if m.any() else 0.0


def harmonic_score(f, X, f0, nh=6):
    """Sum of the first nh partials, ZERO if the fundamental itself is absent."""
    tot = float(X.max()) or 1.0
    e0 = _peak_near(f, X, f0)
    if e0 < tot * 0.02:
        return 0.0
    return sum(_peak_near(f, X, f0 * k) for k in range(1, nh + 1)) / tot


def sounding_midi(x, sr, expect_midi, span=(-24, 25)):
    """Which pitch is this REALLY, tested against the filename's claim.

    Scores every candidate within `span` semitones of the expectation on its
    own harmonic series, then refines to the actual peak so a mistuned or
    stretched sample shows up in cents rather than being rounded away."""
    f, X = spectrum(x, sr)
    best, best_s = None, -1.0
    for st in range(span[0], span[1]):
        hz = 440.0 * 2 ** ((expect_midi + st - 69) / 12.0)
        s = harmonic_score(f, X, hz)
        if s > best_s:
            best, best_s = expect_midi + st, s
    if best is None or best_s <= 0:
        return None, 0.0, 0.0
    hz = 440.0 * 2 ** ((best - 69) / 12.0)
    m = (f >= hz * 0.97) & (f <= hz * 1.03)
    exact = float(f[m][np.argmax(X[m])]) if m.any() else hz
    cents = 1200 * np.log2(exact / hz) if exact > 0 else 0.0
    return best, best_s, cents


def onset_ms(x, sr, frac=0.15):
    w = max(int(0.005 * sr), 1)
    env = np.convolve(np.abs(x), np.ones(w) / w, mode="same")
    return float(np.argmax(env > env.max() * frac) / sr * 1000.0)


def measure_file(path, expect_midi):
    x, sr = sf.read(path, always_2d=True)
    x = x.mean(axis=1)
    if not len(x) or not np.any(x):
        return None
    midi, score, cents = sounding_midi(x, sr, expect_midi)
    f, X = spectrum(x, sr)
    s = x[int(len(x) * 0.3):int(len(x) * 0.6)]
    if len(s) < 128:
        s = x
    return dict(
        midi=midi, score=score, cents=cents,
        onset=onset_ms(x, sr), dur=len(x) / sr, sr=sr,
        peak=20 * np.log10(max(float(np.abs(x).max()), 1e-9)),
        rms=20 * np.log10(float(np.sqrt((s ** 2).mean())) + 1e-12),
        centroid=float((f * X).sum() / (X.sum() or 1.0)))


def survey(folder, label=None, limit=None):
    """Measure every WAV in `folder`. Returns a dict, prints a report."""
    d = Path(folder)
    if not d.is_absolute():
        d = INSTR / folder
    # ⚠️ WAV-ONLY WAS A CHECK POINTED SLIGHTLY TO THE SIDE OF THE THING.
    # The three E-piano sets ship as `.flac` and this glob reported
    # "NO WAV FILES", which reads as "no samples" and is not the same claim.
    # soundfile reads flac natively and so does REAPER.
    files = sorted(q for ext in ("*.wav", "*.flac") for q in d.rglob(ext))
    label = label or d.name
    if not files:
        print(f"\n### {label}\n  NO WAV FILES at {d}")
        return None
    # one file per (note, octave): the first round robin / velocity layer
    picked, skipped = {}, []
    for p in files:
        n = note_of(p.stem)
        if n is None:
            skipped.append(p.name)
            continue
        picked.setdefault(n, p)
    if not picked:
        print(f"\n### {label}\n  {len(files)} files, NO PARSEABLE NOTE NAMES"
              f"  e.g. {files[0].name}")
        return None
    if limit:
        picked = dict(sorted(picked.items())[:limit])

    rows = []
    for (pc, oct_), p in sorted(picked.items(), key=lambda kv: kv[0][1] * 12 + kv[0][0]):
        naive = (oct_ + 1) * 12 + pc            # scientific-pitch reading
        m = measure_file(p, naive)
        if m is None or m["midi"] is None:
            continue
        m.update(name=f"{NAMES[pc]}{oct_}", naive=naive, file=p)
        rows.append(m)
    if not rows:
        print(f"\n### {label}\n  measured nothing")
        return None

    offs = np.array([r["midi"] - r["naive"] for r in rows])
    off = int(round(np.median(offs)))
    resid = offs - off
    bad = [r for r, e in zip(rows, resid) if e != 0]
    los = min(r["naive"] + off for r in rows)
    his = max(r["naive"] + off for r in rows)
    ons = np.array([r["onset"] for r in rows])
    rms = np.array([r["rms"] for r in rows])
    cen = np.array([r["centroid"] for r in rows])
    dur = np.array([r["dur"] for r in rows])
    cents = np.array([abs(r["cents"]) for r in rows])
    rr = len(files) / max(len(picked), 1)

    print(f"\n### {label}")
    print(f"  {len(picked)} sampled pitches from {len(files)} files"
          f"   ({rr:.1f} files per pitch — velocity layers / round robins)")
    print(f"  filename -> MIDI: (octave + {off + 1}) * 12 + N"
          f"    [scientific pitch would be +1]")
    print(f"  sounding range  MIDI {los}-{his}"
          f"  ({NAMES[los % 12]}{los // 12 - 1}-{NAMES[his % 12]}{his // 12 - 1})"
          f"   {his - los} semitones over {len(rows)} samples"
          f"  = every {(his - los) / max(len(rows) - 1, 1):.1f} st")
    print(f"  🔴 MIS-MAPPED: {len(bad)}"
          + ("" if not bad else "  -> " + ", ".join(
              f"{r['name']} sounds {e:+d} st" for r, e in
              zip(rows, resid) if e != 0)))
    print(f"  tuning        {cents.mean():.0f} cents mean off equal temperament"
          f" (max {cents.max():.0f})")
    print(f"  ONSET         {ons.min():.0f}-{ons.max():.0f} ms"
          f"   median {np.median(ons):.0f}"
          f"    {'PAD-CAPABLE' if np.median(ons) < 60 else 'TOO SLOW FOR A PAD'}")
    print(f"  length        {dur.min():.1f}-{dur.max():.1f} s"
          f"   median {np.median(dur):.1f}")
    print(f"  sustain RMS   {rms.min():.1f}..{rms.max():.1f} dBFS"
          f"   SPREAD {np.ptp(rms):.1f} dB"
          f"   {'-> MUST be level-prepped' if np.ptp(rms) > 12 else '(even)'}")
    print(f"  centroid      {np.median(cen):.0f} Hz median"
          f"   ({cen.min():.0f}-{cen.max():.0f})")
    if skipped:
        print(f"  unparsed      {len(skipped)} files, e.g. {skipped[0]}")
    return dict(label=label, dir=str(d), off=off, rows=rows, files=len(files),
                pitches=len(picked), lo=los, hi=his, bad=len(bad),
                onset_med=float(np.median(ons)), onset_max=float(ons.max()),
                rms_spread=float(np.ptp(rms)), centroid=float(np.median(cen)),
                dur_med=float(np.median(dur)), rr=rr)


# The candidates, by the job each would take over from a synth.
CANDIDATES = {
    "PAD — sustained harmony, re-articulates every bar": [
        ("VCSL/Aerophones/Edge-blown Aerophones/Renaissance Organ/8'", "Renaissance Organ 8'"),
        ("VCSL/Aerophones/Edge-blown Aerophones/Renaissance Organ/Full", "Renaissance Organ Full"),
        ("VCSL/Aerophones/Edge-blown Aerophones/Pipe Organ/Quiet", "Pipe Organ Quiet"),
        ("VCSL/Aerophones/Edge-blown Aerophones/Pipe Organ/Loud", "Pipe Organ Loud"),
        ("VCSL/Chordophones/Zithers/Psaltery, Bowed and Plucked", "Psaltery (bowed+plucked)"),
        ("VSCO2-CE/Strings/Violin Section/susVib", "Violin Section susVib"),
    ],
    "TEXTURE — atmosphere, drone, the thing under everything": [
        ("VCSL/Aerophones/Lip Aerophones/Didgeridoo", "Didgeridoo"),
        ("VSCO2-CE/Woodwinds/Clarinet", "Clarinet"),
        ("VSCO2-CE/Woodwinds/Bassoon", "Bassoon"),
        ("VCSL/Chordophones/Zithers/Dan Tranh", "Dan Tranh"),
    ],
    "KEYS — guide tones, 3rd and 7th, 196-330 Hz, offbeat": [
        ("VCSL/Idiophones/Struck Idiophones/Vibraphone/Soft Mallets", "Vibraphone soft"),
        ("VCSL/Idiophones/Struck Idiophones/Marimba", "Marimba"),
        ("VCSL/Idiophones/Struck Idiophones/Balafon", "Balafon"),
        ("VCSL/Chordophones/Composite Chordophones/Folk Harp", "Folk Harp"),
        ("VCSL/Chordophones/Composite Chordophones/Concert Harp", "Concert Harp"),
        ("VSCO2-CE/Strings/Harp", "VSCO2 Harp"),
    ],
    "MELODY / MELODY2 / UPPER — the line, the answer, the top": [
        ("VSCO2-CE/Woodwinds/Flute", "Flute"),
        ("VSCO2-CE/Woodwinds/Oboe", "Oboe"),
        ("VSCO2-CE/Woodwinds/Piccolo", "Piccolo"),
        ("VCSL/Aerophones/Edge-blown Aerophones/Ocarina, Typical", "Ocarina Typical"),
        ("VCSL/Aerophones/Edge-blown Aerophones/Ocarina, Small", "Ocarina Small"),
        ("VCSL/Aerophones/Edge-blown Aerophones/Baroque Tenor Recorder", "Baroque Tenor Recorder"),
        ("VCSL/Aerophones/Edge-blown Aerophones/Baroque Alto Recorder", "Baroque Alto Recorder"),
        ("VCSL/Idiophones/Struck Idiophones/Glockenspiel", "Glockenspiel"),
        ("VSCO2-CE/Strings/Solo Violin", "Solo Violin"),
        ("VCSL/Chordophones/Composite Chordophones/Strumstick", "Strumstick"),
    ],
}


if __name__ == "__main__":
    args = sys.argv[1:]
    if args:
        for a in args:
            survey(a)
    else:
        out = {}
        for job, items in CANDIDATES.items():
            print(f"\n{'=' * 78}\n== {job}\n{'=' * 78}")
            for path, label in items:
                try:
                    r = survey(path, label)
                    if r:
                        out[label] = r
                except Exception as e:                      # noqa: BLE001
                    print(f"\n### {label}\n  FAILED: {type(e).__name__}: {e}")
        print(f"\n\n{'=' * 78}\n== SUMMARY — onset decides who can be a PAD\n"
              f"{'=' * 78}")
        hdr = ("instrument", "pitches", "range", "st/samp", "onset",
               "RMS spr", "centroid", "len", "bad")
        print("{:<26}{:>8}{:>10}{:>9}{:>10}{:>9}{:>10}{:>8}{:>5}".format(*hdr))
        for k, r in sorted(out.items(), key=lambda kv: kv[1]["onset_med"]):
            step = (r["hi"] - r["lo"]) / max(r["pitches"] - 1, 1)
            print("{:<26}{:>8}{:>10}{:>9}{:>10}{:>9}{:>10}{:>8}{:>5}".format(
                k[:26], r["pitches"], f"{r['lo']}-{r['hi']}", f"{step:.1f}",
                f"{r['onset_med']:.0f} ms", f"{r['rms_spread']:.0f} dB",
                f"{r['centroid']:.0f} Hz", f"{r['dur_med']:.1f}s", r["bad"]))
        import json
        p = HERE / "reaper" / "probes" / "instrument-survey.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(
            {k: {kk: vv for kk, vv in r.items() if kk != "rows"}
             for k, r in out.items()}, indent=1))
        print(f"\nwritten: {p}")
