import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  Animated,
  Image,
} from 'react-native';
import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'expo-router';
import { useAudioRecorder, AudioModule, RecordingPresets } from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import { addToHistory } from '@/lib/songHistory';
import { shouldShowGate, consumeFreeAction } from '@/lib/freeGate';
import { FreeGateModal } from '@/components/FreeGateModal';

// ─── Design tokens ────────────────────────────────────────────────────────────

const GOLD     = '#c9a84c';
const GOLD_DIM = '#8a6f32';
const BG       = '#0e0c09';
const CREAM    = '#e8dfc8';
const MUTED    = '#6b6254';
const BORDER   = '#232018';
const RED      = '#c0392b';

// ─── Types ────────────────────────────────────────────────────────────────────

type SongInfo = {
  title:         string;
  artist:        string;
  album?:        string;
  release_date?: string;
  apple_music?:  { artwork?: { url?: string } };
  spotify?:      { album?: { images?: { url: string }[] } };
};
type ChordChart = {
  title:       string;
  artist:      string;
  musicalKey?: string;
  tempo?:      number | string;
  capo?:       number | string;
};
type IdentifyResult = { identified: boolean; songInfo?: SongInfo; chart: ChordChart };
type StatusKey = 'idle' | 'listening' | 'processing' | 'identifying'
               | 'identified' | 'generated' | 'error' | 'saved';
type RecordMode = 'identify' | 'live';

function artworkUrl(songInfo?: SongInfo): string {
  const am = songInfo?.apple_music?.artwork?.url;
  if (am) return am.replace('{w}', '300').replace('{h}', '300');
  return songInfo?.spotify?.album?.images?.[0]?.url ?? '';
}


// ─── AnimatedDots ─────────────────────────────────────────────────────────────

function AnimatedDots({ active }: { active: boolean }) {
  const [dots, setDots] = useState('');
  useEffect(() => {
    if (!active) { setDots(''); return; }
    const id = setInterval(
      () => setDots(d => (d.length >= 3 ? '' : d + '.')),
      480,
    );
    return () => clearInterval(id);
  }, [active]);
  return <Text style={{ color: GOLD }}>{dots}</Text>;
}

// ─── Pill ─────────────────────────────────────────────────────────────────────

function Pill({ label, value }: { label: string; value: string }) {
  return (
    <View style={pill.wrap}>
      <Text style={pill.label}>{label}</Text>
      <Text style={pill.value}>{value}</Text>
    </View>
  );
}

const pill = StyleSheet.create({
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
  label: {
    color: GOLD_DIM,
    fontSize: 8,
    letterSpacing: 2,
    marginBottom: 4,
  },
  value: {
    color: CREAM,
    fontSize: 14,
    fontWeight: '600',
  },
});

// ─── RecordScreen ─────────────────────────────────────────────────────────────

export default function RecordScreen() {
  const router        = useRouter();
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [isRecording, setIsRecording]   = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusKey, setStatusKey]       = useState<StatusKey>('idle');
  const [errorMsg, setErrorMsg]         = useState('');
  const [result, setResult]             = useState<IdentifyResult | null>(null);
  const [mode, setMode]                 = useState<RecordMode>('identify');
  const [gateVisible, setGateVisible]   = useState(false);

  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pulseRef  = useRef<Animated.CompositeAnimation | null>(null);
  const fadeAnim  = useRef(new Animated.Value(0)).current;

  // Record button pulse when recording
  useEffect(() => {
    if (isRecording) {
      pulseRef.current = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.16, duration: 650, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1,    duration: 650, useNativeDriver: true }),
        ]),
      );
      pulseRef.current.start();
    } else {
      pulseRef.current?.stop();
      Animated.timing(pulseAnim, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    }
  }, [isRecording]);

  // Fade-in chart when it arrives
  useEffect(() => {
    if (result?.chart) {
      fadeAnim.setValue(0);
      Animated.timing(fadeAnim, {
        toValue: 1, duration: 600, delay: 80, useNativeDriver: true,
      }).start();
    }
  }, [result]);

  async function startRecording() {
    if (await shouldShowGate()) { setGateVisible(true); return; }
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) { setStatusKey('error'); setErrorMsg('Microphone permission denied'); return; }
      await AudioModule.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      setResult(null);
      setIsRecording(true);
      setStatusKey('listening');
      await audioRecorder.prepareToRecordAsync();
      await audioRecorder.record();
      // In live mode record until the user stops manually — no auto-stop
      if (mode === 'identify') setTimeout(() => stopAndIdentify(), 10000);
    } catch (e: any) {
      setStatusKey('error');
      setErrorMsg(e.message);
      setIsRecording(false);
    }
  }

  async function stopAndSaveLive() {
    try {
      setIsRecording(false);
      setIsProcessing(true);
      setStatusKey('processing');
      await audioRecorder.stop();
      await consumeFreeAction();
      setIsProcessing(false);
      setStatusKey('saved');
    } catch (e: any) {
      setIsProcessing(false);
      setStatusKey('error');
      setErrorMsg(e.message);
    }
  }

  async function stopAndIdentify() {
    try {
      setIsRecording(false);
      setIsProcessing(true);
      setStatusKey('processing');
      await audioRecorder.stop();
      const uri = audioRecorder.uri;
      if (!uri) { setStatusKey('error'); setErrorMsg('No audio recorded'); setIsProcessing(false); return; }
      setStatusKey('identifying');
      const base64Audio = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });
      const response = await fetch('https://music-player-production-524a.up.railway.app/identify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioBase64: base64Audio, mimeType: 'audio/m4a' }),
      });
      const data = await response.json();
      setIsProcessing(false);
      if (data.error) { setStatusKey('error'); setErrorMsg(data.error); return; }

      // Save to history so Songs tab shows this song
      const si = data.songInfo as SongInfo | undefined;
      await addToHistory({
        title:   data.chart?.title  ?? si?.title  ?? '',
        artist:  data.chart?.artist ?? si?.artist ?? '',
        album:   si?.album ?? '',
        year:    si?.release_date ? si.release_date.substring(0, 4) : '',
        artwork: artworkUrl(si),
      });

      await consumeFreeAction();
      setResult(data);
      setStatusKey(data.identified ? 'identified' : 'generated');
    } catch (e: any) {
      setIsProcessing(false);
      setStatusKey('error');
      setErrorMsg(e.message);
    }
  }

  const chart    = result?.chart;
  const songInfo = result?.songInfo as SongInfo | undefined;
  const artwork  = artworkUrl(songInfo);
  const slideY   = fadeAnim.interpolate({ inputRange: [0, 1], outputRange: [20, 0] });

  function openChordChart() {
    if (!chart) return;
    router.navigate({
      pathname: '/(tabs)/song',
      params: {
        title:   chart.title,
        artist:  chart.artist,
        album:   songInfo?.album   ?? '',
        year:    songInfo?.release_date ? songInfo.release_date.substring(0, 4) : '',
        artwork: artwork,
      },
    });
  }

  return (
    <View style={s.root}>
      <FreeGateModal visible={gateVisible} />

      {/* ── Scrollable area ─────────────────────────────────────────────── */}
      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Idle header — changes based on mode */}
        {!chart && statusKey !== 'saved' && (
          <View style={s.idleHeader}>
            {mode === 'identify' ? (
              <>
                <Text style={s.idleMain}>Identify</Text>
                <Text style={s.idleAccent}>a Song.</Text>
                <Text style={s.idleTagline}>Hold your device near the music</Text>
              </>
            ) : (
              <>
                <Text style={s.idleMain}>Record</Text>
                <Text style={s.idleAccent}>Live.</Text>
                <Text style={s.idleTagline}>Capture your performance to share in Lessons</Text>
              </>
            )}
          </View>
        )}

        {/* Live recording saved confirmation */}
        {statusKey === 'saved' && (
          <View style={s.savedState}>
            <Text style={s.savedSymbol}>✦</Text>
            <Text style={s.savedTitle}>Recording saved!</Text>
            <Text style={s.savedSub}>Your recording is ready to upload to the Community Videos section in Lessons.</Text>
            <TouchableOpacity style={s.uploadBtn} activeOpacity={0.8} onPress={() => setStatusKey('idle')}>
              <Text style={s.uploadBtnTxt}>UPLOAD TO LESSONS</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setStatusKey('idle')}>
              <Text style={s.discardTxt}>Discard</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Identified result card ──────────────────────────────── */}
        {chart && (
          <Animated.View style={{ opacity: fadeAnim, transform: [{ translateY: slideY }] }}>
            <Text style={s.sourceBadge}>
              {result?.identified ? '✦  IDENTIFIED' : '✦  GENERATED'}
            </Text>

            <View style={s.resultCard}>
              {artwork
                ? <Image source={{ uri: artwork }} style={s.resultArtwork} />
                : <View style={s.resultArtworkPlaceholder}><Text style={s.resultArtworkNote}>♪</Text></View>
              }
              <View style={s.resultInfo}>
                <Text style={s.resultTitle} numberOfLines={2}>{chart.title}</Text>
                <Text style={s.resultArtist} numberOfLines={1}>{chart.artist}</Text>
                {(chart.musicalKey || chart.tempo) && (
                  <View style={s.resultPills}>
                    {chart.musicalKey ? <Pill label="KEY" value={chart.musicalKey} /> : null}
                    {chart.tempo      ? <Pill label="BPM" value={String(chart.tempo)} /> : null}
                  </View>
                )}
              </View>
            </View>

            <TouchableOpacity style={s.openChartBtn} onPress={openChordChart} activeOpacity={0.85}>
              <Text style={s.openChartTxt}>OPEN CHORD CHART  →</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={s.recordAgainBtn}
              onPress={() => { setResult(null); setStatusKey('idle'); }}
              activeOpacity={0.7}
            >
              <Text style={s.recordAgainTxt}>Record another song</Text>
            </TouchableOpacity>
          </Animated.View>
        )}

        {/* Spacer so content isn't hidden behind the fixed bottom bar */}
        <View style={{ height: 180 }} />
      </ScrollView>

      {/* ── Fixed bottom bar ────────────────────────────────────────────── */}
      <View style={s.bottomBar}>

        {/* Mode toggle */}
        {!isRecording && !isProcessing && statusKey !== 'saved' && !chart && (
          <View style={s.modeToggle}>
            <TouchableOpacity
              style={[s.modeBtn, mode === 'identify' && s.modeBtnActive]}
              onPress={() => { setMode('identify'); setStatusKey('idle'); setResult(null); }}
              activeOpacity={0.8}
            >
              <Text style={[s.modeTxt, mode === 'identify' && s.modeTxtActive]}>IDENTIFY</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.modeBtn, mode === 'live' && s.modeBtnLive]}
              onPress={() => { setMode('live'); setStatusKey('idle'); setResult(null); }}
              activeOpacity={0.8}
            >
              <Text style={[s.modeTxt, mode === 'live' && s.modeTxtLive]}>● RECORD LIVE</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Status */}
        <View style={s.statusRow}>
          {statusKey === 'listening' && (
            <Text style={mode === 'live' ? s.statusRed : s.statusListening}>
              {mode === 'live' ? '● Recording live' : 'Listening'}
              <AnimatedDots active={isRecording} />
            </Text>
          )}
          {statusKey === 'processing'  && <Text style={s.statusMuted}>Processing...</Text>}
          {statusKey === 'identifying' && <Text style={s.statusMuted}>Identifying song...</Text>}
          {statusKey === 'identified'  && <Text style={s.statusGold}>Song identified!</Text>}
          {statusKey === 'generated'   && <Text style={s.statusMuted}>Chart generated</Text>}
          {statusKey === 'error'       && <Text style={s.statusError}>{errorMsg}</Text>}
          {isRecording && <Text style={s.hintText}>tap to stop</Text>}
        </View>

        {/* Record button — hidden on saved screen and result card */}
        {statusKey !== 'saved' && !chart && (
          <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
            <TouchableOpacity
              style={[s.recordBtn, isRecording && s.recordBtnActive]}
              onPress={isRecording
                ? (mode === 'live' ? stopAndSaveLive : stopAndIdentify)
                : startRecording}
              disabled={isProcessing}
              activeOpacity={0.8}
            >
              <View style={[s.recordBtnInner, isRecording && s.recordBtnInnerActive]}>
                <Text style={[s.recordIcon, isRecording && s.recordIconActive]}>
                  {isRecording ? '■' : '⬤'}
                </Text>
              </View>
            </TouchableOpacity>
          </Animated.View>
        )}

      </View>
    </View>
  );
}


// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({

  root:   { flex: 1, backgroundColor: BG },
  scroll: { flex: 1 },
  scrollContent: { paddingTop: 24, paddingHorizontal: 24, flexGrow: 1 },

  // ── Idle header ──────────────────────────────────────────────────────────
  idleHeader:  { paddingTop: 12, paddingBottom: 40 },
  idleMain:    { color: CREAM, fontSize: 52, fontWeight: 'bold',   lineHeight: 58 },
  idleAccent:  { color: GOLD,  fontSize: 52, fontStyle: 'italic',  lineHeight: 58, marginBottom: 14 },
  idleTagline: { color: MUTED, fontSize: 14 },

  // ── Identified result card ────────────────────────────────────────────────
  sourceBadge: {
    color: GOLD_DIM,
    fontSize: 9,
    letterSpacing: 3.5,
    marginBottom: 16,
  },
  resultCard: {
    flexDirection:   'row',
    backgroundColor: '#16130e',
    borderWidth:     1,
    borderColor:     BORDER,
    padding:         16,
    marginBottom:    20,
    gap:             16,
    alignItems:      'flex-start',
  },
  resultArtwork: {
    width:       88,
    height:      88,
    borderWidth: 1,
    borderColor: BORDER,
    flexShrink:  0,
  },
  resultArtworkPlaceholder: {
    width:           88,
    height:          88,
    borderWidth:     1,
    borderColor:     BORDER,
    backgroundColor: '#0e0c09',
    justifyContent:  'center',
    alignItems:      'center',
    flexShrink:      0,
  },
  resultArtworkNote: { color: MUTED, fontSize: 28 },
  resultInfo:        { flex: 1 },
  resultTitle:       { color: CREAM, fontSize: 20, fontWeight: '700', lineHeight: 26, marginBottom: 4 },
  resultArtist:      { color: GOLD,  fontSize: 14, fontStyle: 'italic', marginBottom: 12 },
  resultPills:       { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },

  openChartBtn: {
    backgroundColor: GOLD,
    paddingVertical:   16,
    alignItems:        'center',
    marginBottom:      14,
  },
  openChartTxt: {
    color:         BG,
    fontSize:      12,
    fontWeight:    '700',
    letterSpacing: 2,
  },
  recordAgainBtn: { alignItems: 'center', paddingVertical: 8 },
  recordAgainTxt: { color: MUTED, fontSize: 13 },

  // ── Bottom bar ────────────────────────────────────────────────────────────
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingBottom: 40,
    paddingTop: 14,
    alignItems: 'center',
    backgroundColor: BG,
    borderTopWidth: 1,
    borderTopColor: BORDER,
  },

  statusRow: {
    alignItems: 'center',
    minHeight: 40,
    justifyContent: 'center',
    marginBottom: 16,
  },
  statusListening: { color: GOLD, fontSize: 14, letterSpacing: 0.5 },
  statusRed:       { color: RED,  fontSize: 14, letterSpacing: 0.5 },
  statusMuted:     { color: MUTED, fontSize: 13 },
  statusGold:      { color: GOLD,  fontSize: 13 },
  statusError:     { color: RED,   fontSize: 13, textAlign: 'center', paddingHorizontal: 24 },
  hintText:        { color: MUTED, fontSize: 11, marginTop: 5 },

  // ── Mode toggle ───────────────────────────────────────────────────────────
  modeToggle: {
    flexDirection:  'row',
    borderWidth:    1,
    borderColor:    BORDER,
    marginBottom:   14,
    overflow:       'hidden',
  },
  modeBtn:       { flex: 1, paddingVertical: 8, alignItems: 'center' },
  modeBtnActive: { backgroundColor: GOLD },
  modeBtnLive:   { backgroundColor: RED },
  modeTxt:       { color: MUTED, fontSize: 10, fontWeight: '700', letterSpacing: 1.5 },
  modeTxtActive: { color: BG },
  modeTxtLive:   { color: '#fff' },

  // ── Live saved state ──────────────────────────────────────────────────────
  savedState:  { flex: 1, alignItems: 'center', paddingTop: 32 },
  savedSymbol: { color: GOLD, fontSize: 32, marginBottom: 16 },
  savedTitle:  { color: CREAM, fontSize: 22, fontWeight: '700', marginBottom: 10 },
  savedSub:    { color: MUTED, fontSize: 13, textAlign: 'center', lineHeight: 20, marginBottom: 32, paddingHorizontal: 16 },
  uploadBtn:   { backgroundColor: GOLD, paddingVertical: 14, paddingHorizontal: 32, marginBottom: 16 },
  uploadBtnTxt:{ color: BG, fontSize: 11, fontWeight: '700', letterSpacing: 2.5 },
  discardTxt:  { color: MUTED, fontSize: 12 },

  // ── Record button ─────────────────────────────────────────────────────────
  recordBtn: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: GOLD,
    justifyContent: 'center',
    alignItems: 'center',
    // gold glow
    shadowColor: GOLD,
    shadowOpacity: 0.55,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 0 },
    elevation: 12,
  },
  recordBtnActive: {
    backgroundColor: RED,
    shadowColor: RED,
    shadowOpacity: 0.7,
  },
  recordBtnInner: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(0,0,0,0.15)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  recordBtnInnerActive: {
    backgroundColor: 'rgba(0,0,0,0.2)',
  },
  recordIcon: {
    color: BG,
    fontSize: 26,
    lineHeight: 30,
  },
  recordIconActive: {
    color: '#fff',
    fontSize: 20,
  },
});
