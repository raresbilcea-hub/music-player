import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  TextInput,
  Modal,
  Platform,
  KeyboardAvoidingView,
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

type Chord      = { chord: string; position: number };
type Line       = { lyrics: string; chords?: Chord[] };
type Section    = { label: string; lines?: Line[] };
type ChordChart = {
  title:       string;
  artist:      string;
  musicalKey?: string;
  tempo?:      number | string;
  capo?:       number | string;
  sections:    Section[];
  verified?:   boolean;
};
type LoadState  = 'loading' | 'found' | 'notFound' | 'generating' | 'error';

// Active chord being edited — opens the inline modal
type ActiveChord = { si: number; li: number; ci: number; value: string };

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function clone<T>(x: T): T { return JSON.parse(JSON.stringify(x)); }

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
  wrap:  { backgroundColor: '#191610', borderWidth: 1, borderColor: '#2e2618', borderRadius: 4, paddingHorizontal: 14, paddingVertical: 8, alignItems: 'center', minWidth: 64 },
  label: { color: GOLD_DIM, fontSize: 8,  letterSpacing: 2, marginBottom: 4 },
  value: { color: CREAM,    fontSize: 14, fontWeight: '600' },
});

// ─── SongScreen ───────────────────────────────────────────────────────────────

export default function SongScreen() {
  const router = useRouter();
  const params   = useLocalSearchParams();
  const title    = String(params.title    ?? '');
  const artist   = String(params.artist   ?? '');
  const album    = String(params.album    ?? '');
  const year     = String(params.year     ?? '');
  const genre    = String(params.genre    ?? '');
  const duration = String(params.duration ?? '');

  // ── Load state ──
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [chart,     setChart]     = useState<ChordChart | null>(null);
  const [errorMsg,  setErrorMsg]  = useState('');

  // ── Edit state ──
  const [editing,     setEditing]     = useState(false);
  const [draft,       setDraft]       = useState<ChordChart | null>(null);
  const [saving,      setSaving]      = useState(false);
  const [saveError,   setSaveError]   = useState('');
  const [activeChord, setActiveChord] = useState<ActiveChord | null>(null);

  // ─────────────────────────────────────────────────────────────────────────────

  const fetchChords = useCallback(async () => {
    setLoadState('loading');
    setErrorMsg('');
    try {
      const res  = await fetch(`${API}/chords?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (data.found) { setChart(data.chart); setLoadState('found'); }
      else              setLoadState('notFound');
    } catch (e: any) { setErrorMsg(e.message); setLoadState('error'); }
  }, [title, artist]);

  useEffect(() => { if (title && artist) fetchChords(); }, [fetchChords]);

  async function generateChords() {
    setLoadState('generating');
    setErrorMsg('');
    try {
      const res  = await fetch(`${API}/chords`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ title, artist }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setChart(data.chart);
      setLoadState('found');
    } catch (e: any) { setErrorMsg(e.message); setLoadState('error'); }
  }

  // ── Edit helpers ──

  function startEdit() {
    if (!chart) return;
    setDraft(clone(chart));
    setSaveError('');
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setDraft(null);
    setActiveChord(null);
    setSaveError('');
  }

  async function saveAndVerify() {
    if (!draft) return;
    setSaving(true);
    setSaveError('');
    try {
      const res  = await fetch(`${API}/chords`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          title,
          artist,
          sections:   draft.sections,
          musicalKey: draft.musicalKey,
          tempo:      draft.tempo,
          capo:       draft.capo,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setChart({ ...draft, verified: true });
      setEditing(false);
      setDraft(null);
      setActiveChord(null);
    } catch (e: any) {
      setSaveError(e.message);
    } finally {
      setSaving(false);
    }
  }

  // Draft mutators
  function setChordValue(si: number, li: number, ci: number, val: string) {
    if (!draft) return;
    const next = clone(draft);
    next.sections[si].lines![li].chords![ci].chord = val;
    setDraft(next);
  }

  function setLyricValue(si: number, li: number, val: string) {
    if (!draft) return;
    const next = clone(draft);
    next.sections[si].lines![li].lyrics = val;
    setDraft(next);
  }

  function deleteChord(si: number, li: number, ci: number) {
    if (!draft) return;
    const next = clone(draft);
    next.sections[si].lines![li].chords!.splice(ci, 1);
    setDraft(next);
  }

  function addChordToLine(si: number, li: number) {
    if (!draft) return;
    const next   = clone(draft);
    const line   = next.sections[si].lines![li];
    const chords = line.chords ?? [];
    const lastPos = chords.length > 0 ? (chords[chords.length - 1].position ?? 0) + 4 : 0;
    chords.push({ chord: 'C', position: lastPos });
    line.chords = chords;
    setDraft(next);
  }

  // ─────────────────────────────────────────────────────────────────────────────

  const display = editing ? draft : chart;

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: BG }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>

      {/* ── Chord-edit modal ── */}
      <Modal transparent visible={!!activeChord} animationType="fade" onRequestClose={() => setActiveChord(null)}>
        <TouchableOpacity style={m.overlay} activeOpacity={1} onPress={() => setActiveChord(null)}>
          <View style={m.box}>
            <Text style={m.label}>EDIT CHORD</Text>
            <TextInput
              style={m.input}
              value={activeChord?.value ?? ''}
              onChangeText={v => setActiveChord(ac => ac ? { ...ac, value: v } : null)}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              selectTextOnFocus
              placeholderTextColor={MUTED}
            />
            <View style={m.row}>
              <TouchableOpacity style={m.deleteBtn} onPress={() => {
                if (!activeChord) return;
                deleteChord(activeChord.si, activeChord.li, activeChord.ci);
                setActiveChord(null);
              }}>
                <Text style={m.deleteTxt}>DELETE</Text>
              </TouchableOpacity>
              <TouchableOpacity style={m.applyBtn} onPress={() => {
                if (!activeChord) return;
                setChordValue(activeChord.si, activeChord.li, activeChord.ci, activeChord.value);
                setActiveChord(null);
              }}>
                <Text style={m.applyTxt}>APPLY</Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      <ScrollView style={s.container} contentContainerStyle={s.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

        {/* Back */}
        {!editing && (
          <TouchableOpacity style={s.backBtn} onPress={() => router.back()}>
            <Text style={s.backText}>← Back</Text>
          </TouchableOpacity>
        )}

        {/* Header */}
        <View style={s.header}>
          <Text style={s.songTitle}>{title}</Text>
          <Text style={s.songArtist}>{artist}</Text>
          {album ? <Text style={s.songAlbum}>{album}</Text> : null}
        </View>

        {/* Meta */}
        {!editing && (year || genre || duration) ? (
          <View style={s.metaRow}>
            {year     ? <View style={s.metaItem}><Text style={s.metaLabel}>YEAR</Text><Text style={s.metaValue}>{year}</Text></View>     : null}
            {genre    ? <View style={s.metaItem}><Text style={s.metaLabel}>GENRE</Text><Text style={s.metaValue}>{genre}</Text></View>    : null}
            {duration ? <View style={s.metaItem}><Text style={s.metaLabel}>DURATION</Text><Text style={s.metaValue}>{duration}</Text></View> : null}
          </View>
        ) : null}

        <View style={s.divider} />

        {/* Loading */}
        {loadState === 'loading' && (
          <View style={s.centered}>
            <ActivityIndicator color={GOLD} size="large" />
            <Text style={s.centeredTxt}>Loading chords...</Text>
          </View>
        )}

        {/* Generating */}
        {loadState === 'generating' && (
          <View style={s.centered}>
            <ActivityIndicator color={GOLD} size="large" />
            <Text style={s.centeredTxt}>Generating chord chart...</Text>
            <Text style={s.centeredSub}>Analysing key, chords & lyrics — about 15 seconds</Text>
          </View>
        )}

        {/* Error */}
        {loadState === 'error' && (
          <View style={s.centered}>
            <Text style={s.errorTxt}>{errorMsg}</Text>
            <TouchableOpacity style={s.retryBtn} onPress={fetchChords}>
              <Text style={s.retryTxt}>TRY AGAIN</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Not found */}
        {loadState === 'notFound' && (
          <View style={s.notFound}>
            <Text style={s.notFoundSymbol}>♩</Text>
            <Text style={s.notFoundTitle}>No chord chart yet</Text>
            <Text style={s.notFoundSub}>Generate a complete chord chart using AI — every verse, chorus, and bridge.</Text>
            <TouchableOpacity style={s.generateBtn} onPress={generateChords} activeOpacity={0.85}>
              <Text style={s.generateTxt}>GENERATE CHORDS</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Chart ── */}
        {loadState === 'found' && display && (
          <View>

            {/* Verified badge */}
            {display.verified && !editing && (
              <View style={s.verifiedRow}>
                <Text style={s.verifiedTxt}>✓  Verified by musician</Text>
              </View>
            )}

            {/* Edit toolbar */}
            {editing && (
              <View style={s.toolbar}>
                <Text style={s.toolbarLabel}>EDITING CHORDS</Text>
                <View style={s.toolbarActions}>
                  <TouchableOpacity style={s.cancelBtn} onPress={cancelEdit} disabled={saving}>
                    <Text style={s.cancelTxt}>CANCEL</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.saveBtn} onPress={saveAndVerify} disabled={saving} activeOpacity={0.85}>
                    {saving
                      ? <ActivityIndicator color={BG} size="small" />
                      : <Text style={s.saveTxt}>SAVE & VERIFY</Text>}
                  </TouchableOpacity>
                </View>
              </View>
            )}
            {editing && saveError ? <Text style={s.saveError}>{saveError}</Text> : null}

            {/* Pills */}
            {!editing && (
              <View style={s.pillRow}>
                {display.musicalKey ? <Pill label="KEY"  value={display.musicalKey} /> : null}
                {display.tempo      ? <Pill label="BPM"  value={String(display.tempo)} /> : null}
                {display.capo != null
                  ? <Pill label="CAPO" value={display.capo === 0 ? 'None' : `Fret ${display.capo}`} />
                  : null}
              </View>
            )}

            {/* Sections */}
            {(display.sections ?? []).map((section, si) => (
              <View key={si} style={s.section}>

                <View style={s.sectionHeader}>
                  <Text style={s.sectionLabel}>{(section.label ?? '').toUpperCase()}</Text>
                  <View style={s.sectionRule} />
                </View>

                {(section.lines ?? []).map((line, li) => {
                  const hasChords = (line.chords?.length ?? 0) > 0;
                  const hasLyrics = !!line.lyrics?.trim();

                  if (!editing) {
                    const cl = hasChords ? buildChordLine(line.chords!, line.lyrics ?? '') : null;
                    if (!cl && !hasLyrics) return null;
                    return (
                      <View key={li} style={s.lineBlock}>
                        {cl        ? <Text style={s.chordLine}>{cl}</Text>          : null}
                        {hasLyrics ? <Text style={s.lyricLine}>{line.lyrics}</Text> : null}
                      </View>
                    );
                  }

                  // ── Edit mode ──
                  const sorted = hasChords
                    ? [...(line.chords ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
                    : [];

                  return (
                    <View key={li} style={s.lineBlock}>

                      {/* Chord pills row */}
                      <View style={s.chordPillRow}>
                        {sorted.map((c, ci) => (
                          <TouchableOpacity
                            key={ci}
                            style={s.chordPill}
                            onPress={() => setActiveChord({ si, li, ci, value: c.chord })}
                            activeOpacity={0.7}
                          >
                            <Text style={s.chordPillTxt}>{c.chord}</Text>
                          </TouchableOpacity>
                        ))}
                        <TouchableOpacity
                          style={s.addChordBtn}
                          onPress={() => addChordToLine(si, li)}
                          activeOpacity={0.7}
                        >
                          <Text style={s.addChordTxt}>+ chord</Text>
                        </TouchableOpacity>
                      </View>

                      {/* Editable lyric */}
                      <TextInput
                        style={s.lyricInput}
                        value={line.lyrics ?? ''}
                        onChangeText={v => setLyricValue(si, li, v)}
                        multiline
                        autoCorrect={false}
                        autoCapitalize="sentences"
                        placeholderTextColor={MUTED}
                        placeholder="lyrics…"
                      />
                    </View>
                  );
                })}
              </View>
            ))}

            {/* EDIT CHORDS button — read mode only */}
            {!editing && (
              <View style={s.editBtnWrap}>
                <TouchableOpacity style={s.editBtn} onPress={startEdit} activeOpacity={0.8}>
                  <Text style={s.editBtnTxt}>EDIT CHORDS</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}

      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ─── Modal styles ─────────────────────────────────────────────────────────────

const m = StyleSheet.create({
  overlay:   { flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'center', alignItems: 'center' },
  box:       { backgroundColor: '#131007', borderWidth: 1, borderColor: BORDER, padding: 24, width: 260 },
  label:     { color: GOLD_DIM, fontSize: 9, letterSpacing: 3, marginBottom: 14 },
  input:     { color: GOLD, fontFamily: MONO, fontSize: 20, fontWeight: '700', borderBottomWidth: 1, borderBottomColor: GOLD_DIM, paddingBottom: 6, marginBottom: 20, textAlign: 'center' },
  row:       { flexDirection: 'row', gap: 10 },
  deleteBtn: { flex: 1, borderWidth: 1, borderColor: RED, paddingVertical: 10, alignItems: 'center' },
  deleteTxt: { color: RED, fontSize: 11, fontWeight: '700', letterSpacing: 1.5 },
  applyBtn:  { flex: 1, backgroundColor: GOLD, paddingVertical: 10, alignItems: 'center' },
  applyTxt:  { color: BG,  fontSize: 11, fontWeight: '700', letterSpacing: 1.5 },
});

// ─── Screen styles ────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  content:   { paddingHorizontal: 24, paddingTop: 64, paddingBottom: 80 },

  backBtn:  { marginBottom: 28 },
  backText: { color: GOLD, fontSize: 16 },

  header:     { marginBottom: 24 },
  songTitle:  { color: CREAM, fontSize: 32, fontWeight: 'bold', lineHeight: 36, marginBottom: 6 },
  songArtist: { color: GOLD,  fontSize: 18, fontStyle: 'italic', marginBottom: 4 },
  songAlbum:  { color: MUTED, fontSize: 13 },

  metaRow:   { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 24 },
  metaItem:  { flex: 1 },
  metaLabel: { color: GOLD_DIM, fontSize: 9, letterSpacing: 2, marginBottom: 6 },
  metaValue: { color: CREAM,    fontSize: 15 },

  divider: { height: 1, backgroundColor: BORDER, marginBottom: 28 },

  centered:    { alignItems: 'center', paddingTop: 40, paddingBottom: 20 },
  centeredTxt: { color: MUTED,    fontSize: 14, marginTop: 16 },
  centeredSub: { color: GOLD_DIM, fontSize: 12, marginTop: 8, textAlign: 'center', paddingHorizontal: 20 },

  errorTxt:  { color: RED,  fontSize: 13, textAlign: 'center', marginBottom: 20, paddingHorizontal: 16 },
  retryBtn:  { borderWidth: 1, borderColor: BORDER, paddingHorizontal: 20, paddingVertical: 10 },
  retryTxt:  { color: MUTED, fontSize: 11, letterSpacing: 2 },

  notFound:       { alignItems: 'center', paddingTop: 32, paddingBottom: 12 },
  notFoundSymbol: { color: GOLD_DIM, fontSize: 40, marginBottom: 20 },
  notFoundTitle:  { color: CREAM,    fontSize: 20, fontWeight: '600', marginBottom: 10 },
  notFoundSub:    { color: MUTED,    fontSize: 14, textAlign: 'center', lineHeight: 22, marginBottom: 32, paddingHorizontal: 16 },
  generateBtn:    { backgroundColor: GOLD, paddingVertical: 14, paddingHorizontal: 32 },
  generateTxt:    { color: BG, fontSize: 11, fontWeight: '700', letterSpacing: 2.5 },

  // Verified badge
  verifiedRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 20 },
  verifiedTxt: { color: GOLD, fontSize: 12, fontWeight: '700', letterSpacing: 1.5 },

  // Edit toolbar
  toolbar:        { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: BORDER },
  toolbarLabel:   { color: GOLD_DIM, fontSize: 9, letterSpacing: 3 },
  toolbarActions: { flexDirection: 'row', gap: 10 },
  cancelBtn:      { borderWidth: 1, borderColor: BORDER, paddingHorizontal: 16, paddingVertical: 8 },
  cancelTxt:      { color: MUTED, fontSize: 11, letterSpacing: 1.5 },
  saveBtn:        { backgroundColor: GOLD, paddingHorizontal: 18, paddingVertical: 8, minWidth: 110, alignItems: 'center' },
  saveTxt:        { color: BG, fontSize: 11, fontWeight: '700', letterSpacing: 1.5 },
  saveError:      { color: RED, fontSize: 12, marginBottom: 16, textAlign: 'center' },

  pillRow: { flexDirection: 'row', gap: 8, marginBottom: 28, flexWrap: 'wrap' },

  section:       { marginBottom: 28 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 14 },
  sectionLabel:  { color: GOLD, fontSize: 10, fontWeight: '700', letterSpacing: 3.5 },
  sectionRule:   { flex: 1, height: 1, backgroundColor: GOLD, opacity: 0.2, marginLeft: 12 },

  lineBlock: { marginBottom: 14 },
  chordLine: { color: GOLD,  fontFamily: MONO, fontSize: 13, lineHeight: 18, letterSpacing: 0.1 },
  lyricLine: { color: CREAM, fontFamily: MONO, fontSize: 13, lineHeight: 20 },

  // Edit mode — chord pill row
  chordPillRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 6 },
  chordPill:    { backgroundColor: '#1e1a0e', borderWidth: 1, borderColor: GOLD_DIM, paddingHorizontal: 10, paddingVertical: 4 },
  chordPillTxt: { color: GOLD, fontFamily: MONO, fontSize: 13, fontWeight: '700' },
  addChordBtn:  { paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1, borderColor: BORDER, borderStyle: 'dashed' },
  addChordTxt:  { color: MUTED, fontSize: 11 },

  // Edit mode — lyric input
  lyricInput: {
    color: CREAM,
    fontFamily: MONO,
    fontSize: 13,
    lineHeight: 20,
    borderWidth: 1,
    borderColor: BORDER,
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: '#100e08',
  },

  // EDIT CHORDS button
  editBtnWrap: { marginTop: 36, paddingTop: 24, borderTopWidth: 1, borderTopColor: BORDER },
  editBtn:     { borderWidth: 1, borderColor: GOLD_DIM, paddingVertical: 14, alignItems: 'center' },
  editBtnTxt:  { color: GOLD_DIM, fontSize: 11, fontWeight: '700', letterSpacing: 3 },
});
