#!/usr/bin/env python3
"""
texture.py — HOW BROADBAND IS THE MATERIAL? The fork's central argument, made
reproducible.

WHY THIS EXISTS. The whole case for the tribal fork rests on one number:
spectral flatness, ours vs the references. That number has been quoted in three
places and **never existed as a script** — `STATUS.md` and `HANDOFF.md` say
0.0025 against 0.044-0.065, and a comment in `pipeline/synths.py` says 0.0017
against 0.039-0.060. Neither is reproducible and they do not agree. A load-
bearing measurement that cannot be re-run is an anecdote with a decimal point.

🔴 THE CONFOUND THIS SCRIPT EXISTS TO AVOID. An earlier version of this
comparison was wrong because the two sides were decoded at different sample
rates — Opus at 48 kHz against our 44.1 kHz WAV. Spectral flatness is computed
over the whole spectrum, so a different Nyquist changes the answer without
anything being musically different. **Everything here goes through ONE ffmpeg
decode path: mono, 44100 Hz, float.** Do not add a fast path that skips it.

WHAT IT MEASURES, per track:

  FLATNESS     geometric mean / arithmetic mean of the power spectrum, per
               window, median across the track. 0 = pure tone, 1 = white noise.
               This is the "is the material broadband" number. A record of
               clean synth tones and cleanly sampled single notes sits low; a
               record full of shakers, brushed skins, wind and room sits high.

  HF_NOISE     fraction of total energy above 6 kHz. Hand percussion, shakers
               and air live here; sampled pitched instruments mostly do not.

  ZCR          zero-crossing rate, median per window. A cheap, independent
               check on the same question — it moves with noisiness but is
               computed in the time domain, so it does not share flatness's
               failure modes. If the two disagree, trust neither and look.

  CREST        peak-to-RMS in dB, for continuity with reference-envelope.py.

⚠️ WHAT THIS CANNOT SEE. It measures a finished master. It cannot tell you
WHICH element is broadband, and a bright cymbal-heavy mix can score like a
shaker-heavy one. It answers "is there broadband material in this record at
all", which is the question the fork turns on, and not "what is making it".

⚠️ Opus at ~130 kbps discards the top octave. That suppresses HF_NOISE on the
references and therefore makes any deficit we measure on OUR side a
CONSERVATIVE estimate — the real gap is at least this big, not at most.

Usage:
    python3 texture.py --dir influences/tribal --n 60
    python3 texture.py --dir influences/tribal --n 60 --ours ../tracks/current/Master.wav
    python3 texture.py --dir influences/tribal --dir "influences/Lee Burridge" --n 40
"""
import argparse
import json
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 44100          # ONE decode rate for every input. See the confound note above.
N = 4096
HOP = 2048
HERE = Path(__file__).parent


def decode(path, seconds=120, skip=45):
    """The single decode path. Mono, 44.1 kHz, from `skip` seconds in.

    `skip` matters: intros are sparse and would flatter a texture measurement on
    a record that is busy later. 45 s in is inside the body of a house record.
    """
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as t:
        tmp = t.name
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", str(skip), "-t", str(seconds),
                    "-i", str(path), "-ac", "1", "-ar", str(SR), tmp],
                   check=True, capture_output=True)
    x, sr = sf.read(tmp)
    Path(tmp).unlink(missing_ok=True)
    assert sr == SR, f"decode path returned {sr}, not {SR}"
    return x.astype(np.float64)


def measure(path):
    x = decode(path)
    if len(x) < SR * 10:
        return None
    win = np.hanning(N)
    flat, zcr = [], []
    hf_num = hf_den = 0.0
    f = np.fft.rfftfreq(N, 1 / SR)
    hf = f >= 6000
    for i in range(0, len(x) - N, HOP):
        seg = x[i:i + N]
        if not np.any(seg):
            continue
        p = np.abs(np.fft.rfft(seg * win)) ** 2
        p = np.maximum(p, 1e-20)
        # geometric mean via logs — the direct product underflows instantly.
        flat.append(float(np.exp(np.mean(np.log(p))) / np.mean(p)))
        zcr.append(float(np.mean(np.abs(np.diff(np.sign(seg))) > 0)))
        hf_num += float(p[hf].sum()); hf_den += float(p.sum())
    if not flat:
        return None
    rms = float(np.sqrt(np.mean(x ** 2)))
    peak = float(np.max(np.abs(x)))
    return {
        "flatness": float(np.median(flat)),
        "flatness_p90": float(np.percentile(flat, 90)),
        "hf_noise": hf_num / max(hf_den, 1e-20),
        "zcr": float(np.median(zcr)),
        "crest_db": 20 * np.log10(peak / rms) if rms > 0 else float("nan"),
    }


def summarise(rows, label):
    print(f"\n{'=' * 74}\n{label}  —  n={len(rows)}\n{'=' * 74}")
    out = {"n": len(rows)}
    for k, fmt in [("flatness", ".4f"), ("flatness_p90", ".4f"),
                   ("hf_noise", ".4f"), ("zcr", ".4f"), ("crest_db", ".1f")]:
        v = np.array([r[k] for r in rows], dtype=float)
        v = v[~np.isnan(v)]
        if not len(v):
            continue
        out[k] = {"p10": float(np.percentile(v, 10)),
                  "median": float(np.median(v)),
                  "p90": float(np.percentile(v, 90))}
        print(f"  {k:<14} median {np.median(v):{fmt}}"
              f"   p10 {np.percentile(v, 10):{fmt}}   p90 {np.percentile(v, 90):{fmt}}")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", action="append", required=True,
                    help="folder of audio to measure, relative to library/. Repeatable.")
    ap.add_argument("--n", type=int, default=60)
    ap.add_argument("--ours", default=None,
                    help="path to our own render, measured through the SAME decode path")
    ap.add_argument("--out", default="data/texture.json")
    a = ap.parse_args()

    result = {}
    for d in a.dir:
        files = sorted((HERE / d).rglob("*.opus")) + sorted((HERE / d).rglob("*.wav"))
        if not files:
            print(f"!! no audio under {HERE / d}")
            continue
        files = files[::max(len(files) // a.n, 1)][:a.n]
        rows = []
        for i, fp in enumerate(files, 1):
            try:
                r = measure(fp)
                if r:
                    r["file"] = fp.name
                    rows.append(r)
                    print(f"  [{i}/{len(files)}] flat {r['flatness']:.4f}  hf {r['hf_noise']:.4f}"
                          f"  zcr {r['zcr']:.3f}  {fp.name[:40]}")
            except Exception as e:
                print(f"  [{i}/{len(files)}] skipped {fp.name[:40]}: {type(e).__name__}")
        if rows:
            result[d] = summarise(rows, d)

    if a.ours:
        p = Path(a.ours)
        if not p.is_absolute():
            p = HERE / p
        if p.exists():
            r = measure(p)
            if r:
                result["OURS"] = r
                print(f"\n{'=' * 74}\nOURS — {p.name}, same decode path\n{'=' * 74}")
                print(f"  flatness {r['flatness']:.4f}   hf_noise {r['hf_noise']:.4f}"
                      f"   zcr {r['zcr']:.4f}   crest {r['crest_db']:.1f} dB")
                for d, s in result.items():
                    if d == "OURS" or "flatness" not in s:
                        continue
                    ratio = s["flatness"]["median"] / max(r["flatness"], 1e-12)
                    print(f"  vs {d:<34} {ratio:6.1f}x more broadband (median)")
        else:
            print(f"!! --ours not found: {p}")

    (HERE / a.out).write_text(json.dumps(result, indent=1))
    print(f"\nwrote {HERE / a.out}")


if __name__ == "__main__":
    main()
