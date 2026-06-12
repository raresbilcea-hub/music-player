# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This is the **backend** for Music Player 2.0. The mobile app lives in `MusicPlayer20/` and has its own `CLAUDE.md`.

## ⭐ Roadmap (current direction, post Paul/Rares strategy session)

This section reflects a strategic pivot agreed by Rares (founder) and Paul (advising developer friend). It supersedes the older mobile-first / GPT-4o-chord-generation direction described in earlier project notes — read this first.

### Why we're pivoting

The previous "AI generates the chord chart" approach (`generateChartWithAI`, mode B) is GPT-4o recalling chords from training data — pattern-matching, not real transcription. For popular songs the existing UG/Cifra Club/e-chords scrape cascade (see "Chord chart pipeline" below) already produces better, human-curated charts and should be kept. But for anything not covered by those scrapes, hallucinated AI charts require too much manual correction and cause users to bounce. We need a real audio-based transcription pipeline.

### New audio pipeline (Phase 1)

```
User records snippet / searches song
  → AudD identification or iTunes search (existing)
  → YouTube Data API: find matching video, extract audio
  → Demucs (Replicate, model "htdemucs_6s") → isolate guitar stem
       (htdemucs_6s also yields vocals/drums/bass/piano/other for free)
  → Essentia → chord detection on the guitar stem
  → Lyrics: Musixmatch / Genius / lrclib (extends existing fetchRealLyrics cascade)
  → Static chord chart (NOT synced/scrolling playback like Chordify)
```

**Static chart, not scrolling playback** — better for working musicians at gigs (no internet dependency, printable, glanceable).

**Replicate / Demucs notes:**
- Pay-as-you-go GPU, no subscription. T4 ≈ $0.000225/sec (~$0.81/hr); roughly $0.01–0.02 per 30-sec test clip.
- Model choice: `htdemucs_6s` (6-source: vocals/drums/bass/guitar/piano/other) — gives a dedicated guitar stem, unlike the default 4-source `htdemucs`.
- **The "stem" input parameter is optional.** The Replicate Playground's web form *looks* like it forces you to pick one of vocals/bass/drums/guitar/piano/other from a dropdown, but that's just a UI quirk of the form widget. The underlying API field is nullable — per the model's own docs: *"Only separate audio into the chosen stem and others (no_stem)"*. When calling the API directly (which is what `server.js` will do), simply **don't include the `stem` key in the input object at all** → the model returns **all 6 separated stems** in one run. (Confirmed: a prior playground run returned bass/drums/other/vocals stems simultaneously.) If you ever need to test "all stems" via the Playground UI itself, use the "API"/code tab and omit `stem` from the request body — the Form tab's dropdown can't be left blank.

### Platform pivot: web first

- **Next.js web app first**, not the Expo/React Native app — avoids App Store review friction while validating the product (Paul's advice, Rares agreed).
- The current `MusicPlayer20/` mobile app is **deprioritized, not abandoned** — revisit after the web MVP is validated.
- **Carries over as-is:** Supabase (`chord_charts`, auth, `user_songs`), this Railway backend, chord-chart business logic, chord rendering/diagram logic.
- **Rebuilt for web:** UI, navigation, audio capture/recording.
- Rares is building the Next.js frontend and audio pipeline himself with Claude's help; Paul advises but isn't building.

### Phasing

- **Phase 1 (MVP)** — Guitar chords only, static charts. Validate with ~20 working musicians for about a month before expanding scope.
- **Phase 1b (deferred — build only if users ask for it)** — Multi-instrument charts. Demucs already separates bass/piano/other; add Basic Pitch (Spotify, audio→MIDI) for note-level transcription of those stems.
- **Phase 2 (later)** — Accept user-uploaded recordings of their own original songs (not label catalogue), transcribe via Whisper (already integrated for `/transcribe`) + the chord pipeline.

### Pricing

- Subscription cap: **$12/month max** — hard constraint from Rares, do not design pricing tiers above this.
- Free tier: **3 songs/month** (reduced from an earlier plan of 5, to control AI/API cost while the user base is small).

### Differentiators vs. Chordify

- Shazam-style entry point: record → auto-identify → auto chart, no manual YouTube link needed.
- Crowdsourced verified-correction database (Chordify has nothing like the existing `verified` flag / correction flow).
- Chord fretboard diagrams with finger positions (already built — `ChordDiagram.tsx` / `ChordPreview`).
- Static, printable charts; works offline once generated.

### Legal considerations / open risks (not yet resolved)

- YouTube audio extraction is a ToS violation — Chordify operates this way regardless, but it's a known risk, not a cleared one. **Decision (June 2026, Rares):** full-song YouTube analysis is LIVE (`downloadFullSong` in audioAnalysis.js; yt-dlp installed via brew locally and nixpacks.toml on Railway). The 30s iTunes preview path remains the automatic fallback when YouTube blocks the server's IP.
- The existing UG scraping in `fetchChartFromUG` is **also** a ToS violation — newly identified risk in the current backend, not introduced by the new pipeline.
- Lyrics require licensing: Musixmatch has publisher deals; Genius/lrclib are legal gray areas.
- Chord progressions themselves are not copyrightable — lower risk than lyrics/audio.
- For Phase 2, frame it as "transcribe the user's own original recordings", not "songs outside the label catalogue" — avoids implying we're circumventing licensing for popular music.

## Commands

```bash
node server.js          # start on port 3000
```

No build step, no test suite. All logic is in the single file `server.js`.

## Environment (`.env`)

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | GPT-4o chord generation |
| `SUPABASE_URL` / `SUPABASE_KEY` | chord chart storage + auth |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | audio analysis (key & tempo) |
| `AUDD_API_KEY` | audio fingerprinting (`/identify`) |

## Routes

| Method | Route | Purpose | Rate limit |
|--------|-------|---------|------------|
| GET | `/search?q=` | Proxy to iTunes search, returns `{ count, songs[] }` | — |
| GET | `/chords?title=&artist=` | Supabase cache lookup only — fast, no generation | — |
| POST | `/chords` `{ title, artist, force? }` | Generate & cache; `force:true` bypasses cache and overwrites | 50/day/IP |
| PUT | `/chords` `{ title, artist, sections, musicalKey, tempo, capo }` | Save user correction, marks `verified:true` | — |
| POST | `/identify` `{ audioBase64, mimeType }` | AudD fingerprint → chord chart | 50/day/IP |
| POST | `/transcribe` `{ audioBase64, mimeType }` | Whisper transcription (any language) → `{ transcript, language }` | 50/day/IP |

## Rate limiting

`rateLimit(route, max)` middleware is a tiny in-memory daily counter per IP per route, protecting the OpenAI / AudD / Whisper budgets from a runaway client. Returns HTTP 429 with a readable retry-in-N-hours message when exceeded. State resets on server restart (deploys naturally restart Railway). Swap for Redis if/when we scale horizontally.

`app.set("trust proxy", true)` is set so `req.ip` reads the real client from Railway's `X-Forwarded-For`.

## Chord chart pipeline

Every entry point that needs a chart calls `fetchChartFromSources(title, artist, releaseDate)`, which tries sources in order and stops at the first success:

```
1. Ultimate-Guitar  (fetchChartFromUG)
2. Cifra Club       (fetchChartFromCifra)
3. e-chords         (fetchChartFromEchords)
4. AI fallback      (generateChartWithAI)
     └─ lyrics:  lrclib /get → lrclib /search → lyrics.ovh
     └─ key/bpm: Spotify audio-analysis
```

The Supabase cache is checked **before** this cascade in `POST /chords` (unless `force:true`) and in `POST /identify`. `GET /chords` only hits the cache.

## ChordPro inline format

All three scrapers and the AI produce the same intermediate format before any JSON is built:

```
[Verse 1]
[G]Hello dar[Am]ling, the [C]days drift [G]by
[Em]Time keeps [C]turning, [G]you and [D]I
```

`parseChordPro(text)` converts this to the wire format:
```js
{ label: "Verse 1", lines: [
  { lyrics: "Hello darling, the days drift by",
    chords: [{ chord: "G", position: 0 }, { chord: "Am", position: 10 }, ...] }
]}
```

`position` is the character index in `lyrics` where the chord sounds. The LLM inserts `[Chord]` tags; the server counts positions. This removes character counting from the LLM's job, which was the main source of misaligned chords.

After parsing, every chart passes through `validateAndRepairChart()` which clamps out-of-range positions, sorts chords by position, drops empty lines, and coerces all fields to the correct types.

## Scrapers

### Ultimate-Guitar (`fetchChartFromUG`)
- Searches `ultimate-guitar.com/search.php?type=300` (300 = Chords only)
- Page data is in `<div class="js-store" data-content="...">` as JSON — parse `store.page.data.results`
- Picks the highest `rating × log(1 + votes)` chord tab
- Tab content is in `store.page.data.tab_view.wiki_tab.content`; UG format uses `[ch]G[/ch]` → rewritten to `[G]` before passing to `parseChordPro`
- Cloudflare may block — if `js-store` is missing, returns `null` and the next source is tried

### Cifra Club (`fetchChartFromCifra`)
- Direct URL: `cifraclub.com.br/<artist-slug>/<song-slug>/`; falls back to site search
- Chart is in `<pre class="cifra_chord">` with `<b>` tags wrapping chord names
- Portuguese section headers (`Refrão`, `Estrofe`, `Ponte`) are translated to English equivalents
- Key extracted from `"Tom: <key>"` in body text; capo from `"Capotraste na Xª casa"`

### e-chords (`fetchChartFromEchords`)
- Direct URL only: `e-chords.com/chords/<artist-slug>/<song-slug>`
- Chart in `<pre id="core">` with `<u>` tags wrapping chord names
- Key extracted from `"Tone: <key>"` in body text

All scrapers use `slugify()` to build URL slugs (strips accents, lowercases, replaces special chars with hyphens) and `normalizeForLookup()` to strip parenthetical suffixes before slugifying.

`fetchHtml()` is a shared helper that uses a real-browser `User-Agent` header and a short 8 s timeout. Non-2xx below 500 returns `null`; 5xx throws.

## AI generation (`generateChartWithAI`)

Two modes depending on whether verified lyrics were found:

**Mode A — lyrics in hand**: system prompt instructs GPT-4o to copy lyrics word-for-word and place chords inline. The model's only creative job is chord placement.

**Mode B — full recall**: system prompt asks GPT-4o to recall both lyrics and chords from training data.

Both modes enforce:
- **Key constraint**: if Spotify confirmed a key, the prompt states it and requires every chord to be diatonic (or a recognised borrowed chord)
- **Enharmonic constraint**: flat-key songs get "use flats only" instruction; sharp-key songs get "use sharps only" — prevents `Db` vs `C#` mixing within a chart
- `temperature: 0.1`, `max_tokens: 4096`, model `gpt-4o`

The model's raw output is stripped of markdown fences then passed to `parseChordPro`. If parsing yields 0 sections the whole request fails with an error (no silent empty chart).

## Supabase schema

Table `chord_charts`:

| Column | Type | Notes |
|--------|------|-------|
| `title` | text | unique with `artist` |
| `artist` | text | |
| `musical_key` | text | e.g. `"D major"` |
| `tempo` | int | BPM |
| `capo` | int | 0 = no capo |
| `sections` | jsonb | array of `{ label, lines[] }` |
| `source` | text | `ultimate_guitar` / `cifraclub` / `echords` / `ai_generated` / `user_corrected` |
| `verified` | bool | `true` = user-corrected, never overwrite with AI |
| `play_count` | int | incremented on every cache hit |

Upsert uses `onConflict: 'title,artist'`. Verified charts are protected — `PUT /chords` always sets `verified: true`; `POST /chords` with `force:true` will overwrite even verified rows (intentional: lets the owner regenerate a bad AI chart).

Table `user_songs` — owned by the mobile app's `lib/songHistory.ts`, not touched by the backend.

## Key utility functions

| Function | Purpose |
|----------|---------|
| `normalizeForLookup(s)` | Strips `(Remastered)`, `[Live]`, `feat.`, `& The Band` etc. before URL/search use |
| `slugify(s)` | URL slug: strip accents, lowercase, replace non-alphanumeric with `-` |
| `parseChordPro(text)` | ChordPro inline → `Section[]` |
| `validateAndRepairChart(chart)` | Clamp positions, sort chords, drop empties, coerce types |
| `fetchChartFromSources(title, artist, releaseDate)` | Orchestrates the UG → Cifra → e-chords → AI cascade |
| `fetchRealLyrics(title, artist)` | lrclib /get → lrclib /search → lyrics.ovh cascade |
| `lookupSpotifyKey(title, artist)` | Returns `{ spotifyKey, spotifyTempo }` via Spotify audio-analysis |
