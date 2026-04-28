import { StyleSheet, Text, View, TextInput, TouchableOpacity, FlatList, ActivityIndicator, Image } from 'react-native';
import { useState } from 'react';
import { useRouter } from 'expo-router';

export default function HomeScreen() {
  const [query, setQuery] = useState('');
  const [songs, setSongs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const router = useRouter();

  async function searchSongs() {
    if (!query) return;
    setLoading(true);
    setStatus('Searching...');
    setSongs([]);
    try {
      const response = await fetch(`https://music-player-production-524a.up.railway.app/search?q=${encodeURIComponent(query)}`);
      const data = await response.json();
      setSongs(data.songs);
      setStatus(`${data.count} records found`);
    } catch (error) {
      setStatus('Connection error');
    }
    setLoading(false);
  }

  function openSong(song) {
    router.push({
      pathname: '/song',
      params: {
        title: song.title,
        artist: song.artist,
        album: song.album,
        year: song.year,
        genre: song.genre,
        duration: song.duration,
        artwork: song.artwork,
      }
    });
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
      {loading ? <ActivityIndicator color="#c9a84c" style={{ marginBottom: 16 }} /> : null}

      <FlatList
        data={songs}
        keyExtractor={(item, index) => index.toString()}
        renderItem={({ item, index }) => (
          <TouchableOpacity style={styles.songCard} onPress={() => openSong(item)}>
            <Text style={styles.songNum}>{String(index + 1).padStart(2, '0')}</Text>
            {item.artwork ? (
              <Image source={{ uri: item.artwork }} style={styles.artwork} />
            ) : (
              <View style={styles.artworkPlaceholder} />
            )}
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
  artwork: {
    width: 44,
    height: 44,
    marginRight: 12,
    borderWidth: 1,
    borderColor: '#2a2318',
  },
  artworkPlaceholder: {
    width: 44,
    height: 44,
    marginRight: 12,
    backgroundColor: '#16130e',
    borderWidth: 1,
    borderColor: '#2a2318',
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
