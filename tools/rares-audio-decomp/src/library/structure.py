"""
structure.py — measure ARRANGEMENT STRUCTURE across the influence library.

Why this exists
---------------
`PLAYBOOK.md` §6 prescribes a 240-bar arrangement derived from exactly two things:
a median duration (ADID club releases, 7:53) and ONE published bar map of Ame's
"Rej" — a bar map whose own research note (`references/genre-research/arrangement.md`
§2) flags a documented source conflict. One bar map is not a measurement.

There are ~500 influence tracks on disk. This measures them.

What it measures, per track
---------------------------
    bars_total        length in bars on a fitted uniform bar grid
    section_bars      section lengths in bars — this is how "is the 16-bar unit
                      real?" gets tested
    rayleigh          THE PERIODICITY LADDER. Rayleigh Z of the boundary positions
                      against a P-bar grid, P in 4/8/12/16/24/32. It discriminates
                      8 from 16 from 32 rather than just confirming "some grid" —
                      see `rayleigh()` for why, and `--selftest` for the proof.
    first_lift        first bar the smoothed energy curve crosses the midpoint of
                      its own range — "where does the track actually take off"
    breakdown         longest stretch sitting >=6 dB below its own local context in
                      the sub-150 Hz band (i.e. the kick leaving), with its length
    energy_levels     how many distinct plateaus the energy curve uses (1-D k-means)
    intro / outro     bars before energy first reaches the track median, and after
                      it last leaves it
    melodic_entry     first bar the 300-3000 Hz band (where melody lives) crosses
                      the midpoint of its own range and stays there for >=8 bars
    profile_*         the whole energy / low / mid / onset curve resampled to 100
                      points, so 190 tracks of different lengths can be averaged
                      into one measured shape. This is the thing one bar map
                      cannot give you.

METHOD NOTES, honestly
----------------------
* Downbeats come from `beat_this` (ISMIR 2024) on MPS, then a UNIFORM bar grid is
  least-squares fitted to the beat sequence. beat_this quantises to 20 ms, so a
  median gap is only ~1% accurate — two whole bars of drift over 200 bars — and it
  intermittently emits a downbeat half a bar early.
* Boundaries are snapped to bar lines and NOTHING ELSE. Snapping to an 8- or
  16-bar grid would make the "sections come in 16s" question circular.
* The checkerboard kernel half-width L sets the smallest section the novelty curve
  can resolve. Everything is reported at L=8 bars (primary) and L=4 (sensitivity),
  because that parameter is the one that could manufacture the answer.
* `melodic_entry` is a BAND-ENERGY PROXY, not melody detection. A filtered pad and
  a lead read the same. Treat it as "when does the midrange fill", which is the
  observable the playbook's "nothing melodic until bar 49" claim is really about.
* THE SAMPLE IS YOUTUBE RIPS. That skews toward radio and album edits rather than
  extended club mixes, which shortens every length statistic here. The Lee Burridge
  folder happens to contain both cuts of the same records, so `extended_vs_edit()`
  measures the size of that skew instead of guessing at it.

Usage
-----
    python3 structure.py --plan              # print the stratified sample, do nothing
    python3 structure.py --selftest          # prove the periodicity ladder works
    python3 structure.py --run [--limit N]   # analyse, append to data/structure.json
    python3 structure.py --report            # aggregate stats + playbook claim tests

Runs ONE process. No parallelism — other jobs share this machine.
NEVER touches REAPER.
"""

import json
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
DATA = HERE / "data"
INFL = HERE / "influences"
OUT = DATA / "structure.json"
DURATIONS = DATA / "durations.json"

SR = 22050
NFFT = 2048
HOP = 512
FPS = SR / HOP                       # 43.07 frames/sec

MIN_DUR = 150.0                      # below this there is no arrangement to measure
MAX_DUR = 900.0                      # above this it is a DJ set, not a track

# Titles that are not tracks. YouTube channel rips are full of these.
JUNK = ("interview", "teaser", "trailer", "making of", "making-of", "album teaser",
        "live stream", "livestream", "out now", "coming this friday", "announcement",
        "(preview)", "snippet", "behind the scenes",
        # live jams / DJ-set excerpts / channel filler, not released tracks
        "modular", "freestyle", "studio jam", "farm stream", "deajaying", "djing",
        "global gathering", "(part 1", "(part 2", " @ ", "boiler room", "live set")

# ---------------------------------------------------------------------------
# sample selection
# ---------------------------------------------------------------------------

# The influences/ folder is a record of what was DOWNLOADABLE, not a ranking of
# taste. Paul's NAMED influences are Lee Burridge / All Day I Dream, Solomun,
# Tame Impala, Dope Lemon. Everything else in the folder is label-mates or was
# swept up by the fetch scripts; it is a fair sample of the lane and nothing more.
CLUB = {"Lee Burridge", "ADID roster", "Solomun"}      # four-to-the-floor
BAND = {"Tame Impala", "Dope Lemon", "RUFUS DU SOL"}   # songs, for contrast

# how many to take from each top-level folder
# Sized so the club side carries the statistics (it is the question being asked)
# while the band side is big enough to be a real contrast rather than an anecdote.
# ~13 s/track measured, so this is a single ~40-minute nice'd process.
QUOTA = {
    "Lee Burridge": 63,      # the whole folder — he is the named influence
    "ADID roster": 70,       # round-robin across the six label artists on disk
    "Solomun": 29,           # the whole folder once DJ sets and channel filler are out
    "Tame Impala": 12,
    "Dope Lemon": 12,
    "RUFUS DU SOL": 10,
}


def candidates():
    """Every influence file that is plausibly a single track, with its duration."""
    durs = json.load(open(DURATIONS)) if DURATIONS.exists() else {}
    out = []
    for rel, dur in durs.items():
        p = INFL / rel
        if not p.exists():
            continue
        if not (MIN_DUR <= dur <= MAX_DUR):
            continue
        name = p.stem.lower()
        if any(j in name for j in JUNK):
            continue
        # Solomun's channel is mostly DJ sets titled "Venue // City // date"
        if "//" in rel or "⧸⧸" in rel:
            continue
        out.append({"rel": rel, "dur": dur, "folder": rel.split("/")[0],
                    "sub": rel.split("/")[1] if rel.count("/") > 1 else rel.split("/")[0]})
    return out


def stratified(cands, seed=20260805):
    """Even spread within each folder's sub-artists, deterministic."""
    rng = np.random.default_rng(seed)
    by_folder = {}
    for c in cands:
        by_folder.setdefault(c["folder"], []).append(c)
    picked = []
    for folder, want in QUOTA.items():
        pool = by_folder.get(folder, [])
        if not pool:
            continue
        subs = {}
        for c in pool:
            subs.setdefault(c["sub"], []).append(c)
        # round-robin across sub-artists so one prolific uploader can't dominate
        order = sorted(subs)
        for s in order:
            rng.shuffle(subs[s])
        take, i = [], 0
        while len(take) < min(want, len(pool)):
            progressed = False
            for s in order:
                if i < len(subs[s]) and len(take) < min(want, len(pool)):
                    take.append(subs[s][i])
                    progressed = True
            if not progressed:
                break
            i += 1
        picked += take
    return sorted(picked, key=lambda c: c["rel"])


# ---------------------------------------------------------------------------
# audio + features
# ---------------------------------------------------------------------------

def decode(path):
    p = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(SR),
         "-f", "f32le", "-"], capture_output=True, check=True)
    return np.frombuffer(p.stdout, dtype=np.float32).astype(np.float64)


def stft_power(x):
    n_frames = 1 + (len(x) - NFFT) // HOP
    if n_frames < 8:
        return None, None
    idx = np.arange(NFFT)[None, :] + HOP * np.arange(n_frames)[:, None]
    win = np.hanning(NFFT)
    P = np.empty((n_frames, NFFT // 2 + 1))
    # chunked so an 8-minute track does not allocate a 3 GB array
    for a in range(0, n_frames, 2048):
        b = min(a + 2048, n_frames)
        P[a:b] = np.abs(np.fft.rfft(x[idx[a:b]] * win, axis=1)) ** 2
    freqs = np.fft.rfftfreq(NFFT, 1 / SR)
    return P, freqs


def log_bands(P, freqs, n=40, lo=40.0, hi=10000.0):
    """Triangular log-spaced filterbank. No librosa in this environment."""
    edges = np.geomspace(lo, hi, n + 2)
    B = np.zeros((P.shape[1], n))
    for i in range(n):
        l, c, r = edges[i], edges[i + 1], edges[i + 2]
        up = (freqs >= l) & (freqs <= c)
        dn = (freqs > c) & (freqs <= r)
        B[up, i] = (freqs[up] - l) / max(c - l, 1e-9)
        B[dn, i] = (r - freqs[dn]) / max(r - c, 1e-9)
    return P @ B


def frame_features(x):
    P, freqs = stft_power(x)
    if P is None:
        return None
    M = log_bands(P, freqs)                       # frames x 40
    logM = np.log10(M + 1e-12)
    flux = np.maximum(np.diff(logM, axis=0), 0).sum(axis=1)
    flux = np.concatenate([[0.0], flux])
    total = P.sum(axis=1) + 1e-12
    def band(a, b):
        return P[:, (freqs >= a) & (freqs < b)].sum(axis=1)
    return {
        "logM": logM,
        "flux": flux,
        "rms_db": 10 * np.log10(P.sum(axis=1) / P.shape[1] + 1e-12),
        # ABSOLUTE band energy, not the fraction. The fraction is a trap: when the
        # kick leaves in a breakdown the midrange FRACTION spikes even though less
        # is playing, which made the first version report melody entering at bar 1.
        "lowE": band(20, 150),
        "midE": band(300, 3000),
        "airE": band(6000, 11025),
        "low_frac": band(20, 150) / total,
        "oct": np.stack([band(a, a * 2) for a in (31.25, 62.5, 125, 250, 500,
                                                  1000, 2000, 4000)], axis=1),
    }


def onset_times(flux):
    thr = flux.mean() + flux.std()
    pk = (flux[1:-1] > flux[:-2]) & (flux[1:-1] >= flux[2:]) & (flux[1:-1] > thr)
    return (np.nonzero(pk)[0] + 1) / FPS


def regular_grid(beats, downs, dur):
    """
    A UNIFORM bar grid, not the raw downbeat list.

    beat_this occasionally drops a downbeat half a bar early — on one ADID track
    26 of 248 gaps were 0.98 s against a 1.94 s bar, which shifted every bar
    number after it. Electronic tracks have a constant tempo, so fit one period
    and one phase and trust that instead.
    """
    beats = np.asarray(beats, float)
    bg = np.diff(beats)
    bg = bg[(bg > 0.2) & (bg < 1.2)]
    if bg.size < 8:
        return None
    # beat_this quantises to 20 ms, so a MEDIAN gap is only ~1% accurate — over
    # 200 bars that is two whole bars of drift. Least-squares the whole beat
    # sequence instead and the period comes out to microseconds.
    beat_sec = float(np.median(bg))
    for _ in range(3):
        k = np.concatenate([[0.0], np.cumsum(np.round(np.diff(beats) / beat_sec))])
        A = np.vstack([k, np.ones_like(k)]).T
        sol, *_ = np.linalg.lstsq(A, beats, rcond=None)
        if abs(sol[0] - beat_sec) < 1e-9:
            beat_sec = float(sol[0])
            break
        beat_sec = float(sol[0])
    if not (0.2 < beat_sec < 1.2):
        return None
    bar_sec = 4 * beat_sec

    # bar phase: which of the four beats is the downbeat
    res = (downs - downs[0]) / bar_sec
    mag = abs(np.exp(2j * np.pi * res).mean())
    off = np.median(((downs - downs[0] + bar_sec / 2) % bar_sec) - bar_sec / 2) \
        if mag > 0.5 else 0.0
    phase = (downs[0] + off) % bar_sec
    n = int(np.floor((dur - phase) / bar_sec))
    if n < 16:
        return None
    grid = phase + bar_sec * np.arange(n + 1)
    d = np.abs(((downs - phase + bar_sec / 2) % bar_sec) - bar_sec / 2)
    conf = float((d < 0.08).mean())
    return grid, bar_sec, beat_sec, conf


def bar_features(F, grid):
    """Aggregate frame features into one vector per bar."""
    nb = len(grid) - 1
    if nb < 16:
        return None
    fr = np.clip((np.asarray(grid) * FPS).astype(int), 0, len(F["flux"]) - 1)
    ons = onset_times(F["flux"])
    out = {k: np.zeros(nb) for k in
           ("rms_db", "lowE_db", "midE_db", "airE_db", "low_frac", "onsets")}
    logM = np.zeros((nb, F["logM"].shape[1]))
    octs = np.zeros((nb, F["oct"].shape[1]))
    for b in range(nb):
        a, z = fr[b], max(fr[b + 1], fr[b] + 1)
        logM[b] = np.median(F["logM"][a:z], axis=0)
        octs[b] = F["oct"][a:z].mean(axis=0)
        out["rms_db"][b] = 10 * np.log10(np.mean(10 ** (F["rms_db"][a:z] / 10)) + 1e-12)
        for src, dst in (("lowE", "lowE_db"), ("midE", "midE_db"), ("airE", "airE_db")):
            out[dst][b] = 10 * np.log10(F[src][a:z].mean() + 1e-12)
        out["low_frac"][b] = F["low_frac"][a:z].mean()
        out["onsets"][b] = np.sum((ons >= grid[b]) & (ons < grid[b + 1]))
    out["logM"] = logM
    # "active elements" proxy: how many octave bands are lit relative to their own
    # quiet floor in THIS track. Rej's published density curve is an element count;
    # this is the closest thing measurable from audio alone.
    oct_db = 10 * np.log10(octs + 1e-12)
    lo = np.percentile(oct_db, 10, axis=0)
    hi = np.percentile(oct_db, 90, axis=0)
    out["active"] = (oct_db > lo + 0.4 * (hi - lo)).sum(axis=1).astype(float)
    return out


# ---------------------------------------------------------------------------
# segmentation
# ---------------------------------------------------------------------------

def smooth(v, w):
    if w <= 1:
        return v.copy()
    k = np.ones(w) / w
    return np.convolve(np.pad(v, (w // 2, w - 1 - w // 2), mode="edge"), k, "valid")


def ssm(logM):
    X = logM - logM.mean(axis=0, keepdims=True)
    sd = X.std(axis=0, keepdims=True)
    X = X / np.where(sd < 1e-9, 1.0, sd)
    X = X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-12)
    return X @ X.T


def novelty(S, L):
    """Foote checkerboard kernel, Gaussian-tapered."""
    ax = np.arange(-L, L + 1)
    X, Y = np.meshgrid(ax, ax)
    K = np.sign(X) * np.sign(Y) * np.exp(-0.5 * ((X / (L * 0.5)) ** 2 + (Y / (L * 0.5)) ** 2))
    n = S.shape[0]
    Sp = np.pad(S, L, mode="edge")
    nov = np.array([float((Sp[i:i + 2 * L + 1, i:i + 2 * L + 1] * K).sum())
                    for i in range(n)])
    nov = np.maximum(nov, 0)
    nov[:L] = 0
    nov[-L:] = 0
    m = nov.max()
    return nov / m if m > 0 else nov


def pick_peaks(nov, alpha=0.7, min_gap=4):
    live = nov[nov > 0]
    if live.size == 0:
        return []
    thr = live.mean() + alpha * live.std()
    cand = [i for i in range(1, len(nov) - 1)
            if nov[i] > nov[i - 1] and nov[i] >= nov[i + 1] and nov[i] > thr]
    cand.sort(key=lambda i: -nov[i])
    kept = []
    for i in cand:
        if all(abs(i - j) >= min_gap for j in kept):
            kept.append(i)
    return sorted(kept)


PERIODS = (4, 8, 12, 16, 24, 32)


def rayleigh(bnds, periods=PERIODS):
    """
    Do the detected boundaries land on a P-bar grid?

    Rayleigh test for phase concentration: map each boundary bar b to the angle
    2*pi*b/P and measure the resultant length R. Z = k*R^2 has an exact null
    (approximately Exp(1) for uniform boundaries), so Z > 3 is roughly p < 0.05.
    Origin-invariant, so it does not matter where bar 1 of the file falls.

    Why this and not a "how much novelty lands on multiples of P" score: taking a
    max over P phases is biased upward for large P, and correcting it by
    permutation fails too, because peak-picking enforces a minimum gap and that
    alone spreads boundaries evenly across phases. The Rayleigh statistic has the
    property that actually matters here — it CLIMBS A LADDER. Boundaries every 8
    bars score high at P=8 but CANCEL at P=16 (alternate boundaries land on 0 and
    8 mod 16). Boundaries every 16 score high at 8 AND 16. So:
        high at 8, low at 16          -> the unit is 8 bars
        high at 8 and 16, low at 32   -> the unit is 16 bars
        high at 8, 16 and 32          -> the unit is 32 bars
    """
    k = len(bnds)
    if k < 4:
        return {}
    b = np.asarray(bnds, float)
    return {str(P): round(float(k * abs(np.exp(2j * np.pi * b / P).mean()) ** 2), 2)
            for P in periods}


# ---------------------------------------------------------------------------
# energy
# ---------------------------------------------------------------------------

def z(v):
    s = v.std()
    return (v - v.mean()) / (s if s > 1e-9 else 1.0)


def energy_curve(bf):
    """
    Density + level + band-activity + low-end presence. Not loudness alone.

    The low-end term matters more than it looks: in this genre the single loudest
    arrangement event is the kick leaving and returning, and on a limited master
    the broadband RMS barely moves when it does.
    """
    return smooth(z(bf["onsets"]) + z(bf["rms_db"]) + z(bf["active"])
                  + z(bf["lowE_db"]), 4)


def levels_1d(v, kmax=8, target_r2=0.80):
    """Smallest k whose 1-D k-means explains target_r2 of the variance."""
    v = v.reshape(-1, 1)
    tot = float(((v - v.mean()) ** 2).sum()) or 1.0
    for k in range(1, kmax + 1):
        c = np.percentile(v, np.linspace(5, 95, k)).reshape(-1, 1)
        for _ in range(60):
            lab = np.argmin((v - c.T) ** 2, axis=1)
            nc = np.array([v[lab == j].mean() if (lab == j).any() else c[j, 0]
                           for j in range(k)]).reshape(-1, 1)
            if np.allclose(nc, c):
                break
            c = nc
        within = float(((v - c[lab]) ** 2).sum())
        if 1 - within / tot >= target_r2:
            return k
    return kmax


def runs_below(mask):
    """[(start, length), ...] for contiguous True runs."""
    out, s = [], None
    for i, m in enumerate(mask):
        if m and s is None:
            s = i
        elif not m and s is not None:
            out.append((s, i - s))
            s = None
    if s is not None:
        out.append((s, len(mask) - s))
    return out


def find_dip(v, drop, ctx=32, lo_frac=0.12, hi_frac=0.92):
    """
    Longest stretch that sits `drop` below its own local context on BOTH sides.

    A global low-percentile threshold does not work here: on tracks with a long
    fade-out the outro sets the floor and the real breakdown never crosses it.
    A bar counts as dipped only if the 32 bars before it AND the 32 bars after it
    both contain material `drop` higher — which is what a breakdown is.
    """
    n = len(v)
    dipped = np.zeros(n, bool)
    for b in range(int(lo_frac * n), int(hi_frac * n)):
        pre, post = v[max(0, b - ctx):b], v[b + 1:b + 1 + ctx]
        if pre.size and post.size and pre.max() >= v[b] + drop and post.max() >= v[b] + drop:
            dipped[b] = True
    runs = sorted(runs_below(dipped), key=lambda r: -r[1])
    if not runs:
        return None
    s, ln = runs[0]
    return {"start_bar": s + 1, "bars": int(ln), "at_frac": round((s + ln / 2) / n, 3)}


def measure_energy(E, low_db, nbars):
    lo, hi = np.percentile(E, 5), np.percentile(E, 95)
    rng = max(hi - lo, 1e-9)
    med = float(np.median(E))
    half = lo + 0.5 * rng

    above_half = np.nonzero(E >= half)[0]
    first_lift = int(above_half[0]) if above_half.size else None

    above_med = np.nonzero(E >= med)[0]
    intro = int(above_med[0]) if above_med.size else None
    outro = int(nbars - 1 - above_med[-1]) if above_med.size else None

    # A house breakdown is, operationally, the kick leaving. 6 dB down in the
    # sub-150 Hz band is the primary test; the composite-energy dip is the
    # fallback for breakdowns that keep the kick in.
    kick = find_dip(smooth(low_db, 2), 6.0)
    dip = kick or find_dip(E, 0.5 * rng)
    return {
        "breakdown_by": "kick" if kick else ("energy" if dip else None),
        "first_lift_bar": None if first_lift is None else first_lift + 1,
        "first_lift_frac": None if first_lift is None else round(first_lift / nbars, 3),
        "intro_bars": intro,
        "outro_bars": outro,
        "breakdown": dip,
        "energy_levels": levels_1d(E),
    }


def melodic_entry(bf, nbars):
    m = smooth(bf["midE_db"], 4)
    lo, hi = np.percentile(m, 5), np.percentile(m, 95)
    thr = lo + 0.5 * (hi - lo)
    over = m >= thr
    for s, ln in runs_below(over):
        if ln >= 8:
            return s + 1, round(s / nbars, 3)
    return None, None


# ---------------------------------------------------------------------------
# per track
# ---------------------------------------------------------------------------

_F2B = {}


def _tracker(device):
    if device not in _F2B:
        import torch
        torch.set_num_threads(2)                      # share the machine
        from beat_this.inference import File2Beats
        _F2B[device] = File2Beats(device=device, dbn=False)
    return _F2B[device]


def beats_of(path):
    """MPS first; fall back to CPU on an out-of-memory error.

    This machine runs other people's Essentia and TensorFlow jobs at the same
    time — five tracks in the first full pass died on `MPS backend out of memory`
    with 16.8 GB held by something else. That is a transient condition, not a
    property of the file, so it must not be recorded as a failed track.
    """
    try:
        beats, downs = _tracker("mps")(str(path))
    except RuntimeError as e:
        if "out of memory" not in str(e).lower():
            raise
        import torch
        torch.mps.empty_cache()
        beats, downs = _tracker("cpu")(str(path))
    return np.asarray(beats, float), np.asarray(downs, float)


def analyse_one(rel, dur):
    path = INFL / rel
    beats, downs = beats_of(path)
    if len(downs) < 20:
        return {"rel": rel, "error": "too few downbeats"}
    g = regular_grid(beats, downs, dur)
    if g is None:
        return {"rel": rel, "error": "no stable bar grid"}
    grid, bar_sec, beat_sec, grid_conf = g
    dgap = float(np.median(np.diff(downs)))
    beats_per_bar = dgap / beat_sec if beat_sec > 0 else 0
    bpm = 4 * 60.0 / bar_sec if bar_sec > 0 else 0

    x = decode(path)
    F = frame_features(x)
    if F is None:
        return {"rel": rel, "error": "too short"}
    bf = bar_features(F, grid)
    if bf is None:
        return {"rel": rel, "error": "fewer than 16 bars"}

    nb = len(bf["onsets"])
    S = ssm(bf["logM"])
    nov8 = novelty(S, 8)
    nov4 = novelty(S, 4)
    b8 = pick_peaks(nov8, alpha=0.4, min_gap=4)
    b4 = pick_peaks(nov4, alpha=0.4, min_gap=4)

    def seclens(bnds):
        edges = [0] + list(bnds) + [nb]
        return [int(edges[i + 1] - edges[i]) for i in range(len(edges) - 1)]

    E = energy_curve(bf)
    em = measure_energy(E, bf["lowE_db"], nb)
    mel_bar, mel_frac = melodic_entry(bf, nb)

    # "energy is density, not loudness": within-track correlation of the two, and
    # which of them separates the sections better
    sl = seclens(b8)
    edges = np.cumsum([0] + sl)
    sec_den, sec_rms = [], []
    for i in range(len(sl)):
        a, zz = edges[i], edges[i + 1]
        sec_den.append(float(bf["onsets"][a:zz].mean()))
        sec_rms.append(float(bf["rms_db"][a:zz].mean()))
    sec_den, sec_rms = np.array(sec_den), np.array(sec_rms)
    # the body only — the intro fade-in and outro fade-out dominate any RMS range
    # taken over the whole track and would answer the density-vs-loudness question
    # with an artefact of the DJ furniture
    mid_sec = np.array([0.10 <= (edges[i] + sl[i] / 2) / nb <= 0.90
                        for i in range(len(sl))])
    bden, brms = sec_den[mid_sec], sec_rms[mid_sec]

    def spread(v):
        return float(v.max() - v.min()) if len(v) > 1 else 0.0

    def prof(v, n=100):
        """Resample a per-bar curve onto a fixed 0-100% grid so tracks of
        different lengths can be averaged into one shape."""
        return [round(float(x), 2) for x in
                np.interp(np.linspace(0, 1, n), np.linspace(0, 1, len(v)), v)]

    return {
        "rel": rel,
        "folder": rel.split("/")[0],
        "kind": "club" if rel.split("/")[0] in CLUB else "band",
        "duration_s": round(dur, 1),
        "bpm": round(bpm, 2),
        "bar_sec": round(bar_sec, 4),
        "beats_per_bar": round(beats_per_bar, 2),
        "grid_conf": round(grid_conf, 3),
        "bars_total": int(nb),
        "n_sections": len(sl),
        "section_bars": sl,
        "section_bars_L4": seclens(b4),
        "boundaries": [int(b) + 1 for b in b8],
        "rayleigh": rayleigh(b8),
        "rayleigh_L4": rayleigh(b4),
        "melodic_entry_bar": mel_bar,
        "melodic_entry_frac": mel_frac,
        "density_range": round(spread(sec_den), 2),
        "density_cv": round(float(sec_den.std() / (sec_den.mean() + 1e-9)), 3),
        "rms_range_db": round(spread(sec_rms), 2),
        "den_rms_corr": round(float(np.corrcoef(sec_den, sec_rms)[0, 1]), 3)
        if len(sl) > 2 else None,
        "body_density_range": round(spread(bden), 2),
        "body_density_cv": round(float(bden.std() / (bden.mean() + 1e-9)), 3)
        if bden.size else None,
        "body_rms_range_db": round(spread(brms), 2),
        "sec_density": [round(x, 2) for x in sec_den],
        "sec_rms_db": [round(x, 2) for x in sec_rms],
        # 100-point normalised curves, so 190 tracks of different lengths can be
        # averaged into a single measured shape
        "profile_energy": prof(E),
        "profile_low_db": prof(bf["lowE_db"]),
        "profile_mid_db": prof(bf["midE_db"]),
        "profile_onsets": prof(bf["onsets"]),
        **em,
    }


# ---------------------------------------------------------------------------
# driver
# ---------------------------------------------------------------------------

def run(limit=None, retry=False):
    sample = stratified(candidates())
    done = json.load(open(OUT)) if OUT.exists() else {}
    if retry:
        done = {k: v for k, v in done.items() if "error" not in v}
    todo = [c for c in sample if c["rel"] not in done]
    if limit:
        todo = todo[:limit]
    print(f"{len(sample)} in sample · {len(done)} done · {len(todo)} to go")
    t0 = time.time()
    for i, c in enumerate(todo, 1):
        try:
            r = analyse_one(c["rel"], c["dur"])
        except Exception as e:
            r = {"rel": c["rel"], "error": f"{type(e).__name__}: {e}"}
        done[c["rel"]] = r
        el = time.time() - t0
        tag = r.get("error") or (f"{r['bpm']:6.2f} BPM {r['bars_total']:4d} bars "
                                 f"{r['n_sections']:3d} sec")
        print(f"  [{i}/{len(todo)}] {el/i:5.1f}s/ea  {tag}  {c['rel'][:60]}", flush=True)
        if i % 5 == 0:
            json.dump(done, open(OUT, "w"), indent=1)
    json.dump(done, open(OUT, "w"), indent=1)
    print(f"-> {OUT}  ({time.time()-t0:.0f}s)")


def pct(a, p):
    return float(np.percentile(a, p)) if len(a) else float("nan")



def _summary(g):
    """Everything the aggregate needs, as plain numbers."""
    s = {}
    s["n"] = len(g)
    s["dur"] = np.array([v["duration_s"] for v in g])
    s["bars"] = np.array([v["bars_total"] for v in g])
    s["bpm"] = np.array([v["bpm"] for v in g])
    s["seclen"] = np.array([x for v in g for x in v["section_bars"]])
    s["seclen_L4"] = np.array([x for v in g for x in v["section_bars_L4"]])
    s["nsec"] = np.array([v["n_sections"] for v in g])
    s["lift_b"] = np.array([v["first_lift_bar"] for v in g if v["first_lift_bar"]])
    s["lift_f"] = np.array([v["first_lift_frac"] for v in g
                            if v["first_lift_frac"] is not None])
    s["mel_b"] = np.array([v["melodic_entry_bar"] for v in g if v.get("melodic_entry_bar")])
    s["mel_f"] = np.array([v["melodic_entry_frac"] for v in g
                           if v.get("melodic_entry_frac") is not None])
    bd = [v["breakdown"] for v in g if v.get("breakdown")]
    s["bd_n"] = len(bd)
    s["bd_bars"] = np.array([b["bars"] for b in bd])
    s["bd_frac"] = np.array([b["at_frac"] for b in bd])
    s["intro"] = np.array([v["intro_bars"] for v in g if v["intro_bars"] is not None])
    s["outro"] = np.array([v["outro_bars"] for v in g if v["outro_bars"] is not None])
    s["levels"] = np.array([v["energy_levels"] for v in g])
    s["dcv"] = np.array([v["density_cv"] for v in g])
    s["rrange"] = np.array([v["rms_range_db"] for v in g])
    s["drange"] = np.array([v["density_range"] for v in g])
    s["corr"] = np.array([v["den_rms_corr"] for v in g if v.get("den_rms_corr") is not None])
    return s


def _ladder(g, key="rayleigh"):
    """Median Rayleigh Z per period, and the share of tracks where Z > 3."""
    out = {}
    for P in PERIODS:
        zs = np.array([v[key][str(P)] for v in g if v.get(key) and str(P) in v[key]])
        if zs.size:
            out[P] = (float(np.median(zs)), float((zs > 3).mean()), int(zs.size))
    return out


def _hist(sl, label="section length"):
    bins = [(1, 5, "1-4"), (5, 7, "5-6"), (7, 9, "7-8"), (9, 13, "9-12"),
            (13, 15, "13-14"), (15, 17, "15-16"), (17, 25, "17-24"),
            (25, 33, "25-32"), (33, 49, "33-48"), (49, 9999, ">48")]
    print(f"   {label} histogram (n={len(sl)} sections):")
    for lo, hi, lab in bins:
        n = int(((sl >= lo) & (sl < hi)).sum())
        print(f"      {lab:>6}  {'#' * int(46 * n / max(len(sl), 1))} {n:4d}"
              f" ({100 * n / max(len(sl), 1):4.1f}%)")


def report():
    d = json.load(open(OUT))
    good = [v for v in d.values() if "error" not in v]
    bad = [v for v in d.values() if "error" in v]
    groups = [("CLUB — Lee Burridge / ADID roster / Solomun",
               [v for v in good if v["kind"] == "club"]),
              ("BAND — Tame Impala / Dope Lemon / RUFUS DU SOL",
               [v for v in good if v["kind"] == "band"])]
    club = groups[0][1]

    print(f"\n{'=' * 76}\n  ARRANGEMENT STRUCTURE MEASURED — {len(good)} influence tracks"
          f"  ({len(bad)} failed)\n{'=' * 76}")
    fold = {}
    for v in good:
        fold.setdefault(v["folder"], []).append(v)
    for f in sorted(fold):
        b = np.array([x["bars_total"] for x in fold[f]])
        print(f"   {f:<16} n={len(fold[f]):3d}   median {np.median(b):5.0f} bars"
              f"   {np.median([x['duration_s'] for x in fold[f]]) / 60:5.2f} min"
              f"   {np.median([x['bpm'] for x in fold[f]]):5.1f} BPM")

    for name, g in groups:
        if len(g) < 3:
            continue
        s = _summary(g)
        print(f"\n{'-' * 76}\n  {name}   n={s['n']}\n{'-' * 76}")
        print(f"   duration      p10 {pct(s['dur'],10)/60:.2f}  p25 {pct(s['dur'],25)/60:.2f}"
              f"  MEDIAN {np.median(s['dur'])/60:.2f}  p75 {pct(s['dur'],75)/60:.2f}"
              f"  p90 {pct(s['dur'],90)/60:.2f}  minutes")
        print(f"   LENGTH IN BARS  p10 {pct(s['bars'],10):.0f}  p25 {pct(s['bars'],25):.0f}"
              f"  MEDIAN {np.median(s['bars']):.0f}  p75 {pct(s['bars'],75):.0f}"
              f"  p90 {pct(s['bars'],90):.0f}")
        print(f"                  240 bars sits at the "
              f"{100*(s['bars'] < 240).mean():.0f}th percentile; "
              f"{100*((s['bars']>=224)&(s['bars']<=256)).mean():.0f}% are within +/-16 of it")
        print(f"   BPM           median {np.median(s['bpm']):.1f} "
              f"[p10 {pct(s['bpm'],10):.0f} - p90 {pct(s['bpm'],90):.0f}]")

        print(f"\n   sections/track median {np.median(s['nsec']):.0f}"
              f"   section length median {np.median(s['seclen']):.0f} bars"
              f"   [p25 {pct(s['seclen'],25):.0f}  p75 {pct(s['seclen'],75):.0f}]")
        _hist(s["seclen"])
        for m in (4, 8, 16):
            print(f"      exact multiples of {m:2d}: "
                  f"{100*(s['seclen'] % m == 0).mean():4.1f}%   "
                  f"within +/-1 bar: {100*(np.minimum(s['seclen'] % m, m - s['seclen'] % m) <= 1).mean():4.1f}%")

        print(f"\n   PERIODICITY LADDER — Rayleigh Z of boundary positions (Z>3 ~ p<.05)")
        for key, lab in (("rayleigh", "L=8 kernel"), ("rayleigh_L4", "L=4 kernel")):
            lad = _ladder(g, key)
            if lad:
                print(f"      {lab}:  " + "   ".join(
                    f"P{P}: Z={z:4.1f} ({100*f:2.0f}%)" for P, (z, f, _) in lad.items()))

        print(f"\n   first energy lift   bar {np.median(s['lift_b']):.0f} median,"
              f" at {100*np.median(s['lift_f']):.0f}% of track"
              f"  [p25 {100*pct(s['lift_f'],25):.0f}% p75 {100*pct(s['lift_f'],75):.0f}%]")
        if s["mel_b"].size:
            print(f"   midrange fills at   bar {np.median(s['mel_b']):.0f} median,"
                  f" at {100*np.median(s['mel_f']):.0f}% of track"
                  f"  [p25 {100*pct(s['mel_f'],25):.0f}% p75 {100*pct(s['mel_f'],75):.0f}%]"
                  f"   n={s['mel_b'].size}")
            print(f"      before bar 49: {100*(s['mel_b'] < 49).mean():.0f}% of tracks")
        print(f"   BREAKDOWN found in {s['bd_n']}/{s['n']} "
              f"({100*s['bd_n']/max(s['n'],1):.0f}%)")
        if s["bd_n"]:
            bl = s["bd_bars"]
            print(f"      length in bars   p25 {pct(bl,25):.0f}  MEDIAN {np.median(bl):.0f}"
                  f"  p75 {pct(bl,75):.0f}  p90 {pct(bl,90):.0f}  max {bl.max():.0f}")
            print(f"      <=8 bars {100*(bl<=8).mean():.0f}%   "
                  f"8-16 bars {100*((bl>=8)&(bl<=16)).mean():.0f}%   "
                  f">16 bars {100*(bl>16).mean():.0f}%   "
                  f">32 bars {100*(bl>32).mean():.0f}%")
            print(f"      position         median {100*np.median(s['bd_frac']):.0f}% "
                  f"through  [p25 {100*pct(s['bd_frac'],25):.0f}% "
                  f"p75 {100*pct(s['bd_frac'],75):.0f}%]")
        print(f"   intro  median {np.median(s['intro']):.0f} bars "
              f"[p25 {pct(s['intro'],25):.0f} p75 {pct(s['intro'],75):.0f}]"
              f"      outro  median {np.median(s['outro']):.0f} bars "
              f"[p25 {pct(s['outro'],25):.0f} p75 {pct(s['outro'],75):.0f}]")
        print(f"      intro >= 24 bars: {100*(s['intro']>=24).mean():.0f}% of tracks; "
              f"outro >= 24 bars: {100*(s['outro']>=24).mean():.0f}%")
        print(f"   energy levels  median {np.median(s['levels']):.0f} "
              f"[p10 {pct(s['levels'],10):.0f} - p90 {pct(s['levels'],90):.0f}]")
        print(f"\n   ENERGY = DENSITY OR LOUDNESS?  across sections, per track:")
        print(f"      onsets/bar spread  median {np.median(s['drange']):.1f} "
              f"(= {100*np.median(s['dcv']):.0f}% CV)")
        print(f"      RMS spread         median {np.median(s['rrange']):.1f} dB")
        print(f"      corr(density, RMS) median {np.median(s['corr']):+.2f}  "
              f"— near zero means they move independently")

    print(f"\n{'=' * 76}\n  SCALED TO 96 BARS (the make_track.py default)\n{'=' * 76}")
    if club:
        s = _summary(club)
        nb, med = 96, np.median(s["bars"])
        k = nb / med
        print(f"   median club track = {med:.0f} bars.  96 bars = {100*k:.0f}% of that.")
        rows = [("intro", np.median(s["intro"])),
                ("first energy lift", np.median(s["lift_f"]) * med),
                ("midrange fills", np.median(s["mel_f"]) * med if s["mel_f"].size else None),
                ("breakdown starts", np.median(s["bd_frac"]) * med if s["bd_n"] else None),
                ("breakdown length", np.median(s["bd_bars"]) if s["bd_n"] else None),
                ("outro", np.median(s["outro"]))]
        print(f"   {'':<20}{'in a median track':>20}{'proportional':>16}{'nearest 8':>12}")
        for lab, val in rows:
            if val is None:
                continue
            prop = val * k
            print(f"   {lab:<20}{val:>17.0f} bars{prop:>13.0f} bars"
                  f"{int(round(prop / 8)) * 8:>9d} bars")
        print(f"   energy levels        {np.median(s['levels']):>17.0f}"
              f"{'(unchanged)':>29}")
        print(f"   sections             {np.median(s['nsec']):>17.0f}"
              f"{np.median(s['nsec'])*k:>13.0f}")
    if club:
        print(f"\n{'=' * 76}\n  THE CLAIM TESTS — club tracks only, n={len(club)}\n{'=' * 76}")
        boundary_grid(club)
        print()
        length_invariance(club)
        print()
        breakdown_depths(club)
        print()
        rising_points(club)
        print()
        where_energy_is_added(club)

    print(f"\n{'=' * 76}\n  THE MEASURED SHAPE OF A CLUB TRACK\n{'=' * 76}")
    if club:
        shape(club, "profile_energy", "ENERGY (density + level + bands + low end)")
        print()
        shape(club, "profile_low_db", "SUB-150 Hz (kick/bass presence)")
        print()
        shape(club, "profile_mid_db", "300-3000 Hz (where melody lives)")
    extended_vs_edit(good)
    if bad:
        print(f"\n  {len(bad)} failed:")
        for v in bad[:12]:
            print(f"    {v['error'][:56]}  {v['rel'][:56]}")


def shape(g, key="profile_energy", label="ENERGY", width=64):
    """
    The measured average shape of a track, 0-100% of its length.

    This is the thing one bar map cannot give you: 100+ arrangements laid on top
    of each other. Position is a percentage, so a 3:30 edit and an 8:40 extended
    mix contribute the same shape.
    """
    P = np.array([v[key] for v in g if key in v])
    if P.size == 0:
        return
    med = np.median(P, axis=0)
    lo, hi = np.percentile(P, 25, axis=0), np.percentile(P, 75, axis=0)
    a, b = med.min(), med.max()
    print(f"   MEDIAN {label} PROFILE across {len(P)} tracks "
          f"(| = p25-p75 band, # = median)")
    for i in range(0, 100, 2):
        n = int(width * (med[i] - a) / max(b - a, 1e-9))
        n1 = int(width * (lo[i] - a) / max(b - a, 1e-9))
        n2 = int(width * (hi[i] - a) / max(b - a, 1e-9))
        bar = "".join("#" if j < n else ("|" if n1 <= j < n2 else " ")
                      for j in range(width))
        print(f"      {i:3d}%  {bar}")


def extended_vs_edit(good):
    """
    A natural experiment sitting in the Lee Burridge folder: the same record in
    both a club length and a radio length. It says which parts are the DJ
    furniture and which parts are the record.
    """
    by = {v["rel"]: v for v in good}
    pairs = []
    for rel, v in by.items():
        for tag in (" (Extended Mix)", " (Extended AM Mix)", " (Extended V-Mix)"):
            if tag in rel:
                short = rel.replace(tag, "")
                if short in by:
                    pairs.append((by[short], v))
    if not pairs:
        return
    print(f"\n{'-' * 76}\n  EXTENDED MIX vs EDIT — the same record, both lengths "
          f"(n={len(pairs)} pairs)\n{'-' * 76}")
    print(f"   {'':<40}{'edit':>10}{'extended':>11}{'delta':>9}")
    for lab, f in (("bars", lambda v: v["bars_total"]),
                   ("intro bars", lambda v: v["intro_bars"]),
                   ("outro bars", lambda v: v["outro_bars"]),
                   ("sections", lambda v: v["n_sections"]),
                   ("median section bars",
                    lambda v: float(np.median(v["section_bars"]))),
                   ("breakdown bars",
                    lambda v: v["breakdown"]["bars"] if v.get("breakdown") else None),
                   ("energy levels", lambda v: v["energy_levels"])):
        e = [f(a) for a, b in pairs if f(a) is not None and f(b) is not None]
        x = [f(b) for a, b in pairs if f(a) is not None and f(b) is not None]
        if e:
            print(f"   {lab:<40}{np.median(e):>10.0f}{np.median(x):>11.0f}"
                  f"{np.median(x) - np.median(e):>+9.0f}")
    print(f"   -> the extended mixes are longer by "
          f"{np.median([b['bars_total'] - a['bars_total'] for a, b in pairs]):.0f} bars "
          f"median, and where that length goes is the finding")


def breakdown_depths(g):
    """
    The single most misleading number in the first pass was "breakdown = 17 bars".

    It is not wrong, it is answering a different question: the detector finds the
    span where the low end sits >=6 dB below its full level, which is the
    BREAKDOWN PLUS THE REBUILD. `PLAYBOOK` §6 splits those (113-120 kick out,
    121-128 rebuild) and only calls the first half the breakdown. So measure the
    depth ladder and let the two be compared like for like.
    """
    print("   BREAKDOWN, BY HOW FAR THE LOW END ACTUALLY DROPS")
    for drop, lab in ((6, ">=6 dB down   (breakdown + rebuild)"),
                      (12, ">=12 dB down"),
                      (20, ">=20 dB down  (kick effectively OUT)")):
        ln, pos = [], []
        for v in g:
            L = np.array(v["profile_low_db"])
            m = L < np.percentile(L, 75) - drop
            m[:12] = False
            m[92:] = False
            runs = sorted(runs_below(m), key=lambda r: -r[1])
            if runs and runs[0][1] > 0:
                ln.append(runs[0][1] * v["bars_total"] / 100.0)
                pos.append(runs[0][0] / 100.0)
        ln, pos = np.array(ln), np.array(pos)
        if not ln.size:
            continue
        print(f"      {lab:36s} in {100*len(ln)/len(g):3.0f}% of tracks | "
              f"p25 {pct(ln,25):3.0f}  MED {np.median(ln):3.0f}  p75 {pct(ln,75):3.0f}"
              f"  p90 {pct(ln,90):3.0f} bars | <=8 {100*(ln<=8).mean():3.0f}%"
              f"  8-16 {100*((ln>=8)&(ln<=16)).mean():3.0f}%  >32 {100*(ln>32).mean():3.0f}%"
              f" | starts {100*np.median(pos):3.0f}%")


def boundary_grid(g):
    """
    Pooled boundary positions modulo P. This is the load-bearing evidence for the
    section-unit question, because pooling ~1,500 boundaries beats the per-track
    Rayleigh noise. Boundaries are 1-based bar numbers, so bins 0 and 1 together
    are "on the grid" (a boundary detected one bar early is still on it).
    """
    b = np.array([x for v in g for x in v.get("boundaries", [])])
    if b.size < 100:
        return
    print(f"   POOLED BOUNDARY POSITIONS mod P   (n={b.size} boundaries)")
    for P in (4, 8, 16, 32):
        h = np.bincount(b % P, minlength=P)
        on = h[0] + h[1]
        chance = 2 / P
        print(f"      mod {P:2d}:  on-grid (bins 0-1) {100*on/b.size:4.1f}% "
              f"vs {100*chance:4.1f}% by chance = {on/b.size/chance:.2f}x", end="")
        if P >= 16:
            half = h[P // 2] + h[P // 2 + 1]
            print(f"   |   grid : half-grid = {on/max(half,1):.2f} : 1")
        else:
            print()


def length_invariance(g):
    """Does a short record use SHORTER sections or FEWER of them? It matters:
    the 96-bar arrangement was built by halving every section."""
    print("   SECTION LENGTH vs TRACK LENGTH")
    for lo, hi, lab in ((0, 161, "<=160 bars (edit length)"),
                        (161, 240, "161-239 bars"),
                        (240, 10000, ">=240 bars (club length)")):
        s = [v for v in g if lo <= v["bars_total"] < hi]
        if len(s) < 5:
            continue
        bt = np.array([v["bars_total"] for v in s])
        ns = np.array([v["n_sections"] for v in s])
        ms = np.array([np.median(v["section_bars"]) for v in s])
        print(f"      {lab:26s} n={len(s):3d}  track {np.median(bt):5.0f} bars"
              f"   sections {np.median(ns):4.0f}"
              f"   median section {np.median(ms):5.1f} bars"
              f"   bars/section {np.median(bt/ns):5.1f}")


def where_energy_is_added(g):
    """'Add energy at the top, not by getting louder' — measured."""
    lo, mid, ons = [], [], []
    for v in g:
        E = np.array(v["profile_energy"])
        top = E >= np.percentile(E, 85)
        ref = (E >= np.percentile(E, 40)) & (E <= np.percentile(E, 60))
        if top.sum() < 3 or ref.sum() < 3:
            continue
        for arr, key in ((lo, "profile_low_db"), (mid, "profile_mid_db"),
                         (ons, "profile_onsets")):
            a = np.array(v[key])
            arr.append(a[top].mean() - a[ref].mean())
    if not lo:
        return
    base = np.median([np.median(v["profile_onsets"]) for v in g])
    print(f"   PEAK (top 15% of bars) vs MIDDLE (40th-60th pct), n={len(lo)}")
    print(f"      sub-150 Hz   {np.median(lo):+5.2f} dB")
    print(f"      300-3000 Hz  {np.median(mid):+5.2f} dB")
    print(f"      onsets/bar   {np.median(ons):+5.2f}  on a base of {base:.1f} "
          f"= {100*np.median(ons)/base:+.0f}%")
    print("      -> if the level barely moves and the density does, "
          "'energy is density, not loudness' holds")


def rising_points(g):
    """When does the track reach half / three-quarters / all of its own energy?
    `first_lift` alone is a weak statistic — plenty of these records open with the
    groove already running, so its midpoint crossing lands at bar 4."""
    med_bars = np.median([v["bars_total"] for v in g])
    print(f"   WHERE THE TRACK ARRIVES   (bar numbers are for the median "
          f"{med_bars:.0f}-bar club track)")
    for key, lab in (("profile_energy", "energy"), ("profile_mid_db", "midrange")):
        row = []
        for q in (50, 75, 90):
            f = []
            for v in g:
                a = np.array(v[key])
                i = np.nonzero(a >= np.percentile(a, q))[0]
                if i.size:
                    f.append(i[0] / 100.0)
            f = np.array(f)
            row.append((q, np.median(f)))
        print(f"      {lab:9s} " + "   ".join(
            f"p{q}: {100*m:3.0f}% = bar {m*med_bars:3.0f}" for q, m in row))


def selftest():
    """
    Prove the periodicity ladder can find a grid when one is there, and does not
    invent one when it is not. Without this the whole section is unfalsifiable.
    """
    rng = np.random.default_rng(0)
    print("Rayleigh ladder on synthetic boundary sets (Z>3 ~ p<.05):")
    cases = {
        "every 8 bars   ": list(range(8, 240, 8)),
        "every 16 bars  ": list(range(16, 240, 16)),
        "every 32 bars  ": list(range(32, 240, 32)),
        "16s, +/-1 jitter": [b + int(rng.integers(-1, 2)) for b in range(16, 240, 16)],
        "mixed 16/32    ": [16, 32, 64, 80, 112, 144, 160, 192, 224],
        "random         ": sorted(rng.choice(np.arange(8, 240), 14, replace=False).tolist()),
    }
    for lab, b in cases.items():
        r = rayleigh(b)
        print(f"  {lab}  " + "  ".join(f"P{P}={r[str(P)]:6.1f}" for P in PERIODS))
    print("\nExpect: 8-bar grid HIGH at 8, ~0 at 16 · 16-bar grid high at 8 AND 16,"
          "\n~0 at 32 · 32-bar grid high at 8, 16 AND 32 · random low everywhere.")


if __name__ == "__main__":
    if "--plan" in sys.argv:
        s = stratified(candidates())
        from collections import Counter
        print(Counter(c["folder"] for c in s), len(s))
        for c in s:
            print(f"  {c['dur']:6.1f}s  {c['rel']}")
    elif "--selftest" in sys.argv:
        selftest()
    elif "--report" in sys.argv:
        report()
    elif "--run" in sys.argv:
        lim = None
        if "--limit" in sys.argv:
            lim = int(sys.argv[sys.argv.index("--limit") + 1])
        run(lim, retry="--retry" in sys.argv)
    else:
        print(__doc__)
