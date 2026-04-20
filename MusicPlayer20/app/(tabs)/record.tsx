import { StyleSheet, Text, View, TouchableOpacity } from 'react-native';
import { useState } from 'react';
import { useAudioRecorder, AudioModule, RecordingPresets } from 'expo-audio';

export default function RecordScreen() {
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [isRecording, setIsRecording] = useState(false);
  const [status, setStatus] = useState('Tap to identify a song');
  const [result, setResult] = useState(null);

  async function startRecording() {
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setStatus('Microphone permission denied');
        return;
      }

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
      setStatus('Identifying song...');
      setIsRecording(false);

      await audioRecorder.stop();
      const uri = audioRecorder.uri;

      const formData = new FormData();
      formData.append('api_token', process.env.EXPO_PUBLIC_AUDD_API_KEY);
      formData.append('return', 'spotify,apple_music');
      formData.append('file', {
        uri: uri,
        type: 'audio/m4a',
        name: 'recording.m4a',
      });

      const response = await fetch('https://api.audd.io/', {
        method: 'POST',
        body: formData,
      });

      const data = await response.json();

      if (data.result) {
        setResult({
          title: data.result.title,
          artist: data.result.artist,
          album: data.result.album,
          year: data.result.release_date ? data.result.release_date.substring(0, 4) : '—',
        });
        setStatus('Song identified!');
      } else {
        setStatus('Song not recognized. Try again.');
      }

    } catch (error) {
      setStatus('Error: ' + error.message);
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
          onPress={isRecording ? stopAndIdentify : startRecording}
        >
          <Text style={styles.recordIcon}>{isRecording ? '■' : '●'}</Text>
        </TouchableOpacity>

        <Text style={styles.status}>{status}</Text>
        {isRecording && <Text style={styles.timer}>Recording... tap to stop</Text>}
      </View>

      {result && (
        <View style={styles.resultCard}>
          <Text style={styles.resultLabel}>IDENTIFIED</Text>
          <Text style={styles.resultTitle}>{result.title}</Text>
          <Text style={styles.resultArtist}>{result.artist}</Text>
          <Text style={styles.resultMeta}>{result.album} · {result.year}</Text>
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
    borderColor: '#c9a84c',
    padding: 24,
    marginBottom: 40,
  },
  resultLabel: { color: '#8a6f32', fontSize: 9, letterSpacing: 2, marginBottom: 12 },
  resultTitle: { color: '#e8dfc8', fontSize: 24, fontWeight: 'bold', marginBottom: 4 },
  resultArtist: { color: '#c9a84c', fontSize: 16, marginBottom: 4 },
  resultMeta: { color: '#6b6254', fontSize: 13 },
});
