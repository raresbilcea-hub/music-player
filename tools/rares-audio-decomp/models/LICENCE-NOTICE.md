# ⚠️ These weights are NON-COMMERCIAL

The twelve model files in this directory were created by the **Music Technology
Group (MTG) at Universitat Pompeu Fabra** and are licensed
**CC BY-NC-SA 4.0**. From https://essentia.upf.edu/models.html:

> "All the models created by the MTG are licensed under CC BY-NC-SA 4.0 and are
> also available under proprietary license upon request."

- **NC — non-commercial.** Covers every file here, including
  `discogs-effnet-bs64-1.pb`, which is the embedding everything else reads.
  Using only the embedding does not avoid the licence: an embedding is an output
  of the model.
- **SA — share-alike.** A separate constraint that applies independently.
- **BY — attribution.**

They are bundled here so the pipeline runs out of the box for **evaluation**.
That is not a licence assessment for your product.

**The library that loads them, Essentia, is separately AGPL-3.0** — and the
Affero clause is generally read as reaching software served over a network,
which is what a hosted transcription app is.

**A proprietary licence is available from UPF on request.** If these models turn
out to be the right technical answer, asking what that costs is a normal
transaction and possibly cheap. The mistake would be building on them and
finding out afterwards.

See `../docs/04-licensing.md` for the full picture, including the alternatives
that are more comfortable commercially.

---

## What each file is

| file | what it does |
|---|---|
| `discogs-effnet-bs64-1.pb` | 1280-d embedding. **~95% of the compute**; every head below reads it |
| `genre_discogs400-discogs-effnet-1.pb` + `.json` | 400-class Discogs genre taxonomy |
| `mtg_jamendo_moodtheme-discogs-effnet-1.pb` + `.json` | mood / theme tags |
| `mtg_jamendo_instrument-discogs-effnet-1.pb` + `.json` | 40 instrument classes |
| `danceability-discogs-effnet-1.pb` | binary head |
| `mood_happy` / `mood_sad` / `mood_relaxed` / `mood_aggressive` | binary heads |

**Two traps, both measured:**

1. **The graphs do not share node names.** The genre model exposes
   `serving_default_model_Placeholder` → `PartitionedCall:0`; the MTG-Jamendo
   mood and instrument models expose `model/Placeholder` → `model/Sigmoid`.
   Same publisher, same embedding, different interface. Assuming otherwise
   crashed the tagging stage on the second head it tried. `analyse_song.py`
   now probes the pairs instead of hardcoding one.
2. **These are rankings, not probabilities.** The instrument head's own metadata
   reports **PR-AUC 0.20 / ROC-AUC 0.78** over 25,135 tracks — good ranking,
   poor calibration. `piano = 0.31` means the track sits high in the piano
   ordering, not 31% confidence. Every threshold you set is a percentile of
   your own corpus.

And one thing worth knowing before you read any genre output: **the Discogs-400
vocabulary is fixed and predates most post-2015 subgenre labels.** "Organic
House" is not one of the 400 classes, so the classifier structurally cannot
return it, and its absence is not evidence.
