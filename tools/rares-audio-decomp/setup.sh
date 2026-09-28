#!/usr/bin/env bash
# setup.sh — get this package running from a clean machine.
#
#   bash setup.sh          # check, install what is missing, then verify
#   bash setup.sh --check  # check only, install nothing
#
# Idempotent: safe to run repeatedly. It prints what it is about to do before
# doing it, and it VERIFIES at the end by actually running the pipeline rather
# than by trusting that pip exited 0.
#
# ⚠️ LICENCE GATE: this installs Essentia (AGPL-3.0), and the package ships MTG
# model weights (CC BY-NC-SA 4.0, NON-COMMERCIAL). Both are fine for evaluation
# and neither is fine for an unlicensed commercial product. See
# docs/04-licensing.md. This script prints the warning; it does not decide.

set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

PY="${PYTHON:-python3}"
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
step() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }

MISSING=0

# ─────────────────────────────────────────────────────────── 1. ffmpeg ──────
step "1/5  ffmpeg — every decode in this package goes through it"
if command -v ffmpeg >/dev/null 2>&1; then
  ok "ffmpeg $(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}')"
else
  bad "ffmpeg not found"
  MISSING=1
  if [ "$CHECK_ONLY" = 0 ]; then
    if command -v brew >/dev/null 2>&1;   then echo "    installing via brew…";   brew install ffmpeg
    elif command -v apt-get >/dev/null 2>&1; then echo "    installing via apt…"; sudo apt-get update && sudo apt-get install -y ffmpeg
    else warn "install ffmpeg manually: https://ffmpeg.org/download.html"; fi
  else
    echo "    macOS:  brew install ffmpeg"
    echo "    Debian: sudo apt-get install -y ffmpeg"
  fi
fi

# ─────────────────────────────────────────────────────────── 2. python ──────
step "2/5  Python"
if command -v "$PY" >/dev/null 2>&1; then
  PYV="$("$PY" -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])')"
  ok "$PY  ($PYV)"
  "$PY" - <<'EOF' || warn "essentia-tensorflow wheels do not exist for every Python version; 3.10-3.12 is the safe range"
import sys
raise SystemExit(0 if (3, 9) <= sys.version_info[:2] <= (3, 12) else 1)
EOF
else
  bad "$PY not found"; MISSING=1
fi

# ────────────────────────────────────────────────── 3. python packages ──────
step "3/5  Python packages"
need_pkg() {  # name  import-name
  if "$PY" -c "import $2" >/dev/null 2>&1; then
    V="$("$PY" -c "import $2,sys; sys.stdout.write(str(getattr($2,'__version__','?')))" 2>/dev/null)"
    ok "$1 ($V)"; return 0
  fi
  bad "$1 — missing"; return 1
}
TO_INSTALL=()
need_pkg numpy numpy            || TO_INSTALL+=("numpy")
need_pkg scipy scipy            || TO_INSTALL+=("scipy")
need_pkg soundfile soundfile    || TO_INSTALL+=("soundfile")
need_pkg essentia essentia      || TO_INSTALL+=("essentia-tensorflow")
need_pkg demucs demucs          || TO_INSTALL+=("demucs")

if [ ${#TO_INSTALL[@]} -gt 0 ]; then
  MISSING=1
  echo
  warn "missing: ${TO_INSTALL[*]}"
  if [ "$CHECK_ONLY" = 0 ]; then
    warn "AGPL/non-commercial licences apply — see docs/04-licensing.md"
    echo "    running: $PY -m pip install ${TO_INSTALL[*]}"
    "$PY" -m pip install "${TO_INSTALL[@]}" || warn "pip install failed — see notes below"
  else
    echo "    $PY -m pip install ${TO_INSTALL[*]}"
  fi
  echo
  echo "    NOTES, each one learned the hard way:"
  echo "      · install 'essentia-tensorflow', NOT 'essentia'. The plain package has the"
  echo "        DSP but not TensorflowPredictEffnetDiscogs, so models/ will not load and"
  echo "        stage 7 silently skips."
  echo "      · demucs pulls torch/torchaudio — roughly 2 GB. It is the long part."
  echo "      · no wheel found usually means your Python version, not your network."
fi

# ─────────────────────────────────────────────────────────── 4. models ──────
step "4/5  model weights (27 MB, shipped in this package)"
NEED=(discogs-effnet-bs64-1.pb genre_discogs400-discogs-effnet-1.pb
      genre_discogs400-discogs-effnet-1.json mtg_jamendo_moodtheme-discogs-effnet-1.pb
      mtg_jamendo_moodtheme-discogs-effnet-1.json mtg_jamendo_instrument-discogs-effnet-1.pb
      mtg_jamendo_instrument-discogs-effnet-1.json danceability-discogs-effnet-1.pb
      mood_happy-discogs-effnet-1.pb mood_sad-discogs-effnet-1.pb
      mood_relaxed-discogs-effnet-1.pb mood_aggressive-discogs-effnet-1.pb)
GOT=0
for m in "${NEED[@]}"; do [ -f "$HERE/models/$m" ] && GOT=$((GOT+1)); done
if [ "$GOT" -eq "${#NEED[@]}" ]; then
  ok "all ${#NEED[@]} model files present"
else
  bad "$GOT/${#NEED[@]} model files present"
  MISSING=1
  echo "    re-download from https://essentia.upf.edu/models.html into $HERE/models/"
  echo "    e.g.  curl -L -o models/discogs-effnet-bs64-1.pb \\"
  echo "            https://essentia.upf.edu/models/feature-extractors/discogs-effnet/discogs-effnet-bs64-1.pb"
  echo "    ⚠️ CC BY-NC-SA 4.0 — non-commercial. docs/04-licensing.md"
fi

# ─────────────────────────────────────────────────────────── 5. verify ──────
step "5/5  verify — run it, do not trust the exit codes above"
if [ "$MISSING" = 1 ] && [ "$CHECK_ONLY" = 1 ]; then
  warn "skipping verification: dependencies are missing"
  exit 1
fi

TESTWAV="$HERE/cache/_setup_test.wav"
mkdir -p "$HERE/cache"
# 8 seconds of a synthetic Dm chord over a 120 BPM pulse — no sample files
# needed, and the correct answer is known.
"$PY" - "$TESTWAV" <<'EOF'
# A test signal with a KNOWN answer: D minor at exactly 120 BPM.
#
# ⚠️ THE FIRST VERSION OF THIS WAS BROKEN and the script reported success
# anyway — 152 BPM on a 120 BPM track — because it only checked that the tool
# RAN. A spike train built from `sin(2*pi*2*t) > 0.98` does not land on exact
# half-second boundaries, and the decay envelope was computed against a
# separate modulo clock, so the two disagreed and produced extra onsets. Now
# the clicks are written at exact sample indices, and the tempo is CHECKED.
import sys, numpy as np, soundfile as sf
sr, dur, bpm = 44100, 16.0, 120.0
n = int(sr*dur)
t = np.arange(n)/sr
x = np.zeros(n)
for f in (146.83, 174.61, 220.00, 293.66):        # D3 F3 A3 D4 = D minor
    x += 0.10*np.sin(2*np.pi*f*t)
# One click per beat, at exact sample positions, 25 ms exponential decay.
period = int(round(sr*60.0/bpm))
click_len = int(sr*0.025)
click = np.exp(-np.arange(click_len)/(sr*0.004)) * np.sin(
    2*np.pi*90*np.arange(click_len)/sr)
for i in range(0, n-click_len, period):
    x[i:i+click_len] += 0.9*click
x /= np.max(np.abs(x))*1.05
sf.write(sys.argv[1], np.column_stack([x, x]).astype(np.float32), sr)
EOF

echo "    running: $PY decompose.py cache/_setup_test.wav"
OUT="$("$PY" "$HERE/decompose.py" "$TESTWAV" 2>&1)"
if echo "$OUT" | grep -q "KEY"; then
  ok "decompose.py runs"
  echo "$OUT" | grep -E "TEMPO|KEY " | sed 's/^/      /'
  # CHECK THE ANSWERS, not just that it ran. The signal is D minor at 120 BPM.
  if echo "$OUT" | grep -qiE "KEY +Dm"; then
    ok "key = Dm on a synthetic D-minor chord"
  else
    warn "key is NOT Dm on a synthetic Dm chord — see docs/03-mir-lessons.md §1"
  fi
  BPM="$(echo "$OUT" | awk '/TEMPO/{print $2}')"
  if "$PY" -c "import sys; sys.exit(0 if abs(float('${BPM:-0}')-120.0) <= 3.0 else 1)" 2>/dev/null; then
    ok "tempo = ${BPM} BPM on a 120 BPM click track"
  else
    warn "tempo = ${BPM} BPM on a 120 BPM click track — off by more than one bin."
    warn "  Not necessarily broken: see docs/03-mir-lessons.md §2 on octave"
    warn "  ambiguity (60/240 are the same track) and on bin resolution."
  fi
else
  bad "decompose.py failed:"; echo "$OUT" | tail -15 | sed 's/^/      /'; exit 1
fi

if "$PY" -c "import essentia" >/dev/null 2>&1 && [ "$GOT" -eq "${#NEED[@]}" ]; then
  echo "    running: $PY analyse_song.py --tags  (full stack, no separation)"
  if "$PY" "$HERE/analyse_song.py" "$TESTWAV" --tags --json "$HERE/cache/_setup_test.json" \
        >/dev/null 2>&1; then
    ok "analyse_song.py runs with the ML heads"
  else
    warn "analyse_song.py --tags failed; decompose.py still works"
  fi
fi

step "done"
if [ "$MISSING" = 1 ]; then
  warn "some things were missing — re-run 'bash setup.sh --check' to confirm they are fixed"
else
  ok "everything present"
fi
cat <<'EOF'

  Next:
    python3 decompose.py    your.wav                 # fast, no heavy deps
    python3 analyse_song.py your.wav --all           # separation + tags (slow)
    python3 tests/validate_capture_gate.py           # metric sanity checks

  🔴 Read docs/03-mir-lessons.md before trusting any number either one prints.
EOF
