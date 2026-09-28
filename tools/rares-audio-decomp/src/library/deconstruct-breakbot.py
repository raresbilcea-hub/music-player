#!/usr/bin/env python3
"""
deconstruct-breakbot.py — BREAKBOT, "Baby I'm Yours", read off the STEMS.

*Paul, 12 August 2026: "Can you also take a look at the piano chords within the
Breakbot baby I'm yours song? Look at the actual stem and map it to see what they
are doing" ... "Actually take a look at all of the stems in that track."*

WHY THE STEMS AND NOT THE MIX
─────────────────────────────
`harmony.py` already ran on the full mix and returned a chord list. That list is
a **chroma estimate over everything at once** — bass, drums, vocal and keys
summed — and this repo has logged twice what that costs: the extracted `V7` on
this very track was flagged as *"a strong lead, to be confirmed by ear, not a
settled fact"*, because a `iv` inversion and a `V7` are hard to tell apart when
the bass is in the same chroma frame.

**Separating first removes the bass from the harmony frame**, which is the single
biggest source of that error. `writing-a-tune.md` §6b-bis measured the same thing
on melody: separation took the pitch track from 11 chromatic classes to 7
diatonic ones, and called it *"the difference between a table of noise and a
readable one."*

WHAT THIS MEASURES, per stem
────────────────────────────
    other   the KEYS — chord per beat, voicing register, attack density
    bass    the note per beat, its register, and the octave-leap rate
    drums   onset grid: which 16ths are struck, and the swing
    vocals  presence, so an arrangement map can say when it enters

⚠️ EVERY NUMBER IS FROM THE AUDIO. Where a chord label is a guess between two
readings, both are printed. A chroma frame cannot distinguish an inversion from
a different chord and pretending otherwise is how the `V7` got into the record
as a near-fact.
"""
import sys
from collections import Counter
from pathlib import Path

import numpy as np
import soundfile as sf

HERE = Path(__file__).parent
STEM = HERE / "inspo" / "stems" / "htdemucs" / "Baby I'm Yours [3vVSBLkpO-8]"
NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# measured earlier by `harmony.py`; the bar grid is derived from it
BPM = 117.5
BAR = 4 * 60.0 / BPM


def load(name):
    x, sr = sf.read(STEM / f"{name}.wav", always_2d=True)
    return x.mean(axis=1), sr


def chroma(x, sr, lo=110, hi=2200):
    """12-bin pitch-class energy for one slice."""
    if len(x) < 2048:
        return np.zeros(12)
    w = x * np.hanning(len(x))
    S = np.abs(np.fft.rfft(w)) ** 2
    f = np.fft.rfftfreq(len(x), 1 / sr)
    k = (f > lo) & (f < hi)
    if not k.any():
        return np.zeros(12)
    pc = np.round(69 + 12 * np.log2(np.maximum(f[k], 1e-9) / 440)).astype(int) % 12
    out = np.zeros(12)
    for p in range(12):
        out[p] = S[k][pc == p].sum()
    return out / (out.sum() + 1e-12)


# chord templates, as pitch-class sets. Deliberately a SMALL vocabulary — a
# large one always finds a match and tells you nothing.
TEMPLATES = {
    "m7":   [0, 3, 7, 10],
    "m9":   [0, 3, 7, 10, 2],
    "maj7": [0, 4, 7, 11],
    "maj9": [0, 4, 7, 11, 2],
    "7":    [0, 4, 7, 10],
    "m":    [0, 3, 7],
    "":     [0, 4, 7],
    "sus4": [0, 5, 7],
}


def best_chords(c, n=2):
    """The n best (root, quality) readings, with their scores, so a close call
    is visible instead of hidden behind a single label."""
    scored = []
    for root in range(12):
        for q, iv in TEMPLATES.items():
            tpl = np.zeros(12)
            for i in iv:
                tpl[(root + i) % 12] = 1
            tpl /= tpl.sum()
            scored.append((float(np.dot(c, tpl) / (np.linalg.norm(tpl) + 1e-9)),
                           f"{NAMES[root]}{q}"))
    scored.sort(reverse=True)
    return scored[:n]


def onset_grid(x, sr, bars=16, start_bar=8, div=16, phase=None):
    """Which subdivision of the bar gets struck, summed over `bars` bars.

    🔴 THE PHASE IS FOUND, NOT ASSUMED. The first run reported **zero onsets on
    every beat** — steps 0, 4, 8 and 12 all empty — which is impossible for a
    house record and is the tell that the bar grid was misaligned, not that the
    kick was missing. Nothing tells us where bar 1 begins; the tempo came from a
    ten-bin estimator and the file has an unknown lead-in. So try all 16 offsets
    and keep the one that puts the most energy on the quarters, which is the
    one assumption about this genre that is safe to make."""
    hop = 256
    n = len(x) // hop * hop
    env = np.sqrt((x[:n].reshape(-1, hop) ** 2).mean(axis=1))
    d = np.diff(env, prepend=env[0])
    thr = d.std() * 1.4
    on = (d > thr) & (d > np.roll(d, 1)) & (d > np.roll(d, -1))
    times = np.nonzero(on)[0] * hop / sr
    def build(off):
        g = np.zeros(div)
        for t in times:
            b = (t - start_bar * BAR - off) / BAR
            if 0 <= b < bars:
                g[int(round((b % 1) * div)) % div] += 1
        return g
    if phase is None:
        cands = [(build(o * BAR / div), o) for o in range(div)]
        # score = share of onsets landing on the four quarters
        best = max(cands, key=lambda gc: gc[0][::div // 4].sum() / (gc[0].sum() or 1))
        return best[0], best[1]
    return build(phase * BAR / div), phase


def main():
    if not STEM.exists():
        sys.exit(f"no stems at {STEM}")
    out = []

    # ── THE KEYS ───────────────────────────────────────────────────────────
    other, sr = load("other")
    out.append("## THE KEYS (`other` stem) — chord per bar\n")
    out.append(f"{'bar':>4}  {'best reading':14} {'score':>6}   "
               f"{'runner-up':14} {'score':>6}   top pitch classes")
    rows = []
    for b in range(8, 40):
        seg = other[int(b * BAR * sr):int((b + 1) * BAR * sr)]
        c = chroma(seg, sr)
        top = best_chords(c, 2)
        pcs = " ".join(NAMES[p] for p in np.argsort(-c)[:4])
        rows.append((b + 1, top, pcs))
        out.append(f"{b+1:>4}  {top[0][1]:14} {top[0][0]:6.3f}   "
                   f"{top[1][1]:14} {top[1][0]:6.3f}   {pcs}")
    seq = [r[1][0][1] for r in rows]
    out.append(f"\nchord sequence, bars 9-40:\n  {' -> '.join(seq)}")
    out.append(f"\nmost common: {Counter(seq).most_common(6)}")

    # register of the keys
    seg = other[int(8 * BAR * sr):int(24 * BAR * sr)]
    S = np.abs(np.fft.rfft(seg))
    f = np.fft.rfftfreq(len(seg), 1 / sr)
    tot = (S ** 2).sum()
    out.append("\nKEYS REGISTER — where the stem's energy actually is:")
    for lo, hi in [(60, 130), (130, 260), (260, 520), (520, 1040), (1040, 2080),
                   (2080, 4160), (4160, 12000)]:
        share = 100 * (S[(f >= lo) & (f < hi)] ** 2).sum() / tot
        out.append(f"  {lo:5}-{hi:<5} Hz  {share:5.1f}%  {'#' * int(share / 2)}")

    # ── THE BASS ───────────────────────────────────────────────────────────
    bass, _ = load("bass")
    out.append("\n\n## THE BASS — note per beat, bars 9-24\n")
    notes = []
    for b in range(8, 24):
        for beat in range(4):
            t0 = (b * BAR) + beat * BAR / 4
            seg = bass[int(t0 * sr):int((t0 + BAR / 4) * sr)]
            if len(seg) < 1024:
                continue
            w = np.pad(seg * np.hanning(len(seg)), (0, 4 * len(seg)))
            Sb = np.abs(np.fft.rfft(w))
            fb = np.fft.rfftfreq(len(w), 1 / sr)
            k = (fb > 35) & (fb < 400)
            pk = fb[k][np.argmax(Sb[k])]
            midi = int(round(69 + 12 * np.log2(pk / 440)))
            notes.append(midi)
    out.append("  " + "  ".join(f"{NAMES[m%12]}{m//12-1}" for m in notes[:32]))
    if len(notes) > 1:
        iv = [notes[i + 1] - notes[i] for i in range(len(notes) - 1)]
        oct_leaps = sum(1 for i in iv if abs(i) == 12)
        out.append(f"\n  distinct pitch classes : {len(set(m % 12 for m in notes))}")
        out.append(f"  register               : {min(notes)}-{max(notes)} MIDI = "
                   f"{440*2**((min(notes)-69)/12):.0f}-{440*2**((max(notes)-69)/12):.0f} Hz")
        out.append(f"  median |interval|      : {np.median(np.abs(iv)):.0f} semitones")
        out.append(f"  OCTAVE LEAPS           : {oct_leaps} of {len(iv)} moves "
                   f"= {100*oct_leaps/len(iv):.0f}%")

    # ── THE DRUMS ──────────────────────────────────────────────────────────
    drums, _ = load("drums")
    g, ph = onset_grid(drums, sr)
    out.append(f"\n\n## THE DRUMS — which 16th gets struck (16 bars summed)")
    out.append(f"   downbeat found {ph}/16 of a bar from where the tempo grid put it\n")
    mx = g.max() or 1
    for i in range(16):
        lab = ["1", "e", "&", "a"][i % 4] if i % 4 else str(i // 4 + 1)
        out.append(f"  step {i:2} ({lab})  {'#' * int(20 * g[i] / mx):20} {int(g[i])}")

    # ── THE VOCAL ──────────────────────────────────────────────────────────
    vox, _ = load("vocals")
    out.append("\n\n## THE VOCAL — presence per 8 bars\n")
    for b in range(0, 48, 8):
        seg = vox[int(b * BAR * sr):int((b + 8) * BAR * sr)]
        if not len(seg):
            break
        r = 20 * np.log10(np.sqrt((seg ** 2).mean()) + 1e-12)
        out.append(f"  bars {b+1:3}-{b+8:<3}  {r:6.1f} dB  "
                   f"{'IN' if r > -40 else 'out'}")

    # ── BALANCE ────────────────────────────────────────────────────────────
    out.append("\n\n## STEM BALANCE — what sits where in the mix\n")
    tot_rms = {}
    for nm in ("drums", "bass", "other", "vocals"):
        y, _ = load(nm)
        tot_rms[nm] = 20 * np.log10(np.sqrt((y ** 2).mean()) + 1e-12)
    ref = max(tot_rms.values())
    for nm, v in sorted(tot_rms.items(), key=lambda kv: -kv[1]):
        out.append(f"  {nm:8} {v:7.1f} dB   {v-ref:+6.1f} vs the loudest")

    text = "\n".join(out)
    print(text)
    (HERE / "data" / "breakbot-stems.txt").write_text(text)


if __name__ == "__main__":
    main()
