# 04 — Licensing: a product blocker, not a footnote

**I am not a lawyer and this is not legal advice.** What follows is (a) what the
source project verified and wrote down at the time, and (b) what I believe to be
true and have marked as needing verification. **Check every line yourself before
shipping anything commercial.** Licences change, model cards get updated, and
some of these projects have relicensed in the past.

The reason this file exists: the source project was a **personal, non-commercial
music-production hobby**, so it chose the best-performing tools and noted the
licence in a comment. **Your app is a product.** Several of the best tools here
are unusable to you, and finding that out after building on them is expensive.

---

## The two hard blockers, both verified in the source repo

### Essentia — AGPL-3.0

Essentia is the backbone of the ML tagging, the beat tracking, the key
extraction and the melody tracking in this package. It is **AGPL-3.0**.

**Why AGPL specifically is a problem for an app:** the GPL family triggers
source-disclosure obligations on *distribution*. The **Affero** clause extends
that to **use over a network** — running AGPL code on your server, where users
interact with it over the internet, is generally treated as triggering the same
obligation to offer your source. For a self-hosted backend doing chord
recognition, that is the whole product.

There is a commercial licence available from UPF (the university that maintains
it). If Essentia is the right technical answer, **ask them what it costs** —
that is a normal transaction and possibly cheap. But do not build on it and
decide later.

### The MTG pretrained models — CC BY-NC-SA 4.0

Quoted in `src/library/tag-ml2.py`, from https://essentia.upf.edu/models.html:

> "All the models created by the MTG are licensed under CC BY-NC-SA 4.0 and are
> also available under proprietary license upon request."

**NC = non-commercial.** This covers everything in the tagging path:
`discogs-effnet` (the embedding), `genre_discogs400`, the mood-theme head, the
five binary mood heads, the danceability head and the instrument head.

**SA = share-alike**, which is a second problem independently of NC.

So `tag-ml.py`, `tag-ml2.py` and `similar.py` are **off the table for a
commercial product** as written. Note that this bites even if you only use the
embeddings — an embedding is an output of the model.

---

## Everything else — believed, but verify

| tool | what I believe | confidence |
|---|---|---|
| **librosa** | ISC — permissive, commercially fine. Slower than Essentia, covers most of the same DSP ground. **The obvious Essentia replacement.** | high |
| **numpy / scipy / soundfile** | BSD-family, fine | high |
| **ffmpeg** | LGPL for the core; **GPL if built with certain codecs** (`--enable-gpl`). Which build you ship matters. | medium — check your actual binary |
| **Whisper** (OpenAI, the open weights) | MIT | high |
| **WhisperX** | Check — it wraps several components (VAD, wav2vec2 alignment) and the *aggregate* licence is what binds you | **low — verify** |
| **Demucs** | MIT for the code. **Pretrained weights are the question** — some model checkpoints in this space are research-only even when the code is permissive. | **low — verify per checkpoint** |
| **Basic Pitch** (Spotify) | Apache-2.0, including weights. **If true, this is the most commercially comfortable transcription model available.** | medium-high |
| **madmom** | Historically a BSD-style licence **with an additional clause restricting use to academic/non-commercial purposes**. If so, it is a blocker exactly like Essentia. | **low — verify, and assume the worst until you have** |
| **beat_this** (ISMIR 2024) | Unknown to me | **unverified** |
| **Chordino / NNLS-Chroma** | GPL, I believe | **low — verify** |
| **mir_eval** | MIT | medium-high |

---

## The pattern to apply

**A licence is a design constraint, and it belongs in the design phase.** Before
you adopt any model or library:

1. Find the licence for **the code** and separately for **the weights**. They
   are frequently different, and the weights are what you are actually
   depending on.
2. Check whether the licence has a **network clause** (AGPL) — for a hosted app,
   this is the one that catches people.
3. Check for **non-commercial** and **share-alike** clauses.
4. Check what the model was **trained on**, if it is stated. Training-data
   provenance is a live issue in music AI and a model trained on scraped
   commercial recordings can carry risk that its licence does not mention.
5. Write the answer down next to the import, the way the source repo did. That
   comment in `tag-ml2.py` is why this file could be written at all.

---

## A pragmatic starting stack for a commercial product

Offered as a starting point for *your own* verification, not as a cleared list:

- **DSP and features:** librosa + numpy + scipy + soundfile
- **Separation:** Demucs — *pending weight-licence check*
- **Beats/downbeats:** the licence check here is the deciding factor, not the
  accuracy. Verify before you benchmark.
- **Note transcription:** Basic Pitch — *pending verification*, but the most
  promising on licence terms
- **ASR/lyrics:** Whisper weights (MIT) + your own alignment, if WhisperX's
  aggregate licence does not clear
- **Evaluation:** mir_eval
- **Avoid unless licensed:** Essentia, every MTG model, madmom
