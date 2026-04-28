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
import {
  LineView,
  buildChordLine,
  buildDisplayLyric,
  chordExtent,
  MONO,
  FSIZE,
  CHAR_W,
  type Chord,
  type Line,
} from '@/components/LineView';

// ─── Design tokens ────────────────────────────────────────────────────────────

const GOLD     = '#c9a84c';
const GOLD_DIM = '#8a6f32';
const BG       = '#0e0c09';
const CREAM    = '#e8dfc8';
const MUTED    = '#6b6254';
const BORDER   = '#2a2318';
const RED      = '#c0392b';

const API = 'https://music-player-production-524a.up.railway.app';

// ─── Types ────────────────────────────────────────────────────────────────────

type Section = { label: string; lines?: Line[] };
type ChordChart = {
  title:       string;
  artist:      string;
  musicalKey?: string;
  tempo?:      number | string;
  capo?:       number | string;
  sections:    Section[];
  verified?:   boolean;
};
type LoadState = 'loading' | 'found' | 'notFound' | 'generating' | 'error';

// Modal state: ci === null means "add new chord", otherwise edit existing at index ci
type ChordModal = {
  si:       number;
  li:       number;
  ci:       number | null;
  position: number;
  value:    string;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── EditLineView ─────────────────────────────────────────────────────────────
// Absolutely-positioned chord pills over a tappable canvas + single-line lyric input.

function EditLineView({
  line, si, li,
  onOpenModal,
  onLyricChange,
}: {
  line:          Line;
  si:            number;
  li:            number;
  onOpenModal:   (m: ChordModal) => void;
  onLyricChange: (si: number, li: number, val: string) => void;
}) {
  const chords  = line.chords ?? [];
  const lyrics  = line.lyrics ?? '';
  const extent  = chordExtent(chords);
  const lineCh  = Math.max(lyrics.length, extent);
  const canvasW = (lineCh + 6) * CHAR_W;
  const PILL_H  = 26;

  const sorted = chords
    .map((c, ci) => ({ ...c, ci }))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  return (
    <View style={el.wrap}>
      {/* ── Chord canvas ── */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        nestedScrollEnabled
        style={el.canvasScroll}
        contentContainerStyle={{ width: canvasW + 8 }}
      >
        {/* Background — fires when no pill is under the tap */}
        <TouchableOpacity
          style={[el.canvas, { width: canvasW, height: PILL_H }]}
          activeOpacity={1}
          onPress={e => {
            const charIdx = Math.floor(e.nativeEvent.locationX / CHAR_W);
            onOpenModal({ si, li, ci: null, position: charIdx, value: '' });
          }}
        >
          {/* Existing chord pills — intercept touch before parent */}
          {sorted.map(({ chord, position, ci }) => (
            <TouchableOpacity
              key={ci}
              style={[el.pill, { left: (position ?? 0) * CHAR_W }]}
              onPress={() => onOpenModal({ si, li, ci, position: position ?? 0, value: chord })}
              activeOpacity={0.7}
            >
              <Text style={el.pillTxt}>{chord}</Text>
            </TouchableOpacity>
          ))}

          {/* "+" — add chord after all existing content */}
          <TouchableOpacity
            style={[el.plusBtn, { left: (lineCh + 1) * CHAR_W }]}
            onPress={() => onOpenModal({ si, li, ci: null, position: lineCh + 2, value: '' })}
            activeOpacity={0.7}
          >
            <Text style={el.plusTxt}>+</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </ScrollView>

      {/* Single-line lyric input — never wraps */}
      <TextInput
        style={el.lyricInput}
        value={lyrics}
        onChangeText={v => onLyricChange(si, li, v)}
        autoCorrect={false}
        autoCapitalize="sentences"
        placeholderTextColor={MUTED}
        placeholder="lyrics…"
      />
    </View>
  );
}

const el = StyleSheet.create({
  wrap:        { marginBottom: 18 },
  canvasScroll:{ marginBottom: 4 },
  canvas: {
    position:        'relative',
    backgroundColor: '#0b0904',
    borderWidth:     1,
    borderColor:     '#1e1a10',
    borderStyle:     'dashed',
  },
  pill: {
    position:          'absolute',
    top:               3,
    backgroundColor:   '#1e1a0e',
    borderWidth:       1,
    borderColor:       GOLD_DIM,
    paddingHorizontal: 5,
    paddingVertical:   1,
  },
  pillTxt:    { color: GOLD, fontFamily: MONO, fontSize: FSIZE, fontWeight: '700' },
  plusBtn:    { position: 'absolute', top: 4 },
  plusTxt:    { color: GOLD_DIM, fontSize: 16, lineHeight: 20, fontWeight: '300' },
  lyricInput: {
    color:             CREAM,
    fontFamily:        MONO,
    fontSize:          FSIZE,
    lineHeight:        20,
    borderWidth:       1,
    borderColor:       BORDER,
    paddingHorizontal: 8,
    paddingVertical:   6,
    backgroundColor:   '#100e08',
  },
});

// ─── SongScreen ───────────────────────────────────────────────────────────────

export default function SongScreen() {
  const router   = useRouter();
  const params   = useLocalSearchParams();
  const title    = String(params.title    ?? '');
  const artist   = String(params.artist   ?? '');
  const album    = String(params.album    ?? '');
  const year     = String(params.year     ?? '');
  const genre    = String(params.genre    ?? '');
  const duration = String(params.duration ?? '');

  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [chart,     setChart]     = useState<ChordChart | null>(null);
  const [errorMsg,  setErrorMsg]  = useState('');

  const [editing,   setEditing]   = useState(false);
  const [draft,     setDraft]     = useState<ChordChart | null>(null);
  const [saving,    setSaving]    = useState(false);
  const [saveError, setSaveError] = useState('');
  const [modal,     setModal]     = useState<ChordModal | null>(null);

  // ── Bug fix: reset all state when the song changes ─────────────────────────
  useEffect(() => {
    setChart(null);
    setEditing(false);
    setDraft(null);
    setModal(null);
    setSaveError('');
    setErrorMsg('');
  }, [title, artist]);

  // ─── Network ───────────────────────────────────────────────────────────────

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
    setLoadState('generating'); setErrorMsg('');
    try {
      const res  = await fetch(`${API}/chords`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, artist }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setChart(data.chart); setLoadState('found');
    } catch (e: any) { setErrorMsg(e.message); setLoadState('error'); }
  }

  // ─── Edit ──────────────────────────────────────────────────────────────────

  function startEdit() {
    if (!chart) return;
    setDraft(clone(chart)); setSaveError(''); setEditing(true);
  }

  function cancelEdit() {
    setEditing(false); setDraft(null); setModal(null); setSaveError('');
  }

  async function saveAndVerify() {
    if (!draft) return;
    setSaving(true); setSaveError('');
    try {
      const res = await fetch(`${API}/chords`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title, artist,
          sections:   draft.sections,
          musicalKey: draft.musicalKey,
          tempo:      draft.tempo,
          capo:       draft.capo,
        }),
      });

      // Bug fix: parse as text first so a non-JSON error page doesn't throw
      // an opaque "Unexpected character :<" instead of the real status.
      const text = await res.text();
      let data: any;
      try { data = JSON.parse(text); }
      catch { throw new Error(`Server error (${res.status}) — please try again`); }

      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);

      setChart({ ...draft, verified: true });
      setEditing(false); setDraft(null); setModal(null);
    } catch (e: any) {
      setSaveError(e.message);
    } finally {
      setSaving(false);
    }
  }

  // ─── Draft mutators ────────────────────────────────────────────────────────

  function applyChordModal() {
    if (!modal || !draft) return;
    const next = clone(draft);
    const line = next.sections[modal.si].lines![modal.li];
    if (!line.chords) line.chords = [];

    if (modal.ci !== null) {
      line.chords[modal.ci] = { chord: modal.value, position: modal.position };
    } else {
      line.chords.push({ chord: modal.value, position: modal.position });
      line.chords.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    }
    setDraft(next); setModal(null);
  }

  function deleteChordModal() {
    if (!modal || modal.ci === null || !draft) return;
    const next = clone(draft);
    next.sections[modal.si].lines![modal.li].chords!.splice(modal.ci, 1);
    setDraft(next); setModal(null);
  }

  function setLyricValue(si: number, li: number, val: string) {
    if (!draft) return;
    const next = clone(draft);
    next.sections[si].lines![li].lyrics = val;
    setDraft(next);
  }

  // ─────────────────────────────────────────────────────────────────────────────

  const display = editing ? draft : chart;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: BG }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* ── Chord modal ── */}
      <Modal transparent visible={!!modal} animationType="fade" onRequestClose={() => setModal(null)}>
        <TouchableOpacity style={mo.overlay} activeOpacity={1} onPress={() => setModal(null)}>
          <View style={mo.box}>
            <Text style={mo.heading}>{modal?.ci !== null ? 'EDIT CHORD' : 'ADD CHORD'}</Text>
            <Text style={mo.posHint}>position {modal?.position ?? 0}</Text>
            <TextInput
              style={mo.input}
              value={modal?.value ?? ''}
              onChangeText={v => setModal(m => m ? { ...m, value: v } : null)}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              selectTextOnFocus
              placeholderTextColor={MUTED}
              placeholder="e.g. Am7"
            />
            <View style={mo.btnRow}>
              {modal?.ci !== null && (
                <TouchableOpacity style={mo.deleteBtn} onPress={deleteChordModal}>
                  <Text style={mo.deleteTxt}>DELETE</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={[mo.applyBtn, modal?.ci === null && { flex: 1 }]}
                onPress={applyChordModal}
                disabled={!modal?.value?.trim()}
              >
                <Text style={mo.applyTxt}>APPLY</Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      <ScrollView
        style={s.container}
        contentContainerStyle={s.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
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
        {!editing && (year || genre || duration) && (
          <View style={s.metaRow}>
            {year     && <View style={s.metaItem}><Text style={s.metaLabel}>YEAR</Text><Text style={s.metaValue}>{year}</Text></View>}
            {genre    && <View style={s.metaItem}><Text style={s.metaLabel}>GENRE</Text><Text style={s.metaValue}>{genre}</Text></View>}
            {duration && <View style={s.metaItem}><Text style={s.metaLabel}>DURATION</Text><Text style={s.metaValue}>{duration}</Text></View>}
          </View>
        )}

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
            <Text style={s.notFoundSym}>♩</Text>
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
              <Text style={s.verifiedTxt}>✓  Verified by musician</Text>
            )}

            {/* Edit toolbar */}
            {editing && (
              <>
                <View style={s.toolbar}>
                  <Text style={s.toolbarLabel}>EDITING CHORDS</Text>
                  <View style={s.toolbarBtns}>
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
                <Text style={s.editHint}>Tap empty space to add chord · Tap pill to edit</Text>
                {saveError ? <Text style={s.saveError}>{saveError}</Text> : null}
              </>
            )}

            {/* Pills */}
            {!editing && (
              <View style={s.pillRow}>
                {display.musicalKey && <Pill label="KEY"  value={display.musicalKey} />}
                {display.tempo      && <Pill label="BPM"  value={String(display.tempo)} />}
                {display.capo != null && (
                  <Pill label="CAPO" value={display.capo === 0 ? 'None' : `Fret ${display.capo}`} />
                )}
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
                  if (!hasChords && !hasLyrics) return null;

                  if (!editing) return <LineView key={li} line={line} />;

                  return (
                    <EditLineView
                      key={li}
                      line={line}
                      si={si}
                      li={li}
                      onOpenModal={setModal}
                      onLyricChange={setLyricValue}
                    />
                  );
                })}
              </View>
            ))}

            {/* EDIT CHORDS button */}
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

const mo = StyleSheet.create({
  overlay:   { flex: 1, backgroundColor: 'rgba(0,0,0,0.78)', justifyContent: 'center', alignItems: 'center' },
  box:       { backgroundColor: '#131007', borderWidth: 1, borderColor: BORDER, padding: 24, width: 270 },
  heading:   { color: GOLD_DIM, fontSize: 9, letterSpacing: 3, marginBottom: 4 },
  posHint:   { color: MUTED, fontSize: 10, marginBottom: 14 },
  input:     { color: GOLD, fontFamily: MONO, fontSize: 22, fontWeight: '700', borderBottomWidth: 1, borderBottomColor: GOLD_DIM, paddingBottom: 8, marginBottom: 22, textAlign: 'center', letterSpacing: 1 },
  btnRow:    { flexDirection: 'row', gap: 10 },
  deleteBtn: { flex: 1, borderWidth: 1, borderColor: RED, paddingVertical: 11, alignItems: 'center' },
  deleteTxt: { color: RED, fontSize: 11, fontWeight: '700', letterSpacing: 1.5 },
  applyBtn:  { flex: 1, backgroundColor: GOLD, paddingVertical: 11, alignItems: 'center' },
  applyTxt:  { color: BG, fontSize: 11, fontWeight: '700', letterSpacing: 1.5 },
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

  errorTxt: { color: RED,  fontSize: 13, textAlign: 'center', marginBottom: 20, paddingHorizontal: 16 },
  retryBtn: { borderWidth: 1, borderColor: BORDER, paddingHorizontal: 20, paddingVertical: 10 },
  retryTxt: { color: MUTED, fontSize: 11, letterSpacing: 2 },

  notFound:      { alignItems: 'center', paddingTop: 32, paddingBottom: 12 },
  notFoundSym:   { color: GOLD_DIM, fontSize: 40, marginBottom: 20 },
  notFoundTitle: { color: CREAM,    fontSize: 20, fontWeight: '600', marginBottom: 10 },
  notFoundSub:   { color: MUTED,    fontSize: 14, textAlign: 'center', lineHeight: 22, marginBottom: 32, paddingHorizontal: 16 },
  generateBtn:   { backgroundColor: GOLD, paddingVertical: 14, paddingHorizontal: 32 },
  generateTxt:   { color: BG, fontSize: 11, fontWeight: '700', letterSpacing: 2.5 },

  verifiedTxt: { color: GOLD, fontSize: 12, fontWeight: '700', letterSpacing: 1.5, marginBottom: 20 },

  toolbar:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: BORDER },
  toolbarLabel: { color: GOLD_DIM, fontSize: 9, letterSpacing: 3 },
  toolbarBtns:  { flexDirection: 'row', gap: 10 },
  cancelBtn:    { borderWidth: 1, borderColor: BORDER, paddingHorizontal: 16, paddingVertical: 8 },
  cancelTxt:    { color: MUTED, fontSize: 11, letterSpacing: 1.5 },
  saveBtn:      { backgroundColor: GOLD, paddingHorizontal: 18, paddingVertical: 8, minWidth: 110, alignItems: 'center' },
  saveTxt:      { color: BG, fontSize: 11, fontWeight: '700', letterSpacing: 1.5 },
  editHint:     { color: MUTED, fontSize: 10, letterSpacing: 0.5, marginBottom: 16 },
  saveError:    { color: RED, fontSize: 12, marginBottom: 16, textAlign: 'center' },

  pillRow: { flexDirection: 'row', gap: 8, marginBottom: 28, flexWrap: 'wrap' },

  section:       { marginBottom: 28 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 14 },
  sectionLabel:  { color: GOLD, fontSize: 10, fontWeight: '700', letterSpacing: 3.5 },
  sectionRule:   { flex: 1, height: 1, backgroundColor: GOLD, opacity: 0.2, marginLeft: 12 },

  editBtnWrap: { marginTop: 36, paddingTop: 24, borderTopWidth: 1, borderTopColor: BORDER },
  editBtn:     { borderWidth: 1, borderColor: GOLD_DIM, paddingVertical: 14, alignItems: 'center' },
  editBtnTxt:  { color: GOLD_DIM, fontSize: 11, fontWeight: '700', letterSpacing: 3 },
});
