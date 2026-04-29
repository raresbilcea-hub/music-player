import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  FlatList,
  Image,
  ActivityIndicator,
  TextInput,
  Modal,
  Platform,
  KeyboardAvoidingView,
} from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { useState, useEffect, useCallback } from 'react';
import { getHistory, clearHistory, type HistorySong } from '@/lib/songHistory';
import { useAuth } from '@/context/auth';
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
import { ChordDiagramModal } from '@/components/ChordDiagram';

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

// ─── Pill / EditPill ──────────────────────────────────────────────────────────

function Pill({ label, value }: { label: string; value: string }) {
  return (
    <View style={ps.wrap}>
      <Text style={ps.label}>{label}</Text>
      <Text style={ps.value}>{value}</Text>
    </View>
  );
}

function EditPill({
  label, value, onChangeText, keyboard, placeholder,
}: {
  label:        string;
  value:        string;
  onChangeText: (v: string) => void;
  keyboard?:    'default' | 'numeric' | 'decimal-pad';
  placeholder?: string;
}) {
  return (
    <View style={ps.editWrap}>
      <Text style={ps.label}>{label}</Text>
      <TextInput
        style={ps.input}
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboard ?? 'default'}
        autoCapitalize="none"
        autoCorrect={false}
        selectTextOnFocus
        placeholder={placeholder ?? '—'}
        placeholderTextColor={MUTED}
      />
    </View>
  );
}

const ps = StyleSheet.create({
  wrap:     { backgroundColor: '#191610', borderWidth: 1, borderColor: '#2e2618', borderRadius: 4, paddingHorizontal: 14, paddingVertical: 8, alignItems: 'center', minWidth: 64 },
  editWrap: { backgroundColor: '#191610', borderWidth: 1, borderColor: GOLD_DIM,  borderRadius: 4, paddingHorizontal: 10, paddingVertical: 6,  alignItems: 'center', minWidth: 72 },
  label:    { color: GOLD_DIM, fontSize: 8, letterSpacing: 2, marginBottom: 4 },
  value:    { color: CREAM,    fontSize: 14, fontWeight: '600' },
  input:    { color: GOLD,     fontSize: 14, fontWeight: '600', fontFamily: MONO, textAlign: 'center', minWidth: 52, padding: 0 },
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

// ─── SongHistoryList ──────────────────────────────────────────────────────────
// Shown when the Songs tab is opened with no title/artist params.

function SongHistoryList() {
  const router = useRouter();
  const { user, signOut } = useAuth();
  const [history, setHistory] = useState<HistorySong[]>([]);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    useCallback(() => {
      getHistory().then(h => { setHistory(h); setLoading(false); });
    }, [])
  );

  async function handleClear() {
    await clearHistory();
    setHistory([]);
  }

  async function handleSignOut() {
    await signOut();
  }

  function openSong(song: HistorySong) {
    router.navigate({
      pathname: '/(tabs)/song',
      params: {
        title:   song.title,
        artist:  song.artist,
        album:   song.album    ?? '',
        year:    song.year     ?? '',
        genre:   song.genre    ?? '',
        artwork: song.artwork  ?? '',
      },
    });
  }

  if (loading) {
    return (
      <View style={hl.container}>
        <ActivityIndicator color={GOLD} size="large" />
      </View>
    );
  }

  return (
    <View style={hl.container}>

      {/* Header */}
      <View style={hl.header}>
        <View>
          <Text style={hl.title}>Songs</Text>
          <Text style={hl.subtitle}>
            {history.length > 0 ? `${history.length} in history` : 'Your history'}
          </Text>
        </View>
        {history.length > 0 && (
          <TouchableOpacity onPress={handleClear} activeOpacity={0.7}>
            <Text style={hl.clearTxt}>CLEAR ALL</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Account row */}
      {user && (
        <View style={hl.accountRow}>
          <Text style={hl.accountEmail} numberOfLines={1}>{user.email}</Text>
          <TouchableOpacity onPress={handleSignOut} activeOpacity={0.7}>
            <Text style={hl.signOutTxt}>SIGN OUT</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={hl.divider} />

      {history.length === 0 ? (
        <View style={hl.empty}>
          <Text style={hl.emptySym}>♪</Text>
          <Text style={hl.emptyTitle}>No songs yet</Text>
          <Text style={hl.emptySub}>
            Songs you search on the Home tab or identify with the Record tab will appear here.
          </Text>
        </View>
      ) : (
        <FlatList
          data={history}
          keyExtractor={(item, i) => `${item.title}-${item.artist}-${i}`}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 40 }}
          renderItem={({ item, index }) => (
            <TouchableOpacity style={hl.card} onPress={() => openSong(item)} activeOpacity={0.8}>
              <Text style={hl.num}>{String(index + 1).padStart(2, '0')}</Text>
              {item.artwork
                ? <Image source={{ uri: item.artwork }} style={hl.art} />
                : <View style={hl.artPlaceholder}><Text style={hl.artNote}>♪</Text></View>
              }
              <View style={hl.info}>
                <Text style={hl.songTitle}  numberOfLines={1}>{item.title}</Text>
                <Text style={hl.songMeta}   numberOfLines={1}>
                  {item.artist}{item.album ? ` · ${item.album}` : ''}
                </Text>
              </View>
              {item.year ? <Text style={hl.year}>{item.year}</Text> : null}
              <Text style={hl.chevron}>›</Text>
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}

const hl = StyleSheet.create({
  container:      { flex: 1, backgroundColor: BG, paddingTop: 16, paddingHorizontal: 24 },
  header:         { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 16 },
  title:          { color: CREAM, fontSize: 32, fontWeight: 'bold' },
  subtitle:       { color: MUTED, fontSize: 11, marginTop: 4 },
  clearTxt:       { color: GOLD_DIM, fontSize: 10, letterSpacing: 2 },
  accountRow:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10, marginBottom: 4 },
  accountEmail:   { color: MUTED, fontSize: 12, flex: 1, marginRight: 16 },
  signOutTxt:     { color: GOLD_DIM, fontSize: 10, letterSpacing: 2 },
  divider:        { height: 1, backgroundColor: BORDER, marginBottom: 8 },
  empty:          { flex: 1, alignItems: 'center', paddingTop: 60 },
  emptySym:       { color: GOLD_DIM, fontSize: 40, marginBottom: 20 },
  emptyTitle:     { color: CREAM, fontSize: 18, fontWeight: '600', marginBottom: 10 },
  emptySub:       { color: MUTED, fontSize: 13, textAlign: 'center', lineHeight: 20, paddingHorizontal: 24 },
  card:           { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: BORDER },
  num:            { color: MUTED, fontSize: 11, width: 28 },
  art:            { width: 44, height: 44, marginRight: 12, borderWidth: 1, borderColor: BORDER },
  artPlaceholder: { width: 44, height: 44, marginRight: 12, backgroundColor: '#16130e', borderWidth: 1, borderColor: BORDER, justifyContent: 'center', alignItems: 'center' },
  artNote:        { color: MUTED, fontSize: 16 },
  info:           { flex: 1 },
  songTitle:      { color: CREAM, fontSize: 15, fontWeight: '600', marginBottom: 3 },
  songMeta:       { color: MUTED, fontSize: 12 },
  year:           { color: GOLD_DIM, fontSize: 11, marginRight: 8 },
  chevron:        { color: MUTED, fontSize: 20, lineHeight: 24 },
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

  // No params → show the history list (tab's default state)
  if (!title || !artist) return <SongHistoryList />;

  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [chart,     setChart]     = useState<ChordChart | null>(null);
  const [errorMsg,  setErrorMsg]  = useState('');

  const [editing,      setEditing]      = useState(false);
  const [draft,        setDraft]        = useState<ChordChart | null>(null);
  const [saving,       setSaving]       = useState(false);
  const [saveError,    setSaveError]    = useState('');
  const [modal,        setModal]        = useState<ChordModal | null>(null);
  const [chordDiagram, setChordDiagram] = useState<string | null>(null);

  // ── Bug fix: reset all state when the song changes ─────────────────────────
  useEffect(() => {
    setChart(null);
    setEditing(false);
    setDraft(null);
    setModal(null);
    setSaveError('');
    setErrorMsg('');
    setChordDiagram(null);
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

  function setDraftMeta(field: 'musicalKey' | 'tempo' | 'capo', raw: string) {
    if (!draft) return;
    setDraft(prev => {
      if (!prev) return prev;
      if (field === 'musicalKey') return { ...prev, musicalKey: raw };
      const num = raw === '' ? undefined : Number(raw);
      if (field === 'tempo') return { ...prev, tempo: isNaN(num as number) ? prev.tempo : num };
      // capo: empty string → 0 (no capo)
      return { ...prev, capo: (raw === '' || isNaN(num as number)) ? 0 : num };
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────

  const display = editing ? draft : chart;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: BG }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* ── Chord diagram modal ── */}
      <ChordDiagramModal
        chordName={chordDiagram}
        onClose={() => setChordDiagram(null)}
      />

      {/* ── Chord edit modal ── */}
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
        {/* Back — always returns to the history list, never to Home */}
        {!editing && (
          <TouchableOpacity
            style={s.backBtn}
            onPress={() => router.navigate('/(tabs)/song')}
          >
            <Text style={s.backText}>← Songs</Text>
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

            {/* Verified badge + quick edit shortcut */}
            {display.verified && !editing && (
              <View style={s.verifiedRow}>
                <Text style={s.verifiedTxt}>✓  Verified by musician</Text>
                <TouchableOpacity onPress={startEdit} activeOpacity={0.7}>
                  <Text style={s.verifiedEditLink}>EDIT CHORDS ↓</Text>
                </TouchableOpacity>
              </View>
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

            {/* Pills — read mode shows static pills, edit mode shows text inputs */}
            <View style={s.pillRow}>
              {editing ? (
                <>
                  <EditPill
                    label="KEY"
                    value={draft?.musicalKey ?? ''}
                    onChangeText={v => setDraftMeta('musicalKey', v)}
                    placeholder="D major"
                  />
                  <EditPill
                    label="BPM"
                    value={draft?.tempo != null ? String(draft.tempo) : ''}
                    onChangeText={v => setDraftMeta('tempo', v)}
                    keyboard="numeric"
                    placeholder="120"
                  />
                  <EditPill
                    label="CAPO"
                    value={draft?.capo != null ? String(draft.capo) : ''}
                    onChangeText={v => setDraftMeta('capo', v)}
                    keyboard="numeric"
                    placeholder="0"
                  />
                </>
              ) : (
                <>
                  {display.musicalKey && <Pill label="KEY"  value={display.musicalKey} />}
                  {display.tempo      && <Pill label="BPM"  value={String(display.tempo)} />}
                  {display.capo != null && (
                    <Pill label="CAPO" value={display.capo === 0 ? 'None' : `Fret ${display.capo}`} />
                  )}
                </>
              )}
            </View>

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

                  if (!editing) return (
                    <LineView
                      key={li}
                      line={line}
                      onChordPress={name => setChordDiagram(name)}
                    />
                  );

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
  content:   { paddingHorizontal: 24, paddingTop: 16, paddingBottom: 80 },

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

  verifiedRow:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 },
  verifiedTxt:     { color: GOLD, fontSize: 12, fontWeight: '700', letterSpacing: 1.5 },
  verifiedEditLink:{ color: GOLD_DIM, fontSize: 10, letterSpacing: 1.5 },

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
