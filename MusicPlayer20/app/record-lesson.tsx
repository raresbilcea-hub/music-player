// ─── Record a lesson ─────────────────────────────────────────────────────────
// Modal-style route accessed from the Lessons tab.
// Records audio, sends it to /transcribe (Whisper) for multilingual lyrics
// transcription, then offers Save Locally + (coming soon) Upload to Community.
//
// Lives outside (tabs)/ on purpose so it presents as a full-screen modal,
// keeping the Record tab itself reserved for song identification.

import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  Animated,
  Alert,
} from 'react-native';
import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'expo-router';
import { useAudioRecorder, AudioModule, RecordingPresets } from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
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

const LOCAL_KEY = '@mp_local_lessons';

type StatusKey = 'idle' | 'listening' | 'processing' | 'transcribing' | 'transcribed' | 'saved' | 'error';
type Transcript = { text: string; language: string; audioUri: string; createdAt: number };

// ─── AnimatedDots ─────────────────────────────────────────────────────────────

function AnimatedDots({ active }: { active: boolean }) {
  const [dots, setDots] = useState('');
  useEffect(() => {
    if (!active) { setDots(''); return; }
    const id = setInterval(() => setDots(d => (d.length >= 3 ? '' : d + '.')), 480);
    return () => clearInterval(id);
  }, [active]);
  return <Text style={{ color: GOLD }}>{dots}</Text>;
}

// ─── Local-save helper ────────────────────────────────────────────────────────
// Stores transcribed lessons in AsyncStorage under a single key.
// Cloud upload to community is intentionally deferred — see Coming Soon alert.

async function saveLessonLocally(transcript: Transcript) {
  try {
    const existingRaw = await AsyncStorage.getItem(LOCAL_KEY);
    const existing: Transcript[] = existingRaw ? JSON.parse(existingRaw) : [];
    existing.unshift(transcript);
    // cap the local list so we don't grow unbounded
    if (existing.length > 50) existing.length = 50;
    await AsyncStorage.setItem(LOCAL_KEY, JSON.stringify(existing));
  } catch {
    // swallow — local save is best-effort
  }
}

// ─── RecordLessonScreen ──────────────────────────────────────────────────────

export default function RecordLessonScreen() {
  const router        = useRouter();
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

  const [isRecording, setIsRecording]   = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusKey, setStatusKey]       = useState<StatusKey>('idle');
  const [errorMsg, setErrorMsg]         = useState('');
  const [transcript, setTranscript]     = useState<Transcript | null>(null);
  const [gateVisible, setGateVisible]   = useState(false);

  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pulseRef  = useRef<Animated.CompositeAnimation | null>(null);

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

  async function startRecording() {
    if (await shouldShowGate()) { setGateVisible(true); return; }
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) { setStatusKey('error'); setErrorMsg('Microphone permission denied'); return; }
      await AudioModule.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      setTranscript(null);
      setIsRecording(true);
      setStatusKey('listening');
      await audioRecorder.prepareToRecordAsync();
      await audioRecorder.record();
      // No auto-stop — user controls duration by tapping again
    } catch (e: any) {
      setStatusKey('error');
      setErrorMsg(e.message);
      setIsRecording(false);
    }
  }

  async function stopAndTranscribe() {
    try {
      setIsRecording(false);
      setIsProcessing(true);
      setStatusKey('processing');
      await audioRecorder.stop();
      const uri = audioRecorder.uri;
      if (!uri) { setStatusKey('error'); setErrorMsg('No audio recorded'); setIsProcessing(false); return; }

      setStatusKey('transcribing');
      const base64Audio = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });
      const response = await fetch('https://music-player-production-524a.up.railway.app/transcribe', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ audioBase64: base64Audio, mimeType: 'audio/m4a' }),
      });
      const data = await response.json();
      setIsProcessing(false);
      if (data.error) { setStatusKey('error'); setErrorMsg(data.error); return; }

      await consumeFreeAction();
      setTranscript({
        text:      data.transcript,
        language:  data.language,
        audioUri:  uri,
        createdAt: Date.now(),
      });
      setStatusKey('transcribed');
    } catch (e: any) {
      setIsProcessing(false);
      setStatusKey('error');
      setErrorMsg(e.message);
    }
  }

  async function saveLocallyAndClose() {
    if (!transcript) return;
    await saveLessonLocally(transcript);
    setStatusKey('saved');
    Alert.alert(
      'Saved on this device',
      'Your lesson is saved locally. Sharing to the community library is coming soon.',
      [{ text: 'OK', onPress: () => router.back() }],
    );
  }

  function uploadComingSoon() {
    Alert.alert(
      'Community upload coming soon',
      "We're building the community lesson library now. For now your lesson is saved locally on this device — once the library is live, you'll be able to publish it with one tap.",
      [{ text: 'Got it', style: 'default' }],
    );
  }

  return (
    <View style={s.root}>
      <FreeGateModal visible={gateVisible} />

      {/* Header bar with close button */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Ionicons name="close" size={26} color={GOLD} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>RECORD A LESSON</Text>
        <View style={{ width: 26 }} />
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Idle header */}
        {!transcript && (
          <View style={s.idleHeader}>
            <Text style={s.idleMain}>Record</Text>
            <Text style={s.idleAccent}>a Lesson.</Text>
            <Text style={s.idleTagline}>Sing or play — lyrics transcribed in any language.</Text>
          </View>
        )}

        {/* Transcript result */}
        {statusKey === 'transcribed' && transcript && (
          <View>
            <Text style={s.sourceBadge}>✦  TRANSCRIBED</Text>
            <View style={s.langRow}>
              <View style={s.pill}>
                <Text style={s.pillLabel}>LANGUAGE</Text>
                <Text style={s.pillValue}>{(transcript.language || 'unknown').toUpperCase()}</Text>
              </View>
            </View>
            <View style={s.transcriptBox}>
              <Text style={s.transcriptText}>{transcript.text}</Text>
            </View>

            <TouchableOpacity style={s.primaryBtn} onPress={saveLocallyAndClose} activeOpacity={0.85}>
              <Text style={s.primaryBtnTxt}>SAVE ON THIS DEVICE</Text>
            </TouchableOpacity>

            <TouchableOpacity style={s.secondaryBtn} onPress={uploadComingSoon} activeOpacity={0.7}>
              <Text style={s.secondaryBtnTxt}>↑  UPLOAD TO COMMUNITY (COMING SOON)</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={s.tertiaryBtn}
              onPress={() => { setTranscript(null); setStatusKey('idle'); }}
              activeOpacity={0.7}
            >
              <Text style={s.tertiaryBtnTxt}>Record again</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={{ height: 180 }} />
      </ScrollView>

      {/* Fixed bottom bar */}
      <View style={s.bottomBar}>
        <View style={s.statusRow}>
          {statusKey === 'listening'    && <Text style={s.statusRed}>● Recording<AnimatedDots active={isRecording} /></Text>}
          {statusKey === 'processing'   && <Text style={s.statusMuted}>Processing...</Text>}
          {statusKey === 'transcribing' && <Text style={s.statusMuted}>Transcribing audio...</Text>}
          {statusKey === 'error'        && <Text style={s.statusError}>{errorMsg}</Text>}
          {isRecording && <Text style={s.hintText}>tap to stop</Text>}
        </View>

        {/* Record button — hidden once we have a transcript */}
        {!transcript && (
          <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
            <TouchableOpacity
              style={[s.recordBtn, isRecording && s.recordBtnActive]}
              onPress={isRecording ? stopAndTranscribe : startRecording}
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
  root: { flex: 1, backgroundColor: BG },

  header: {
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'space-between',
    paddingTop:     56,
    paddingHorizontal: 20,
    paddingBottom:  18,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
  },
  headerTitle: { color: GOLD, fontSize: 12, letterSpacing: 2.5, fontWeight: '700' },

  scroll:        { flex: 1 },
  scrollContent: { paddingTop: 24, paddingHorizontal: 24, flexGrow: 1 },

  idleHeader:  { paddingTop: 12, paddingBottom: 40 },
  idleMain:    { color: CREAM, fontSize: 52, fontWeight: 'bold',  lineHeight: 58 },
  idleAccent:  { color: GOLD,  fontSize: 52, fontStyle: 'italic', lineHeight: 58, marginBottom: 14 },
  idleTagline: { color: MUTED, fontSize: 14, lineHeight: 20 },

  sourceBadge: { color: GOLD_DIM, fontSize: 9, letterSpacing: 3.5, marginBottom: 16 },

  langRow: { flexDirection: 'row', marginBottom: 16 },
  pill: {
    backgroundColor: '#191610',
    borderWidth: 1, borderColor: '#2e2618',
    borderRadius: 4, paddingHorizontal: 14, paddingVertical: 8,
    alignItems: 'center', minWidth: 80,
  },
  pillLabel: { color: GOLD_DIM, fontSize: 8, letterSpacing: 2, marginBottom: 4 },
  pillValue: { color: CREAM,    fontSize: 14, fontWeight: '600' },

  transcriptBox: {
    backgroundColor: '#16130e',
    borderWidth:     1,
    borderColor:     BORDER,
    padding:         20,
    marginBottom:    24,
  },
  transcriptText: { color: CREAM, fontSize: 16, lineHeight: 28 },

  primaryBtn:    { backgroundColor: GOLD, paddingVertical: 16, alignItems: 'center', marginBottom: 10 },
  primaryBtnTxt: { color: BG, fontSize: 12, fontWeight: '700', letterSpacing: 2 },

  secondaryBtn:    { borderWidth: 1, borderColor: GOLD_DIM, paddingVertical: 14, alignItems: 'center', marginBottom: 8 },
  secondaryBtnTxt: { color: GOLD_DIM, fontSize: 11, fontWeight: '700', letterSpacing: 1.5 },

  tertiaryBtn:    { alignItems: 'center', paddingVertical: 10 },
  tertiaryBtnTxt: { color: MUTED, fontSize: 13 },

  bottomBar: {
    position:        'absolute',
    bottom:          0,
    left:            0,
    right:           0,
    paddingBottom:   40,
    paddingTop:      14,
    alignItems:      'center',
    backgroundColor: BG,
    borderTopWidth:  1,
    borderTopColor:  BORDER,
  },

  statusRow:   { alignItems: 'center', minHeight: 40, justifyContent: 'center', marginBottom: 16 },
  statusRed:   { color: RED, fontSize: 14, letterSpacing: 0.5 },
  statusMuted: { color: MUTED, fontSize: 13 },
  statusError: { color: RED, fontSize: 13, textAlign: 'center', paddingHorizontal: 24 },
  hintText:    { color: MUTED, fontSize: 11, marginTop: 5 },

  recordBtn: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: GOLD,
    justifyContent: 'center', alignItems: 'center',
    shadowColor: GOLD, shadowOpacity: 0.55, shadowRadius: 22, shadowOffset: { width: 0, height: 0 },
    elevation: 12,
  },
  recordBtnActive: { backgroundColor: RED, shadowColor: RED, shadowOpacity: 0.7 },
  recordBtnInner:  { width: 64, height: 64, borderRadius: 32, backgroundColor: 'rgba(0,0,0,0.15)', justifyContent: 'center', alignItems: 'center' },
  recordBtnInnerActive: { backgroundColor: 'rgba(0,0,0,0.2)' },
  recordIcon:       { color: BG, fontSize: 26, lineHeight: 30 },
  recordIconActive: { color: '#fff', fontSize: 20 },
});
