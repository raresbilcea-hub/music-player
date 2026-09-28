"""
analyse.py — measure every track in the library and write a tag file.

No installs. numpy + soundfile + ffmpeg, all already here.

What it extracts per track:
    tempo        BPM, from onset-envelope autocorrelation.
                 ⚠️ CORRECTED 5 Aug 2026 — this used to say "searched 110-140".
                 It is not. The lag bounds are INTEGER frame counts at 86.13
                 fps, so the reachable range is 114.8-143.6 BPM and the
                 estimator can only ever emit TEN values: 114.8 117.5 120.2
                 123.0 126.0 129.2 132.5 136.0 139.7 143.6. Adjacent bins near
                 house tempo are ~3 BPM apart, so a "3 BPM difference" between
                 two populations is one bin. 11% of the influences and 17% of
                 the playlist sit on a boundary value (114.8 / 143.6), meaning
                 their true tempo is outside the window and was clamped —
                 which is why Tame Impala and Dope Lemon tempi are unusable.
    key          tonic + major/minor, from bass-band chroma correlated against
                 major/minor profiles.
                 🔴 DO NOT USE THIS COLUMN. Measured 5 Aug 2026 against Essentia's
                 KeyExtractor(profileType='edma') and against harmony.py: this
                 estimator returns **Am for 39% of the playlist and 41% of the
                 influences**. A 431-track house corpus is not 41% A minor --
                 that is a detector artefact, and any past claim that "his
                 library is mostly A minor" is a property of this function.
                 edma puts Am at 9%. On the 63 tracks harmony.py also covers,
                 edma agrees 37% of the time and this column 19%. See
                 references/genre-research/the-lane-measured.md §4.
    energy       0-10, normalised WITHIN this collection rather than absolutely.
                 Mixed In Key's 1-10 is absolute across all music, which squashes
                 house into 5-7 and tells you nothing. Ours spreads across what
                 Paul actually listens to.
    brightness   % of spectral energy above 6 kHz -- "airy" vs "dark"
    weight       % below 150 Hz -- how bass-forward it is
    crest        peak-to-RMS in dB -- punchy vs squashed
    density      onsets per second -- busy vs sparse. This is the number that
                 turned out to matter: what he called "too fast" was density.

ON ACCURACY, honestly: BPM on 4-on-the-floor house is close to exact. Key is
roughly 70-75% -- the free tools all land there, and Mixed In Key at ~89% is the
paid standard. Good enough to sort and study a collection; not good enough to
harmonically mix a set off blindly.

Usage:  python3 analyse.py            # analyse everything new
        python3 analyse.py --report   # just print the summary
"""

import json, subprocess, sys, tempfile
from pathlib import Path
import numpy as np
import soundfile as sf

HERE = Path(__file__).parent
DATA = HERE / "data"
AUDIO = HERE / "audio"
TAGS = DATA / "tags.json"
SR = 22050          # plenty for analysis, and 2x faster than 44.1k

NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Krumhansl-Schmuckler profiles. The research flagged that `temperley` is
# derived from euroclassical corpora and gets house wrong; these are the
# general-purpose ones and they behave acceptably on 4/4 dance material.
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def load(path, max_seconds=180):
    """Decode to mono. 3 minutes from the middle is plenty and much faster."""
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as t:
        tmp = t.name
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", "30", "-t", str(max_seconds),
                    "-i", str(path), "-ac", "1", "-ar", str(SR), tmp],
                   check=True, capture_output=True)
    x, _ = sf.read(tmp)
    Path(tmp).unlink(missing_ok=True)
    return x.astype(np.float64)


def onset_env(x, hop=256, n=1024):
    """Spectral flux — the raw material for both tempo and density."""
    win = np.hanning(n)
    frames = np.array([np.abs(np.fft.rfft(x[i:i + n] * win))
                       for i in range(0, len(x) - n, hop)])
    flux = np.maximum(np.diff(frames, axis=0), 0).sum(axis=1)
    return flux - flux.mean(), SR / hop


def tempo(flux, fps):
    ac = np.correlate(flux, flux, "full")[len(flux) - 1:]
    lo, hi = int(fps * 60 / 140), int(fps * 60 / 110)      # house lives here
    if hi >= len(ac):
        return float("nan")
    return 60.0 * fps / (lo + int(np.argmax(ac[lo:hi])))


def density(flux, fps):
    """Onsets per second. Busy tracks and sparse tracks at the same BPM feel
    completely different, and no BPM number captures that."""
    thr = flux.mean() + flux.std()
    peaks = (flux[1:-1] > flux[:-2]) & (flux[1:-1] > flux[2:]) & (flux[1:-1] > thr)
    return peaks.sum() / (len(flux) / fps)


def spectrum(x, n=8192):
    win, acc, count = np.hanning(n), np.zeros(n // 2 + 1), 0
    for i in range(0, len(x) - n, n // 2):
        acc += np.abs(np.fft.rfft(x[i:i + n] * win)) ** 2
        count += 1
    return acc / max(count, 1), np.fft.rfftfreq(n, 1 / SR)


def key_of(x):
    """
    Bass-band chroma. House basslines sit on the root, which makes the low end a
    far more reliable key cue than the full spectrum (pads and vocals confuse it).
    """
    n, hop = 8192, 4096
    freqs = np.fft.rfftfreq(n, 1 / SR)
    band = (freqs >= 55) & (freqs <= 520)
    pc = (np.round(12 * np.log2(np.maximum(freqs[band], 1e-9) / 440.0) + 69).astype(int)) % 12
    win, chroma = np.hanning(n), np.zeros(12)
    for i in range(0, len(x) - n, hop):
        np.add.at(chroma, pc, np.abs(np.fft.rfft(x[i:i + n] * win))[band] ** 2)
    if chroma.sum() == 0:
        return "?", 0.0
    chroma /= chroma.sum()
    best, score = None, -9
    for shift in range(12):
        rot = np.roll(chroma, -shift)
        for prof, mode in ((MAJOR, ""), (MINOR, "m")):
            c = np.corrcoef(rot, prof)[0, 1]
            if c > score:
                score, best = c, f"{NAMES[shift]}{mode}"
    return best, float(score)


def camelot(key):
    """The wheel DJs actually use. 8A/8B etc."""
    order_major = ["B", "F#", "C#", "G#", "D#", "A#", "F", "C", "G", "D", "A", "E"]
    order_minor = ["G#", "D#", "A#", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"]
    if key.endswith("m"):
        root = key[:-1]
        return f"{order_minor.index(root) + 1}A" if root in order_minor else "?"
    return f"{order_major.index(key) + 1}B" if key in order_major else "?"


def analyse(path):
    x = load(path)
    if len(x) < SR * 5:
        return None
    flux, fps = onset_env(x)
    spec, freqs = spectrum(x)
    total = spec.sum() or 1.0
    peak = float(np.max(np.abs(x))) or 1e-9
    rms = float(np.sqrt(np.mean(x ** 2))) or 1e-9
    k, conf = key_of(x)
    return {
        "tempo": round(float(tempo(flux, fps)), 1),
        "key": k,
        "camelot": camelot(k),
        "key_confidence": round(conf, 2),
        "density": round(float(density(flux, fps)), 2),
        "brightness": round(100 * float(spec[freqs >= 6000].sum() / total), 2),
        "weight": round(100 * float(spec[freqs < 150].sum() / total), 2),
        "crest": round(20 * np.log10(peak / rms), 1),
        "rms_db": round(20 * np.log10(rms), 1),
    }


def main():
    titles = {}
    pj = DATA / "playlist.json"
    if pj.exists():
        for e in json.load(open(pj)).get("entries", []):
            titles[e["id"]] = e.get("title", "")

    tags = json.load(open(TAGS)) if TAGS.exists() else {}
    files = sorted(AUDIO.glob("*.opus"))
    todo = [f for f in files if f.stem not in tags]
    print(f"{len(files)} downloaded · {len(tags)} already analysed · {len(todo)} to do")

    for i, f in enumerate(todo, 1):
        try:
            r = analyse(f)
            if r:
                r["title"] = titles.get(f.stem, f.stem)
                tags[f.stem] = r
                print(f"  [{i}/{len(todo)}] {r['tempo']:5.1f} BPM  {r['key']:3s} "
                      f"{r['camelot']:3s}  {r['title'][:44]}")
        except Exception as e:
            print(f"  [{i}/{len(todo)}] FAILED {f.name}: {e}")
        if i % 10 == 0:
            json.dump(tags, open(TAGS, "w"), indent=1)
    json.dump(tags, open(TAGS, "w"), indent=1)
    report(tags)


def report(tags=None):
    tags = tags or json.load(open(TAGS))
    if not tags:
        print("nothing analysed yet")
        return
    v = list(tags.values())
    bpm = np.array([t["tempo"] for t in v])
    dens = np.array([t["density"] for t in v])

    # Energy is normalised WITHIN the collection -- see the module docstring.
    raw = np.array([t["density"] for t in v]) * np.array([t["weight"] for t in v]) ** 0.4
    rank = raw.argsort().argsort() / max(len(raw) - 1, 1)
    for t, e in zip(v, rank):
        t["energy"] = int(round(1 + e * 9))
    json.dump(tags, open(TAGS, "w"), indent=1)

    print(f"\n{'='*58}\n  {len(v)} TRACKS — WHAT PAUL ACTUALLY LISTENS TO\n{'='*58}")
    print(f"\n  TEMPO   median {np.median(bpm):.0f} BPM   "
          f"middle half {np.percentile(bpm,25):.0f}-{np.percentile(bpm,75):.0f}")
    hist, edges = np.histogram(bpm, bins=np.arange(110, 145, 2.5))
    for h, lo in zip(hist, edges):
        if h:
            print(f"    {lo:5.1f}-{lo+2.5:5.1f}  {'#'*h} {h}")

    keys = {}
    for t in v:
        keys[t["key"]] = keys.get(t["key"], 0) + 1
    minor = sum(n for k, n in keys.items() if k.endswith("m"))
    print(f"\n  KEY     {minor}/{len(v)} minor ({100*minor/len(v):.0f}%)")
    for k, n in sorted(keys.items(), key=lambda x: -x[1])[:6]:
        print(f"    {k:4s} {camelot(k):4s} {'#'*n} {n}")

    print(f"\n  DENSITY median {np.median(dens):.1f} onsets/sec  "
          f"(this is the 'busy vs sparse' axis — what reads as 'too fast')")
    print(f"  WEIGHT  median {np.median([t['weight'] for t in v]):.0f}% of energy below 150 Hz")
    print(f"  AIR     median {np.median([t['brightness'] for t in v]):.2f}% above 6 kHz")

    print(f"\n  THE FIVE MOST 'CHILLED' (low energy, sparse):")
    for t in sorted(v, key=lambda t: t["energy"])[:5]:
        print(f"    e{t['energy']}  {t['tempo']:5.1f}  {t['key']:3s}  {t['title'][:44]}")
    print(f"\n  THE FIVE HIGHEST ENERGY:")
    for t in sorted(v, key=lambda t: -t["energy"])[:5]:
        print(f"    e{t['energy']}  {t['tempo']:5.1f}  {t['key']:3s}  {t['title'][:44]}")
    print(f"\n  -> tags.json")


if __name__ == "__main__":
    report() if "--report" in sys.argv else main()
