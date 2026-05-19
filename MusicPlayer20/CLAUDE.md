# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This is the **React Native / Expo mobile app** for Music Player 2.0. The backend lives in the parent directory and has its own `CLAUDE.md`.

## Commands

```bash
npm install             # install dependencies
npx expo start          # start dev server — scan QR with Expo Go or open a simulator
npx expo start --ios    # open directly in iOS simulator
npm run lint            # ESLint via expo lint
```

No test suite exists yet.

## Environment

Copy `.env.example` → `.env`:

| Variable | Purpose |
|----------|---------|
| `EXPO_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `EXPO_PUBLIC_SUPABASE_KEY` | Supabase anon key |

The backend API URL is hardcoded in `app/(tabs)/index.tsx` and `app/(tabs)/song.tsx`:
```
https://music-player-production-524a.up.railway.app
```

The Supabase client (`lib/supabase.ts`) uses AsyncStorage for session persistence and sets `detectSessionInUrl: false` (required for React Native).

## Routing (Expo Router, file-based)

```
app/
  _layout.tsx          — root Stack; wraps everything in AuthProvider
                         redirects away from login/register if already signed in
                         never forces login — auth is opt-in via the free gate
  (tabs)/
    _layout.tsx        — bottom tab bar (Home / Lessons / Songs / Record)
                         AuthHeaderButton in header shows username + sign-out or sign-in link
    index.tsx          — Home: iTunes search + recently viewed horizontal carousel
    song.tsx           — dual-purpose: history list (no params) or chord chart viewer/editor (with params)
    record.tsx         — audio identification (AudD) + live recording stub
    explore.tsx        — Lessons tab; all data is mock, no backend yet
  login.tsx            — email/password sign-in
  register.tsx         — email/password sign-up
  profile.tsx          — presented as a modal
```

Navigation between Home and the chord chart uses `router.navigate` (not `router.push`) so the Songs tab gains focus and the back button returns to the history list, not Home.

## Screens in detail

### `app/(tabs)/song.tsx`

The most complex screen. Serves two roles depending on whether `title`/`artist` route params are present:

**No params → `SongHistoryList`**: shows AsyncStorage/Supabase song history with a clear-all button and account row.

**With params → chord chart viewer/editor**. Load state machine:

| State | Meaning |
|-------|---------|
| `loading` | GET `/chords` cache lookup in flight |
| `found` | Chart loaded (from cache or after generation) |
| `notFound` | Not in cache — shows "Generate Chords" button |
| `generating` | POST `/chords` in flight (~15 s) |
| `regenerating` | POST `/chords` with `force:true` in flight |
| `error` | Network or server error — shows retry |

Edit mode (`editing: true`) replaces `LineView` with `EditLineView` (chord pills on a tappable canvas + lyric `TextInput`). Saving calls `PUT /chords` and marks the chart `verified: true` locally. The "Regenerate" button is hidden for verified charts — once a user corrects a chart it is never silently overwritten.

`readJsonOrThrow(res)` is a local helper that reads the response as text first, so if the server returns an HTML error page (502/504) the error message is readable instead of a JSON parse failure.

### `app/(tabs)/record.tsx`

Two modes toggled by the user:

| Mode | Behaviour |
|------|-----------|
| `identify` | Records for 10 s automatically, then POSTs base64 audio to `/identify` |
| `live` | Records until user taps stop, saves locally (upload to Lessons is a stub) |

Uses `expo-audio` (`useAudioRecorder`, `RecordingPresets.HIGH_QUALITY`) and `expo-file-system/legacy` (`readAsStringAsync` with `encoding: 'base64'`). The record button pulses via `Animated.loop` while recording.

### `app/(tabs)/explore.tsx`

Lessons tab — fully mock data (no backend). Videos, lessons, and teacher cards are hardcoded arrays. Replace with real API calls when the backend is ready.

## Components

### `components/LineView.tsx`

Renders one lyric line with chords positioned above it. Both rows use a fixed monospace font so character indices map directly to pixels.

**Critical constants** — changing font or size requires updating these:

| Constant | Value | Meaning |
|----------|-------|---------|
| `MONO` | `'Courier New'` (iOS) / `'monospace'` (Android) | Font family for both rows |
| `FSIZE` | `13` | Font size in px |
| `CHAR_W` | `7.8` (iOS) / `7.7` (Android) | Pixel width of one character |

Chord `position` × `CHAR_W` = left offset in pixels. If these drift out of sync, chords misalign above their syllables.

Exports used by `song.tsx`:
- `buildChordLine(chords, lyrics)` — builds the chord row string
- `buildDisplayLyric(chords, lyrics)` — pads lyrics to match chord row width
- `chordExtent(chords)` — rightmost pixel extent of all chords (for canvas sizing in edit mode)

### `components/ChordDiagram.tsx`

Two exports:
- `ChordDiagramModal` — full-screen modal shown when a chord name is tapped in `song.tsx`
- `ChordPreview` — inline diagram without a modal, shown live in the chord-edit modal as the user types

Both delegate to `lookupChord(name)` from `lib/chordDiagrams.ts`. If the chord isn't in the library they show a "not in library yet" placeholder — no error thrown.

Diagram layout constants: `SG=30` (string gap), `FH=36` (fret height), `FR=4` (frets shown), `DOT_R=10` (dot radius).

### `components/FreeGateModal.tsx`

Bottom sheet modal shown when an unauthenticated user attempts a second free action. Uses `router.replace('/register')` and `router.replace('/login')` — `replace` so the back button doesn't return to the gate. The modal has no dismiss/close button — the user must sign up or log in. Controlled by the `visible` prop from the parent screen.

## Libraries

### `lib/freeGate.ts`

Freemium gate — one free action per device, then auth wall.

| Function | Purpose |
|----------|---------|
| `shouldShowGate()` | Returns `true` if free action was consumed AND no session exists |
| `consumeFreeAction()` | Writes `'true'` to AsyncStorage key `@mp_free_used` |
| `clearGate()` | Removes the key — called on sign-in and sign-up |

Call `shouldShowGate()` before starting any gated action; call `consumeFreeAction()` after it completes successfully.

### `lib/songHistory.ts`

Local-first + cloud-sync song history. Always writes to AsyncStorage immediately (offline-safe), then fires-and-forgets to Supabase when a session exists. Reads prefer cloud when signed in, fall back to local.

| Function | Purpose |
|----------|---------|
| `addToHistory(song)` | Upserts by title+artist, prepends to list, caps at 100 |
| `getHistory()` | Cloud if signed in (Supabase `user_songs`), else local |
| `clearHistory()` | Clears both local and cloud |
| `addToVerified(song)` | Local-only record of what *this device* has corrected |
| `getVerified()` | Returns local verified list |

Supabase table: `user_songs`, unique on `(user_id, title, artist)`.

### `lib/chordDiagrams.ts`

Static fingering data. `lookupChord(name)` returns a `ChordShape`:
```ts
type ChordShape = {
  positions: number[];  // 6 entries, one per string (low E → high e)
                        // -1 = muted, 0 = open, N = fret number
  baseFret?: number;    // starting fret for high-position chords
};
```

`getAllChordNames()` returns all known chord names — used by `song.tsx` to power the suggestion pills in the chord-edit modal.

### `context/auth.tsx`

`AuthProvider` wraps the entire app. `useAuth()` returns `{ session, user, loading, signIn, signUp, signOut }`. Both `signIn` and `signUp` call `clearGate()` on success so the freemium wall never reappears after authentication.

## Data model: chord chart

```ts
type ChordChart = {
  title:       string;
  artist:      string;
  musicalKey?: string;    // e.g. "D major", "F# minor"
  tempo?:      number;
  capo?:       number;    // 0 = no capo
  sections:    Section[];
  verified?:   boolean;   // true = user-corrected; never overwrite with AI
  source?:     'ultimate_guitar' | 'cifraclub' | 'echords' | 'ai_generated' | 'user_corrected';
};
type Section = { label: string; lines: Line[] };
type Line    = { lyrics: string; chords: Chord[] };
type Chord   = { chord: string; position: number };  // position = char index in lyrics
```

## Design tokens — use these, do not introduce new colours

```
BG       #0e0c09   page background
CREAM    #e8dfc8   primary text
GOLD     #c9a84c   accent / interactive elements
GOLD_DIM #8a6f32   secondary accent / muted interactive
MUTED    #6b6254   secondary text
BORDER   #2a2318   borders / dividers
RED      #c0392b   destructive / error / live-recording indicator
```

Each screen re-declares these as local constants — there is no shared theme file. Keep them consistent when adding new screens.
