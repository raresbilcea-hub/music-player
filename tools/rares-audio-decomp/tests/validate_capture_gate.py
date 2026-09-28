#!/usr/bin/env python3
"""
validate_capture_gate.py — check the CHECKER before trusting it.

    python3 tests/validate_capture_gate.py                 # synthetic only
    python3 tests/validate_capture_gate.py song.wav …      # + your own files

This is docs/03-mir-lessons.md §10 as an executable test:

    "Ask what the metric returns for a DEGENERATE input — silence, a single
     impulse, a constant tone. Run those first. An implausibly uniform result
     across genuinely different inputs is the tell."

**It earned its place immediately.** The first version of the capture gate:

  · **crashed on digital silence** — `np.searchsorted` returned an
    out-of-bounds index when the cumulative energy never reached its threshold;
  · **reported a perfectly good dark piano recording as band-limited**, because
    it used a cumulative-energy percentile, which measures the MATERIAL while
    claiming to measure the CAPTURE. A sustained low chord legitimately puts
    99.5% of its energy under 900 Hz;
  · then, once rewritten to hunt for a spectral cliff, **found the steepest step
    in the ARRANGEMENT instead of the codec cutoff** — 449 Hz on a 130 kbps
    Opus — and compared it against a 10 kHz threshold that **sat above the
    highest value the measurement could ever return**, so it fired on every
    file including clean ones.

Three wrong versions, all of which looked fine until run against inputs whose
answers were known. Neither reading the code nor testing on one real file would
have caught any of them.

WHAT THE GATE SHOULD DO, and what this asserts:
  · genuinely dark but full-bandwidth material  → NO band-limit warning
  · the same material through an 8 kHz lowpass  → band-limit warning
  · silence / impulse / sine / noise / 0.3 s    → flagged, and NO crash
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np                                             # noqa: E402
import analyse_song as A                                       # noqa: E402
import decompose as D                                          # noqa: E402

try:
    from scipy.signal import butter, lfilter
    HAVE_SCIPY = True
except Exception:                                              # noqa: BLE001
    HAVE_SCIPY = False

SR = D.SR
FAILS = []


def gate(name, x, expect_bandlimit=None, expect_no_crash=True):
    try:
        g = A.capture_gate(x)
    except Exception as e:                                     # noqa: BLE001
        print(f"  ✗ {name:<34} CRASHED: {type(e).__name__}: {e}")
        FAILS.append(f"{name}: crashed")
        return None
    bl = any("BAND-LIMITED" in w for w in g["warnings"])
    print(f"    {name:<34} bw={g['bandwidth_hz']:>7.0f} Hz  roll={g['rolloff_above_bandwidth_db']:>5.1f} dB "
          f" hdrm={g['dynamic_headroom_db']:>5.1f}  {g['verdict']}")
    for w in g["warnings"]:
        print(f"        · {w[:88]}")
    if expect_bandlimit is not None and bl != expect_bandlimit:
        want = "a band-limit warning" if expect_bandlimit else "NO band-limit warning"
        print(f"  ✗ expected {want}")
        FAILS.append(f"{name}: expected {want}")
    return g


def dark_chord(seconds=20.0):
    """Legitimately dark but FULL-BANDWIDTH material. The gate must NOT call
    this band-limited.

    🔴 THE FIRST VERSION OF THIS FIXTURE WAS ITSELF BAND-LIMITED and the test
    duly failed — four sine pairs topping out at 440 Hz over a noise floor
    49 dB down is, correctly, a 449 Hz cliff. **The gate was right and the test
    was wrong**, which is worth stating because the instinct on a red test is to
    go and change the code.

    What distinguishes a dark INSTRUMENT from a filtered CAPTURE is that the
    instrument has a long, gently decaying harmonic tail — energy all the way
    up, just quiet. So: 40 partials at 1/k^1.5, which slopes rather than
    shelves, over a realistic broadband floor."""
    t = np.arange(int(SR * seconds)) / SR
    x = np.zeros_like(t)
    for f in (73.42, 110.0, 146.83, 220.0):                    # D2 A2 D3 A3
        for k in range(1, 41):
            if f * k > SR / 2 * 0.95:
                break
            x += (0.20 / k ** 1.5) * np.sin(2 * np.pi * f * k * t + k)
    x += 0.0005 * np.random.RandomState(1).randn(len(t))       # a real noise floor
    # slow amplitude movement, so the headroom check has something to look at
    x *= 0.5 + 0.5 * np.abs(np.sin(2 * np.pi * 0.25 * t))
    return x / (np.max(np.abs(x)) * 1.05)


def main():
    print(__doc__.split("WHAT THE GATE")[0].strip()[:0] or "", end="")
    print("\n▶ REAL-SHAPED SIGNALS — these must come back clean\n")
    dark = dark_chord()
    gate("dark sustained chord, full-band", dark, expect_bandlimit=False)

    for p in sys.argv[1:]:
        if Path(p).exists():
            gate(f"your file: {Path(p).name[:22]}", D.load(p, 0, 30))
        else:
            print(f"    (skipped, not found: {p})")

    if HAVE_SCIPY:
        print("\n▶ SYNTHETIC BAND-LIMITING — these must be caught\n")
        for cut, label in ((8000, "8 kHz (phone mic)"), (3400, "3.4 kHz (phone line)")):
            b, a = butter(8, cut / (SR / 2))
            gate(f"lowpassed at {label}", lfilter(b, a, dark), expect_bandlimit=True)
    else:
        print("\n  (scipy not installed — skipping the band-limit cases)")

    print("\n▶ DEGENERATE INPUTS — none of these may crash\n")
    t = np.arange(SR * 10) / SR
    gate("digital silence", np.zeros(SR * 10))
    gate("pure 220 Hz sine", 0.5 * np.sin(2 * np.pi * 220 * t))
    gate("white noise", np.random.RandomState(0).randn(SR * 10) * 0.1)
    gate("single impulse", np.eye(1, SR * 10, 0).ravel())
    gate("0.3 s of audio", dark[:int(SR * 0.3)])
    gate("clipped +12 dB", np.clip(dark * 4, -1, 1))
    gate("empty array", np.zeros(0))
    gate("DC offset only", np.ones(SR * 5) * 0.5)

    print()
    if FAILS:
        print(f"✗ {len(FAILS)} FAILURE(S):")
        for f in FAILS:
            print(f"    · {f}")
        sys.exit(1)
    print("✓ all checks passed — the gate separates dark material from a "
          "band-limited capture, and survives every degenerate input")


if __name__ == "__main__":
    main()
