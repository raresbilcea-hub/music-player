import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  Animated,
  Platform,
} from 'react-native';
import { useState, useRef, useEffect } from 'react';
import { useAudioRecorder, AudioModule, RecordingPresets } from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import { LineView } from '@/components/LineView';

// ─── Design tokens ────────────────────────────────────────────────────────────

const GOLD     = '#c9a84c';
const GOLD_DIM = '#8a6f32';
const BG       = '#0e0c09';
const CREAM    = '#e8dfc8';
const MUTED    = '#6b6254';
const BORDER   = '#232018';
const RED      = '#c0392b';

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
type IdentifyResult = { identified: boolean; chart: ChordChart };
type StatusKey = 'idle' | 'listening' | 'processing' | 'identifying'
               | 'identified' | 'generated' | 'error';


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
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [isRecording, setIsRecording]   = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusKey, setStatusKey]       = useState<StatusKey>('idle');
  const [errorMsg, setErrorMsg]         = useState('');
  const [result, setResult]             = useState<IdentifyResult | null>(null);

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
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) { setStatusKey('error'); setErrorMsg('Microphone permission denied'); return; }
      await AudioModule.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      setResult(null);
      setIsRecording(true);
      setStatusKey('listening');
      await audioRecorder.prepareToRecordAsync();
      await audioRecorder.record();
      setTimeout(() => stopAndIdentify(), 10000);
    } catch (e: any) {
      setStatusKey('error');
      setErrorMsg(e.message);
      setIsRecording(false);
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
      setResult(data);
      setStatusKey(data.identified ? 'identified' : 'generated');
    } catch (e: any) {
      setIsProcessing(false);
      setStatusKey('error');
      setErrorMsg(e.message);
    }
  }

  const chart = result?.chart;
  const slideY = fadeAnim.interpolate({ inputRange: [0, 1], outputRange: [20, 0] });

  return (
    <View style={s.root}>

      {/* ── Scrollable area ─────────────────────────────────────────────── */}
      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Idle header — hidden once chart loads */}
        {!chart && (
          <View style={s.idleHeader}>
            <Text style={s.idleMain}>Identify</Text>
            <Text style={s.idleAccent}>a Song.</Text>
            <Text style={s.idleTagline}>Hold your device near the music</Text>
          </View>
        )}

        {/* ── Chord chart ─────────────────────────────────────────────── */}
        {chart && (
          <Animated.View style={{ opacity: fadeAnim, transform: [{ translateY: slideY }] }}>

            {/* Source badge */}
            <Text style={s.sourceBadge}>
              {result?.identified ? '✦  IDENTIFIED' : '✦  GENERATED'}
            </Text>

            {/* Title / artist */}
            <Text style={s.songTitle}>{chart.title}</Text>
            <Text style={s.songArtist}>{chart.artist}</Text>

            {/* Pill row */}
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
                {(section.lines ?? []).map((line, li) => (
                  <LineView key={li} line={line} />
                ))}
              </View>
            ))}
          </Animated.View>
        )}

        {/* Spacer so content isn't hidden behind the fixed bottom bar */}
        <View style={{ height: 180 }} />
      </ScrollView>

      {/* ── Fixed bottom bar ────────────────────────────────────────────── */}
      <View style={s.bottomBar}>

        {/* Status */}
        <View style={s.statusRow}>
          {statusKey === 'listening' && (
            <Text style={s.statusListening}>
              Listening<AnimatedDots active={isRecording} />
            </Text>
          )}
          {statusKey === 'processing'  && <Text style={s.statusMuted}>Processing...</Text>}
          {statusKey === 'identifying' && <Text style={s.statusMuted}>Identifying song...</Text>}
          {statusKey === 'identified'  && <Text style={s.statusGold}>Song identified!</Text>}
          {statusKey === 'generated'   && <Text style={s.statusMuted}>Chart generated</Text>}
          {statusKey === 'error'       && <Text style={s.statusError}>{errorMsg}</Text>}
          {isRecording && <Text style={s.hintText}>tap to stop early</Text>}
        </View>

        {/* Record button */}
        <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
          <TouchableOpacity
            style={[s.recordBtn, isRecording && s.recordBtnActive]}
            onPress={isRecording ? stopAndIdentify : startRecording}
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

      </View>
    </View>
  );
}


// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({

  root:   { flex: 1, backgroundColor: BG },
  scroll: { flex: 1 },
  scrollContent: { paddingTop: 68, paddingHorizontal: 24, flexGrow: 1 },

  // ── Idle header ──────────────────────────────────────────────────────────
  idleHeader:  { paddingTop: 12, paddingBottom: 40 },
  idleMain:    { color: CREAM, fontSize: 52, fontWeight: 'bold',   lineHeight: 58 },
  idleAccent:  { color: GOLD,  fontSize: 52, fontStyle: 'italic',  lineHeight: 58, marginBottom: 14 },
  idleTagline: { color: MUTED, fontSize: 14 },

  // ── Chart ────────────────────────────────────────────────────────────────
  sourceBadge: {
    color: GOLD_DIM,
    fontSize: 9,
    letterSpacing: 3.5,
    marginBottom: 20,
  },
  songTitle: {
    color: CREAM,
    fontSize: 34,
    fontWeight: '800',
    lineHeight: 38,
    marginBottom: 6,
  },
  songArtist: {
    color: GOLD,
    fontSize: 19,
    fontStyle: 'italic',
    marginBottom: 22,
  },

  pillRow: { flexDirection: 'row', gap: 8, marginBottom: 32, flexWrap: 'wrap' },

  // ── Sections ─────────────────────────────────────────────────────────────
  section: { marginBottom: 30 },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
  },
  sectionLabel: {
    color: GOLD,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 3.5,
  },
  sectionRule: {
    flex: 1,
    height: 1,
    backgroundColor: GOLD,
    opacity: 0.2,
    marginLeft: 12,
  },

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
  statusListening: { color: GOLD,  fontSize: 14, letterSpacing: 0.5 },
  statusMuted:     { color: MUTED, fontSize: 13 },
  statusGold:      { color: GOLD,  fontSize: 13 },
  statusError:     { color: RED,   fontSize: 13, textAlign: 'center', paddingHorizontal: 24 },
  hintText:        { color: MUTED, fontSize: 11, marginTop: 5 },

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
