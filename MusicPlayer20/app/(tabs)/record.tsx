import { StyleSheet, Text, View, TouchableOpacity, ScrollView } from 'react-native';
import { useState } from 'react';
import { useAudioRecorder, AudioModule, RecordingPresets } from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';

export default function RecordScreen() {
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [isRecording, setIsRecording] = useState(false);
  const [status, setStatus] = useState('Tap to identify a song');
  const [result, setResult] = useState(null);

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
    } catch (error) {
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
    } catch (error) {
      setStatus('Error: ' + error.message);
    }
  }

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.title}>Identify</Text>
      <Text style={styles.titleItalic}>a Song</Text>
      <Text style={styles.tagline}>Play music near your device</Text>
      <View style={styles.centerArea}>
        <TouchableOpacity style={[styles.recordBtn, isRecording && styles.recordBtnActive]} onPress={isRecording ? stopAndIdentify : startRecording}>
          <Text style={styles.recordIcon}>{isRecording ? "■" : "●"}</Text>
        </TouchableOpacity>
        <Text style={styles.status}>{status}</Text>
        {isRecording && <Text style={styles.timer}>Recording... tap to stop early</Text>}
      </View>
      {result && result.chart && (
        <View style={styles.resultCard}>
          <Text style={styles.resultLabel}>{result.identified ? 'IDENTIFIED' : 'GENERATED CHART'}</Text>
          <Text style={styles.resultTitle}>{result.chart.title}</Text>
          <Text style={styles.resultArtist}>{result.chart.artist}</Text>
          <View style={styles.metaRow}>
            <Text style={styles.metaItem}>Key: {result.chart.musicalKey}</Text>
            <Text style={styles.metaItem}>Tempo: {result.chart.tempo}</Text>
            <Text style={styles.metaItem}>Capo: {result.chart.capo}</Text>
          </View>
          <View style={styles.divider} />
          {result.chart.sections && result.chart.sections.map((section, si) => (
            <View key={si} style={styles.section}>
              <Text style={styles.sectionLabel}>{section.label}</Text>
              {section.lines && section.lines.map((line, li) => (
                <View key={li}>
                  {line.chords && line.chords.length > 0 && <Text style={styles.chords}>{line.chords.map(c => c.chord).join("  ")}</Text>}
                  <Text style={styles.lyrics}>{line.lyrics}</Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0e0c09', padding: 24, paddingTop: 60 },
  title: { color: '#e8dfc8', fontSize: 48, fontWeight: 'bold' },
  titleItalic: { color: '#c9a84c', fontSize: 48, fontStyle: 'italic', marginTop: -10 },
  tagline: { color: '#6b6254', fontSize: 14, marginTop: 8 },
  centerArea: { alignItems: 'center', paddingVertical: 40 },
  recordBtn: { width: 120, height: 120, borderRadius: 60, backgroundColor: '#16130e', borderWidth: 2, borderColor: '#c9a84c', justifyContent: 'center', alignItems: 'center', marginBottom: 24 },
  recordBtnActive: { borderColor: '#e24b4a', backgroundColor: '#1e0e0e' },
  recordIcon: { color: '#c9a84c', fontSize: 40 },
  status: { color: '#6b6254', fontSize: 14, textAlign: 'center', marginBottom: 8 },
  timer: { color: '#8a6f32', fontSize: 12, textAlign: 'center' },
  resultCard: { backgroundColor: '#16130e', borderWidth: 1, borderColor: '#c9a84c', padding: 24, marginBottom: 40 },
  resultLabel: { color: '#8a6f32', fontSize: 9, letterSpacing: 2, marginBottom: 12 },
  resultTitle: { color: '#e8dfc8', fontSize: 24, fontWeight: 'bold', marginBottom: 4 },
  resultArtist: { color: '#c9a84c', fontSize: 16, marginBottom: 12 },
  metaRow: { flexDirection: 'row', gap: 16, marginBottom: 16 },
  metaItem: { color: '#6b6254', fontSize: 12 },
  divider: { height: 1, backgroundColor: '#2a2318', marginBottom: 16 },
  section: { marginBottom: 20 },
  sectionLabel: { color: '#8a6f32', fontSize: 10, letterSpacing: 2, marginBottom: 8, textTransform: 'uppercase' },
  chords: { color: '#c9a84c', fontSize: 14, fontFamily: 'monospace', marginBottom: 2 },
  lyrics: { color: '#e8dfc8', fontSize: 14, marginBottom: 8 },
});
