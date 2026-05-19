# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install             # install dependencies
npx expo start          # start Expo dev server (scan QR with Expo Go or open simulator)
npx expo start --ios    # open directly in iOS simulator
npm run lint            # ESLint via expo lint
```

No test suite exists yet.

## Environment

Copy `.env.example` → `.env`:
- `EXPO_PUBLIC_SUPABASE_URL`
- `EXPO_PUBLIC_SUPABASE_KEY`

The backend URL is hardcoded in `app/(tabs)/index.tsx` and `app/(tabs)/song.tsx`:
```
https://music-player-production-524a.up.railway.app
```

## Architecture

### Routing (Expo Router, file-based)

```
app/
  _layout.tsx          — root Stack; wraps everything in AuthProvider; redirects away
                         from login/register when already signed in (never forces login)
  (tabs)/
    _layout.tsx        — bottom tab bar: Home / Lessons / Songs / Record
    index.tsx          — song search (iTunes) + recently viewed carousel
    song.tsx           — dual-purpose: history list (no params) OR chord chart (with params)
    record.tsx         — audio identification + live recording
    explore.tsx        — Lessons tab (placeholder)
  login.tsx / register.tsx
  profile.tsx          — presented as a modal
```

`song.tsx` is the most complex screen. It handles: fetching from cache, generating, regenerating (force:true), inline chord editing, and saving user corrections. State machine: `'loading' | 'found' | 'notFound' | 'generating' | 'regenerating' | 'error'`.

### Chord chart data model

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
type Line    = { lyrics: string; chords: { chord: string; position: number }[] };
```

`position` is a **character index** in the lyrics string. The monospace renderer maps it directly to pixels using `CHAR_W`.

### Key components

**`components/LineView.tsx`** — chord row + lyric row renderer. Critical constraints:
- Both rows must use `MONO` (`'Courier New'` on iOS, `'monospace'` on Android) at `FSIZE` (13px).
- `CHAR_W` (7.8px iOS / 7.7px Android) is the pixel width of one character. Chord `position` × `CHAR_W` = pixel offset. If you change the font or size, update `CHAR_W` to match.
- Exports `buildChordLine`, `buildDisplayLyric`, `chordExtent` — used by `song.tsx` edit mode (`EditLineView`).

**`components/ChordDiagram.tsx`** — modal showing guitar fingering diagram when a chord name is tapped. Chord data lives in `lib/chordDiagrams.ts`.

**`components/FreeGateModal.tsx`** — shown when a guest tries a second free action. Prompts sign-up.

### State and persistence

| Concern | Where |
|---------|-------|
| Auth session | `context/auth.tsx` (`useAuth`) — Supabase auth, session persisted by the Supabase client |
| Song history | `lib/songHistory.ts` — AsyncStorage (always) + Supabase `user_songs` table (when signed in) |
| Freemium gate | `lib/freeGate.ts` — AsyncStorage key `@mp_free_used`; cleared on sign-in |
| Verified corrections | `lib/songHistory.ts` `addToVerified` — AsyncStorage only, local record of what this user corrected |

Song history uses a **local-first + cloud-sync** pattern: writes always hit AsyncStorage immediately (offline-safe), then fire-and-forget to Supabase when a session exists. Reads prefer cloud when signed in, fall back to local.

### Design tokens — use these, do not introduce new colours

```
BG       #0e0c09   page background
CREAM    #e8dfc8   primary text
GOLD     #c9a84c   accent / interactive
GOLD_DIM #8a6f32   secondary accent / muted interactive
MUTED    #6b6254   secondary text
BORDER   #2a2318   borders / dividers
RED      #c0392b   destructive / error / live-recording indicator
```

### Auth flow

The app is intentionally permissive — guests get one free action (search or record), then `FreeGateModal` prompts sign-up. Auth is **never forced** by the router; `_layout.tsx` only redirects *away* from login/register when a session already exists. Signing in or up calls `clearGate()` so the freemium wall never appears again.
