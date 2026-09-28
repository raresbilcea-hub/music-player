"""width.py — settle the stereo question. ONE script, ONE decode path.

    python3 library/width.py

🔴 WHY THIS EXISTS. Two research agents measured this project's stereo picture
against the same library on the same day and reported opposite conclusions:

    "the real gap is stereo width: ours 1.39x, lane 1.61-1.76x —
     the only axis below all three reference sets"
    "his record is not narrow. Loud-section correlation 0.892, the 44th
     percentile of his own lane. Nothing needs widening."

**Neither is necessarily wrong, because they are not the same quantity.**
`movement.py`'s number is how much the width CHANGES inside a section; the
other is how wide it IS. This script computes BOTH, on the same windows, with
the same decoder, so the two can be told apart instead of argued about.

⚠️ AND IT FIXES A REAL BUG WHILE IT IS HERE. `movement.py` decodes references
through ffmpeg at **22050 Hz** and our own master through soundfile at
**44100**. Spectral centroid depends on Nyquist, so every ours-versus-lane
BRIGHTNESS comparison this project has made was between different bandwidths.
Width ratios are less affected, but the fix is free: decode everything the same
way, always.

THE THREE MEASUREMENT TRAPS, all of which have already bitten:
  1. A sparse section reads WIDE for free — the centred elements have dropped
     out and only the stereo tails remain. So loud and quiet windows are
     reported SEPARATELY and never pooled. (One agent's first pass returned an
     alarming 0.451 from a 60 s chunk that had landed in a breakdown.)
  2. The lane is YouTube Opus, which uses mid/side coupling and could in
     principle have manufactured the whole comparison. Round-tripping our own
     master through Opus at 130 kbps moved correlation 0.5839 -> 0.5826, so the
     comparison survives — but it is checked here rather than assumed.
  3. Both quantities are ratios of ratios. Degenerate inputs are printed at the
     bottom so a number can be sanity-checked against silence and against mono.
"""
import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

HERE = Path(__file__).parent
INFL = HERE / "influences"
OURS = HERE.parent / "tracks" / "current" / "Master.wav"
SR = 44100                    # ONE rate for everything. See the note above.
WIN = 4.0                     # seconds per analysis window
MAX_S = 420


def load(path, sr=SR, max_s=MAX_S):
    """Everything through ffmpeg at ONE rate — including our own WAV, so our
    number and the lane's cannot differ because of the decoder."""
    cmd = ["ffmpeg", "-v", "quiet", "-i", str(path), "-t", str(max_s),
           "-f", "f32le", "-acodec", "pcm_f32le", "-ac", "2",
           "-ar", str(sr), "-"]
    raw = subprocess.run(cmd, capture_output=True).stdout
    x = np.frombuffer(raw, dtype=np.float32)
    if len(x) < sr * 30 * 2:
        return None
    return x.reshape(-1, 2)


def windows(x, sr=SR):
    """Per-window (level, side/mid ratio, L/R correlation)."""
    n = int(WIN * sr)
    L, R = x[:, 0].astype(np.float64), x[:, 1].astype(np.float64)
    mid, side = (L + R) / 2, (L - R) / 2
    out = []
    for a in range(0, len(mid) - n, n):
        m = mid[a:a + n]
        e = float(np.sqrt((m ** 2).mean()))
        if e < 1e-4:
            continue
        s = float(np.sqrt((side[a:a + n] ** 2).mean()))
        l, r = L[a:a + n], R[a:a + n]
        sl, sr_ = l.std(), r.std()
        c = float((l - l.mean()).dot(r - r.mean()) / (len(l) * sl * sr_)) \
            if sl > 1e-9 and sr_ > 1e-9 else 1.0
        out.append((20 * np.log10(e), s / (e + 1e-9), c))
    return np.array(out) if len(out) >= 12 else None


def describe(w):
    """Loud half and quiet half, ALWAYS separated — a sparse section reads wide
    for free and pooling the two is how a breakdown becomes a finding."""
    lvl, ratio, corr = w[:, 0], w[:, 1], w[:, 2]
    cut = np.median(lvl)
    loud, quiet = lvl >= cut, lvl < cut
    if loud.sum() < 4 or quiet.sum() < 4:
        return None
    return dict(
        corr_loud=float(np.median(corr[loud])),
        corr_quiet=float(np.median(corr[quiet])),
        ratio_loud=float(np.median(ratio[loud])),
        # movement = how much the width CHANGES within the loud half. Stated as
        # p90-p10 of the ratio, NOT as a p90/p10 ratio: a ratio of ratios blows
        # up when p10 is near zero, which is exactly what a mono-ish record does.
        move_loud=float(np.percentile(ratio[loud], 90)
                        - np.percentile(ratio[loud], 10)),
        quiet_wider=float(np.median(corr[loud]) - np.median(corr[quiet])))


def main():
    # ⚠️ rglob, NOT glob. `influences/` is organised into per-artist folders
    # (Lee Burridge, Solomun, ADID roster, tribal, ...) and a flat glob finds
    # exactly zero files while reporting a clean run — which is what the first
    # version of this script did.
    files = sorted(INFL.rglob("*.opus")) + sorted(INFL.rglob("*.m4a"))
    print(f"  {len(files)} lane tracks on disk · everything decoded at {SR} Hz "
          f"· {WIN:.0f}s windows")

    rows = []
    for i, f in enumerate(files):
        x = load(f)
        if x is None:
            continue
        w = windows(x)
        if w is None:
            continue
        d = describe(w)
        if d:
            rows.append(d)
        if (i + 1) % 100 == 0:
            print(f"    ...{i + 1}/{len(files)}")
    if not rows:
        print("  no lane tracks decoded — is ffmpeg present?")
        return 1

    ours = describe(windows(load(OURS)))
    keys = [("corr_loud", "L/R correlation, LOUD half", "1.0 = mono"),
            ("corr_quiet", "L/R correlation, QUIET half", ""),
            ("ratio_loud", "side/mid ratio, LOUD half", "higher = wider"),
            ("move_loud", "width MOVEMENT within the loud half", "p90-p10"),
            ("quiet_wider", "loud minus quiet correlation", "+ = breakdowns wider")]

    print(f"\n  {len(rows)} lane tracks measured\n")
    print(f"  {'':44}{'p10':>8}{'median':>9}{'p90':>8}{'OURS':>9}{'pctile':>8}")
    for k, label, note in keys:
        v = np.array([r[k] for r in rows])
        o = ours[k]
        pct = 100.0 * float((v < o).mean())
        flag = "  <<<" if pct < 10 or pct > 90 else ""
        print(f"  {label:<36}{note:>8}{np.percentile(v, 10):8.3f}"
              f"{np.median(v):9.3f}{np.percentile(v, 90):8.3f}"
              f"{o:9.3f}{pct:7.0f}%{flag}")

    print("\n  DEGENERATE INPUTS — what this measurement returns when it should")
    # ⚠️ 90 s, NOT 30. At 4 s windows, 30 s yields 7 and `windows()` requires
    # 12 — so all three degenerate cases returned "no windows" and the script
    # printed "(correct for silence)" beside every one of them. **A sanity
    # check that cannot fail is not a sanity check**, and this one reassured me
    # about mono and decorrelated noise while measuring neither.
    n = int(90 * SR)
    rng = np.random.default_rng(0)
    for name, sig in (("pure mono", np.tile(rng.standard_normal((n, 1)), (1, 2))),
                      ("fully decorrelated", rng.standard_normal((n, 2))),
                      ("silence", np.zeros((n, 2)))):
        w = windows(sig.astype(np.float64))
        if w is None:
            print(f"    {name:<22} no windows"
                  f"{'   <- correct' if name == 'silence' else '   🔴 WRONG'}")
            continue
        print(f"    {name:<22} correlation {np.median(w[:, 2]):+.3f}   "
              f"side/mid {np.median(w[:, 1]):.3f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
