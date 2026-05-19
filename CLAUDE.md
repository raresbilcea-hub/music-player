# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Two-part project

The repo has two independent runnable pieces:

| Part | Directory | Purpose |
|------|-----------|---------|
| Backend API | `/` (root) | Node.js/Express server, deployed on Railway |
| Mobile app | `MusicPlayer20/` | React Native + Expo (iOS-first) |

---

## Backend (`/server.js`)

### Run locally
```bash
# from repo root
node server.js          # starts on port 3000
```

Requires a `.env` with:
- `OPENAI_API_KEY` — GPT-4o for chord generation
- `SUPABASE_URL` / `SUPABASE_KEY` — chord chart storage and auth
- `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` — key & tempo lookup
- `AUDD_API_KEY` — audio fingerprinting (`/identify`)

### API routes
| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/search?q=` | iTunes song search |
| GET | `/chords?title=&artist=` | Supabase cache lookup only (fast) |
| POST | `/chords` `{ title, artist, force? }` | Generate & save chart; `force:true` bypasses cache |
| PUT | `/chords` | User correction — marks chart `verified:true` |
| POST | `/identify` | Audio fingerprint → AudD → chord chart |

### Chord chart pipeline (POST /chords)
The server tries sources in order, stopping at the first success:
1. **Ultimate-Guitar** — parses `js-store` JSON embedded in HTML; converts `[ch]X[/ch]` → ChordPro
2. **Cifra Club** — parses `<pre class="cifra_chord">` with `<b>` chord tags
3. **e-chords** — parses `<pre id="core">` with `<u>` chord tags
4. **AI fallback** — GPT-4o generates in ChordPro inline format; lyrics fetched first from lrclib → lyrics.ovh, Spotify provides confirmed key/tempo to constrain the model

### ChordPro format (critical to understand)
The server and AI both use ChordPro *inline* format, not character-offset JSON:
```
[Verse 1]
[G]Hello dar[Am]ling, the [C]days drift [G]by
```
`parseChordPro()` in `server.js` converts this to `{ sections: [{ label, lines: [{ lyrics, chords: [{ chord, position }] }] }] }`. Position = character index in the lyrics string. The LLM inserts `[Chord]` tags; the server counts positions — this is the key reliability design: it removes character counting from the LLM's responsibility.

---

## Mobile app (`MusicPlayer20/`)

### Run locally
```bash
cd MusicPlayer20
npm install
npx expo start          # opens Expo dev server
npx expo start --ios    # iOS simulator
```

### Lint
```bash
cd MusicPlayer20
npm run lint            # expo lint (ESLint)
```

No test suite exists yet.

### Environment
Copy `.env.example` → `.env` inside `MusicPlayer20/`. The app reads `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_KEY`.

The backend URL is hardcoded in `app/(tabs)/index.tsx` and `app/(tabs)/song.tsx` as:
```
https://music-player-production-524a.up.railway.app
```

### Routing (Expo Router file-based)
```
app/
  _layout.tsx          — root layout, wraps AuthProvider
  (tabs)/
    _layout.tsx        — bottom tab bar (Home, Songs, Record)
    index.tsx          — Home: iTunes search + recent songs
    song.tsx           — Song history list + chord chart viewer/editor
    record.tsx         — Audio identification + live recording
  login.tsx / register.tsx / profile.tsx
```

`song.tsx` serves double duty: when navigated to without `title`/`artist` params it renders `SongHistoryList`; with params it fetches and displays the chord chart.

### Key components and libraries
- `components/LineView.tsx` — chord row + lyric row renderer. Uses a fixed monospace `CHAR_W` (7.8px iOS / 7.7px Android) so chord pixel positions align with lyric characters. Both rows must use `MONO` (`Courier New` on iOS) at `FSIZE` (13px) or alignment breaks.
- `components/ChordDiagram.tsx` — tappable chord name → fingering diagram modal
- `lib/chordDiagrams.ts` — static fingering data for known chord names
- `lib/freeGate.ts` — freemium gate: one free action per device, then auth wall (`shouldShowGate` / `consumeFreeAction` / `clearGate`)
- `lib/songHistory.ts` — AsyncStorage-backed recently-viewed song list
- `lib/supabase.ts` — Supabase client (auth + chord chart reads/writes)
- `context/auth.tsx` — `AuthProvider` + `useAuth` hook; wraps the whole app in `_layout.tsx`

### Design tokens (apply consistently, do not introduce new colours)
```
BG       #0e0c09   — page background
CREAM    #e8dfc8   — primary text
GOLD     #c9a84c   — accent / interactive elements
GOLD_DIM #8a6f32   — secondary accent
MUTED    #6b6254   — secondary text
BORDER   #2a2318   — borders
RED      #c0392b   — destructive / error
```

### Data model: chord chart
```ts
type ChordChart = {
  title:       string;
  artist:      string;
  musicalKey?: string;       // e.g. "D major", "F# minor"
  tempo?:      number;
  capo?:       number;       // 0 = no capo
  sections:    Section[];
  verified?:   boolean;      // true = user-corrected, never overwrite with AI
  source?:     'ultimate_guitar' | 'cifraclub' | 'echords' | 'ai_generated' | 'user_corrected';
};

type Section = { label: string; lines: Line[] };
type Line    = { lyrics: string; chords: { chord: string; position: number }[] };
```

Supabase table is `chord_charts` with a unique constraint on `(title, artist)`. Upsert uses `onConflict: 'title,artist'`.
