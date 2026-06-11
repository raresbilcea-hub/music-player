// Chart data model + line-layout helpers.
// Types mirror the server's chart shape (server.js validateAndRepairChart).
// Layout helpers ported from the mobile app's LineView.tsx — pure functions,
// identical behavior; rendering positions use CSS `ch` units instead of the
// mobile CHAR_W pixel constant.

export type Chord = { chord: string; position: number };
export type Line = { lyrics: string; chords?: Chord[] };
export type Section = { label: string; lines: Line[] };

export type ChordChart = {
  title: string;
  artist: string;
  musicalKey: string | null;
  tempo: number | null;
  capo: number;
  sections: Section[];
  verified?: boolean;
  source?: string;
};

export type SongInfo = {
  title: string;
  artist: string;
  album?: string;
  release_date?: string;
  artwork?: string;
};

export function buildChordLine(chords: Chord[], lyrics: string): string {
  if (!chords?.length) return "";
  const sorted = [...chords].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  let out = "";
  for (const c of sorted) {
    const pos = c.position ?? 0;
    while (out.length < pos) out += " ";
    out += c.chord + " ";
  }
  return out.trimEnd();
}

export function buildDisplayLyric(chords: Chord[], lyrics: string): string {
  const cl = buildChordLine(chords, lyrics);
  return cl.length > lyrics.length ? lyrics.padEnd(cl.length, " ") : lyrics;
}

export function chordExtent(chords: Chord[]): number {
  if (!chords?.length) return 0;
  return Math.max(...chords.map((c) => (c.position ?? 0) + (c.chord?.length ?? 1)));
}

export function sortedChords(chords: Chord[] | undefined): Chord[] {
  return [...(chords ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}
