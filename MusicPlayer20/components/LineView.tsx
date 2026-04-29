import { StyleSheet, Text, View, ScrollView, TouchableOpacity, Platform } from 'react-native';

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

export function buildDisplayLyric(chords: Chord[], lyrics: string): string {
  const cl = buildChordLine(chords, lyrics);
  return cl.length > lyrics.length ? lyrics.padEnd(cl.length, ' ') : lyrics;
}

export function chordExtent(chords: Chord[]): number {
  if (!chords?.length) return 0;
  return Math.max(...chords.map(c => (c.position ?? 0) + (c.chord?.length ?? 1)));
}

// ─── LineView ─────────────────────────────────────────────────────────────────
// Chord row + lyric row in a horizontal ScrollView.
// Pass onChordPress to make each chord name tappable (e.g. to show a diagram).

export function LineView({
  line,
  onChordPress,
}: {
  line:          Line;
  onChordPress?: (chord: string) => void;
}) {
  const chords    = line.chords ?? [];
  const hasChords = chords.length > 0;
  const hasLyrics = !!(line.lyrics?.trim());
  if (!hasChords && !hasLyrics) return null;

  const cl           = hasChords ? buildChordLine(chords, line.lyrics ?? '') : '';
  const displayLyric = hasChords
    ? buildDisplayLyric(chords, line.lyrics ?? '')
    : (line.lyrics ?? '');

  // Width of the content area so all chords and lyrics fit without wrapping
  const contentW = Math.max(cl.length, displayLyric.length) * CHAR_W + 8;

  const sorted = [...chords].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      nestedScrollEnabled
      style={lv.scroll}
    >
      {/* flexShrink:0 prevents squeezing to parent width, which would cause wrapping */}
      <View style={[lv.inner, { minWidth: contentW }]}>

        {/* Chord row — each chord is an individually tappable cell */}
        {hasChords && (
          <View style={[lv.chordRow, { height: 19 }]}>
            {sorted.map((c, i) => {
              const left = (c.position ?? 0) * CHAR_W;
              return (
                <TouchableOpacity
                  key={i}
                  style={{ position: 'absolute', left }}
                  onPress={onChordPress ? () => onChordPress(c.chord) : undefined}
                  hitSlop={{ top: 4, bottom: 4, left: 2, right: 2 }}
                  activeOpacity={onChordPress ? 0.6 : 1}
                  disabled={!onChordPress}
                >
                  <Text style={onChordPress ? lv.chordTap : lv.chordStatic}>
                    {c.chord}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        <Text style={lv.lyricLine}>{displayLyric}</Text>
      </View>
    </ScrollView>
  );
}

const lv = StyleSheet.create({
  scroll:      { marginBottom: 14 },
  inner:       { flexShrink: 0 },
  chordRow:    { position: 'relative', marginBottom: 0 },
  chordStatic: { color: '#c9a84c', fontFamily: MONO, fontSize: FSIZE, lineHeight: 19, letterSpacing: 0 },
  chordTap:    { color: '#c9a84c', fontFamily: MONO, fontSize: FSIZE, lineHeight: 19, letterSpacing: 0, textDecorationLine: 'underline', textDecorationColor: '#8a6f32', textDecorationStyle: 'dotted' },
  lyricLine:   { color: '#e8dfc8', fontFamily: MONO, fontSize: FSIZE, lineHeight: 20 },
});
