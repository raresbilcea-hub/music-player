import { StyleSheet, Text, View, TextInput, TouchableOpacity, FlatList, ActivityIndicator } from 'react-native';
import { useState } from 'react';
import { useRouter } from 'expo-router';

export default function HomeScreen() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [songs, setSongs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');

  async function searchSongs() {
    if (!query) return;
    setLoading(true);
    setStatus('Searching...');
    setSongs([]);
    try {
      const response = await fetch(`http://localhost:3000/search?q=${encodeURIComponent(query)}`);
      const data = await response.json();
      setSongs(data.songs);
      setStatus(`${data.count} records found`);
    } catch (error) {
      setStatus('Connection error');
    }
    setLoading(false);
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Music</Text>
      <Text style={styles.titleItalic}>Player 2.0</Text>
      <Text style={styles.tagline}>Search any song. Discover chords.</Text>

      <View style={styles.searchRow}>
        <TextInput
          style={styles.input}
          placeholder="Enter a song or artist..."
          placeholderTextColor="#6b6254"
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={searchSongs}
        />
        <TouchableOpacity style={styles.button} onPress={searchSongs}>
          <Text style={styles.buttonText}>SEARCH</Text>
        </TouchableOpacity>
      </View>

      {status ? <Text style={styles.status}>— {status}</Text> : null}
      {loading ? <ActivityIndicator color="#c9a84c" /> : null}

      <FlatList
        data={songs}
        keyExtractor={(item, index) => index.toString()}
        renderItem={({ item, index }) => (
          <TouchableOpacity style={styles.songCard} onPress={() => router.push({
  pathname: '/(tabs)/song',
  params: { title: item.title, artist: item.artist, album: item.album, year: item.year, genre: item.genre, duration: item.duration }
})}>
            <Text style={styles.songNum}>{String(index + 1).padStart(2, '0')}</Text>
            <View style={styles.songInfo}>
              <Text style={styles.songTitle}>{item.title}</Text>
              <Text style={styles.songMeta}>{item.artist} · {item.album}</Text>
            </View>
            <Text style={styles.songYear}>{item.year}</Text>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0e0c09',
    padding: 24,
    paddingTop: 60,
  },
  title: {
    color: '#e8dfc8',
    fontSize: 48,
    fontWeight: 'bold',
  },
  titleItalic: {
    color: '#c9a84c',
    fontSize: 48,
    fontStyle: 'italic',
    marginTop: -10,
  },
  tagline: {
    color: '#6b6254',
    fontSize: 14,
    marginTop: 8,
    marginBottom: 32,
  },
  searchRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16,
  },
  input: {
    flex: 1,
    backgroundColor: '#16130e',
    color: '#e8dfc8',
    padding: 14,
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#2a2318',
  },
  button: {
    backgroundColor: '#c9a84c',
    padding: 14,
    justifyContent: 'center',
  },
  buttonText: {
    color: '#0e0c09',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 2,
  },
  status: {
    color: '#6b6254',
    fontSize: 11,
    marginBottom: 16,
  },
  songCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#16130e',
    padding: 16,
    marginBottom: 2,
    borderWidth: 1,
    borderColor: '#2a2318',
  },
  songNum: {
    color: '#6b6254',
    fontSize: 11,
    width: 28,
  },
  songInfo: {
    flex: 1,
  },
  songTitle: {
    color: '#e8dfc8',
    fontSize: 18,
  },
  songMeta: {
    color: '#6b6254',
    fontSize: 13,
    marginTop: 2,
  },
  songYear: {
    color: '#8a6f32',
    fontSize: 11,
  },
});
