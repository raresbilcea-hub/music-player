import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState, useEffect, useCallback } from 'react';

// ─── Design tokens ────────────────────────────────────────────────────────────

const MONO     = Platform.OS === 'ios' ? 'Courier New' : 'monospace';
const GOLD     = '#c9a84c';
const GOLD_DIM = '#8a6f32';
const BG       = '#0e0c09';
const CREAM    = '#e8dfc8';
const MUTED    = '#6b6254';
const BORDER   = '#2a2318';
const RED      = '#c0392b';

const API = 'https://music-player-production-524a.up.railway.app';

// ─── Types ────────────────────────────────────────────────────────────────────

type Chord = { chord: string; position: number };
type Line  = { lyrics: string; chords?: Chord[] };
type Section = { label: string; lines?: Line[] };
type ChordChart = {
  title: string;
  artist: string;
  musicalKey?: string;
  tempo?: number | string;
  capo?: number | string;
  sections: Section[];
};
type LoadState = 'loading' | 'found' | 'notFound' | 'generating' | 'error';

// ─── buildChordLine ───────────────────────────────────────────────────────────

function buildChordLine(chords: Chord[], lyrics: string): string {
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

// ─── Pill ─────────────────────────────────────────────────────────────────────

function Pill({ label, value }: { label: string; value: string }) {
  return (
    <View style={ps.wrap}>
      <Text style={ps.label}>{label}</Text>
      <Text style={ps.value}>{value}</Text>
    </View>
  );
}

const ps = StyleSheet.create({
  wrap: {
    backgroundColor: '#191610',
    borderWidth: 1,
    borderColor: '#2e2618',
    borderRadius: 4,
    paddingHorizontal: 14,
    paddingVertical: 8,
    alignItems: 'center',
    minWidth: 64,
  },
  label: { color: GOLD_DIM, fontSize: 8,  letterSpacing: 2, marginBottom: 4 },
  value: { color: CREAM,    fontSize: 14, fontWeight: '600' },
});

// ─── SongScreen ───────────────────────────────────────────────────────────────

export default function SongScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const title    = String(params.title    ?? '');
  const artist   = String(params.artist   ?? '');
  const album    = String(params.album    ?? '');
  const year     = String(params.year     ?? '');
  const genre    = String(params.genre    ?? '');
  const duration = String(params.duration ?? '');

  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [chart, setChart]         = useState<ChordChart | null>(null);
  const [errorMsg, setErrorMsg]   = useState('');

  const fetchChords = useCallback(async () => {
    setLoadState('loading');
    setErrorMsg('');
    try {
      const res = await fetch(
        `${API}/chords?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`
      );
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (data.found) {
        setChart(data.chart);
        setLoadState('found');
      } else {
        setLoadState('notFound');
      }
    } catch (e: any) {
      setErrorMsg(e.message);
      setLoadState('error');
    }
  }, [title, artist]);

  useEffect(() => {
    if (title && artist) fetchChords();
  }, [fetchChords]);

  async function generateChords() {
    setLoadState('generating');
    setErrorMsg('');
    try {
      const res = await fetch(`${API}/chords`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, artist }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setChart(data.chart);
      setLoadState('found');
    } catch (e: any) {
      setErrorMsg(e.message);
      setLoadState('error');
    }
  }

  return (
    <ScrollView
      style={s.container}
      contentContainerStyle={s.content}
      showsVerticalScrollIndicator={false}
    >
      {/* Back */}
      <TouchableOpacity style={s.backBtn} onPress={() => router.back()}>
        <Text style={s.backText}>← Back</Text>
      </TouchableOpacity>

      {/* Song header */}
      <View style={s.header}>
        <Text style={s.songTitle}>{title}</Text>
        <Text style={s.songArtist}>{artist}</Text>
        {album ? <Text style={s.songAlbum}>{album}</Text> : null}
      </View>

      {/* Meta row */}
      {(year || genre || duration) ? (
        <View style={s.metaRow}>
          {year     ? <View style={s.metaItem}><Text style={s.metaLabel}>YEAR</Text><Text style={s.metaValue}>{year}</Text></View>     : null}
          {genre    ? <View style={s.metaItem}><Text style={s.metaLabel}>GENRE</Text><Text style={s.metaValue}>{genre}</Text></View>    : null}
          {duration ? <View style={s.metaItem}><Text style={s.metaLabel}>DURATION</Text><Text style={s.metaValue}>{duration}</Text></View> : null}
        </View>
      ) : null}

      <View style={s.divider} />

      {/* ── Loading ── */}
      {loadState === 'loading' && (
        <View style={s.centeredState}>
          <ActivityIndicator color={GOLD} size="large" />
          <Text style={s.centeredText}>Loading chords...</Text>
        </View>
      )}

      {/* ── Generating ── */}
      {loadState === 'generating' && (
        <View style={s.centeredState}>
          <ActivityIndicator color={GOLD} size="large" />
          <Text style={s.centeredText}>Generating chord chart...</Text>
          <Text style={s.centeredSub}>Analysing key, chords & lyrics — about 15 seconds</Text>
        </View>
      )}

      {/* ── Error ── */}
      {loadState === 'error' && (
        <View style={s.centeredState}>
          <Text style={s.errorText}>{errorMsg}</Text>
          <TouchableOpacity style={s.retryBtn} onPress={fetchChords}>
            <Text style={s.retryBtnText}>TRY AGAIN</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Not found ── */}
      {loadState === 'notFound' && (
        <View style={s.notFoundState}>
          <Text style={s.notFoundSymbol}>♩</Text>
          <Text style={s.notFoundTitle}>No chord chart yet</Text>
          <Text style={s.notFoundSub}>
            Generate a complete chord chart for this song using AI — includes every verse, chorus, and bridge.
          </Text>
          <TouchableOpacity style={s.generateBtn} onPress={generateChords} activeOpacity={0.85}>
            <Text style={s.generateBtnText}>GENERATE CHORDS</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Chord chart ── */}
      {loadState === 'found' && chart && (
        <View style={s.chartWrap}>

          {/* Key / BPM / Capo pills */}
          <View style={s.pillRow}>
            {chart.musicalKey ? <Pill label="KEY"  value={chart.musicalKey} /> : null}
            {chart.tempo      ? <Pill label="BPM"  value={String(chart.tempo)} /> : null}
            {chart.capo != null
              ? <Pill label="CAPO" value={chart.capo === 0 ? 'None' : `Fret ${chart.capo}`} />
              : null}
          </View>

          {/* Sections */}
          {(chart.sections ?? []).map((section, si) => (
            <View key={si} style={s.section}>

              {/* Label + extending gold rule */}
              <View style={s.sectionHeaderRow}>
                <Text style={s.sectionLabel}>{(section.label ?? '').toUpperCase()}</Text>
                <View style={s.sectionRule} />
              </View>

              {/* Chord + lyric lines */}
              {(section.lines ?? []).map((line, li) => {
                const hasChords = (line.chords?.length ?? 0) > 0;
                const cl = hasChords ? buildChordLine(line.chords!, line.lyrics ?? '') : null;
                if (!cl && !line.lyrics?.trim()) return null;
                return (
                  <View key={li} style={s.lineBlock}>
                    {cl          ? <Text style={s.chordLine}>{cl}</Text>         : null}
                    {line.lyrics ? <Text style={s.lyricLine}>{line.lyrics}</Text> : null}
                  </View>
                );
              })}
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  content:   { paddingHorizontal: 24, paddingTop: 64, paddingBottom: 60 },

  // Back
  backBtn:  { marginBottom: 28 },
  backText: { color: GOLD, fontSize: 16 },

  // Song header
  header:     { marginBottom: 24 },
  songTitle:  { color: CREAM, fontSize: 32, fontWeight: 'bold', lineHeight: 36, marginBottom: 6 },
  songArtist: { color: GOLD,  fontSize: 18, fontStyle: 'italic', marginBottom: 4 },
  songAlbum:  { color: MUTED, fontSize: 13 },

  // Meta
  metaRow:    { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 24 },
  metaItem:   { flex: 1 },
  metaLabel:  { color: GOLD_DIM, fontSize: 9, letterSpacing: 2, marginBottom: 6 },
  metaValue:  { color: CREAM,    fontSize: 15 },

  divider: { height: 1, backgroundColor: BORDER, marginBottom: 28 },

  // States
  centeredState: { alignItems: 'center', paddingTop: 40, paddingBottom: 20 },
  centeredText:  { color: MUTED,    fontSize: 14, marginTop: 16 },
  centeredSub:   { color: GOLD_DIM, fontSize: 12, marginTop: 8, textAlign: 'center', paddingHorizontal: 20 },

  errorText: { color: RED,  fontSize: 13, textAlign: 'center', marginBottom: 20, paddingHorizontal: 16 },
  retryBtn:  { borderWidth: 1, borderColor: BORDER, paddingHorizontal: 20, paddingVertical: 10 },
  retryBtnText: { color: MUTED, fontSize: 11, letterSpacing: 2 },

  notFoundState:  { alignItems: 'center', paddingTop: 32, paddingBottom: 12 },
  notFoundSymbol: { color: GOLD_DIM, fontSize: 40, marginBottom: 20 },
  notFoundTitle:  { color: CREAM,    fontSize: 20, fontWeight: '600', marginBottom: 10 },
  notFoundSub:    { color: MUTED,    fontSize: 14, textAlign: 'center', lineHeight: 22, marginBottom: 32, paddingHorizontal: 16 },
  generateBtn:    { backgroundColor: GOLD, paddingVertical: 14, paddingHorizontal: 32 },
  generateBtnText:{ color: BG,  fontSize: 11, fontWeight: '700', letterSpacing: 2.5 },

  // Chart
  chartWrap: {},
  pillRow:   { flexDirection: 'row', gap: 8, marginBottom: 28, flexWrap: 'wrap' },

  section:         { marginBottom: 28 },
  sectionHeaderRow:{ flexDirection: 'row', alignItems: 'center', marginBottom: 14 },
  sectionLabel:    { color: GOLD, fontSize: 10, fontWeight: '700', letterSpacing: 3.5 },
  sectionRule:     { flex: 1, height: 1, backgroundColor: GOLD, opacity: 0.2, marginLeft: 12 },

  lineBlock: { marginBottom: 12 },
  chordLine: { color: GOLD,  fontFamily: MONO, fontSize: 13, lineHeight: 18, letterSpacing: 0.1 },
  lyricLine: { color: CREAM, fontFamily: MONO, fontSize: 13, lineHeight: 20 },
});
