#!/bin/bash
# Library-wide arrangement study, v2.
#
# WHAT CHANGED FROM v1, and why -- both changes were Paul's calls, 5 Aug 2026:
#
#  1. **STEMS ARE KEPT.** v1 deleted them after each track to hold disk flat,
#     on a note that said 34 GB free. There are now 249 GB free -- the
#     constraint expired -- and deleting them meant that asking for finer
#     resolution forced the entire separation to run again. Separation is the
#     expensive step; keeping it is the whole point.
#  2. **SIX STEMS, NOT FOUR.** htdemucs_6s splits `piano` and `guitar` out of
#     `other`. Piano is in 18% of his library and his lane is organic house.
#     With four stems the study was structurally blind to both.
#
# Also: the per-track TEXT PICTURE is no longer the output. The output is a raw
# per-beat matrix (arrangement-matrix.py), because a picture is one resolution
# and the numbers are every resolution. Pictures are rendered from it on demand.
#
# Cost: ~2:19 per track, ~148 MB per track as FLAC. 139 tracks ~ 5.4 h, ~20 GB.
# Resumable: a track whose stem folder already exists is not separated again,
# and a track already in the .jsonl is not re-measured. Safe to kill and rerun.

cd /Users/paul/paul-personal/music-production
OUT=library/inspo/stems-study
MODEL=htdemucs_6s
MAT=library/data/arrangement-matrix.jsonl
LIST=library/data/arrangement-filelist.tsv
PY=/Users/paul/miniconda3/bin/python3
mkdir -p "$OUT" library/data

# ---- the file list: the 135-track genre set PLUS the four House Inspo records
# he named himself. Those four were only ever separated at 4 stems, so they get
# redone at 6 -- his instruction, and they are the most important four in the set.
$PY - "$LIST" <<'PYEOF'
import glob, json, os, sys
rows = []
for r in json.load(open('library/data/arrangement-set.json')):
    rows.append((r['path'], r['genre'], r['name']))
for p in sorted(glob.glob('library/inspo/*.opus')):
    rows.append((p, 'House Inspo', os.path.basename(p).rsplit(' [', 1)[0]))
seen, out = set(), []
for p, g, n in rows:
    if p in seen or not os.path.exists(p):
        continue
    seen.add(p)
    out.append(f"{p}\t{g}\t{n}")
open(sys.argv[1], 'w').write("\n".join(out) + "\n")
print(f"{len(out)} tracks queued")
PYEOF

N=$(wc -l < "$LIST" | tr -d ' ')
echo "=== arrangement study v2 — $N tracks, $MODEL, started $(date) ==="
# 🔴 THE FILELIST IS READ ON FD 3, NOT STDIN, AND THAT IS LOAD-BEARING.
# v2 originally used `done < "$LIST"` with a plain `read`. `uvx demucs` inherits
# the loop's stdin, reads from it, and EATS BYTES OFF THE FILELIST — so the next
# iteration got a truncated path: `library/audio/x.opus` arrived as `brary/audio/
# x.opus`. Demucs then printed "File ... does not exist" and **exited 0**, so
# nothing looked wrong: no error in the log, no crash, just 16 of the first 36
# tracks silently missing. Reading on fd 3 puts the list out of stdin's reach.
i=0
while IFS=$'\t' read -r -u 3 f genre name; do
  i=$((i+1))
  b=$(basename "$f"); b="${b%.*}"
  if [ -d "$OUT/$MODEL/$b" ]; then
    echo "[$i/$N] have stems — $genre — $name"
  else
    echo "[$i/$N] separating — $genre — $name"
    uvx --with numpy demucs -d mps -n "$MODEL" --flac -o "$OUT" "$f" \
      >> /tmp/arr-demucs.log 2>&1 < /dev/null
    [ -d "$OUT/$MODEL/$b" ] || echo "    ⚠️  SEPARATION PRODUCED NOTHING: $f"
  fi
  if [ -d "$OUT/$MODEL/$b" ]; then
    # `--track=$b`, NOT `--track "$b"`. YouTube IDs can START WITH A HYPHEN
    # (`-hLpHvi5UZM`), and argparse reads a leading-dash value as another flag,
    # so that one track silently never got measured — 138 of 139, no error.
    # The `=` form is the only one that survives it.
    $PY library/arrangement-matrix.py --stems "$OUT/$MODEL" --track="$b" \
      --out "$MAT" < /dev/null 2>/dev/null
  fi
done 3< "$LIST"
echo "=== ALL DONE $(date) — $(wc -l < "$MAT" | tr -d ' ') tracks in $MAT ==="
