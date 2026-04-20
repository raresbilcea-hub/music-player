import { StyleSheet, Text, View, TouchableOpacity } from 'react-native';
import { useState } from 'react';
import { Audio } from 'expo-av';

export default function RecordScreen() {
  const [recording, setRecording] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [status, setStatus] = useState('Tap to identify a song');
  const [result, setResult] = useState(null);

  async function startRecording() {
    try {
      await Audio.requestPermissionsAsync();
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      setStatus('Listening...');
      setIsRecording(true);
      setResult(null);

      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );
      setRecording(recording);

      setTimeout(() => stopRecording(recording), 10000);

    } catch (error) {
      setStatus('Error: ' + error.message);
      setIsRecording(false);
    }
  }

  async function stopRecording(rec) {
    try {
      setStatus('Identifying song...');
      setIsRecording(false);

      const currentRecording = rec || recording;
      await currentRecording.stopAndUnloadAsync();
      const uri = currentRecording.getURI();

      setStatus('Audio captured!');
      setResult({ message: 'Audio recorded successfully! Song identification coming soon.' });

    } catch (error) {
      setStatus('Error stopping: ' + error.message);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Identify</Text>
      <Text style={styles.titleItalic}>a Song</Text>
      <Text style={styles.tagline}>Play music near your device</Text>

      <View style={styles.centerArea}>
        <TouchableOpacity
          style={[styles.recordBtn, isRecording && styles.recordBtnActive]}
          onPress={isRecording ? () => stopRecording(null) : startRecording}
        >
          <Text style={styles.recordIcon}>{isRecording ? '■' : '●'}</Text>
        </TouchableOpacity>

        <Text style={styles.status}>{status}</Text>
        {isRecording && <Text style={styles.timer}>Recording for 10 seconds...</Text>}
      </View>

      {result && (
        <View style={styles.resultCard}>
          <Text style={styles.resultLabel}>RESULT</Text>
          <Text style={styles.resultText}>{result.message}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0e0c09', padding: 24, paddingTop: 60 },
  title: { color: '#e8dfc8', fontSize: 48, fontWeight: 'bold' },
  titleItalic: { color: '#c9a84c', fontSize: 48, fontStyle: 'italic', marginTop: -10 },
  tagline: { color: '#6b6254', fontSize: 14, marginTop: 8 },
  centerArea: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  recordBtn: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: '#16130e',
    borderWidth: 2,
    borderColor: '#c9a84c',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 32,
  },
  recordBtnActive: {
    borderColor: '#e24b4a',
    backgroundColor: '#1e0e0e',
  },
  recordIcon: { color: '#c9a84c', fontSize: 40 },
  status: { color: '#6b6254', fontSize: 14, textAlign: 'center', marginBottom: 8 },
  timer: { color: '#8a6f32', fontSize: 12, textAlign: 'center' },
  resultCard: {
    backgroundColor: '#16130e',
    borderWidth: 1,
    borderColor: '#2a2318',
    padding: 20,
    marginBottom: 40,
  },
  resultLabel: { color: '#8a6f32', fontSize: 9, letterSpacing: 2, marginBottom: 8 },
  resultText: { color: '#e8dfc8', fontSize: 16 },
});
