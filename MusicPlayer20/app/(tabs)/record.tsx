import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  Animated,
} from 'react-native';
import { useState, useRef, useEffect } from 'react';
import { useAudioRecorder, AudioModule, RecordingPresets } from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';

type Chord = { chord: string; position: number };
type Line = { lyrics: string; chords?: Chord[] };
type Section = { label: string; lines?: Line[] };
type ChordChart = {
  title: string;
  artist: string;
  musicalKey?: string;
  tempo?: number | string;
  capo?: number | string;
  sections: Section[];
};
type IdentifyResult = {
  identified: boolean;
  chart: ChordChart;
};

function buildChordLine(chords: Chord[], lyrics: string): string {
  if (!chords?.length) return '';
  const sorted = [...chords].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  let result = '';
  for (const item of sorted) {
    const pos = item.position ?? 0;
    while (result.length < pos) result += ' ';
    result += item.chord + ' ';
  }
  return result.trimEnd();
}

export default function RecordScreen() {
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [isRecording, setIsRecording] = useState(false);
  const [status, setStatus] = useState('Tap to identify a song');
  const [result, setResult] = useState<IdentifyResult | null>(null);

  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pulseLoop = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    if (isRecording) {
      pulseLoop.current = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.18, duration: 700, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 700, useNativeDriver: true }),
        ])
      );
      pulseLoop.current.start();
    } else {
      pulseLoop.current?.stop();
      Animated.timing(pulseAnim, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    }
  }, [isRecording]);

  async function startRecording() {
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) { setStatus('Microphone permission denied'); return; }
      await AudioModule.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      setStatus('Listening...');
      setIsRecording(true);
      setResult(null);
      await audioRecorder.prepareToRecordAsync();
      await audioRecorder.record();
      setTimeout(() => stopAndIdentify(), 10000);
    } catch (error: any) {
      setStatus('Error: ' + error.message);
      setIsRecording(false);
    }
  }

  async function stopAndIdentify() {
    try {
      setStatus('Processing...');
      setIsRecording(false);
      await audioRecorder.stop();
      const uri = audioRecorder.uri;
      if (!uri) { setStatus('No audio recorded'); return; }
      setStatus('Identifying song...');
      const base64Audio = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });
      const response = await fetch('http://localhost:3000/identify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioBase64: base64Audio, mimeType: 'audio/m4a' }),
      });
      const data = await response.json();
      if (data.error) { setStatus('Error: ' + data.error); return; }
      setResult(data);
      setStatus(data.identified ? 'Song identified!' : 'Chart generated');
    } catch (error: any) {
      setStatus('Error: ' + error.message);
    }
  }

  const chart = result?.chart;

  return (
    <View style={styles.root}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Page header */}
        <View style={styles.headerBlock}>
          <Text style={styles.headingMain}>Identify</Text>
          <Text style={styles.headingAccent}>a Song</Text>
          <Text style={styles.tagline}>Play music near your device</Text>
        </View>

        {/* Record button */}
        <View style={styles.recordArea}>
          <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
            <TouchableOpacity
              style={[styles.recordBtn, isRecording && styles.recordBtnActive]}
              onPress={isRecording ? stopAndIdentify : startRecording}
              activeOpacity={0.85}
            >
              <Text style={[styles.recordIcon, isRecording && styles.recordIconActive]}>
                {isRecording ? '■' : '●'}
              </Text>
            </TouchableOpacity>
          </Animated.View>
          <Text style={styles.statusText}>{status}</Text>
          {isRecording && <Text style={styles.hintText}>tap to stop early</Text>}
        </View>

        {/* Chord chart */}
        {chart && (
          <View style={styles.chartCard}>
            <Text style={styles.badgeText}>
              {result?.identified ? 'IDENTIFIED' : 'GENERATED CHART'}
            </Text>
            <Text style={styles.chartTitle}>{chart.title ?? 'Unknown'}</Text>
            <Text style={styles.chartArtist}>{chart.artist ?? 'Unknown Artist'}</Text>

            <View style={styles.pillRow}>
              {chart.musicalKey ? (
                <View style={styles.pill}>
                  <Text style={styles.pillLabel}>KEY</Text>
                  <Text style={styles.pillValue}>{chart.musicalKey}</Text>
                </View>
              ) : null}
              {chart.tempo ? (
                <View style={styles.pill}>
                  <Text style={styles.pillLabel}>BPM</Text>
                  <Text style={styles.pillValue}>{chart.tempo}</Text>
                </View>
              ) : null}
              {chart.capo !== undefined && chart.capo !== null ? (
                <View style={styles.pill}>
                  <Text style={styles.pillLabel}>CAPO</Text>
                  <Text style={styles.pillValue}>{chart.capo === 0 ? 'None' : `Fret ${chart.capo}`}</Text>
                </View>
              ) : null}
            </View>

            <View style={styles.divider} />

            {(chart.sections ?? []).map((section, si) => (
              <View key={si} style={styles.section}>
                <View style={styles.sectionHeader}>
                  <View style={styles.sectionBar} />
                  <Text style={styles.sectionLabel}>
                    {(section.label ?? '').toUpperCase()}
                  </Text>
                </View>

                {(section.lines ?? []).map((line, li) => {
                  const hasChords = line.chords && line.chords.length > 0;
                  const chordLine = hasChords
                    ? buildChordLine(line.chords!, line.lyrics ?? '')
                    : null;
                  return (
                    <View key={li} style={styles.lineBlock}>
                      {chordLine ? (
                        <Text style={styles.chordLine}>{chordLine}</Text>
                      ) : null}
                      {line.lyrics ? (
                        <Text style={styles.lyricLine}>{line.lyrics}</Text>
                      ) : null}
                    </View>
                  );
                })}
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const GOLD = '#c9a84c';
const GOLD_DIM = '#8a6f32';
const BG = '#0e0c09';
const BG_CARD = '#16130e';
const CREAM = '#e8dfc8';
const MUTED = '#6b6254';
const BORDER = '#2a2318';
const RED = '#e24b4a';

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: BG,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 24,
    paddingTop: 64,
    paddingBottom: 60,
    flexGrow: 1,
  },

  headerBlock: {
    marginBottom: 8,
  },
  headingMain: {
    color: CREAM,
    fontSize: 48,
    fontWeight: 'bold',
    lineHeight: 52,
  },
  headingAccent: {
    color: GOLD,
    fontSize: 48,
    fontStyle: 'italic',
    lineHeight: 52,
    marginBottom: 8,
  },
  tagline: {
    color: MUTED,
    fontSize: 14,
  },

  recordArea: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  recordBtn: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: BG_CARD,
    borderWidth: 2,
    borderColor: GOLD,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
    shadowColor: GOLD,
    shadowOpacity: 0.2,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 0 },
  },
  recordBtnActive: {
    borderColor: RED,
    backgroundColor: '#1e0e0e',
    shadowColor: RED,
    shadowOpacity: 0.3,
  },
  recordIcon: {
    color: GOLD,
    fontSize: 40,
  },
  recordIconActive: {
    color: RED,
  },
  statusText: {
    color: MUTED,
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 6,
  },
  hintText: {
    color: GOLD_DIM,
    fontSize: 12,
    textAlign: 'center',
  },

  chartCard: {
    backgroundColor: BG_CARD,
    borderWidth: 1,
    borderColor: BORDER,
    borderRadius: 4,
    overflow: 'hidden',
  },
  badgeText: {
    color: GOLD_DIM,
    fontSize: 9,
    letterSpacing: 2.5,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 10,
  },
  chartTitle: {
    color: CREAM,
    fontSize: 26,
    fontWeight: 'bold',
    paddingHorizontal: 20,
    lineHeight: 30,
    marginBottom: 4,
  },
  chartArtist: {
    color: GOLD,
    fontSize: 16,
    paddingHorizontal: 20,
    marginBottom: 16,
  },

  pillRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 20,
    marginBottom: 20,
    flexWrap: 'wrap',
  },
  pill: {
    backgroundColor: '#1f1c14',
    borderWidth: 1,
    borderColor: BORDER,
    borderRadius: 3,
    paddingHorizontal: 10,
    paddingVertical: 6,
    alignItems: 'center',
    minWidth: 56,
  },
  pillLabel: {
    color: GOLD_DIM,
    fontSize: 8,
    letterSpacing: 1.5,
    marginBottom: 2,
  },
  pillValue: {
    color: CREAM,
    fontSize: 13,
    fontWeight: '600',
  },

  divider: {
    height: 1,
    backgroundColor: BORDER,
  },

  section: {
    paddingTop: 16,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
    paddingHorizontal: 20,
    gap: 8,
  },
  sectionBar: {
    width: 3,
    height: 12,
    backgroundColor: GOLD,
    borderRadius: 2,
  },
  sectionLabel: {
    color: GOLD_DIM,
    fontSize: 10,
    letterSpacing: 2,
    fontWeight: '600',
  },

  lineBlock: {
    paddingHorizontal: 20,
    marginBottom: 10,
  },
  chordLine: {
    color: GOLD,
    fontSize: 13,
    fontFamily: 'Courier',
    letterSpacing: 0.2,
    lineHeight: 18,
  },
  lyricLine: {
    color: CREAM,
    fontSize: 14,
    lineHeight: 20,
  },
});
