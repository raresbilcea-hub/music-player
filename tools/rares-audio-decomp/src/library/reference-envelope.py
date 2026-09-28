#!/usr/bin/env python3
"""
reference-envelope.py — measure OUR OWN influence library and build the target
envelope the mix is scored against.

WHY. The mixing research ended on this: no public dataset has measured LUFS or
spectra for Lee Burridge, All Day I Dream, RÜFÜS DU SOL, Solomun or Lane 8.
AcousticBrainz is retired, dr.loudness-war.info is down. Every organic-house
number in that brief is an artist quote or an interpolation. But we have 550+
tracks by exactly those artists sitting on disk, so we can stop citing rules of
thumb and measure the actual thing.

Stores a per-band MEDIAN plus 10th/90th PERCENTILE envelope, not a mean curve.
The envelope IS the tolerance -- derived rather than assumed.

CAVEAT, stated in the output: these are ~130 kbps Opus. LUFS, crest factor,
correlation and spectral tilt below ~15 kHz survive that fine. The top octave
does not -- the codec discarded it. Do not read the 11-16 kHz band as truth.

Usage:  python3 reference-envelope.py [--n 60] [--dir influences]
"""
import argparse, json, subprocess, tempfile
from collections import defaultdict
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import lfilter

SR = 44100
# ITU-R BS.1770 K-weighting: high-shelf then high-pass, coefficients for 48 kHz
# rescaled to 44.1 kHz via the standard bilinear re-derivation.
def k_weight(x, sr=SR):
    f0, G, Q = 1681.97, 3.99984, 0.7071752
    K = np.tan(np.pi * f0 / sr); Vh = 10 ** (G / 20); Vb = Vh ** 0.499666
    a0 = 1 + K / Q + K * K
    b = np.array([(Vh + Vb * K / Q + K * K), 2 * (K * K - Vh), (Vh - Vb * K / Q + K * K)]) / a0
    a = np.array([1.0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0])
    y = lfilter(b, a, x)
    f0, Q = 38.13547087, 0.5003270
    K = np.tan(np.pi * f0 / sr)
    a0 = 1 + K / Q + K * K
    b2 = np.array([1.0, -2.0, 1.0])
    a2 = np.array([1.0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0])
    return lfilter(b2, a2, y)


def lufs_integrated(L, R, sr=SR):
    """BS.1770 gated loudness. 400 ms blocks, 75% overlap, -70 abs / -10 rel gate."""
    z = k_weight(L, sr) ** 2 + k_weight(R, sr) ** 2
    n = int(0.4 * sr); hop = n // 4
    blocks = np.array([z[i:i + n].mean() for i in range(0, len(z) - n, hop)])
    if not len(blocks):
        return float("nan")
    l = -0.691 + 10 * np.log10(np.maximum(blocks, 1e-12))
    keep = l > -70
    if not keep.any():
        return float("nan")
    rel = -0.691 + 10 * np.log10(blocks[keep].mean()) - 10
    keep &= l > rel
    if not keep.any():
        return float("nan")
    return float(-0.691 + 10 * np.log10(blocks[keep].mean()))


BANDS = [(31, 63), (63, 125), (125, 250), (250, 500), (500, 1000),
         (1000, 2000), (2000, 4000), (4000, 8000), (8000, 16000)]


def measure(path, seconds=90, skip=60):
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as t:
        tmp = t.name
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", str(skip), "-t", str(seconds),
                    "-i", str(path), "-ac", "2", "-ar", str(SR), tmp],
                   check=True, capture_output=True)
    x, _ = sf.read(tmp, always_2d=True)
    Path(tmp).unlink(missing_ok=True)
    if len(x) < SR * 10:
        return None
    L, R = x[:, 0], x[:, 1]
    m = (L + R) / 2
    s = (L - R) / 2

    n = 1 << 15
    win = np.hanning(n)
    acc = np.zeros(n // 2 + 1); cnt = 0
    for i in range(0, len(m) - n, n // 2):
        acc += np.abs(np.fft.rfft(m[i:i + n] * win)) ** 2; cnt += 1
    acc /= max(cnt, 1)
    f = np.fft.rfftfreq(n, 1 / SR)
    tot = acc.sum() or 1
    bandpct = [100 * acc[(f >= lo) & (f < hi)].sum() / tot for lo, hi in BANDS]

    # spectral tilt over the percussion-invariant window, 89 Hz - 4.5 kHz
    sel = (f >= 89) & (f <= 4500) & (acc > 0)
    tilt = float(np.polyfit(np.log2(f[sel]), 10 * np.log10(acc[sel]), 1)[0])

    pk = float(np.max(np.abs(m))); rms = float(np.sqrt(np.mean(m ** 2)))
    hp = m - lfilter(*_hp200(), m) * 0  # placeholder, side fraction computed below
    # side fraction above 200 Hz
    b, a = _hp200()
    mh, sh = lfilter(b, a, m), lfilter(b, a, s)
    side_frac = float(np.sum(sh ** 2) / max(np.sum(mh ** 2) + np.sum(sh ** 2), 1e-12))

    return {
        "lufs": lufs_integrated(L, R),
        "crest_db": 20 * np.log10(pk / rms) if rms else float("nan"),
        "tilt_db_oct": tilt,
        "corr": float(np.corrcoef(L, R)[0, 1]) if np.std(R) > 0 else 1.0,
        "side_frac_gt200": side_frac,
        "bands": bandpct,
    }


def _hp200(sr=SR, f0=200.0, q=0.707):
    w = 2 * np.pi * f0 / sr; al = np.sin(w) / (2 * q); c = np.cos(w)
    b = np.array([(1 + c) / 2, -(1 + c), (1 + c) / 2]) / (1 + al)
    a = np.array([1.0, -2 * c / (1 + al), (1 - al) / (1 + al)])
    return b, a


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="influences")
    ap.add_argument("--n", type=int, default=60)
    ap.add_argument("--out", default="data/reference-envelope.json")
    a = ap.parse_args()
    here = Path(__file__).parent
    files = sorted((here / a.dir).rglob("*.opus"))
    if not files:
        print(f"no .opus under {here / a.dir}"); return
    files = files[::max(len(files) // a.n, 1)][:a.n]

    rows = []
    for i, fp in enumerate(files, 1):
        try:
            r = measure(fp)
            if r and not np.isnan(r["lufs"]):
                # keep the RELATIVE PATH, not just the basename. Without it the
                # envelope cannot be split by collection, and the influences
                # folder is not one lane: 45 of its 504 tracks are Tame Impala
                # and Dope Lemon, i.e. psych-rock, not house. Averaging those
                # into a house mixing target is a category error.
                r["path"] = str(fp.relative_to(here / a.dir))
                r["collection"] = r["path"].split("/")[0]
                r["file"] = fp.name; rows.append(r)
                print(f"  [{i}/{len(files)}] {r['lufs']:6.1f} LUFS  crest {r['crest_db']:4.1f} dB  "
                      f"tilt {r['tilt_db_oct']:5.2f}  corr {r['corr']:+.2f}  side {100*r['side_frac_gt200']:4.1f}%  {fp.name[:34]}")
        except Exception as e:
            print(f"  [{i}/{len(files)}] skipped {fp.name[:34]}: {type(e).__name__}")
    if not rows:
        print("nothing measured"); return

    def env(key, rs=None):
        v = np.array([r[key] for r in (rs or rows)])
        return dict(p10=float(np.percentile(v, 10)), median=float(np.median(v)),
                    p90=float(np.percentile(v, 90)))

    def envelope_of(rs):
        b = np.array([r["bands"] for r in rs])
        return {
            "n": len(rs),
            "lufs": env("lufs", rs), "crest_db": env("crest_db", rs),
            "tilt_db_oct": env("tilt_db_oct", rs), "corr": env("corr", rs),
            "side_frac_gt200": env("side_frac_gt200", rs),
            "bands_pct": {"p10": np.percentile(b, 10, axis=0).tolist(),
                          "median": np.median(b, axis=0).tolist(),
                          "p90": np.percentile(b, 90, axis=0).tolist()},
        }

    bands = np.array([r["bands"] for r in rows])
    out = {
        "n": len(rows),
        "source": a.dir,
        "caveat": "~130 kbps Opus. LUFS/crest/corr/tilt below ~15 kHz are sound; the top octave is codec-limited.",
        "lufs": env("lufs"), "crest_db": env("crest_db"), "tilt_db_oct": env("tilt_db_oct"),
        "corr": env("corr"), "side_frac_gt200": env("side_frac_gt200"),
        "bands_hz": [f"{lo}-{hi}" for lo, hi in BANDS],
        "bands_pct": {"p10": np.percentile(bands, 10, axis=0).tolist(),
                      "median": np.median(bands, axis=0).tolist(),
                      "p90": np.percentile(bands, 90, axis=0).tolist()},
    }

    # per-collection envelopes. The house lane and the guitar lane are different
    # records and should not be scored against one number.
    cols = defaultdict(list)
    for r in rows:
        cols[r.get("collection", "?")].append(r)
    out["by_collection"] = {c: envelope_of(rs) for c, rs in cols.items() if len(rs) >= 8}
    HOUSE = ("ADID roster", "Lee Burridge", "Solomun", "RUFUS DU SOL")
    house = [r for r in rows if r.get("collection") in HOUSE]
    if len(house) >= 8:
        out["house_lane"] = envelope_of(house)
        out["house_lane"]["collections"] = list(HOUSE)
    (here / a.out).write_text(json.dumps(out, indent=1))

    print("\n" + "=" * 72)
    print(f"REFERENCE ENVELOPE from {len(rows)} tracks in {a.dir}")
    print("=" * 72)
    for k, lbl, fmt in (("lufs", "integrated LUFS", "6.1f"), ("crest_db", "crest factor dB", "6.1f"),
                        ("tilt_db_oct", "tilt dB/oct 89-4500", "6.2f"), ("corr", "L/R correlation", "6.2f"),
                        ("side_frac_gt200", "side fraction >200Hz", "6.3f")):
        e = out[k]
        print(f"  {lbl:24} p10 {e['p10']:{fmt}}   median {e['median']:{fmt}}   p90 {e['p90']:{fmt}}")
    print("\n  octave band % of energy      p10    median    p90")
    for i, (lo, hi) in enumerate(BANDS):
        print(f"    {lo:>5}-{hi:<6} Hz          {out['bands_pct']['p10'][i]:5.2f}   "
              f"{out['bands_pct']['median'][i]:6.2f}   {out['bands_pct']['p90'][i]:5.2f}")

    if out.get("by_collection"):
        print("\n" + "=" * 72)
        print("  BY COLLECTION — medians. The folder is not one lane.")
        print("=" * 72)
        print(f"  {'collection':16} {'n':>4} {'LUFS':>7} {'crest':>7} {'tilt':>7} "
              f"{'corr':>6} {'side':>6}   {'31-63':>6} {'63-125':>7}")
        for c, e in sorted(out["by_collection"].items(), key=lambda x: -x[1]["n"]):
            print(f"  {c:16} {e['n']:>4} {e['lufs']['median']:7.1f} "
                  f"{e['crest_db']['median']:7.1f} {e['tilt_db_oct']['median']:7.2f} "
                  f"{e['corr']['median']:6.2f} {e['side_frac_gt200']['median']:6.3f}   "
                  f"{e['bands_pct']['median'][0]:6.1f} {e['bands_pct']['median'][1]:7.1f}")
        if out.get("house_lane"):
            e = out["house_lane"]
            print(f"\n  {'HOUSE LANE':16} {e['n']:>4} {e['lufs']['median']:7.1f} "
                  f"{e['crest_db']['median']:7.1f} {e['tilt_db_oct']['median']:7.2f} "
                  f"{e['corr']['median']:6.2f} {e['side_frac_gt200']['median']:6.3f}   "
                  f"{e['bands_pct']['median'][0]:6.1f} {e['bands_pct']['median'][1]:7.1f}")
            print("  ^ score house renders against THIS, not the all-influences row.")
    print(f"\nwrote {here / a.out}")


if __name__ == "__main__":
    main()
