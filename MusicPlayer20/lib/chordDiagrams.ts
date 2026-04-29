// Guitar chord shapes for the chord library.
// positions: [E2, A2, D3, G3, B3, e4] — low string to high string
// -1 = muted   0 = open   n = fret n
// baseFret: which fret the diagram starts on (default 1)

export type ChordShape = {
  positions: number[];
  baseFret?:  number;
};

const CHORDS: Record<string, ChordShape> = {

  // ── Major ────────────────────────────────────────────────────────────────
  'C':  { positions: [-1, 3, 2, 0, 1, 0] },
  'D':  { positions: [-1, -1, 0, 2, 3, 2] },
  'E':  { positions: [0, 2, 2, 1, 0, 0] },
  'F':  { positions: [1, 3, 3, 2, 1, 1] },
  'G':  { positions: [3, 2, 0, 0, 3, 3] },
  'A':  { positions: [-1, 0, 2, 2, 2, 0] },
  'B':  { positions: [-1, 2, 4, 4, 4, 2] },
  'Bb': { positions: [-1, 1, 3, 3, 3, 1] },
  'Eb': { positions: [-1, -1, 1, 3, 4, 3] },
  'Ab': { positions: [4, 6, 6, 5, 4, 4], baseFret: 4 },

  // ── Minor ────────────────────────────────────────────────────────────────
  'Am': { positions: [-1, 0, 2, 2, 1, 0] },
  'Bm': { positions: [-1, 2, 4, 4, 3, 2] },
  'Cm': { positions: [-1, 3, 5, 5, 4, 3], baseFret: 3 },
  'Dm': { positions: [-1, -1, 0, 2, 3, 1] },
  'Em': { positions: [0, 2, 2, 0, 0, 0] },
  'Fm': { positions: [1, 3, 3, 1, 1, 1] },
  'Gm': { positions: [3, 5, 5, 3, 3, 3], baseFret: 3 },
  'Bbm':{ positions: [-1, 1, 3, 3, 2, 1] },
  'F#m':{ positions: [2, 4, 4, 2, 2, 2] },
  'C#m':{ positions: [-1, 4, 6, 6, 5, 4], baseFret: 4 },

  // ── Dominant 7th ─────────────────────────────────────────────────────────
  'A7':  { positions: [-1, 0, 2, 0, 2, 0] },
  'B7':  { positions: [-1, 2, 1, 2, 0, 2] },
  'C7':  { positions: [-1, 3, 2, 3, 1, 0] },
  'D7':  { positions: [-1, -1, 0, 2, 1, 2] },
  'E7':  { positions: [0, 2, 0, 1, 0, 0] },
  'F7':  { positions: [1, 1, 2, 1, 1, 1] },
  'G7':  { positions: [3, 2, 0, 0, 0, 1] },

  // ── Minor 7th ────────────────────────────────────────────────────────────
  'Am7': { positions: [-1, 0, 2, 0, 1, 0] },
  'Bm7': { positions: [-1, 2, 0, 2, 0, 2] },
  'Dm7': { positions: [-1, -1, 0, 2, 1, 1] },
  'Em7': { positions: [0, 2, 0, 0, 0, 0] },
  'Fm7': { positions: [1, 1, 1, 1, 1, 1] },
  'Gm7': { positions: [3, 5, 3, 3, 3, 3], baseFret: 3 },
  'Cm7': { positions: [-1, 3, 5, 3, 4, 3], baseFret: 3 },

  // ── Major 7th ────────────────────────────────────────────────────────────
  'Amaj7': { positions: [-1, 0, 2, 1, 2, 0] },
  'Cmaj7': { positions: [-1, 3, 2, 0, 0, 0] },
  'Dmaj7': { positions: [-1, -1, 0, 2, 2, 2] },
  'Emaj7': { positions: [0, 2, 1, 1, 0, 0] },
  'Fmaj7': { positions: [-1, -1, 3, 2, 1, 0] },
  'Gmaj7': { positions: [3, 2, 0, 0, 0, 2] },

  // ── Suspended ────────────────────────────────────────────────────────────
  'Asus2': { positions: [-1, 0, 2, 2, 0, 0] },
  'Asus4': { positions: [-1, 0, 2, 2, 3, 0] },
  'Dsus2': { positions: [-1, -1, 0, 2, 3, 0] },
  'Dsus4': { positions: [-1, -1, 0, 2, 3, 3] },
  'Esus4': { positions: [0, 2, 2, 2, 0, 0] },
  'Gsus4': { positions: [3, 3, 0, 0, 1, 1] },

  // ── Add ──────────────────────────────────────────────────────────────────
  'Cadd9': { positions: [-1, 3, 2, 0, 3, 0] },
  'Dadd9': { positions: [-1, -1, 0, 2, 3, 0] },
  'Gadd9': { positions: [3, 2, 0, 2, 3, 3] },
  'Eadd9': { positions: [0, 2, 2, 1, 0, 2] },

  // ── Diminished ───────────────────────────────────────────────────────────
  'Bdim': { positions: [-1, 2, 3, 4, 3, -1] },
  'Adim': { positions: [-1, 0, 1, 2, 1, -1] },
  'Edim': { positions: [0, 1, 2, 3, 2, -1] },

  // ── Augmented ────────────────────────────────────────────────────────────
  'Caug': { positions: [-1, 3, 2, 1, 1, 0] },
  'Eaug': { positions: [0, 3, 2, 1, 1, 0] },
  'Aaug': { positions: [-1, 0, 3, 2, 2, 1] },

  // ── Power chords ─────────────────────────────────────────────────────────
  'E5': { positions: [0, 2, 2, -1, -1, -1] },
  'A5': { positions: [-1, 0, 2, 2, -1, -1] },
  'D5': { positions: [-1, -1, 0, 2, 3, -1] },
  'G5': { positions: [3, 5, 5, -1, -1, -1] },
};

// ── Lookup ────────────────────────────────────────────────────────────────────
// Tries exact match, then strips bass note (e.g. "G/B" → "G"), then gives up.
export function lookupChord(name: string): ChordShape | null {
  if (!name) return null;

  // Exact match
  if (CHORDS[name]) return CHORDS[name];

  // Strip slash-bass note (G/B → G)
  const slashBase = name.split('/')[0];
  if (CHORDS[slashBase]) return CHORDS[slashBase];

  // Normalize flat symbol (♭ → b)  and sharp (♯ → #)
  const norm = name.replace('♭', 'b').replace('♯', '#').split('/')[0];
  if (CHORDS[norm]) return CHORDS[norm];

  return null;
}
