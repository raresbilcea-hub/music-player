"""
melody_extract.py -- pull note events off a separated `other` stem and reduce
them to something a human can read: pitches, scale degrees, intervals, contour.

WHY THIS EXISTS. Three melodies were written from rule tables and all three were
rejected. `references/genre-research/writing-a-tune.md` says the fix is to start
from something a human actually wrote. The four House Inspo tracks are already
Demucs-separated, and on the `other` stem Melodia returns 7 diatonic pitch
classes against 11 chromatic ones on the full mix -- the stem is what makes the
table readable.

WHAT IT DOES NOT DO. It does not know which notes are "the melody". A pitch
tracker returns the most salient f0 frame by frame; over a house record that is
sometimes the lead, sometimes the top of a chord, sometimes a vocal. The output
is a menu for Paul to listen against, not a transcription.

⚠️ THE DOWNBEAT LIMIT, stated up front because it cost a wrong table in the
research run. RhythmExtractor2013 returns BEATS, not DOWNBEATS. `ticks[0]` is
*a* beat with no guarantee it is beat 1. So:
    - the 16th position WITHIN THE BEAT (1=on, 2=e, 3=&, 4=a) is correct
    - the bar-relative step (1-16) is only correct modulo 4 unless the backbeat
      detector below pins it, and it is printed as `~` when unpinned.
The backbeat detector looks for clap/snare energy (1.5-4 kHz) on alternating
beats, which pins the bar phase modulo 2. That is as far as measurement gets
here; the rest is Paul tapping along.

Run:  /Users/paul/miniconda3/bin/python3 library/melody_extract.py
      [--track NAME] [--start 90] [--dur 30] [--all]
"""
import argparse, glob, json, os, sys
import numpy as np
import essentia.standard as es

SR = 44100
STEMS = "library/inspo/stems/htdemucs"
NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
# scale-degree names relative to the tonic, minor-ish spelling (these records are minor)
DEG = ["1", "b2", "2", "b3", "3", "4", "b5", "5", "b6", "6", "b7", "7"]


def note_name(midi):
    m = int(round(midi))
    return f"{NAMES[m % 12]}{m // 12 - 1}"


def load(path, start=0.0, dur=None):
    a = es.MonoLoader(filename=path, sampleRate=SR)()
    i0 = int(start * SR)
    i1 = len(a) if dur is None else min(len(a), i0 + int(dur * SR))
    return a[i0:i1]


def band_energy(x, lo, hi):
    """envelope of x band-limited to [lo,hi] Hz, 512-sample hop"""
    from scipy.signal import butter, sosfiltfilt
    sos = butter(4, [lo / (SR / 2), hi / (SR / 2)], btype="band", output="sos")
    y = sosfiltfilt(sos, x)
    hop = 512
    n = len(y) // hop
    return np.sqrt(np.mean(y[: n * hop].reshape(n, hop) ** 2, axis=1)), hop


def backbeat_phase(drums, beats, t0):
    """
    Which beats carry the clap? Returns 0 or 1: the parity of beat index that is
    LOUDEST in the clap band. Backbeat is on 2 and 4, so downbeats are the OTHER
    parity. Pins the bar phase mod 2, not mod 4.
    """
    env, hop = band_energy(drums, 1500, 4000)
    idx = [int((b - t0) * SR / hop) for b in beats]
    idx = [i for i in idx if 0 <= i < len(env)]
    if len(idx) < 8:
        return None, 0.0
    ev = np.array([env[i] for i in idx])
    a, b = ev[0::2].mean(), ev[1::2].mean()
    conf = abs(a - b) / (a + b + 1e-12)
    return (0 if a > b else 1), float(conf)


def extract(path_other, path_drums=None, start=0.0, dur=None,
            fmin=180.0, fmax=1400.0, voicing=0.4, min_dur=0.12):
    audio = load(path_other, start, dur)
    key, scale, strength = es.KeyExtractor(profileType="edma")(audio)
    bpm, ticks, conf, _, _ = es.RhythmExtractor2013(method="multifeature")(audio)

    pitch, _ = es.PredominantPitchMelodia(
        frameSize=2048, hopSize=128,
        minFrequency=fmin, maxFrequency=fmax,
        voicingTolerance=voicing)(audio)
    onsets, durs, midi = es.PitchContourSegmentation(
        hopSize=128, minDuration=min_dur)(pitch, audio)

    # 🔴 essentia's KeyExtractor returns FLAT names — 'Eb', 'Bb', 'Ab' — and
    # NAMES is spelled in sharps, so `NAMES.index('Eb')` raises. It killed all
    # five windows of **Manasarovar**, which is the one record the handoff
    # explicitly asked to re-run, and the failure looked like a bad file
    # rather than a spelling table.
    FLAT = {"Db": "C#", "Eb": "D#", "Gb": "F#", "Ab": "G#", "Bb": "A#"}
    tonic = NAMES.index(FLAT.get(key, key))
    step = (60.0 / bpm) / 4.0          # one 16th, seconds
    t0 = ticks[0] if len(ticks) else 0.0

    bar_phase, bb_conf = (None, 0.0)
    if path_drums and os.path.exists(path_drums):
        drums = load(path_drums, start, dur)
        par, bb_conf = backbeat_phase(drums, ticks, 0.0)
        if par is not None and bb_conf > 0.15:
            # downbeats are the parity that is NOT the clap parity
            bar_phase = 1 - par

    notes = []
    for on, dr, m in zip(onsets, durs, midi):
        on = float(on) + start            # absolute time in the record, so he can find it
        k = int(round((on - start - t0) / step))
        beat16 = k % 4 + 1                       # position within the beat: correct
        bar16 = (k % 16 + 1) if bar_phase is not None else None
        notes.append(dict(t=on, dur=float(dr), midi=int(round(m)),
                          name=note_name(m), deg=DEG[(int(round(m)) - tonic) % 12],
                          pc=(int(round(m)) - tonic) % 12,
                          beat16=beat16, bar16=bar16))
    return dict(key=key, scale=scale, key_strength=float(strength),
                bpm=float(bpm), beat_conf=float(conf), sixteenth=step,
                bar_phase_pinned=bar_phase is not None, backbeat_conf=bb_conf,
                notes=notes)


def phrases(notes, gap_beats=1.0, sixteenth=0.125):
    """split into phrases wherever the silence between notes exceeds gap_beats"""
    gap = gap_beats * sixteenth * 4
    out, cur = [], []
    for n in notes:
        if cur and n["t"] - (cur[-1]["t"] + cur[-1]["dur"]) > gap:
            out.append(cur)
            cur = []
        cur.append(n)
    if cur:
        out.append(cur)
    return out


def parsons(ms):
    return "".join("U" if b > a else ("D" if b < a else "R") for a, b in zip(ms, ms[1:]))


def describe(ph):
    ms = [n["midi"] for n in ph]
    iv = [b - a for a, b in zip(ms, ms[1:])]
    return dict(n=len(ms), span=max(ms) - min(ms) if ms else 0,
                intervals=iv, parsons=parsons(ms),
                nbig=sum(1 for i in iv if abs(i) >= 4),
                nstep=sum(1 for i in iv if 0 < abs(i) <= 2),
                nrep=sum(1 for i in iv if i == 0),
                loops=len(ms) > 2 and ms[0] == ms[-1],
                bars=(ph[-1]["t"] + ph[-1]["dur"] - ph[0]["t"]))


def report(name, r, max_phrases=14):
    print(f"\n{'='*78}\n{name}")
    pin = ("bar phase PINNED by backbeat (conf %.2f)" % r["backbeat_conf"]
           if r["bar_phase_pinned"] else "bar phase NOT pinned -- step is within-beat only")
    print(f"  key {r['key']} {r['scale']} (strength {r['key_strength']:.2f}) · "
          f"{r['bpm']:.1f} BPM (conf {r['beat_conf']:.1f}) · {pin}")
    ns = r["notes"]
    if not ns:
        print("  no notes")
        return
    pcs = {}
    for n in ns:
        pcs[n["deg"]] = pcs.get(n["deg"], 0) + 1
    tot = len(ns)
    order = sorted(pcs.items(), key=lambda kv: -kv[1])
    print(f"  {tot} notes · {len(pcs)} pitch classes · "
          + " ".join(f"{d}:{c*100//tot}%" for d, c in order))

    phs = phrases(ns, 1.0, r["sixteenth"])
    ivall = [b["midi"] - a["midi"] for a, b in zip(ns, ns[1:])]
    iv_in = [abs(i) for i in ivall if abs(i) < 24]
    if iv_in:
        print(f"  intervals: {sum(1 for i in iv_in if i<=2)*100//len(iv_in)}% step(<=2) · "
              f"{sum(1 for i in iv_in if i>=4)*100//len(iv_in)}% leap(>=4) · "
              f"median {int(np.median(iv_in))} semitones")
    print(f"  {len(phs)} phrases, median {int(np.median([len(p) for p in phs]))} notes each")

    print(f"\n  {'bar':>5} {'beat16':>7}  phrase")
    ranked = sorted(phs, key=lambda p: -len(p))[:max_phrases]
    ranked.sort(key=lambda p: p[0]["t"])
    for p in ranked:
        d = describe(p)
        step_col = "".join(str(n["bar16"] if n["bar16"] else n["beat16"]) for n in p[:12])
        toks = " ".join(f"{n['name']}({n['deg']})" for n in p[:12])
        tail = " …" if len(p) > 12 else ""
        print(f"  {p[0]['t']:5.1f}s {step_col:>7}  {toks}{tail}")
        print(f"         {'':>7}  → {d['parsons']}  span {d['span']}st  "
              f"{d['nbig']} leap≥4 / {d['nstep']} step / {d['nrep']} rep"
              f"{'  LOOPS' if d['loops'] else ''}  ({d['bars']:.1f}s)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stems", default=STEMS,
                    help="folder of Demucs output dirs. Defaults to the four "
                         "House Inspo records; point it at stems-refs to read "
                         "the track-two reference set instead.")
    ap.add_argument("--track", default=None, help="substring of the folder name")
    ap.add_argument("--start", type=float, default=60.0)
    ap.add_argument("--dur", type=float, default=45.0)
    ap.add_argument("--all", action="store_true", help="whole track, ignore --start/--dur")
    ap.add_argument("--fmin", type=float, default=180.0)
    ap.add_argument("--fmax", type=float, default=1400.0)
    ap.add_argument("--json", default=None)
    a = ap.parse_args()

    dirs = sorted(glob.glob(os.path.join(a.stems, "*")))
    if a.track:
        dirs = [d for d in dirs if a.track.lower() in os.path.basename(d).lower()]
    if not dirs:
        sys.exit(f"no stems found under {a.stems}")

    out = {}
    for d in dirs:
        other = os.path.join(d, "other.wav")
        drums = os.path.join(d, "drums.wav")
        if not os.path.exists(other):
            continue
        r = extract(other, drums,
                    start=0.0 if a.all else a.start,
                    dur=None if a.all else a.dur,
                    fmin=a.fmin, fmax=a.fmax)
        name = os.path.basename(d)
        out[name] = r
        report(name, r)

    if a.json:
        with open(a.json, "w") as f:
            json.dump(out, f, indent=1)
        print(f"\nwrote {a.json}")


if __name__ == "__main__":
    main()


# ── CONSENSUS ───────────────────────────────────────────────────────────────
# 🔴 WHY THIS EXISTS. A single Melodia run is NOT reproducible on this material:
# the same five seconds of the same stem returned three different note lists
# depending only on where the analysis window started, including octave
# disagreements. I reported one of those runs to Paul as though it were a
# transcription. It was not.
#
# So: run the chain over many overlapping windows, quantise onsets to a 16th
# grid, and take the MODAL pitch in each slot along with how strongly the runs
# agreed. A note that eight windows out of eight place at the same pitch is a
# fact about the record; a note that three of eight agree on is a guess, and it
# is now labelled as one.
def consensus(path_other, centre, span=8.0, n_windows=9, pad=14.0,
              bpm=None, fmin=250.0, fmax=1200.0, min_dur=0.10):
    import collections
    runs, bpms = [], []
    for k in range(n_windows):
        st = centre - pad + (2 * pad - span) * k / max(1, n_windows - 1)
        r = extract(path_other, None, start=max(0.0, st), dur=span + pad,
                    fmin=fmin, fmax=fmax, min_dur=min_dur)
        bpms.append(r["bpm"])
        runs.append([n for n in r["notes"] if centre <= n["t"] < centre + span])
    tempo = bpm or sorted(bpms)[len(bpms) // 2]
    s16 = 60.0 / tempo / 4.0
    slots = collections.defaultdict(list)
    for r in runs:
        for n in r:
            slots[int(round((n["t"] - centre) / s16))].append(n["midi"])
    out = []
    for k in sorted(slots):
        votes = collections.Counter(slots[k])
        midi, cnt = votes.most_common(1)[0]
        out.append(dict(slot=k, midi=midi, agree=cnt / n_windows,
                        alts=dict(votes), t=centre + k * s16))
    return out, tempo, s16
