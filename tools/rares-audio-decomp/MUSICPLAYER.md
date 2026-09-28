# MusicPlayer integration

This folder is Paul's audio decomposition handoff, unpacked from:

`/Users/raresbilcea/Downloads/rares-audio-decomp.zip`

## How MusicPlayer uses it

The backend wrapper is:

`../../audioDecomp.js`

Run a local analysis from the repo root:

```bash
npm run audio:decomp -- ./test-clip.wav --dur 30
```

This calls `decompose.py` and returns its JSON output: tempo, beat summary, key
verdict, per-bar chords, section boundaries, and band energy.

## Setup

The lightweight analyzer needs Python packages:

```bash
python3 -m pip install -r tools/rares-audio-decomp/requirements.txt
```

Then verify:

```bash
npm run audio:decomp:check
```

## Production boundary

Do not wire `analyse_song.py --all`, Essentia, or the bundled `.pb` model
weights into the deployed product until the licences are cleared.

Known blockers from `docs/04-licensing.md`:

- Essentia is AGPL-3.0.
- The MTG model weights are CC BY-NC-SA 4.0.

The `.pb` weights are present locally for evaluation but ignored by git. The
safe first use inside MusicPlayer is local experimentation with `decompose.py`
and lifting commercially usable ideas into the existing JavaScript pipeline.
