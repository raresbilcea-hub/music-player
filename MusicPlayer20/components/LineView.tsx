import { StyleSheet, Text, View, ScrollView, Platform } from 'react-native';

// ─── Shared font metrics ──────────────────────────────────────────────────────
// Both chord and lyric rows must use identical font metrics so position indices
// map 1-to-1 to visual columns in the monospace layout.

export const MONO   = Platform.OS === 'ios' ? 'Courier New' : 'monospace';
export const FSIZE  = 13;
// Logical-pixel width of one character: Courier New / monospace at 13px.
export const CHAR_W = Platform.OS === 'ios' ? 7.8 : 7.7;

// ─── Types ────────────────────────────────────────────────────────────────────

export type Chord = { chord: string; position: number };
export type Line  = { lyrics: string; chords?: Chord[] };

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Builds the chord string: each chord placed at its character-index position.
export function buildChordLine(chords: Chord[], lyrics: string): string {
  if (!chords?.length) return '';
  const sorted = [...chords].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  let out = '';
  for (const c of sorted) {
    const pos = c.position ?? 0;
    while (out.length < pos) out += ' ';
    out += c.chord + ' ';
  }
  return out.trimEnd();
}

// Pads the lyric with trailing spaces so it reaches at least the end of the
// chord line — prevents the chord row from extending beyond the lyric row.
export function buildDisplayLyric(chords: Chord[], lyrics: string): string {
  const cl = buildChordLine(chords, lyrics);
  return cl.length > lyrics.length ? lyrics.padEnd(cl.length, ' ') : lyrics;
}

// Right-most character extent across all chords (position + chord name length).
export function chordExtent(chords: Chord[]): number {
  if (!chords?.length) return 0;
  return Math.max(...chords.map(c => (c.position ?? 0) + (c.chord?.length ?? 1)));
}

// ─── LineView ─────────────────────────────────────────────────────────────────
// Chord row + lyric row in a horizontal ScrollView.
// The inner View has flexShrink:0 so long lines never wrap — they scroll instead.

export function LineView({ line }: { line: Line }) {
  const chords    = line.chords ?? [];
  const hasChords = chords.length > 0;
  const hasLyrics = !!(line.lyrics?.trim());
  if (!hasChords && !hasLyrics) return null;

  const cl           = hasChords ? buildChordLine(chords, line.lyrics ?? '') : '';
  const displayLyric = hasChords
    ? buildDisplayLyric(chords, line.lyrics ?? '')
    : (line.lyrics ?? '');

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      nestedScrollEnabled
      style={lv.scroll}
    >
      {/* flexShrink:0 prevents the View from being squeezed to its parent's width,
          which would cause the Text children to wrap at spaces. */}
      <View style={lv.inner}>
        {hasChords && <Text style={lv.chordLine}>{cl}</Text>}
        <Text style={lv.lyricLine}>{displayLyric}</Text>
      </View>
    </ScrollView>
  );
}

const lv = StyleSheet.create({
  scroll:    { marginBottom: 14 },
  inner:     { flexShrink: 0 },
  chordLine: { color: '#c9a84c', fontFamily: MONO, fontSize: FSIZE, lineHeight: 19, letterSpacing: 0 },
  lyricLine: { color: '#e8dfc8', fontFamily: MONO, fontSize: FSIZE, lineHeight: 20 },
});
