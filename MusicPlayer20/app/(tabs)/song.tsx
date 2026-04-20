import { StyleSheet, Text, View, TouchableOpacity, ScrollView } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

export default function SongScreen() {
  const router = useRouter();
  const { title, artist, album, year, genre, duration, artwork } = useLocalSearchParams();

  return (
    <ScrollView style={styles.container}>
      <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
        <Text style={styles.backText}>← Back</Text>
      </TouchableOpacity>

      <View style={styles.header}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.artist}>{artist}</Text>
        <Text style={styles.album}>{album}</Text>
      </View>

      <View style={styles.divider} />

      <View style={styles.metaGrid}>
        <View style={styles.metaItem}>
          <Text style={styles.metaLabel}>YEAR</Text>
          <Text style={styles.metaValue}>{year}</Text>
        </View>
        <View style={styles.metaItem}>
          <Text style={styles.metaLabel}>GENRE</Text>
          <Text style={styles.metaValue}>{genre}</Text>
        </View>
        <View style={styles.metaItem}>
          <Text style={styles.metaLabel}>DURATION</Text>
          <Text style={styles.metaValue}>{duration}</Text>
        </View>
      </View>

      <View style={styles.divider} />

      <View style={styles.comingSoon}>
        <Text style={styles.comingSoonLabel}>COMING SOON</Text>
        <Text style={styles.comingSoonText}>
          Chord charts & tabs will appear here — beginner, intermediate & advanced
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0e0c09', padding: 24, paddingTop: 60 },
  backBtn: { marginBottom: 32 },
  backText: { color: '#c9a84c', fontSize: 16 },
  header: { marginBottom: 24 },
  title: { color: '#e8dfc8', fontSize: 32, fontWeight: 'bold', marginBottom: 8 },
  artist: { color: '#c9a84c', fontSize: 18, marginBottom: 4 },
  album: { color: '#6b6254', fontSize: 14 },
  divider: { height: 1, backgroundColor: '#2a2318', marginVertical: 24 },
  metaGrid: { flexDirection: 'row', justifyContent: 'space-between' },
  metaItem: { flex: 1 },
  metaLabel: { color: '#8a6f32', fontSize: 9, letterSpacing: 2, marginBottom: 6 },
  metaValue: { color: '#e8dfc8', fontSize: 16 },
  comingSoon: { borderWidth: 1, borderColor: '#2a2318', borderStyle: 'dashed', padding: 20, alignItems: 'center' },
  comingSoonLabel: { color: '#8a6f32', fontSize: 9, letterSpacing: 2, marginBottom: 8 },
  comingSoonText: { color: '#6b6254', fontSize: 14, fontStyle: 'italic', textAlign: 'center' },
});
